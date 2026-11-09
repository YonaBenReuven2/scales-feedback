// The mic and the piano input are found and opened as Chrome on Windows exposes them:
// unnamed inputs until the mic is allowed, a prompt in which the person picks one,
// then "default"/"communications" entries next to the real inputs.
const test = require('node:test');
const assert = require('node:assert');
const SF = require('./load.js')('core', 'listen');

const MIC = { id: 'h-mic', label: 'Microphone Array (Realtek(R) Audio)', group: 'g1' };
const PIANO = { id: 'h-piano', label: 'Line (P-Series) (0499:1715)', group: 'g2' };
const HEADSET = { id: 'h-hs', label: 'Headset (WH-1000XM4 Hands-Free AG Audio)', group: 'g3' };

function fakeTrack(id, label) {
  const t = { label, readyState: 'live', stopped: false, onended: null, getSettings: () => ({ deviceId: id, sampleRate: 48000 }), stop() { this.stopped = true; this.readyState = 'ended'; } };
  return t;
}
function fakeStream(id, label) {
  const t = fakeTrack(id, label);
  return { t, getAudioTracks: () => [t], getTracks: () => [t] };
}

/** A pretend Chrome on Windows. o: {perm, pick (what the prompt hands back), def (Windows default), faults} */
function browser(o) {
  const st = { perm: o.perm || 'prompt', calls: [], streams: [] };
  const devs = [MIC, PIANO, HEADSET];
  const def = devs.find((d) => d.id === (o.def || MIC.id));
  const md = {
    async enumerateDevices() {
      if (st.perm !== 'granted') return [{ deviceId: '', kind: 'audioinput', label: '', groupId: '' }];
      return [
        { deviceId: 'default', kind: 'audioinput', label: 'Default - ' + def.label, groupId: def.group },
        { deviceId: 'communications', kind: 'audioinput', label: 'Communications - ' + def.label, groupId: def.group },
      ].concat(devs.map((d) => ({ deviceId: d.id, kind: 'audioinput', label: d.label, groupId: d.group })));
    },
    async getUserMedia(c) {
      const dv = c.audio.deviceId;
      const want = dv ? dv.exact || dv.ideal : null;
      st.calls.push((want || 'any') + (dv && dv.exact ? '!' : '') + '@' + st.perm);
      let d;
      let reported;
      if (st.perm !== 'granted') {
        if (dv && dv.exact && !devs.some((x) => x.id === want)) throw Object.assign(new Error(''), { name: 'OverconstrainedError', constraint: 'deviceId' });
        // the person allowed it in the prompt; a page opened from the disk keeps nothing
        if (!o.perRequest) st.perm = 'granted';
        const pick = o.picks && o.picks.length ? o.picks.shift() : o.pick;
        d = (want && devs.find((x) => x.id === want)) || devs.find((x) => x.id === pick) || def;
        reported = d.id;
      } else if (want) {
        d = devs.find((x) => x.id === want);
        if (!d) throw Object.assign(new Error(''), { name: 'OverconstrainedError', constraint: 'deviceId' });
        reported = d.id;
      } else {
        d = def;
        reported = 'default';
      }
      const f = (o.faults || {})[d.id];
      if (f === 'hang') return new Promise(() => {});
      if (f === 'busy') throw Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' });
      const s = fakeStream(reported, reported === 'default' ? 'Default - ' + d.label : d.label);
      st.streams.push(s);
      return s;
    },
  };
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: md, permissions: { query: async () => ({ state: st.perm }) } }, configurable: true, writable: true });
  return st;
}

function listener() {
  SF.audio = { ctx: { sampleRate: 48000, state: 'running' }, resume() {}, exists: true };
  const L = new SF.Listener();
  L.build = async () => {};
  L.startEngine = () => {};
  L.openTimeout = 80;
  return L;
}

test('first time: the names are asked for, and the mic picked in the browser’s prompt is kept', async () => {
  const st = browser({ pick: MIC.id, def: PIANO.id });
  const L = listener();
  await L.start(null);
  assert.strictEqual(L.micId, MIC.id);
  assert.strictEqual(L.micLabel, MIC.label);
  assert.deepStrictEqual(st.calls, ['any@prompt']);
});

