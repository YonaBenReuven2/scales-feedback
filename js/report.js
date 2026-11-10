/* How you're doing, in detail: from the verdict of every note sung (scale degree, which way
 * the voice moved to it, how far off, how soon it settled), the numbers, the patterns worth
 * saying out loud, and the same over time.
 *
 * A note record (Scorer.detail): {p: pitch, deg: 'mi', dir: 1 up / -1 down / 0 same / null
 * first, st: 'hit'|'close'|'off'|'silent', c: cents (median) or null, rt: ms to settle on the
 * note (null: never did), sd: wobble in cents, r: key index}.
 */
(function (root) {
  'use strict';
  const SF = root.SF;

  const DEG_ORDER = ['do', 'ra', 're', 'me', 'mi', 'fa', 'fi', 'sol', 'le', 'la', 'te', 'ti'];
  const DIRS = [
    ['up', 1, 'Going up'],
    ['down', -1, 'Going down'],
    ['other', null, 'Same note or first'],
  ];
  const LATE_MS = 250; // settling on a note later than this counts as late

  const cell = () => ({ n: 0, hit: 0, close: 0, off: 0, silent: 0, cs: 0, cn: 0, rs: 0, rn: 0 });
  function add(c, x) {
    c.n++;
    c[x.st]++;
    if (x.c != null && x.st !== 'silent') {
      c.cs += x.c;
      c.cn++;
    }
    if (x.rt != null) {
      c.rs += x.rt;
      c.rn++;
    }
  }
  const dirKey = (d) => (d === 1 ? 'up' : d === -1 ? 'down' : 'other');
  const rate = (c) => (c && c.n ? c.hit / c.n : null);
  const bias = (c) => (c && c.cn ? c.cs / c.cn : null);
  const median = (a) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  /** Everything worth showing about a run (or several): see the fields below. */
  function summarize(notes) {
    const all = cell();
    const byDeg = new Map();
    const byPitch = new Map();
    const reach = [];
    const wob = [];
    let late = 0;
    let reachable = 0;
    for (const x of notes) {
      add(all, x);
      if (x.deg) {
        let d = byDeg.get(x.deg);
        if (!d) byDeg.set(x.deg, (d = { up: cell(), down: cell(), other: cell(), all: cell() }));
        add(d[dirKey(x.dir)], x);
        add(d.all, x);
      }
      let p = byPitch.get(x.p);
      if (!p) byPitch.set(x.p, (p = cell()));
      add(p, x);
      if (x.st !== 'silent') {
        reachable++;
        if (x.rt != null) reach.push(x.rt);
        if (x.rt == null || x.rt > LATE_MS) late++;
      }
      if (x.sd != null) wob.push(x.sd);
    }
    // high and low halves of what was sung: a register that goes flat, or isn't heard
    const pitches = [...byPitch.keys()].sort((a, b) => a - b);
    let split = null;
    const low = cell();
    const high = cell();
    if (pitches.length >= 4) {
      split = pitches[Math.floor(pitches.length / 2)];
      for (const x of notes) add(x.p < split ? low : high, x);
    }
    return {
      all,
      byDeg,
      byPitch,
      reach: median(reach),
      lateShare: reachable ? late / reachable : null,
      wobble: median(wob),
      split,
      low,
      high,
      reachUp: median(notes.filter((x) => x.dir === 1 && x.rt != null).map((x) => x.rt)),
      reachDown: median(notes.filter((x) => x.dir === -1 && x.rt != null).map((x) => x.rt)),
    };
  }

  /** A run's summary small enough to keep with its result: degree and direction, notes, timing. */
  function compact(notes) {
    const s = summarize(notes);
    const pack = (c) => [c.n, c.hit, c.close, c.off, c.silent, Math.round(c.cs), c.cn];
    const d = {};
    for (const [deg, v] of s.byDeg) for (const [k] of DIRS) if (v[k].n) d[deg + ':' + k] = pack(v[k]);
    const p = {};
    for (const [pitch, c] of s.byPitch) p[pitch] = pack(c);
    return {
      n: s.all.n,
      b: bias(s.all) == null ? null : Math.round(bias(s.all)),
      rt: s.reach == null ? null : Math.round(s.reach),
      ls: s.lateShare == null ? null : Math.round(s.lateShare * 100),
      w: s.wobble == null ? null : Math.round(s.wobble),
      d,
      p,
    };
  }
  /** Back from compact(): {byDeg, byPitch} with cells as summarize() makes them, merged over runs. */
  function expand(list) {
    const byDeg = new Map();
    const byPitch = new Map();
    const unpack = (c, a) => {
      c.n += a[0];
      c.hit += a[1];
      c.close += a[2];
      c.off += a[3];
      c.silent += a[4];
      c.cs += a[5];
      c.cn += a[6];
    };
    for (const bd of list) {
      if (!bd) continue;
      for (const [k, a] of Object.entries(bd.d || {})) {
        const [deg, dir] = k.split(':');
        let v = byDeg.get(deg);
        if (!v) byDeg.set(deg, (v = { up: cell(), down: cell(), other: cell(), all: cell() }));
        unpack(v[dir] || v.other, a);
        unpack(v.all, a);
      }
      for (const [k, a] of Object.entries(bd.p || {})) {
        let c = byPitch.get(+k);
        if (!c) byPitch.set(+k, (c = cell()));
        unpack(c, a);
      }
    }
    return { byDeg, byPitch };
  }

  /** A summary as summarize() gives it, from what was kept of a saved run (compact()). */
  function fromCompact(bd) {
    const { byDeg, byPitch } = expand([bd]);
    const all = cell();
    const merge = (c, x) => {
      for (const k of ['n', 'hit', 'close', 'off', 'silent', 'cs', 'cn']) c[k] += x[k];
    };
    for (const c of byPitch.values()) merge(all, c);
    const pitches = [...byPitch.keys()].sort((a, b) => a - b);
    let split = null;
    const low = cell();
    const high = cell();
    if (pitches.length >= 4) {
      split = pitches[Math.floor(pitches.length / 2)];
      for (const [p, c] of byPitch) merge(p < split ? low : high, c);
    }
    return { all, byDeg, byPitch, reach: bd.rt, lateShare: bd.ls == null ? null : bd.ls / 100, wobble: bd.w, split, low, high, reachUp: null, reachDown: null };
  }

  const pct = (x) => Math.round(x * 100) + '%';
  const centsWord = (c) => Math.abs(Math.round(c)) + '¢ ' + (c < 0 ? 'flat' : 'sharp');
  const dirWord = (k) => (k === 'up' ? 'going up' : k === 'down' ? 'going down' : 'on a repeated or first note');

  /**
   * The few things most worth saying about a run, as plain sentences (most telling first).
   * prev: the compact summaries of earlier runs of the same exercise, for "better than".
   */
  function insights(s, opts) {
    opts = opts || {};
    const out = [];
    const overall = rate(s.all);
    if (!s.all.n) return out;
    const name = opts.noteName || ((m) => String(m));
    // the degree and direction missed most, well below the rest
    let worst = null;
    for (const [deg, v] of s.byDeg) {
      for (const [k] of DIRS) {
        const c = v[k];
        if (c.n < 3) continue;
        const r = rate(c);
        if (overall - r >= 0.15 && (!worst || r < worst.r || (r === worst.r && c.n > worst.c.n))) worst = { deg, k, c, r };
      }
    }
    if (worst) {
      const b = bias(worst.c);
      let t = 'You miss ' + worst.deg + ' ' + dirWord(worst.k) + ' most: ' + worst.c.hit + ' of ' + worst.c.n + ' in tune, against ' + pct(overall) + ' overall';
      if (b != null && Math.abs(b) >= 12) t += ', and it lands ' + centsWord(b) + ' on average';
      else if (worst.c.silent / worst.c.n >= 0.4) t += ', mostly not heard';
      out.push(t + '.');
    }
    // sharp or flat, overall or in one register
    const b = bias(s.all);
    const bl = bias(s.low);
    const bh = bias(s.high);
    if (s.split != null && bl != null && bh != null && s.low.cn >= 4 && s.high.cn >= 4 && Math.abs(bl - bh) >= 15 && Math.max(Math.abs(bl), Math.abs(bh)) >= 12) {
      const lowWorse = Math.abs(bl) > Math.abs(bh);
      out.push(
        (lowWorse ? 'The low notes (below ' + name(s.split) + ') come out ' + centsWord(bl) : 'The high notes (from ' + name(s.split) + ' up) come out ' + centsWord(bh)) +
          ' on average; the ' + (lowWorse ? 'high ones ' : 'low ones ') + centsWord(lowWorse ? bh : bl) + '.'
      );
    } else if (b != null && s.all.cn >= 6 && Math.abs(b) >= 10) out.push('Overall you sing a little ' + (b < 0 ? 'flat' : 'sharp') + ': ' + centsWord(b) + ' on average.');
    // not heard, and where
    const sil = s.all.silent / s.all.n;
    if (sil >= 0.12) {
      let t = pct(sil) + ' of the notes weren’t heard';
      if (s.split != null && s.low.n && s.high.n) {
        const sl = s.low.silent / s.low.n;
        const sh = s.high.silent / s.high.n;
        if (sl >= 2 * sh && sl - sh >= 0.15) t += ', mostly the low ones (below ' + name(s.split) + ')';
        else if (sh >= 2 * sl && sh - sl >= 0.15) t += ', mostly the high ones (from ' + name(s.split) + ' up)';
      }
      out.push(t + '. Sing out a little more, or check the mic’s level.');
    }
    // timing
    if (s.reach != null && s.reach >= 180) {
      let t = 'You take about ' + Math.round(s.reach / 10) * 10 + ' ms to settle on each note';
      if (s.reachUp != null && s.reachDown != null && Math.abs(s.reachUp - s.reachDown) >= 80)
        t += ', longer ' + (s.reachUp > s.reachDown ? 'going up (' + Math.round(s.reachUp) + ' ms) than going down (' + Math.round(s.reachDown) : 'going down (' + Math.round(s.reachDown) + ' ms) than going up (' + Math.round(s.reachUp)) + ' ms)';
      out.push(t + '.');
    }
    if (s.wobble != null && s.wobble >= 25) out.push('Your pitch wavers about ' + Math.round(s.wobble) + '¢ within a note: hold it steadier, or the vibrato narrower.');
    // against earlier runs
    const prev = (opts.prev || []).filter((x) => x && x.score != null);
    if (prev.length && opts.score != null) {
      const before = prev.slice(-5);
      const avg = before.reduce((a, x) => a + x.score, 0) / before.length;
      const d = opts.score - avg;
      if (Math.abs(d) >= 0.05) out.push((d > 0 ? 'Better' : 'Lower') + ' than your last ' + (before.length === 1 ? 'run' : before.length + ' runs') + ' of this exercise: ' + pct(opts.score) + ' against ' + pct(avg) + '.');
    }
    if (!out.length && overall >= 0.85) out.push('Nothing stands out: ' + pct(overall) + ' in tune, evenly across the notes.');
    return out;
  }

  SF.Report = { summarize, compact, expand, fromCompact, insights, rate, bias, DEG_ORDER, DIRS, LATE_MS };
})(typeof window !== 'undefined' ? window : globalThis);
