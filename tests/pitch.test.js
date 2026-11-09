const test = require('node:test');
const assert = require('node:assert');
const SF = require('./load.js')('core', 'pitch');
const { voice, noise } = require('./synth-voice.js');

function track(sig, sr, opts) {
  const tr = new SF.PitchTracker(sr, opts);
  const W = tr.size;
  const hop = 512;
  const frames = [];
  for (let s = 0; s + W <= sig.length; s += hop) {
    const t = ((s + W / 2) / sr) * 1000;
    frames.push(tr.process(sig.subarray(s, s + W), t));
  }
  return frames;
}

test('FFT round trip', () => {
  const f = new SF.FFT(64);
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + (i % 3));
  const im = new Float64Array(64);
  const copy = re.slice();
  f.transform(re, im);
  f.inverse(re, im);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(re[i] - copy[i]) < 1e-9);
});

for (const sr of [44100, 48000]) {
  test(`steady vowels E2..G5 within 10 cents, no octave errors (${sr} Hz)`, () => {
    let total = 0, bad = 0, octave = 0, worst = 0;
    for (let m = 40; m <= 79; m += 3) {
      for (const vowel of ['a', 'i', 'u', 'o']) {
        const sig = voice(() => m + 0.13, sr, 0.6, { vowel });
        const fr = track(sig, sr).filter((f) => f.t > 60);
        for (const f of fr) {
          total++;
          if (!f.voiced) { bad++; continue; }
          const err = (f.midi - (m + 0.13)) * 100;
          if (Math.abs(Math.abs(err) - 1200) < 100) octave++;
          else worst = Math.max(worst, Math.abs(err));
          if (Math.abs(err) > 10) bad++;
        }
      }
    }
    assert.strictEqual(octave, 0, 'octave errors');
    assert.ok(bad / total < 0.01, `bad ${bad}/${total}, worst ${worst.toFixed(1)}c`);
  });
}

test('vibrato ±60 cents at 5.5 Hz follows the pitch, median sits on the note', () => {
  const sr = 48000;
  for (const m of [43, 48, 55, 62, 67]) {
    const sig = voice(() => m, sr, 1.5, { vowel: 'a', vibrato: { rate: 5.5, cents: 60 } });
    const fr = track(sig, sr).filter((f) => f.t > 80 && f.voiced);
    assert.ok(fr.length > 100);
    const med = SF.median(fr.map((f) => f.midi));
    assert.ok(Math.abs(med - m) * 100 < 8, `median ${((med - m) * 100).toFixed(1)}c at ${m}`);
    for (const f of fr) assert.ok(Math.abs(f.midi - m) * 100 < 90, 'stays near the note');
  }
});

test('breathy singing (noise at -20 dB) still tracks', () => {
  const sr = 48000;
  for (const m of [41, 50, 59, 66]) {
    const sig = voice(() => m, sr, 0.8, { vowel: 'e', noise: 0.03, level: 0.3 });
    const fr = track(sig, sr).filter((f) => f.t > 60);
    const ok = fr.filter((f) => f.voiced && Math.abs(f.midi - m) * 100 < 15).length;
    assert.ok(ok / fr.length > 0.9, `${ok}/${fr.length} at ${m}`);
  }
});

test('quiet singing above the gate is heard, below it is not', () => {
  const sr = 48000;
  const quiet = voice(() => 50, sr, 0.5, { level: 0.01 }); // about -43 dBFS rms
  const fr = track(quiet, sr, { gateDb: -50 }).filter((f) => f.t > 60);
  assert.ok(fr.filter((f) => f.voiced).length / fr.length > 0.9);
  const fr2 = track(quiet, sr, { gateDb: -35 }).filter((f) => f.t > 60);
  assert.strictEqual(fr2.filter((f) => f.voiced).length, 0);
});

test('silence and room noise are unvoiced', () => {
  const sr = 48000;
  const fr = track(noise(sr, 1, 0.05), sr);
  assert.ok(fr.filter((f) => f.voiced).length / fr.length < 0.03, 'white noise');
  const fr2 = track(new Float32Array(sr), sr);
  assert.strictEqual(fr2.filter((f) => f.voiced).length, 0);
});

test('a real octave leap (C3 to C4, as in "do") is followed within a few frames', () => {
  const sr = 48000;
  const sig = voice((t) => (t < 0.5 ? 48 : 60), sr, 1.0, { vowel: 'a' });
  const fr = track(sig, sr).filter((f) => f.voiced);
  const after = fr.filter((f) => f.t > 600);
  assert.ok(after.every((f) => Math.abs(f.midi - 60) < 0.2), 'settled on C4');
  const lag = fr.filter((f) => f.t > 500 && Math.abs(f.midi - 60) > 0.5).length;
  assert.ok(lag <= 6, 'lag frames ' + lag);
});

test('missing fundamental (phone-like high-pass) still gives the sung note', () => {
  const sr = 48000;
  for (const m of [40, 45, 50]) {
    const raw = voice(() => m, sr, 0.6, { vowel: 'a' });
    // crude high-pass at ~200 Hz: removes the fundamental of these low notes
    const a = Math.exp((-2 * Math.PI * 200) / sr);
    const y = new Float32Array(raw.length);
    let px = 0, py = 0;
    for (let i = 0; i < raw.length; i++) { y[i] = a * (py + raw[i] - px); px = raw[i]; py = y[i]; }
    let y2 = new Float32Array(raw.length); px = 0; py = 0;
    for (let i = 0; i < raw.length; i++) { y2[i] = a * (py + y[i] - px); px = y[i]; py = y2[i]; }
    const fr = track(y2, sr).filter((f) => f.t > 80 && f.voiced);
    const med = SF.median(fr.map((f) => f.midi));
    assert.ok(Math.abs(med - m) < 0.3, `got ${med.toFixed(2)} for ${m}`);
  }
});
