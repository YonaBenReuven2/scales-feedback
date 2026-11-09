// Writes small Standard MIDI Files for tests: new exercises made up on the spot.
//   smf({ ppq, bpm, tracks: [{ name, ch, notes: [{ p, t, d, v }] }] })   t and d in beats
//   tempo changes: tempos: [{ t, bpm }] (beats)
function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
function track(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bytes = [];
  let last = 0;
  for (const e of events) {
    bytes.push(...vlq(Math.round(e.tick - last)), ...e.data);
    last = Math.round(e.tick);
  }
  bytes.push(0, 0xff, 0x2f, 0);
  const len = bytes.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...bytes];
}
function smf(spec) {
  const ppq = spec.ppq || 480;
  const tracks = [];
  const tempo = [{ tick: 0, order: 0, data: tempoEv(spec.bpm || 100) }];
  for (const tc of spec.tempos || []) tempo.push({ tick: tc.t * ppq, order: 0, data: tempoEv(tc.bpm) });
  tracks.push(track(tempo));
  for (const tr of spec.tracks) {
    const ev = [];
    const name = Buffer.from(tr.name || '');
    if (tr.name) ev.push({ tick: 0, order: 0, data: [0xff, 0x03, ...vlq(name.length), ...name] });
    const ch = tr.ch || 0;
    for (const n of tr.notes) {
      ev.push({ tick: n.t * ppq, order: 2, data: [0x90 | ch, n.p, n.v == null ? 100 : n.v] });
      // note-offs as note-on velocity 0 sometimes, as some writers do
      ev.push({ tick: (n.t + n.d) * ppq, order: 1, data: n.zeroOff ? [0x90 | ch, n.p, 0] : [0x80 | ch, n.p, 0] });
    }
    tracks.push(track(ev));
  }
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, (ppq >> 8) & 255, ppq & 255];
  return Buffer.from(head.concat(...tracks));
}
function tempoEv(bpm) {
  const us = Math.round(60e6 / bpm);
  return [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255];
}
/** One "round" of a scale exercise: a held reference chord, then the line to sing. */
function round(t, chord, line, opts) {
  opts = opts || {};
  const notes = [];
  const cd = opts.chordBeats || 2;
  for (const p of chord) notes.push({ p, t, d: cd });
  let u = t + cd;
  for (const p of line) {
    notes.push({ p, t: u, d: opts.noteBeats || 1, sing: true });
    u += opts.noteBeats || 1;
  }
  return { notes, end: u + (opts.gap || 0) };
}
module.exports = { smf, round };
