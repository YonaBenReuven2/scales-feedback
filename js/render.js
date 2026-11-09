/* The picture: notes fall onto the keyboard (future above), pass through it, and
 * carry on below it as the recent past — where your sung pitch is drawn over them.
 * Pitch runs left to right exactly as on the keys.
 */
(function (root) {
  'use strict';
  const SF = root.SF;

  const C = {
    bg: '#0a1320',
    bg2: '#0f1a2b',
    lane: 'rgba(255,255,255,0.022)',
    laneLine: 'rgba(255,255,255,0.05)',
    octLine: 'rgba(255,255,255,0.11)',
    acc: 'rgba(212, 178, 106, 0.88)', // brass: the piano's own chords
    accEdge: '#ecd59c',
    target: '#8bd3f7', // ice blue: what you sing
    targetEdge: '#d6f0fd',
    other: 'rgba(127, 184, 164, 0.5)', // sage: the other voices
    otherEdge: '#a9d6c5',
    hit: '#5bd69b',
    close: '#f2c14e',
    off: '#f07a6a',
    silent: '#6b7a90',
    white: '#ece5d4', // ivory
    whiteEdge: '#a69d8c',
    black: '#14171d', // ebony
    felt: '#9e2a3a',
    feltDark: '#6e1c29',
    text: '#0b1726',
    textLight: '#dfe6ef',
    sep: 'rgba(255,255,255,0.13)',
    histBg: 'rgba(0,0,0,0.28)',
    input: '#f2a65a',
  };
  const STATUS = { hit: C.hit, close: C.close, off: C.off, silent: C.silent };

  class Renderer {
    constructor(canvas, player, scorer) {
      this.cv = canvas;
      this.g = canvas.getContext('2d');
      this.player = player;
      this.scorer = scorer;
      this.opts = { lookahead: 3, history: true, labels: 'solfege', full: false, pastSec: 2.2 };
      this.lo = 36;
      this.hi = 84;
      this.inputKeys = new Map(); // keys played on the piano
      this.popups = [];
      this.resize();
    }
    set(opts) {
      Object.assign(this.opts, opts);
      this.layout();
    }
    /** Fit the keyboard to an exercise: whole octaves around everything it plays. */
    fit(ex) {
      if (this.opts.full || !ex) {
        this.lo = 21;
        this.hi = 108;
      } else {
        let lo = ex.lo - 2;
        let hi = ex.hi + 2;
        lo = Math.min(lo, 36);
        hi = Math.max(hi, lo + 30);
        while (SF.isBlack(lo)) lo--;
        while (SF.isBlack(hi)) hi++;
        while (SF.pc(lo) !== 0 && SF.pc(lo) !== 5) lo--; // start on C or F
        while (SF.pc(hi) !== 11 && SF.pc(hi) !== 4) hi++; // end on B or E
        this.lo = Math.max(21, lo);
        this.hi = Math.min(108, hi);
      }
      this.layout();
    }
    resize() {
      const r = this.cv.getBoundingClientRect();
      const dpr = Math.min(root.devicePixelRatio || 1, 2);
      this.W = Math.max(200, r.width);
      this.H = Math.max(160, r.height);
      this.cv.width = Math.round(this.W * dpr);
      this.cv.height = Math.round(this.H * dpr);
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.layout();
    }
    layout() {
      const W = this.W;
      const H = this.H;
      this.kbH = SF.clamp(H * 0.16, 56, 128);
      this.histH = this.opts.history ? SF.clamp(H * 0.2, 48, 170) : 0;
      this.yNow = H - this.kbH - this.histH;
      this.pps = this.yNow / this.opts.lookahead;
      // the strip under the keys runs slower, so it holds the last couple of seconds
      this.ppsPast = this.histH ? this.histH / this.opts.pastSec : 1;
      // white keys share the width; black keys sit on the boundaries
      const whites = [];
      for (let m = this.lo; m <= this.hi; m++) if (!SF.isBlack(m)) whites.push(m);
      this.ww = W / whites.length;
      this.bw = this.ww * 0.6;
      this.keyX = new Map();
      whites.forEach((m, i) => this.keyX.set(m, { x: i * this.ww, w: this.ww, c: (i + 0.5) * this.ww, black: false }));
      for (let m = this.lo + 1; m < this.hi; m++) {
        if (!SF.isBlack(m)) continue;
        const left = this.keyX.get(m - 1);
        if (!left) continue;
        const c = left.x + left.w;
        this.keyX.set(m, { x: c - this.bw / 2, w: this.bw, c, black: true });
      }
    }
    /** x of a (fractional) pitch: between key centres. */
    xOf(m) {
      const a = Math.floor(m);
      const f = m - a;
      const ka = this.keyX.get(a);
      const kb = this.keyX.get(a + 1);
      if (ka && kb) return ka.c + f * (kb.c - ka.c);
      if (ka) return ka.c;
      if (m < this.lo) return 0;
      return this.W;
    }

    draw() {
      const g = this.g;
      const p = this.player;
      const W = this.W;
      const H = this.H;
      const yNow = this.yNow;
      const kbH = this.kbH;
      const yHist = yNow + kbH;
      const Pnow = p.position();
      const sp = p.speed;
      const pps = this.pps;
      const yFut = (P) => yNow - ((P - Pnow) / sp) * pps;
      const yPast = (P) => yHist + ((Pnow - P) / sp) * this.ppsPast;
      const aheadP = this.opts.lookahead * sp;
      const behindP = this.opts.pastSec * sp;

      // background and lanes
      const grd = g.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, C.bg2);
      grd.addColorStop(1, C.bg);
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
      for (const [m, k] of this.keyX) {
        if (k.black) {
          g.fillStyle = C.lane;
          g.fillRect(k.x, 0, k.w, yNow);
          if (this.histH) g.fillRect(k.x, yHist, k.w, this.histH);
        } else if (SF.pc(m) === 0 || SF.pc(m) === 5) {
          g.fillStyle = SF.pc(m) === 0 ? C.octLine : C.laneLine;
          g.fillRect(Math.round(k.x), 0, 1, yNow);
          if (this.histH) g.fillRect(Math.round(k.x), yHist, 1, this.histH);
        }
      }
      if (this.histH) {
        g.fillStyle = C.histBg;
        g.fillRect(0, yHist, W, this.histH);
      }
      if (!p.ex) {
        this.drawKeyboard(new Map(), null);
        return;
      }

      // key changes
      g.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
      for (const seg of p.queue) {
        if (seg.kind !== 'round' || seg.P0 < Pnow || seg.P0 > Pnow + aheadP) continue;
        const y = Math.round(yFut(seg.P0)) + 0.5;
        g.strokeStyle = C.sep;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(W, y);
        g.stroke();
        const rd = p.ex.rounds[seg.r];
        const label = p.ex.structure === 'rounds' && rd.key ? SF.keyLabel(rd.key) + ', from ' + rd.label : rd.label;
        // fade out near the top, where the big key name sits; it takes over when the key arrives
        const a = SF.clamp((y - 120) / 60, 0, 1);
        if (a > 0) {
          const tw = g.measureText(label).width;
          g.globalAlpha = a;
          g.fillStyle = 'rgba(15,26,43,0.9)';
          g.fillRect(6, y - 20, tw + 14, 18);
          g.fillStyle = C.textLight;
          g.fillText(label, 13, y - 6.5);
          g.globalAlpha = 1;
        }
      }

      // notes
      const active = new Map(); // pitch -> colour, sounding now
      const want = new Map(); // pitch -> true: sing this now
      const labels = this.opts.labels;
      p.forNotes(Pnow - behindP, Pnow + aheadP, (n, seg, P0, P1) => {
        const k = this.keyX.get(n.pitch);
        if (!k) return;
        const target = p.isTarget(n);
        const audible = p.audible(n);
        const res = target && this.scorer ? this.scorer.resultFor(seg, n) : null;
        let fill;
        let edge;
        let hollow = false;
        if (n.role === 'acc') {
          fill = C.acc;
          edge = C.accEdge;
        } else if (target) {
          fill = C.target;
          edge = C.targetEdge;
          hollow = !audible;
        } else {
          fill = C.other;
          edge = C.otherEdge;
        }
        const x = k.x + (k.black ? 1 : 2);
        const w = k.w - (k.black ? 2 : 4);
        const rd = p.ex.rounds[seg.r];
        // future part
        if (P1 > Pnow) {
          const yt = Math.max(-4, yFut(P1));
          const yb = Math.min(yNow, yFut(Math.max(P0, Pnow)));
          const live = this.scorer && this.scorer.live;
          const singing = target && P0 <= Pnow && live && live.listening && live.target === n.pitch && STATUS[live.status];
          if (singing && live.status !== 'silent') {
            // the note you are singing right now shows how you are doing
            const col = STATUS[live.status];
            g.save();
            g.shadowColor = col;
            g.shadowBlur = 18;
            if (yb - yt > 0.5) this.block(x, yt, w, yb - yt, col, '#ffffff', false, labels !== 'none' ? this.label(n, rd) : '');
            g.restore();
          } else if (yb - yt > 0.5) this.block(x, yt, w, yb - yt, fill, edge, hollow, labels !== 'none' && P0 >= Pnow ? this.label(n, rd) : '');
        }
        // past part, below the keyboard
        if (this.histH && P0 < Pnow) {
          const yt = yPast(Math.min(P1, Pnow));
          const yb = Math.min(H + 4, yPast(P0));
          let f = fill;
          let e = edge;
          if (target && res && STATUS[res.status]) {
            f = STATUS[res.status];
            e = f;
            hollow = false;
          } else if (target) {
            f = 'rgba(139,211,247,0.3)';
          }
          if (n.role === 'acc') {
            g.globalAlpha = 0.5;
            if (yb - yt > 0.5) this.block(x, yt, w, yb - yt, 'rgba(212,178,106,0.12)', 'rgba(212,178,106,0.45)', false, '');
          } else {
            g.globalAlpha = target ? 0.9 : 0.55;
            if (yb - yt > 0.5) this.block(x, yt, w, yb - yt, f, e, hollow, '');
          }
          g.globalAlpha = 1;
        }
        if (P0 <= Pnow && P1 > Pnow) {
          if (audible) active.set(n.pitch, n.role === 'acc' ? C.acc : target ? C.target : C.other);
          if (target) want.set(n.pitch, true);
        }
      });

      // the sung pitch, below the keyboard
      const sc = this.scorer;
      if (sc && this.histH) {
        g.save();
        g.beginPath();
        g.rect(0, yHist, W, this.histH);
        g.clip();
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.lineWidth = 5;
        g.shadowBlur = 10;
        let prev = null;
        const minP = Pnow - behindP - 0.2;
        for (let i = Math.max(0, sc.trace.length - 1200); i < sc.trace.length; i++) {
          const t = sc.trace[i];
          if (t.P < minP || t.midi == null || t.st === 'idle') {
            prev = null;
            continue;
          }
          const x = this.xOf(t.midi);
          const y = yPast(t.P);
          if (prev && t.P - prev.P < 0.06 * sp && t.P >= prev.P) {
            g.strokeStyle = STATUS[t.st] || C.textLight;
            g.shadowColor = g.strokeStyle;
            g.beginPath();
            g.moveTo(prev.x, prev.y);
            g.lineTo(x, y);
            g.stroke();
          }
          prev = { x, y, P: t.P };
        }
        g.restore();
      }

      this.drawKeyboard(active, want);

      // the felt strip above the keys is "now"
      g.fillStyle = C.felt;
      g.fillRect(0, yNow - 4, W, 5);
      g.fillStyle = C.feltDark;
      g.fillRect(0, yNow, W, 1);

      // your pitch: a beam rising from where you are on the keys (only while listening)
      if (sc && sc.live.listening && sc.live.midi != null) {
        const lv = sc.live;
        const x = this.xOf(lv.midi);
        const col = STATUS[lv.status] || C.textLight;
        const beamTop = Math.max(40, yNow - Math.min(220, yNow * 0.42));
        // where the target is, for comparison
        if (lv.target != null) {
          const tk = this.keyX.get(lv.target);
          if (tk) {
            const grd2 = g.createLinearGradient(0, beamTop, 0, yNow);
            grd2.addColorStop(0, 'rgba(139,211,247,0)');
            grd2.addColorStop(1, 'rgba(139,211,247,0.16)');
            g.fillStyle = grd2;
            g.fillRect(tk.x, beamTop, tk.w, yNow - beamTop);
          }
        }
        const grd = g.createLinearGradient(0, beamTop, 0, yNow);
        grd.addColorStop(0, 'rgba(0,0,0,0)');
        grd.addColorStop(1, col);
        g.save();
        g.shadowColor = col;
        g.shadowBlur = 22;
        g.fillStyle = grd;
        g.fillRect(x - 4, beamTop, 8, yNow - beamTop);
        g.fillStyle = col;
        g.fillRect(x - 3, yNow - 2, 6, kbH * 0.6);
        g.beginPath();
        g.arc(x, yNow - 2, 10, 0, Math.PI * 2);
        g.fill();
        g.restore();
        // label: the note and how far off
        const name = SF.noteName(Math.round(lv.midi), true);
        const txt = lv.cents != null ? name + '  ' + SF.fmtCents(lv.cents) : name;
        g.font = '800 18px system-ui, -apple-system, "Segoe UI", sans-serif';
        const tw = g.measureText(txt).width;
        const bx = SF.clamp(x - tw / 2 - 10, 4, W - tw - 24);
        const by = beamTop - 34;
        g.fillStyle = 'rgba(8,13,22,0.92)';
        g.beginPath();
        if (g.roundRect) g.roundRect(bx, by, tw + 20, 30, 8);
        else g.rect(bx, by, tw + 20, 30);
        g.fill();
        g.strokeStyle = col;
        g.lineWidth = 2;
        g.stroke();
        g.fillStyle = col;
        g.fillText(txt, bx + 10, by + 21.5);
      }

      // verdicts popping up over the keys as notes end
      const nowMs = SF.now();
      this.popups = this.popups.filter((pp) => nowMs - pp.t0 < 1400);
      for (const pp of this.popups) {
        const k = this.keyX.get(pp.pitch);
        if (!k) continue;
        const age = (nowMs - pp.t0) / 1400;
        const y = yNow - 18 - age * 70;
        g.globalAlpha = 1 - age * age;
        g.font = '800 ' + (pp.big ? 26 : 18) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
        g.textAlign = 'center';
        g.lineWidth = 4;
        g.strokeStyle = 'rgba(8,13,22,0.9)';
        g.strokeText(pp.text, k.c, y);
        g.fillStyle = pp.color;
        g.fillText(pp.text, k.c, y);
        g.textAlign = 'left';
        g.globalAlpha = 1;
      }
    }
    /** Show a note's verdict over its key. */
    verdict(note, res) {
      if (!res || res.status === 'none') return;
      let text;
      if (res.status === 'hit') text = '✓';
      else if (res.status === 'silent') text = '–';
      else text = SF.fmtCents(res.cents);
      this.popups.push({ pitch: note.pitch, t0: SF.now(), text, color: STATUS[res.status], big: res.status === 'hit' });
    }
    label(n, rd) {
      if (this.opts.labels === 'names') return SF.noteName(n.pitch, rd.key ? rd.key.flats : true);
      if (this.opts.labels === 'solfege') return rd.key ? SF.solfege(n.pitch, rd.key.doPc) : SF.noteName(n.pitch, true);
      return '';
    }
    block(x, y, w, h, fill, edge, hollow, text) {
      const g = this.g;
      const r = Math.min(5, w / 3, h / 2);
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, w, h, r);
      else g.rect(x, y, w, h);
      if (hollow) {
        g.fillStyle = 'rgba(139,211,247,0.10)';
        g.fill();
        g.strokeStyle = edge;
        g.lineWidth = 2;
        g.setLineDash([5, 4]);
        g.stroke();
        g.setLineDash([]);
      } else {
        g.fillStyle = fill;
        g.fill();
        g.strokeStyle = edge;
        g.lineWidth = 1;
        g.stroke();
      }
      if (text && h >= 16 && w >= 16) {
        g.font = '700 ' + Math.min(12, Math.floor(w * 0.42)) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
        g.fillStyle = hollow ? C.targetEdge : C.text;
        g.textAlign = 'center';
        g.fillText(text, x + w / 2, y + h - 5);
        g.textAlign = 'left';
      }
    }
    drawKeyboard(active, want) {
      const g = this.g;
      const y = this.yNow;
      const h = this.kbH;
      // white keys
      for (const [m, k] of this.keyX) {
        if (k.black) continue;
        const col = active.get(m);
        g.fillStyle = col ? mix(col) : C.white;
        g.fillRect(k.x, y, k.w, h);
        g.fillStyle = C.whiteEdge;
        g.fillRect(Math.round(k.x), y, 1, h);
        if (want && want.get(m) && !col) this.ring(k.x + 2, y + 2, k.w - 4, h - 4);
        if (SF.pc(m) === 0) {
          g.font = '600 10px system-ui, sans-serif';
          g.fillStyle = '#6b7280';
          g.textAlign = 'center';
          g.fillText('C' + SF.octave(m), k.c, y + h - 6);
          g.textAlign = 'left';
        }
        if (this.inputKeys.has(m)) this.dot(k.c, y + h - 20);
      }
      // black keys
      const bh = h * 0.62;
      for (const [m, k] of this.keyX) {
        if (!k.black) continue;
        const col = active.get(m);
        g.fillStyle = col ? mix(col, 0.3) : C.black;
        g.fillRect(k.x, y, k.w, bh);
        if (!col) {
          g.fillStyle = 'rgba(255,255,255,0.08)';
          g.fillRect(k.x + 2, y, k.w - 4, bh * 0.9);
          g.fillStyle = C.black;
          g.fillRect(k.x + 3, y, k.w - 6, bh * 0.86);
        }
        if (want && want.get(m) && !col) this.ring(k.x + 1, y + 1, k.w - 2, bh - 2);
        if (this.inputKeys.has(m)) this.dot(k.c, y + bh - 10);
      }
    }
    ring(x, y, w, h) {
      const g = this.g;
      g.strokeStyle = C.target;
      g.lineWidth = 3;
      g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
    }
    dot(x, y) {
      const g = this.g;
      g.fillStyle = C.input;
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fill();
    }
  }
  function mix(col, darken) {
    // a key held down takes the colour of what is playing it
    if (col === C.acc) return darken ? '#8f7135' : '#e6cf96';
    if (col === C.target) return darken ? '#2f86b3' : '#b9e6fb';
    return darken ? '#4f7f6e' : '#bfe0d4';
  }

  SF.Renderer = Renderer;
  SF.COLORS = C;
})(typeof window !== 'undefined' ? window : globalThis);
