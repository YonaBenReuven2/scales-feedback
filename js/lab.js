/* Filter lab: tests the piano filter on the real piano, mic and room.
 *
 * The piano plays the app's calibration while you stay quiet, then a short exercise (three
 * keys of "chord, five notes, chord") to sing along to. Both inputs are recorded the whole
 * time; afterwards the same filter code the app uses runs over the recording here, from
 * nothing learned, and gives back the pitch it heard against the notes to sing, and things to
 * listen to: the mic, the piano's own audio, the piano as the filter predicts the mic hears it,
 * the mic with that removed, and that cleaned up further with what the filter learned of the
 * piano's leftover frequency by frequency.
 */
(function (root) {
  'use strict';
  const SF = root.SF;
  const $ = (id) => document.getElementById(id);
  const W = 2048;

  const listener = new SF.Listener();
  listener.recordSec = 120;
  const midi = new SF.Midi();
  let out = null;
  let plan = { mode: 'stopped' };
  listener.planner = () => plan;
  let take = null; // the recording and what the filter made of it
  let running = false;

  // ---------------------------------------------------------------- inputs
  const setDev = (msg, cls) => {
    $('devStatus').textContent = msg;
    $('devStatus').className = 'status' + (cls ? ' ' + cls : '');
  };
  async function fillDevices() {
    const ds = await listener.devices();
    const named = ds.filter((d) => d.label);
    const mic = $('micSel');
    const ref = $('refSel');
    mic.innerHTML = '';
    ref.innerHTML = '';
    if (!named.length) {
      mic.add(new Option(listener.running ? listener.micLabel || 'Microphone' : 'Press Connect', ''));
      ref.add(new Option(listener.refStream ? listener.refLabel : listener.running ? 'Hidden by the browser' : 'Press Connect', ''));
    } else ref.add(new Option('Choose the input…', ''));
    for (const d of named) {
      mic.add(new Option(d.label + (d.piano ? ' (the piano, not a mic)' : ''), d.id));
      if (d.id !== listener.micId) ref.add(new Option(d.label + (d.piano ? ' (the piano)' : ''), d.id));
    }
    if (listener.micId) mic.value = listener.micId;
    ref.value = listener.refStream && listener.refId ? listener.refId : '';
  }
  async function connect() {
    SF.audio.resume();
    setDev('Connecting…');
    try {
      await listener.start(null);
    } catch (e) {
      setDev(SF.inputError(e, e && e.device), 'bad');
      return;
    }
    try {
      const ds = await listener.devices();
      const named = ds.filter((d) => d.label);
      if (!named.length) await listener.askReference(null);
      else {
        const p = named.find((d) => d.piano && d.id !== listener.micId);
        if (p) await listener.setReference(p.id);
      }
    } catch (e) {
      setDev(SF.inputError(e, e && e.device), 'bad');
    }
    if (!midi.access) await midi.connect();
    const port = midi.preferred();
    out = port ? new SF.MidiOut(port, 0) : null;
    $('midiName').textContent = out ? out.name : midi.error || 'No piano found over MIDI. Is the USB cable in and the piano on?';
    await fillDevices();
    updateReady();
  }
  /** What is still missing before a test can run ('' when nothing). */
  function missing() {
    if (typeof SF.calibrationNotes !== 'function' || typeof listener.dump !== 'function')
      return 'The browser is still using an older copy of the app. Reload this page with Ctrl+Shift+R.';
    if (!listener.running) return 'The microphone isn’t open: press Connect.';
    if (!listener.refStream) return 'The piano’s USB audio isn’t open: pick it in the list above (it shows as Line (P-Series)).';
    if (!out) return 'The piano isn’t connected over MIDI: is the USB cable in and the piano on? Then press Connect.';
    return '';
  }
  function updateReady() {
    // the button always answers: when something is missing it says what
    $('runBtn').disabled = running;
    const m = missing();
    if (!m) setDev('Ready: ' + listener.micLabel + ', and ' + listener.refLabel + '.', 'ok');
    else if (listener.running || /older copy/.test(m)) setDev(m, 'bad');
  }
  $('connectBtn').onclick = connect;
  $('micSel').onchange = async () => {
    const id = $('micSel').value;
    if (!id) return;
    try {
      await listener.start(id, { allowPiano: true });
    } catch (e) {
      setDev(SF.inputError(e, e && e.device), 'bad');
    }
    await fillDevices();
    updateReady();
  };
  $('refSel').onchange = async () => {
    const id = $('refSel').value;
    if (!id) return;
    try {
      await listener.setReference(id);
    } catch (e) {
      setDev(SF.inputError(e, e && e.device), 'bad');
    }
    await fillDevices();
    updateReady();
  };
  const pct = (db) => SF.clamp((db + 70) / 60, 0, 1) * 100 + '%';
  listener.on('level', (lv) => {
    $('micLvl').style.width = pct(lv.mic);
    $('refLvl').style.width = listener.refStream ? pct(lv.ref) : '0%';
  });
  for (const id of ['velAcc', 'velSing']) $(id).oninput = () => ($(id + 'V').textContent = $(id).value);

  // ---------------------------------------------------------------- the test
  /** Three keys of "chord, five sung notes (do re mi re do), chord", going down. */
  function exercise(lo, hi, guide, velAcc, velSing) {
    const notes = [];
    const spans = [];
    const top = Math.max(lo + 4, Math.min(hi - 4, Math.round((lo + hi) / 2) - 2));
    let t = 0;
    for (const root of [top, top - 1, top - 2]) {
      for (const d of [0, 4, 7]) notes.push({ p: root + d, vel: velAcc, t, d: 1200 });
      t += 1300;
      for (const s of [0, 2, 4, 2, 0]) {
        if (guide) notes.push({ p: root + s, vel: velSing, t, d: 680 });
        spans.push([t, t + 700, root + s]);
        t += 700;
      }
      t += 500;
    }
    return { notes, spans, dur: t };
  }
  const sleepUntil = (ms) => new Promise((res) => setTimeout(res, Math.max(0, ms - SF.now())));
  async function runTest() {
    if (running) return;
    let m = missing();
    if (m && !/older copy/.test(m)) {
      // try connecting first (this click lets the browser start the sound)
      $('runStatus').textContent = 'Connecting…';
      await connect();
      m = missing();
    }
    if (m) {
      $('runStatus').textContent = m;
      $('runStatus').className = 'status bad';
      return;
    }
    $('runStatus').className = 'status';
    try {
      await runTestNow();
    } catch (e) {
      $('runStatus').textContent = 'The test stopped: ' + (e && e.message ? e.message : e) + '. Reload the page and try again; if it happens again, tell me what it says.';
      $('runStatus').className = 'status bad';
      $('phase').hidden = true;
      $('progBox').hidden = true;
      plan = { mode: 'stopped' };
      listener.sendPlan();
      if (out) out.allOff();
    }
    running = false;
    updateReady();
  }
  async function runTestNow() {
    const lo = SF.parseNote($('loNote').value);
    const hi = SF.parseNote($('hiNote').value);
    if (!isFinite(lo) || !isFinite(hi) || hi - lo < 12) throw new Error('write the notes like E2 and A4, at least an octave apart');
    running = true;
    updateReady();
    $('results').hidden = true;
    $('runStatus').textContent = '';
    SF.audio.resume();
    const velAcc = +$('velAcc').value;
    const velSing = +$('velSing').value;
    const tap = SF.tapOutput(out, (at, p, on) => listener.markKey(at, p, on), () => listener.markAllOff(SF.now()));
    // a fresh start: nothing learned, and the recording holds only this test
    listener.savedRoom = null;
    listener.startEngine();
    const cal = SF.calibrationNotes(lo, hi, velAcc, velSing);
    const ex = exercise(lo, hi, $('guideOn').checked, velAcc, velSing);
    const t0 = SF.now() + 1000;
    const te = t0 + cal.dur + 1500;
    const tEnd = te + ex.dur + 800;
    plan = { mode: 'calib' };
    listener.sendPlan();
    for (const n of cal.notes) {
      tap.noteOn(n.p, n.vel, t0 + n.t);
      tap.noteOff(n.p, t0 + n.t + n.d);
    }
    $('phase').hidden = false;
    $('progBox').hidden = false;
    // the exercise, scheduled a little ahead as it comes
    const pending = ex.notes.map((n) => ({ p: n.p, vel: n.vel, on: te + n.t, off: te + n.t + n.d }));
    let sent = 0;
    while (SF.now() < tEnd) {
      const now = SF.now();
      if (now < te - 300) $('phase').textContent = 'Stay quiet: the piano is calibrating (' + Math.ceil((te - now) / 1000) + ' s)';
      else {
        if (plan.mode !== 'play') {
          plan = { mode: 'play', from: te - 500, until: tEnd, spans: ex.spans.map((s) => [te + s[0], te + s[1]]) };
          listener.sendPlan();
        }
        const cur = ex.spans.find((s) => now >= te + s[0] - 150 && now < te + s[1]);
        $('phase').textContent = cur ? 'Sing: ' + SF.noteName(cur[2]) : now < te ? 'Get ready to sing…' : 'Listen…';
      }
      while (sent < pending.length && pending[sent].on <= now + 400) {
        const n = pending[sent++];
        tap.noteOn(n.p, n.vel, n.on);
        tap.noteOff(n.p, n.off);
      }
      $('prog').style.width = SF.clamp((now - t0 + 1000) / (tEnd - t0 + 1000), 0, 1) * 100 + '%';
      await sleepUntil(now + 50);
    }
    plan = { mode: 'stopped' };
    listener.sendPlan();
    $('phase').textContent = 'Working it out…';
    let d;
    d = await listener.dump();
    d.meta.lab = { lo, hi, velAcc, velSing, guide: $('guideOn').checked, t0, te, tEnd, calDur: cal.dur, spans: ex.spans.map((s) => [te + s[0], te + s[1], s[2]]), at: new Date().toISOString(), mic: listener.micLabel, piano: listener.refLabel };
    take = await processTake(d, (f) => ($('prog').style.width = f * 100 + '%'));
    $('phase').hidden = true;
    $('progBox').hidden = true;
    showResults(take);
  }
  $('runBtn').onclick = runTest;

  // ---------------------------------------------------------------- filtering the recording
  /** Runs the recording through a fresh filter, as the listening engine does. */
  async function processTake(d, onProgress) {
    const { mic, ref, meta } = d;
    const sr = meta.sr;
    const B = 512;
    const blocks = meta.blocks;
    const f0 = blocks[0][0];
    let off = 0;
    for (const b of blocks) off += b[1] - b[2] * 1000;
    off /= blocks.length;
    const tOf = (f) => off + (f / sr) * 1000; // context frame -> page time
    const pf = new SF.PianoFilter(sr, {});
    const tr = new SF.PitchTracker(sr, { size: W, gateDb: meta.gateDb });
    const n = mic.length;
    const echo = new Float32Array(n);
    const res = new Float32Array(n);
    const frames = [];
    let done = 0;
    let analyzed = W;
    let delayAt = null;
    const keys = meta.keys.slice().sort((a, b) => a.t - b.t);
    let ki = 0;
    for (let i = 0; i < blocks.length; i++) {
      const f = blocks[i][0];
      const a = mic.subarray(i * B, i * B + B);
      const b = ref.subarray(i * B, i * B + B);
      const t0 = tOf(f);
      const t1 = tOf(f + B);
      let onset = false;
      let events = null;
      while (ki < keys.length && keys[ki].t < t1) {
        const k = keys[ki++];
        if (k.t < t0 - 50) continue;
        if (k.on) onset = true;
        (events = events || []).push(k);
      }
      pf.push(a, b, blocks[i][3] === 1, onset, events);
      if (delayAt == null && pf.delay != null) delayAt = tOf(f);
      for (; done < pf.done; done++) {
        echo[done] = pf.echoR[done & pf.mask];
        res[done] = pf.resR[done & pf.mask];
      }
      while (analyzed + 512 <= pf.done) {
        analyzed += 512;
        const fr = SF.analyzeFrame(pf, tr, analyzed, tOf(f0 + analyzed - W / 2));
        frames.push(fr);
      }
      if (i % 300 === 0) {
        onProgress(i / blocks.length);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    for (; done < n; done++) res[done] = mic[done];
    onProgress(1);
    await new Promise((r) => setTimeout(r, 0));
    const post = pf.spec && pf.spec.ready ? SF.cleanUp(pf.spec, res, echo, 4) : res;
    return { meta, mic, ref, side: d.side || null, echo, res, post, frames, sr, tOf, f0, pf, delayAt };
  }

  // ---------------------------------------------------------------- results
  const dbr = (a, b) => (b > 0 && a > 0 ? 10 * Math.log10(a / b) : null);
  function showResults(tk) {
    const { meta, mic, res, sr, pf } = tk;
    const lab = meta.lab;
    const idx = (t) => Math.round(((t - (tk.tOf(tk.f0))) / 1000) * sr); // page time -> sample
    // how much piano it removed while nobody sang: the calibration's single keys and the
    // exercise's chords, once the filter was working
    let em = 0;
    let er = 0;
    let ep = 0;
    const post = tk.post;
    const blocks = meta.blocks;
    // (once it has had the chance to learn: from the calibration's single keys on)
    const from = tk.delayAt == null ? Infinity : Math.max(idx(tk.delayAt + 2000), idx(lab.t0 + 0.6 * lab.calDur));
    for (let i = 0; i < blocks.length; i++) {
      if (!blocks[i][3]) continue;
      for (let k = i * 512; k < i * 512 + 512 && k < mic.length; k++) {
        if (k < from) continue;
        em += mic[k] * mic[k];
        er += res[k] * res[k];
        ep += post[k] * post[k];
      }
    }
    const cal = dbr(em, er);
    const calPost = post !== res ? dbr(em, ep) : null;
    // the sung notes: how many it could hear (not counting each note's first and last 120 ms)
    let all = 0;
    let heard = 0;
    let unsure = 0;
    const vDb = [];
    const pDb = [];
    for (const fr of tk.frames) {
      const s = lab.spans.find((x) => fr.t >= x[0] + 120 && fr.t < x[1] - 120);
      if (!s) continue;
      all++;
      if (fr.echoDb > -100) pDb.push(fr.echoDb);
      if (fr.voiced) {
        heard++;
        if (fr.resDb != null) vDb.push(fr.resDb);
      } else if (fr.source === 'learning' || fr.source === 'unsure') unsure++;
    }
    // how loud the voice was at the mic against the piano playing the same notes
    const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : null);
    const vs = vDb.length >= 10 && pDb.length >= 10 ? median(vDb) - median(pDb) : null;
    $('nDelay').textContent = pf.delay == null ? 'not found' : ((pf.delay / sr) * 1000).toFixed(1) + ' ms';
    $('nCal').textContent = cal == null ? '–' : cal.toFixed(1) + ' dB';
    $('nCalNote').textContent = 'Piano removed while you were quiet' + (calPost != null ? ' (' + calPost.toFixed(1) + ' dB after the clean-up, in “What’s left”)' : '');
    $('nSing').textContent = all ? Math.round((100 * heard) / all) + '%' : '–';
    const vr = vs == null ? null : Math.round(vs);
    $('nVoice').textContent = vr == null ? '–' : (vr > 0 ? '+' : vr < 0 ? '−' : '') + Math.abs(vr) + ' dB';
    let v;
    if (pf.delay == null) v = 'It never found the delay between the piano’s audio and the mic, so it couldn’t remove anything. Is the piano loud enough to hear in the room?';
    else if (cal != null && cal < 6) v = 'It removed very little of the piano. Listen to “What’s left”: if the piano is nearly as loud as in “The mic”, the mic may still be changing its own sound, or the setup changed during the test.';
    else if (all && heard / all < 0.6) v = 'It removed the piano, but heard only part of your singing. “What’s left” shows whether your voice is clear there.';
    else v = 'It removed the piano and heard most of your singing. “What’s left” should sound like your voice alone.';
    const share = (k) => Math.round((100 * k) / Math.max(1, all)) + '%';
    v += all && heard < all ? ' In your sung notes it heard you ' + share(heard) + ' of the time, couldn’t tell you from the piano ' + share(unsure) + ', and heard no singing ' + share(all - heard - unsure) + '.' : '';
    if (vs != null && vs < -3 && lab.guide && heard < 0.9 * all)
      v += ' At the mic, the piano playing your notes was about ' + Math.round(-vs) + ' dB louder than your voice: where it is that much louder, it can’t always tell you apart. A lower “Your notes touch” helps.';
    $('verdict').textContent = v;
    $('results').hidden = false;
    drawPitch(tk);
    drawChart(tk);
  }
  /** The notes to sing, and the pitch heard: as the voice (by how close), or read but not trusted. */
  function drawPitch(tk) {
    const c = $('pitchChart');
    const g = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    g.clearRect(0, 0, w, h);
    const lab = tk.meta.lab;
    const t0 = lab.te - 300;
    const t1 = lab.spans.length ? lab.spans[lab.spans.length - 1][1] + 500 : lab.tEnd;
    const ps = lab.spans.map((s) => s[2]);
    const lo = Math.min(...ps) - 3.5;
    const hi = Math.max(...ps) + 3.5;
    const left = 70;
    const x = (t) => left + ((t - t0) / (t1 - t0)) * (w - left - 10);
    const y = (m) => h - 8 - ((SF.clamp(m, lo, hi) - lo) / (hi - lo)) * (h - 16);
    // a line per semitone, named
    g.font = '20px ' + getComputedStyle(document.body).fontFamily;
    g.textBaseline = 'middle';
    for (let m = Math.ceil(lo); m <= hi; m++) {
      g.strokeStyle = m % 12 === 0 ? '#2f4466' : '#1d2b45';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(left, y(m));
      g.lineTo(w - 10, y(m));
      g.stroke();
      g.fillStyle = '#93a1b8';
      g.fillText(SF.noteName(m), 10, y(m));
    }
    // the notes to sing
    const rowH = (h - 16) / (hi - lo);
    g.fillStyle = '#2c4a73';
    for (const [a, b, p] of lab.spans) {
      const r = Math.min(6, rowH * 0.35);
      const xa = x(a);
      const xb = x(b) - 3;
      const ya = y(p) - rowH * 0.35;
      if (g.roundRect) {
        g.beginPath();
        g.roundRect(xa, ya, xb - xa, rowH * 0.7, r);
        g.fill();
      } else g.fillRect(xa, ya, xb - xa, rowH * 0.7);
    }
    // what it heard
    const tol = 0.35;
    for (const fr of tk.frames) {
      const s = lab.spans.find((q) => fr.t >= q[0] && fr.t < q[1]);
      if (!s) continue; // between the notes
      const m = fr.voiced ? fr.midi : fr.raw;
      if (m == null || m < lo || m > hi) continue;
      if (fr.voiced && fr.midi != null) {
        const d = Math.abs(fr.midi - s[2]);
        g.fillStyle = d <= tol ? '#5bd69b' : d <= 2 * tol ? '#f2c14e' : '#f07a6a';
        g.beginPath();
        g.arc(x(fr.t), y(fr.midi), 4.5, 0, 2 * Math.PI);
        g.fill();
      } else if (fr.source === 'unsure' && fr.raw != null) {
        g.strokeStyle = '#93a1b8';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x(fr.t), y(fr.raw), 3.5, 0, 2 * Math.PI);
        g.stroke();
      }
    }
  }
  function drawChart(tk) {
    const c = $('chart');
    const g = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    g.clearRect(0, 0, w, h);
    const { mic, res, sr, meta } = tk;
    const n = mic.length;
    const hop = Math.round(sr * 0.05);
    const x = (i) => (i / n) * w;
    const y = (db) => h - SF.clamp((db + 80) / 70, 0, 1) * (h - 10) - 5;
    const idx = (t) => Math.round(((t - tk.tOf(tk.f0)) / 1000) * sr);
    // the calibration and the sung notes
    g.fillStyle = '#1b2a44';
    g.fillRect(x(idx(meta.lab.t0)), 0, x(idx(meta.lab.t0 + meta.lab.calDur)) - x(idx(meta.lab.t0)), h);
    g.fillStyle = '#24395c';
    for (const s of meta.lab.spans) g.fillRect(x(idx(s[0])), 0, Math.max(1, x(idx(s[1])) - x(idx(s[0]))), h);
    const line = (arr, color, width) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      for (let i = 0; i + hop <= n; i += hop) {
        let s = 0;
        for (let k = i; k < i + hop; k++) s += arr[k] * arr[k];
        const db = 10 * Math.log10(s / hop + 1e-12);
        if (i === 0) g.moveTo(x(i), y(db));
        else g.lineTo(x(i), y(db));
      }
      g.stroke();
    };
    line(mic, '#c3cddc', 4);
    line(res, '#8bd3f7', 1.6);
  }

  // ---------------------------------------------------------------- listening back
  let playing = null;
  function stopPlaying() {
    if (playing) {
      try {
        playing.src.stop();
      } catch (e) {
        /* done already */
      }
      playing.btn.classList.remove('playing');
      playing = null;
    }
  }
  for (const btn of document.querySelectorAll('[data-track]')) {
    btn.onclick = () => {
      const was = playing && playing.btn === btn;
      stopPlaying();
      if (was || !take) return;
      const tk = take;
      const ctx = SF.audio.ctx;
      SF.audio.resume();
      const arr = tk[btn.dataset.track];
      const idx = (t) => SF.clamp(Math.round(((t - tk.tOf(tk.f0)) / 1000) * tk.sr), 0, arr.length);
      const a = $('wholeOn').checked ? 0 : idx(tk.meta.lab.te - 800);
      const b = arr.length;
      // the mic, the prediction and what's left at one loudness, so they compare fairly; the
      // piano's own audio on its own
      let peak = 1e-6;
      const scaleOf = btn.dataset.track === 'ref' ? tk.ref : tk.mic;
      for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(scaleOf[i]));
      const gain = 0.7 / peak;
      const buf = ctx.createBuffer(1, b - a, tk.sr);
      const ch = buf.getChannelData(0);
      for (let i = a; i < b; i++) ch[i - a] = SF.clamp(arr[i] * gain, -1, 1);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => {
        if (playing && playing.src === src) stopPlaying();
      };
      src.start();
      btn.classList.add('playing');
      playing = { src, btn };
    };
  }

  // ---------------------------------------------------------------- saving
  $('saveBtn').onclick = () => {
    if (!take) return;
    const blob = SF.wavWithData(take.mic, take.ref, take.sr, take.meta, take.side);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'scales-feedback-lab-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.wav';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };

  // ---------------------------------------------------------------- opening a saved recording
  /** Runs a recording saved earlier through the filter as it is now (after an update, say). */
  async function openRecording(file) {
    if (running) return;
    const st = $('openStatus');
    st.className = 'status';
    st.textContent = 'Reading ' + file.name + '…';
    try {
      const w = SF.readWavData(await file.arrayBuffer());
      if (!w.meta.lab) throw new Error('this recording was saved by the app, not the lab: open it there');
      running = true;
      updateReady();
      $('results').hidden = true;
      $('progBox').hidden = false;
      take = await processTake({ mic: w.mic, ref: w.ref, side: w.side, meta: w.meta }, (f) => ($('prog').style.width = f * 100 + '%'));
      $('progBox').hidden = true;
      showResults(take);
      st.textContent = 'Showing ' + file.name + ', from ' + new Date(w.meta.lab.at).toLocaleString() + ', run through the filter as it is now.';
      st.className = 'status ok';
    } catch (e) {
      $('progBox').hidden = true;
      st.textContent = 'Couldn’t open it: ' + (e && e.message ? e.message : e) + '.';
      st.className = 'status bad';
    }
    running = false;
    updateReady();
  }
  $('openBtn').onclick = () => $('openFile').click();
  $('openFile').onchange = () => {
    const f = $('openFile').files[0];
    $('openFile').value = '';
    if (f) openRecording(f);
  };

  // reconnect at once if the browser already allows the mic (it remembers on this site)
  (async () => {
    try {
      const st = await navigator.permissions.query({ name: 'microphone' });
      if (st.state === 'granted') await connect();
    } catch (e) {
      /* press Connect */
    }
  })();
  root.addEventListener('error', (e) => {
    $('runStatus').textContent = 'Something went wrong: ' + (e.message || e) + '. Reload the page (Ctrl+Shift+R) and try again.';
    $('runStatus').className = 'status bad';
  });
  updateReady();
  root.SFLab = { listener, processTake, openRecording, get take() { return take; } };
})(window);
