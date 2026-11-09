/* The ears: the room microphone, and optionally the piano's own USB audio as a
 * reference for cancelling the piano out of the room sound.
 *
 * Both inputs go through one AudioWorklet (two channels of one merger), so their
 * samples line up exactly. The blocks go on to the listening engine (ears.js), in a
 * worker when possible, which filters and analyses them and sends back one frame of
 * pitch every 512 samples. This side looks after the devices and tells the engine
 * what the app is doing: keys pressed, and when singing is expected.
 */
(function (root) {
  'use strict';
  const SF = root.SF;

  const WORKLET = `
class SFCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.B = 512; this.a = new Float32Array(this.B); this.b = new Float32Array(this.B); this.k = 0; this.start = 0; this.alive = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; };
  }
  process(inputs) {
    if (!this.alive) return false;
    const inp = inputs[0] || [];
    const c0 = inp[0], c1 = inp[1];
    const n = c0 ? c0.length : 128;
    for (let i = 0; i < n; i++) {
      if (this.k === 0) this.start = currentFrame + i;
      this.a[this.k] = c0 ? c0[i] : 0;
      this.b[this.k] = c1 ? c1[i] : 0;
      if (++this.k === this.B) {
        this.port.postMessage({ f: this.start, a: this.a, b: this.b }, [this.a.buffer, this.b.buffer]);
        this.a = new Float32Array(this.B); this.b = new Float32Array(this.B); this.k = 0;
      }
    }
    return true;
  }
}
registerProcessor('sf-capture', SFCapture);`;

  const HEADSET_RE = /hands-?free|headset|bluetooth|airpods|buds|\bbt\b/i;
  const PIANO_IN_RE = /p-?series|p-?225|digital ?piano|yamaha|0499:/i;

  const isAlias = (id) => id === 'default' || id === 'communications';
  // Windows' "Default - X" and "Communications - X" entries stand for the input X
  const plainLabel = (s) => String(s || '').replace(/^(default|communications)\s*-\s*/i, '');

  function describe(e) {
    if (!e) return 'unknown error';
    return [e.name, e.message, e.constraint ? 'constraint ' + e.constraint : ''].filter(Boolean).join(': ');
  }

  /** What to tell the person when an input won't open. */
  function explain(e, name) {
    const what = name || 'that input';
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError')
      return 'The browser isn’t allowed to use the microphone. Click the icon at the left of the address bar, allow the microphone, and reload.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return what + ' isn’t there any more. Is it plugged in and switched on?';
    if (n === 'NotReadableError' || n === 'AbortError')
      return 'Windows wouldn’t open ' + what + '. Another program may be using it: close other apps that record sound, or unplug the USB cable and plug it back in.';
    if (n === 'TimeoutError') return what + ' didn’t open within a few seconds. Unplug the USB cable and plug it back in, or restart the browser.';
    return 'Could not open ' + what + ': ' + describe(e);
  }

  /** Rejects with a TimeoutError after ms; a stream that turns up later is closed. */
  function timed(p, ms) {
    if (!ms) return p;
    let timer;
    const late = new Promise((res, rej) => {
      timer = setTimeout(() => {
        p.then((s) => s && s.getTracks && s.getTracks().forEach((t) => t.stop()), () => {});
        const e = new Error('no answer from the device after ' + ms / 1000 + ' s');
        e.name = 'TimeoutError';
        rej(e);
      }, ms);
    });
    return Promise.race([p.finally(() => clearTimeout(timer)), late]);
  }

  /**
   * Opens one input with no processing. With an id, first exactly that device, then (for
   * drivers that refuse strict requests) loosely; the first error is kept as the reason.
   * Without an id the browser picks, and when it asks it lets the person choose.
   */
  async function getStream(id, stereo, opts) {
    const o = opts || {};
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: stereo ? 2 : 1 } };
    const tries = id ? (o.exactOnly ? [{ deviceId: { exact: id } }] : [{ deviceId: { exact: id } }, { deviceId: { ideal: id } }]) : [{}];
    let first = null;
    for (const t of tries) {
      try {
        const s = await timed(navigator.mediaDevices.getUserMedia({ audio: Object.assign({}, base, t) }), o.timeout);
        if (o.log) o.log('opened ' + (o.name || 'an input') + (t.deviceId ? (t.deviceId.exact ? '' : ' (asked loosely)') : ' (the browser chose which)'));
        s.firstError = first;
        return s;
      } catch (e) {
        if (o.log) o.log('could not open ' + (o.name || 'an input') + ': ' + describe(e));
        first = first || e;
        if (e.name === 'NotAllowedError' || e.name === 'TimeoutError') break;
      }
    }
    throw first;
  }

  /** The best guess at the room mic: not the piano, preferably not a headset. */
  function bestMic(ds) {
    const named = ds.filter((d) => d.label && !d.piano);
    const pick =
      named.find((d) => !d.headset && /mic|array|built-?in|internal|realtek|webcam|usb/i.test(d.label)) ||
      named.find((d) => !d.headset) ||
      named[0] ||
      ds.find((d) => !d.piano);
    return pick ? pick.id || null : null;
  }

  class Listener extends SF.Emitter {
    constructor() {
      super();
      this.running = false;
      this.micStream = null;
      this.refStream = null;
      this.micId = null;
      this.refId = null;
      // Set by the app: when singing is expected, so the piano is only learned from while
      // nobody sings. Returns {mode: 'calib'} (all quiet), {mode: 'stopped'}, or
      // {mode: 'play', from, until, spans: [[t0, t1], ...]} with the sung notes' page times.
      this.planner = () => ({ mode: 'stopped' });
      this.levels = { mic: -120, ref: -120 };
      this.gateDb = -50;
      this.minClarity = 0.8;
      this.warning = '';
      this.mode = '';
      this.status = null;
      this.engine = null;
      this.log = []; // [time, what happened] for the device report
      this.phase = ''; // 'asking' (the browser's prompt is up) or 'opening' an input
      this.phaseName = '';
      this.openTimeout = 10000; // ms an input gets to open once the browser has allowed the mic
    }
    // ---------- the engine ----------
    /** A worker if the browser allows one here, else the same engine on the page. */
    makeEngine() {
      if (this.engine) return this.engine;
      const inline = () => {
        const ears = new SF.Ears((m) => this.fromEngine(m));
        this.engine = { kind: 'page', ears, send: (m) => ears.handle(m) };
        return this.engine;
      };
      const forcePage = root.location && /[?&]ears=page\b/.test(root.location.search || '');
      const src = !forcePage && typeof Worker !== 'undefined' && SF.Ears.workerSource();
      if (!src) return inline();
      try {
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
        const eng = { kind: 'worker', w, send: (m, tr) => w.postMessage(m, tr || []) };
        w.onmessage = (e) => this.fromEngine(e.data);
        w.onerror = (e) => {
          // the worker couldn't start: carry on with the engine on the page
          if (e && e.preventDefault) e.preventDefault();
          if (this.engine !== eng) return;
          w.terminate();
          this.engine = null;
          inline();
          if (this.lastStart) this.engine.send(this.lastStart);
          if (this.savedRoom) this.engine.send({ type: 'room', st: this.savedRoom });
        };
        this.engine = eng;
        return eng;
      } catch (e) {
        return inline();
      }
    }
    send(m, transfer) {
      this.makeEngine().send(m, transfer);
    }
    fromEngine(m) {
      switch (m.type) {
        case 'frame':
          if (this.running) this.emit('frame', m.fr);
          break;
        case 'level':
          this.levels.mic = m.mic;
          this.levels.ref = m.ref;
          this.emit('level', this.levels);
          break;
        case 'status':
          this.status = m.st;
          break;
        case 'room':
          this.emit('room', m.st);
          break;
      }
    }
    /** The engine on the page, for tests and debugging (null when it runs in a worker). */
    get ears() {
      return this.engine && this.engine.ears ? this.engine.ears : null;
    }
    get pf() {
      return this.ears ? this.ears.pf : null;
    }
    startEngine() {
      this.lastStart = { type: 'start', sr: this.sr, hasRef: !!this.refStream, gateDb: this.gateDb, minClarity: this.minClarity, saved: this.savedRoom || null };
      this.status = null;
      this.send(this.lastStart);
      this.sendPlan();
      clearInterval(this.planTimer);
      this.planTimer = setInterval(() => this.sendPlan(), 150);
    }
    /** Tell the engine when singing is expected (the app calls this when the transport moves). */
    sendPlan() {
      if (!this.running && !this.lastStart) return;
      let plan;
      try {
        plan = this.planner();
      } catch (e) {
        plan = { mode: 'stopped' };
      }
      this.send({ type: 'plan', plan });
    }
    /** A saved room to start from (used if the measured delay matches). */
    offerRoom(st) {
      this.savedRoom = st || null;
      if (st && this.engine) this.send({ type: 'room', st });
    }
    /** Ask for what was learned: it arrives as a 'room' event. */
    saveRoom() {
      if (this.engine) this.send({ type: 'save' });
    }
    forgetRoom() {
      this.savedRoom = null;
      if (this.engine) this.send({ type: 'forget' });
    }
    get supported() {
      return !!(root.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }
    /** Every audio input the browser lists, Windows' Default and Communications included. */
    async inputs() {
      if (!this.supported) return [];
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    }
    /** The real inputs. Until the browser is allowed the mic, labels are '' (and ids too). */
    async devices() {
      return (await this.inputs())
        .filter((d) => !isAlias(d.deviceId))
        .map((d) => ({ id: d.deviceId, label: d.label || '', group: d.groupId, piano: PIANO_IN_RE.test(d.label), headset: HEADSET_RE.test(d.label) }));
    }
    /** A mic that isn't the piano's own audio input (nor, if there's a choice, a headset). */
    async defaultMic() {
      return bestMic(await this.devices());
    }
    async pianoInput() {
      const ds = await this.devices();
      const p = ds.find((d) => d.piano);
      return p ? p.id : null;
    }
    /** 'granted', 'prompt', 'denied', or 'unknown' when the browser won't say. */
    async permission() {
      try {
        return (await navigator.permissions.query({ name: 'microphone' })).state;
      } catch (e) {
        return 'unknown';
      }
    }
    /** Which real input a stream came from: {id, label}. Opened without an id, the browser
     * may say "default"; that is matched to the input it stands for. */
    async which(stream) {
      const tr = stream && stream.getAudioTracks()[0];
      const st = tr && tr.getSettings ? tr.getSettings() : {};
      let all = [];
      try {
        all = await this.inputs();
      } catch (e) {
        /* fine */
      }
      const real = all.filter((d) => d.deviceId && !isAlias(d.deviceId));
      let d = real.find((x) => x.deviceId === st.deviceId) || null;
      if (!d && isAlias(st.deviceId)) {
        const a = all.find((x) => x.deviceId === st.deviceId);
        if (a) d = real.find((x) => x.label && x.label === plainLabel(a.label)) || null;
      }
      if (!d && tr && tr.label) d = real.find((x) => x.label && x.label === plainLabel(tr.label)) || null;
      const id = d ? d.deviceId : st.deviceId && !isAlias(st.deviceId) ? st.deviceId : null;
      return { id, label: (d && d.label) || plainLabel(tr ? tr.label : '') };
    }
    /** A line for the device report. */
    note(m) {
      this.log.push([Date.now(), m]);
      if (this.log.length > 80) this.log.shift();
    }
    setPhase(phase, name) {
      this.phase = phase || '';
      this.phaseName = name || '';
      this.emit('phase');
    }

    /**
     * Opens the room mic (the one asked for if it's there, else the best guess) and starts
     * listening. Always a named input, never "default": on Windows the default input can
     * be the piano's own USB audio. A stored choice that is the piano is not reused unless
     * opts.allowPiano (the person picked it just now).
     */
    async start(micId, opts) {
      if (!this.supported) throw new Error('No microphone access in this browser');
      const o = opts || {};
      const ctx = SF.audio.ctx;
      SF.audio.resume(); // runs once the page has been clicked or a key pressed
      this.stopStreams(true);
      const log = (m) => this.note(m);
      let ds = await this.devices();
      const asked = (list) => {
        const d = micId && list.find((x) => x.id === micId);
        return d && (o.allowPiano || !d.piano) ? micId : null;
      };
      let stream = null;
      if (!ds.some((d) => d.label)) {
        // The names stay hidden until the browser is allowed the mic: ask without naming
        // one. The browser's prompt lets you pick, and that pick is kept (unless it's the piano).
        log('asking the browser for the microphone (' + (await this.permission()) + ')');
        this.setPhase('asking');
        try {
          stream = await getStream(null, false, { log, name: 'the microphone' });
        } finally {
          this.setPhase('');
        }
        ds = await this.devices();
        const got = await this.which(stream);
        const want = asked(ds);
        if (PIANO_IN_RE.test(got.label) || (want && got.id !== want)) {
          log('the browser gave ' + (got.label || 'an unnamed input') + '; opening another');
          stream.getTracks().forEach((t) => t.stop());
          stream = null;
        }
      }
      if (!stream) {
        const want = asked(ds) || bestMic(ds);
        const name = (ds.find((d) => d.id === want) || {}).label || 'the microphone';
        const granted = (await this.permission()) === 'granted';
        this.setPhase('opening', name);
        try {
          stream = await getStream(want, false, { timeout: granted ? this.openTimeout : 0, log, name });
        } catch (e) {
          e.device = name;
          throw e;
        } finally {
          this.setPhase('');
        }
      }
      this.micStream = stream;
      const track = stream.getAudioTracks()[0];
      const got = await this.which(stream);
      const st = track && track.getSettings ? track.getSettings() : {};
      this.micId = got.id;
      this.micLabel = got.label || (track ? track.label : '');
      log('mic: ' + (this.micLabel || '(no name)'));
      if (track) {
        track.onended = () => {
          if (this.micStream !== stream) return;
          log('the mic stopped (unplugged, or taken by another program)');
          this.emit('lost', 'mic');
        };
      }
      this.warning = '';
      if (PIANO_IN_RE.test(this.micLabel)) this.warning = 'This input is the piano’s own audio, not a microphone.';
      else if (HEADSET_RE.test(this.micLabel) || (st.sampleRate && st.sampleRate <= 24000))
        this.warning = 'A Bluetooth headset mic switches the headphones to call quality. Prefer the laptop or a USB mic.';
      this.sr = ctx.sampleRate;
      await this.build();
      this.running = true;
      this.startEngine();
      this.emit('state');
    }
    /** Use the piano's USB audio to cancel the piano (null to stop). */
    async setReference(refId) {
      this.dropReference();
      let err = null;
      if (refId) {
        const log = (m) => this.note(m);
        const asked = (await this.devices()).find((d) => d.id === refId);
        const name = (asked && asked.label) || 'the piano’s audio';
        try {
          if (refId === this.micId) throw Object.assign(new Error('that input is the microphone itself'), { name: 'SameAsMic' });
          const granted = (await this.permission()) === 'granted';
          this.setPhase('opening', name);
          let stream;
          try {
            stream = await getStream(refId, true, { timeout: granted ? this.openTimeout : 0, log, name });
          } finally {
            this.setPhase('');
          }
          const got = await this.which(stream);
          // a driver that ignores the exact device can hand back another input instead:
          // never use some other mic (above all the mic itself) as "the piano"
          const wrong = got.id !== refId && !PIANO_IN_RE.test(got.label) && !(asked && asked.label && asked.label === got.label);
          if (wrong || this.isMic(stream, got)) {
            stream.getTracks().forEach((t) => t.stop());
            log('asked for ' + name + ' but got ' + (got.label || 'another input'));
            throw stream.firstError || Object.assign(new Error(this.isMic(stream, got) ? 'that input is the microphone itself' : 'the browser opened another input instead'), { name: 'WrongDevice' });
          }
          this.adopt(stream, got, refId);
        } catch (e) {
          e.device = e.device || name;
          err = e;
        }
      }
      await this.rebuilt();
      if (err) throw err;
    }
    /**
     * When the browser hides the inputs (a page opened from the disk: Chrome then asks
     * for every input separately), ask it for the piano's input: its box lets you choose
     * Line (P-Series). An id that worked before is tried first, so the box names the piano.
     */
    async askReference(lastId) {
      this.dropReference();
      const log = (m) => this.note(m);
      let err = null;
      try {
        log('asking the browser for the piano’s input (' + (await this.permission()) + ')');
        this.setPhase('asking-ref');
        let stream = null;
        try {
          if (lastId && lastId !== this.micId) {
            try {
              stream = await getStream(lastId, true, { exactOnly: true, log, name: 'the piano’s input from last time' });
            } catch (e) {
              if (e.name === 'NotAllowedError') throw e;
              stream = null;
            }
          }
          if (!stream) stream = await getStream(null, true, { log, name: 'the input chosen in the browser’s box' });
        } finally {
          this.setPhase('');
        }
        const got = await this.which(stream);
        if (this.isMic(stream, got)) {
          stream.getTracks().forEach((t) => t.stop());
          log('the browser gave the microphone again');
          throw Object.assign(new Error('the browser gave the microphone again'), { name: 'SameAsMic' });
        }
        this.adopt(stream, got, null);
        if (!PIANO_IN_RE.test(got.label)) log('note: ' + got.label + ' doesn’t look like the piano');
      } catch (e) {
        e.device = e.device || 'the piano’s input';
        err = e;
      }
      await this.rebuilt();
      if (err) throw err;
    }
    /** Is this stream the mic that is already open? */
    isMic(stream, got) {
      const tr = stream.getAudioTracks()[0];
      const st = tr && tr.getSettings ? tr.getSettings() : {};
      if (got.id && this.micId) return got.id === this.micId;
      if (st.deviceId && this.micId && !isAlias(st.deviceId)) return st.deviceId === this.micId;
      return !!(got.label && got.label === this.micLabel);
    }
    dropReference() {
      if (this.refStream) this.refStream.getTracks().forEach((t) => t.stop());
      this.refStream = null;
      this.refId = null;
      this.refLabel = '';
    }
    adopt(stream, got, askedId) {
      const tr = stream.getAudioTracks()[0];
      const st = tr && tr.getSettings ? tr.getSettings() : {};
      this.refStream = stream;
      this.refId = got.id || (st.deviceId && !isAlias(st.deviceId) ? st.deviceId : null) || askedId;
      this.refLabel = got.label;
      this.note('piano input: ' + got.label);
      if (tr) {
        tr.onended = () => {
          if (this.refStream !== stream) return;
          this.note('the piano input stopped (piano off or unplugged?)');
          this.refStream = null;
          this.refId = null;
          if (this.running) this.build().then(() => this.startEngine());
          this.emit('lost', 'ref');
        };
      }
    }
    /** Rebuild the graph with whatever is open, so a failed piano input leaves the mic working. */
    async rebuilt() {
      if (this.running) {
        await this.build();
        this.startEngine();
      }
      this.emit('state');
    }
    /** Everything the browser reports about the inputs, as text to paste into a message. */
    async report(extra) {
      const L = [];
      const short = (id) => (!id ? '(none)' : isAlias(id) ? id : String(id).slice(0, 8));
      L.push('scales-feedback device report, ' + new Date().toISOString());
      L.push('page: ' + location.protocol + '//' + location.host + '/…/' + location.pathname.split('/').pop());
      L.push('browser: ' + navigator.userAgent);
      L.push('microphone permission: ' + (await this.permission()));
      let all = [];
      try {
        all = await this.inputs();
      } catch (e) {
        L.push('listing the inputs failed: ' + describe(e));
      }
      L.push('inputs the browser lists (' + all.length + '):');
      for (const d of all) L.push('  ' + short(d.deviceId) + ' | ' + (d.label || '(no name yet)') + ' | group ' + short(d.groupId));
      const tr = (s, what) => {
        const t = s && s.getAudioTracks()[0];
        if (!t) return L.push(what + ': not open');
        const st = t.getSettings ? t.getSettings() : {};
        L.push(what + ': ' + t.label + ' | ' + t.readyState + (t.muted ? ', muted' : '') + ' | id ' + short(st.deviceId) + ' | ' + (st.sampleRate || '?') + ' Hz, ' + (st.channelCount || '?') + ' ch, echo cancellation ' + st.echoCancellation + ', noise suppression ' + st.noiseSuppression + ', auto gain ' + st.autoGainControl);
      };
      tr(this.micStream, 'mic');
      tr(this.refStream, 'piano input');
      L.push('ids in use: mic ' + short(this.micId) + ', piano ' + short(this.refId));
      const ctx = SF.audio.exists ? SF.audio.ctx : null;
      L.push('audio: ' + (ctx ? ctx.state + ', ' + ctx.sampleRate + ' Hz' : 'not started') + ', capture ' + (this.mode || '-') + ', engine ' + (this.engine ? this.engine.kind : '-') + ', listening ' + this.running);
      L.push('levels: mic ' + Math.round(this.levels.mic) + ' dB, piano ' + Math.round(this.levels.ref) + ' dB');
      if (this.status) L.push('filter: ' + JSON.stringify(this.status));
      if (extra) for (const x of extra) L.push(x);
      L.push('what happened:');
      for (const [t, m] of this.log) L.push('  ' + new Date(t).toTimeString().slice(0, 8) + ' ' + m);
      return L.join('\n');
    }
    /** Disconnect the graph and silence the old capture node: a disconnected worklet
     * keeps running and would interleave blocks of silence with the new one's. */
    teardown() {
      this.gen = (this.gen || 0) + 1;
      if (this.nodes) this.nodes.forEach((n) => n.disconnect());
      this.nodes = null;
      const cap = this.capture;
      this.capture = null;
      if (cap) {
        if (cap.port) {
          cap.port.onmessage = null;
          try {
            cap.port.postMessage('stop');
          } catch (e) {
            /* gone already */
          }
        } else cap.onaudioprocess = null;
      }
    }
    async build() {
      const ctx = SF.audio.ctx;
      this.teardown();
      const merger = ctx.createChannelMerger(2);
      const mic = ctx.createMediaStreamSource(this.micStream);
      mic.connect(merger, 0, 0);
      const nodes = [merger, mic];
      if (this.refStream) {
        const ref = ctx.createMediaStreamSource(this.refStream);
        ref.connect(merger, 0, 1);
        nodes.push(ref);
      }
      const capture = await this.captureNode(ctx);
      this.capture = capture;
      merger.connect(capture);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      capture.connect(sink);
      sink.connect(ctx.destination);
      nodes.push(capture, sink);
      this.nodes = nodes;
    }
    async captureNode(ctx) {
      const gen = this.gen;
      const onBlock = (f, a, b) => {
        if (gen === this.gen) this.block(f, a, b);
      };
      if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        const urls = [];
        try {
          urls.push(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
        } catch (e) {
          /* no blobs */
        }
        urls.push('data:application/javascript;base64,' + btoa(WORKLET)); // file:// refuses blob: worklets
        for (const u of urls) {
          try {
            if (!this.workletLoaded) await ctx.audioWorklet.addModule(u);
            this.workletLoaded = true;
            const node = new AudioWorkletNode(ctx, 'sf-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [1] });
            node.port.onmessage = (e) => onBlock(e.data.f, e.data.a, e.data.b);
            this.mode = 'worklet';
            return node;
          } catch (e) {
            /* try the next way */
          }
        }
      }
      // last resort
      const sp = ctx.createScriptProcessor(1024, 2, 1);
      let f = null;
      sp.onaudioprocess = (e) => {
        if (f == null) f = Math.round(ctx.currentTime * ctx.sampleRate); // frames on the context clock
        const a = e.inputBuffer.getChannelData(0);
        const b = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : new Float32Array(a.length);
        for (let i = 0; i < a.length; i += 512) onBlock(f + i, a.slice(i, i + 512), b.slice(i, i + 512));
        f += a.length;
      };
      this.mode = 'script';
      return sp;
    }
    /** The app tells us when it pressed (on) or released a key, in performance ms. */
    markKey(at, pitch, on) {
      if (!this.running || !this.refStream) return;
      // the piano's USB audio is a few ms behind the MIDI
      this.send({ type: 'keys', events: [{ t: at + 8, p: pitch == null ? -1 : pitch, on: on !== false }] });
    }
    markOnset(at, pitch) {
      this.markKey(at, pitch, true);
    }
    markAllOff(at) {
      if (!this.running || !this.refStream) return;
      this.send({ type: 'keys', events: [{ t: at + 8, p: 'all', on: false }] });
    }
    /** A captured block: on to the engine, stamped with the page clock. */
    block(f, a, b) {
      if (!this.running) return;
      const ctx = SF.audio.ctx;
      const m = { type: 'block', f, a, b, perf: SF.now(), ctx: ctx.currentTime };
      if (this.engine && this.engine.kind === 'worker') this.send(m, [a.buffer, b.buffer]);
      else this.send(m);
    }
    setGate(db) {
      this.gateDb = db;
      if (this.engine) this.send({ type: 'gate', db });
    }
    /** Status of the piano filter, for the UI (a quarter of a second old at most). */
    get filter() {
      if (!this.refStream || !this.running) return null;
      return this.status || { delayMs: null, ready: false, solved: false, cancelDb: 0, learned: 0, keys: 0, restored: false, realigns: 0 };
    }
    stopStreams(keepRef) {
      if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
      if (!keepRef && this.refStream) {
        this.refStream.getTracks().forEach((t) => t.stop());
        this.refStream = null;
      }
    }
    stop() {
      if (this.engine) this.send({ type: 'stop' }); // sends what it learned first
      this.running = false;
      clearInterval(this.planTimer);
      this.teardown();
      this.stopStreams(false);
      this.emit('state');
    }
  }

  SF.Listener = Listener;
  SF.PIANO_IN_RE = PIANO_IN_RE;
  SF.inputError = explain;
})(typeof window !== 'undefined' ? window : globalThis);
