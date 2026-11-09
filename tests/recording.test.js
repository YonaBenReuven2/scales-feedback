// The sound files the app and the lab save, and the lab reading them back.
const test = require('node:test');
const assert = require('node:assert');
const SF = require('./load.js')('core');

test('a saved recording reads back: mic, piano, the piano’s side and the data', async () => {
  const n = 1000;
  const a = new Float32Array(n).map((_, i) => Math.sin(i / 7) * 0.5);
  const b = new Float32Array(n).map((_, i) => Math.cos(i / 11) * 0.25);
  const c = new Float32Array(n).map((_, i) => ((i % 13) - 6) / 100);
  const meta = { sr: 44100, blocks: [[0, 1, 0, 1]], lab: { at: '2026-11-09T12:00:00Z' } };
  for (const side of [null, c]) {
    const blob = SF.wavWithData(a, b, 44100, meta, side);
    const w = SF.readWavData(await blob.arrayBuffer());
    assert.strictEqual(w.sr, 44100);
    assert.strictEqual(w.mic.length, n);
    assert.ok(Math.abs(w.mic[123] - a[123]) < 1e-7 && Math.abs(w.ref[456] - b[456]) < 1e-7);
    if (side) assert.ok(w.side && Math.abs(w.side[789] - c[789]) < 1e-7, 'third channel');
    else assert.strictEqual(w.side, null);
    assert.deepStrictEqual(w.meta, meta);
  }
});

test('anything else is refused with a reason', async () => {
  assert.throws(() => SF.readWavData(new ArrayBuffer(40)), /not a WAV/);
  const blob = SF.wavWithData(new Float32Array(10), new Float32Array(10), 44100, { nothing: true });
  assert.throws(() => SF.readWavData(blob.arrayBuffer ? new ArrayBuffer(0) : null), /not a WAV/);
  await assert.rejects(async () => SF.readWavData(await blob.arrayBuffer()), /not a recording/);
});
