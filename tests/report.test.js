// The breakdown of a run: every note's verdict by scale degree and the way the voice moved
// to it, timing and steadiness, what stands out, and the same kept small over many runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SF = require('./load.js')('core', 'midifile', 'analyze', 'player', 'scoring', 'report');

const fx = (f) => SF.analyze(SF.parseMidi(fs.readFileSync(path.join(__dirname, 'fixtures', f))));
let clock = 0;
SF.now = () => clock;
const silentOut = { lookahead: 40, noteOn() {}, noteOff() {}, allOff() {} };

/** Sings an exercise; sing(target, prev, P0, P) gives the frame (null target: nothing to sing). */
function sing(file, ms, fn) {
  clock = 1000;
  const p = new SF.Player({ preroll: 0.5 }, { ticker: false });
  p.setOutput(silentOut);
  p.load(fx(file));
  const sc = new SF.Scorer(p, { latency: 30 });
  p.play();
  const end = clock + ms;
  while (clock < end) {
    clock += 11.6;
    p.tick();
    const t = clock - 25;
    const P = p.positionAt(t - 30);
    let target = null;
    let P0 = null;
    if (P != null)
      p.forNotes(P - 1e-4, P + 1e-4, (n, seg, a, b) => {
        if (p.isTarget(n) && P >= a && P < b) {
          target = n.pitch;
          P0 = a;
        }
      });
    sc.frame(Object.assign({ t }, fn(target, P0 == null ? null : (P - P0) / p.speed)));
    sc.update();
  }
  return sc;
}

test('each note keeps its scale degree, the way the voice moved to it, how soon it settled', () => {
  // in tune from 80 ms into each note on; before that still on the way (a semitone low)
  const sc = sing('basic_scale_whole.mid', 6000, (target, into) => (target == null ? { voiced: false } : { voiced: true, midi: into < 0.08 ? target - 1 : target + 0.04 }));
  const first = sc.session.notes.slice(0, 5);
  assert.deepStrictEqual(first.map((x) => x.deg), ['do', 're', 'mi', 're', 'do']);
  assert.deepStrictEqual(first.map((x) => x.dir), [null, 1, 1, -1, -1]);
  assert.deepStrictEqual(first.map((x) => x.st), ['hit', 'hit', 'hit', 'hit', 'hit']);
  for (const x of first) {
    assert.ok(x.rt >= 60 && x.rt <= 120, 'settled after about 80 ms: ' + x.rt);
    assert.strictEqual(x.c, 4);
    assert.strictEqual(x.r, 0);
  }
});

test('a note never reached has no settling time; a wobbly one shows its spread', () => {
  const sc = sing('basic_scale_whole.mid', 6000, (target, into) => (target == null ? { voiced: false } : { voiced: true, midi: target + 0.8 + 0.3 * Math.sin(into * 40) }));
  const first = sc.session.notes.slice(0, 5);
  for (const x of first) {
    assert.strictEqual(x.st, 'off');
    assert.strictEqual(x.rt, null);
    assert.ok(x.sd >= 15 && x.sd <= 25, 'about 21¢ of spread: ' + x.sd);
  }
});

/** Made-up notes: n of each (degree, direction, verdict, cents, settle ms). */
function notes(spec) {
  const out = [];
  const pitch = { do: 48, re: 50, mi: 52, fa: 53, sol: 55, la: 57, ti: 59 };
  for (const [deg, dir, st, n, c, rt, sd, dp] of spec) for (let i = 0; i < n; i++) out.push({ p: pitch[deg] + (dp || 0), deg, dir, st, c: st === 'silent' ? null : c, rt: st === 'silent' ? null : rt, sd: sd == null ? 8 : sd, r: 0 });
  return out;
}

test('summary: by degree and direction, the tuning, the timing, the high and low notes', () => {
  const s = SF.Report.summarize(
    notes([
      ['do', null, 'hit', 4, 3, 60],
      ['re', 1, 'hit', 4, 2, 80],
      ['mi', 1, 'off', 3, -60, null],
      ['mi', 1, 'hit', 1, -20, 300],
      ['re', -1, 'close', 4, 45, 200],
      ['do', -1, 'silent', 2],
      ['do', -1, 'hit', 2, -5, 90],
    ])
  );
  assert.strictEqual(s.all.n, 20);
  assert.deepStrictEqual([s.all.hit, s.all.close, s.all.off, s.all.silent], [11, 4, 3, 2]);
  const mi = s.byDeg.get('mi');
  assert.deepStrictEqual([mi.up.n, mi.up.hit, mi.up.off, mi.down.n], [4, 1, 3, 0]);
  assert.strictEqual(Math.round(SF.Report.bias(mi.up)), -50);
  assert.strictEqual(s.byDeg.get('do').other.n, 4);
  assert.strictEqual(s.byDeg.get('do').down.silent, 2);
  assert.strictEqual(SF.Report.rate(s.byDeg.get('re').up), 1);
  // timing: the middle of the settle times; late = over a quarter second, or never
  assert.strictEqual(s.reach, 80);
  assert.strictEqual(Math.round(s.lateShare * 18), 3 + 1); // 3 never reached + 1 at 300 ms, of the 18 heard
  assert.strictEqual(s.split, null, 'three notes are too few to tell high from low');
});

