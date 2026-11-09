// The piano filter in a simulated room: the piano's USB audio is the reference, the mic
// hears it later through a room (and the singer). Slow-ish: each case is ~15 s of audio.
const test = require('node:test');
const assert = require('node:assert');
const SF = require('./load.js')('core', 'pitch', 'echo');
const { voice, reseed: reseedVoice } = require('./synth-voice.js');
const R = require('./sim-room.js');

const sr = 44100;
const B = 512;

/** A calibration-style run (optional), then three keys of "chord, five sung notes, chord". */
function scene(o) {
  R.reseed(o.seed);
  reseedVoice(o.seed);
  const ev = [];
  const sung = [];
  let t = 0.3;
  if (o.calib && o.solo !== false) {
    // as the app calibrates: three chords, then each key alone, as loud as the guide
    for (const ch of [[0, 4, 7], [-5, 0, 4], [-3, 0, 5]]) {
      for (const dd of ch) ev.push({ pitch: 56 + dd, t, d: 0.6, vel: 50 });
      t += 0.7;
    }
    t += 0.3;
    for (let m = 44; m <= 64; m++) {
      ev.push({ pitch: m, t, d: 0.33, vel: 62 });
      t += 0.15;
    }
    t += 0.7;
    for (let m = 44; m <= 64; m++) {
      ev.push({ pitch: m, t, d: 0.25, vel: 62 });
      t += 0.3;
    }
    t += 1.2;
  } else if (o.calib) {
    // as the app used to calibrate: an overlapping run over the range, then three chords
    for (let m = 44; m <= 64; m++) {
      ev.push({ pitch: m, t, d: 0.33, vel: 60 });
      t += 0.15;
    }
    t += 0.3;
    for (const ch of [[0, 4, 7], [-5, 0, 4], [-3, 0, 5]]) {
      for (const dd of ch) ev.push({ pitch: 56 + dd, t, d: 0.6, vel: 60 });
      t += 0.7;
    }
    t += 0.8;
  }
  const calEnd = o.calib ? t : 0; // the app marks the calibration as surely quiet
  for (const b of [48, 47, 46]) {
    for (const p of [0, 4, 7]) ev.push({ pitch: b + p, t, d: 1.2, vel: 50 });
    t += 1.2;
    for (const s of [0, 2, 4, 2, 0]) {
      if (o.guide !== false) ev.push({ pitch: b + s, t, d: 0.6, vel: 62 });
      sung.push({ pitch: b + s, t, d: 0.6 });
      t += 0.6;
    }
    for (const p of [0, 4, 7]) ev.push({ pitch: b + p, t, d: 0.6, vel: 50 });
    t += 0.6;
  }
  const dur = t + 0.6;
  if (o.shift) {
    // the same, that many semitones lower or higher
    for (const e of ev) e.pitch += o.shift;
    for (const s of sung) s.pitch += o.shift;
  }
  const ref = R.piano(ev, sr, dur);
  let room;
  if (o.roomSeed) R.reseed(o.roomSeed); // the same room in two sessions
  if (!o.harsh) room = R.shift(R.convolve(ref, R.roomIR(sr, { rt60: 0.35 })), 0.0283 * sr, o.drift || 0);
  else {
    // a harder room: speakers that distort a little, an echo longer than the filter models,
    // and a room that shifts as you move. About 15 dB of the piano can be removed.
    const x = new Float32Array(ref.length);
    for (let i = 0; i < x.length; i++) x[i] = Math.tanh(0.6 * ref[i]) / 0.6;
    const ya = R.convolve(x, R.roomIR(sr, { rt60: 0.6 }));
    const yb = R.convolve(x, R.roomIR(sr, { rt60: 0.6 }));
    const y = new Float32Array(x.length);
    for (let i = 0; i < y.length; i++) {
      const w = 0.12 + 0.08 * Math.sin((2 * Math.PI * i) / sr / 6);
      y[i] = (1 - w) * ya[i] + w * yb[i];
    }
    room = R.shift(y, 0.0283 * sr, 0);
  }
  const v = new Float32Array(ref.length);
  if (o.voiceDb != null) {
    for (const s of sung) {
      // a voice always wavers a little (a held piano note doesn't): 5 cents unless set
      const vib = o.vibrato == null ? 5 : o.vibrato;
      const seg = voice(() => s.pitch + (o.cents || 0) / 100, sr, s.d, { vowel: 'a', vibrato: vib ? { rate: 5.5, cents: vib } : null });
      const i0 = Math.round(s.t * sr);
      for (let i = 0; i < seg.length && i0 + i < v.length; i++) {
        const tt = i / sr;
        v[i0 + i] += seg[i] * Math.min(1, tt / 0.03, (s.d - tt) / 0.03);
      }
    }
  }
  // the voice level relative to the piano at the mic, measured over the sung stretches
  let pe = 0;
  let ve = 0;
  for (const s of sung) {
    const a = Math.round(s.t * sr);
    const b = Math.round((s.t + s.d) * sr);
    for (let i = a; i < b; i++) {
      pe += room[i] * room[i];
      ve += v[i] * v[i];
    }
  }
  const g = o.voiceDb == null ? 0 : Math.sqrt(pe / Math.max(ve, 1e-12)) * Math.pow(10, o.voiceDb / 20);
  const mic = new Float32Array(ref.length);
  for (let i = 0; i < mic.length; i++) mic[i] = room[i] + g * v[i] + 2e-4 * R.gauss();
  if (o.agc) {
    // a mic with its own automatic volume: once the singing starts it turns itself down 10 dB
    const t0 = sung[0].t;
    for (let i = 0; i < mic.length; i++) mic[i] *= 1 - 0.68 * SF.clamp((i / sr - t0) / 2, 0, 1);
  }
  return { ev, sung, ref, mic, calEnd, cents: o.voiceDb == null ? 0 : o.cents || 0 };
}

