/* Scales Feedback — the page: wires the player, the sound outputs, the ears, the
 * scorer and the picture to the controls. */
(function (root) {
  'use strict';
  const SF = root.SF;
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- settings
  const DEFAULTS = {
    output: 'synth', // 'midi' | 'samples' | 'synth'
    localOut: 'synth', // last choice that isn't the piano
    midiPort: null,
    midiCh: 0,
    velAcc: 50,
    velSing: 62,
    guide: true,
    loop: false,
    shuffle: false,
    skip: false,
    rangeLo: 40,
    rangeHi: 69,
    preroll: 1.5,
    ahead: 3,
    labels: 'solfege',
    hist: true,
    kbView: 'fit', // the keyboard shows the exercise ('fit'), all 88 keys ('all'), or kbWhites white keys ('zoom')
    kbWhites: 22,
    kbFrac: null, // the keyboard's height and the strip's under it, as dragged (null: automatic)
    histFrac: null,
    feedback: 'all', // while singing show how you're doing ('all'), only where you sing ('where'), or nothing ('none')
    boxPlace: 'right', // the box: on the right, or out of the way of the notes ('move')
    metro: false,
    metroVol: 70,
    pedal: false,
    micOn: false,
    micId: null,
    gate: -50,
    tol: 35,
    octFree: false,
    latency: 30,
    grace: 120, // ms not judged at each end of a note
    refOn: false, // hear me over the piano: the filter is set up
    refId: null,
    filterGuide: true, // and used while the piano plays your notes
    filterChord: false, // and in Chord only (nothing plays while you sing)
    lastEx: null,
    bpmByEx: {},
    voiceByEx: {},
    rolesByEx: {},
  };
  const stored = SF.store.get('settings', {});
  const S = Object.assign({}, DEFAULTS, stored);
  if (stored.fullKb && !stored.kbView) S.kbView = 'all'; // the old "Full 88-key keyboard"
  delete S.fullKb;
  const save = () => SF.store.set('settings', S);

  // ---------------------------------------------------------------- objects
  const player = new SF.Player({
    guide: S.guide,
    velAcc: S.velAcc,
    velSing: S.velSing,
    loop: S.loop,
    shuffle: S.shuffle,
    skip: S.skip,
    lo: S.rangeLo,
    hi: S.rangeHi,
    preroll: S.preroll,
  });
  // the metronome: a click with no pitch, and the frames it drowns out aren't judged
  const metronome = new SF.Metronome();
  metronome.setVolume(S.metroVol / 100);
  const scorer = new SF.Scorer(player, { tolerance: S.tol, octaveFree: S.octFree, latency: S.latency, grace: S.grace / 1000, endGrace: S.grace / 1000, clickNear: (t) => metronome.clickedNear(t) });
  const renderer = new SF.Renderer($('cv'), player, scorer);
  renderer.set({ lookahead: S.ahead, history: S.hist, labels: S.labels, view: S.kbView, whites: S.kbWhites, kbFrac: S.kbFrac, histFrac: S.histFrac, feedback: S.feedback, beats: S.metro });
  if (S.metro) player.setMetronome(metronome);
  const midi = new SF.Midi();
  const synth = new SF.Synth();
  const listener = new SF.Listener();
  listener.setGate(S.gate);
  // the filter: used in Play my notes, off in Chord only unless turned on there
  const filterWanted = () => !!(player.cfg.guide ? S.filterGuide : S.filterChord);
  listener.setFilterUse(filterWanted());
  const library = new SF.Library();
  let bank = null;
  let ex = null;
  const held = new Set(); // keys held down on the screen
  let calibrating = false;
  let wakeLock = null;

  // ---------------------------------------------------------------- outputs
  let midiOut = null;
  function currentOutput() {
    if (S.output === 'midi' && midiOut) return midiOut;
    if (S.output === 'samples' && bank) return samplePlayer();
    return synth;
  }
  let sp = null;
  function samplePlayer() {
    if (!sp || sp.bank !== bank) sp = new SF.SamplePlayer(bank);
    return sp;
  }
  let tapOut = null; // the output, telling the filter every key it plays
  function applyOutput() {
    const out = currentOutput();
    if (!tapOut || tapOut.inner !== out) {
      tapOut = SF.tapOutput(out, (at, p, on) => listener.markKey(at, p, on), () => listener.markAllOff(SF.now()));
      player.setOutput(tapOut);
    }
    if (out.kind === 'samples' && ex) bank.prepare(ex.notes.map((n) => n.pitch));
    updateOutputUI();
    syncRef();
    updateRefUI(); // (what the filter takes follows what plays)
  }
  /** The filter takes the piano's USB audio when the piano plays, the app's own sound otherwise. */
  let refKindNow = null;
  function syncRef() {
    const app = currentOutput().kind !== 'midi';
    if (refKindNow === app) return;
    refKindNow = app;
    if (S.refOn && listener.running) refOn(true);
  }
  function refreshMidi() {
    const port = midi.preferred(S.midiPort);
    const had = !!midiOut;
    if (port) {
      if (!midiOut || midiOut.port !== port || midiOut.channel !== S.midiCh) {
        if (midiOut) midiOut.allOff();
        midiOut = new SF.MidiOut(port, S.midiCh);
      }
      // the piano takes over whenever it (re)appears
      if (!had && S.output !== 'midi') {
        if (S.output !== 'midi') S.localOut = S.output;
        S.output = 'midi';
        save();
        toast('Playing on ' + port.name);
      }
    } else {
      if (midiOut) midiOut.allOff();
      midiOut = null;
      if (S.output === 'midi' && had) {
        S.output = S.localOut || 'synth';
        toast('The piano went away, playing on the ' + (S.output === 'samples' ? 'samples' : 'built-in synth'));
      }
    }
    applyOutput();
  }
  midi.on('change', refreshMidi);
  midi.on('key', (k) => {
    if (k.on) renderer.inputKeys.set(k.pitch, true);
    else renderer.inputKeys.delete(k.pitch);
    lastKeyAt = SF.now();
  });
  let pedalDown = false;
  midi.on('cc', ({ cc, value }) => {
    if (cc !== 64) return;
    const down = value >= 64;
    if (down && !pedalDown && S.pedal && ex) togglePlay();
    pedalDown = down;
  });

  // ---------------------------------------------------------------- the ears
  /** Could this pitch be the piano (or the app) itself, with nothing filtering it out? */
  let lastKeyAt = -1e9;
  function pianoHeard(fr) {
    if (fr.why) return false; // the filter heard it as the voice
    const f = listener.filter;
    if (f && f.noEcho) return false; // the mic doesn't hear the piano (headphones)
    const t = fr.t - S.latency;
    if (held.size || renderer.inputKeys.size || t - lastKeyAt < 600) return true;
    const P = player.positionAt(t);
    if (P == null || !ex) return false;
    const tail = 0.4 * player.speed; // a note still rings a moment after it ends
    let on = false;
    player.forNotes(P - tail, P + 1e-4, (n, seg, P0, P1) => {
      if (!on && player.audible(n) && P0 <= P && P1 > P - tail) on = true;
    });
    return on;
  }
  // When singing is expected, as page times: the piano filter learns only outside these.
  listener.planner = () => {
    if (calibrating) return { mode: 'calib' };
    if (player.state !== 'playing' || !player.ex) return { mode: 'stopped' };
    const P = player.position();
    const ahead = 3 * player.speed;
    const spans = [];
    player.forNotes(P - 2 * player.speed, P + ahead, (n, seg, P0, P1) => {
      if (n.role === 'sing') spans.push([player.perfAt(P0), player.perfAt(P1)]);
    });
    return { mode: 'play', from: player.anchoredAt, until: player.perfAt(P + ahead), spans };
  };
  for (const ev of ['state', 'seek', 'tempo', 'replan']) player.on(ev, () => listener.sendPlan());
  let learningFrames = 0;
  let learningTold = false;
  let unsureFrames = 0;
  let unsureTold = false;
  listener.on('frame', (fr) => {
    scorer.frame(fr);
    // where you sing, also between notes, while paused, with no exercise: never the piano's own sound
    if (fr.voiced && fr.midi != null && !pianoHeard(fr)) renderer.free = { midi: fr.midi, at: SF.now() };
    // notes the piano filter can't judge aren't scored: say why, once each
    if (!scorer.live.listening) return;
    if (fr.source === 'learning' && !learningTold && ++learningFrames > 60) {
      learningTold = true;
      toast('The piano filter is still learning these keys, so they aren’t scored yet. Calibrate under Settings, Hear me over the piano: it takes about 15 to 20 seconds.', 6500);
    } else if (fr.source === 'unsure' && !unsureTold && ++unsureFrames > 120) {
      unsureTold = true;
      toast('Too much of the piano is left to hear you, so these notes aren’t scored. Calibrate under Settings, or turn the piano down a little.', 6500);
    }
  });
  listener.on('level', (lv) => {
    const pct = (db) => SF.clamp((db + 70) / 60, 0, 1) * 100 + '%';
    $('micMeter').style.width = pct(lv.mic);
    if ($('set').classList.contains('open')) {
      $('micLvl').style.width = pct(lv.mic);
      $('refLvl').style.width = listener.refStream ? pct(lv.ref) : '0%';
    }
  });
  listener.on('room', (st) => {
    if (st) SF.idb.put('kv', roomKey(), st).catch(() => {});
  });
  // what was learned, per reference (the piano's audio, or the app's own sound), mic and rate
  const roomKey = () => 'room:' + (listener.refApp ? 'app' : listener.refLabel || '') + '|' + (listener.micLabel || '') + '|' + (listener.sr || '');

  // Opening inputs one at a time: a second request while the browser's prompt is up
  // would otherwise race the first.
  let devQ = Promise.resolve();
  const serial = (fn) => {
    const run = devQ.then(fn, fn);
    devQ = run.catch(() => {});
    return run;
  };
  let micNote = ''; // why the mic isn't on, when it should be
  let micBusy = null;
  /** Turn the mic on (and the piano filter, if it's ticked). pick: an input the person just chose. */
  function micOn(pick) {
    if (micBusy && !pick) return micBusy;
    const p = serial(() => openMic(pick)).finally(() => {
      if (micBusy === p) micBusy = null;
    });
    micBusy = p;
    return p;
  }
  async function openMic(pick) {
    micNote = '';
    updateMicUI();
    try {
      SF.audio.resume(); // the browser lets it run after the first click or key press
      await listener.start(pick || S.micId, { allowPiano: !!pick });
      S.micId = listener.micId || S.micId;
      S.micOn = true;
      save();
      // show the mic's name now, whatever the piano input does next
      await fillDevices();
      updateMicUI();
      if (S.refOn) await openRef(true);
    } catch (e) {
      S.micOn = false;
      micNote = SF.inputError(e, e && e.device);
      toast(esc(micNote), 6000);
      await fillDevices();
    }
    updateMicUI();
    updateRefUI();
  }
  function micOff() {
    listener.stop();
    S.micOn = false;
    micNote = '';
    save();
    updateMicUI();
    updateRefUI();
  }
  let refNote = ''; // why the piano filter isn't running, when it should be
  let pianoFound = ''; // the piano's input, when the browser lists it
  let namesHidden = false; // the browser lists the inputs without names (or not at all)
  function refOn(quiet) {
    return serial(() => openRef(quiet));
  }
  async function openRef(quiet) {
    refNote = '';
    // synth or samples: the filter takes the app's own sound, nothing to open
    const app = currentOutput().kind !== 'midi';
    refKindNow = app;
    if (app) {
      try {
        await listener.setAppReference(true);
        await offerSavedRoom();
      } catch (e) {
        refNote = 'Could not start the filter: ' + (e && e.message ? e.message : e);
      }
      save();
      updateRefUI();
      updateMicUI();
      return;
    }
    try {
      // the piano: its USB audio, not the app's sound (which has nothing of it)
      if (listener.refApp) await listener.setAppReference(false);
      // the input picked before, if it's still there; else whatever looks like the piano
      const ds = await listener.devices();
      const named = ds.filter((d) => d.label);
      if (!named.length && listener.running) {
        // The browser hides the inputs (Chrome does for a page opened from the disk) and
        // asks for each one separately: ask it for the piano's input. On opening that
        // happens once by itself; after that, from the button or the checkbox.
        if (quiet && askedPianoThisVisit) {
          refNote = 'Press Ask Chrome for the piano’s input, and choose Line (P-Series) in its box.';
          updateRefUI();
          return;
        }
        askedPianoThisVisit = true;
        updateRefUI();
        await listener.askReference(S.refId);
        S.refId = listener.refId;
        await offerSavedRoom();
        save();
        await fillDevices();
        updateRefUI();
        updateMicUI();
        return;
      }
      const id = (S.refId && named.some((d) => d.id === S.refId && d.id !== listener.micId) && S.refId) || (named.find((d) => d.piano && d.id !== listener.micId) || {}).id || null;
      if (!id) {
        await listener.setReference(null);
        refNote = named.length ? 'The piano’s USB audio isn’t in the list. Is the piano on and connected by USB? Or pick its input under Sound, Piano.' : 'Pick the piano’s USB audio under Sound, Piano.';
        if (!quiet) toast('Pick the piano’s USB audio in Settings, under Sound, Piano.');
        await fillDevices();
        updateRefUI();
        return;
      }
      updateRefUI();
      await listener.setReference(id);
      S.refId = listener.refId;
      await offerSavedRoom();
    } catch (e) {
      refNote =
        e && e.name === 'SameAsMic' && /again/.test(e.message)
          ? 'Chrome gave the microphone again. Press Ask Chrome for the piano’s input, and in its box choose Line (P-Series).'
          : SF.inputError(e, e && e.device);
      if (!quiet) toast(esc(refNote), 6000);
    }
    save();
    await fillDevices();
    updateRefUI();
    updateMicUI();
  }
  let askedPianoThisVisit = false;
  async function offerSavedRoom() {
    try {
      const st = await SF.idb.get('kv', roomKey());
      if (st) listener.offerRoom(st);
    } catch (e) {
      /* nothing saved */
    }
  }
  listener.on('phase', () => {
    updateMicUI();
    updateRefUI();
  });
  listener.on('state', () => updateFilterUI());
  listener.on('lost', (which) => {
    if (which === 'mic') {
      listener.stop();
      micNote = 'The microphone stopped: it was unplugged, or another program took it. Turn the mic on again.';
      toast(esc(micNote), 6000);
    } else refNote = 'The piano’s audio stopped. Is the piano still on? It reconnects when the piano comes back.';
    fillDevices();
    updateMicUI();
    updateRefUI();
  });
  // a device plugged in or out (the piano switched on, say)
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      await fillDevices();
      if (S.refOn && listener.running && !listener.refStream && currentOutput().kind === 'midi') {
        const ds = await listener.devices();
        if (ds.some((d) => d.label && (d.id === S.refId || d.piano) && d.id !== listener.micId)) refOn(true);
      }
    });
  }

  // ---------------------------------------------------------------- exercises
  async function openExercise(id) {
    endSession();
    try {
      ex = await library.open(id);
    } catch (e) {
      toast('Could not read that file: ' + e.message);
      return;
    }
    S.lastEx = id;
    const voice = S.voiceByEx[ex.id];
    player.set({ voice: ex.voices > 1 ? (voice == null ? 0 : voice) : 0 });
    player.load(ex, { bpm: S.bpmByEx[ex.id] || ex.bpm });
    scorer.reset();
    renderer.fit(ex);
    if (S.output === 'samples' && bank) bank.prepare(ex.notes.map((n) => n.pitch));
    save();
    $('empty').hidden = true;
    buildExerciseUI();
    updatePlayUI(); // a new exercise starts paused, whatever was playing
    boxRound = -2;
    closeDrawers();
  }
  /** The run just saved, to show in the results until the next one starts. */
  let lastRun = null;
  function endSession() {
    if (ex && scorer.session.rounds.length) {
      SF.History.add(ex.id, scorer.session, { bpm: Math.round(player.bpm), voice: player.cfg.voice, guide: player.cfg.guide, tol: S.tol });
      lastRun = { ex: ex.id, notes: scorer.session.notes, rounds: latestPerKey(scorer.session.rounds), started: scorer.session.started, bpm: Math.round(player.bpm) };
      scorer.session = { started: Date.now(), rounds: [], notes: [] };
    }
  }
  /** Each key's latest result, in the exercise's order. */
  function latestPerKey(rounds) {
    const m = new Map();
    for (const r of rounds) m.set(r.r, r);
    return [...m.values()].sort((a, b) => a.r - b.r);
  }
  player.on('ended', () => {
    endSession();
    releaseWake();
    updatePlayUI();
    showSummary();
  });
  player.on('state', () => {
    updatePlayUI();
    if (player.state === 'playing') holdWake();
    else releaseWake();
  });
  scorer.on('note', ({ note, res }) => renderer.verdict(note, res));
  scorer.on('round', (r) => {
    updateKeyStrip();
    if ($('res').classList.contains('open')) renderResults();
    if (S.feedback !== 'all') return; // how it went waits for the end
    const parts = [r.hit + ' of ' + r.n + ' in tune'];
    if (r.cents != null && Math.abs(r.cents) >= 5) parts.push(Math.abs(Math.round(r.cents)) + '¢ ' + (r.cents < 0 ? 'flat' : 'sharp') + ' on average');
    if (r.silent) parts.push(r.silent + ' not heard');
    toast('<span class="big">' + esc(r.label) + '</span><br>' + esc(parts.join(', ')), 2600);
  });

  // ---------------------------------------------------------------- transport
  async function togglePlay() {
    if (calibrating) return;
    if (!ex) return openDrawer('lib');
    if (player.state !== 'playing') {
      await SF.audio.resume();
      if (S.micOn && !listener.running) await micOn();
    }
    player.toggle();
  }
  function setBpm(b) {
    if (!ex) return;
    player.setBpm(Math.round(b));
    S.bpmByEx[ex.id] = Math.round(player.bpm);
    if (Math.round(player.bpm) === Math.round(ex.bpm)) delete S.bpmByEx[ex.id];
    save();
    updateTempoUI();
  }

  // ---------------------------------------------------------------- UI: top bar
  function updatePlayUI() {
    const playing = player.state === 'playing';
    $('playIcon').innerHTML = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4v16l13-8z"/>';
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  function updateTempoUI() {
    if (!ex) return;
    if (document.activeElement !== $('bpmIn')) $('bpmIn').value = Math.round(player.bpm);
    $('bpmFile').textContent = Math.round(ex.bpm);
    $('bpmReset').hidden = Math.round(player.bpm) === Math.round(ex.bpm);
  }
  function updateGuideUI() {
    for (const b of $('guideSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String((b.dataset.guide === 'on') === player.cfg.guide));
  }
  function updateLoopUI() {
    $('loopBtn').setAttribute('aria-pressed', String(player.cfg.loop));
  }
  function updateMicUI() {
    $('micBtn').setAttribute('aria-pressed', String(listener.running));
    $('micBtn').classList.toggle('live', listener.running);
    $('micBtn').title = listener.running ? 'Listening with ' + (listener.micLabel || 'the mic') + ' (M)' : 'Turn the mic on (M)';
    $('micLabel').textContent = listener.phase === 'asking' ? 'Allow the mic' : listener.running ? 'Mic on' : 'Mic off';
    if (!listener.running) $('micMeter').style.width = '0';
    $('micWarn').hidden = !listener.warning;
    $('micWarn').textContent = listener.warning;
    let st = '';
    let ok = false;
    if (listener.phase === 'asking') st = 'Allow the microphone in the browser’s box under the address bar. You can choose which mic there.';
    else if (listener.phase === 'opening' && !listener.running) st = 'Opening ' + listener.phaseName + '…';
    else if (listener.running && SF.audio.ctx.state !== 'running') st = 'Opened ' + (listener.micLabel || 'the microphone') + '. Click anywhere on the page or press a key to start listening: the browser waits for that.';
    else if (listener.running) {
      st = 'Listening with ' + (listener.micLabel || 'the microphone') + '.';
      ok = true;
    } else if (micNote) st = micNote;
    else st = 'The mic is off. Press M, or the Mic button at the top.';
    $('micStatus').textContent = st;
    $('micStatus').className = 'status' + (ok ? ' ok' : '');
  }
  function updateOutputUI() {
    const out = currentOutput();
    const label = out.kind === 'midi' ? out.name || 'Piano' : out.kind === 'samples' ? bank.name : 'Built-in synth';
    $('outLabel').textContent = label.length > 18 ? label.slice(0, 17) + '…' : label;
    $('outDot').className = 'dot ' + (out.kind === 'midi' ? 'ok' : out.kind === 'samples' ? 'ok' : '');
    for (const b of $('outSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.out === S.output));
    // what there is to set for each: the piano's MIDI and USB audio, the samples, the synth
    $('pianoBox').hidden = S.output !== 'midi';
    $('samplesBox').hidden = S.output !== 'samples';
    $('synthBox').hidden = S.output !== 'synth';
    let st = '';
    if (S.output === 'midi' && !midiOut) st = midi.error || (midi.access ? 'No piano found. Check the USB cable and that the piano is on.' : 'Press Piano to connect over MIDI.');
    else if (S.output === 'midi') st = 'Playing on ' + midiOut.name + '.';
    else if (S.output === 'samples' && !bank) st = 'No samples imported yet.';
    else if (S.output === 'samples') st = 'Playing the imported samples.';
    else st = 'Playing the built-in synth.';
    $('outStatus').textContent = st;
    $('outStatus').className = 'status' + ((S.output === 'midi' && midiOut) || (S.output === 'samples' && bank) ? ' ok' : '');
    // MIDI ports
    const sel = $('midiPort');
    const outs = midi.outputs();
    sel.innerHTML = '';
    if (!outs.length) sel.add(new Option(midi.access ? 'No MIDI outputs' : 'Not connected', ''));
    for (const p of outs) sel.add(new Option(p.name, p.id));
    if (midiOut) sel.value = midiOut.port.id;
    $('midiCh').value = S.midiCh;
    $('samplesInfo').textContent = bank
      ? bank.name + ': ' + bank.meta.notes.length + ' recordings, ' + SF.noteName(bank.meta.lo, true) + ' to ' + SF.noteName(bank.meta.hi, true) + (bank.meta.vels.length > 1 ? ', velocities ' + bank.meta.vels.join(', ') : ', velocity ' + bank.meta.vels[0])
      : 'No samples in this browser.';
    $('removeSamples').disabled = !bank;
  }
  let micEffectsTold = false;
  /** The piano's level at the mic jumps between chords, or little of it can be removed: a mic
   *  with its own automatic volume or noise suppression (Windows' effects), not the room. */
  const micEffects = (f) => !!(f && f.ready && (f.micDrift >= 7 || (f.measured > 0 && f.runCancel != null && f.runCancel < 5)));
  function updateRefUI() {
    const app = currentOutput().kind !== 'midi';
    const what = app ? 'the app’s sound' : 'the piano';
    $('refOn').checked = !!S.refOn;
    $('refBox').hidden = !S.refOn;
    $('filterGuide').checked = !!S.filterGuide;
    $('filterChord').checked = !!S.filterChord;
    $('refWhat').textContent = app
      ? 'With the ' + (currentOutput().kind === 'samples' ? 'samples' : 'built-in synth') + ' it takes the app’s own sound, which it knows exactly: nothing to connect.'
      : 'With the piano it takes the piano’s USB audio (under Sound, Piano).';
    const f = listener.filter;
    let st;
    if (!S.refOn) st = 'Off. Turn it on to sing along to ' + what + ' without headphones.';
    else if (!app && listener.phase === 'asking-ref') st = 'Chrome is asking again, this time for the piano: in its box choose Line (P-Series), then Allow.';
    else if (listener.phase === 'opening' && listener.running) st = 'Opening ' + listener.phaseName + '…';
    else if (!listener.running) st = listener.phase ? 'Waiting for the microphone first.' : 'Starts when the microphone is on.';
    else if (refNote) st = refNote;
    else if (!f) st = app ? 'Starting…' : 'Not connected to the piano’s audio: pick it under Sound, Piano.';
    else if (f.noEcho) st = 'The mic doesn’t hear ' + what + ' (headphones on?), so there is nothing to remove: it listens to the mic as it is.';
    else if (f.delayMs == null) st = 'Measuring how late ' + what + ' reaches the mic, from the chords. To start at once, press Calibrate (15 to 20 seconds, stay quiet).';
    else if (!f.ready) st = 'Delay ' + f.delayMs.toFixed(1) + ' ms. Learning the room from the chords, or press Calibrate.';
    else {
      st = 'Delay ' + f.delayMs.toFixed(1) + ' ms. Removes about ' + Math.round(f.cancelDb) + ' dB of ' + what + (f.restored ? ' (remembered from last time)' : '') + '. ';
      const need = ex ? ex.hi - ex.lo + 1 : 37;
      st += f.keys >= need ? 'Knows ' + f.keys + ' keys.' : 'Knows ' + f.keys + (f.keys === 1 ? ' key' : ' keys') + ' so far: calibrate to learn the rest.';
      // calibrating measures how much of each key is left; without that it is careful on the
      // very note the piano plays, and hears you there less readily
      if (!f.measured) st += ' Calibrate again: it now measures each key, which lets it hear you better on the notes the piano plays.';
      // the mic changing its own sound (Windows' microphone effects) defeats any filter
      if (micEffects(f)) {
        st = 'Your mic is changing its own sound as you sing (its Windows effects), so ' + what + ' can’t be removed well. In Windows, Sound settings, Input, ' + (listener.micLabel || 'your mic') + ', set Audio enhancements to Off; then calibrate again. ' + st;
        if (!micEffectsTold) {
          micEffectsTold = true;
          toast('Your mic is changing its own sound as you sing, so the filter can’t keep up. Settings, Hear me over the piano, says how to turn that off.', 8000);
        }
      }
    }
    if (S.refOn && listener.running && !filterWanted()) st = 'Not in use in ' + (player.cfg.guide ? 'Play my notes' : 'Chord only') + ' (the Filter button at the top turns it on there): the mic is heard as it is. ' + st;
    $('refStatus').textContent = st;
    $('refStatus').className = 'status' + (f && f.ready && filterWanted() ? ' ok' : '');
    $('calibBtn').disabled = !(listener.running && listener.hasRef);
    // the piano's USB audio, under Sound, Piano
    let pi = '';
    if (listener.refStream) pi = 'Open: ' + listener.refLabel + '.';
    else if (!listener.running) pi = namesHidden || !pianoFound ? 'Turn the mic on to see the inputs.' : 'Found ' + pianoFound + '.';
    else if (namesHidden) pi = 'The browser hides the inputs: press Ask Chrome for the piano’s input.';
    else if (pianoFound) pi = 'Found ' + pianoFound + (S.refOn && !app ? '.' : ': picking it turns the filter on.');
    else pi = 'Not in the list. Is the piano on and connected by USB?';
    if (!app && S.refOn && refNote) pi = refNote;
    $('refInStatus').textContent = pi;
    $('refInStatus').className = 'status' + (listener.refStream ? ' ok' : '');
    $('refAsk').hidden = !namesHidden || !!listener.refStream;
    $('fileHint').hidden = !(namesHidden && location.protocol === 'file:');
    updateFilterUI();
  }
  /** The Filter button at the top: on or off for this mode (Play my notes, Chord only), and how it's doing. */
  function updateFilterUI() {
    const b = $('filterBtn');
    if (!b) return;
    const app = currentOutput().kind !== 'midi';
    const what = app ? 'the app’s sound' : 'the piano';
    const on = !!(S.refOn && filterWanted());
    const f = listener.filter;
    let dot = '';
    let title;
    if (!S.refOn) title = 'Filter off: press to take ' + what + ' out of what the mic hears, to sing without headphones (F)';
    else if (!on) title = player.cfg.guide ? 'Filter off in Play my notes: the mic hears everything (F)' : 'Filter off in Chord only: nothing plays while you sing. Press to use it here too (F)';
    else if (!listener.running) {
      dot = 'warn';
      title = 'Filter on: starts with the mic (F)';
    } else if (!f) {
      dot = 'warn';
      title = refNote || 'Filter on: connecting to ' + what + ' (F)';
    } else if (f.noEcho) {
      dot = 'ok';
      title = 'Filter on, with nothing to remove: the mic doesn’t hear ' + what + ' (F)';
    } else if (!f.ready) {
      dot = 'warn';
      title = 'Filter on, still learning ' + what + '. Calibrate under Settings to start at once (F)';
    } else {
      dot = 'ok';
      title = 'Filter on: removes about ' + Math.round(f.cancelDb) + ' dB of ' + what + ' from the mic (F)';
    }
    b.setAttribute('aria-pressed', String(on));
    $('filterDot').className = 'dot ' + dot;
    b.title = title;
  }
  /** Use the filter in this mode or not; set up the filter first if it isn't. */
  async function toggleFilter() {
    const k = player.cfg.guide ? 'filterGuide' : 'filterChord';
    if (!S.refOn) {
      S.refOn = true;
      S[k] = true;
    } else S[k] = !S[k];
    save();
    listener.setFilterUse(filterWanted());
    updateFilterUI();
    // (with the mic off, it starts with the mic)
    if (S.refOn && S[k] && listener.running && !listener.hasRef) await refOn();
    toast(filterWanted() ? 'Filter on in ' + modeName() + '.' : 'Filter off in ' + modeName() + ': the mic hears everything.');
    updateRefUI();
  }
  const modeName = () => (player.cfg.guide ? 'Play my notes' : 'Chord only');
  function updateMetroUI() {
    $('metroBtn').setAttribute('aria-pressed', String(!!S.metro));
    $('metroBtn').title = (S.metro ? 'Metronome on' : 'Metronome') + ': clicks on the beat of the exercise (K)';
  }
  function setMetro(on) {
    S.metro = !!on;
    save();
    if (S.metro) SF.audio.resume();
    player.setMetronome(S.metro ? metronome : null);
    renderer.set({ beats: S.metro });
    updateMetroUI();
  }

  // ---------------------------------------------------------------- UI: exercise
  function buildExerciseUI() {
    $('exName').textContent = ex.name;
    $('exSub').textContent = ex.summary;
    updateTempoUI();
    // voices
    const vs = $('voiceSeg');
    vs.innerHTML = '';
    vs.hidden = ex.voices <= 1;
    if (ex.voices > 1) {
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = 'I sing';
      vs.appendChild(lbl);
      const opts = ex.voiceLabels.map((l, i) => [i, l]).concat([['any', 'Any']]);
      for (const [v, l] of opts) {
        const b = document.createElement('button');
        b.textContent = l;
        b.dataset.voice = v;
        b.title = v === 'any' ? 'All the voices play; sing whichever you like' : 'Sing the ' + l.toLowerCase() + ' voice; the others keep playing';
        b.onclick = () => setVoice(v === 'any' ? 'any' : +v);
        vs.appendChild(b);
      }
    }
    updateVoiceUI();
    buildKeyStrip();
    // exercise info and parts
    const how = {
      template: 'It repeats one round in every key: the chord at the start and end of each round is the reference, everything between is sung.',
      chords: 'Chords that stand on their own are references; the single notes are sung.',
      parts: 'Several tracks: the single-line part is sung, the others accompany it.',
      named: 'The track names say which part is sung.',
      chosen: 'You chose which parts are sung.',
      melody: 'Everything in it is sung.',
    }[ex.method];
    $('exInfo').textContent = ex.summary + ', ' + Math.round(ex.bpm) + ' bpm, ' + SF.fmtTime(ex.duration) + ' long. ' + (how || '');
    const pb = $('partsBox');
    pb.innerHTML = '';
    if (ex.parts.length > 1) {
      for (const p of ex.parts) {
        const row = document.createElement('div');
        row.className = 'field';
        const l = document.createElement('label');
        l.textContent = p.label + ' (' + p.count + ' notes, ' + SF.noteName(p.lo, true) + '–' + SF.noteName(p.hi, true) + ')';
        const sel = document.createElement('select');
        sel.add(new Option('Sung', 'sing'));
        sel.add(new Option('Accompaniment', 'acc'));
        sel.value = p.role === 'sing' ? 'sing' : 'acc';
        sel.onchange = () => setRole(p.key, sel.value);
        row.append(l, sel);
        pb.appendChild(row);
      }
    }
  }
  async function setRole(partKey, role) {
    const roles = Object.assign({}, S.rolesByEx[ex.id] || {});
    for (const p of ex.parts) roles[p.key] = roles[p.key] || (p.role === 'sing' ? 'sing' : 'acc');
    roles[partKey] = role;
    S.rolesByEx[ex.id] = roles;
    save();
    const it = library.items.find((i) => i.name === ex.id);
    const data = await it.load();
    const fresh = SF.analyze(SF.parseMidi(data), { roles });
    fresh.id = ex.id;
    fresh.name = ex.name;
    ex = fresh;
    player.load(ex, { bpm: S.bpmByEx[ex.id] || ex.bpm });
    scorer.reset();
    renderer.fit(ex);
    buildExerciseUI();
  }
  function setVoice(v) {
    player.set({ voice: v });
    S.voiceByEx[ex.id] = v;
    save();
    updateVoiceUI();
    updateKeyStrip();
  }
  function updateVoiceUI() {
    for (const b of $('voiceSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String(String(player.cfg.voice) === b.dataset.voice));
  }
  function buildKeyStrip() {
    const k = $('keys');
    k.innerHTML = '';
    if (!ex) return;
    ex.rounds.forEach((r) => {
      const b = document.createElement('button');
      b.textContent = r.label;
      b.dataset.r = r.i;
      b.title =
        (r.key && ex.structure === 'rounds' ? SF.keyLabel(r.key) + '. ' : '') +
        (r.singLo != null ? 'You sing ' + SF.noteName(r.singLo, true) + ' to ' + SF.noteName(r.singHi, true) + '.' : '');
      const bar = document.createElement('span');
      bar.className = 'bar-score';
      b.appendChild(bar);
      b.onclick = () => {
        player.seekRound(r.i);
        updateKeyStrip(true);
      };
      k.appendChild(b);
    });
    updateKeyStrip(true);
  }
  let lastCur = -1;
  function updateKeyStrip(scroll) {
    if (!ex) return;
    const cur = player.currentRound();
    const buttons = $('keys').children;
    for (const b of buttons) {
      const r = +b.dataset.r;
      const res = scorer.byRound.get(r);
      let cls = '';
      if (res && S.feedback === 'all') cls = res.score >= 0.85 ? 's-hit' : res.score >= 0.6 ? 's-close' : 's-off';
      b.className = (r === cur ? 'cur ' : '') + cls + (player.cfg.skip && !player.eligible(r) ? ' out-of-range' : '');
    }
    if ((scroll || cur !== lastCur) && buttons[cur]) buttons[cur].scrollIntoView({ block: 'nearest', inline: 'center' });
    lastCur = cur;
  }

  // ---------------------------------------------------------------- HUD
  let hudAt = 0;
  let tunerAt = 0;
  function updateHUD() {
    const now = SF.now();
    if (now - tunerAt >= 33) {
      tunerAt = now;
      updateTuner();
    }
    if (now - hudAt < 120) return;
    hudAt = now;
    if (S.refOn && $('set').classList.contains('open')) updateRefUI();
    else updateFilterUI();
    placeBox();
    if (!ex) {
      $('hudKey').textContent = '';
      $('hudInfo').textContent = '';
      return;
    }
    const r = player.currentRound();
    const rd = ex.rounds[r];
    $('hudKey').textContent = rd && rd.key ? SF.keyLabel(rd.key) : '';
    const P = player.position();
    const seg = player.segmentAt(P, true);
    const into = seg && seg.kind === 'round' ? Math.max(0, P - seg.P0) : 0;
    const t = rd ? rd.s0 + into : 0;
    const unit = ex.structure === 'rounds' ? 'Key' : 'Part';
    let info = unit + ' ' + (r + 1) + ' of ' + ex.rounds.length + ', ' + SF.fmtTime(t / player.speed) + ' of ' + SF.fmtTime(ex.duration / player.speed);
    if (player.cfg.loop) info += ', repeating';
    if (player.cfg.subset && player.cfg.subset.length) info += ', weak keys only';
    $('hudInfo').textContent = info;
    if (r !== lastCur) updateKeyStrip();
  }

  // ---------------------------------------------------------------- the box
  // On the right; or, if you like, out of the way of the notes: decided once per key, so
  // it doesn't jump about, and on the right whenever the left is no better.
  let boxRound = -2;
  function placeBox(force) {
    const tuner = $('tuner');
    const show = S.feedback === 'all';
    tuner.hidden = !show;
    if (!show) return;
    const r = ex ? player.currentRound() : -1;
    if (!force && r === boxRound) return;
    boxRound = r;
    let side = 'right';
    if (S.boxPlace === 'move' && ex && ex.rounds[r]) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const n of ex.rounds[r].notes) {
        lo = Math.min(lo, n.pitch);
        hi = Math.max(hi, n.pitch);
      }
      const W = renderer.W;
      const bw = tuner.offsetWidth || 250;
      const a = renderer.xOf(lo) - renderer.sxTarget - renderer.ww;
      const b = renderer.xOf(hi) - renderer.sxTarget + renderer.ww;
      const covers = (x0, x1) => b > x0 && a < x1;
      if (covers(W - 18 - bw, W - 18) && !covers(18, 18 + bw)) side = 'left';
    }
    if (side === 'left') {
      const W = $('stage').clientWidth;
      const top = $('hudLeft').offsetHeight + 10;
      tuner.style.transform = 'translate(' + -(W - tuner.offsetWidth - 36) + 'px,' + top + 'px)';
    } else tuner.style.transform = '';
    tuner.dataset.side = side;
  }

  /** The big readout of what you are singing. */
  let zonesTol = null;
  function updateTuner() {
    if (S.feedback !== 'all') return;
    const lv = scorer.live;
    const tuner = $('tuner');
    if (zonesTol !== S.tol) {
      // the meter spans ±100 cents; green is the tolerance, amber twice it
      zonesTol = S.tol;
      const g1 = 50 - S.tol / 2;
      const g2 = 50 + S.tol / 2;
      const a1 = Math.max(0, 50 - S.tol);
      const a2 = Math.min(100, 50 + S.tol);
      $('tZones').style.background =
        'linear-gradient(90deg, var(--off) 0 ' + a1 + '%, var(--close) ' + a1 + '% ' + g1 + '%, var(--hit) ' + g1 + '% ' + g2 + '%, var(--close) ' + g2 + '% ' + a2 + '%, var(--off) ' + a2 + '% 100%)';
    }
    const needle = $('tNeedle');
    let state = 'idle';
    let target = '';
    let syl = '';
    let noteTxt = '–';
    let centsTxt = '';
    let stateTxt;
    const rd = ex ? ex.rounds[player.currentRound()] : null;
    const sylOf = (m) => (rd && rd.key ? SF.solfege(m, rd.key.doPc) : '');
    if (!listener.running) {
      target = 'Mic off';
      stateTxt = 'Press M to listen';
    } else if (SF.audio.exists && SF.audio.ctx.state !== 'running') {
      target = 'Mic ready';
      stateTxt = 'Click or press a key to start listening';
    } else if (lv.listening && lv.target != null) {
      target = 'Sing ' + SF.noteName(lv.target, rd && rd.key ? rd.key.flats : true);
      syl = sylOf(lv.target);
      if (lv.midi != null) {
        noteTxt = SF.noteName(Math.round(lv.midi), true);
        centsTxt = SF.fmtCents(lv.cents);
        state = lv.status;
        needle.style.left = SF.clamp(50 + (lv.cents / 100) * 50, 1, 99) + '%';
        needle.style.color = 'var(--' + lv.status + ')';
        needle.style.background = 'var(--' + lv.status + ')';
      }
      stateTxt =
        lv.source === 'learning'
          ? 'Learning, not scored yet'
          : lv.source === 'unsure'
            ? 'Too much piano to hear you'
            : lv.source === 'piano'
              ? 'Hearing only the piano'
              : lv.midi == null
                ? 'Not hearing you'
                : 'Listening';
    } else {
      // between notes: say what is coming
      const next = nextTarget();
      if (next) {
        // in the key of the round it belongs to, which may be the next one
        target = 'Next ' + SF.noteName(next.pitch, next.key ? next.key.flats : true);
        syl = next.key ? SF.solfege(next.pitch, next.key.doPc) : '';
      }
      stateTxt = player.state === 'playing' ? (lv.listening ? 'Listening' : 'Chord, not judged') : 'Paused';
    }
    tuner.className = 'tuner ' + state;
    $('tTarget').textContent = target;
    $('tSyl').textContent = syl;
    $('tNote').textContent = noteTxt;
    $('tCents').textContent = centsTxt;
    needle.classList.toggle('on', state !== 'idle' && state !== 'silent');
    const st = $('tState');
    st.textContent = stateTxt;
    st.className = lv.listening && listener.running ? 'on' : '';
    const last = scorer.last;
    const tl = $('tLast');
    if (last && listener.running && last.res.status !== 'none') {
      const r = last.res;
      tl.textContent = 'Last ' + (r.status === 'hit' ? '✓ ' + SF.fmtCents(r.cents) : r.status === 'silent' ? 'not heard' : SF.fmtCents(r.cents));
      tl.style.color = 'var(--' + (r.status === 'none' ? 'silent' : r.status) + ')';
    } else tl.textContent = '';
  }
  function nextTarget() {
    if (!ex) return null;
    const P = player.position();
    let best = null;
    player.forNotes(P, P + 4 * player.speed, (n, seg, P0) => {
      if (P0 >= P && player.isTarget(n) && (!best || P0 < best.P0)) best = { pitch: n.pitch, P0, key: ex.rounds[seg.r].key };
    });
    return best;
  }

  // ---------------------------------------------------------------- toasts, drawers
  let toastTimer = null;
  function toast(html, ms) {
    const t = $('toast');
    t.innerHTML = html;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms || 3200);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function openDrawer(id) {
    const d = $(id);
    const open = !d.classList.contains('open');
    closeDrawers();
    if (!open) return;
    d.classList.add('open');
    if (id === 'res') renderResults();
    if (id === 'lib') renderLibrary();
    if (id === 'set') {
      updateRefUI();
      fillDevices().then(updateRefUI);
    }
  }
  function closeDrawers() {
    for (const d of document.querySelectorAll('.drawer.open')) d.classList.remove('open');
    $('help').hidden = true;
  }
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closeDrawers);
  $('help').addEventListener('click', (e) => {
    if (e.target === $('help')) closeDrawers();
  });

  // ---------------------------------------------------------------- library UI
  function renderFolderBox() {
    const box = $('folderBox');
    box.innerHTML = '';
    const f = library.folder;
    if (!library.canLink) {
      const b = document.createElement('button');
      b.textContent = 'Open a folder (this visit only)';
      b.onclick = () => $('dirIn').click();
      box.append(b);
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'This browser cannot remember folders. Chrome or Edge can, and then new exercises appear on their own.';
      box.append(p);
      return;
    }
    if (!f) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = 'Link exercise folder';
      b.onclick = linkFolder;
      box.append(b);
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Pick the folder the generator writes to. It is read again every time you open this list, so new exercises just appear.';
      box.append(p);
      return;
    }
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.innerHTML = 'Folder <b>' + esc(f.name) + '</b>';
    row.append(name);
    if (f.state !== 'granted') {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = 'Allow reading it again';
      b.onclick = async () => {
        await library.reconnect();
        renderLibrary();
      };
      row.append(b);
    } else {
      const b = document.createElement('button');
      b.textContent = 'Rescan';
      b.onclick = async () => {
        await library.refresh();
        renderLibrary();
      };
      row.append(b);
    }
    const u = document.createElement('button');
    u.className = 'link';
    u.textContent = 'Unlink';
    u.onclick = async () => {
      await library.unlink();
      renderLibrary();
    };
    row.append(u);
    box.append(row);
  }
  async function linkFolder() {
    try {
      await library.linkFolder();
      renderLibrary();
      openDrawer('lib');
      if (!$('lib').classList.contains('open')) openDrawer('lib');
    } catch (e) {
      if (e.name !== 'AbortError') toast('Could not open that folder: ' + e.message);
    }
  }
  const infoCache = new Map();
  function renderLibrary() {
    renderFolderBox();
    const list = $('libList');
    const q = $('libSearch').value.trim().toLowerCase();
    list.innerHTML = '';
    const items = library.items.filter((it) => !q || it.name.toLowerCase().includes(q));
    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = library.items.length ? 'Nothing matches.' : 'No exercises yet. Link the folder or add MIDI files.';
      list.append(p);
    }
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'lib-item' + (ex && ex.id === it.name ? ' cur' : '');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = SF.prettyName(it.name);
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = it.source === 'folder' ? 'folder' : 'saved';
      const m = document.createElement('span');
      m.className = 'm';
      m.textContent = '…';
      b.append(t, tag, m);
      b.onclick = () => openExercise(it.id);
      list.append(b);
      const key = it.id + '|' + it.size + '|' + it.lastModified;
      const show = (info) => {
        if (info.error) {
          m.textContent = 'Could not read: ' + info.error;
          return;
        }
        const hist = SF.History.forExercise(it.name);
        const last = hist.length ? hist[hist.length - 1] : null;
        m.textContent = info.summary + ', ' + Math.round(info.bpm) + ' bpm, ' + SF.fmtTime(info.duration) + (last ? '. Last time ' + Math.round(last.score * 100) + '%' : '');
        if (info.voices > 1) {
          tag.textContent = info.voices + ' voices';
          tag.classList.add('voices');
        }
      };
      if (infoCache.has(key)) show(infoCache.get(key));
      else
        library.info(it.id).then((info) => {
          infoCache.set(key, info);
          show(info);
        });
    }
  }
  library.on('change', () => {
    if ($('lib').classList.contains('open')) renderLibrary();
  });

  // ---------------------------------------------------------------- results UI
  let resTab = 'run';
  function renderResults() {
    const hist = ex ? SF.History.forExercise(ex.id) : [];
    for (const b of $('resTabs').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.tab === resTab));
    $('resRun').hidden = resTab !== 'run';
    $('resTime').hidden = resTab !== 'time';
    const noteName = (m) => SF.noteName(m, true);
    if (resTab === 'run') {
      const ses = scorer.session;
      const live = ses.rounds.length || ses.notes.length;
      let run = live ? { notes: ses.notes, rounds: latestPerKey(ses.rounds), started: ses.started, bpm: Math.round(player.bpm), live: true } : lastRun && ex && lastRun.ex === ex.id ? lastRun : null;
      // after opening the app again: the last run saved, from what was kept of it
      const saved = hist[hist.length - 1];
      if (!run && saved && saved.bd)
        run = {
          summary: SF.Report.fromCompact(saved.bd),
          rounds: (saved.rounds || []).map((r) => ({ r: r.r, label: r.l, n: r.n, hit: r.h, close: r.c, off: r.o, silent: r.s, cents: r.ct, score: r.n ? (r.h + 0.5 * r.c) / r.n : 0 })),
          started: saved.t,
          bpm: saved.bpm,
        };
      SF.ResultsView.renderRun($('resRun'), run, hist, { noteName, onWeak: practiseWeak, onAll: allKeys });
    } else SF.ResultsView.renderTime($('resTime'), hist, { noteName, onCsv: exportCsv, onClear: clearHistory });
  }
  for (const b of $('resTabs').querySelectorAll('button')) {
    b.onclick = () => {
      resTab = b.dataset.tab;
      renderResults();
    };
  }
  function practiseWeak() {
    const weak = [...scorer.byRound.values()].filter((r) => r.score < 0.7).map((r) => r.r);
    if (!weak.length) return toast(scorer.byRound.size ? 'No weak keys: every key so far is at 70% or better.' : 'Sing some keys first.');
    player.set({ subset: weak, loop: false });
    S.loop = false;
    updateLoopUI();
    player.seekRound(weak[0], { preroll: S.preroll });
    toast('Practising ' + weak.length + ' weak ' + (weak.length === 1 ? 'key' : 'keys') + '.');
    closeDrawers();
  }
  function allKeys() {
    player.set({ subset: null });
    toast('All keys again.');
  }
  function exportCsv() {
    const blob = new Blob([SF.History.csv()], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'scales-feedback-results.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function clearHistory() {
    if (!ex || !confirm('Clear the saved results of ' + ex.name + '?')) return;
    SF.History.clear(ex.id);
    if (lastRun && lastRun.ex === ex.id) lastRun = null;
    renderResults();
  }
  function showSummary() {
    const rows = scorer.session.rounds.length ? scorer.session.rounds : [...scorer.byRound.values()];
    if (!rows.length) return;
    const total = rows.reduce((s, r) => s + r.n, 0);
    const pts = rows.reduce((s, r) => s + r.hit + 0.5 * r.close, 0);
    toast('<span class="big">Done: ' + Math.round((100 * pts) / Math.max(1, total)) + '%</span><br>' + rows.length + ' keys. Press R for the details.', 5000);
  }

  // ---------------------------------------------------------------- devices
  async function fillDevices() {
    let ds = [];
    try {
      ds = await listener.devices();
    } catch (e) {
      ds = [];
    }
    const mic = $('micSel');
    const ref = $('refSel');
    mic.innerHTML = '';
    ref.innerHTML = '';
    const named = ds.filter((d) => d.label);
    namesHidden = !named.length;
    if (!named.length) {
      mic.add(new Option(listener.running ? listener.micLabel || 'Microphone' : 'Turn the mic on to see the inputs', ''));
      if (listener.refStream) ref.add(new Option(listener.refLabel || 'Piano', listener.refId || ''));
      else ref.add(new Option(listener.running ? 'Hidden by the browser: use the button below' : 'Turn the mic on to see the inputs', ''));
    } else ref.add(new Option('Choose the input…', ''));
    for (const d of named) {
      mic.add(new Option(d.label + (d.piano ? ' (the piano, not a mic)' : d.headset ? ' (headset)' : ''), d.id));
      // the mic itself can't be the piano's reference
      if (d.id !== listener.micId) ref.add(new Option(d.label + (d.piano ? ' (the piano)' : ''), d.id));
    }
    // the open mic is always shown by name, even if the browser's list doesn't have it
    if (listener.running && listener.micId && !named.some((d) => d.id === listener.micId)) mic.add(new Option(listener.micLabel || 'Microphone', listener.micId), 0);
    else if (listener.running && !listener.micId) mic.add(new Option(listener.micLabel || 'Microphone', ''), 0);
    if (listener.running) mic.value = listener.micId || '';
    else if (S.micId && named.some((d) => d.id === S.micId)) mic.value = S.micId;
    if (listener.refStream && listener.refId && ![...ref.options].some((o) => o.value === listener.refId)) ref.add(new Option(listener.refLabel || 'Piano', listener.refId));
    // only an input that is actually open shows as chosen: picking the same entry again
    // isn't a change to the browser, so it has to start from "Choose the input…"
    ref.value = listener.refStream && listener.refId ? listener.refId : '';
    pianoFound = (named.find((d) => d.piano && d.id !== listener.micId) || {}).label || '';
  }

  // ---------------------------------------------------------------- calibration
  async function calibrate() {
    if (calibrating) return;
    if (!(listener.running && listener.hasRef)) return toast('Turn on the mic and Hear me over the piano first.');
    const out = currentOutput();
    player.pause();
    calibrating = true;
    // (it learns from every frame of the calibration, in either mode)
    listener.setFilterUse(true);
    listener.sendPlan();
    $('calib').hidden = false;
    $('calibWhat').textContent = out.kind === 'midi' ? 'The piano plays a run of notes so the app can learn how it sounds in your room.' : 'The app plays a run of notes so it can learn how its sound reaches your mic.';
    const tap = tapOut;
    const lo = ex ? SF.clamp(ex.lo - 2, 28, 72) : 40;
    const hi = ex ? SF.clamp(ex.hi + 2, lo + 12, 96) : 76;
    const plan = SF.calibrationNotes(lo, hi, S.velAcc, S.velSing);
    const t0 = SF.now() + 600;
    for (const n of plan.notes) {
      tap.noteOn(n.p, n.vel, t0 + n.t);
      tap.noteOff(n.p, t0 + n.t + n.d);
    }
    const end = t0 + plan.dur;
    await new Promise((res) => {
      const tick = () => {
        const f = SF.clamp((SF.now() - t0 + 600) / (end - t0 + 600), 0, 1);
        $('calibProg').style.width = f * 100 + '%';
        if (SF.now() >= end) res();
        else setTimeout(tick, 100);
      };
      tick();
    });
    calibrating = false;
    listener.setFilterUse(filterWanted());
    listener.sendPlan();
    $('calib').hidden = true;
    const f = listener.filter;
    const what = out.kind === 'midi' ? 'The piano is' : 'The app’s sound is';
    if (f && f.noEcho) toast('The mic doesn’t hear ' + (out.kind === 'midi' ? 'the piano' : 'the app’s sound') + ' (headphones on?): there’s nothing to remove, so it listens to the mic as it is.', 6000);
    else if (f && f.ready) {
      toast('<span class="big">Learned</span><br>' + what + ' about ' + Math.round(f.cancelDb) + ' dB quieter in what the app hears.');
      listener.saveRoom(); // arrives as a 'room' event, which stores it
    } else toast('Could not hear ' + (out.kind === 'midi' ? 'the piano' : 'the app’s sound') + ' through the mic. Turn it up a little, check the inputs, and calibrate again.');
    updateRefUI();
  }

  // ---------------------------------------------------------------- wake lock
  async function holdWake() {
    try {
      if (navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      wakeLock = null;
    }
  }
  function releaseWake() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  // ---------------------------------------------------------------- controls
  $('libBtn').onclick = () => openDrawer('lib');
  $('setBtn').onclick = () => openDrawer('set');
  $('resBtn').onclick = () => openDrawer('res');
  $('outBtn').onclick = () => openDrawer('set');
  $('helpBtn').onclick = () => ($('help').hidden = !$('help').hidden);
  $('playBtn').onclick = togglePlay;
  $('prevBtn').onclick = () => ex && player.prev();
  $('nextBtn').onclick = () => ex && player.next();
  $('restartBtn').onclick = () => ex && player.restart();
  $('bpmDown').onclick = (e) => setBpm(player.bpm - (e.shiftKey ? 1 : 5));
  $('bpmUp').onclick = (e) => setBpm(player.bpm + (e.shiftKey ? 1 : 5));
  $('bpmIn').onchange = () => setBpm(+$('bpmIn').value || player.bpm);
  $('bpmReset').onclick = () => ex && setBpm(ex.bpm);
  for (const b of $('guideSeg').querySelectorAll('button')) {
    b.onclick = () => {
      S.guide = b.dataset.guide === 'on';
      player.set({ guide: S.guide });
      save();
      updateGuideUI();
      // the filter as set for this mode (by default on in Play my notes, off in Chord only)
      listener.setFilterUse(filterWanted());
      updateRefUI();
    };
  }
  $('filterBtn').onclick = toggleFilter;
  $('metroBtn').onclick = () => setMetro(!S.metro);
  $('loopBtn').onclick = () => {
    S.loop = !player.cfg.loop;
    player.set({ loop: S.loop });
    save();
    updateLoopUI();
  };
  $('micBtn').onclick = () => (listener.running ? micOff() : micOn());
  for (const b of $('outSeg').querySelectorAll('button')) {
    b.onclick = async () => {
      const o = b.dataset.out;
      if (o === 'midi') {
        S.output = 'midi';
        if (!midi.access) await midi.connect();
        refreshMidi();
      } else if (o === 'samples' && !bank) {
        $('zipIn').click();
        return;
      } else {
        S.output = o;
        S.localOut = o;
      }
      save();
      applyOutput();
    };
  }
  $('midiPort').onchange = () => {
    S.midiPort = $('midiPort').value || null;
    save();
    if (midiOut) midiOut.allOff();
    midiOut = null;
    refreshMidi();
  };
  for (let c = 0; c < 16; c++) $('midiCh').add(new Option(String(c + 1), c));
  $('midiCh').onchange = () => {
    S.midiCh = +$('midiCh').value;
    save();
    if (midiOut) midiOut.allOff();
    midiOut = null;
    refreshMidi();
  };
  $('importSamples').onclick = () => $('zipIn').click();
  $('zipIn').onchange = async () => {
    const f = $('zipIn').files[0];
    $('zipIn').value = '';
    if (!f) return;
    try {
      $('samplesInfo').textContent = 'Reading ' + f.name + '…';
      const meta = await SF.importSamplesZip(f, (d, n) => ($('samplesInfo').textContent = 'Importing ' + d + ' of ' + n + '…'));
      bank = new SF.SampleBank(meta);
      S.output = 'samples';
      S.localOut = 'samples';
      save();
      applyOutput();
      toast('Imported ' + meta.notes.length + ' recordings.');
    } catch (e) {
      toast('Could not import the samples: ' + e.message);
      updateOutputUI();
    }
  };
  $('removeSamples').onclick = async () => {
    if (!bank || !confirm('Remove the imported samples from this browser?')) return;
    await SF.removeSamples();
    bank = null;
    if (S.output === 'samples') S.output = 'synth';
    S.localOut = 'synth';
    save();
    applyOutput();
  };
  const bindRange = (id, key, fmt, apply) => {
    const el = $(id);
    el.value = S[key];
    $(id + 'V').textContent = fmt(S[key]);
    el.oninput = () => {
      S[key] = +el.value;
      $(id + 'V').textContent = fmt(S[key]);
      apply(S[key]);
    };
    el.onchange = () => {
      save();
      el.blur(); // arrow keys go back to the transport
    };
  };
  bindRange('velAcc', 'velAcc', (v) => v, (v) => player.set({ velAcc: v }));
  bindRange('velSing', 'velSing', (v) => v, (v) => player.set({ velSing: v }));
  bindRange('gate', 'gate', (v) => v + ' dB', (v) => listener.setGate(v));
  bindRange('tol', 'tol', (v) => '±' + v + '¢', (v) => scorer.set({ tolerance: v }));
  bindRange('grace', 'grace', (v) => v + ' ms', (v) => scorer.set({ grace: v / 1000, endGrace: v / 1000 }));
  bindRange('lat', 'latency', (v) => v + ' ms', (v) => scorer.set({ latency: v }));
  bindRange('preroll', 'preroll', (v) => v + ' s', (v) => player.set({ preroll: v }));
  bindRange('ahead', 'ahead', (v) => v + ' s', (v) => renderer.set({ lookahead: v }));
  const bindCheck = (id, key, apply) => {
    const el = $(id);
    el.checked = !!S[key];
    el.onchange = () => {
      S[key] = el.checked;
      save();
      apply(S[key]);
    };
  };
  bindCheck('octFree', 'octFree', (v) => scorer.set({ octaveFree: v }));
  bindCheck('skipOn', 'skip', (v) => {
    player.set({ skip: v });
    updateKeyStrip();
  });
  bindCheck('shuffleOn', 'shuffle', (v) => player.set({ shuffle: v }));
  bindCheck('histOn', 'hist', (v) => {
    renderer.set({ history: v });
    placeBox(true);
  });
  bindCheck('pedalOn', 'pedal', () => {});
  bindRange('metroVol', 'metroVol', (v) => v + '%', (v) => metronome.setVolume(v / 100));
  bindCheck('filterGuide', 'filterGuide', () => {
    listener.setFilterUse(filterWanted());
    updateRefUI();
  });
  bindCheck('filterChord', 'filterChord', () => {
    listener.setFilterUse(filterWanted());
    updateRefUI();
  });
  // ---- the view
  function setView(view, whites) {
    S.kbView = view;
    if (whites != null) S.kbWhites = SF.clamp(Math.round(whites), 8, 52);
    save();
    renderer.set({ view: S.kbView, whites: S.kbWhites });
    updateViewUI();
    placeBox(true);
  }
  function updateViewUI() {
    $('kbView').value = S.kbView;
    $('kbWhites').value = S.kbWhites;
    $('kbWhitesV').textContent = S.kbWhites + ' white keys';
    $('kbWhitesRow').hidden = S.kbView !== 'zoom';
    $('feedback').value = S.feedback;
    $('boxPlace').value = S.boxPlace;
    $('boxPlaceRow').hidden = S.feedback !== 'all';
  }
  $('kbView').onchange = () => setView($('kbView').value, $('kbView').value === 'zoom' ? (renderer.zoomed ? S.kbWhites : renderer.whitesShown()) : null);
  $('kbWhites').oninput = () => setView('zoom', +$('kbWhites').value);
  $('kbWhites').onchange = () => $('kbWhites').blur();
  /** Closer (dir -1: fewer keys across) or further (+1), from what shows now. */
  function zoomBy(dir) {
    const now = renderer.whitesShown();
    const n = now + dir * Math.max(1, Math.round(now * 0.12));
    if (dir > 0) {
      // further out: the whole exercise, then all 88 keys
      if (S.kbView === 'zoom') return n >= renderer.fitWhites() ? setView('fit') : setView('zoom', n);
      if (S.kbView === 'fit') setView('all');
      return;
    }
    if (n >= 8) setView('zoom', n);
  }
  $('kbReset').onclick = () => {
    S.kbFrac = null;
    S.histFrac = null;
    save();
    renderer.set({ kbFrac: null, histFrac: null });
    placeBox(true);
  };
  function setFeedback(f) {
    S.feedback = f;
    save();
    renderer.set({ feedback: f });
    updateViewUI();
    updateKeyStrip();
    placeBox(true);
  }
  $('feedback').onchange = () => setFeedback($('feedback').value);
  $('boxPlace').onchange = () => {
    S.boxPlace = $('boxPlace').value;
    save();
    placeBox(true);
  };
  $('refOn').checked = !!S.refOn;
  $('refOn').onchange = async () => {
    S.refOn = $('refOn').checked;
    if (S.refOn) S.filterGuide = true; // (Chord only keeps its own setting)
    listener.setFilterUse(filterWanted());
    save();
    if (S.refOn) {
      if (!listener.running) await micOn();
      else await refOn();
    } else {
      refNote = '';
      await serial(() => listener.setReference(null));
    }
    updateRefUI();
    updateMicUI();
  };
  // picking the piano's input means using it: the filter turns on and the input opens,
  // so its level bar shows right away whether it hears the piano
  $('refSel').onchange = async () => {
    const id = $('refSel').value || null;
    if (!id) return;
    S.refId = id;
    S.refOn = true;
    S.filterGuide = true;
    listener.setFilterUse(filterWanted());
    save();
    updateRefUI();
    if (listener.running) await refOn();
    else await micOn();
    updateRefUI();
    updateMicUI();
  };
  // picking a mic opens it straight away (even the piano's input, if that's really wanted)
  $('micSel').onchange = async () => {
    const id = $('micSel').value || null;
    if (!id) return;
    S.micId = id;
    save();
    await micOn(id);
  };
  // when the browser hides the inputs: ask it for the piano's input (its box lets you choose)
  $('refAsk').onclick = async () => {
    S.refOn = true;
    S.filterGuide = true;
    listener.setFilterUse(filterWanted());
    save();
    askedPianoThisVisit = false;
    if (!listener.running) await micOn();
    else await refOn();
    updateRefUI();
    updateMicUI();
  };
  // "Save the last 40 seconds": both inputs as a sound file (mic left, the piano's audio right,
  // and what differs between the piano's two channels third when it is stereo), with what the
  // app decided about every moment inside it, to tune the filter
  $('recSave').onclick = async () => {
    let d;
    try {
      d = await listener.dump();
    } catch (e) {
      return toast('Turn on the mic (and the piano filter) and sing a little first.');
    }
    d.meta.app = { exercise: ex ? ex.name : null, voice: player.cfg.voice, guide: player.cfg.guide, bpm: player.bpm, velAcc: S.velAcc, velSing: S.velSing, grace: S.grace, tol: S.tol, latency: S.latency, mic: listener.micLabel, piano: listener.refName, output: currentOutput().kind, metronome: !!S.metro, filterInUse: filterWanted(), at: new Date().toISOString() };
    const blob = SF.wavWithData(d.mic, d.ref, d.meta.sr, d.meta, d.side);
    const name = 'scales-feedback-take-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.wav';
    try {
      if (window.showSaveFilePicker) {
        const h = await window.showSaveFilePicker({ suggestedName: name, startIn: 'downloads', types: [{ description: 'Sound file', accept: { 'audio/wav': ['.wav'] } }] });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        return toast('Saved ' + esc(h.name) + '.');
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // closed the save box
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Saved ' + esc(name) + ' to your downloads.');
  };
  $('devReport').onclick = async () => {
    const extra = [
      'app settings: mic ' + (S.micOn ? 'on' : 'off') + ', filter ' + (S.refOn ? 'on' : 'off') + ' (play my notes ' + (S.filterGuide ? 'on' : 'off') + ', chord only ' + (S.filterChord ? 'on' : 'off') + ', now ' + (filterWanted() ? 'in use' : 'not in use') + '), output ' + S.output + ', metronome ' + (S.metro ? 'on' : 'off'),
      'mic line: ' + $('micStatus').textContent,
      'filter line: ' + $('refStatus').textContent,
      'piano input line: ' + $('refInStatus').textContent,
    ];
    const text = await listener.report(extra);
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        copied = document.execCommand('copy');
      } catch (e2) {
        copied = false;
      }
      ta.remove();
    }
    $('devReportOut').hidden = copied;
    $('devReportOut').value = text;
    toast(copied ? 'Copied the device report. Paste it into your message.' : 'Select the report below and copy it.');
  };
  $('calibBtn').onclick = calibrate;
  $('refForget').onclick = async () => {
    try {
      await SF.idb.del('kv', roomKey());
    } catch (e) {
      /* fine */
    }
    listener.forgetRoom();
    updateRefUI();
  };
  const rangeIn = (id, key) => {
    const el = $(id);
    el.value = SF.noteName(S[key], true).replace('♭', 'b').replace('♯', '#');
    el.onchange = () => {
      const m = SF.parseNote(el.value);
      if (!isFinite(m)) {
        el.value = SF.noteName(S[key], true).replace('♭', 'b');
        return toast('Write a note like E2 or Bb4.');
      }
      S[key] = m;
      save();
      player.set({ lo: S.rangeLo, hi: S.rangeHi });
      updateKeyStrip();
    };
  };
  rangeIn('rangeLo', 'rangeLo');
  rangeIn('rangeHi', 'rangeHi');
  $('labels').value = S.labels;
  $('labels').onchange = () => {
    S.labels = $('labels').value;
    renderer.set({ labels: S.labels });
    save();
  };
  $('addFilesBtn').onclick = () => $('fileIn').click();
  $('emptyAdd').onclick = () => $('fileIn').click();
  $('emptyLink').onclick = async () => {
    if (!library.canLink) return $('dirIn').click();
    if (library.folder && library.folder.state !== 'granted') {
      await library.reconnect();
      renderLibrary();
      if (library.folder && library.folder.state === 'granted') {
        $('emptyLink').textContent = 'Link exercise folder';
        if (!ex) await openLast();
        if (!ex) openDrawer('lib');
      }
      return;
    }
    linkFolder();
  };
  $('fileIn').onchange = async () => {
    const ids = await library.addFiles($('fileIn').files);
    $('fileIn').value = '';
    if (ids.length === 1) openExercise(ids[0]);
    else renderLibrary();
  };
  $('dirIn').onchange = async () => {
    library.session = [];
    for (const f of $('dirIn').files) {
      if (/\.(mid|midi)$/i.test(f.name)) library.session.push({ name: f.name, data: await f.arrayBuffer(), lastModified: f.lastModified, size: f.size });
    }
    await library.refresh();
    renderLibrary();
    openDrawer('lib');
  };
  $('libSearch').oninput = renderLibrary;

  // ---------------------------------------------------------------- the picture, by hand
  // Drag the keyboard's top or bottom edge to make it (or the strip under it) taller; click
  // or drag along the keys to play them; drag the notes sideways (or wheel) to scroll when
  // zoomed in; Ctrl + wheel (or pinch) zooms.
  const cv = $('cv');
  let grab = null;
  const at = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  async function pressKey(p) {
    SF.audio.resume();
    held.add(p);
    renderer.pressed.add(p);
    const out = tapOut;
    if (!out) return;
    if (out.kind === 'samples' && bank) {
      const sm = bank.pick(p, S.velSing);
      if (sm && !bank.cache.has(sm.key)) await bank.prepare([p]);
      if (!held.has(p)) return; // let go already
    }
    out.noteOn(p, S.velSing, SF.now());
  }
  function releaseKey(p) {
    if (!held.has(p)) return;
    held.delete(p);
    lastKeyAt = SF.now();
    renderer.pressed.delete(p);
    if (tapOut) tapOut.noteOff(p, SF.now());
  }
  function releaseAll() {
    for (const p of [...held]) releaseKey(p);
  }
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const { x, y } = at(e);
    const edge = renderer.edgeAt(y);
    if (edge) grab = { kind: 'edge', edge };
    else if (renderer.inScrollbar(y)) {
      grab = { kind: 'bar' };
      renderer.scrollbarTo(x);
    } else {
      const k = renderer.keyAt(x, y);
      if (k != null) {
        grab = { kind: 'key', key: k };
        pressKey(k);
      } else if (renderer.zoomed) grab = { kind: 'scroll', x0: x, sx0: renderer.sx };
    }
    if (grab) {
      cv.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  });
  cv.addEventListener('pointermove', (e) => {
    const { x, y } = at(e);
    if (!grab) {
      // say what a press would do
      const edge = renderer.edgeAt(y);
      cv.style.cursor = edge ? 'ns-resize' : renderer.keyAt(x, y) != null ? 'pointer' : renderer.zoomed && y < renderer.yNow ? 'grab' : renderer.inScrollbar(y) ? 'pointer' : '';
      return;
    }
    if (grab.kind === 'edge') {
      const fr = renderer.dragEdge(grab.edge, y);
      if (fr) {
        S.kbFrac = fr.kbFrac;
        S.histFrac = fr.histFrac;
      }
    } else if (grab.kind === 'key') {
      // a glissando: along the keys, whatever the height
      const k = renderer.keyAt(x, SF.clamp(y, renderer.yNow + 1, renderer.yNow + renderer.kbH * 0.95));
      if (k != null && k !== grab.key) {
        releaseKey(grab.key);
        grab.key = k;
        pressKey(k);
      }
    } else if (grab.kind === 'scroll') {
      cv.style.cursor = 'grabbing';
      renderer.scrollTo(grab.sx0 - (x - grab.x0));
    } else if (grab.kind === 'bar') renderer.scrollbarTo(x);
  });
  const letGo = () => {
    if (!grab) return;
    if (grab.kind === 'key') releaseKey(grab.key);
    if (grab.kind === 'edge') {
      save();
      placeBox(true);
    }
    grab = null;
    cv.style.cursor = '';
  };
  cv.addEventListener('pointerup', letGo);
  cv.addEventListener('pointercancel', letGo);
  cv.addEventListener('lostpointercapture', letGo);
  cv.addEventListener('dblclick', (e) => {
    // double-click an edge: back to the automatic size
    if (!renderer.edgeAt(at(e).y)) return;
    $('kbReset').click();
  });
  cv.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        // zoom (a touchpad's pinch arrives as this too)
        e.preventDefault();
        wheelZoom += e.deltaY;
        if (Math.abs(wheelZoom) >= 40) {
          zoomBy(wheelZoom > 0 ? 1 : -1);
          wheelZoom = 0;
        }
      } else if (renderer.zoomed) {
        e.preventDefault();
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        renderer.scrollBy(d * (e.deltaMode === 1 ? 20 : 1));
      }
    },
    { passive: false }
  );
  let wheelZoom = 0;
  cv.addEventListener('contextmenu', (e) => {
    if (grab) e.preventDefault();
  });

  // drag and drop anywhere
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    document.body.classList.add('drop-on');
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('drop-on');
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drop-on');
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
    const zip = files.find((f) => /\.zip$/i.test(f.name));
    if (zip) {
      $('zipIn').files = e.dataTransfer.files;
    }
    const ids = await library.addFiles(files);
    if (ids.length) openExercise(ids[0]);
    else if (!zip) toast('Drop .mid files to add exercises.');
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' && /text|number|search/.test(t.type)) || (t && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'));
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let used = true;
    if (k === ' ') togglePlay();
    else if (k === 'ArrowLeft') ex && player.prev();
    else if (k === 'ArrowRight') ex && player.next();
    else if (k === 'ArrowUp') setBpm(player.bpm + (e.shiftKey ? 1 : 5));
    else if (k === 'ArrowDown') setBpm(player.bpm - (e.shiftKey ? 1 : 5));
    else if (k === 'Home') ex && player.restart();
    else if (k === 'g' || k === 'G') $('guideSeg').querySelector('[data-guide="' + (player.cfg.guide ? 'off' : 'on') + '"]').click();
    else if (k === 'l' || k === 'L') $('loopBtn').click();
    else if (k === 'm' || k === 'M') $('micBtn').click();
    else if (k === 'f' || k === 'F') toggleFilter();
    else if (k === 'k' || k === 'K') setMetro(!S.metro);
    else if (k === 'h' || k === 'H') {
      const order = ['all', 'where', 'none'];
      const f = order[(order.indexOf(S.feedback) + 1) % 3];
      setFeedback(f);
      toast(f === 'all' ? 'Showing how you’re doing as you sing.' : f === 'where' ? 'Showing only where you sing, not whether you hit the notes.' : 'Showing nothing while you sing: the results wait for the end.');
    } else if (k === '+' || k === '=') zoomBy(-1);
    else if (k === '-' || k === '_') zoomBy(1);
    else if (k === '0') setView('fit');
    else if (k === 'v' || k === 'V') {
      if (ex && ex.voices > 1) {
        const order = ex.voiceLabels.map((_, i) => i).concat(['any']);
        setVoice(order[(order.indexOf(player.cfg.voice) + 1) % order.length]);
      }
    } else if (k === 'n' || k === 'N') {
      const order = ['solfege', 'names', 'none'];
      S.labels = order[(order.indexOf(S.labels) + 1) % 3];
      $('labels').value = S.labels;
      renderer.set({ labels: S.labels });
      save();
    } else if (k === '[') {
      S.ahead = SF.clamp(S.ahead + 0.5, 1.5, 8);
      renderer.set({ lookahead: S.ahead });
      save();
    } else if (k === ']') {
      S.ahead = SF.clamp(S.ahead - 0.5, 1.5, 8);
      renderer.set({ lookahead: S.ahead });
      save();
    } else if (k === 'e' || k === 'E') openDrawer('lib');
    else if (k === 's' || k === 'S') openDrawer('set');
    else if (k === 'r' || k === 'R') openDrawer('res');
    else if (k === '?') $('help').hidden = !$('help').hidden;
    else if (k === 'Escape') closeDrawers();
    else used = false;
    if (used) {
      e.preventDefault();
      if (t && t.blur && t.tagName === 'BUTTON') t.blur();
    }
  });

  // never leave a note hanging; don't play on in a hidden tab
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && player.state === 'playing') player.pause();
    if (!document.hidden && S.refOn) updateRefUI();
  });
  root.addEventListener('pagehide', () => {
    player.stopSound();
    endSession();
    listener.saveRoom();
  });
  root.addEventListener('focus', () => {
    if (library.folder && library.folder.state === 'granted') library.refresh();
  });
  const resized = () => {
    renderer.resize();
    placeBox(true);
  };
  root.addEventListener('resize', resized);
  if (root.ResizeObserver) new ResizeObserver(resized).observe($('stage'));
  // a key held on the screen when the window loses the pointer
  root.addEventListener('blur', () => releaseAll());

  // ---------------------------------------------------------------- loop
  function frame() {
    player.tick();
    scorer.update();
    renderer.draw();
    updateHUD();
    if (ex && player.state === 'playing') updateTempoUI();
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- start
  async function start() {
    SF.audio.ctx.addEventListener('statechange', updateMicUI);
    updatePlayUI();
    updateGuideUI();
    updateLoopUI();
    updateMicUI();
    updateMetroUI();
    updateViewUI();
    placeBox(true);
    applyOutput();
    try {
      bank = await SF.SampleBank.load();
    } catch (e) {
      bank = null;
    }
    if (S.output === 'samples' && !bank) S.output = 'synth';
    applyOutput();
    // Everything that was in use last time connects again as the page opens: the piano,
    // the mic (and the piano filter), and the exercise folder. The browser may ask first.
    if (S.output === 'midi' || S.midiPort) midi.connect().then(refreshMidi);
    else midi.autoConnect().then(refreshMidi);
    if (S.micOn) micOn();
    await library.init();
    await openLast();
    requestAnimationFrame(frame);
  }
  /** The exercise open last time; if it lives in the folder, once the folder can be read. */
  async function openLast() {
    if (S.lastEx && library.get(S.lastEx)) return openExercise(S.lastEx);
    const f = library.folder;
    if (f && f.state !== 'granted') {
      $('emptyLink').textContent = 'Open ' + f.name + ' again';
      toast('Click anywhere to let the app read ' + esc(f.name) + ' again: the browser asks once per visit.', 6000);
    }
    $('empty').hidden = false;
  }
  // The first click or key press: the browser now lets the audio run, and asks about the folder.
  let folderAsked = false;
  async function firstGesture() {
    if (SF.audio.exists && SF.audio.ctx.state !== 'running') SF.audio.ctx.resume().catch(() => {});
    const f = library.folder;
    if (!folderAsked && f && f.state === 'prompt') {
      folderAsked = true;
      await library.reconnect();
      renderLibrary();
      if (library.folder && library.folder.state === 'granted' && !ex) await openLast();
    }
  }
  document.addEventListener('pointerdown', firstGesture, true);
  document.addEventListener('keydown', firstGesture, true);
  root.SFApp = { player, scorer, renderer, listener, library, midi, synth, metronome, get ex() { return ex; }, get out() { return tapOut; }, S, openExercise, calibrate, toast };
  start();
})(window);
