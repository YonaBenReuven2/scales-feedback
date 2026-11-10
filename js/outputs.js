/* Where the notes go: the piano over Web MIDI, imported samples, or a built-in synth.
 * All three take noteOn(pitch, velocity, atMs) / noteOff(pitch, atMs) / allOff(),
 * with atMs on the performance.now() clock, and say how far ahead they want notes.
 */
(function (root) {
  'use strict';
  const SF = root.SF;

  // ---------- the one AudioContext ----------
  let ctx = null;
  let bus = null;
  SF.audio = {
    get ctx() {
      if (!ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        ctx = new AC({ latencyHint: 'interactive' });
      }
      return ctx;
    },
    /** Everything the app itself plays (the synth, the samples, the metronome, keys clicked)
     *  goes through here to the speakers: the piano filter can take it as what to remove. */
    get bus() {
      if (!bus) {
        const c = SF.audio.ctx;
        bus = c.createGain();
        bus.connect(c.destination);
      }
      return bus;
    },
    get exists() {
      return !!ctx;
    },
    async resume() {
      const c = SF.audio.ctx;
      if (c.state !== 'running') {
        try {
          await c.resume();
        } catch (e) {
          /* needs a user gesture */
        }
      }
      return c;
    },
    /** Seconds between the audio being worked out and being heard at the speakers. */
    outputLag() {
      const c = SF.audio.ctx;
      let lag = null;
      if (c.getOutputTimestamp) {
        const ts = c.getOutputTimestamp();
        if (ts && ts.contextTime != null && isFinite(ts.contextTime) && ts.contextTime > 0) lag = c.currentTime - ts.contextTime;
      }
      if (lag == null || !isFinite(lag)) lag = (c.outputLatency || 0) + (c.baseLatency || 0);
      return SF.clamp(lag, 0, 0.5);
    },
    /** Context time at which a sound should start to be heard at performance time ms. */
    timeAt(ms) {
      const c = SF.audio.ctx;
      let t;
      if (c.getOutputTimestamp) {
        const ts = c.getOutputTimestamp();
        if (ts && ts.performanceTime) t = ts.contextTime + (ms - ts.performanceTime) / 1000;
      }
      if (t == null || !isFinite(t)) t = c.currentTime + (ms - SF.now()) / 1000;
      return Math.max(c.currentTime, t);
    },
  };

  // ---------- MIDI ----------
  const PIANO_RE = /p-?225|p-?series|digital ?piano|yamaha|0499:/i;
  const SOFT_RE = /microsoft gs|wavetable|midi through|iac|loopmidi|virtual/i;

  class MidiOut {
    constructor(port, channel) {
      this.port = port;
      this.channel = channel || 0;
      this.lookahead = 70;
      this.kind = 'midi';
      this.active = new Map();
      this.name = port ? port.name : '';
    }
    send(bytes, at) {
      try {
        this.port.send(bytes, at && at > SF.now() ? at : undefined);
      } catch (e) {
        /* port went away */
      }
    }
    noteOn(p, v, at) {
      this.active.set(p, (this.active.get(p) || 0) + 1);
      this.send([0x90 | this.channel, p, SF.clamp(v | 0, 1, 127)], at);
    }
    noteOff(p, at) {
      const n = (this.active.get(p) || 0) - 1;
      if (n > 0) {
        this.active.set(p, n);
        return;
      }
      this.active.delete(p);
      this.send([0x80 | this.channel, p, 0], at);
    }
    allOff() {
      try {
        if (this.port.clear) this.port.clear();
      } catch (e) {
        /* not implemented everywhere */
      }
      for (const p of this.active.keys()) this.send([0x80 | this.channel, p, 0]);
      this.active.clear();
      this.send([0xb0 | this.channel, 64, 0]); // sustain off
      this.send([0xb0 | this.channel, 123, 0]); // all notes off
    }
  }

  class Midi extends SF.Emitter {
    constructor() {
      super();
      this.access = null;
      this.error = '';
    }
    get supported() {
      return !!(root.navigator && navigator.requestMIDIAccess);
    }
    /** Connect without prompting if permission was already given. */
    async autoConnect() {
      if (!this.supported) return false;
      try {
        const st = await navigator.permissions.query({ name: 'midi' });
        if (st.state !== 'granted') return false;
      } catch (e) {
        return false;
      }
      return this.connect();
    }
    async connect() {
      if (!this.supported) {
        this.error = 'This browser has no Web MIDI (use Chrome or Edge).';
        this.emit('change');
        return false;
      }
      if (root.isSecureContext === false) {
        this.error = 'MIDI needs https, localhost or a file on disk.';
        this.emit('change');
        return false;
      }
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: false });
      } catch (e) {
        this.error = 'MIDI access was refused.';
        this.emit('change');
        return false;
      }
      this.error = '';
      this.access.onstatechange = () => {
        this.listen();
        this.emit('change');
      };
      this.listen();
      this.emit('change');
      return true;
    }
    outputs() {
      if (!this.access) return [];
      return [...this.access.outputs.values()].filter((p) => p.state !== 'disconnected');
    }
    /** The piano if there is one; never a software synth by choice. */
    preferred(savedId) {
      const outs = this.outputs();
      return (
        outs.find((p) => p.id === savedId) ||
        outs.find((p) => PIANO_RE.test(p.name + ' ' + (p.manufacturer || ''))) ||
        outs.find((p) => !SOFT_RE.test(p.name)) ||
        null
      );
    }
    listen() {
      if (!this.access) return;
      for (const inp of this.access.inputs.values()) {
        inp.onmidimessage = (e) => {
          const [s, d1, d2] = e.data;
          if (s >= 0xf0) return;
          const type = s & 0xf0;
          if (type === 0x90 && d2 > 0) this.emit('key', { pitch: d1, vel: d2, on: true });
          else if (type === 0x80 || type === 0x90) this.emit('key', { pitch: d1, on: false });
          else if (type === 0xb0) this.emit('cc', { cc: d1, value: d2 });
        };
      }
    }
  }

  // ---------- built-in synth ----------
  class Synth {
    constructor() {
      this.kind = 'synth';
      this.name = 'Built-in synth';
      this.lookahead = 120;
      this.voices = new Map();
      this.volume = 0.8;
    }
    setup() {
      if (this.out) return;
      const c = SF.audio.ctx;
      this.out = c.createGain();
      this.out.gain.value = this.volume;
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 4;
      this.out.connect(comp);
      comp.connect(SF.audio.bus);
      // a soft, piano-ish tone: falling harmonics
      const n = 12;
      const re = new Float32Array(n);
      const im = new Float32Array(n);
      for (let h = 1; h < n; h++) im[h] = (1 / Math.pow(h, 1.6)) * (h % 2 ? 1 : 0.6);
      this.wave = c.createPeriodicWave(re, im);
    }
    noteOn(p, v, at) {
      this.setup();
      const c = SF.audio.ctx;
      const t = SF.audio.timeAt(at);
      const osc = c.createOscillator();
      osc.setPeriodicWave(this.wave);
      osc.frequency.value = SF.midiToHz(p);
      const g = c.createGain();
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(9000, SF.midiToHz(p) * 8 + 400);
      const peak = 0.25 * Math.pow(v / 127, 1.5);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.006);
      g.gain.setTargetAtTime(peak * 0.35, t + 0.006, 0.35);
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.out);
      osc.start(t);
      const voice = { osc, g, t };
      if (!this.voices.has(p)) this.voices.set(p, []);
      this.voices.get(p).push(voice);
    }
    noteOff(p, at) {
      const list = this.voices.get(p);
      if (!list || !list.length) return;
      const v = list.shift();
      const t = Math.max(SF.audio.timeAt(at), v.t + 0.01);
      v.g.gain.cancelScheduledValues(t);
      v.g.gain.setTargetAtTime(0, t, 0.06);
      v.osc.stop(t + 0.5);
    }
    allOff() {
      if (!this.out) return;
      const t = SF.audio.ctx.currentTime;
      for (const list of this.voices.values()) {
        for (const v of list) {
          try {
            v.g.gain.cancelScheduledValues(t);
            v.g.gain.setTargetAtTime(0, t, 0.015);
            v.osc.stop(t + 0.2);
          } catch (e) {
            /* already stopped */
          }
        }
      }
      this.voices.clear();
    }
  }

  // ---------- imported samples ----------
  class SamplePlayer {
    constructor(bank) {
      this.kind = 'samples';
      this.bank = bank; // SF.SampleBank
      this.name = bank ? bank.name : 'Samples';
      this.lookahead = 120;
      this.voices = new Map();
      this.volume = 0.9;
    }
    setup() {
      if (this.out) return;
      const c = SF.audio.ctx;
      this.out = c.createGain();
      this.out.gain.value = this.volume;
      this.out.connect(SF.audio.bus);
    }
    noteOn(p, v, at) {
      const s = this.bank && this.bank.pick(p, v);
      if (!s) return;
      this.setup();
      const c = SF.audio.ctx;
      const t = SF.audio.timeAt(at);
      const buf = this.bank.buffer(s);
      if (!buf) return;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = Math.pow(2, (p - s.midi) / 12); // nearest recorded note, retuned
      const g = c.createGain();
      // loudness follows the velocity slider: the recorded velocity is the reference
      g.gain.value = this.bank.gain * Math.min(1.6, Math.pow(v / s.vel, 1.8));
      src.connect(g);
      g.connect(this.out);
      src.start(t);
      const voice = { src, g, t };
      if (!this.voices.has(p)) this.voices.set(p, []);
      this.voices.get(p).push(voice);
      src.onended = () => {
        const l = this.voices.get(p);
        if (l) {
          const i = l.indexOf(voice);
          if (i >= 0) l.splice(i, 1);
        }
      };
    }
    noteOff(p, at) {
      const list = this.voices.get(p);
      if (!list || !list.length) return;
      const v = list.shift();
      const t = Math.max(SF.audio.timeAt(at), v.t + 0.01);
      v.g.gain.setTargetAtTime(0, t, 0.3 / 4); // a damper landing, about 0.3 s
      try {
        v.src.stop(t + 1.6);
      } catch (e) {
        /* fine */
      }
    }
    allOff() {
      if (!this.out) return;
      const t = SF.audio.ctx.currentTime;
      for (const list of this.voices.values()) {
        for (const v of list) {
          try {
            v.g.gain.cancelScheduledValues(t);
            v.g.gain.setTargetAtTime(0, t, 0.015 / 3);
            v.src.stop(t + 0.1);
          } catch (e) {
            /* already stopped */
          }
        }
      }
      this.voices.clear();
    }
  }

  // ---------- the metronome ----------
  /**
   * A click on every beat. It is a few milliseconds of noise, so it has no pitch the mic could
   * take for a sung note, with or without the piano filter. The scorer asks clickedNear() and
   * doesn't count a frame the click drowned out.
   */
  class Metronome {
    constructor() {
      this.volume = 0.7;
      this.live = new Set();
      this.times = []; // page times of the clicks scheduled lately
    }
    setup() {
      if (this.out) return;
      const c = SF.audio.ctx;
      this.out = c.createGain();
      this.out.gain.value = this.volume;
      this.out.connect(SF.audio.bus);
      const n = Math.round(c.sampleRate * 0.012);
      this.noise = c.createBuffer(1, n, c.sampleRate);
      const d = this.noise.getChannelData(0);
      let seed = 12345;
      for (let i = 0; i < n; i++) {
        seed = (seed * 16807) % 2147483647;
        d[i] = ((seed / 2147483647) * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.0022));
      }
    }
    setVolume(v) {
      this.volume = v;
      if (this.out) this.out.gain.value = v;
    }
    /** A click at page time at (ms); accent: the first beat of a bar. */
    click(at, accent) {
      this.setup();
      const c = SF.audio.ctx;
      const t = SF.audio.timeAt(at);
      const src = c.createBufferSource();
      src.buffer = this.noise;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = accent ? 3400 : 2300;
      bp.Q.value = 0.8;
      const g = c.createGain();
      g.gain.value = accent ? 1.4 : 0.8;
      src.connect(bp);
      bp.connect(g);
      g.connect(this.out);
      src.start(t);
      this.live.add(src);
      src.onended = () => this.live.delete(src);
      this.times.push(at);
      if (this.times.length > 64) this.times.splice(0, this.times.length - 64);
    }
    /** Stop the clicks already scheduled (on pause or a jump). */
    cancel() {
      const now = SF.now();
      for (const s of this.live) {
        try {
          s.stop();
        } catch (e) {
          /* already played */
        }
      }
      this.live.clear();
      this.times = this.times.filter((t) => t <= now);
    }
    /** Was there a click within ms of page time t (the mic hears it a little after)? */
    clickedNear(t, ms) {
      const w = ms == null ? 45 : ms;
      for (let i = this.times.length - 1; i >= 0; i--) {
        const d = t - this.times[i];
        if (d >= -w && d <= w + 25) return true;
        if (d > w + 25) break;
      }
      return false;
    }
  }

  /** A pass-through that also reports each key pressed and released (the piano filter
   *  wants to know): onNote(at, pitch, on). */
  function tap(out, onNote, onAll) {
    return {
      kind: out.kind,
      name: out.name,
      get lookahead() {
        return out.lookahead;
      },
      noteOn(p, v, at) {
        onNote(at, p, true);
        out.noteOn(p, v, at);
      },
      noteOff(p, at) {
        onNote(at, p, false);
        out.noteOff(p, at);
      },
      allOff() {
        if (onAll) onAll();
        out.allOff();
      },
      inner: out,
    };
  }

  SF.MidiOut = MidiOut;
  SF.Midi = Midi;
  SF.Synth = Synth;
  SF.SamplePlayer = SamplePlayer;
  SF.Metronome = Metronome;
  SF.tapOutput = tap;
  SF.PIANO_RE = PIANO_RE;
})(typeof window !== 'undefined' ? window : globalThis);
