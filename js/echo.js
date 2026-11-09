/* Hearing the singer through the piano: cancel the piano using its own USB audio.
 *
 * The P-225 sends its sound to the computer over USB before it reaches its
 * speakers. In the room the microphone hears that same sound — later, and
 * shaped by the speakers and the room — plus the voice. So:
 *
 *  1. DelayTracker finds how far the room mic lags the piano's USB audio
 *     (GCC-PHAT, only on stretches that hold a note onset: steady notes are
 *     ambiguous).
 *  2. RoomModel learns the path from the piano's audio to the mic as an
 *     impulse response (H1 estimate from long-window cross-spectra), only while
 *     nobody should be singing — the reference chords, or a calibration run.
 *  3. Convolver plays the piano's USB audio through that impulse response, which
 *     predicts what the mic hears of the piano, sample by sample; subtracting it
 *     leaves the voice — even when the voice sings the very note the piano plays.
 *  4. analyzeFrame() reads the pitch from what is left and only calls a frame
 *     sung when what is left is clearly louder than the piano's expected leftover,
 *     so the piano on its own never scores a note.
 *
 * Plain DSP on Float32Arrays: tested offline with a simulated room.
 */
(function (factory) {
  // kept as source too, so the listening worker can be built from the same code
  const root = typeof window !== 'undefined' ? window : globalThis;
  (root.SF_SRC = root.SF_SRC || {}).echo = factory;
  factory(root);
})(function (root) {
  'use strict';
  const SF = root.SF;

  const hann = (n) => {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    return w;
  };
  const pow2 = (x) => {
    let n = 1;
    while (n < x) n <<= 1;
    return n;
  };

  // ---------------------------------------------------------------- delay
  class DelayTracker {
    /** Finds lag d (samples) such that mic[n] ~ ref[n - d]. */
    constructor(sampleRate, opts) {
      opts = opts || {};
      this.sr = sampleRate;
      this.L = pow2(sampleRate * (opts.window || 0.6));
      this.N = 2 * this.L;
      this.fft = new SF.FFT(this.N);
      this.maxLag = Math.round(sampleRate * (opts.maxLag || 0.25));
      this.negLag = opts.symmetric ? this.maxLag : Math.round(this.maxLag / 4);
      this.cr = new Float64Array(this.N);
      this.ci = new Float64Array(this.N);
      this.a = new Float64Array(this.N);
      this.b = new Float64Array(this.N);
      // Tukey taper: cutting both streams at the same sample would itself correlate at lag 0
      this.taper = new Float64Array(this.L);
      const edge = Math.round(this.L * 0.06);
      for (let i = 0; i < this.L; i++) {
        const d = Math.min(i, this.L - 1 - i);
        this.taper[i] = d >= edge ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * d) / edge);
      }
      this.delay = null; // accepted (several windows agree)
      this.raw = null; // latest single-window estimate
      this.confidence = 0;
      this.history = [];
      this.onsets = 0;
    }
    /** Signal-only onset test (spectral flux). Not used by PianoFilter, which is told when the
     *  app struck a key; kept for callers without that knowledge. Fires on beating chords too. */
    hasOnset(ref) {
      // spectral flux on short blocks: a new note brings energy at frequencies that were quiet,
      // even when other notes are still ringing (a steady chord brings none)
      const M = 1024;
      if (!this.offt) {
        this.offt = new SF.FFT(M);
        this.ore = new Float64Array(M);
        this.oim = new Float64Array(M);
        this.oprev = new Float64Array(M / 2);
        this.ocur = new Float64Array(M / 2);
      }
      const blocks = Math.floor(ref.length / M);
      const last = Math.floor(blocks * 0.45);
      let prevTotal = 0;
      for (let b = 0; b <= last; b++) {
        const re = this.ore;
        const im = this.oim;
        for (let i = 0; i < M; i++) {
          re[i] = ref[b * M + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / M));
          im[i] = 0;
        }
        this.offt.transform(re, im);
        let total = 0;
        let flux = 0;
        for (let k = 2; k < M / 2; k++) {
          const mag = Math.hypot(re[k], im[k]);
          this.ocur[k] = mag;
          total += mag;
          const d = mag - this.oprev[k];
          if (d > 0) flux += d;
        }
        if (b >= 2 && total > 1e-4 && prevTotal > 0 && flux > 0.6 * prevTotal) return true;
        if (b >= 2 && total > 1e-3 && prevTotal <= 1e-6) return true; // a note out of silence
        this.oprev.set(this.ocur);
        prevTotal = total;
      }
      return false;
    }
    /** mic and ref: the same L samples of time from both streams (no alignment).
     *  strict: someone may be singing, so only trust a clear peak, and (given near, the
     *  delay expected) only one close to it: a voice in unison with the piano can make a
     *  convincing peak anywhere. */
    add(mic, ref, strict, near) {
      this.strict = !!strict;
      this.near = strict && near != null ? near : null;
      this.spectrum(mic, ref);
      this.onsets++;
      return this.estimate();
    }
    /** One window on its own: {lag, conf} of the clearest peak (no history, no threshold). */
    measure(mic, ref) {
      this.spectrum(mic, ref);
      return this.peak();
    }
    spectrum(mic, ref) {
      const N = this.N;
      const L = this.L;
      const a = this.a;
      const b = this.b;
      // one complex FFT for both real signals: z = mic + j·ref
      a.fill(0);
      b.fill(0);
      for (let i = 0; i < L; i++) {
        a[i] = mic[i] * this.taper[i];
        b[i] = ref[i] * this.taper[i];
      }
      this.fft.transform(a, b);
      for (let k = 0; k < N; k++) {
        const j = (N - k) % N;
        // X = (Z[k] + conj Z[N-k]) / 2 ; Y = (Z[k] - conj Z[N-k]) / 2j
        const xr = 0.5 * (a[k] + a[j]);
        const xi = 0.5 * (b[k] - b[j]);
        const yr = 0.5 * (b[k] + b[j]);
        const yi = -0.5 * (a[k] - a[j]);
        // X * conj(Y), one window at a time: windows must agree with each other
        this.cr[k] = xr * yr + xi * yi;
        this.ci[k] = xi * yr - xr * yi;
      }
    }
    peak() {
      const N = this.N;
      const a = this.a;
      const b = this.b;
      for (let k = 0; k < N; k++) {
        const mag = Math.hypot(this.cr[k], this.ci[k]) + 1e-20;
        const f = ((k <= N / 2 ? k : N - k) * this.sr) / N;
        const w = f > 80 && f < 5000 ? 1 / mag : 0; // PHAT, where piano and mic overlap
        a[k] = this.cr[k] * w;
        b[k] = this.ci[k] * w;
      }
      this.fft.inverse(a, b);
      let best = 0;
      let bestV = -Infinity;
      let sum = 0;
      let cnt = 0;
      for (let lag = -this.negLag; lag <= this.maxLag; lag++) {
        const v = a[(lag + N) % N];
        sum += Math.abs(v);
        cnt++;
        if (v > bestV) {
          bestV = v;
          best = lag;
        }
      }
      const conf = sum > 0 ? bestV / (sum / cnt) : 0;
      const y0 = a[(best - 1 + N) % N];
      const y1 = a[(best + N) % N];
      const y2 = a[(best + 1 + N) % N];
      const den = y0 - 2 * y1 + y2;
      const frac = den ? (0.5 * (y0 - y2)) / den : 0;
      return { lag: best + (Math.abs(frac) < 1 ? frac : 0), conf };
    }
    estimate() {
      const pk = this.peak();
      const conf = pk.conf;
      this.confidence = conf;
      if (conf > (this.strict ? 16 : 10)) {
        this.raw = pk.lag;
        if (this.near != null && Math.abs(this.raw - this.near) > this.sr * 0.0015) return this.delay;
        this.history.push(this.raw);
        if (this.history.length > 7) this.history.shift();
        // accept the largest group of recent estimates within 3 samples of each other (3+ windows)
        let bestGroup = [];
        for (const x of this.history) {
          const g = this.history.filter((y) => Math.abs(y - x) <= 3);
          if (g.length > bestGroup.length) bestGroup = g;
        }
        if (bestGroup.length >= 3) this.delay = SF.median(bestGroup);
      }
      return this.delay;
    }
    reset() {
      this.cr.fill(0);
      this.ci.fill(0);
      this.delay = null;
      this.history = [];
      this.onsets = 0;
    }
  }

  // ---------------------------------------------------------------- room
  class RoomModel {
    constructor(sampleRate, opts) {
      opts = opts || {};
      this.sr = sampleRate;
      this.Lw = pow2(sampleRate * (opts.learnWindow || 0.6)); // ~0.7 s: shorter windows bias the estimate low
      this.N = 2 * this.Lw;
      this.fft = new SF.FFT(this.N);
      this.win = hann(this.Lw);
      this.K = this.N / 2 + 1;
      this.Sr = new Float64Array(this.K); // cross-spectrum mic·conj(ref)
      this.Si = new Float64Array(this.K);
      this.Srr = new Float64Array(this.K);
      this.a = new Float64Array(this.N);
      this.b = new Float64Array(this.N);
      this.pre = opts.pre || 256; // taps before the main delay (estimation slack)
      this.Lh = opts.taps || Math.round(sampleRate * 0.17);
      this.forget = opts.forget || 0.985;
      this.updates = 0;
      this.h = null;
    }
    /** mic and ref (already aligned): Lw samples each, from a stretch with nobody singing. */
    learn(mic, ref) {
      const N = this.N;
      const a = this.a;
      const b = this.b;
      a.fill(0);
      b.fill(0);
      let er = 0;
      for (let i = 0; i < this.Lw; i++) {
        a[i] = mic[i] * this.win[i];
        b[i] = ref[i] * this.win[i];
        er += ref[i] * ref[i];
      }
      if (er / this.Lw < 1e-10) return false;
      this.fft.transform(a, b);
      const f = this.forget;
      for (let k = 0; k < this.K; k++) {
        const j = (N - k) % N;
        const xr = 0.5 * (a[k] + a[j]);
        const xi = 0.5 * (b[k] - b[j]);
        const yr = 0.5 * (b[k] + b[j]);
        const yi = -0.5 * (a[k] - a[j]);
        this.Sr[k] = f * this.Sr[k] + (xr * yr + xi * yi);
        this.Si[k] = f * this.Si[k] + (xi * yr - xr * yi);
        this.Srr[k] = f * this.Srr[k] + (yr * yr + yi * yi);
      }
      this.updates++;
      return true;
    }
    /**
     * Impulse response h (this.pre taps before lag 0, then this.Lh after).
     *
     * The piano only excites its partials, so the plain H1 estimate S/Srr is known at a
     * scattering of frequencies and ~0 in between; its impulse response is then long and
     * truncating it ruins the fit. Instead find the compact response that fits the
     * frequencies the piano did excite: alternate between "match the measured cross-spectrum
     * where there was excitation" and "no energy outside the support" (warm-started, so a
     * few rounds per call are enough as learning goes on).
     */
    solve(iterations) {
      if (!this.updates) return null;
      const N = this.N;
      const a = this.a;
      const b = this.b;
      const len = this.pre + this.Lh;
      let mx = 0;
      for (let k = 0; k < this.K; k++) if (this.Srr[k] > mx) mx = this.Srr[k];
      const eps = mx * 1e-3;
      if (!this.hc) this.hc = new Float64Array(len);
      const hc = this.hc;
      const iters = iterations || (this.solves ? 2 : 10);
      for (let it = 0; it < iters; it++) {
        // spectrum of the current compact response
        a.fill(0);
        b.fill(0);
        for (let i = 0; i < len; i++) a[(i - this.pre + N) % N] = hc[i];
        this.fft.transform(a, b);
        // where the piano excited a bin, move to what was measured there
        for (let k = 0; k < this.K; k++) {
          const s = this.Srr[k];
          const d = s + eps;
          const nr = (this.Sr[k] + eps * a[k]) / d;
          const ni = (this.Si[k] + eps * b[k]) / d;
          a[k] = k === 0 ? 0 : nr;
          b[k] = k === 0 ? 0 : ni;
          if (k > 0 && k < this.K - 1) {
            a[N - k] = a[k];
            b[N - k] = -b[k];
          }
        }
        b[N / 2] = 0;
        this.fft.inverse(a, b);
        // back to the support
        for (let i = 0; i < len; i++) hc[i] = a[(i - this.pre + N) % N];
      }
      this.solves = (this.solves || 0) + 1;
      const h = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        let v = hc[i];
        if (i < 32) v *= 0.5 - 0.5 * Math.cos((Math.PI * i) / 32); // soften both ends
        const tail = len - i;
        if (tail < 512) v *= 0.5 - 0.5 * Math.cos((Math.PI * tail) / 512);
        h[i] = v;
      }
      this.h = h;
      return h;
    }
    reset() {
      this.Sr.fill(0);
      this.Si.fill(0);
      this.Srr.fill(0);
      this.updates = 0;
      this.solves = 0;
      this.hc = null;
      this.h = null;
    }
  }

  // ---------------------------------------------------------------- convolution
  /** Uniformly partitioned overlap-save convolution, block size B. */
  class Convolver {
    constructor(B) {
      this.B = B;
      this.N = 2 * B;
      this.fft = new SF.FFT(this.N);
      this.parts = [];
      this.fdl = [];
      this.buf = new Float64Array(this.N);
      this.accR = new Float64Array(this.N);
      this.accI = new Float64Array(this.N);
    }
    setFilter(h) {
      const B = this.B;
      const P = Math.ceil(h.length / B);
      const parts = [];
      for (let p = 0; p < P; p++) {
        const re = new Float64Array(this.N);
        const im = new Float64Array(this.N);
        for (let i = 0; i < B && p * B + i < h.length; i++) re[i] = h[p * B + i];
        this.fft.transform(re, im);
        parts.push([re, im]);
      }
      this.parts = parts;
      while (this.fdl.length < P) this.fdl.push([new Float64Array(this.N), new Float64Array(this.N)]);
      this.fdl.length = P;
    }
    /** x: B input samples; out: B output samples. */
    process(x, out) {
      const B = this.B;
      const N = this.N;
      this.buf.copyWithin(0, B);
      for (let i = 0; i < B; i++) this.buf[B + i] = x[i];
      if (!this.parts.length) {
        out.fill(0);
        return out;
      }
      const spec = this.fdl.pop();
      spec[0].set(this.buf);
      spec[1].fill(0);
      this.fft.transform(spec[0], spec[1]);
      this.fdl.unshift(spec);
      const ar = this.accR;
      const ai = this.accI;
      ar.fill(0);
      ai.fill(0);
      for (let p = 0; p < this.parts.length; p++) {
        const hr = this.parts[p][0];
        const hi = this.parts[p][1];
        const xr = this.fdl[p][0];
        const xi = this.fdl[p][1];
        for (let k = 0; k < N; k++) {
          ar[k] += hr[k] * xr[k] - hi[k] * xi[k];
          ai[k] += hr[k] * xi[k] + hi[k] * xr[k];
        }
      }
      this.fft.inverse(ar, ai);
      for (let i = 0; i < B; i++) out[i] = ar[B + i];
      return out;
    }
  }

  // ---------------------------------------------------------------- the whole filter
  /**
   * Streaming: push(mic, ref, quiet) with equal-length blocks captured together.
   * Samples below this.done are then available through res(i) (mic minus the
   * predicted piano), echo(i) (the predicted piano) and mic(i).
   */
  class PianoFilter {
    constructor(sampleRate, opts) {
      opts = opts || {};
      this.sr = sampleRate;
      this.B = 512;
      this.cap = pow2(sampleRate * 4);
      this.mask = this.cap - 1;
      this.micR = new Float32Array(this.cap);
      this.refR = new Float32Array(this.cap);
      this.resR = new Float32Array(this.cap);
      this.echoR = new Float32Array(this.cap);
      this.quietR = new Uint8Array(this.cap / this.B);
      this.dR = new Float64Array(this.cap / this.B); // the alignment each block was computed with
      this.refE = new Float32Array(this.cap / this.B); // mean square of the reference per block
      this.hasRef = false;
      // Which piano keys the room has been learned for. The model is only trusted for keys it
      // has heard in a quiet stretch (or in the calibration run): a key it has never heard
      // would leave most of its sound behind and could pass for a voice.
      this.keyLearn = new Uint8Array(128);
      this.keys = []; // {p, i0, i1}: when each key sounded, in reference samples
      this.n = 0; // samples captured
      this.tracker = new DelayTracker(sampleRate, opts);
      // once the room is known: how far the mic is from the predicted piano (0 when aligned)
      this.rtrack = new DelayTracker(sampleRate, { window: 0.3, maxLag: 0.05, symmetric: true });
      this.rq = []; // onsets waiting for their window of predicted piano
      this.room = new RoomModel(sampleRate, opts);
      this.conv = new Convolver(this.B);
      this.pre = this.room.pre;
      this.delay = null; // samples the mic lags the reference
      this.dUsed = null;
      this.alignPos = 0; // next mic index the echo estimate is computed for
      this.done = 0;
      this.lastGcc = -Infinity;
      this.lastLearn = -Infinity;
      this.lastSolve = -Infinity;
      this.learnedSec = 0;
      this.xb = new Float32Array(this.B);
      this.yb = new Float32Array(this.B);
      this.echoQuiet = 0; // smoothed quiet-time energies: how much piano is left after cancelling
      this.resQuiet = 0;
      this.solved = false;
      this.onsetAt = [];
      this.pendingOnsets = [];
      this.tmpL = new Float32Array(this.tracker.L);
      this.tmpL2 = new Float32Array(this.tracker.L);
      this.tmpW = new Float32Array(this.room.Lw);
      this.tmpW2 = new Float32Array(this.room.Lw);
    }
    get ready() {
      return this.solved && this.delay != null;
    }
    /** Fraction of the piano's energy left after cancelling, measured while nobody sings —
     *  on the high side (mean + 1 sd, in dB), since a voice is only believed above it. */
    get leftover() {
      if (!this.lCount) return 1;
      return Math.min(1, Math.pow(10, (this.lMean + Math.sqrt(Math.max(0, this.lVar))) / 10));
    }
    /** Typical cancellation in dB (for display). */
    get cancelDb() {
      return this.lCount ? Math.max(0, -this.lMean) : 0;
    }
    /** Loudest block of the reference between indices i0 and i1 (mean square). */
    refPeak(i0, i1) {
      const q = this.refE.length - 1;
      let m = 0;
      for (let s = Math.max(0, Math.floor(i0 / this.B), Math.floor((this.n - this.cap) / this.B) + 1); s <= Math.floor((i1 - 1) / this.B); s++) m = Math.max(m, this.refE[s & q]);
      return m;
    }
    quietAt(i) {
      return i >= 0 && this.quietR[Math.floor(i / this.B) & (this.quietR.length - 1)] === 1;
    }
    copy(ring, end, out) {
      const len = out.length;
      for (let i = 0; i < len; i++) out[i] = ring[(end - len + i) & this.mask];
      return out;
    }
    refAt(pos) {
      const i = Math.floor(pos);
      if (i < 0 || i + 1 >= this.n || i <= this.n - this.cap) return 0;
      const f = pos - i;
      return this.refR[i & this.mask] * (1 - f) + this.refR[(i + 1) & this.mask] * f;
    }
    /** onset: a note-on was sent to the piano during this block.
     *  events: the keys pressed ({p, on: true}) and released ({p, on: false}) in it. */
    push(mic, ref, quiet, onset, events) {
      const len = mic.length;
      if (onset) this.pendingOnsets.push(this.n);
      if (events && events.length) this.keyEvents(events);
      for (let i = 0; i < len; i++) {
        const k = (this.n + i) & this.mask;
        this.micR[k] = mic[i];
        this.refR[k] = ref ? ref[i] : 0;
      }
      const q = this.quietR.length - 1;
      let e = 0;
      if (ref) {
        this.hasRef = true;
        for (let i = 0; i < len; i++) e += ref[i] * ref[i];
        e /= len;
      }
      for (let s = Math.floor(this.n / this.B); s <= Math.floor((this.n + len - 1) / this.B); s++) {
        this.quietR[s & q] = quiet ? 1 : 0;
        this.refE[s & q] = e;
      }
      this.n += len;
      this.step();
    }
    keyEvents(events) {
      for (const ev of events) {
        if (ev.p === 'all') {
          for (const k of this.keys) if (k.i1 === Infinity) k.i1 = this.n;
          continue;
        }
        if (!(ev.p >= 0 && ev.p < 128)) continue;
        if (ev.on) this.keys.push({ p: ev.p, i0: this.n, i1: Infinity });
        else {
          const k = this.keys.find((x) => x.p === ev.p && x.i1 === Infinity);
          if (k) k.i1 = this.n;
        }
      }
      const old = this.n - this.cap;
      if (this.keys.length > 400 || (this.keys.length && this.keys[0].i1 < old)) this.keys = this.keys.filter((x) => x.i1 >= old).slice(-400);
    }
    /** The room was just learned from reference samples e0..e1: the keys that sounded there are known. */
    learnKeys(e0, e1) {
      const need = this.sr * 0.15;
      for (const k of this.keys) {
        if (Math.min(k.i1, e1) - Math.max(k.i0, e0) >= need && this.keyLearn[k.p] < 255) this.keyLearn[k.p]++;
      }
    }
    /** Is a key the room hasn't been learned for sounding into the mic frame ending at end? */
    unlearnedAt(end, W) {
      const d = this.dUsed || 0;
      const e1 = end - d;
      const e0 = end - W - d - this.sr * 0.5; // a released key rings on for a moment
      for (const k of this.keys) if (this.keyLearn[k.p] < 2 && k.i0 <= e1 && k.i1 >= e0) return true;
      return false;
    }
    /** How often the least-heard key sounding into the frame ending at end was learned
     *  (Infinity when no key is known to sound). */
    leastLearned(end, W) {
      const d = this.dUsed || 0;
      const e1 = end - d;
      const e0 = end - W - d - this.sr * 0.5;
      let m = Infinity;
      for (const k of this.keys) if (k.i0 <= e1 && k.i1 >= e0 && this.keyLearn[k.p] < m) m = this.keyLearn[k.p];
      return m;
    }
    /** Keys learned so far (for the UI). */
    get keysLearned() {
      let n = 0;
      for (let p = 0; p < 128; p++) if (this.keyLearn[p] >= 2) n++;
      return n;
    }
    /** Move a "key struck" mark to the attack itself: the biggest rise in the reference's
     *  brightness within 150 ms of it (the mark's timing can be off by tens of ms). */
    refineOnsets() {
      const sr = this.sr;
      const win = Math.round(sr * 0.15);
      const hop = 256;
      while (this.pendingOnsets.length && this.pendingOnsets[0] + win + hop <= this.n) {
        const o = this.pendingOnsets.shift();
        let best = o;
        let bestRise = 0;
        let prevE = null;
        for (let s0 = Math.max(1, o - win); s0 + hop <= Math.min(this.n, o + win); s0 += hop) {
          let e = 0;
          for (let i = s0; i < s0 + hop; i++) {
            const d = this.refR[i & this.mask] - this.refR[(i - 1) & this.mask];
            e += d * d;
          }
          if (prevE != null && prevE > 0) {
            const rise = e / prevE;
            if (rise > bestRise) {
              bestRise = rise;
              best = s0;
            }
          } else if (prevE === 0 && e > 0 && bestRise < 1e6) {
            bestRise = 1e6;
            best = s0;
          }
          prevE = e;
        }
        const at = bestRise >= 1.5 ? best : o;
        this.onsetAt.push(at);
        if (this.onsetAt.length > 64) this.onsetAt.shift();
        if (this.solved && (!this.rq.length || at - this.rq[this.rq.length - 1] > this.sr * 0.12)) this.rq.push(at);
      }
    }
    step() {
      const sr = this.sr;
      const L = this.tracker.L;
      this.refineOnsets();
      // 1. the delay, from quiet stretches that hold an onset
      // Only windows with a key struck early in them (so the mic's delayed copy is inside too);
      // also while singing, at a stricter confidence, to keep up with clock drift.
      const w0 = this.n - L;
      const struck = this.onsetAt.some((o) => o >= w0 + 0.05 * L && o <= w0 + 0.45 * L);
      const quietWin = this.quietAt(this.n - 1) && this.quietAt(this.n - L);
      // Until the room is known: the delay between the raw streams, from quiet stretches.
      // (Afterwards that number shifts with which notes play, since the room delays low and
      // high notes differently; the room model takes care of that, so it is no longer used.)
      if (!this.solved && this.n - this.lastGcc >= sr * 0.08 && this.n >= L && struck && quietWin) {
        this.lastGcc = this.n;
        const d = this.tracker.add(this.copy(this.micR, this.n, this.tmpL), this.copy(this.refR, this.n, this.tmpL2), false);
        if (d != null && d !== this.lastAccepted) {
          this.lastAccepted = d;
          const at = this.n - L / 2; // the onset sits early in the window
          if (this.delay == null) {
            this.dUsed = d;
            this.alignPos = Math.max(this.done, Math.ceil(this.n - L * 0.5));
            this.dpts = [];
            // the same setup as last time: start from the room learned then
            if (this.saved && Math.abs(this.saved.delay - d) <= sr * 0.003) {
              this.dUsed = this.saved.delay;
              this.useSaved();
            }
            this.saved = null;
          } else if (Math.abs(d - this.dUsed) > sr * 0.001) {
            this.dUsed = d;
            this.dpts = [];
          }
          this.dpts.push([at, this.dUsed]);
          this.delay = this.dUsed;
        }
      }
      if (this.solved) this.follow();
      if (this.delay == null) {
        for (let i = this.done; i < this.n; i++) {
          this.resR[i & this.mask] = this.micR[i & this.mask];
          this.echoR[i & this.mask] = 0;
        }
        this.done = this.n;
        return;
      }
      if (this.alignPos > this.done) {
        for (let i = this.done; i < this.alignPos; i++) {
          this.resR[i & this.mask] = this.micR[i & this.mask];
          this.echoR[i & this.mask] = 0;
        }
        this.done = this.alignPos;
      }
      // 2. predict the piano at the mic, block by block, as far as the reference allows
      const B = this.B;
      // both the mic samples and the reference they depend on must be in
      while (this.alignPos + B <= this.n && this.alignPos + B + this.pre - this.dUsed <= this.n - 2) {
        // follow clock drift between the two devices: the fitted trend, approached gently
        const diff = this.predictDelay(this.alignPos) - this.dUsed;
        const maxStep = (8 * B) / sr;
        this.dUsed += Math.abs(diff) <= maxStep ? diff : Math.sign(diff) * maxStep;
        this.dR[Math.floor(this.alignPos / B) & (this.dR.length - 1)] = this.dUsed;
        for (let i = 0; i < B; i++) this.xb[i] = this.refAt(this.alignPos + i + this.pre - this.dUsed);
        this.conv.process(this.xb, this.yb);
        for (let i = 0; i < B; i++) {
          const k = (this.alignPos + i) & this.mask;
          const e = this.solved ? this.yb[i] : 0;
          this.echoR[k] = e;
          this.resR[k] = this.micR[k] - e;
        }
        this.alignPos += B;
        this.done = this.alignPos;
        this.afterBlock(this.alignPos);
      }
    }
    /**
     * Keep the piano's audio lined up with the mic once the room is known: compare the mic
     * with the predicted piano around each onset. Lined up, they match at lag 0; clock drift
     * between the two devices shows up as a slowly growing lag, a glitch in either stream as
     * a sudden one.
     */
    follow() {
      const sr = this.sr;
      const Lr = this.rtrack.L;
      while (this.rq.length) {
        const o = this.rq[0];
        const s0 = Math.round(o + this.dUsed - 0.25 * Lr); // onset a quarter into the window
        if (s0 < this.n - this.cap + Lr || s0 < 0) {
          this.rq.shift();
          continue;
        }
        if (s0 + Lr > this.done) break; // not predicted that far yet
        this.rq.shift();
        const end = s0 + Lr;
        if (this.unlearnedAt(end, Lr)) continue; // the prediction is no good there
        const mic = this.copy(this.micR, end, this.tmpR || (this.tmpR = new Float32Array(Lr)));
        const echo = this.copy(this.echoR, end, this.tmpR2 || (this.tmpR2 = new Float32Array(Lr)));
        let ee = 0;
        for (let i = 0; i < Lr; i++) ee += echo[i] * echo[i];
        if (ee < 1e-8 * Lr) continue;
        const pk = this.rtrack.measure(mic, echo);
        const quiet = this.quietAt(s0) && this.quietAt(end - 1);
        const base = this.dR[Math.floor((o + this.dUsed) / this.B) & (this.dR.length - 1)] || this.dUsed;
        const at = o + base;
        const d = base + pk.lag;
        this.lastLag = pk.lag;
        if (pk.conf <= 10) continue;
        if (Math.abs(pk.lag) <= 3) {
          // lined up: follow the slow drift (while singing, only from clear windows)
          if (quiet || pk.conf > 16) this.addDrift(at, d);
          this.offBy = 0;
          if (this.lCount >= 30) this.goodL = [this.lMean, this.lVar];
          continue;
        }
        // Off by more than a few samples. One window can be fooled (a voice in unison with the
        // piano), so act when separate onsets agree: two quiet ones, or any three. "Agree"
        // allows for drift between them (up to 200 ppm).
        this.offBy = (this.offBy || 0) + 1;
        const near = (h) => Math.abs(h.d - d) <= 3 + 2e-4 * Math.abs(at - h.at);
        const recent = (this.lagHist || []).filter((h) => at - h.at < sr * 8 && near(h));
        this.lagHist = (this.lagHist || []).filter((h) => at - h.at < sr * 8).concat([{ at, d, quiet }]).slice(-8);
        const agree = recent.length + 1;
        const quietAgree = recent.filter((h) => h.quiet).length + (quiet ? 1 : 0);
        if (quietAgree >= 2 || agree >= 3) {
          // the streams really moved: re-align at once. The room itself hasn't changed, so
          // keep what was learned
          // the latest is the best guess of where it is now (it may be drifting)
          this.dUsed = d;
          this.dpts = recent.map((h) => [h.at, h.d]).concat([[at, d]]);
          this.lagHist = [];
          this.offBy = 0;
          this.realigns = (this.realigns || 0) + 1;
          // what was measured while misaligned says nothing about the room
          if (this.goodL) [this.lMean, this.lVar] = this.goodL;
        }
        this.delay = this.dUsed;
      }
    }
    addDrift(at, d) {
      if (!this.dpts) this.dpts = [];
      this.dpts.push([at, d]);
      if (this.dpts.length > 16) this.dpts.shift();
    }
    /** What was learned about the room, to start the next session from. */
    exportState() {
      if (!this.solved || !this.room.hc) return null;
      return { v: 2, sr: this.sr, delay: this.dUsed, hc: Float32Array.from(this.room.hc), lMean: this.lMean, lVar: this.lVar, keys: Array.from(this.keyLearn) };
    }
    /** Offer a saved room; it is used if the measured delay matches it (same setup). */
    importState(st) {
      if (!st || st.v !== 2 || st.sr !== this.sr || !st.hc || st.hc.length !== this.room.pre + this.room.Lh) return false;
      this.saved = st;
      return true;
    }
    useSaved() {
      const st = this.saved;
      this.room.hc = Float64Array.from(st.hc);
      this.room.solves = 1; // warm start: frequencies not heard again keep what was learned
      const h = new Float32Array(st.hc);
      this.conv.setFilter(h);
      this.solved = true;
      this.restored = true;
      if (st.keys) for (let p = 0; p < 128; p++) this.keyLearn[p] = Math.max(this.keyLearn[p], st.keys[p] || 0);
      if (st.lMean != null) {
        this.lMean = st.lMean;
        this.lVar = st.lVar;
        this.lCount = 30;
      }
    }
    /** Delay expected at mic index m: the trend of recent measurements (clock drift), else the last. */
    predictDelay(m) {
      const p = this.dpts || [];
      if (!p.length) return this.delay;
      if (p.length < 3 || p[p.length - 1][0] - p[0][0] < this.sr * 4) return p[p.length - 1][1];
      let sx = 0;
      let sy = 0;
      for (const [x, y] of p) {
        sx += x;
        sy += y;
      }
      const mx = sx / p.length;
      const my = sy / p.length;
      let sxy = 0;
      let sxx = 0;
      for (const [x, y] of p) {
        sxy += (x - mx) * (y - my);
        sxx += (x - mx) * (x - mx);
      }
      const slope = SF.clamp(sxx > 0 ? sxy / sxx : 0, -200e-6, 200e-6); // at most 200 ppm
      return my + slope * (m - mx);
    }
    afterBlock(end) {
      const sr = this.sr;
      const B = this.B;
      const Lw = this.room.Lw;
      if (this.solved && !this.offBy && this.quietAt(end - 1) && this.quietAt(end - B) && !this.unlearnedAt(end, B)) {
        let ee = 0;
        let er = 0;
        for (let i = end - B; i < end; i++) {
          const k = i & this.mask;
          ee += this.echoR[k] * this.echoR[k];
          er += this.resR[k] * this.resR[k];
        }
        this.echoPeak = Math.max(ee, (this.echoPeak || 0) * 0.999);
        // Only while the piano really plays: once it fades into the noise floor the ratio means nothing.
        const l = ee > 1e-8 * B && ee >= 0.03 * this.echoPeak && er > 0 ? 10 * Math.log10(er / ee) : null;
        // far more left than usual: someone is singing or talking over the chord. Skip it
        // (but not forever: a long run of it means the room itself changed)
        const odd = l != null && this.lCount >= 30 && l > this.lMean + 3 * Math.max(2, Math.sqrt(this.lVar));
        this.oddRun = odd ? (this.oddRun || 0) + 1 : 0;
        if (l != null && (!odd || this.oddRun > 60)) {
          if (!this.lCount) {
            this.lMean = l;
            this.lVar = 9;
          }
          this.lCount = (this.lCount || 0) + 1;
          const a = this.lCount < 30 ? 1 / this.lCount : 0.03;
          const d = l - this.lMean;
          this.lMean += a * d;
          this.lVar = (1 - a) * (this.lVar + a * d * d);
          this.echoQuiet = 1;
          this.resQuiet = Math.pow(10, this.lMean / 10);
        }
      }
      // 3. learn the room on quiet stretches where the piano plays
      if (!this.offBy && end - this.lastLearn >= Lw / 4 && end >= Lw && this.quietAt(end - 1) && this.quietAt(end - Lw) && this.quietAt(end - Lw / 2)) {
        this.lastLearn = end;
        // something besides the piano in a stretch of keys already learned (a voice over the
        // chord) would only blur what was learned: skip a few such stretches
        if (this.solved && this.lCount >= 30 && !this.unlearnedAt(end, Lw)) {
          let ee = 0;
          let er = 0;
          for (let i = end - Lw; i < end; i++) {
            const k = i & this.mask;
            ee += this.echoR[k] * this.echoR[k];
            er += this.resR[k] * this.resR[k];
          }
          const odd = ee > 1e-8 * Lw && er > ee * Math.pow(10, (this.lMean + 10) / 10);
          this.oddLearn = odd ? (this.oddLearn || 0) + 1 : 0;
          if (odd && this.oddLearn <= 8) return;
          if (odd) this.oddLearn = 0;
        }
        const m = this.copy(this.micR, end, this.tmpW);
        const r = this.tmpW2;
        for (let i = 0; i < Lw; i++) r[i] = this.refAt(end - Lw + i - this.dUsed);
        if (this.room.learn(m, r)) {
          this.learnKeys(end - Lw - this.dUsed, end - this.dUsed);
          this.learnedSec += Lw / 4 / sr;
          if (!this.solved || end - this.lastSolve >= sr * 1.0) {
            const h = this.room.solve();
            if (h) {
              this.conv.setFilter(h);
              this.lastSolve = end;
              this.solved = true;
            }
          }
        }
      }
    }
    reset() {
      this.tracker.reset();
      this.room.reset();
      this.rq = [];
      this.lagHist = [];
      this.offBy = 0;
      this.conv = new Convolver(this.B);
      this.delay = null;
      this.dUsed = null;
      this.solved = false;
      this.learnedSec = 0;
      this.echoQuiet = 0;
      this.resQuiet = 0;
      this.lCount = 0;
      this.echoPeak = 0;
      this.keyLearn.fill(0);
      this.restored = false;
      this.alignPos = this.n;
      this.done = this.n;
    }
  }

  /**
   * One analysis frame ending at index end (<= pf.done): the pitch of what is left after
   * cancelling, and whether a voice is really there.
   */
  function analyzeFrame(pf, tracker, end, t, opts) {
    opts = opts || {};
    const W = tracker.size;
    if (!analyzeFrame.buf || analyzeFrame.buf.length !== W) analyzeFrame.buf = new Float32Array(W);
    const buf = analyzeFrame.buf;
    let em = 0;
    let ee = 0;
    let er = 0;
    for (let i = 0; i < W; i++) {
      const k = (end - W + i) & pf.mask;
      const r = pf.resR[k];
      buf[i] = r;
      er += r * r;
      em += pf.micR[k] * pf.micR[k];
      ee += pf.echoR[k] * pf.echoR[k];
    }
    const fr = tracker.process(buf, t);
    const db = (x) => (x > 0 ? 10 * Math.log10(x / W) : -120);
    fr.micDb = db(em);
    fr.echoDb = db(ee);
    fr.source = 'mic';
    if (!pf.ready) {
      // The piano is connected but its sound can't be removed yet: while it plays (or
      // rings on into the mic) nothing is believed, so it can't sing notes for you.
      if (pf.hasRef && pf.refPeak(end - W - pf.tracker.maxLag, end) > (opts.refFloor || 1e-7)) {
        fr.voiced = false;
        fr.midi = null;
        fr.source = 'learning';
      }
      return fr;
    }
    if (pf.unlearnedAt(end, W) || pf.offBy >= 2) {
      // a key the room hasn't been learned for: calibrating teaches it every key
      fr.voiced = false;
      fr.midi = null;
      fr.source = 'learning';
      return fr;
    }
    if (ee < 1e-9 * W) {
      noteVoice(pf, fr, er, W); // no piano to remove here
      return fr;
    }
    const expected = ee * Math.max(pf.leftover, 0.002);
    fr.presence = er / expected;
    fr.source = 'filtered';
    // the leftover is measured on the chords, which it hears all the time; a key heard only a
    // few times (in the calibration run) is cancelled less well, so ask for more there
    const margin = (opts.margin || 4) * (pf.leastLearned(end, W) < 8 ? 2 : 1);
    if (er < margin * expected) {
      fr.voiced = false;
      fr.midi = null;
      // Nothing above the piano's leftover. That means "not singing" only if the singer's
      // usual level would have stood out; if what is left of the piano is about as loud
      // as the voice, it can't tell, and says so rather than mark you silent.
      const needDb = db(margin * expected);
      const voiceDb = pf.voiceDb != null ? pf.voiceDb : opts.voiceDb || -35;
      fr.source = needDb > voiceDb - 3 ? 'unsure' : 'piano';
    } else noteVoice(pf, fr, er, W);
    return fr;
  }
  /** Keep a running idea of how loud the singer is at the mic. */
  function noteVoice(pf, fr, er, W) {
    if (!fr.voiced || !(er > 0)) return;
    const d = 10 * Math.log10(er / W);
    pf.voiceDb = pf.voiceDb == null ? d : pf.voiceDb + 0.01 * (d - pf.voiceDb);
  }

  SF.DelayTracker = DelayTracker;
  SF.RoomModel = RoomModel;
  SF.Convolver = Convolver;
  SF.PianoFilter = PianoFilter;
  SF.analyzeFrame = analyzeFrame;
});
