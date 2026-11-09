const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SF = require('./load.js')('core', 'midifile', 'analyze', 'player', 'scoring');

const fx = (f) => SF.analyze(SF.parseMidi(fs.readFileSync(path.join(__dirname, 'fixtures', f))));
let clock = 0;
SF.now = () => clock;
const silentOut = { lookahead: 40, noteOn() {}, noteOff() {}, allOff() {} };

/**
 * Plays an exercise with a pretend singer. sing(target, P, player) returns the frame the mic
 * would give: {voiced, midi, source} (target: the pitch to sing now, or null).
 */
function session(file, cfg, ms, sing, scoreOpts, bpm) {
  clock = 1000;
  const p = new SF.Player(Object.assign({ preroll: 0.5 }, cfg), { ticker: false });
  p.setOutput(silentOut);
  p.load(fx(file), bpm ? { bpm } : null);
  const sc = new SF.Scorer(p, Object.assign({ latency: 30 }, scoreOpts));
  const notes = [];
  const rounds = [];
  sc.on('note', (e) => notes.push(e));
  sc.on('round', (r) => rounds.push(r));
  const listening = [];
  p.play();
  const end = clock + ms;
  while (clock < end) {
    clock += 11.6; // one frame every 512 samples at 44.1 kHz
    p.tick();
    const t = clock - 25; // a frame describes the sound a little earlier
    const P = p.positionAt(t - 30);
    let target = null;
    if (P != null) p.forNotes(P - 1e-4, P + 1e-4, (n, seg, P0, P1) => {
      if (p.isTarget(n) && P >= P0 && P < P1) target = target == null ? n.pitch : target;
    });
    const fr = Object.assign({ t }, sing(target, P, p));
    sc.frame(fr);
    listening.push([P, sc.live.listening, sc.live.status]);
    sc.update();
  }
  return { p, sc, notes, rounds, listening };
}

test('in tune: every note is a hit and the key scores 100%', () => {
  const s = session('basic_scale_whole.mid', {}, 6000, (target) => (target == null ? { voiced: false } : { voiced: true, midi: target + 0.05 }));
  const first = s.notes.slice(0, 5);
  assert.strictEqual(first.length, 5);
  for (const e of first) {
    assert.strictEqual(e.res.status, 'hit');
    assert.ok(Math.abs(e.res.cents - 5) < 0.5);
  }
  assert.strictEqual(s.rounds[0].hit, 5);
  assert.strictEqual(s.rounds[0].score, 1);
});

test('half a semitone sharp is close, a whole one is off, nothing sung is silent', () => {
  const run = (f) => session('basic_scale_whole.mid', {}, 6000, f).rounds[0];
  const close = run((t) => (t == null ? { voiced: false } : { voiced: true, midi: t + 0.5 }));
  assert.strictEqual(close.close, 5);
  const off = run((t) => (t == null ? { voiced: false } : { voiced: true, midi: t + 1 }));
  assert.strictEqual(off.off, 5);
  const silent = run(() => ({ voiced: false }));
  assert.strictEqual(silent.silent, 5);
});

test('nothing is listened to while the reference chord plays', () => {
  const s = session('basic_scale_whole.mid', {}, 4500, () => ({ voiced: false }));
  const ex = s.p.ex;
  const r0 = ex.rounds[0];
  const chordEnd = r0.notes.filter((n) => n.role === 'acc')[0].s1 - r0.s0;
  // the first round's segment starts after the pre-roll at P = s.p.past/queue segment P0
  const seg = s.p.past.concat(s.p.queue).find((x) => x.kind === 'round' && x.r === 0);
  for (const [P, on] of s.listening) if (P != null && P >= seg.P0 && P < seg.P0 + chordEnd - 0.01) assert.strictEqual(on, false);
  assert.ok(s.listening.some(([, on]) => on), 'it listens to the line');
});

test('frames the piano filter cannot judge yet are left out, not counted against you', () => {
  const s = session('basic_scale_whole.mid', {}, 6000, () => ({ voiced: false, source: 'learning' }));
  assert.ok(s.notes.slice(0, 5).every((e) => e.res.status === 'none'));
  assert.ok(!s.rounds.length || s.rounds[0].r !== 0, 'a key with nothing judged gets no score');
});

test('singing the chosen voice is what counts in a harmony exercise', () => {
  const ex = fx('voices_whole.mid');
  // sing the middle voice
  const s = session('voices_whole.mid', { voice: 1 }, 9000, (target) => (target == null ? { voiced: false } : { voiced: true, midi: target }));
  const r0 = s.notes.filter((e) => e.seg.r === s.notes[0].seg.r);
  assert.ok(r0.length > 0);
  assert.ok(r0.every((e) => e.note.voice === 1 && e.res.status === 'hit'));
  assert.strictEqual(ex.voices, 3);
});

test('in "any" mode each slot counts whichever voice you sang', () => {
  const ex = fx('voices_whole.mid');
  // always sing the lowest voice sounding
  const s = session('voices_whole.mid', { voice: 'any' }, 9000, (target, P, p) => {
    if (P == null) return { voiced: false };
    let low = null;
    p.forNotes(P - 1e-4, P + 1e-4, (n, seg, a, b) => {
      if (n.role === 'sing' && P >= a && P < b && (low == null || n.pitch < low)) low = n.pitch;
    });
    return low == null ? { voiced: false } : { voiced: true, midi: low };
  });
  assert.ok(s.notes.length > 0);
  const firstRound = s.notes.filter((e) => e.seg.r === s.notes[0].seg.r);
  assert.ok(firstRound.every((e) => e.res.status === 'hit'));
  assert.ok(firstRound.some((e) => e.res.voice === ex.voices - 1), 'credited to the bottom voice');
});

test('a short grace at each end of a note: still on the last note for a moment is not held against you', () => {
  // for the first 100 ms of each note the voice is still on the previous one
  const late = (lagMs) => {
    let cur = null;
    let since = 0;
    let prev = null;
    return (target) => {
      if (target !== cur) {
        if (target != null) {
          prev = cur;
          since = clock;
        }
        cur = target;
      }
      if (target == null) return { voiced: false };
      return { voiced: true, midi: clock - since < lagMs && prev != null ? prev : target };
    };
  };
  const run = (graceMs) => {
    const s = session('basic_scale_whole.mid', {}, 6000, late(100), { grace: graceMs / 1000, endGrace: graceMs / 1000 });
    return { verdicts: s.notes.slice(0, 5).map((e) => e.res.status), wrongLive: s.listening.filter((x) => x[1] && (x[2] === 'off' || x[2] === 'close')).length };
  };
  const strict = run(0);
  const kind = run(150);
  // either way the notes themselves come out right: most of each note was in tune
  assert.ok(kind.verdicts.every((x) => x === 'hit') && strict.verdicts.every((x) => x === 'hit'), kind.verdicts + ' / ' + strict.verdicts);
  // but without the grace the moment on the old note shows as wrong while you sing
  assert.ok(strict.wrongLive > 10, 'without grace, ' + strict.wrongLive + ' frames showed wrong');
  assert.strictEqual(kind.wrongLive, 0, 'with grace nothing shows wrong');
});