/** Streams the scene through the filter as the app does; returns what each sung frame said. */
function run(sc, pf0) {
  const pf = pf0 || new SF.PianoFilter(sr, {});
  const tr = new SF.PitchTracker(sr, { size: 2048 });
  const W = 2048;
  const inSung = (t) => sc.sung.some((s) => t >= s.t - 0.25 && t < s.t + s.d + 0.25);
  // key presses and releases per block, as the app reports them
  const byBlock = new Map();
  const add = (t, e) => {
    const k = Math.floor((t * sr) / B);
    (byBlock.get(k) || byBlock.set(k, []).get(k)).push(e);
  };
  for (const e of sc.ev) {
    add(e.t, { p: e.pitch, on: true });
    add(e.t + e.d, { p: e.pitch, on: false });
  }
  const out = { frames: 0, hit: 0, voiced: 0, cents: [], src: {}, why: {}, log: process.env.ECHO_LOG ? [] : null };
  let analyzed = W;
  for (let p = 0; p + B <= sc.mic.length; p += B) {
    const evs = byBlock.get(p / B) || null;
    const tb = (p + B / 2) / sr;
    pf.push(sc.mic.subarray(p, p + B), sc.ref.subarray(p, p + B), tb < sc.calEnd ? 2 : !inSung(tb), !!(evs && evs.some((e) => e.on)), evs);
    while (analyzed + 512 <= pf.done) {
      analyzed += 512;
      const tc = (analyzed - W / 2) / sr;
      const fr = SF.analyzeFrame(pf, tr, analyzed, tc * 1000);
      const s = sc.sung.find((x) => tc >= x.t + 0.1 && tc < x.t + x.d - 0.03);
      if (!s) continue;
      out.frames++;
      out.src[fr.source] = (out.src[fr.source] || 0) + 1;
      if (out.log) out.log.push([+tc.toFixed(2), s.pitch, fr.source, fr.voiced ? +fr.midi.toFixed(2) : null, fr.presence == null ? null : +fr.presence.toFixed(1), +pf.leftover.toFixed(4), pf.leastLearned(analyzed, W)]);
      if (fr.voiced && fr.why) out.why[fr.why] = (out.why[fr.why] || 0) + 1;
      if (fr.voiced) {
        out.voiced++;
        if (Math.abs(fr.midi - (s.pitch + (sc.cents || 0) / 100)) > 0.5) out.wrong = (out.wrong || 0) + 1;
        (out.vf = out.vf || []).push([+tc.toFixed(2), s.pitch, +fr.midi.toFixed(2), +(fr.presence || 0).toFixed(1)]);
        const c = (fr.midi - s.pitch) * 100;
        out.cents.push(c);
        if (Math.abs(c) <= 35) out.hit++;
      }
    }
  }
  out.pf = pf;
  return out;
}

test('after calibrating, the piano alone never passes for a voice', () => {
  const r = run(scene({ calib: true }));
  assert.ok(r.pf.ready, 'learned the room');
  assert.ok(Math.abs((r.pf.delay / sr) * 1000 - 28.3) < 1.5, 'delay ' + (r.pf.delay / sr) * 1000);
  assert.ok(r.pf.cancelDb > 10, 'cancels ' + r.pf.cancelDb + ' dB');
  assert.strictEqual(r.voiced, 0, JSON.stringify(r.src));
});

