// The metronome: clicks on the exercise's own beat (counting in before a key), never taken for
// a sung note; and the beat grid the picture draws.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SF = require('./load.js')('core', 'midifile', 'analyze', 'player', 'scoring', 'outputs');
const { smf, round } = require('./smf.js');

const fx = (f) => SF.analyze(SF.parseMidi(fs.readFileSync(path.join(__dirname, 'fixtures', f))));
let clock = 0;
SF.now = () => clock;
const silentOut = { lookahead: 40, noteOn() {}, noteOff() {}, allOff() {} };
/** A metronome that writes down its clicks. */
function fakeMetronome() {
  const m = { clicks: [], cancelled: 0 };
  m.click = (at, accent) => m.clicks.push({ at, accent: !!accent });
  m.cancel = () => {
    m.cancelled++;
    m.clicks = m.clicks.filter((c) => c.at <= clock);
  };
  return m;
}
function run(p, ms, step = 10) {
  const end = clock + ms;
  while (clock < end) {
    clock += step;
    p.tick();
  }
}
function player(ex, cfg, bpm) {
  clock = 1000;
  const p = new SF.Player(Object.assign({ preroll: 1.5 }, cfg), { ticker: false });
  p.setOutput(silentOut);
  p.load(ex, bpm ? { bpm } : null);
  return p;
}
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

test('it clicks on the beat of the file, counting in during the lead-in, the bar accented', () => {
  const ex = fx('basic_scale_whole.mid'); // 4/4 at 100 bpm: a beat every 0.6 s
  const p = player(ex);
  const m = fakeMetronome();
  p.setMetronome(m);
  p.play();
  run(p, 5000);
  const start = 1000 + 1500; // the first key, after the 1.5 s lead-in
  const at = m.clicks.map((c) => c.at);
  // counting in: the beats before the key that fit in the lead-in
  assert.ok(near(at[0], start - 1200) && near(at[1], start - 600), 'count-in ' + at.slice(0, 2));
  assert.ok(at.some((t) => near(t, start)), 'a click as the key starts');
  for (let i = 1; i < at.length; i++) assert.ok(near(at[i] - at[i - 1], 600), 'every 0.6 s: ' + at.join(' '));
  // the first beat of each bar (4/4: every fourth) is accented, the key starting on one
  const accents = m.clicks.filter((c) => c.accent).map((c) => c.at);
  assert.ok(accents.some((t) => near(t, start)) && accents.some((t) => near(t, start + 2400)), 'accents ' + accents);
  assert.ok(!accents.some((t) => near(t, start + 600)), 'the second beat is not');
  // never more than the output's look-ahead early
  assert.ok(Math.max(...at) <= clock + 40 + 1);
});

test('the clicks follow the tempo set, and stop at once on pause', () => {
  const p = player(fx('basic_scale_whole.mid'), {}, 200);
  const m = fakeMetronome();
  p.setMetronome(m);
  p.play();
  run(p, 3000);
  const at = m.clicks.map((c) => c.at);
  for (let i = 1; i < at.length; i++) assert.ok(near(at[i] - at[i - 1], 300), 'every 0.3 s at 200 bpm');
  p.pause();
  assert.ok(m.cancelled >= 1, 'pausing silences the clicks already scheduled');
  const n = m.clicks.length;
  run(p, 1000);
  assert.strictEqual(m.clicks.length, n, 'no clicks while paused');
  p.setMetronome(null);
  p.play();
  run(p, 1000);
  assert.strictEqual(m.clicks.length, n, 'turned off: no more clicks');
});

test('in 6/8 it clicks the dotted quarter, two to a bar', () => {
  const r1 = round(0, [60, 64, 67], [60, 62, 64, 62, 60, 60], { chordBeats: 3, noteBeats: 1.5 });
  const notes = r1.notes.map((n) => ({ p: n.p, t: n.t, d: n.d }));
  const file = smf({ bpm: 120, timeSig: { num: 6, den: 8 }, tracks: [{ name: 'chords', notes: notes.filter((n, i) => !r1.notes[i].sing) }, { name: 'line', notes: notes.filter((n, i) => r1.notes[i].sing) }] });
  const ex = SF.analyze(SF.parseMidi(file));
  assert.deepStrictEqual([ex.timeSig.num, ex.timeSig.den], [6, 8]);
  const p = player(ex, { preroll: 0 });
  const m = fakeMetronome();
  p.setMetronome(m);
  p.play();
  run(p, 4000);
  const at = m.clicks.map((c) => c.at);
  // a quarter is 0.5 s at 120 bpm, so a dotted quarter 0.75 s
  assert.ok(at.length >= 4);
  for (let i = 1; i < at.length; i++) assert.ok(near(at[i] - at[i - 1], 750), 'every 0.75 s: ' + at.join(' '));
  assert.deepStrictEqual(m.clicks.slice(0, 4).map((c) => c.accent), [true, false, true, false]);
});

test('the beats the picture draws are the ones the metronome clicks', () => {
  const p = player(fx('basic_scale_whole.mid'));
  const m = fakeMetronome();
  p.setMetronome(m);
  p.play();
  run(p, 4000);
  const drawn = [];
  p.beatsIn(0, p.position() + 0.03, (P, bar) => drawn.push([Math.round(p.perfAt(P)), bar]));
  const clicked = m.clicks.filter((c) => c.at <= clock + 30).map((c) => [Math.round(c.at), c.accent]);
  assert.deepStrictEqual(drawn, clicked);
});

test('a click drowning out a frame is not taken for silence; a voice over it still counts', () => {
  clock = 1000;
  const p = new SF.Player({ preroll: 0.5 }, { ticker: false });
  p.setOutput(silentOut);
  p.load(fx('basic_scale_whole.mid'));
  const sing = (clickAll, voiced) => {
    clock = 1000;
    p.load(fx('basic_scale_whole.mid'));
    const sc = new SF.Scorer(p, { latency: 30, clickNear: () => clickAll });
    p.play();
    const end = clock + 6000;
    while (clock < end) {
      clock += 11.6;
      p.tick();
      const t = clock - 25;
      const P = p.positionAt(t - 30);
      let target = null;
      if (P != null)
        p.forNotes(P - 1e-4, P + 1e-4, (n, seg, P0, P1) => {
          if (p.isTarget(n) && P >= P0 && P < P1) target = n.pitch;
        });
      sc.frame(voiced && target != null ? { t, voiced: true, midi: target } : { t, voiced: false });
      sc.update();
    }
    p.pause();
    return sc.session.rounds[0];
  };
  // nothing sung, but every frame drowned by a click: nothing to judge, so no verdict at all
  assert.strictEqual(sing(true, false), undefined);
  // nothing sung, no clicks: silent
  assert.strictEqual(sing(false, false).silent, 5);
  // sung in tune with clicks everywhere: the voice still counts
  assert.strictEqual(sing(true, true).hit, 5);
});

test('the real click: a short noise burst, flagged for a moment around it only', () => {
  const m = new SF.Metronome();
  m.times = [1000, 1600];
  assert.ok(m.clickedNear(1000) && m.clickedNear(1040) && m.clickedNear(1060), 'around a click (the mic hears it a little later)');
  assert.ok(!m.clickedNear(940) && !m.clickedNear(1100) && !m.clickedNear(1300), 'not between clicks');
  assert.ok(m.clickedNear(1600));
});