test('compact and back: what is kept with a run adds up over runs', () => {
  const a = notes([['mi', 1, 'off', 3, -60], ['mi', 1, 'hit', 1, -20], ['do', null, 'hit', 2, 0]]);
  const b = notes([['mi', 1, 'hit', 4, 5], ['do', null, 'silent', 2]]);
  const ca = SF.Report.compact(a);
  const cb = SF.Report.compact(b);
  assert.ok(JSON.stringify(ca).length < 400, 'small: ' + JSON.stringify(ca));
  const m = SF.Report.expand([ca, cb, null]);
  const mi = m.byDeg.get('mi').up;
  assert.deepStrictEqual([mi.n, mi.hit, mi.off], [8, 5, 3]);
  assert.strictEqual(m.byDeg.get('do').other.silent, 2);
  assert.strictEqual(m.byPitch.get(52).n, 8);
  assert.strictEqual(Math.round(SF.Report.bias(mi)), Math.round((-180 - 20 + 20) / 8));
});

test('what stands out: the degree and direction missed most, a flat register, notes not heard, slow settling', () => {
  const s = SF.Report.summarize(
    notes([
      ['do', null, 'hit', 6, 0, 60],
      ['re', 1, 'hit', 6, 0, 70],
      ['mi', 1, 'off', 5, -55, 400],
      ['mi', 1, 'hit', 1, -10, 200],
      ['re', -1, 'hit', 6, 2, 60],
      ['mi', -1, 'hit', 6, 0, 60],
      ['do', -1, 'hit', 6, 0, 60],
    ])
  );
  const out = SF.Report.insights(s, { noteName: (m) => 'n' + m });
  assert.match(out[0], /^You miss mi going up most: 1 of 6 in tune/);
  assert.match(out[0], /flat on average/);
  const s2 = SF.Report.summarize(notes([['do', null, 'hit', 6, -30, 300, 8, -12], ['re', 1, 'hit', 6, -28, 300, 8, -12], ['sol', 1, 'hit', 6, 0, 300], ['la', 1, 'hit', 6, 2, 300], ['do', -1, 'silent', 5]]));
  const out2 = SF.Report.insights(s2, { noteName: (m) => 'n' + m });
  assert.ok(out2.some((t) => /The low notes \(below n\d+\) come out 29¢ flat/.test(t)), out2.join(' / '));
  assert.ok(out2.some((t) => /17% of the notes weren’t heard/.test(t)), out2.join(' / '));
  assert.ok(out2.some((t) => /take about 300 ms to settle/.test(t)), out2.join(' / '));
});

test('against earlier runs, and nothing to say when it went well', () => {
  const good = SF.Report.summarize(notes([['do', null, 'hit', 10, 2, 60], ['re', 1, 'hit', 10, 0, 60], ['mi', 1, 'hit', 9, 1, 60], ['mi', 1, 'close', 1, 40, 60]]));
  const out = SF.Report.insights(good, { score: 0.95, prev: [{ score: 0.7 }, { score: 0.8 }] });
  assert.ok(out.some((t) => /^Better than your last 2 runs of this exercise: 95% against 75%/.test(t)), out.join(' / '));
  const out2 = SF.Report.insights(good, {});
  assert.deepStrictEqual(out2, ['Nothing stands out: 98% in tune, evenly across the notes.'.replace('98%', Math.round((good.all.hit / good.all.n) * 100) + '%')]);
});

test('a saved run keeps its breakdown; only the latest 60 do', () => {
  const store = new Map();
  SF.store = { get: (k, d) => (store.has(k) ? JSON.parse(store.get(k)) : d), set: (k, v) => store.set(k, JSON.stringify(v)) };
  const ses = { started: 5, rounds: [{ r: 0, label: 'C3', root: 48, n: 2, hit: 1, close: 0, off: 1, silent: 0, cents: 10, score: 0.5 }], notes: notes([['mi', 1, 'off', 1, -60], ['do', null, 'hit', 1, 0]]) };
  for (let i = 0; i < 65; i++) SF.History.add('ex', ses, { bpm: 100 });
  const list = SF.History.forExercise('ex');
  assert.strictEqual(list.length, 65);
  assert.ok(list[64].bd && list[64].bd.d['mi:up'][0] === 1);
  assert.ok(!list[0].bd && list[5].bd, 'the oldest lose theirs');
});

test('a saved run’s summary comes back from what was kept of it', () => {
  const ns = notes([['do', null, 'hit', 6, 0, 60], ['re', 1, 'hit', 6, 0, 70], ['mi', 1, 'off', 5, -55, 400], ['mi', 1, 'hit', 1, -10, 200], ['re', -1, 'hit', 6, 2, 60], ['do', -1, 'silent', 2]]);
  const live = SF.Report.summarize(ns);
  const back = SF.Report.fromCompact(SF.Report.compact(ns));
  for (const k of ['n', 'hit', 'close', 'off', 'silent', 'cn']) assert.strictEqual(back.all[k], live.all[k], k);
  assert.strictEqual(back.reach, Math.round(live.reach));
  assert.strictEqual(back.byDeg.get('mi').up.off, 5);
  // the same things stand out
  assert.match(SF.Report.insights(back, {})[0], /^You miss mi going up most/);
});
