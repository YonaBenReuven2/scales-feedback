/* The listening engine: piano filter and pitch analysis, fed blocks of captured audio.
 *
 * It runs in a Web Worker when it can, so its heavy number-crunching never delays the
 * notes sent to the piano or the drawing; otherwise on the page itself. Either way it
 * is driven by the same messages:
 *
 *   in   start {sr, hasRef, refKind, use, gateDb, minClarity, saved}   a fresh filter for new
 *                                     inputs (refKind: 'piano' USB audio, or 'app' sound)
 *        block {f, a, b, perf, ctx}   512 samples of mic (a) and piano audio (b) from
 *                                     context frame f, forwarded at page time perf, when
 *                                     the audio clock read ctx seconds
 *        keys {events: [{t, p, on}]}  keys the app pressed and released (page time)
 *        plan {plan}                  when singing is expected (see Listener.planner)
 *        use {on}                     filter, or just listen (still learning the room)
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

  const RECORD_SEC = 40;

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
      // the last recordSec seconds, for "Save the last 40 seconds" (tuning the filter to a room)
      this.rec = [];
      this.recFrames = [];
      this.recPlans = [];
      this.recordSec = RECORD_SEC;
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
        case 'plan': {
          this.plan = m.plan || { mode: 'stopped' };
          const j = JSON.stringify(this.plan);
          if (j !== this.lastPlanJson) {
            this.lastPlanJson = j;
            this.recPlans.push([m.at || null, this.plan]);
            if (this.recPlans.length > 400) this.recPlans.shift();
          }
          return;
        }
        case 'dump':
          return this.dump();
        case 'use':
          this.use = m.on !== false;
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
      this.recordSec = m.recordSec || RECORD_SEC;
      this.hasRef = !!m.hasRef;
      this.refKind = m.refKind || 'piano';
      this.use = m.use !== false;
      this.gateDb = m.gateDb;
      if (!this.tracker || this.tracker.det.sr !== this.sr) this.tracker = new SF.PitchTracker(this.sr, { gateDb: m.gateDb, minClarity: m.minClarity });
      else this.tracker.gateDb = m.gateDb;
      // the app's own sound reaches the mic after the computer's output delay as well, which
      // can be long (Bluetooth speakers): look further for it
      this.pf = new SF.PianoFilter(this.sr, this.refKind === 'app' ? { maxLag: 0.45 } : {});
      if (m.saved) this.saved = m.saved;
      if (this.saved) this.pf.importState(this.saved);
      this.pfFrame0 = null; // context frame of the filter's first sample
      this.lastEnd = 0;
      this.offsetMs = null;
      this.keys = [];
      this.rec = [];
      this.recFrames = [];
      this.running = true;
      this.sendStatus();
    }
    /** Page time of context frame f. */
    perfOfFrame(f) {
      return this.offsetMs + (f / this.sr) * 1000;
    }
    /** Should nobody be singing at page time t? Then the piano is learned from (2: the
     *  calibration, where nobody sings for sure). */
    expectQuiet(t) {
      const p = this.plan;
      if (p.mode === 'calib') return 2;
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
      const quiet = this.expectQuiet((t0 + t1) / 2);
      pf.push(a, this.hasRef ? b : null, quiet, onset, events);
      this.rec.push({ f, a, b, s: m.s || null, perf: m.perf, ctx: m.ctx, q: quiet === 2 ? 2 : quiet ? 1 : 0 });
      while (this.rec.length && f - this.rec[0].f > this.recordSec * this.sr) this.rec.shift();
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
        const fr = SF.analyzeFrame(pf, this.tracker, end, this.perfOfFrame(this.pfFrame0 + end - W / 2), { bypass: !this.use });
        this.post({ type: 'frame', fr });
        const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
        this.recFrames.push([this.pfFrame0 + end, fr.source, fr.voiced ? r3(fr.midi) : null, fr.why || null, r3(fr.presence), r3(fr.dev), r3(fr.clarity), r3(fr.raw), Math.round(fr.micDb), Math.round(fr.echoDb)]);
        while (this.recFrames.length && this.pfFrame0 + end - this.recFrames[0][0] > this.recordSec * this.sr) this.recFrames.shift();
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
          measured: pf.kN.reduce((n, k) => n + (k >= 6 ? 1 : 0), 0), // keys measured on their own
          micDrift: Math.round(pf.micDrift * 10) / 10, // dB the piano's level at the mic moved between chords
          runCancel: pf.recentCancel == null ? null : Math.round(pf.recentCancel * 10) / 10, // dB removed lately
          noEcho: !!pf.noEcho, // the mic doesn't hear the piano (headphones?)
          use: this.use !== false,
        },
      });
    }
    /** The last recordSec seconds of both inputs, with what was decided about them. */
    dump() {
      const rec = this.rec;
      const n = rec.reduce((k, r) => k + r.a.length, 0);
      const mic = new Float32Array(n);
      const ref = new Float32Array(n);
      const side = rec.some((r) => r.s) ? new Float32Array(n) : null;
      let k = 0;
      const blocks = [];
      for (const r of rec) {
        mic.set(r.a, k);
        if (r.b) ref.set(r.b, k);
        if (side && r.s) side.set(r.s, k);
        blocks.push([r.f, Math.round(r.perf * 10) / 10, Math.round(r.ctx * 1e6) / 1e6, r.q]);
        k += r.a.length;
      }
      const pf = this.pf;
      const st = pf
        ? {
            delay: pf.dUsed,
            ready: pf.ready,
            cancelDb: pf.cancelDb,
            lMean: pf.lMean,
            lVar: pf.lVar,
            fMean: pf.fMean,
            fVar: pf.fVar,
            fCount: pf.fCount,
            voiceDb: pf.voiceDb,
            offBy: pf.offBy,
            realigns: pf.realigns || 0,
            keyLearn: Array.from(pf.keyLearn),
            kOff: Array.from(pf.kMean),
            kN: Array.from(pf.kN),
            tune: Array.from(pf.tune),
            tuneN: Array.from(pf.tuneN),
            room: pf.solved ? pf.exportState() : null,
          }
        : null;
      const meta = {
        v: 1,
        sr: this.sr,
        hasRef: this.hasRef,
        refKind: this.refKind, // 'piano' (its USB audio) or 'app' (the app's own sound)
        use: this.use,
        gateDb: this.gateDb,
        offsetMs: this.offsetMs,
        pfFrame0: this.pfFrame0,
        blocks,
        frames: this.recFrames.slice(),
        frameCols: ['frameEnd', 'source', 'midi', 'why', 'presence', 'dev', 'clarity', 'raw', 'micDb', 'echoDb'],
        keys: this.keys.slice(),
        plans: this.recPlans.slice(),
        filter: st,
      };
      if (meta.filter && meta.filter.room && meta.filter.room.hc) meta.filter.room.hc = Array.from(meta.filter.room.hc);
      if (meta.filter && meta.filter.room) {
        // big, and the recording rebuilds them
        delete meta.filter.room.spec;
        delete meta.filter.room.stats;
      }
      if (side) meta.side = true;
      this.post({ type: 'dump', mic, ref, side, meta }, side ? [mic.buffer, ref.buffer, side.buffer] : [mic.buffer, ref.buffer]);
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
      '\nconst ears = new self.SF.Ears((m, tr) => self.postMessage(m, tr || []));\n' +
      'self.onmessage = (e) => ears.handle(e.data);\n' +
      "self.postMessage({ type: 'hello' });\n"
    );
  };

  SF.Ears = Ears;
});
