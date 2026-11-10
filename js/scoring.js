/* Scoring: did the singer hit each note?
 *
 * Frames from the mic arrive with the time they describe. Each is mapped onto the
 * playlist position P, and only counts while a note to be sung is sounding —
 * after a short grace for the attack. Nothing is listened to during the
 * reference chords. When a note ends it gets a verdict from the median of its
 * frames: hit (within the tolerance), close (within twice it), off, or silent.
 */
(function (root) {
  'use strict';
  const SF = root.SF;

  function cents(sung, target, octaveFree) {
    let c = (sung - target) * 100;
    if (octaveFree) c = ((((c + 600) % 1200) + 1200) % 1200) - 600;
    return c;
  }

  class Scorer extends SF.Emitter {
    constructor(player, opts) {
      super();
      this.player = player;
      this.opts = Object.assign(
        {
          tolerance: 35, // cents
          octaveFree: false,
          minVoiced: 0.3, // share of a note's frames that must be sung
          minJudged: 0.25, // share of a note's frames that must be judged at all (not 'unsure')
          // seconds not judged at a note's start and end, while the voice moves between
          // notes (still on the last one, or already on the next)
          grace: 0.12,
          endGrace: 0.12,
          chordGrace: 0.08, // extra after a reference chord: the piano is still ringing
          latency: 30, // ms the mic is late, beyond the analysis window
          clickNear: null, // (t) => true when a metronome click sounded around page time t
        },
        opts || {}
      );
      this.reset();
    }
    set(opts) {
      Object.assign(this.opts, opts);
    }
    reset() {
      this.acc = new Map(); // key -> accumulator for a note (or a slot in 'any' mode)
      this.results = new Map(); // key -> result
      this.trace = []; // {P, midi, st}
      this.live = { midi: null, target: null, cents: null, status: 'idle', listening: false, source: '' };
      this.done = new Set(); // segments already scored
      this.session = { started: Date.now(), rounds: [], notes: [] };
      this.byRound = new Map(); // round index -> latest result this session
      this.prevCache = new Map();
    }
    statusOf(c) {
      const t = this.opts.tolerance;
      const a = Math.abs(c);
      return a <= t ? 'hit' : a <= 2 * t ? 'close' : 'off';
    }
    keyOf(seg, n) {
      return this.player.cfg.voice === 'any' && this.player.ex.voices > 1 ? seg.uid + ':s' + n.slot : seg.uid + ':' + n.id;
    }
    /** Window of a note in which frames count, in P units. */
    window(seg, n) {
      const p = this.player;
      const [P0, P1] = p.noteP(seg, n);
      const len = P1 - P0;
      // each edge at most a third of the note, so a short note still gets judged
      let g = Math.min(this.opts.grace * p.speed, 0.33 * len);
      // right after a reference chord the piano is still ringing: give a little more
      if (n.afterChord) g = Math.min(g + this.opts.chordGrace * p.speed, 0.45 * len);
      const endG = Math.min(this.opts.endGrace * p.speed, 0.33 * len);
      return [P0 + g, P1 - endG, P0, P1];
    }
    /** One analysed mic frame. */
    frame(fr) {
      const p = this.player;
      if (!p.ex) return;
      // a metronome click drowned this frame out: it says nothing about the voice
      if (!fr.voiced && this.opts.clickNear && this.opts.clickNear(fr.t - this.opts.latency)) fr = Object.assign({}, fr, { source: 'click' });
      const P = p.positionAt(fr.t - this.opts.latency);
      if (P == null) {
        this.live.listening = false;
        return;
      }
      const seg = this.segmentAt(P);
      const live = this.live;
      live.midi = fr.voiced ? fr.midi : null;
      live.source = fr.source || '';
      live.P = P;
      if (!seg) {
        live.target = null;
        live.status = 'idle';
        live.listening = false;
        return;
      }
      // the notes to sing right now, and those sounding but in their unjudged edges
      const targets = [];
      const edges = [];
      let near = false;
      p.forNotes(P - 0.0001, P + 0.0001, (n, s) => {
        if (s !== seg || !p.isTarget(n)) return;
        const [a, b, P0, P1] = this.window(seg, n);
        if (P >= P0 && P < P1) near = true;
        if (P >= a && P < b) targets.push(n);
        else if (P >= P0 && P < P1) {
          edges.push(n);
          // how soon the voice settles on the note counts from its very start
          if (P < a && fr.voiced && Math.abs(cents(fr.midi, n.pitch, this.opts.octaveFree)) <= this.opts.tolerance) {
            const acc = this.accFor(seg, n);
            if (acc.firstOk == null) acc.firstOk = P;
          }
        }
      });
      live.listening = near;
      let st = 'idle';
      if (!targets.length) {
        // between notes, or in a note's grace edge: show the note, judge nothing
        let best = edges[0] || null;
        let bc = null;
        if (best && fr.voiced) {
          bc = cents(fr.midi, best.pitch, this.opts.octaveFree);
          for (const n of edges) {
            const c = cents(fr.midi, n.pitch, this.opts.octaveFree);
            if (Math.abs(c) < Math.abs(bc)) [best, bc] = [n, c];
          }
        }
        live.target = best ? best.pitch : null;
        live.cents = bc;
      } else {
        // the target the voice is closest to (several only in 'any' mode or unisons)
        let best = targets[0];
        let bc = fr.voiced ? cents(fr.midi, best.pitch, this.opts.octaveFree) : null;
        if (fr.voiced) {
          for (const n of targets) {
            const c = cents(fr.midi, n.pitch, this.opts.octaveFree);
            if (Math.abs(c) < Math.abs(bc)) {
              best = n;
              bc = c;
            }
          }
        }
        const keys = new Set();
        // 'learning' / 'unsure': the piano can't be told apart from you here, so these
        // frames say nothing either way (but they are counted: a note judged from only a few
        // frames gets no verdict)
        const unknown = fr.source === 'learning' || fr.source === 'unsure' || fr.source === 'click';
        for (const n of targets) {
          const k = this.keyOf(seg, n);
          if (keys.has(k)) continue;
          keys.add(k);
          const a = this.accFor(seg, n, k);
          a.all++;
          if (unknown) continue;
          a.frames++;
          if (fr.voiced) {
            // in 'any' mode a slot is scored against whichever voice was sung
            const target = this.player.cfg.voice === 'any' ? best : n;
            const c = cents(fr.midi, target.pitch, this.opts.octaveFree);
            a.voiced++;
            a.cents.push(c);
            a.voices.set(target.voice, (a.voices.get(target.voice) || 0) + 1);
            if (a.firstOk == null && Math.abs(c) <= this.opts.tolerance) a.firstOk = P;
          }
        }
        live.target = best.pitch;
        live.cents = bc;
        st = unknown ? 'idle' : fr.voiced ? this.statusOf(bc) : 'silent';
      }
      live.status = st;
      this.trace.push({ P, midi: fr.voiced ? fr.midi : null, st: near ? st : 'idle' });
      if (this.trace.length > 3000) this.trace.splice(0, 1000);
    }
    accFor(seg, n, key) {
      const k = key || this.keyOf(seg, n);
      let a = this.acc.get(k);
      if (!a) {
        a = { frames: 0, all: 0, voiced: 0, cents: [], voices: new Map(), seg, note: n, firstOk: null };
        this.acc.set(k, a);
      }
      return a;
    }
    /** The note sung just before n in its key (same voice), or null for the first. */
    prevOf(seg, n) {
      const p = this.player;
      const ck = seg.r + ':' + (p.ex.voices > 1 ? n.voice : 0);
      let m = this.prevCache.get(ck);
      if (!m || m.ex !== p.ex) {
        m = { ex: p.ex, prev: new Map() };
        const list = p.ex.rounds[seg.r].notes.filter((x) => x.role === 'sing' && (p.ex.voices <= 1 || x.voice === n.voice)).sort((a, b) => a.s0 - b.s0);
        // notes starting together (a chord in the sung part) share what came before them
        let before = null;
        let groupS0 = -Infinity;
        let groupLast = null;
        for (const x of list) {
          if (x.s0 - groupS0 > 1e-3) {
            before = groupLast;
            groupS0 = x.s0;
          }
          m.prev.set(x.id, before);
          groupLast = x;
        }
        this.prevCache.set(ck, m);
      }
      return m.prev.get(n.id) || null;
    }
    /** What the breakdown keeps of a judged note. */
    detail(a, res) {
      const p = this.player;
      const n = a.note;
      const rd = p.ex.rounds[a.seg.r];
      const [, , P0] = this.window(a.seg, n);
      const prev = this.prevOf(a.seg, n);
      const cs = a.cents;
      let sd = null;
      if (cs.length >= 4) {
        const m = SF.mean(cs);
        sd = Math.sqrt(cs.reduce((s, c) => s + (c - m) * (c - m), 0) / cs.length);
      }
      return {
        p: n.pitch,
        deg: rd.key ? SF.solfege(n.pitch, rd.key.doPc) : null,
        dir: prev ? Math.sign(n.pitch - prev.pitch) : null,
        st: res.status,
        c: res.cents == null ? null : Math.round(res.cents),
        rt: a.firstOk == null ? null : Math.round((Math.max(0, a.firstOk - P0) / p.speed) * 1000),
        sd: sd == null ? null : Math.round(sd),
        r: a.seg.r,
      };
    }
    segmentAt(P) {
      const p = this.player;
      for (const s of p.queue) if (s.kind === 'round' && P >= s.P0 && P < s.P1) return s;
      for (let i = p.past.length - 1; i >= 0; i--) {
        const s = p.past[i];
        if (s.kind === 'round' && P >= s.P0 && P < (s.cutAt != null ? s.cutAt : s.P1)) return s;
      }
      return null;
    }
    /** Give notes and keys their verdicts once they are over. Call often. */
    update() {
      const p = this.player;
      if (!p.ex) return;
      const Pnow = p.position() - ((this.opts.latency + 60) / 1000) * p.speed;
      for (const [k, a] of this.acc) {
        if (this.results.has(k)) continue;
        const [, , , P1] = this.window(a.seg, a.note);
        const end = a.seg.cutAt != null ? Math.min(P1, a.seg.cutAt) : P1;
        if (Pnow < end) continue;
        const res = this.verdict(a);
        this.results.set(k, res);
        this.last = { res, note: a.note, seg: a.seg };
        if (res.status !== 'none') {
          this.session.notes.push(this.detail(a, res));
          if (this.session.notes.length > 5000) this.session.notes.splice(0, 1000);
        }
        this.emit('note', { res, note: a.note, seg: a.seg });
      }
      for (const seg of p.past.concat(p.queue)) {
        if (seg.kind !== 'round' || this.done.has(seg.uid)) continue;
        const end = seg.cutAt != null ? seg.cutAt : seg.P1;
        if (Pnow < end) continue;
        this.done.add(seg.uid);
        this.scoreRound(seg);
      }
      // forget accumulators far in the past
      if (this.acc.size > 4000) {
        let i = 0;
        for (const k of this.acc.keys()) {
          if (i++ > 1000) break;
          this.acc.delete(k);
        }
      }
    }
    verdict(a) {
      // too little of the note could be told apart from the piano to say anything
      if (a.frames < 2 || a.frames < this.opts.minJudged * (a.all || a.frames)) return { status: 'none' };
      const ratio = a.voiced / a.frames;
      let voice = null;
      let vmax = 0;
      for (const [v, c] of a.voices) if (c > vmax) [voice, vmax] = [v, c];
      if (ratio < this.opts.minVoiced || a.cents.length < 2) return { status: 'silent', voiced: ratio, voice };
      const med = SF.median(a.cents);
      return { status: this.statusOf(med), cents: med, voiced: ratio, voice };
    }
    /** Result for a drawn note, if it has one yet. */
    resultFor(seg, n) {
      return this.results.get(this.keyOf(seg, n)) || null;
    }
    scoreRound(seg) {
      const p = this.player;
      const rd = p.ex.rounds[seg.r];
      const seen = new Set();
      const counts = { hit: 0, close: 0, off: 0, silent: 0 };
      const cs = [];
      let total = 0;
      let reached = 0;
      for (const n of rd.notes) {
        if (!p.isTarget(n)) continue;
        const k = this.keyOf(seg, n);
        if (seen.has(k)) continue;
        seen.add(k);
        total++;
        const [P0] = p.noteP(seg, n);
        if (seg.cutAt != null && P0 >= seg.cutAt) continue;
        reached++;
        const r = this.results.get(k) || (this.acc.has(k) ? this.verdict(this.acc.get(k)) : null);
        if (!r || r.status === 'none') continue;
        counts[r.status]++;
        if (r.cents != null) cs.push(r.cents);
      }
      const n = counts.hit + counts.close + counts.off + counts.silent;
      // a key cut short by a jump only counts if most of it was sung
      if (!n || (seg.cutAt != null && reached < 0.6 * total)) return null;
      const res = {
        r: seg.r,
        label: rd.label,
        root: rd.key ? rd.key.rootMidi : null,
        lo: rd.singLo,
        hi: rd.singHi,
        n,
        hit: counts.hit,
        close: counts.close,
        off: counts.off,
        silent: counts.silent,
        cents: cs.length ? SF.mean(cs) : null,
        score: (counts.hit + 0.5 * counts.close) / n,
        at: Date.now(),
      };
      this.session.rounds.push(res);
      this.byRound.set(seg.r, res);
      this.emit('round', res);
      return res;
    }
  }

  // ---------- history (localStorage) ----------
  const History = {
    load() {
      return SF.store.get('history', {});
    },
    add(exId, session, meta) {
      if (!session || !session.rounds.length) return;
      const all = History.load();
      const list = (all[exId] = all[exId] || []);
      const rounds = session.rounds;
      const n = rounds.reduce((s, r) => s + r.n, 0);
      const pts = rounds.reduce((s, r) => s + r.hit + 0.5 * r.close, 0);
      list.push(
        Object.assign(
          {
            t: session.started,
            dur: Math.round((Date.now() - session.started) / 1000),
            keys: rounds.length,
            notes: n,
            score: n ? pts / n : 0,
            rounds: rounds.map((r) => ({ r: r.r, l: r.label, root: r.root, n: r.n, h: r.hit, c: r.close, o: r.off, s: r.silent, ct: r.cents == null ? null : Math.round(r.cents) })),
          },
          meta || {}
        )
      );
      if (session.notes && session.notes.length && SF.Report) list[list.length - 1].bd = SF.Report.compact(session.notes);
      if (list.length > 200) list.splice(0, list.length - 200);
      // the breakdowns (by scale degree, note and timing) only for the latest runs: they are bigger
      for (let i = 0; i < list.length - 60; i++) delete list[i].bd;
      SF.store.set('history', all);
    },
    forExercise(exId) {
      return History.load()[exId] || [];
    },
    clear(exId) {
      const all = History.load();
      if (exId) delete all[exId];
      SF.store.set('history', exId ? all : {});
    },
    csv() {
      const all = History.load();
      const rows = [['exercise', 'date', 'bpm', 'voice', 'guide', 'tolerance', 'key', 'root_midi', 'notes', 'hit', 'close', 'off', 'silent', 'mean_cents']];
      for (const [ex, list] of Object.entries(all)) {
        for (const s of list) {
          for (const r of s.rounds) {
            rows.push([ex, new Date(s.t).toISOString(), s.bpm, s.voice, s.guide, s.tol, r.l, r.root, r.n, r.h, r.c, r.o, r.s, r.ct == null ? '' : r.ct]);
          }
        }
      }
      return rows.map((r) => r.map((x) => (/[",\n]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : x)).join(',')).join('\n');
    },
  };

  SF.Scorer = Scorer;
  SF.History = History;
  SF.centsOff = cents;
})(typeof window !== 'undefined' ? window : globalThis);
