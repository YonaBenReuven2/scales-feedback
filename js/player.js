/* Transport: clock, playlist of rounds, and the note scheduler.
 *
 * Position P is measured in "file seconds" (seconds at the file's own tempo).
 * Real time runs P / speed, where speed = chosen BPM / file BPM.
 * The playlist is a queue of segments laid end to end on the P axis: a short
 * silent gap (pre-roll) and then rounds, in file order, looped, shuffled or with
 * out-of-range keys skipped. Notes are sent to the output a little ahead of
 * time with exact timestamps; nothing plays that isn't inside that window, so
 * pausing or jumping stops at once.
 */
(function (root) {
  'use strict';
  const SF = root.SF;

  function makeTicker(fn, ms) {
    let fallback = null;
    const useInterval = () => {
      if (!fallback) fallback = setInterval(fn, ms);
    };
    try {
      const src = 'let id=null;onmessage=e=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = fn;
      w.onerror = () => useInterval();
      w.postMessage(ms);
      return {
        stop() {
          w.terminate();
          if (fallback) clearInterval(fallback);
        },
      };
    } catch (e) {
      useInterval();
      return {
        stop() {
          clearInterval(fallback);
        },
      };
    }
  }

  class Player extends SF.Emitter {
    constructor(cfg, opts) {
      super();
      opts = opts || {};
      this.ex = null;
      this.state = 'paused'; // 'playing' | 'paused' | 'ended'
      this.speed = 1;
      this.P = 0; // position while paused
      this.P0 = 0; // anchor
      this.t0 = 0;
      this.anchoredAt = 0;
      this.queue = []; // upcoming and current segments
      this.past = []; // finished or cut segments, kept for drawing
      this.pending = [];
      this.schedP = 0;
      this.endP = Infinity;
      this.output = null;
      this.curSeg = null;
      this.shuffled = [];
      this.cfg = Object.assign(
        {
          guide: true, // play the notes you sing
          voice: 0, // index, or 'any'
          velAcc: 50,
          velSing: 62,
          loop: false,
          shuffle: false,
          skip: false,
          lo: 40,
          hi: 69,
          subset: null, // e.g. weak keys only
          preroll: 1.5, // seconds of falling notes before the first chord
          jumpGap: 0.6, // seconds of gap when jumping while playing
        },
        cfg || {}
      );
      this.ticker = opts.ticker === false ? null : makeTicker(() => this.tick(), 10);
    }

    // ---------- loading ----------
    load(ex, opts) {
      this.stopSound();
      this.ex = ex;
      this.speed = opts && opts.bpm ? opts.bpm / ex.bpm : 1;
      this.reshuffle();
      this.past = [];
      this.queue = [];
      this.state = 'paused';
      this.P = 0;
      this.endP = Infinity;
      this.curSeg = null;
      this.seekRound(this.firstRound(), { preroll: this.cfg.preroll });
      this.emit('load', ex);
    }
    reshuffle() {
      const n = this.ex ? this.ex.rounds.length : 0;
      const a = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      this.shuffled = a;
    }
    setOutput(out) {
      if (this.output && this.output !== out) this.output.allOff();
      this.output = out;
      if (this.state === 'playing') this.restrike(this.position());
    }
    set(cfg) {
      const replan = ['loop', 'shuffle', 'skip', 'lo', 'hi', 'subset', 'voice'].some((k) => k in cfg && cfg[k] !== this.cfg[k]);
      const resound = ['guide', 'voice'].some((k) => k in cfg && cfg[k] !== this.cfg[k]);
      if (cfg.shuffle && !this.cfg.shuffle) this.reshuffle();
      Object.assign(this.cfg, cfg);
      if (replan) this.replan();
      if (resound && this.state === 'playing') {
        // a note that just became silent stops now; one that just became audible starts
        this.output && this.output.allOff();
        this.pending = [];
        const P = this.position();
        this.schedP = P;
        this.restrike(P, true);
      }
      this.emit('config', this.cfg);
    }

    // ---------- clock ----------
    position(now) {
      if (this.state !== 'playing') return this.P;
      return this.P0 + (((now == null ? SF.now() : now) - this.t0) / 1000) * this.speed;
    }
    /** Position at a past instant t (ms), or null if the clock was re-anchored since. */
    positionAt(t) {
      if (this.state !== 'playing' || t < this.anchoredAt) return null;
      return this.P0 + ((t - this.t0) / 1000) * this.speed;
    }
    perfAt(P) {
      return this.t0 + ((P - this.P0) / this.speed) * 1000;
    }
    anchor(P, now) {
      this.P0 = P;
      this.t0 = now == null ? SF.now() : now;
      this.anchoredAt = this.t0;
    }
    get bpm() {
      return this.ex ? this.ex.bpm * this.speed : 120;
    }
    setBpm(bpm) {
      if (!this.ex) return;
      bpm = SF.clamp(bpm, 20, 400);
      const now = SF.now();
      const P = this.position(now);
      this.speed = bpm / this.ex.bpm;
      if (this.state === 'playing') {
        this.P0 = P;
        this.t0 = now; // keep anchoredAt: earlier mic frames still map correctly enough
      } else this.P = P;
      this.emit('tempo', this.bpm);
    }

    // ---------- transport ----------
    play() {
      if (!this.ex || this.state === 'playing') return;
      if (this.state === 'ended') {
        this.seekRound(this.firstRound(), { preroll: this.cfg.preroll });
      }
      const now = SF.now();
      this.anchor(this.P, now);
      this.state = 'playing';
      this.schedP = this.P;
      this.pending = [];
      this.restrike(this.P);
      this.tick();
      this.emit('state', this.state);
    }
    pause() {
      if (this.state !== 'playing') return;
      this.P = this.position();
      this.state = 'paused';
      this.stopSound();
      this.emit('state', this.state);
    }
    toggle() {
      if (this.state === 'playing') this.pause();
      else this.play();
    }
    stopSound() {
      this.pending = [];
      if (this.output) this.output.allOff();
    }
    /** Jump to the start of round r. */
    seekRound(r, opts) {
      if (!this.ex) return;
      r = SF.clamp(r | 0, 0, this.ex.rounds.length - 1);
      const playing = this.state === 'playing';
      const now = SF.now();
      const P = this.position(now);
      this.stopSound();
      this.cutQueue(P);
      const gap = opts && opts.preroll != null ? opts.preroll : playing ? this.cfg.jumpGap : this.cfg.preroll;
      let at = P;
      if (gap > 0) {
        const g = this.seg('gap', r, at, gap * this.speed);
        this.queue.push(g);
        at = g.P1;
      }
      this.queue.push(this.seg('round', r, at));
      this.endP = Infinity;
      if (playing) {
        this.anchor(P, now);
        this.schedP = P;
      } else {
        this.P = P;
        if (this.state === 'ended') this.state = 'paused';
      }
      this.curSeg = null;
      this.ensureQueue(P + 10 * this.speed);
      this.emit('seek', r);
    }
    /** The round being played (or about to be, during a gap). */
    currentRound(P) {
      const s = this.segmentAt(P == null ? this.position() : P, true);
      return s ? s.r : this.ex ? this.firstRound() : 0;
    }
    next() {
      const r = this.nextRound(this.currentRound(), true);
      if (r >= 0) this.seekRound(r);
    }
    prev() {
      const P = this.position();
      const s = this.segmentAt(P, true);
      if (s && s.kind === 'round' && (P - s.P0) / this.speed > 1.5) return this.seekRound(s.r); // restart this key
      const r = this.prevRound(s ? s.r : this.currentRound());
      this.seekRound(r >= 0 ? r : s ? s.r : 0);
    }
    restart() {
      this.seekRound(this.firstRound(), { preroll: this.cfg.preroll });
    }

    // ---------- playlist ----------
    eligible(r) {
      const c = this.cfg;
      if (!c.skip) return true;
      const rd = this.ex.rounds[r];
      const v = c.voice === 'any' || this.ex.voices <= 1 ? null : c.voice;
      const lo = v == null ? rd.singLo : rd.voiceLo[v];
      const hi = v == null ? rd.singHi : rd.voiceHi[v];
      if (lo == null) return true;
      return lo >= c.lo && hi <= c.hi;
    }
    order() {
      const all = this.ex.rounds.map((r) => r.i);
      let o = this.cfg.subset && this.cfg.subset.length ? this.cfg.subset.slice() : this.cfg.shuffle ? this.shuffled.slice() : all;
      const e = o.filter((r) => r < this.ex.rounds.length && this.eligible(r));
      return e.length ? e : o;
    }
    firstRound() {
      const o = this.order();
      return o.length ? o[0] : 0;
    }
    nextRound(r, ignoreLoop) {
      if (this.cfg.loop && !ignoreLoop && r >= 0) return r;
      const o = this.order();
      const i = o.indexOf(r);
      if (i >= 0) return i + 1 < o.length ? o[i + 1] : -1;
      if (!this.cfg.shuffle && !(this.cfg.subset && this.cfg.subset.length)) {
        const later = o.find((x) => x > r);
        return later == null ? -1 : later;
      }
      return o.length ? o[0] : -1;
    }
    prevRound(r) {
      const o = this.order();
      const i = o.indexOf(r);
      if (i > 0) return o[i - 1];
      if (i === 0) return -1;
      const earlier = o.filter((x) => x < r);
      return earlier.length ? earlier[earlier.length - 1] : -1;
    }

    // ---------- segments ----------
    seg(kind, r, P0, len) {
      const rd = this.ex.rounds[r];
      const s = { uid: SF.uid(), kind, r, P0 };
      if (kind === 'round') {
        s.s0 = rd.s0;
        s.s1 = rd.s1;
        s.P1 = P0 + (rd.s1 - rd.s0);
      } else s.P1 = P0 + len;
      return s;
    }
    ensureQueue(Pmax) {
      if (!this.ex) return;
      let guard = 0;
      while (this.queue.length && this.queue[this.queue.length - 1].P1 < Pmax && guard++ < 64) {
        const last = this.queue[this.queue.length - 1];
        const r = last.kind === 'gap' ? -2 : this.nextRound(last.r);
        if (r === -2) break; // a gap is always followed by its round already
        if (r < 0) {
          this.endP = last.P1;
          break;
        }
        this.queue.push(this.seg('round', r, last.P1));
      }
    }
    /** Drop segments that haven't started yet, after a change to loop/skip/shuffle. */
    replan() {
      if (!this.ex || !this.queue.length) return;
      const P = Math.max(this.position(), this.schedP);
      const keep = this.queue.filter((s) => s.P0 <= P);
      if (!keep.length) return;
      // a lead-in gap belongs to the round after it: keep that round too
      const last = keep[keep.length - 1];
      if (last.kind === 'gap') {
        const its = this.queue[this.queue.indexOf(last) + 1];
        if (its) keep.push(its);
      }
      this.queue = keep;
      this.endP = Infinity;
      this.ensureQueue(this.position() + 10 * this.speed);
      this.emit('replan');
    }
    /** Move everything to the past, cutting the current segment at P. */
    cutQueue(P) {
      for (const s of this.queue) {
        if (s.P0 >= P) continue;
        if (s.P1 > P) s.cutAt = P;
        this.past.push(s);
      }
      this.queue = [];
      const keepFrom = P - 120;
      this.past = this.past.filter((s) => s.P1 > keepFrom && (s.cutAt == null || s.cutAt > s.P0));
    }
    segmentAt(P, orNext) {
      for (const s of this.queue) {
        if (P >= s.P0 && P < s.P1) {
          if (s.kind === 'gap' && orNext) return this.queue[this.queue.indexOf(s) + 1] || s;
          return s;
        }
      }
      if (orNext) {
        const later = this.queue.find((s) => s.P0 > P && s.kind === 'round');
        if (later) return later;
        const prevs = this.queue.filter((s) => s.kind === 'round');
        return prevs.length ? prevs[prevs.length - 1] : null;
      }
      return null;
    }
    /** Every segment that may have notes in [Pa, Pb]. */
    segmentsIn(Pa, Pb) {
      const out = [];
      for (const s of this.past) if (s.kind === 'round' && s.P1 > Pa && s.P0 < Pb) out.push(s);
      for (const s of this.queue) if (s.kind === 'round' && s.P1 > Pa && s.P0 < Pb) out.push(s);
      return out;
    }
    noteP(seg, n) {
      const P0 = seg.P0 + (n.s0 - seg.s0);
      let P1 = Math.min(seg.P0 + (n.s1 - seg.s0), seg.P1);
      if (seg.cutAt != null) P1 = Math.min(P1, seg.cutAt);
      return [P0, P1];
    }
    /** Calls fn(note, seg, P0, P1) for each note overlapping [Pa, Pb]. */
    forNotes(Pa, Pb, fn) {
      for (const seg of this.segmentsIn(Pa, Pb)) {
        const notes = this.ex.rounds[seg.r].notes;
        const sb = seg.s0 + (Pb - seg.P0);
        for (const n of notes) {
          if (n.s0 >= sb) break;
          const [P0, P1] = this.noteP(seg, n);
          if (seg.cutAt != null && P0 >= seg.cutAt) continue;
          if (P1 <= Pa) continue;
          fn(n, seg, P0, P1);
        }
      }
    }

    // ---------- what sounds ----------
    isTarget(n) {
      if (n.role !== 'sing') return false;
      return this.cfg.voice === 'any' || this.ex.voices <= 1 || n.voice === this.cfg.voice;
    }
    audible(n) {
      if (n.role === 'acc') return true;
      if (this.isTarget(n)) return !!this.cfg.guide;
      return true; // the other voices always play
    }
    velocity(n) {
      const base = n.role === 'acc' ? this.cfg.velAcc : this.cfg.velSing;
      const scale = n.vel / (this.ex.maxVel[n.role] || 127);
      return SF.clamp(Math.round(base * scale), 1, 127);
    }
    /** Sound the notes that are already held at P (after play, a jump, or a voice change). */
    restrike(P, includeShort) {
      if (!this.ex) return;
      const minLeft = includeShort ? 0.05 : 0.25;
      const seen = new Set();
      this.forNotes(P, P + 1e-6, (n, seg, P0, P1) => {
        // notes starting at P or later are the scheduler's job
        if (P0 >= P - 1e-9 || P1 - P < minLeft * this.speed || !this.audible(n)) return;
        if (seen.has(n.pitch)) return;
        seen.add(n.pitch);
        this.pending.push({ P, on: true, pitch: n.pitch, vel: this.velocity(n) });
        this.pending.push({ P: P1, on: false, pitch: n.pitch });
      });
    }

    // ---------- the scheduler ----------
    tick() {
      if (this.state !== 'playing' || !this.ex) return;
      const now = SF.now();
      const P = this.position(now);
      const look = ((this.output ? this.output.lookahead : 100) / 1000) * this.speed;
      const horizon = P + look;
      this.ensureQueue(horizon + 10 * this.speed);

      if (horizon > this.schedP) {
        for (const seg of this.queue) {
          if (seg.kind !== 'round' || seg.P1 <= this.schedP || seg.P0 >= horizon) continue;
          const notes = this.ex.rounds[seg.r].notes;
          const sa = seg.s0 + (Math.max(this.schedP, seg.P0) - seg.P0);
          const sb = seg.s0 + (Math.min(horizon, seg.P1) - seg.P0);
          const batch = new Set();
          for (let i = SF.lowerBound(notes, sa, (x) => x.s0); i < notes.length && notes[i].s0 < sb; i++) {
            const n = notes[i];
            if (!this.audible(n)) continue;
            const [P0, P1] = this.noteP(seg, n);
            const k = n.pitch + ':' + Math.round(P0 * 4000);
            if (batch.has(k)) continue; // voices in unison: strike the key once
            batch.add(k);
            this.pending.push({ P: P0, on: true, pitch: n.pitch, vel: this.velocity(n) });
            this.pending.push({ P: P1, on: false, pitch: n.pitch });
          }
        }
        this.schedP = horizon;
      }
      if (this.pending.length) {
        this.pending.sort((a, b) => a.P - b.P || a.on - b.on);
        let i = 0;
        for (; i < this.pending.length && this.pending[i].P <= horizon; i++) {
          const e = this.pending[i];
          if (!this.output) continue;
          const at = this.perfAt(e.P);
          if (e.on) this.output.noteOn(e.pitch, e.vel, at);
          else this.output.noteOff(e.pitch, at);
        }
        if (i) this.pending.splice(0, i);
      }

      const seg = this.segmentAt(P);
      if (seg !== this.curSeg) {
        const prev = this.curSeg;
        this.curSeg = seg;
        if (prev) this.emit('segmentEnd', prev);
        if (seg) this.emit('segment', seg);
      }
      // retire old segments
      while (this.queue.length > 1 && this.queue[0].P1 < P - 1) this.past.push(this.queue.shift());
      if (this.past.length > 200) this.past.splice(0, this.past.length - 200);

      if (P >= this.endP + 0.3) {
        this.P = this.endP;
        this.state = 'ended';
        this.stopSound();
        this.curSeg = null;
        this.emit('state', this.state);
        this.emit('ended');
      }
    }

    destroy() {
      if (this.ticker) this.ticker.stop();
      this.stopSound();
    }
  }

  SF.Player = Player;
})(typeof window !== 'undefined' ? window : globalThis);