test('first time, the prompt left on Windows’ default, which is the piano: the real mic is opened instead', async () => {
  const st = browser({ pick: PIANO.id, def: PIANO.id });
  const L = listener();
  await L.start(null);
  assert.strictEqual(L.micId, MIC.id);
  assert.strictEqual(L.micLabel, MIC.label);
  assert.ok(st.streams[0].t.stopped, 'the piano stream from the prompt was closed');
  assert.strictEqual(L.warning, '');
});

test('a stored mic that is the piano is not reused; picked just now, it is (with a warning)', async () => {
  browser({ perm: 'granted', def: PIANO.id });
  const L = listener();
  await L.start(PIANO.id);
  assert.strictEqual(L.micId, MIC.id);
  await L.start(PIANO.id, { allowPiano: true });
  assert.strictEqual(L.micId, PIANO.id);
  assert.ok(/piano/.test(L.warning));
});

test('an input reported as "default" is matched to the real one', async () => {
  const st = browser({ perm: 'granted', def: HEADSET.id });
  const L = listener();
  const s = await navigator.mediaDevices.getUserMedia({ audio: {} });
  const got = await L.which(s);
  assert.deepStrictEqual(got, { id: HEADSET.id, label: HEADSET.label });
  assert.ok(st.calls.length === 1);
});

test('the piano input opens next to the mic, never as the mic itself', async () => {
  browser({ perm: 'granted' });
  const L = listener();
  await L.start(null);
  L.running = true;
  await L.setReference(PIANO.id);
  assert.strictEqual(L.refId, PIANO.id);
  assert.strictEqual(L.refLabel, PIANO.label);
  await assert.rejects(L.setReference(MIC.id), /microphone itself/);
  assert.strictEqual(L.refStream, null);
});

test('a piano input that never opens, or that Windows refuses, ends in a clear reason', async () => {
  browser({ perm: 'granted', faults: { 'h-piano': 'hang' } });
  let L = listener();
  await L.start(null);
  L.running = true;
  let err = null;
  await L.setReference(PIANO.id).catch((e) => (err = e));
  assert.strictEqual(err.name, 'TimeoutError');
  assert.ok(/didn’t open/.test(SF.inputError(err, err.device)) && err.device === PIANO.label);
  browser({ perm: 'granted', faults: { 'h-piano': 'busy' } });
  L = listener();
  await L.start(null);
  L.running = true;
  err = null;
  await L.setReference(PIANO.id).catch((e) => (err = e));
  assert.strictEqual(err.name, 'NotReadableError');
  assert.ok(/Another program/.test(SF.inputError(err, err.device)));
  assert.strictEqual(L.micId, MIC.id, 'the mic keeps working');
});

test('a piano that goes away is reported', async () => {
  const st = browser({ perm: 'granted' });
  const L = listener();
  await L.start(null);
  L.running = true;
  await L.setReference(PIANO.id);
  let lost = null;
  L.on('lost', (w) => (lost = w));
  st.streams[st.streams.length - 1].t.onended();
  assert.strictEqual(lost, 'ref');
  assert.strictEqual(L.refStream, null);
});

test('opened from the disk (Chrome hides every input and asks for each): the piano is asked for in a second box', async () => {
  const st = browser({ perRequest: true, picks: [MIC.id, PIANO.id] });
  const L = listener();
  await L.start(null);
  L.running = true;
  assert.strictEqual(L.micLabel, MIC.label);
  assert.ok(!(await L.devices()).some((d) => d.label), 'the names stay hidden');
  await L.askReference(null);
  assert.strictEqual(L.refLabel, PIANO.label);
  assert.strictEqual(L.refId, PIANO.id);
  assert.deepStrictEqual(st.calls, ['any@prompt', 'any@prompt']);
});

test('opened from the disk: the mic handed back again is refused; the piano from last time is asked for by its id', async () => {
  browser({ perRequest: true, picks: [MIC.id, MIC.id] });
  let L = listener();
  await L.start(null);
  L.running = true;
  await assert.rejects(L.askReference(null), (e) => e.name === 'SameAsMic');
  assert.strictEqual(L.refStream, null);
  const st = browser({ perRequest: true, picks: [MIC.id, MIC.id] });
  L = listener();
  await L.start(null);
  L.running = true;
  await L.askReference(PIANO.id);
  assert.strictEqual(L.refLabel, PIANO.label);
  assert.deepStrictEqual(st.calls, ['any@prompt', 'h-piano!@prompt']);
});