test('after calibrating, a voice 6 dB under the piano, singing the same notes, is heard in tune', () => {
  const r = run(scene({ calib: true, voiceDb: -6, cents: -20 }));
  assert.ok(r.voiced / r.frames > 0.7, 'heard ' + r.voiced + ' of ' + r.frames + ' ' + JSON.stringify(r.src));
  const med = SF.median(r.cents);
  assert.ok(Math.abs(med + 20) < 4, 'reads ' + med + ' cents (sang -20)');
});

test('without calibrating, keys it has not learned are not scored at all', () => {
  // the guide plays D and F, which never sound in a quiet stretch: no verdict either way
  const r = run(scene({ voiceDb: null }));
  assert.strictEqual(r.voiced, 0, JSON.stringify(r.src));
  assert.ok((r.src.learning || 0) > 0, 'some frames wait for learning: ' + JSON.stringify(r.src));
  assert.ok(r.pf.keysLearned >= 3, 'learned the chord keys: ' + r.pf.keysLearned);
});

test('without calibrating, singing it cannot hear over the piano is left unjudged, not called silent', () => {
  const r = run(scene({ voiceDb: -6 }));
  assert.ok(!r.src.piano, 'no "only the piano" frames while singing: ' + JSON.stringify(r.src));
  assert.ok(r.voiced > 0 && r.hit === r.voiced, 'what it does hear is right: ' + r.hit + ' of ' + r.voiced);
});

test('clock drift between the two devices is followed', () => {
  // 40 ppm over the ~25 s is about 1 ms
  const r = run(scene({ calib: true, drift: 40e-6, voiceDb: -6 }));
  const end = (r.pf.dUsed / sr) * 1000;
  assert.ok(end < 28.3 - 0.6, 'followed the drift: ' + end + ' ms');
  assert.ok(r.voiced / r.frames > 0.7, 'still hears the voice ' + JSON.stringify(r.src));
  assert.ok(Math.abs(SF.median(r.cents)) < 5, 'in tune: ' + SF.median(r.cents));
  const silent = run(scene({ calib: true, drift: 40e-6 }));
  assert.strictEqual(silent.voiced, 0, 'nothing from the piano alone: ' + JSON.stringify(silent.src) + ' ' + JSON.stringify(silent.why) + ' delay ' + (silent.pf.dUsed / sr * 1000).toFixed(2) + ' cancel ' + silent.pf.cancelDb.toFixed(1) + ' realigns ' + (silent.pf.realigns || 0));
});

test('in a harder room, singing off the piano’s note is heard however much piano is left', () => {
  // 60 cents sharp, 12 dB under the piano, with the guide playing the right notes
  const r = run(scene({ calib: true, harsh: true, voiceDb: -12, cents: 60, vibrato: 8, seed: 3 }));
  assert.ok(r.voiced / r.frames > 0.6, 'heard ' + r.voiced + ' of ' + r.frames + ' ' + JSON.stringify(r.src));
  assert.ok((r.wrong || 0) <= 0.03 * r.frames, 'misread ' + r.wrong);
  const med = SF.median(r.cents);
  assert.ok(Math.abs(med - 60) < 12, 'reads ' + med + ' cents (sang +60)');
});

test('in a harder room, singing the very note the piano plays is heard when it stands out', () => {
  const r = run(scene({ calib: true, harsh: true, voiceDb: -6, cents: -8, vibrato: 8, seed: 3 }));
  assert.ok(r.voiced / r.frames > 0.6, 'heard ' + r.voiced + ' of ' + r.frames + ' ' + JSON.stringify(r.src));
  assert.ok(Math.abs(SF.median(r.cents) + 8) < 8, 'reads ' + SF.median(r.cents));
});

test('in a harder room, a voice 12 dB under the piano on its very note is heard by its own harmonics', () => {
  // the room leaves about as much of the piano as the voice: by loudness alone it can't tell,
  // but the voice's harmonics stand far above the piano's leftover at several frequencies
  const r = run(scene({ calib: true, harsh: true, voiceDb: -12, cents: -8, vibrato: 8, seed: 3 }));
  assert.ok(r.voiced / r.frames > 0.8, 'heard ' + r.voiced + ' of ' + r.frames + ' ' + JSON.stringify(r.src));
  assert.ok((r.why['its own harmonics'] || 0) > 0.3 * r.frames, JSON.stringify(r.why));
  assert.ok((r.wrong || 0) <= 0.03 * r.frames, 'misread ' + r.wrong);
  assert.ok(Math.abs(SF.median(r.cents) + 8) < 8, 'reads ' + SF.median(r.cents));
});

