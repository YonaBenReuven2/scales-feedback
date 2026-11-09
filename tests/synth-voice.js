// Vowel-like test signals: a glottal-ish harmonic source shaped by formants,
// with optional vibrato, pitch drift, breath noise and level.
const VOWELS = {
  a: [[730, 90, 1], [1090, 110, 0.5], [2440, 160, 0.25]],
  i: [[270, 60, 1], [2290, 100, 0.35], [3010, 120, 0.25]],
  u: [[300, 60, 1], [870, 90, 0.4], [2240, 120, 0.12]],
  e: [[530, 70, 1], [1840, 100, 0.4], [2480, 120, 0.25]],
  o: [[570, 70, 1], [840, 80, 0.6], [2410, 120, 0.15]],
};
function env(f, formants) {
  let g = 0;
  for (const [F, B, a] of formants) g += a / (1 + ((f - F) / B) ** 2);
  return g + 0.02;
}
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
/** pitchAt(t) -> midi (float); returns Float32Array */
function voice(pitchAt, sr, dur, opts = {}) {
  const n = Math.round(sr * dur);
  const out = new Float32Array(n);
  const formants = VOWELS[opts.vowel || 'a'];
  const level = opts.level == null ? 0.3 : opts.level;
  const vib = opts.vibrato || null; // {rate, cents}
  let phase = 0;
  const H = [];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let m = pitchAt(t);
    if (vib) m += (vib.cents / 100) * Math.sin(2 * Math.PI * vib.rate * t);
    const f0 = 440 * Math.pow(2, (m - 69) / 12);
    phase += (2 * Math.PI * f0) / sr;
    // recompute harmonic amplitudes every 256 samples
    if (i % 256 === 0) {
      H.length = 0;
      for (let h = 1; h * f0 < Math.min(5000, sr / 2 - 200); h++) H.push((env(h * f0, formants) / Math.pow(h, 0.7)));
    }
    let s = 0;
    for (let h = 0; h < H.length; h++) s += H[h] * Math.sin((h + 1) * phase);
    out[i] = s;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * level + (opts.noise ? opts.noise * gauss() : 0);
  return out;
}
function noise(sr, dur, level) {
  const n = Math.round(sr * dur);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = level * gauss();
  return out;
}
const reseed = (n) => (seed = n || 12345);
module.exports = { voice, noise, VOWELS, reseed };
