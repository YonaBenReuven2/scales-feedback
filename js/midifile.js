/* Standard MIDI File reader and tempo map.
 *
 * Reads format 0/1/2 files (and RIFF "RMID" wrappers), running status, metas and
 * sysex, and pairs note-ons with note-offs first-in-first-out per track, channel
 * and pitch, so three voices sounding the same pitch stay three notes.
 */
(function (root) {
  'use strict';
  const SF = root.SF;

  function parseMidi(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let base = 0;
    const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const u32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    const u16 = (o) => (bytes[o] << 8) | bytes[o + 1];

    if (bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'RMID') {
      for (let o = 12; o + 8 <= bytes.length; ) {
        const len = bytes[o + 4] | (bytes[o + 5] << 8) | (bytes[o + 6] << 16) | (bytes[o + 7] << 24);
        if (tag(o) === 'data') {
          base = o + 8;
          break;
        }
        o += 8 + len + (len & 1);
      }
    }
    if (bytes.length < base + 14 || tag(base) !== 'MThd') throw new Error('Not a MIDI file (no MThd header)');
    const hlen = u32(base + 4);
    const format = u16(base + 8);
    const ntrks = u16(base + 10);
    const division = u16(base + 12);
    let ppq;
    let smpte = false;
    if (division & 0x8000) {
      // SMPTE time: express it as a fixed tempo of 0.5 s per "quarter".
      smpte = true;
      let fps = 256 - (division >> 8);
      if (fps === 29) fps = 29.97;
      const tpf = division & 0xff;
      ppq = Math.round(fps * tpf * 0.5);
    } else {
      ppq = division || 480;
    }

    const out = {
      format,
      ppq,
      smpte,
      tracks: [],
      notes: [],
      tempos: [],
      timeSigs: [],
      keySigs: [],
      markers: [],
      endTick: 0,
    };

    let p = base + 8 + hlen;
    let trk = 0;
    let trackOffset = 0; // format 2: tracks play one after another
    while (p + 8 <= bytes.length && trk < Math.max(ntrks, 1) + 64) {
      const id = tag(p);
      const len = u32(p + 4);
      const start = p + 8;
      const end = Math.min(start + len, bytes.length);
      p = start + len;
      if (id !== 'MTrk') continue;
      const t = parseTrack(bytes, start, end, trk, out, format === 2 ? trackOffset : 0);
      if (format === 2) trackOffset = t.endTick;
      trk++;
    }
    if (smpte) out.tempos = [{ tick: 0, uspq: 500000 }];
    out.notes.sort((a, b) => a.on - b.on || a.pitch - b.pitch || a.trk - b.trk);
    out.tempos.sort((a, b) => a.tick - b.tick);
    return out;
  }

  function parseTrack(bytes, p, end, trk, out, offset) {
    const track = { name: '', noteCount: 0, instrument: '' };
    out.tracks.push(track);
    let tick = offset;
    let status = 0;
    const open = new Map(); // (ch,pitch) -> [{on, vel}]
    const vlq = () => {
      let v = 0;
      for (let i = 0; i < 4 && p < end; i++) {
        const b = bytes[p++];
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return v;
    };
    const text = (s, e) => {
      let r = '';
      for (let i = s; i < e; i++) r += String.fromCharCode(bytes[i]);
      try {
        return decodeURIComponent(escape(r)); // UTF-8 if it is UTF-8
      } catch (err) {
        return r;
      }
    };
    const noteOff = (ch, pitch) => {
      const k = ch * 128 + pitch;
      const q = open.get(k);
      if (!q || !q.length) return;
      const n = q.shift();
      if (tick > n.on) {
        out.notes.push({ pitch, vel: n.vel, ch, trk, on: n.on, off: tick });
        track.noteCount++;
      }
    };

    while (p < end) {
      tick += vlq();
      if (p >= end) break;
      let b = bytes[p];
      if (b === 0xff) {
        p++;
        const type = bytes[p++];
        const len = vlq();
        const ds = p;
        p += len;
        if (p > end) break;
        if (type === 0x51 && len >= 3) {
          out.tempos.push({ tick, uspq: (bytes[ds] << 16) | (bytes[ds + 1] << 8) | bytes[ds + 2] });
        } else if (type === 0x58 && len >= 2) {
          out.timeSigs.push({ tick, num: bytes[ds], den: 1 << bytes[ds + 1] });
        } else if (type === 0x59 && len >= 2) {
          const sf = bytes[ds] > 127 ? bytes[ds] - 256 : bytes[ds];
          out.keySigs.push({ tick, sf, mi: bytes[ds + 1] });
        } else if (type === 0x03) {
          if (!track.name) track.name = text(ds, ds + len).trim();
        } else if (type === 0x04) {
          track.instrument = text(ds, ds + len).trim();
        } else if (type === 0x06 || type === 0x01) {
          out.markers.push({ tick, text: text(ds, ds + len), kind: type === 0x06 ? 'marker' : 'text', trk });
        } else if (type === 0x2f) {
          break;
        }
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        p++;
        p += vlq();
        status = 0;
        continue;
      }
      if (b & 0x80) {
        status = b;
        p++;
      } else if (!status) {
        p++; // stray data byte with no running status: skip it
        continue;
      }
      const kind = status & 0xf0;
      const ch = status & 0x0f;
      if (kind === 0xc0 || kind === 0xd0) {
        p += 1;
        continue;
      }
      const d1 = bytes[p++] & 0x7f;
      const d2 = bytes[p++] & 0x7f;
      if (kind === 0x90 && d2 > 0) {
        const k = ch * 128 + d1;
        if (!open.has(k)) open.set(k, []);
        open.get(k).push({ on: tick, vel: d2 });
      } else if (kind === 0x80 || kind === 0x90) {
        noteOff(ch, d1);
      }
    }
    // Close anything left hanging at the end of the track.
    for (const [k, q] of open) for (const n of q) {
      if (tick > n.on) {
        out.notes.push({ pitch: k % 128, vel: n.vel, ch: (k / 128) | 0, trk, on: n.on, off: tick });
        track.noteCount++;
      }
    }
    out.endTick = Math.max(out.endTick, tick);
    return { endTick: tick };
  }

  /** Converts between ticks and seconds through the file's tempo changes. */
  class TempoMap {
    constructor(ppq, tempos) {
      this.ppq = ppq;
      const t = (tempos || []).filter((x) => x.uspq > 0).sort((a, b) => a.tick - b.tick);
      const segs = [];
      for (const x of t) {
        if (segs.length && segs[segs.length - 1].tick === x.tick) segs[segs.length - 1].uspq = x.uspq;
        else segs.push({ tick: x.tick, uspq: x.uspq });
      }
      if (!segs.length || segs[0].tick > 0) segs.unshift({ tick: 0, uspq: segs.length ? segs[0].uspq : 500000 });
      let sec = 0;
      for (let i = 0; i < segs.length; i++) {
        if (i > 0) sec += ((segs[i].tick - segs[i - 1].tick) * segs[i - 1].uspq) / 1e6 / ppq;
        segs[i].sec = sec;
      }
      this.segs = segs;
      this.bpm = 60e6 / segs[0].uspq;
    }
    sec(tick) {
      const s = this.segs;
      let i = s.length - 1;
      if (tick < s[i].tick) i = Math.max(0, SF.lowerBound(s, tick + 1e-9, (x) => x.tick) - 1);
      const g = s[i];
      return g.sec + ((tick - g.tick) * g.uspq) / 1e6 / this.ppq;
    }
    tick(sec) {
      const s = this.segs;
      let i = s.length - 1;
      if (sec < s[i].sec) i = Math.max(0, SF.lowerBound(s, sec + 1e-12, (x) => x.sec) - 1);
      const g = s[i];
      return g.tick + ((sec - g.sec) * 1e6 * this.ppq) / g.uspq;
    }
    bpmAt(tick) {
      const s = this.segs;
      const i = Math.max(0, SF.lowerBound(s, tick + 1e-9, (x) => x.tick) - 1);
      return 60e6 / s[i].uspq;
    }
  }

  SF.parseMidi = parseMidi;
  SF.TempoMap = TempoMap;
})(typeof window !== 'undefined' ? window : globalThis);
