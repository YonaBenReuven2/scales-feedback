/* Singing pitch detection: the McLeod Pitch Method (normalised square difference),
 * computed through an FFT, plus a small tracker that steadies octave flips.
 *
 * detect() takes one window of samples and returns the frequency and a clarity
 * between 0 and 1 (how periodic the window is). Voice is "voiced" when the
 * clarity is high and the level is above the noise gate.
 */
(function (factory) {
  // kept as source too, so the listening worker can be built from the same code
  const root = typeof window !== 'undefined' ? window : globalThis;
  (root.SF_SRC = root.SF_SRC || {}).pitch = factory;
  factory(root);
})(function (root) {
  'use strict';
  const SF = root.SF;

  class FFT {
    constructor(n) {
      this.n = n;
      this.rev = new Uint32Array(n);
      const bits = Math.round(Math.log2(n));
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        this.rev[i] = r;
      }
      this.cos = new Float64Array(n / 2);
      this.sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) {
        this.cos[i] = Math.cos((2 * Math.PI * i) / n);
        this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
      }
    }
    transform(re, im) {
      const n = this.n;
      const rev = this.rev;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i];
          re[i] = re[j];
          re[j] = t;
          t = im[i];
          im[i] = im[j];
          im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j;
            const b = a + half;
            const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
            const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
            re[b] = re[a] - tr;
            im[b] = im[a] - ti;
            re[a] += tr;
            im[a] += ti;
          }
        }
      }
    }
    inverse(re, im) {
      const n = this.n;
      for (let i = 0; i < n; i++) im[i] = -im[i];
      this.transform(re, im);
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] = -im[i] / n;
      }
    }
  }

  class PitchDetector {
    constructor(sampleRate, size, opts) {
      opts = opts || {};
      this.sr = sampleRate;
      this.W = size;
      let N = 1;
      while (N < 2 * size) N <<= 1;
      this.N = N;
      this.fft = new FFT(N);
      this.re = new Float64Array(N);
      this.im = new Float64Array(N);
      this.x = new Float64Array(size);
      this.nsdf = new Float64Array(size);
      this.minF = opts.minF || 55;
      this.maxF = opts.maxF || 1100;
      this.k = opts.k || 0.93; // 0.9 lets a strong 2nd harmonic win (octave-up errors)
    }
    detect(frame) {
      const W = this.W;
      const x = this.x;
      let mean = 0;
      for (let i = 0; i < W; i++) mean += frame[i];
      mean /= W;
      let ss = 0;
      for (let i = 0; i < W; i++) {
        const v = frame[i] - mean;
        x[i] = v;
        ss += v * v;
      }
      const rms = Math.sqrt(ss / W);
      const res = { freq: 0, clarity: 0, rms, maxima: [] };
      if (rms < 1e-5) return res;

      const re = this.re;
      const im = this.im;
      re.fill(0);
      im.fill(0);
      for (let i = 0; i < W; i++) re[i] = x[i];
      this.fft.transform(re, im);
      for (let i = 0; i < this.N; i++) {
        re[i] = re[i] * re[i] + im[i] * im[i];
        im[i] = 0;
      }
      this.fft.inverse(re, im); // re[tau] = sum x[j] x[j+tau]

      const maxTau = Math.min(W - 2, Math.ceil(this.sr / this.minF) + 2);
      const minTau = Math.max(2, Math.floor(this.sr / this.maxF));
      const nsdf = this.nsdf;
      let m = 2 * ss;
      nsdf[0] = 1;
      for (let t = 1; t <= maxTau; t++) {
        m -= x[t - 1] * x[t - 1] + x[W - t] * x[W - t];
        nsdf[t] = m > 1e-12 ? (2 * re[t]) / m : 0;
      }

      const pick = pickPeriod(nsdf, minTau, maxTau, this.k);
      res.maxima = pick.maxima;
      if (!pick.best) return res;
      res.freq = this.sr / pick.best.tau;
      res.clarity = Math.min(1, pick.best.val);
      return res;
    }
  }

  /** MPM peak picking on a normalised autocorrelation: the first key maximum within k of the highest. */
  function pickPeriod(nsdf, minTau, maxTau, k) {
    const interp = (i) => {
      const a = nsdf[i - 1];
      const b = nsdf[i];
      const c = nsdf[i + 1];
      const den = a - 2 * b + c;
      const d = den ? (0.5 * (a - c)) / den : 0;
      const dd = Math.abs(d) < 1 ? d : 0;
      return { tau: i + dd, val: b - 0.25 * (a - c) * dd };
    };
    let t = 1;
    while (t < maxTau && nsdf[t] > 0) t++;
    const maxima = [];
    while (t < maxTau) {
      while (t < maxTau && nsdf[t] <= 0) t++;
      if (t >= maxTau) break;
      let best = t;
      while (t < maxTau && nsdf[t] > 0) {
        if (nsdf[t] > nsdf[best]) best = t;
        t++;
      }
      if (best >= minTau && best < maxTau) maxima.push(interp(best));
    }
    if (!maxima.length) return { best: null, maxima };
    let top = 0;
    for (const mx of maxima) if (mx.val > top) top = mx.val;
    return { best: maxima.find((mx) => mx.val >= k * top), maxima };
  }

  /** Detector + state: noise gate, clarity threshold, octave-flip hysteresis, light smoothing. */
  class PitchTracker {
    constructor(sampleRate, opts) {
      opts = opts || {};
      const size = opts.size || (sampleRate > 60000 ? 4096 : 2048);
      this.size = size;
      this.det = new PitchDetector(sampleRate, size, opts);
      this.minClarity = opts.minClarity || 0.8;
      this.gateDb = opts.gateDb == null ? -50 : opts.gateDb;
      this.a4 = opts.a4 || 440;
      this.stable = null; // {midi, t}
      this.cand = 0;
      this.recent = [];
    }
    process(frame, t) {
      const r = this.det.detect(frame);
      const db = r.rms > 0 ? 20 * Math.log10(r.rms) : -120;
      const out = { t, db, clarity: r.clarity, voiced: false, midi: null, raw: null };
      if (!(r.freq > 0 && r.clarity >= this.minClarity && db >= this.gateDb)) {
        if (this.stable && t - this.stable.t > 250) this.stable = null;
        this.recent.length = 0;
        return out;
      }
      let midi = SF.hzToMidi(r.freq, this.a4);
      out.raw = midi;
      if (this.stable) {
        const d = midi - this.stable.midi;
        const oct = Math.round(d / 12);
        if (oct !== 0 && Math.abs(d - oct * 12) < 1.2) {
          // an octave away from where the voice just was: believe it after 2 frames in a row
          this.cand = Math.sign(this.cand) === Math.sign(oct) ? this.cand + Math.sign(oct) : Math.sign(oct);
          if (Math.abs(this.cand) >= 2) {
            this.cand = 0;
          } else {
            midi -= oct * 12;
          }
        } else this.cand = 0;
      }
      this.stable = { midi, t };
      this.recent.push(midi);
      if (this.recent.length > 3) this.recent.shift();
      out.voiced = true;
      out.midi = this.recent.length === 3 ? SF.median(this.recent) : midi;
      return out;
    }
    reset() {
      this.stable = null;
      this.cand = 0;
      this.recent.length = 0;
    }
  }

  SF.FFT = FFT;
  SF.pickPeriod = pickPeriod;
  SF.PitchDetector = PitchDetector;
  SF.PitchTracker = PitchTracker;
});
