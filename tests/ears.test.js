// The listening engine, driven by messages as the page (or its worker) drives it.
const test = require('node:test');
const assert = require('node:assert');
const SF = require('./load.js')('core', 'pitch', 'echo', 'ears');
const { voice } = require('./synth-voice.js');

const sr = 44100;
const B = 512;

function engine() {
  const out = [];
  const ears = new SF.Ears((m) => out.push(m));
  ears.handle({ type: 'start', sr, hasRef: false, gateDb: -50, minClarity: 0.8 });
  return { ears, out, frames: () => out.filter((m) => m.type === 'frame').map((m) => m.fr) };
}
/** Feed x as blocks starting at context frame f0; the page clock runs 1000 ms ahead of the audio clock. */
function feed(ears, x, f0, skip) {
  for (let i = 0; i + B <= x.length; i += B) {
    const f = f0 + i;
    if (skip && skip(f)) continue;
    const a = x.slice(i, i + B);
    ears.handle({ type: 'block', f, a, b: new Float32Array(B), perf: 1000 + ((f + B) / sr) * 1000 + 3, ctx: (f + B) / sr });
  }
}

test('frames come every 512 samples, stamped on the page clock, with the sung pitch', () => {
  const { ears, frames } = engine();
  const x = voice(() => 48, sr, 1.5, { vowel: 'a' });
  feed(ears, x, 44100 * 7); // the context has been running for 7 s
  const fs = frames();
  assert.ok(fs.length > 100, fs.length + ' frames');
  for (let i = 1; i < fs.length; i++) assert.ok(Math.abs(fs[i].t - fs[i - 1].t - (512 / sr) * 1000) < 0.01);
  // the frame describes audio in the middle of its window: about 7 s + 1000 ms + 3 ms on the page clock
  assert.ok(fs[0].t > 8000 && fs[0].t < 8100, 'first frame at ' + fs[0].t);
  const v = fs.slice(10).filter((f) => f.voiced);
  assert.ok(v.length > 0.9 * (fs.length - 10));
  assert.ok(Math.abs(SF.median(v.map((f) => f.midi)) - 48) < 0.1);
});

test('a lost block is filled with silence and a repeated one dropped, so timing stays true', () => {
  const { ears, frames } = engine();
  const x = voice(() => 55, sr, 1.0, { vowel: 'o' });
  const lost = 44100 + 20 * B;
  feed(ears, x, 44100, (f) => f === lost);
  // and a repeat of an old block
  ears.handle({ type: 'block', f: 44100 + 5 * B, a: new Float32Array(B), b: new Float32Array(B), perf: 2000, ctx: 1 });
  const fs = frames();
  for (let i = 1; i < fs.length; i++) assert.ok(Math.abs(fs[i].t - fs[i - 1].t - (512 / sr) * 1000) < 0.01, 'step ' + i);
});

test('when singing is expected, from the plan', () => {
  const { ears } = engine();
  ears.handle({ type: 'plan', plan: { mode: 'play', from: 1000, until: 9000, spans: [[2000, 2500], [4000, 4600]] } });
  assert.strictEqual(ears.expectQuiet(1500), true);
  assert.strictEqual(ears.expectQuiet(1800), false, 'just before a sung note');
  assert.strictEqual(ears.expectQuiet(2700), false, 'just after');
  assert.strictEqual(ears.expectQuiet(3300), true);
  assert.strictEqual(ears.expectQuiet(500), false, 'before playing started');
  assert.strictEqual(ears.expectQuiet(9500), false, 'beyond what the plan knows');
  ears.handle({ type: 'plan', plan: { mode: 'calib' } });
  assert.strictEqual(ears.expectQuiet(4200), 2, 'the calibration: nobody sings for sure');
  ears.handle({ type: 'plan', plan: { mode: 'stopped' } });
  assert.strictEqual(ears.expectQuiet(3300), false);
});

test('the worker is built from the very code the page loaded', () => {
  const src = SF.Ears.workerSource();
  assert.ok(src && src.includes('class PianoFilter') && src.includes('class Ears') && src.includes('self.onmessage'));
  // and it runs: evaluate it with a fake worker global
  const vm = require('vm');
  const posted = [];
  const ctx = { self: null, postMessage: (m) => posted.push(m), Float32Array, Float64Array, Uint8Array, Math, Array, Object, Map, Set, JSON, Infinity, NaN, Number, isFinite, console };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  assert.strictEqual(posted[0].type, 'hello');
  ctx.onmessage({ data: { type: 'start', sr, hasRef: false, gateDb: -50, minClarity: 0.8 } });
  assert.ok(posted.some((m) => m.type === 'status'));
});
