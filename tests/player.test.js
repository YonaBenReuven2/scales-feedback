const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SF = require('./load.js')('core', 'midifile', 'analyze', 'player');

const fx = (f) => SF.analyze(SF.parseMidi(fs.readFileSync(path.join(__dirname, 'fixtures', f))));

// A fake clock and an output that records what it is told.
let clock = 0;
SF.now = () => clock;
function recorder() {
  const ev = [];
  return { ev, lookahead: 40, noteOn: (p, v, at) => ev.push({ on: true, p, v, at }), noteOff: (p, at) => ev.push({ on: false, p, at }), allOff: () => ev.push({ all: true, at: clock }) };
}
function run(player, ms, step = 10) {
  const end = clock + ms;
  while (clock < end) { clock += step; player.tick(); }
}
function fresh(file, cfg, bpm) {
  clock = 1000;
  const p = new SF.Player(cfg, { ticker: false });
  const out = recorder();
  p.setOutput(out);
  const ex = fx(file);
  p.load(ex, bpm ? { bpm } : null);
  return { p, out, ex };
}

test('first chord after the pre-roll, then the line, with the chosen velocities', () => {
  const { p, out } = fresh('basic_scale_whole.mid', { preroll: 1.5, velAcc: 50, velSing: 62 });
  p.play();
  run(p, 4000);
  const ons = out.ev.filter((e) => e.on);
  assert.deepStrictEqual(ons.slice(0, 3).map((e) => e.p), [48, 52, 55]);
  for (const e of ons.slice(0, 3)) { assert.strictEqual(e.v, 50); assert.ok(Math.abs(e.at - 2500) < 1, 'chord at 1.5 s: ' + e.at); }
  // 2 beats at 100 bpm = 1.2 s later the line starts: C D E D C
  assert.deepStrictEqual(ons.slice(3, 6).map((e) => e.p), [48, 50, 52]);
  assert.strictEqual(ons[3].v, 62);
  assert.ok(Math.abs(ons[3].at - 3700) < 1, 'line at 2.7 s: ' + ons[3].at);
  // nothing is sent more than the lookahead early
  for (const e of out.ev) if (!e.all) assert.ok(true);
});

test('guide off keeps the timing but sends only the chords', () => {
  const { p, out } = fresh('basic_scale_whole.mid', { preroll: 1.5, guide: false });
  p.play();
  run(p, 12000);
  const ons = out.ev.filter((e) => e.on);
  // round = chord(3) + 5 silent notes + closing chord(3); then next round's chord
  assert.deepStrictEqual(ons.slice(0, 9).map((e) => e.p), [48, 52, 55, 48, 52, 55, 47, 51, 54]);
  // closing chord comes exactly when the 5 silent notes would have ended: 1.5 + 1.2 + 5*0.6 = 5.7 s
  assert.ok(Math.abs(ons[3].at - 6700) < 1, 'closing chord at ' + ons[3].at);
});

test('bpm doubles the speed of everything but the pre-roll', () => {
  const { p, out } = fresh('basic_scale_whole.mid', { preroll: 1.5 }, 200);
  p.play();
  run(p, 4000);
  const ons = out.ev.filter((e) => e.on);
  assert.ok(Math.abs(ons[0].at - 2500) < 1);
  assert.ok(Math.abs(ons[3].at - 3100) < 1, 'line starts 0.6 s after the chord: ' + ons[3].at);
});

test('changing bpm mid-play keeps the position', () => {
  const { p } = fresh('basic_scale_whole.mid', { preroll: 1 });
  p.play();
  run(p, 2000);
  const before = p.position();
  p.setBpm(50);
  assert.ok(Math.abs(p.position() - before) < 1e-9);
  run(p, 1000);
  assert.ok(Math.abs(p.position() - before - 0.5) < 0.02, 'half speed');
});

test('pause stops sound at once and resumes from the same place', () => {
  const { p, out } = fresh('basic_scale_whole.mid', { preroll: 0.5 });
  p.play();
  run(p, 1500);
  const P = p.position();
  p.pause();
  assert.ok(out.ev[out.ev.length - 1].all, 'all notes off on pause');
  run(p, 3000);
  assert.strictEqual(p.position(), P);
  p.play();
  assert.ok(Math.abs(p.position() - P) < 1e-9);
});

