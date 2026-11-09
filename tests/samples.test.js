// Reading the piano samples zip: zip directory, both compression methods, WAV flavours.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const SF = require('./load.js')('core', 'samples');

function wav(channels, sr, bits, float) {
  const ch = channels.length;
  const n = channels[0].length;
  const bps = bits / 8;
  const data = Buffer.alloc(n * ch * bps);
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = channels[c][i];
      if (float) data.writeFloatLE(v, o);
      else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), o);
      else if (bits === 24) data.writeIntLE(Math.round(v * 8388607), o, 3);
      o += bps;
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(float ? 3 : 1, 20);
  h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * ch * bps, 28);
  h.writeUInt16LE(ch * bps, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A minimal zip writer: entries [{name, data, deflate}]. */
function zip(entries) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const crc = zlib.crc32 ? zlib.crc32(e.data) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const tone = (n, f, sr, a = 0.5) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / sr));

test('a zip with stored and deflated recordings', async () => {
  const w1 = wav([tone(4410, 261.6, 44100)], 44100, 16);
  const w2 = wav([tone(2000, 440, 48000), tone(2000, 440, 48000, 0.25)], 48000, 24);
  const z = zip([
    { name: 'p225/m060_C4_v080.wav', data: w1 },
    { name: 'p225/m069_A4_v100.wav', data: w2, deflate: true },
    { name: 'notes.txt', data: Buffer.from('hello'), deflate: true },
  ]);
  const entries = SF.readZip(z);
  assert.deepStrictEqual(entries.map((e) => e.name), ['p225/m060_C4_v080.wav', 'p225/m069_A4_v100.wav', 'notes.txt']);
  const d1 = await entries[0].data();
  assert.strictEqual(Buffer.compare(Buffer.from(d1), w1), 0);
  const d2 = await entries[1].data();
  assert.strictEqual(Buffer.compare(Buffer.from(d2), w2), 0, 'inflated back to the same bytes');
  const p2 = SF.parseWav(d2);
  assert.strictEqual(p2.sr, 48000);
  assert.strictEqual(p2.channels.length, 2);
  assert.ok(Math.abs(p2.channels[1][100] - 0.25 * Math.sin((2 * Math.PI * 440 * 100) / 48000)) < 1e-5);
});

test('WAV: 16-bit, 24-bit and float samples come back as numbers in [-1, 1]', () => {
  const x = tone(1000, 100, 44100, 0.8);
  for (const [bits, float, tol] of [[16, false, 1e-4], [24, false, 1e-6], [32, true, 1e-7]]) {
    const p = SF.parseWav(new Uint8Array(wav([x], 44100, bits, float)));
    assert.strictEqual(p.channels[0].length, 1000);
    for (let i = 0; i < 1000; i += 37) assert.ok(Math.abs(p.channels[0][i] - x[i]) < tol, bits + '-bit sample ' + i);
  }
  assert.throws(() => SF.parseWav(new Uint8Array(Buffer.from('RIFF....WAVX'))));
});

test('a recording is trimmed to just before the key sounds', () => {
  const sr = 44100;
  const x = new Float32Array(sr);
  for (let i = 0; i < sr; i++) if (i >= 10000) x[i] = 0.5 * Math.sin(i / 10) * Math.exp(-(i - 10000) / 8000);
  const { start, peak } = SF.sampleOnset([x], sr);
  assert.ok(peak > 0.4);
  assert.ok(start <= 10000 && start >= 10000 - Math.round(0.006 * sr), 'start ' + start);
});

test('not a zip is said plainly', () => {
  assert.throws(() => SF.readZip(new Uint8Array(100)), /Not a zip/);
});
