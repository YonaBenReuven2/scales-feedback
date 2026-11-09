const test = require('node:test');
const assert = require('node:assert');
const SF = require('./load.js')('core', 'midifile');
const { smf } = require('./smf.js');

function file(trackBytes, ppq = 96) {
  const t = [0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trackBytes.length + 4, ...trackBytes, 0, 0xff, 0x2f, 0];
  return Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, ppq, ...t]);
}

test('running status and note-on with velocity 0 as note-off', () => {
  // note on C4, then (running status) note on E4, then both "off" as velocity 0
  const m = SF.parseMidi(file([0, 0x90, 60, 100, 0, 64, 90, 96, 60, 0, 0, 64, 0]));
  assert.strictEqual(m.notes.length, 2);
  const c = m.notes.find((n) => n.pitch === 60);
  const e = m.notes.find((n) => n.pitch === 64);
  assert.deepStrictEqual([c.on, c.off, c.vel], [0, 96, 100]);
  assert.deepStrictEqual([e.on, e.off, e.vel], [0, 96, 90]);
});

test('the same key struck twice before release pairs first-in first-out (unison voices survive)', () => {
  // on@0, on@48, off@96, off@144 for the same pitch
  const m = SF.parseMidi(file([0, 0x90, 60, 100, 48, 0x90, 60, 100, 48, 0x80, 60, 0, 48, 0x80, 60, 0]));
  const ns = m.notes.filter((n) => n.pitch === 60).sort((a, b) => a.on - b.on);
  assert.strictEqual(ns.length, 2);
  assert.deepStrictEqual(ns.map((n) => [n.on, n.off]), [[0, 96], [48, 144]]);
});

test('tempo changes are followed', () => {
  const buf = smf({ ppq: 480, bpm: 120, tempos: [{ t: 4, bpm: 60 }], tracks: [{ name: 'x', notes: [{ p: 60, t: 0, d: 1 }, { p: 62, t: 6, d: 1 }] }] });
  const m = SF.parseMidi(buf);
  const tm = new SF.TempoMap(m.ppq, m.tempos);
  // 4 beats at 120 = 2 s, then 2 beats at 60 = 2 s
  assert.ok(Math.abs(tm.sec(6 * 480) - 4) < 1e-9);
  assert.ok(Math.abs(tm.tick(3) - 5 * 480) < 1e-6);
  assert.strictEqual(m.notes.length, 2);
});

test('track names and a note that is never released', () => {
  const buf = smf({ tracks: [{ name: 'Voice', notes: [{ p: 67, t: 0, d: 2 }] }] });
  const m = SF.parseMidi(buf);
  assert.ok(m.tracks.some((t) => t.name === 'Voice'));
  // a dangling note-on still becomes a note (it ends with the file)
  const d = SF.parseMidi(file([0, 0x90, 60, 100, 96, 0x90, 62, 100, 96, 0x80, 62, 0]));
  const c = d.notes.find((n) => n.pitch === 60);
  assert.ok(c && c.off > c.on);
});

test('garbage is refused clearly', () => {
  assert.throws(() => SF.parseMidi(Buffer.from('not a midi file at all')));
});
