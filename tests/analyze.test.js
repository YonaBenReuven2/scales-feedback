const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SF = require('./load.js')('core', 'midifile', 'analyze');
const { smf, round } = require('./smf.js');

const FX = path.join(__dirname, 'fixtures');
const fx = (f) => SF.analyze(SF.parseMidi(fs.readFileSync(path.join(FX, f))));
const ana = (buf, opts) => SF.analyze(SF.parseMidi(buf), opts);
const sung = (r) => r.notes.filter((n) => n.role === 'sing');
const keyName = (r) => SF.keyLabel(r.key);

test('every exercise file is understood: rounds or sections, something to sing in each', () => {
  const voices = { 'two_voices_whole.mid': 2, 'voices_whole.mid': 3, 'voices_hard_whole.mid': 2 };
  for (const f of fs.readdirSync(FX)) {
    const ex = fx(f);
    assert.ok(ex.rounds.length > 0, f);
    assert.strictEqual(ex.voices, voices[f] || 1, f + ' voices');
    assert.strictEqual(ex.structure, /brit_olam/.test(f) ? 'sections' : 'rounds', f + ' structure');
    for (const r of ex.rounds) {
      assert.ok(sung(r).length > 0, f + ' ' + r.label + ' has notes to sing');
      assert.ok(r.key, f + ' ' + r.label + ' has a key');
    }
  }
});

test('each round takes its key from its own reference chord (no key signatures needed)', () => {
  const ex = fx('basic_scale_whole.mid');
  assert.deepStrictEqual(ex.rounds.slice(0, 6).map(keyName), ['C major', 'B major', 'B♭ major', 'A major', 'A♭ major', 'G major']);
  // the chord is accompaniment, the line is sung: C D E D C
  assert.deepStrictEqual(sung(ex.rounds[0]).map((n) => n.pitch), [48, 50, 52, 50, 48]);
  assert.ok(ex.rounds[0].notes.filter((n) => n.role === 'acc').length >= 3);
});

test('minor reference chords give minor keys, spelled the usual way', () => {
  const ex = fx('minor_stacc_whole.mid');
  assert.deepStrictEqual(ex.rounds.slice(0, 5).map(keyName), ['C minor', 'B minor', 'B♭ minor', 'A minor', 'G♯ minor']);
  // movable do, la-based minor: the tonic of C minor is la, so do is E♭
  assert.strictEqual(ex.rounds[0].key.doPc, 3);
});

test('a song without reference chords gets a key for each section', () => {
  const ex = fx('brit_olam_full.mid');
  const keys = ex.rounds.map(keyName);
  assert.strictEqual(keys[0], 'B♭ minor');
  assert.ok(new Set(keys).size >= 2, 'the key changes somewhere: ' + keys.join(', '));
  // the melody-only file is the same song three semitones lower
  const mel = fx('brit_olam_melody.mid');
  assert.strictEqual(keyName(mel.rounds[0]), 'G minor');
});

test('a brand-new exercise (minor arpeggios rising by tones) works without anything special', () => {
  const notes = [];
  let t = 0;
  for (const root of [50, 52, 54]) {
    const r = round(t, [root, root + 3, root + 7], [root, root + 3, root + 7, root + 12, root + 7, root + 3, root].map((p) => p), { gap: 1 });
    notes.push(...r.notes);
    t = r.end;
  }
  const ex = ana(smf({ bpm: 90, tracks: [{ name: 'Exercise', notes }] }));
  assert.strictEqual(ex.structure, 'rounds');
  assert.strictEqual(ex.rounds.length, 3);
  assert.deepStrictEqual(ex.rounds.map(keyName), ['D minor', 'E minor', 'F♯ minor']);
  for (const [i, r] of ex.rounds.entries()) {
    const root = 50 + 2 * i;
    assert.deepStrictEqual(sung(r).map((n) => n.pitch), [root, root + 3, root + 7, root + 12, root + 7, root + 3, root]);
    assert.strictEqual(r.notes.filter((n) => n.role === 'acc').length, 3);
  }
  assert.strictEqual(ex.voices, 1);
});

test('a new two-part harmony exercise has two voices to choose from', () => {
  const notes = [];
  let t = 0;
  for (const root of [48, 47, 46]) {
    for (const p of [root, root + 4, root + 7]) notes.push({ p, t, d: 2 });
    t += 2;
    const upper = [4, 5, 7, 5, 4];
    const lower = [0, 2, 4, 2, 0];
    for (let k = 0; k < 5; k++) {
      notes.push({ p: root + 12 + upper[k], t, d: 1 });
      notes.push({ p: root + 12 + lower[k], t, d: 1 });
      t += 1;
    }
    t += 1;
  }
  const ex = ana(smf({ bpm: 100, tracks: [{ name: 'Harmony', notes }] }));
  assert.strictEqual(ex.rounds.length, 3);
  assert.strictEqual(ex.voices, 2);
  const r = ex.rounds[0];
  const top = sung(r).filter((n) => n.voice === 0).map((n) => n.pitch);
  const bottom = sung(r).filter((n) => n.voice === 1).map((n) => n.pitch);
  assert.deepStrictEqual(top, [64, 65, 67, 65, 64]);
  assert.deepStrictEqual(bottom, [60, 62, 64, 62, 60]);
});

test('a track named for singing is what gets sung', () => {
  // a song: chords and a tune running together, no reference chords
  const tune = [67, 69, 71, 72, 71, 69, 67, 64, 65, 67, 69, 67, 65, 64, 62, 60];
  const mel = tune.map((p, i) => ({ p, t: i, d: 1 }));
  const acc = [];
  for (let b = 0; b < 16; b += 4) for (const p of b % 8 ? [43, 47, 50] : [48, 52, 55]) acc.push({ p, t: b, d: 4 });
  const ex = ana(smf({ bpm: 96, tracks: [{ name: 'Piano', notes: acc }, { name: 'Melody', ch: 1, notes: mel }] }));
  const all = ex.rounds.flatMap((r) => r.notes);
  assert.deepStrictEqual(all.filter((n) => n.role === 'sing').map((n) => n.pitch), tune);
  assert.ok(all.filter((n) => n.role !== 'sing').every((n) => n.pitch < 56));
});

test('the singer can choose which part to sing', () => {
  const ex = fx('voices_whole.mid');
  assert.deepStrictEqual(ex.voiceLabels, ['Top', 'Middle', 'Bottom']);
  const r = ex.rounds[0];
  for (let v = 0; v < 3; v++) assert.ok(sung(r).some((n) => n.voice === v), 'voice ' + v + ' has notes');
  // voices are ordered top to bottom wherever they sound together
  const byOn = new Map();
  for (const n of sung(r)) (byOn.get(n.on) || byOn.set(n.on, []).get(n.on)).push(n);
  for (const group of byOn.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.voice - b.voice);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i - 1].pitch >= sorted[i].pitch);
  }
});
