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
    /** Add one window to a running sum of (whitened) cross-spectra: in a room where the piano
     *  reaches the mic mostly by reflections no single window is clear, but together they are. */
    accumulate(mic, ref) {
      this.spectrum(mic, ref);
      const N = this.N;
      if (!this.accR) {
        this.accR = new Float64Array(N);
        this.accI = new Float64Array(N);
        this.accN = 0;
      }
      for (let k = 0; k < N; k++) {
        const m = Math.hypot(this.cr[k], this.ci[k]) + 1e-20;
        this.accR[k] += this.cr[k] / m;
        this.accI[k] += this.ci[k] / m;
      }
      this.accN++;
      this.cr.set(this.accR);
      this.ci.set(this.accI);
      return this.peak();
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
      this.accR = null;
      this.accN = 0;
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
      // taps before the main delay: slack for a delay measured a little late (when the mic
      // hears the piano mostly by reflections, the strongest of them can pass for it)
      this.pre = opts.pre || 256;
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
    /** What was measured, to carry on from next session (the response alone isn't enough: re-solved
     *  from a few new chords without it, it drifts from what the calibration found). */
    exportStats() {
      return this.updates ? { K: this.K, Sr: Float32Array.from(this.Sr), Si: Float32Array.from(this.Si), Srr: Float32Array.from(this.Srr), updates: this.updates } : null;
    }
    importStats(st) {
      if (!st || st.K !== this.K || !st.Sr || st.Sr.length !== this.K) return false;
      this.Sr.set(st.Sr);
      this.Si.set(st.Si);
      this.Srr.set(st.Srr);
      this.updates = st.updates || 1;
      return true;
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
      // How the piano is tuned (cents from equal temperament), read from its own audio when
      // a key sounds alone: a pitch well away from every note it plays can't be its leftover.
      this.tune = new Float32Array(128);
      this.tuneN = new Uint16Array(128);
      this.gTune = 0;
      this.gTuneN = 0;
      // the echo's envelope (the room rings on after the predicted piano stops), and how much
      // of it is left after cancelling, per analysis frame, while nobody sings (dB)
      this.env = 0;
      this.envEnd = 0;
      this.envPeak = 0;
      this.fCount = 0;
      this.fMean = 0;
      this.fVar = 0;
      this.vref = null; // the last frame believed to be the voice: {end, midi}
      // the same per key, from frames where it sounds alone (the calibration run plays each
      // key on its own): rooms leave much more of some notes than of others
      this.kMean = new Float32Array(128);
      this.kN = new Uint16Array(128);
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
    /** The keys sounding into the mic frame ending at end: held, or released less than
     *  RING seconds before (they ring on into the room). */
    soundingKeys(end, W) {
      const d = this.dUsed || 0;
      const e1 = end - d;
      const e0 = end - W - d - this.sr * SOUNDING_RING;
      const out = [];
      for (const k of this.keys) if (k.i0 <= e1 && k.i1 >= e0 && out.indexOf(k.p) < 0) out.push(k.p);
      return out;
    }
    /** The pitch the piano really sounds for key p (MIDI, fractional). */
    pianoPitch(p) {
      return p + (this.tuneN[p] ? this.tune[p] : this.gTune) / 100;
    }
    /** When one key sounds alone (past its attack), read its pitch from the piano's own audio. */
    learnTuning(det, end, W) {
      const d = this.dUsed || 0;
      const e1 = end - d;
      const e0 = e1 - W;
      if (e0 < 0 || e0 <= this.n - this.cap) return;
      let only = null;
      for (const k of this.keys) {
        if (k.i0 > e1 || k.i1 < e0 - this.sr * 0.3) continue;
        if (only) return; // more than one
        only = k;
      }
      if (!only || only.i0 > e0 - this.sr * 0.08 || only.i1 < e1) return;
      const buf = this.tuneBuf || (this.tuneBuf = new Float32Array(W));
      for (let i = 0; i < W; i++) buf[i] = this.refR[(e0 + i) & this.mask];
      const r = lowPitch(this, buf, W);
      if (!(r && r.clarity >= 0.9)) return;
      const c = (r.midi - only.p) * 100;
      if (Math.abs(c) > 50) return;
      const p = only.p;
      this.tuneN[p] = Math.min(this.tuneN[p] + 1, 1000);
      this.tune[p] += (c - this.tune[p]) / Math.min(this.tuneN[p], 20);
      this.gTuneN = Math.min(this.gTuneN + 1, 1000);
      this.gTune += (c - this.gTune) / Math.min(this.gTuneN, 50);
    }
    /** The echo's envelope for the frame ending at end: its energy now, or what is still
     *  ringing in the room from just before (an energy time constant of TAIL seconds). */
    envelope(ee, end) {
      const dt = end - this.envEnd;
      this.env = Math.max(ee, dt > 0 ? this.env * Math.exp(-dt / (this.sr * TAIL)) : this.env);
      this.envEnd = Math.max(end, this.envEnd);
      this.envPeak = Math.max(this.env, this.envPeak * Math.exp(-Math.max(0, dt) / (this.sr * 20)));
      return this.env;
    }
    /** How much of the piano is left after cancelling, from a frame where nobody sings
     *  (false: far more than usual is left, someone sings over it, so it wasn't counted). */
    noteLeftover(rDb) {
      // far more left than usual: someone is singing or talking over it. Skip it (but not
      // forever: a long run of it means the room itself changed)
      const odd = this.fCount >= 30 && rDb > this.fMean + 3 * Math.max(2, Math.sqrt(this.fVar));
      this.fOdd = odd ? (this.fOdd || 0) + 1 : 0;
      if (odd && this.fOdd <= 120) return false;
      this.fCount++;
      if (this.fCount === 1) {
        this.fMean = rDb;
        this.fVar = 9;
        return true;
      }
      const a = this.fCount < 50 ? 1 / this.fCount : 0.02;
      const d = rDb - this.fMean;
      this.fMean += a * d;
      this.fVar = (1 - a) * (this.fVar + a * d * d);
      return true;
    }
    /** The key sounding alone through the mic frame ending at end (others released at least
     *  120 ms before it), or null. */
    soloKey(end, W) {
      const d = this.dUsed || 0;
      const e1 = end - d;
      const e0 = end - W - d;
      let solo = null;
      for (const k of this.keys) {
        if (k.i1 <= e0 - this.sr * 0.12 || k.i0 > e1) continue;
        if (solo || !(k.i0 <= e0 - this.sr * 0.02 && k.i1 >= e1)) return null;
        solo = k;
      }
      return solo ? solo.p : null;
    }
    /** Per key, kept as how much more (or less) is left of it than of the room as a whole
     *  at the time: the room changes (people move, the lid, the volume), its keys with it. */
    noteKeyLeftover(p, rDb) {
      if (this.fCount < 10) return;
      const off = rDb - this.fMean;
      if (off > 3 * Math.max(3, Math.sqrt(this.fVar)) + 9) return; // a voice over it
      this.kN[p] = Math.min(this.kN[p] + 1, 1000);
      this.kMean[p] += (off - this.kMean[p]) / Math.min(this.kN[p], 20);
    }
    /**
     * How the piano reaches the mic, stretch by stretch of piano with nobody singing (the
     * reference chords). A mic that changes its own volume or sound as you sing (Windows'
     * microphone effects: automatic volume, noise suppression, aiming at the voice) shows as
     * the same piano arriving much louder or quieter from one chord to the next, and as a
     * filter that can't remove much of it; no room does that.
     */
    trackRuns(end) {
      const B = this.B;
      const quiet = this.quietAt(end - 1);
      const d = Math.round(this.dUsed || 0);
      let em = 0;
      let ex = 0;
      let er = 0;
      for (let i = end - B; i < end; i++) {
        const k = i & this.mask;
        em += this.micR[k] * this.micR[k];
        er += this.resR[k] * this.resR[k];
        const x = this.refR[(i - d) & this.mask];
        ex += x * x;
      }
      if (quiet && ex > 1e-8 * B) {
        const r = this.run || (this.run = { em: 0, ex: 0, er: 0, n: 0, solved: this.solved && !this.offBy });
        r.em += em;
        r.ex += ex;
        r.er += er;
        r.n++;
        r.solved = r.solved && this.solved && !this.offBy;
        return;
      }
      if (quiet) return; // the piano is silent: the stretch may go on
      const r = this.run;
      this.run = null;
      if (!r || r.n < 20 || !(r.em > 0) || !(r.ex > 0)) return;
      const runs = this.runs || (this.runs = []);
      runs.push({ at: end, levelDb: 10 * Math.log10(r.em / r.ex), cancelDb: r.solved && r.er > 0 ? 10 * Math.log10(r.em / r.er) : null });
      while (runs.length > 8 || (runs.length && end - runs[0].at > this.sr * 90)) runs.shift();
      // a room taken over from last time: keep it only if it removes the piano now (judged on
      // three chords; if it can't even be lined up with the mic over six, it doesn't fit either)
      if (this.trial) {
        this.trial.runs++;
        const c = this.recentCancel;
        const bad = (c != null && this.trial.runs >= 3 && c < 3) || (c == null && this.trial.runs >= 6);
        if (bad) {
          this.reset();
          this.dropped = (this.dropped || 0) + 1;
        } else if (c != null && this.trial.runs >= 3) this.trial = null;
      }
    }
    /** How much the piano's level at the mic moved between recent chords (dB). */
    get micDrift() {
      const r = (this.runs || []).slice(-6);
      if (r.length < 3) return 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of r) {
        lo = Math.min(lo, x.levelDb);
        hi = Math.max(hi, x.levelDb);
      }
      return hi - lo;
    }
    /** How much of the piano the filter removed over the last few chords (dB), or null. */
    get recentCancel() {
      const r = (this.runs || []).filter((x) => x.cancelDb != null).slice(-3);
      return r.length >= 2 ? SF.median(r.map((x) => x.cancelDb)) : null;
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
      // Every quiet stretch of piano also adds to a running sum, which settles the delay where
      // no single window is clear enough (a room where reflections reach the mic first).
      let accD = null;
      if (this.delay == null && this.n - (this.lastAcc || -Infinity) >= sr * 0.25 && this.n >= L && quietWin && this.refPeak(this.n - L, this.n) > 1e-7) {
        this.lastAcc = this.n;
        const pk = this.tracker.accumulate(this.copy(this.micR, this.n, this.tmpL), this.copy(this.refR, this.n, this.tmpL2));
        // a fallback only: where single windows are clear they settle it first, and better
        if (this.tracker.accN >= 8 && pk.conf >= 8 && !this.tracker.history.length) accD = pk.lag;
      }
      if (accD != null || (!this.solved && this.n - this.lastGcc >= sr * 0.08 && this.n >= L && struck && quietWin)) {
        this.lastGcc = this.n;
        const d = accD != null ? accD : this.tracker.add(this.copy(this.micR, this.n, this.tmpL), this.copy(this.refR, this.n, this.tmpL2), false);
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
      return {
        v: 2,
        sr: this.sr,
        delay: this.dUsed,
        hc: Float32Array.from(this.room.hc),
        lMean: this.lMean,
        lVar: this.lVar,
        keys: Array.from(this.keyLearn),
        fMean: this.fCount >= 30 ? this.fMean : null,
        fVar: this.fVar,
        kOff: Array.from(this.kMean),
        kN: Array.from(this.kN),
        tune: Array.from(this.tune),
        tuneN: Array.from(this.tuneN),
        gTune: this.gTune,
        spec: this.spec ? this.spec.exportState() : null,
        stats: this.room.exportStats(),
      };
    }
    /** Offer a saved room; it is used if the measured delay matches it (same setup). */
    importState(st) {
      if (!st || st.v !== 2 || st.sr !== this.sr || !st.hc || st.hc.length !== this.room.pre + this.room.Lh) return false;
      this.saved = st;
      if (this.delay == null && st.delay != null) {
        // Same inputs as last time: start from what was learned then, at once (the delay need
        // not be measured again first). If it no longer fits (the laptop moved, the volume
        // changed), the next few chords show it and it is dropped.
        this.dUsed = this.delay = st.delay;
        this.alignPos = Math.max(this.done, this.n);
        this.dpts = [];
        this.useSaved();
        this.saved = null;
        this.trial = { runs: 0 };
      }
      return true;
    }
    useSaved() {
      const st = this.saved;
      this.room.hc = Float64Array.from(st.hc);
      this.room.solves = 1; // warm start: frequencies not heard again keep what was learned
      this.statsRestored = this.room.importStats(st.stats);
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
      if (st.fMean != null) {
        this.fMean = st.fMean;
        this.fVar = st.fVar;
        this.fCount = 30;
      }
      if (st.kOff && st.kN) {
        for (let p = 0; p < 128; p++) {
          this.kMean[p] = st.kOff[p] || 0;
          this.kN[p] = Math.min(st.kN[p] || 0, 20);
        }
      }
      if (st.tune && st.tuneN) {
        for (let p = 0; p < 128; p++) {
          this.tune[p] = st.tune[p] || 0;
          this.tuneN[p] = Math.min(st.tuneN[p] || 0, 20);
        }
        this.gTune = st.gTune || 0;
        this.gTuneN = 20;
      }
      if (st.spec && st.spec.num) {
        this.spec = new LeftoverSpectrum(this.sr, (st.spec.num.length - 1) * 2);
        this.spec.importState(st.spec);
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
      this.trackRuns(end);
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
          // A room saved from last time is kept as it is until a few stretches have been heard
          // again: re-solving it from the first one alone (often the attack of a single chord)
          // leaves it predicting the piano several dB too quiet for a while.
          const fresh = !this.restored || this.statsRestored || this.room.updates >= 8;
          if (!this.solved || (fresh && end - this.lastSolve >= sr * 1.0)) {
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
      this.fCount = 0;
      this.kN.fill(0);
      this.runs = [];
      this.run = null;
      this.trial = null;
      this.lastAcc = -Infinity;
      this.vref = null;
      this.vsure = null;
      this.spec = null;
      this.restored = false;
      this.statsRestored = false;
      this.alignPos = this.n;
      this.done = this.n;
    }
  }

  // ------------------------------------------------------------ the leftover, frequency by frequency
  const SPEC_TAU = 0.6; // s: how long the piano's leftover can go on ringing at a frequency
  const SPEC_FORGET = 1 / 3000; // per quiet frame: the picture follows a room that changes
  const HARM_DB = 8; // a harmonic of the voice: this far above what the piano usually leaves there
  const HARM_MAX_HZ = 4000;
  const HARM_MIN = 5; // harmonics that must stand out to call it the voice
  const HARM_KEY = 8; // ... and this far above what the same key itself leaves there, when known
  const HOLD_HARM = 3; // enough to go on believing a voice surely heard a moment before
  const NH = 16;

  /**
   * What the room filter leaves of the piano, frequency by frequency. The leftover is much
   * larger at some frequencies than at others (a room resonance, a note the room colours), but
   * at each it follows the predicted piano there: learned while nobody sings, as a ratio per
   * frequency, it says how much piano to expect in each band of a frame. A voice on the very
   * note the piano plays then still shows: its harmonics stand far above that at several
   * frequencies, while the piano's own leftover only ever reaches it here and there.
   * The same picture cleans up what is left, for listening (the lab).
   */
  class LeftoverSpectrum {
    constructor(sr, W) {
      this.sr = sr;
      this.W = W;
      this.bins = W / 2 + 1;
      this.fft = new SF.FFT(W);
      this.win = new Float64Array(W);
      for (let i = 0; i < W; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W);
      this.rr = new Float64Array(W);
      this.ri = new Float64Array(W);
      this.er = new Float64Array(W);
      this.ei = new Float64Array(W);
      this.R = new Float64Array(this.bins); // the leftover now (power)
      this.E = new Float64Array(this.bins); // the predicted piano, with its ring
      this.num = new Float64Array(this.bins); // leftover / piano while nobody sings
      this.den = new Float64Array(this.bins);
      this.floor = new Float64Array(this.bins).fill(Infinity); // the room's noise
      // per key and partial: how much more of it is left than the picture above expects (dB),
      // from frames where the key sounds alone (the calibration plays each key on its own)
      this.kx = new Float32Array(128 * NH);
      this.kxN = new Uint16Array(128);
      this.n = 0;
      this.end = null;
      this.postEnd = null;
    }
    get ready() {
      return this.n >= 150;
    }
    frame(pf, end) {
      const W = this.W;
      const m = pf.mask;
      const { rr, ri, er, ei, win } = this;
      for (let i = 0; i < W; i++) {
        const k = (end - W + i) & m;
        rr[i] = pf.resR[k] * win[i];
        er[i] = pf.echoR[k] * win[i];
      }
      ri.fill(0);
      ei.fill(0);
      this.fft.transform(rr, ri);
      this.fft.transform(er, ei);
      const dt = this.end == null ? 0 : end - this.end;
      const decay = dt > 0 ? Math.exp(-dt / (this.sr * SPEC_TAU)) : 1;
      const rise = dt > 0 ? Math.pow(1.0002, dt / 512) : 1;
      const tiny = 1e-14 * W;
      for (let b = 0; b < this.bins; b++) {
        const r = rr[b] * rr[b] + ri[b] * ri[b];
        const e = er[b] * er[b] + ei[b] * ei[b];
        this.R[b] = r;
        this.E[b] = Math.max(e, this.E[b] * decay);
        this.floor[b] = Math.max(tiny, Math.min(r, this.floor[b] * rise));
      }
      if (dt > 0 || this.end == null) this.end = end;
    }
    /** A frame where nobody sings and the piano plays. */
    learn() {
      const a = this.n < 1 / SPEC_FORGET ? 1 / (this.n + 1) : SPEC_FORGET;
      for (let b = 0; b < this.bins; b++) {
        this.num[b] += a * (this.R[b] - this.num[b]);
        this.den[b] += a * (this.E[b] - this.den[b]);
      }
      this.n++;
    }
    /** How much piano to expect in bin b of this frame (power). */
    expected(b) {
      const lo = Math.max(0, b - 1);
      const hi = Math.min(this.bins - 1, b + 1);
      let nu = 0;
      let de = 0;
      for (let j = lo; j <= hi; j++) {
        nu += this.num[j];
        de += this.den[j];
      }
      return de > 0 ? (nu / de) * this.E[b] : 0;
    }
    /** At harmonic h of f0 (Hz): the leftover now, the piano expected there, the noise floor (power). */
    at(f0, h) {
      const c = Math.round((h * f0 * this.W) / this.sr);
      if (c < 2 || c >= this.bins - 1) return null;
      let r = 0;
      let ex = 0;
      let fl = 0;
      for (let b = c - 1; b <= c + 1; b++) {
        r = Math.max(r, this.R[b]);
        ex = Math.max(ex, this.expected(b));
        fl = Math.max(fl, this.floor[b]);
      }
      return { r, ex, fl };
    }
    /** Key p (sounding at pitch midi) is the only one sounding, with nobody singing. */
    learnKey(p, midi) {
      if (!this.ready) return;
      const f0 = 440 * Math.pow(2, (midi - 69) / 12);
      this.kxN[p] = Math.min(this.kxN[p] + 1, 1000);
      const a = 1 / Math.min(this.kxN[p], 30);
      for (let h = 1; h <= NH; h++) {
        const v = h * f0 <= HARM_MAX_HZ ? this.at(f0, h) : null;
        if (!v || !(v.ex > 0)) continue;
        const x = SF.clamp(10 * Math.log10(Math.max(v.r, 1e-30) / v.ex), -20, 40);
        const i = p * NH + h - 1;
        this.kx[i] += a * (x - this.kx[i]);
      }
    }
    /**
     * How many harmonics of the pitch midi (up to 16, below 4 kHz) stand far above the piano's
     * leftover. keys: the keys sounding, [{p, m}] (m: the pitch it really sounds). Where a
     * harmonic falls on a partial of one of them, it must also stand well above what that key
     * itself was found to leave there.
     */
    harmonics(midi, keys) {
      if (!this.ready || midi == null) return 0;
      const f0 = 440 * Math.pow(2, (midi - 69) / 12);
      if (f0 < (3 * this.sr) / this.W) return 0; // harmonics closer than the bins can tell apart
      const k = Math.pow(10, HARM_DB / 10);
      let n = 0;
      for (let h = 1; h <= NH && h * f0 <= HARM_MAX_HZ; h++) {
        const v = this.at(f0, h);
        if (!v) continue;
        let need = k * v.ex;
        for (const key of keys || []) {
          // the key's partial j on the same frequency (within a third of a semitone)
          const fk = 440 * Math.pow(2, (key.m - 69) / 12);
          const j = Math.round((h * f0) / fk);
          if (j < 1 || j > NH || Math.abs(12 * Math.log2((h * f0) / (j * fk))) > 0.33) continue;
          const xs = this.kxN[key.p] >= 5 ? this.kx[key.p * NH + j - 1] : 6;
          need = Math.max(need, v.ex * Math.pow(10, (xs + HARM_KEY) / 10));
        }
        if (v.r > need && v.r > 100 * v.fl) n++;
      }
      return n;
    }
    /** Clean up the frame (take out the piano's expected leftover, times over) and overlap-add it into out. */
    clean(end, out, mask, over) {
      const W = this.W;
      const { rr, ri, win } = this;
      const on = this.ready;
      const k = over || 2;
      for (let b = 0; b < this.bins; b++) {
        let g = 1;
        if (on && this.R[b] > 0) g = Math.min(1, Math.max(0.03, 1 - (k * this.expected(b)) / this.R[b]));
        rr[b] *= g;
        ri[b] *= g;
        if (b > 0 && b < W / 2) {
          rr[W - b] *= g;
          ri[W - b] *= g;
        }
      }
      this.fft.inverse(rr, ri);
      const from = this.postEnd == null ? end - W : Math.max(end - W, this.postEnd);
      for (let i = from; i < end; i++) out[i & mask] = 0;
      for (let i = 0; i < W; i++) out[(end - W + i) & mask] += (rr[i] * win[i]) / 1.5; // Hann² at a quarter hop sums to 1.5
      this.postEnd = end;
    }
    exportState() {
      if (!this.ready) return null;
      return { n: Math.min(this.n, 1 / SPEC_FORGET), num: Float32Array.from(this.num), den: Float32Array.from(this.den), kx: Float32Array.from(this.kx), kxN: Array.from(this.kxN, (x) => Math.min(x, 30)) };
    }
    importState(st) {
      if (!st || !st.num || st.num.length !== this.bins) return;
      this.num = Float64Array.from(st.num);
      this.den = Float64Array.from(st.den);
      this.n = st.n;
      if (st.kx && st.kx.length === this.kx.length && st.kxN) {
        this.kx.set(st.kx);
        for (let p = 0; p < 128; p++) this.kxN[p] = st.kxN[p] || 0;
      }
    }
  }

  /**
   * The whole of a take cleaned up with what the filter learned by its end (spec): for
   * listening to what is left of the piano once the room is known. res, echo: what was left
   * after the room filter, and the predicted piano.
   */
  function cleanUp(spec, res, echo, over) {
    const n = res.length;
    const P = pow2(n + spec.W);
    const fake = { resR: new Float32Array(P), echoR: new Float32Array(P), mask: P - 1 };
    fake.resR.set(res);
    fake.echoR.set(echo);
    const sp = new LeftoverSpectrum(spec.sr, spec.W);
    sp.importState(spec.exportState());
    const out = new Float32Array(P);
    const H = spec.W / 4;
    for (let end = spec.W; end <= n + spec.W; end += H) {
      sp.frame(fake, end);
      sp.clean(end, out, P - 1, over);
    }
    return out.subarray(0, n);
  }

  const RING = 0.5; // seconds a released key still rings into the mic
  const SOUNDING_RING = 0.3; // ... loud enough to read as one of the piano's pitches
  const TAIL = 0.08; // energy time constant of the room's ring after the piano stops (s)
  const DEV = 0.3; // semitones: a pitch this far from every note the piano plays isn't its leftover

  /**
   * The pitch of the low band of a window (below about 1 kHz), or null. Piano strings'
   * overtones are stretched, and what is left of the piano after cancelling is mostly its
   * high ones, which read sharp; down here they are barely stretched, and the voice is strong.
   */
  function lowPitch(pf, src, W) {
    if (!pf.lowDet || pf.lowDet.W !== W) {
      pf.lowDet = new SF.PitchDetector(pf.sr, W);
      pf.lowBuf = new Float32Array(W);
      // 2nd-order Butterworth low-pass, run forward and back (no phase shift)
      const w = Math.tan((Math.PI * 1000) / pf.sr);
      const q = Math.SQRT2;
      const n = 1 / (1 + q * w + w * w);
      pf.lowK = [w * w * n, 2 * w * w * n, w * w * n, 2 * (w * w - 1) * n, (1 - q * w + w * w) * n];
    }
    const [b0, b1, b2, a1, a2] = pf.lowK;
    const y = pf.lowBuf;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < W; i++) {
      const x = src[i];
      const v = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = v;
      y[i] = v;
    }
    x1 = x2 = y1 = y2 = 0;
    for (let i = W - 1; i >= 0; i--) {
      const x = y[i];
      const v = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = v;
      y[i] = v;
    }
    const r = pf.lowDet.detect(y);
    return r.freq > 0 ? { midi: SF.hzToMidi(r.freq), clarity: r.clarity } : null;
  }

  /** Does m (in any octave) lie between two of the pitches ps that are under 2.5 semitones apart? */
  function between(m, ps) {
    const pc = (x) => (((x % 12) + 12) % 12);
    const c = pc(m);
    let below = Infinity;
    let above = Infinity;
    for (const p of ps) {
      const d = pc(p) - c;
      const up = ((d % 12) + 12) % 12; // semitones up to p
      const down = (12 - up) % 12; // semitones down to p
      if (up > 0 && up < above) above = up;
      if (down > 0 && down < below) below = down;
    }
    return above + below < 2.5;
  }

  /** Distance in semitones (0..6) from midi to the nearest of the pitches ps, in any octave. */
  function pcDist(m, ps) {
    let best = Infinity;
    for (const p of ps) {
      let d = (m - p) % 12;
      if (d < 0) d += 12;
      if (d > 6) d = 12 - d;
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * One analysis frame ending at index end (<= pf.done): the pitch of what is left after
   * cancelling, and whether it is the voice.
   *
   * The piano's leftover can only ever have the piano's pitches. So a clear pitch well away
   * from every note the piano is sounding (DEV, in any octave) is the voice, however much
   * piano is left. Only on the very note the piano plays does it come down to loudness:
   * then the voice must stand out from what is usually left of the piano (measured while
   * nobody sings), clearly to be believed, a little to go on being believed while it holds
   * the pitch it was just heard on.
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
    fr.resDb = db(er);
    fr.source = 'mic';
    let spec = null;
    if (pf.hasRef) {
      spec = pf.spec && pf.spec.W === W ? pf.spec : (pf.spec = new LeftoverSpectrum(pf.sr, W));
      spec.frame(pf, end);
      if (pf.postR) spec.clean(end, pf.postR, pf.mask);
    }
    if (!pf.hasRef) {
      noteVoice(pf, fr, er, W, end);
      return fr;
    }
    // how the piano is tuned, from its own audio (now and then: it doesn't change)
    if ((pf.tuneTick = (pf.tuneTick || 0) + 1) % 4 === 0) pf.learnTuning(null, end, W);
    const env = pf.envelope(ee, end);
    const sounding = pf.soundingKeys(end, W);
    const pianoOn = pf.ready ? env > 1e-9 * W : pf.refPeak(end - W - pf.tracker.maxLag, end) > (opts.refFloor || 1e-7);
    if (!pianoOn) {
      noteVoice(pf, fr, er, W, end); // no piano to remove here
      return fr;
    }
    if (pf.ready) fr.source = 'filtered';
    if (!pf.ready || pf.unlearnedAt(end, W) || pf.offBy >= 2) {
      // keys the room hasn't been learned for (or the alignment is in doubt): the piano could
      // be singing any of it. Calibrating teaches every key.
      fr.voiced = false;
      fr.midi = null;
      fr.source = 'learning';
      return fr;
    }
    // what is left, against the usual leftover of the piano heard just now (dB)
    const rDb = er > 0 && env > 0 ? 10 * Math.log10(er / env) : -120;
    const quiet = pf.quietAt(end - 1) && pf.quietAt(end - W);
    if (quiet && env >= 1e-8 * W && env >= 0.03 * pf.envPeak) {
      const counted = pf.noteLeftover(rDb);
      if (counted && spec) spec.learn();
      const solo = pf.soloKey(end, W);
      if (solo != null) {
        pf.noteKeyLeftover(solo, rDb);
        if (counted && spec) spec.learnKey(solo, pf.pianoPitch(solo));
      }
    }
    let mu;
    let sd;
    if (pf.fCount >= 30) {
      mu = pf.fMean;
      sd = Math.sqrt(Math.max(0, pf.fVar));
    } else {
      // not enough heard yet: the block measurements, already on the high side
      mu = 10 * Math.log10(Math.max(pf.leftover, 0.002));
      sd = 3;
    }
    // The usual leftover of the keys sounding now: measured key by key where it was (the
    // worst of them counts); else the room's, a little higher for a key heard only a few
    // times (in the calibration run), which is cancelled less well.
    let muK = -Infinity;
    for (const p of sounding) {
      // (a key not measured on its own may be one the room leaves much more of: careful)
      const m = pf.kN[p] >= 6 ? mu + Math.max(pf.kMean[p], -4) : mu + 6;
      if (m > muK) muK = m;
    }
    if (muK === -Infinity) muK = mu + (pf.leastLearned(end, W) < 8 ? 3 : 0);
    const strongDb = muK + SF.clamp(3 * sd, 8, 12);
    const weakDb = muK + SF.clamp(2 * sd, 4, 8);
    fr.presence = Math.pow(10, (rDb - muK) / 10);
    if (fr.voiced && sounding.length) {
      // A pitch the piano isn't playing: its leftover can't make that, so it's the voice,
      // provided the reading is clean (the low band agrees, clear, at least as loud as the
      // usual leftover) and not between two notes the piano sounds close together, where two
      // of its own sounds mixed can read.
      // (judged on the low band when it agrees with the full reading: there the piano's
      // leftover reads true, while its stretched high overtones pull the full reading sharp)
      const ps = sounding.map((p) => pf.pianoPitch(p));
      const low = fr.clarity >= 0.85 ? lowPitch(pf, buf, W) : null;
      const agree = low && low.clarity >= 0.9 && Math.abs((((low.midi - fr.midi + 6) % 12) + 12) % 12 - 6) <= 0.35;
      const dev = pcDist(agree ? low.midi : fr.midi, ps);
      fr.dev = dev;
      if (dev >= DEV) {
        if (agree && fr.clarity >= 0.9 && rDb >= muK + 3 && (rDb >= weakDb || !between(low.midi, ps))) {
          fr.why = 'other pitch';
          noteVoice(pf, fr, er, W, end, true);
          return fr;
        }
        fr.voiced = false;
        fr.midi = null;
        fr.source = 'unsure';
        return fr;
      }
    }
    // A held piano note reads dead steady (to a cent, perfectly clear); a voice wavers a
    // little. Steady as a machine on the piano's own note: ask for much more before
    // believing it is you.
    const raws = pf.raws || (pf.raws = []);
    if (fr.voiced && fr.raw != null && (!raws.length || end - raws[raws.length - 1].end <= 600)) raws.push({ end, m: fr.raw });
    else raws.length = 0;
    if (raws.length > 6) raws.shift();
    let machine = false;
    if (fr.voiced && raws.length === 6 && fr.clarity >= 0.985) {
      let m = 0;
      for (const r of raws) m += r.m;
      m /= 6;
      let v = 0;
      for (const r of raws) v += (r.m - m) * (r.m - m);
      machine = Math.sqrt(v / 6) * 100 < 1.2;
    }
    const extra = machine ? 6 : 0;
    if (fr.voiced) {
      if (rDb >= strongDb + extra) {
        fr.why = 'louder than the piano';
        noteVoice(pf, fr, er, W, end, true);
        return fr;
      }
      // quieter than the piano overall, but its own harmonics stand out from the piano's
      // leftover at several frequencies: a voice (the piano's leftover only reaches that here
      // and there)
      const hn = spec ? spec.harmonics(fr.midi, sounding.map((p) => ({ p, m: pf.pianoPitch(p) }))) : 0;
      fr.harm = hn;
      if (hn >= HARM_MIN + (machine ? 2 : 0)) {
        fr.why = 'its own harmonics';
        noteVoice(pf, fr, er, W, end, true);
        return fr;
      }
      // still the voice heard a moment ago, on the same pitch: a little above the piano, or
      // a few of its harmonics still standing out (within a moment of it surely being heard)
      const v = pf.vref;
      const sure = pf.vsure;
      const same = (x) => x && Math.abs(fr.midi - x.midi) <= 0.4;
      if ((v && end - v.end <= 600 && same(v) && rDb >= weakDb + extra) || (sure && end - sure.end <= 0.25 * pf.sr && same(sure) && hn >= HOLD_HARM && !machine)) {
        fr.why = 'holding';
        noteVoice(pf, fr, er, W, end);
        return fr;
      }
    } else if (rDb >= strongDb) return fr; // something well above the piano, but no pitch
    // Nothing that is surely the voice. That means "not singing" only when what is left is
    // just the piano's usual leftover and the singer's usual level would have stood out;
    // otherwise it can't tell, and says so rather than mark you silent.
    fr.voiced = false;
    fr.midi = null;
    const voiceDb = pf.voiceDb != null ? pf.voiceDb : opts.voiceDb || -35;
    const pianoDb = db(env) + strongDb;
    fr.source = rDb < weakDb && pianoDb < voiceDb - 6 ? 'piano' : 'unsure';
    return fr;
  }
  /** Keep a running idea of how loud the singer is at the mic, and where the voice was. */
  function noteVoice(pf, fr, er, W, end, sure) {
    if (!fr.voiced || !(er > 0)) return;
    const d = 10 * Math.log10(er / W);
    pf.voiceDb = pf.voiceDb == null ? d : pf.voiceDb + 0.01 * (d - pf.voiceDb);
    if (end != null) pf.vref = { end, midi: fr.midi };
    if (end != null && sure) pf.vsure = { end, midi: fr.midi };
  }

  SF.DelayTracker = DelayTracker;
  SF.RoomModel = RoomModel;
  SF.Convolver = Convolver;
  SF.PianoFilter = PianoFilter;
  SF.analyzeFrame = analyzeFrame;
  SF.LeftoverSpectrum = LeftoverSpectrum;
  SF.cleanUp = cleanUp;
  SF.pcDist = pcDist;
});
