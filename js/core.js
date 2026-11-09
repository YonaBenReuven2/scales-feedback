/* Scales Feedback — shared helpers.
 *
 * Every file is a classic script that hangs its exports off window.SF, so the app
 * runs from GitHub Pages, from localhost, or straight off the disk (file://),
 * where ES modules are blocked. The same files load in Node for the tests.
 */
(function (factory) {
  // kept as source too, so the listening worker can be built from the same code
  const root = typeof window !== 'undefined' ? window : globalThis;
  (root.SF_SRC = root.SF_SRC || {}).core = factory;
  factory(root);
})(function (root) {
  'use strict';
  const SF = (root.SF = root.SF || {});

  // ---------- notes, keys and solfege ----------
  const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  // Tonic pitch classes whose key signature uses flats.
  const FLAT_MAJOR = new Set([5, 10, 3, 8, 1]); // F B♭ E♭ A♭ D♭
  const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]); // d g c f b♭ e♭
  // Movable do. Chromatic notes get the usual singer's choices (ra me fi le te).
  const SOLFEGE = ['do', 'ra', 're', 'me', 'mi', 'fa', 'fi', 'sol', 'le', 'la', 'te', 'ti'];

  SF.pc = (m) => ((Math.round(m) % 12) + 12) % 12;
  SF.octave = (m) => Math.floor(Math.round(m) / 12) - 1; // MIDI 60 = C4
  SF.isBlack = (m) => [1, 3, 6, 8, 10].includes(SF.pc(m));
  SF.pcName = (pc, flats) => (flats ? FLAT : SHARP)[SF.pc(pc)];
  SF.noteName = (m, flats) => SF.pcName(m, flats) + SF.octave(m);
  SF.keyUsesFlats = (rootPc, quality) =>
    quality === 'minor' ? FLAT_MINOR.has(SF.pc(rootPc)) : FLAT_MAJOR.has(SF.pc(rootPc));
  SF.keyLabel = (key) => {
    if (!key) return '';
    const name = SF.pcName(key.root, key.flats);
    if (key.quality === 'minor') return name + ' minor';
    if (key.quality === 'major') return name + ' major';
    return name + (key.chord ? ' ' + key.chord : '');
  };
  /** Solfege syllable of MIDI note m when "do" is pitch class doPc. */
  SF.solfege = (m, doPc) => SOLFEGE[SF.pc(m - doPc)];
  SF.midiToHz = (m, a4) => (a4 || 440) * Math.pow(2, (m - 69) / 12);
  SF.hzToMidi = (f, a4) => 69 + 12 * Math.log2(f / (a4 || 440));
  /** Parse "C4", "Eb2", "F#3", "B♭2" into a MIDI number (NaN if not a note). */
  SF.parseNote = (s) => {
    const t = String(s).trim().replace('♯', '#').replace('♭', 'b');
    const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(t);
    if (!m) return NaN;
    const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
    const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
    return (parseInt(m[3], 10) + 1) * 12 + base + acc;
  };

  // ---------- small numeric helpers ----------
  SF.clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  SF.median = (arr) => {
    if (!arr.length) return NaN;
    const a = Array.from(arr).sort((x, y) => x - y);
    const h = a.length >> 1;
    return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
  };
  SF.mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : NaN);
  /** First index i in sorted array arr with key(arr[i]) >= x. */
  SF.lowerBound = (arr, x, key) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (key(arr[mid]) < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  SF.fmtTime = (sec) => {
    if (!isFinite(sec)) return '–';
    const s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  SF.fmtCents = (c) => (isFinite(c) ? (c > 0 ? '+' : c < 0 ? '−' : '±') + Math.abs(Math.round(c)) + '¢' : '');
  SF.prettyName = (file) =>
    String(file)
      .replace(/\.(mid|midi|kar|rmi)$/i, '')
      .replace(/[_]+/g, ' ')
      .trim();
  SF.now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  SF.uid = (() => {
    let n = 0;
    return () => ++n;
  })();

  // ---------- settings / history in localStorage ----------
  // Keys are prefixed: on GitHub Pages this app shares an origin with the ear trainer.
  const PREFIX = 'scales-feedback:';
  SF.store = {
    get(key, fallback) {
      try {
        const raw = root.localStorage && root.localStorage.getItem(PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (root.localStorage) root.localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch (e) {
        /* storage full or blocked: settings just won't persist */
      }
    },
    remove(key) {
      try {
        if (root.localStorage) root.localStorage.removeItem(PREFIX + key);
      } catch (e) {
        /* ignore */
      }
    },
  };

  // ---------- a tiny event emitter ----------
  SF.Emitter = class Emitter {
    constructor() {
      this._ev = {};
    }
    on(name, fn) {
      (this._ev[name] = this._ev[name] || []).push(fn);
      return () => this.off(name, fn);
    }
    off(name, fn) {
      const l = this._ev[name];
      if (l) this._ev[name] = l.filter((f) => f !== fn);
    }
    emit(name, ...args) {
      const l = this._ev[name];
      if (!l) return;
      for (const fn of l.slice()) {
        try {
          fn(...args);
        } catch (e) {
          if (typeof console !== 'undefined') console.error(e);
        }
      }
    }
  };

  // ---------- IndexedDB (files, folder handle, samples) ----------
  SF.idb = (function () {
    const NAME = 'scales-feedback';
    const VERSION = 1;
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        if (!root.indexedDB) return reject(new Error('IndexedDB is not available'));
        const req = root.indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of ['files', 'kv', 'samples']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbp;
    }
    function tx(store, mode, fn) {
      return open().then(
        (db) =>
          new Promise((resolve, reject) => {
            const t = db.transaction(store, mode);
            const s = t.objectStore(store);
            let out;
            const r = fn(s);
            if (r && 'onsuccess' in r) r.onsuccess = () => (out = r.result);
            t.oncomplete = () => resolve(out);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
          })
      );
    }
    return {
      get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
      put: (store, key, val) => tx(store, 'readwrite', (s) => s.put(val, key)),
      del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
      keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
      all: (store) => tx(store, 'readonly', (s) => s.getAll()),
      clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
    };
  })();
});
