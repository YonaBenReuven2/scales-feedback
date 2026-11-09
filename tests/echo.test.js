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
  if (o.calib) {
    // as the app calibrates: a run over the range, then three chords
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
  const ref = R.piano(ev, sr, dur);
  const room = R.shift(R.convolve(ref, R.roomIR(sr, { rt60: 0.35 })), 0.0283 * sr, o.drift || 0);
  const v = new Float32Array(ref.length);
  if (o.voiceDb != null) {
    for (const s of sung) {
      const seg = voice(() => s.pitch + (o.cents || 0) / 100, sr, s.d, { vowel: 'a' });
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
  return { ev, sung, ref, mic };
}

/** Streams the scene through the filter as the app does; returns what each sung frame said. */
function run(sc) {
  const pf = new SF.PianoFilter(sr, {});
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
  const out = { frames: 0, hit: 0, voiced: 0, cents: [], src: {}, log: process.env.ECHO_LOG ? [] : null };
  let analyzed = W;
  for (let p = 0; p + B <= sc.mic.length; p += B) {
    const evs = byBlock.get(p / B) || null;
    pf.push(sc.mic.subarray(p, p + B), sc.ref.subarray(p, p + B), !inSung((p + B / 2) / sr), !!(evs && evs.some((e) => e.on)), evs);
    while (analyzed + 512 <= pf.done) {
      analyzed += 512;
      const tc = (analyzed - W / 2) / sr;
      const fr = SF.analyzeFrame(pf, tr, analyzed, tc * 1000);
      const s = sc.sung.find((x) => tc >= x.t + 0.1 && tc < x.t + x.d - 0.03);
      if (!s) continue;
      out.frames++;
      out.src[fr.source] = (out.src[fr.source] || 0) + 1;
      if (out.log) out.log.push([+tc.toFixed(2), s.pitch, fr.source, fr.voiced ? +fr.midi.toFixed(2) : null, fr.presence == null ? null : +fr.presence.toFixed(1), +pf.leftover.toFixed(4), pf.leastLearned(analyzed, W)]);
      if (fr.voiced) {
        out.voiced++;
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
  assert.strictEqual(silent.voiced, 0, 'nothing from the piano alone: ' + JSON.stringify(silent.src));
});