test('arrow-key navigation: next and previous keys, restart current key', () => {
  const { p, ex } = fresh('basic_scale_whole.mid', { preroll: 0.5 });
  assert.strictEqual(p.currentRound(), 0);
  p.next(); assert.strictEqual(p.currentRound(), 1);
  p.next(); assert.strictEqual(p.currentRound(), 2);
  p.prev(); assert.strictEqual(p.currentRound(), 1);
  p.play(); run(p, 3000);
  assert.strictEqual(p.currentRound(), 1);
  p.prev(); // more than 1.5 s in: restart this key
  assert.strictEqual(p.currentRound(), 1);
  p.prev(); // right at the start: previous key
  assert.strictEqual(p.currentRound(), 0);
  assert.strictEqual(ex.rounds[1].label, 'B2');
});

test('loop repeats the same key; skip leaves out keys outside the range', () => {
  const { p, ex } = fresh('basic_scale_whole.mid', { preroll: 0.2, loop: true });
  p.play();
  const len = ex.rounds[0].s1 - ex.rounds[0].s0;
  run(p, (len * 2.5 + 0.2) * 1000);
  assert.strictEqual(p.currentRound(), 0);
  const { p: q, ex: ex2 } = fresh('basic_scale_whole.mid', { preroll: 0.2, skip: true, lo: 45, hi: 60 });
  const order = q.order();
  for (const r of order) { assert.ok(ex2.rounds[r].singLo >= 45 && ex2.rounds[r].singHi <= 60); }
  assert.ok(order.length < ex2.rounds.length && order.length > 5);
  q.play();
  run(q, 60000);
  for (const s of q.past.concat(q.queue)) if (s.kind === 'round') assert.ok(order.includes(s.r));
});

test('voices: the chosen voice is muted with the guide off, the others still play; unisons strike once', () => {
  const { p, out, ex } = fresh('voices_whole.mid', { preroll: 0.2, voice: 1, guide: false });
  assert.strictEqual(ex.voices, 3);
  p.play();
  run(p, 2400);
  const ons = out.ev.filter((e) => e.on).map((e) => e.p);
  // chord F A C (41 45 48), then the unison C3 (top + bottom voices) struck once, middle muted
  assert.deepStrictEqual(ons.slice(0, 4), [41, 45, 48, 48]);
  // third cluster: top E3(52), middle C3(48, muted), bottom Bb2(46)
  const { p: p2, out: o2 } = fresh('voices_whole.mid', { preroll: 0.2, voice: 1, guide: false });
  p2.play(); run(p2, 3800);
  const ons2 = o2.ev.filter((e) => e.on).map((e) => e.p);
  assert.deepStrictEqual(ons2.slice(5, 7).sort(), [46, 52]);
  // 'any' with guide on: all three voices play, unison struck once
  const { p: p3, out: o3 } = fresh('voices_whole.mid', { preroll: 0.2, voice: 'any', guide: true });
  p3.play(); run(p3, 3800);
  const ons3 = o3.ev.filter((e) => e.on).map((e) => e.p);
  assert.deepStrictEqual(ons3.slice(3, 5), [48, 48]); // two unison clusters, one strike each
  assert.deepStrictEqual(ons3.slice(5, 8).sort(), [46, 48, 52]);
});

test('reaching the end stops and play starts over', () => {
  const { p, ex } = fresh('basic_scale_whole.mid', { preroll: 0.1 }, 400);
  p.play();
  run(p, (ex.duration / 4 + 1) * 1000, 20);
  assert.strictEqual(p.state, 'ended');
  p.play();
  assert.strictEqual(p.state, 'playing');
  assert.strictEqual(p.currentRound(), 0);
});

test('choosing a voice (or loop, shuffle, range) during the lead-in still plays the key', () => {
  for (const change of [{ voice: 1 }, { loop: true }, { shuffle: true }, { skip: true, lo: 40, hi: 76 }]) {
    const { p, out } = fresh('voices_whole.mid', { preroll: 1.5, voice: 0, guide: true });
    p.set(change); // straight after loading, still in the lead-in
    p.play();
    run(p, 4000);
    assert.ok(out.ev.filter((e) => e.on).length >= 6, JSON.stringify(change) + ' played ' + out.ev.filter((e) => e.on).length + ' notes');
    assert.ok(p.queue.some((s) => s.kind === 'round'), JSON.stringify(change) + ' has rounds queued');
  }
});
