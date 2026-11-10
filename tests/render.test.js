// The picture's geometry: which keys show (the exercise, all 88, or a set number that scroll),
// following what is about to be played, keys under the pointer, dragging the keyboard's edges.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SF = require('./load.js')('core', 'midifile', 'analyze', 'player', 'scoring', 'render');

const fx = (f) => SF.analyze(SF.parseMidi(fs.readFileSync(path.join(__dirname, 'fixtures', f))));
let clock = 0;
SF.now = () => clock;
const silentOut = { lookahead: 40, noteOn() {}, noteOff() {}, allOff() {} };

/** A canvas that draws nothing but records how many things were drawn. */
function fakeCanvas(w, h) {
  const calls = { n: 0 };
  const g = new Proxy(
    {},
    {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'measureText') return (s) => ({ width: String(s).length * 7 });
        if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
        return () => {
          calls.n++;
        };
      },
      set(t, k, v) {
        t[k] = v;
        return true;
      },
    }
  );
  return { calls, width: 0, height: 0, getContext: () => g, getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0 }) };
}
function setup(file, opts, size) {
  clock = 1000;
  const p = new SF.Player({ preroll: 0.5 }, { ticker: false });
  p.setOutput(silentOut);
  const ex = fx(file || 'basic_scale_whole.mid');
  p.load(ex);
  const sc = new SF.Scorer(p, {});
  const cv = fakeCanvas((size || [1200, 800])[0], (size || [1200, 800])[1]);
  const r = new SF.Renderer(cv, p, sc);
  r.set(opts || {});
  r.fit(ex);
  return { p, sc, r, ex, cv };
}
const whites = (lo, hi) => {
  let n = 0;
  for (let m = lo; m <= hi; m++) if (!SF.isBlack(m)) n++;
  return n;
};

test('it shows the exercise with keys to spare, all 88, or a set number of white keys', () => {
  const { r, ex } = setup();
  assert.ok(r.lo <= ex.lo - 2 && r.hi >= ex.hi + 2, 'the exercise and a little either side');
  assert.ok(!r.zoomed && r.sx === 0);
  assert.strictEqual(r.whitesShown(), whites(r.lo, r.hi));
  r.set({ view: 'all' });
  assert.deepStrictEqual([r.lo, r.hi, r.whitesShown(), r.zoomed], [21, 108, 52, false]);
  r.set({ view: 'zoom', whites: 14 });
  assert.ok(r.zoomed);
  assert.strictEqual(r.whitesShown(), 14);
  assert.ok(Math.abs(r.ww - 1200 / 14) < 1e-9);
  // a zoomed view starts on the exercise
  const mid = r.pitchAt(r.sx + r.W / 2);
  assert.ok(mid >= ex.lo && mid <= ex.hi, 'centred on the exercise: ' + SF.noteName(mid));
});

test('zooming keeps the middle of the view where it was', () => {
  const { r } = setup(null, { view: 'zoom', whites: 20 });
  r.scrollTo(r.xOf(72) - r.W / 2);
  const before = r.pitchAt(r.sx + r.W / 2);
  r.set({ whites: 12 });
  assert.strictEqual(r.pitchAt(r.sx + r.W / 2), before);
});

test('the key under the pointer: black keys on the upper part, white below', () => {
  const { r } = setup();
  const c4 = r.keyX.get(60);
  const cs4 = r.keyX.get(61);
  assert.strictEqual(r.keyAt(cs4.c, r.yNow + 5), 61);
  assert.strictEqual(r.keyAt(cs4.c, r.yNow + r.kbH * 0.9), cs4.c < c4.x + c4.w ? 60 : 62);
  assert.strictEqual(r.keyAt(c4.x + 2, r.yNow + r.kbH * 0.9), 60);
  assert.strictEqual(r.keyAt(c4.c, r.yNow - 10), null, 'not above the keys');
  // scrolled: the same screen spot is another key
  r.set({ view: 'zoom', whites: 10 });
  r.scrollTo(r.xOf(48) - 5);
  assert.strictEqual(r.keyAt(5 + (r.keyX.get(48).c - r.xOf(48)), r.yNow + r.kbH * 0.9), 48);
});

test('dragging the keyboard’s edges: taller keys, a bigger or smaller strip below, the notes keep room', () => {
  const { r } = setup(null, {}, [1200, 800]);
  const kb0 = r.kbH;
  const bottom = r.yNow + r.kbH;
  assert.strictEqual(r.edgeAt(r.yNow + 2), 'top');
  assert.strictEqual(r.edgeAt(bottom - 3), 'bottom');
  assert.strictEqual(r.edgeAt(r.yNow + r.kbH / 2), null);
  const f = r.dragEdge('top', r.yNow - 60);
  assert.ok(Math.abs(r.kbH - (kb0 + 60)) < 1e-6 && Math.abs(r.yNow + r.kbH - bottom) < 1e-6, 'the top moves, the bottom stays');
  assert.ok(Math.abs(f.kbFrac - r.kbH / 800) < 1e-9);
  const hist0 = r.histH;
  r.dragEdge('bottom', r.yNow + r.kbH + 50);
  assert.ok(Math.abs(r.histH - (hist0 - 50)) < 1e-6, 'the strip below gets smaller');
  // never so tall that the falling notes lose their room
  r.dragEdge('top', 10);
  assert.ok(r.yNow >= 800 * 0.25 - 1e-6, 'notes keep a quarter: ' + r.yNow);
  assert.ok(r.kbH <= 800 * 0.55 + 1e-6);
  // set again from the saved shares
  const { r: r2 } = setup(null, { kbFrac: f.kbFrac, histFrac: 0.1 });
  assert.ok(Math.abs(r2.kbH - f.kbFrac * 800) < 1e-6 && Math.abs(r2.histH - 80) < 1e-6);
});

test('zoomed in, it scrolls to what is about to be played, gently; a look around by hand is left alone', () => {
  const { r, p, ex } = setup(null, { view: 'zoom', whites: 9 });
  // far away from the first key's notes
  r.scrollTo(r.fullW);
  r.manualUntil = 0;
  p.play();
  for (let i = 0; i < 200; i++) {
    clock += 16;
    p.tick();
    r.follow(p.position(), 16);
  }
  const notes = ex.rounds[0].notes.map((n) => n.pitch);
  for (const m of notes) {
    const x = r.screenX(m);
    assert.ok(x > 0 && x < r.W, SF.noteName(m) + ' in view at ' + Math.round(x));
  }
  // scrolled by hand: stays where it was put while nothing is about to be missed
  const sx = r.sx;
  r.scrollBy(-40);
  r.follow(p.position(), 16);
  assert.ok(Math.abs(r.sx - (sx - 40)) < 1e-6 || r.sx === 0);
});

test('it draws without trouble: every way of showing feedback, the beat lines, no exercise', () => {
  const { r, p, cv } = setup();
  p.play();
  for (const fb of ['all', 'where', 'none']) {
    r.set({ feedback: fb, beats: true });
    clock += 500;
    p.tick();
    r.free = { midi: 57.3, at: clock };
    r.draw();
  }
  r.set({ view: 'zoom', whites: 12 });
  r.pressed.add(60);
  r.draw();
  assert.ok(cv.calls.n > 100);
  const { r: r2 } = setup();
  r2.fit(null);
  r2.player.ex = null;
  r2.free = { midi: 60, at: clock };
  r2.draw();
});