test('low notes (below C3): a voice 12 dB under the piano is heard, the piano alone is not', () => {
  // everything 7 semitones lower: the voice sings G♯2 down to D♯2
  const r = run(scene({ calib: true, harsh: true, voiceDb: -12, cents: -8, vibrato: 8, seed: 3, shift: -7 }));
  assert.ok(r.voiced / r.frames > 0.85, 'heard ' + r.voiced + ' of ' + r.frames + ' ' + JSON.stringify(r.src));
  assert.ok((r.wrong || 0) <= 0.03 * r.frames, 'misread ' + r.wrong);
  const silent = run(scene({ calib: true, harsh: true, seed: 3, shift: -7 }));
  assert.ok(silent.voiced <= 0.01 * silent.frames, silent.voiced + ' of ' + silent.frames + ' ' + JSON.stringify(silent.why));
});

test('in a harder room, the piano alone almost never passes for a voice', () => {
  const r = run(scene({ calib: true, harsh: true, seed: 3 }));
  assert.ok(r.voiced <= 0.03 * r.frames, r.voiced + ' of ' + r.frames + ' frames: ' + JSON.stringify(r.src));
  assert.ok(r.pf.kN.some((n) => n >= 6), 'measured keys on their own in the calibration');
});

test('a mic that changes its own volume as you sing (Windows effects) is noticed; a room is not', () => {
  const ok = run(scene({ calib: true, voiceDb: -6, cents: -10 }));
  assert.ok(ok.pf.micDrift < 7 && ok.pf.recentCancel >= 5, 'steady mic: drift ' + ok.pf.micDrift + ', cancels ' + ok.pf.recentCancel);
  const r = run(scene({ calib: true, voiceDb: -6, cents: -10, agc: true }));
  assert.ok(r.pf.micDrift >= 7 || r.pf.recentCancel < 5, 'drift ' + r.pf.micDrift + ', cancels ' + r.pf.recentCancel);
});

test('the clean-up takes out more of the piano and keeps the voice', () => {
  const sc = scene({ calib: true, harsh: true, voiceDb: -6, cents: -8, seed: 3 });
  const pf = new SF.PianoFilter(sr, {});
  pf.postR = new Float32Array(pf.cap);
  const r = run(sc, pf);
  const n = sc.mic.length;
  const res = new Float32Array(n);
  const echo = new Float32Array(n);
  for (let i = Math.max(0, n - pf.cap + 1); i < n && i < pf.done; i++) {
    res[i] = pf.resR[i & pf.mask];
    echo[i] = pf.echoR[i & pf.mask];
  }
  const post = SF.cleanUp(pf.spec, res, echo, 4);
  const sung = (t) => sc.sung.some((s) => t >= s.t && t < s.t + s.d);
  let rq = 0;
  let pq = 0;
  let rs = 0;
  let ps = 0;
  for (let i = Math.max(0, n - pf.cap + 1); i < pf.done; i++) {
    if (sung(i / sr)) {
      rs += res[i] * res[i];
      ps += post[i] * post[i];
    } else if (echo[i] !== 0) {
      rq += res[i] * res[i];
      pq += post[i] * post[i];
    }
  }
  assert.ok(r.pf.spec && r.pf.spec.ready, 'learned the leftover frequency by frequency');
  assert.ok(10 * Math.log10(rq / pq) > 3, 'removes more of the piano: ' + (10 * Math.log10(rq / pq)).toFixed(1) + ' dB');
  assert.ok(10 * Math.log10(rs / ps) < 3, 'keeps the voice: ' + (10 * Math.log10(rs / ps)).toFixed(1) + ' dB');
});

test('a room saved from last time is used at once', () => {
  const st = run(scene({ calib: true, roomSeed: 77 })).pf.exportState();
  const pf = new SF.PianoFilter(sr, {});
  pf.importState(st);
  assert.ok(pf.ready, 'ready before hearing a note');
  const r = run(scene({ voiceDb: -6, cents: -10, seed: 5, roomSeed: 77 }), pf);
  assert.ok(r.voiced / r.frames > 0.6, 'hears the voice from the first key: ' + JSON.stringify(r.src));
  assert.ok(!pf.dropped, 'kept it');
});

test('a saved room is not spoiled by the first chord it hears again', () => {
  const st = run(scene({ calib: true, roomSeed: 77 })).pf.exportState();
  assert.ok(st.spec && st.spec.num, 'the leftover picture is saved too');
  const pf = new SF.PianoFilter(sr, {});
  pf.importState(st);
  const r = run(scene({ seed: 5, roomSeed: 77 }), pf);
  assert.strictEqual(r.voiced, 0, 'nothing heard from the piano alone: ' + JSON.stringify(r.src) + ' ' + JSON.stringify(r.why));
  assert.ok(pf.cancelDb > 15, 'still cancels ' + pf.cancelDb);
});
