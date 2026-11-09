/* Imported piano samples: read a zip of mNNN_<name>_vVVV.wav recordings, trim each
 * note at its onset, keep them in this browser only (IndexedDB), play them back.
 * The recordings never touch the repository or the website.
 */
(function (root) {
  'use strict';
  const SF = root.SF;

  // ---------- zip (stored + deflate) ----------
  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unzip (no DecompressionStream)');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function readZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a zip file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged zip directory');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const size = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (csize === 0xffffffff || off === 0xffffffff) throw new Error('Zip64 files are not supported');
      const lnlen = dv.getUint16(off + 26, true);
      const lxlen = dv.getUint16(off + 28, true);
      const start = off + 30 + lnlen + lxlen;
      entries.push({
        name,
        size,
        method,
        async data() {
          const raw = u8.subarray(start, start + csize);
          if (method === 0) return raw;
          if (method === 8) return inflateRaw(raw);
          throw new Error('Unsupported zip compression in ' + name);
        },
      });
    }
    return entries;
  }

  // ---------- WAV ----------
  function parseWav(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
    let fmt = null;
    let data = null;
    for (let p = 12; p + 8 <= u8.length; ) {
      const id = tag(p);
      const len = dv.getUint32(p + 4, true);
      if (id === 'fmt ') {
        let format = dv.getUint16(p + 8, true);
        if (format === 0xfffe && len >= 40) format = dv.getUint16(p + 8 + 24, true); // extensible
        fmt = { format, ch: dv.getUint16(p + 10, true), sr: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
      } else if (id === 'data') {
        data = { start: p + 8, len: Math.min(len, u8.length - p - 8) };
      }
      p += 8 + len + (len & 1);
    }
    if (!fmt || !data) throw new Error('WAV without fmt/data');
    const { format, ch, bits } = fmt;
    const bps = bits / 8;
    const frames = Math.floor(data.len / (bps * ch));
    const out = [];
    for (let c = 0; c < ch; c++) out.push(new Float32Array(frames));
    let o = data.start;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < ch; c++) {
        let v;
        if (format === 3 && bits === 32) v = dv.getFloat32(o, true);
        else if (bits === 16) v = dv.getInt16(o, true) / 32768;
        else if (bits === 24) {
          let x = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16);
          if (x & 0x800000) x |= ~0xffffff;
          v = x / 8388608;
        } else if (bits === 32) v = dv.getInt32(o, true) / 2147483648;
        else if (bits === 8) v = (u8[o] - 128) / 128;
        else throw new Error('Unsupported WAV format: ' + bits + '-bit');
        out[c][i] = v;
        o += bps;
      }
    }
    return { sr: fmt.sr, channels: out };
  }

  /** First sample above 5% of the peak, minus 4 ms (what works on the P-225 recordings). */
  function onsetIndex(chs, sr) {
    let peak = 0;
    for (const c of chs) for (let i = 0; i < c.length; i++) if (Math.abs(c[i]) > peak) peak = Math.abs(c[i]);
    if (!peak) return { start: 0, peak };
    const th = 0.05 * peak;
    let first = 0;
    outer: for (let i = 0; i < chs[0].length; i++) {
      for (const c of chs) {
        if (Math.abs(c[i]) > th) {
          first = i;
          break outer;
        }
      }
    }
    return { start: Math.max(0, first - Math.round(0.004 * sr)), peak };
  }

  const NAME_RE = /(?:^|\/)m(\d{1,3})(?:_[^/]*?)?_v(\d{1,3})\.wav$/i;

  /** Import a samples zip into IndexedDB. onProgress(done, total). */
  async function importZip(file, onProgress) {
    const u8 = new Uint8Array(await file.arrayBuffer());
    const entries = readZip(u8).filter((e) => NAME_RE.test(e.name));
    if (!entries.length) throw new Error('No mNNN_<name>_vVVV.wav recordings in this zip');
    await SF.idb.clear('samples');
    const metaNotes = [];
    let done = 0;
    let srSeen = 0;
    const peaks = [];
    for (const e of entries) {
      const [, m, v] = NAME_RE.exec(e.name);
      const midi = +m;
      const vel = +v;
      const wav = parseWav(await e.data());
      const chs = wav.channels.slice(0, 2);
      const { start, peak } = onsetIndex(chs, wav.sr);
      const frames = chs[0].length - start;
      if (frames <= 0 || !peak) {
        done++;
        continue;
      }
      const inter = new Int16Array(frames * chs.length);
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < chs.length; c++) inter[i * chs.length + c] = Math.round(SF.clamp(chs[c][start + i], -1, 1) * 32767);
      }
      await SF.idb.put('samples', 'n:' + midi + ':' + vel, { midi, vel, sr: wav.sr, ch: chs.length, frames, data: inter.buffer });
      metaNotes.push({ midi, vel, peak });
      peaks.push(peak);
      srSeen = wav.sr;
      done++;
      if (onProgress) onProgress(done, entries.length);
    }
    if (!metaNotes.length) throw new Error('The recordings in this zip are empty');
    // one gain for the whole set: the median peak lands at 0.7
    const gain = 0.7 / SF.median(peaks);
    const meta = {
      name: (file.name || 'samples').replace(/\.zip$/i, ''),
      notes: metaNotes.map((n) => [n.midi, n.vel]),
      lo: Math.min(...metaNotes.map((n) => n.midi)),
      hi: Math.max(...metaNotes.map((n) => n.midi)),
      vels: [...new Set(metaNotes.map((n) => n.vel))].sort((a, b) => a - b),
      gain,
      sr: srSeen,
      importedAt: Date.now(),
    };
    await SF.idb.put('samples', 'meta', meta);
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch (err) {
      /* best effort */
    }
    return meta;
  }

  /** The imported set, loaded on demand into AudioBuffers. */
  class SampleBank {
    constructor(meta) {
      this.meta = meta;
      this.name = meta.name;
      this.gain = meta.gain;
      this.byMidi = new Map(); // midi -> [{midi, vel}]
      for (const [m, v] of meta.notes) {
        if (!this.byMidi.has(m)) this.byMidi.set(m, []);
        this.byMidi.get(m).push({ midi: m, vel: v, key: 'n:' + m + ':' + v });
      }
      for (const l of this.byMidi.values()) l.sort((a, b) => a.vel - b.vel);
      this.recorded = [...this.byMidi.keys()].sort((a, b) => a - b);
      this.cache = new Map();
      this.loading = new Map();
    }
    static async load() {
      try {
        const meta = await SF.idb.get('samples', 'meta');
        return meta ? new SampleBank(meta) : null;
      } catch (e) {
        return null;
      }
    }
    /** The recording to use for a pitch at a velocity: the nearest note, then the nearest velocity. */
    pick(p, v) {
      if (!this.recorded.length) return null;
      let best = this.recorded[0];
      for (const m of this.recorded) if (Math.abs(m - p) < Math.abs(best - p)) best = m;
      const layers = this.byMidi.get(best);
      let s = layers[0];
      for (const l of layers) if (Math.abs(l.vel - v) < Math.abs(s.vel - v)) s = l;
      return s;
    }
    buffer(s) {
      const b = this.cache.get(s.key);
      if (b) return b;
      this.prepare([s.midi]); // not ready yet: get it ready for next time
      return null;
    }
    /** Decode the recordings needed for these pitches ahead of time. */
    async prepare(pitches) {
      const want = new Set();
      for (const p of pitches) for (const v of [30, 60, 90, 120]) {
        const s = this.pick(p, v);
        if (s) want.add(s);
      }
      const c = SF.audio.ctx;
      await Promise.all(
        [...want].map(async (s) => {
          if (this.cache.has(s.key) || this.loading.has(s.key)) return this.loading.get(s.key);
          const job = (async () => {
            const rec = await SF.idb.get('samples', s.key);
            if (!rec) return;
            const data = new Int16Array(rec.data);
            const buf = c.createBuffer(rec.ch, rec.frames, rec.sr);
            for (let ch = 0; ch < rec.ch; ch++) {
              const out = buf.getChannelData(ch);
              for (let i = 0; i < rec.frames; i++) out[i] = data[i * rec.ch + ch] / 32768;
            }
            this.cache.set(s.key, buf);
          })();
          this.loading.set(s.key, job);
          await job;
          this.loading.delete(s.key);
        })
      );
    }
  }

  async function removeSamples() {
    await SF.idb.clear('samples');
  }

  SF.readZip = readZip;
  SF.parseWav = parseWav;
  SF.importSamplesZip = importZip;
  SF.SampleBank = SampleBank;
  SF.removeSamples = removeSamples;
  SF.sampleOnset = onsetIndex;
})(typeof window !== 'undefined' ? window : globalThis);
