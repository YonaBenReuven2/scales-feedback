/* The listening engine: piano filter and pitch analysis, fed blocks of captured audio.
 *
 * It runs in a Web Worker when it can, so its heavy number-crunching never delays the
 * notes sent to the piano or the drawing; otherwise on the page itself. Either way it
 * is driven by the same messages:
 *
 *   in   start {sr, hasRef, gateDb, minClarity, saved}   a fresh filter for new inputs
 *        block {f, a, b, perf, ctx}   512 samples of mic (a) and piano audio (b) from
 *                                     context frame f, forwarded at page time perf, when
 *                                     the audio clock read ctx seconds
 *        keys {events: [{t, p, on}]}  keys the app pressed and released (page time)
 *        plan {plan}                  when singing is expected (see Listener.planner)
 *        gate {db} · room {st} · forget · save · stop
 *   out  frame {fr} · level {mic, ref} · status {st} · room {st}
 *
 * All times are the page's performance.now() clock: a worker's own clock differs.
 */
(function (factory) {
  const root = typeof window !== 'undefined' ? window : globalThis;
  (root.SF_SRC = root.SF_SRC || {}).ears = factory;
  factory(root);
})(function (root) {
  'use strict';
  const SF = root.SF;

  class Ears {
    /** post(message, transfer): where results go. */
    constructor(post) {
      this.post = post;
      this.running = false;
      this.keys = [];
      this.plan = { mode: 'stopped' };
      this.levels = { mic: -120, ref: -120 };
      this.lastLevel = -Infinity;
      this.lastStatus = -Infinity;
      this.lastSave = -Infinity;
    }
    handle(m) {
      switch (m.type) {
        case 'start':
          return this.start(m);
        case 'block':
          return this.block(m);
        case 'keys':
          for (const e of m.events) this.keys.push(e);
          if (this.keys.length > 512) this.keys.splice(0, this.keys.length - 512);
          return;
        case 'plan':
          this.plan = m.plan || { mode: 'stopped' };
          return;
        case 'gate':
          this.gateDb = m.db;
          if (this.tracker) this.tracker.gateDb = m.db;
          return;
        case 'room':
          this.saved = m.st;
          if (this.pf && m.st) this.pf.importState(m.st);
          return;
        case 'forget':
          this.saved = null;
          if (this.pf) this.pf.reset();
          this.sendStatus();
          return;
        case 'save':
          this.sendStatus();
          return this.sendRoom();
        case 'stop':
          this.sendRoom();
          this.running = false;
          return;
      }
    }
    start(m) {
      this.sr = m.sr;
      this.hasRef = !!m.hasRef;
      this.gateDb = m.gateDb;
      if (!this.tracker || this.tracker.det.sr !== this.sr) this.tracker = new SF.PitchTracker(this.sr, { gateDb: m.gateDb, minClarity: m.minClarity });
      else this.tracker.gateDb = m.gateDb;
      this.pf = new SF.PianoFilter(this.sr, {});
      if (m.saved) this.saved = m.saved;
      if (this.saved) this.pf.importState(this.saved);
      this.pfFrame0 = null; // context frame of the filter's first sample
      this.lastEnd = 0;
      this.offsetMs = null;
      this.keys = [];
      this.running = true;
      this.sendStatus();
    }
    /** Page time of context frame f. */
    perfOfFrame(f) {
      return this.offsetMs + (f / this.sr) * 1000;
    }
    /** Should nobody be singing at page time t? Then the piano is learned from. */
    expectQuiet(t) {
      const p = this.plan;
      if (p.mode === 'calib') return true;
      if (p.mode !== 'play' || t < p.from || t > p.until) return false;
      for (const s of p.spans) if (t >= s[0] - 300 && t < s[1] + 300) return false;
      return true;
    }
    block(m) {
      if (!this.running) return;
      const { f, a, b } = m;
      const B = a.length;
      const pf = this.pf;
      // keep filter samples and context frames in step: drop repeats, fill short gaps
      if (this.pfFrame0 == null) this.pfFrame0 = f - pf.n;
      const expect = this.pfFrame0 + pf.n;
      if (f < expect) return;
      if (f > expect) {
        const gap = f - expect;
        if (gap > this.sr) this.pfFrame0 += gap; // a long stall: just carry on from here
        else {
          const z = new Float32Array(B);
          for (let k = 0; k < gap; k += B) pf.push(z, this.hasRef ? z : null, true, false);
          this.pfFrame0 = f - pf.n;
        }
      }
      // context frame -> page time, smoothed so jitter in message delivery doesn't move it;
      // re-anchored if the audio clock really jumped (a stall)
      const raw = m.perf - m.ctx * 1000;
      if (this.offsetMs == null || Math.abs(raw - this.offsetMs) > 150) this.offsetMs = raw;
      else this.offsetMs += 0.02 * (raw - this.offsetMs);
      const t0 = this.perfOfFrame(f);
      const t1 = this.perfOfFrame(f + B);
      let onset = false;
      let events = null;
      if (this.hasRef) {
        for (const o of this.keys) {
          if (o.t < t0 || o.t >= t1) continue;
          if (o.on) onset = true;
          (events = events || []).push(o);
        }
      }
      pf.push(a, this.hasRef ? b : null, this.expectQuiet((t0 + t1) / 2), onset, events);
      // levels for the meters
      let sm = 0;
      let sr2 = 0;
      for (let i = 0; i < B; i++) {
        sm += a[i] * a[i];
        sr2 += b[i] * b[i];
      }
      const db = (x) => (x > 0 ? 10 * Math.log10(x / B) : -120);
      this.levels.mic = Math.max(db(sm), this.levels.mic - 3);
      this.levels.ref = this.hasRef ? Math.max(db(sr2), this.levels.ref - 3) : -120;
      // analyse every 512 samples of what the filter has finished
      const W = this.tracker.size;
      if (this.lastEnd < W) this.lastEnd = Math.max(W, pf.done - 512);
      while (this.lastEnd + 512 <= pf.done) {
        this.lastEnd += 512;
        const end = this.lastEnd;
        const fr = SF.analyzeFrame(pf, this.tracker, end, this.perfOfFrame(this.pfFrame0 + end - W / 2));
        this.post({ type: 'frame', fr });
      }
      const now = m.perf;
      if (now - this.lastLevel > 60) {
        this.lastLevel = now;
        this.post({ type: 'level', mic: this.levels.mic, ref: this.levels.ref });
      }
      if (now - this.lastStatus > 250) {
        this.lastStatus = now;
        this.sendStatus();
      }
      if (pf.solved && now - this.lastSave > 30000) {
        this.lastSave = now;
        this.sendRoom();
      }
    }
    sendStatus() {
      const pf = this.pf;
      if (!pf) return;
      this.post({
        type: 'status',
        st: {
          delayMs: pf.delay == null ? null : (pf.delay / this.sr) * 1000,
          ready: pf.ready,
          solved: pf.solved,
          cancelDb: pf.cancelDb,
          learned: pf.learnedSec,
          keys: pf.keysLearned,
          restored: !!pf.restored,
          realigns: pf.realigns || 0,
        },
      });
    }
    sendRoom() {
      const st = this.pf && this.pf.solved ? this.pf.exportState() : null;
      if (st) this.post({ type: 'room', st });
    }
  }

  /** The source of a worker running Ears, built from the same code the page loaded. */
  Ears.workerSource = function () {
    const src = root.SF_SRC || {};
    const parts = ['core', 'pitch', 'echo', 'ears'];
    if (!parts.every((k) => typeof src[k] === 'function')) return null;
    return (
      parts.map((k) => '(' + src[k].toString() + ')(self);').join('\n') +
      '\nconst ears = new self.SF.Ears((m) => self.postMessage(m));\n' +
      'self.onmessage = (e) => ears.handle(e.data);\n' +
      "self.postMessage({ type: 'hello' });\n"
    );
  };

  SF.Ears = Ears;
});
