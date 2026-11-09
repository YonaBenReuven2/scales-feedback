// A small acoustic simulation for testing the piano-reference canceller.
const SF = require('./load.js')('core', 'pitch');

let seed = 987654;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

/** Piano-like tones: stretched partials, per-partial decay, damper on release. */
function piano(events, sr, dur) {
  const n = Math.round(sr * dur);
  const out = new Float32Array(n);
  for (const ev of events) {
    const f0 = 440 * Math.pow(2, (ev.pitch - 69) / 12);
    const B = 1.5e-4 * Math.pow(2, (ev.pitch - 48) / 18);
    const s0 = Math.round(ev.t * sr);
    const off = Math.round((ev.t + ev.d) * sr);
    const end = Math.min(n, off + Math.round(0.4 * sr));
    const amp = (ev.vel || 64) / 127;
    for (let h = 1; h <= 40; h++) {
      const fh = h * f0 * Math.sqrt(1 + B * h * h);
      if (fh > 7000) break;
      const a = (amp / Math.pow(h, 1.1)) * (0.6 + 0.4 * Math.cos(h * 1.3));
      const tau = (2.5 * Math.sqrt(130 / f0)) / (1 + 0.12 * h);
      const ph = rand() * 6.283;
      const w = (2 * Math.PI * fh) / sr;
      for (let i = s0; i < end; i++) {
        const t = (i - s0) / sr;
        let e = Math.exp(-t / tau) * Math.min(1, t / 0.003);
        if (i >= off) e *= Math.exp(-(i - off) / sr / 0.07);
        out[i] += a * e * Math.sin(w * (i - s0) + ph);
      }
    }
  }
  return out;
}

/** Room: direct sound, a few reflections, and a diffuse tail. */
function roomIR(sr, opts = {}) {
  const rt60 = opts.rt60 || 0.35;
  const n = Math.round(sr * Math.min(0.6, rt60 * 1.2));
  const h = new Float32Array(n);
  const tap = (ms, g) => { const i = Math.round((ms / 1000) * sr); if (i < n) h[i] += g; };
  tap(0, 0.6); tap(2.9, 0.33); tap(6.1, -0.24); tap(9.7, 0.18); tap(13.4, -0.12); tap(17.0, 0.1);
  const k = Math.log(1000) / rt60;
  for (let i = Math.round(0.02 * sr); i < n; i++) h[i] += 0.04 * gauss() * Math.exp(-k * (i / sr));
  // a bit of speaker/mic colouring: one-pole lowpass
  let y = 0;
  for (let i = 0; i < n; i++) { y = 0.7 * h[i] + 0.3 * y; h[i] = y; }
  return h;
}

function convolve(x, h) {
  let N = 1;
  while (N < x.length + h.length) N <<= 1;
  const fft = new SF.FFT(N);
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  for (let i = 0; i < x.length; i++) ar[i] = x[i];
  for (let i = 0; i < h.length; i++) br[i] = h[i];
  fft.transform(ar, ai); fft.transform(br, bi);
  for (let k = 0; k < N; k++) { const r = ar[k] * br[k] - ai[k] * bi[k]; ai[k] = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = r; }
  fft.inverse(ar, ai);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = ar[i];
  return y;
}

/** y[n] = x[(n - delay) * (1 + drift)], linear interpolation. */
function shift(x, delay, drift = 0) {
  const y = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    const p = (n - delay) * (1 + drift);
    const i = Math.floor(p);
    if (i < 0 || i + 1 >= x.length) continue;
    const f = p - i;
    y[n] = x[i] * (1 - f) + x[i + 1] * f;
  }
  return y;
}

function rms(x, a = 0, b = x.length) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); }

const reseed = (n) => (seed = n || 987654);
module.exports = { piano, roomIR, convolve, shift, rms, gauss, reseed };
