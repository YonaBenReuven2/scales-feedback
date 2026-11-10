/* The picture: notes fall onto the keyboard (future above), pass through it, and
 * carry on below it as the recent past — where your sung pitch is drawn over them.
 * Pitch runs left to right exactly as on the keys.
 *
 * The keyboard can be made taller or shorter, and so can the strip under it (drag their
 * edges). It shows the whole exercise, all 88 keys, or a set number of white keys: then it
 * scrolls, by itself to keep what is about to be played (and your voice) in view, or by hand.
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
    beat: 'rgba(255,255,255,0.045)',
    bar: 'rgba(255,255,255,0.11)',
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
    free: '#dfe6ef', // your voice where nothing is judged
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
    pressed: '#f2a65a',
  };
  const STATUS = { hit: C.hit, close: C.close, off: C.off, silent: C.silent };
  const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

  class Renderer {
    constructor(canvas, player, scorer) {
      this.cv = canvas;
      this.g = canvas.getContext('2d');
      this.player = player;
      this.scorer = scorer;
      this.opts = {
        lookahead: 3,
        history: true,
        labels: 'solfege',
        pastSec: 2.2,
        view: 'fit', // 'fit' the exercise, 'all' 88 keys, or 'zoom' to `whites` white keys
        whites: 22,
        kbFrac: null, // the keyboard's height as a share of the picture (null: automatic)
        histFrac: null, // the same for the strip under it
        feedback: 'all', // 'all', 'where' (your pitch, not whether you hit), 'none'
        beats: false, // beat lines (when the metronome is on)
      };
      this.lo = 36;
      this.hi = 84;
      this.ex = null;
      this.sx = 0; // horizontal scroll, px
      this.sxTarget = 0;
      this.manualUntil = 0;
      this.inputKeys = new Map(); // keys played on the piano
      this.pressed = new Set(); // keys held with the mouse or a finger
      this.free = null; // {midi, at}: your voice where nothing is being judged
      this.popups = [];
      this.lastDraw = 0;
      this.resize();
    }
    set(opts) {
      const refit = ('view' in opts && opts.view !== this.opts.view) || ('whites' in opts && opts.whites !== this.opts.whites);
      // zooming keeps the middle of the view where it was (a fresh zoom starts on the exercise)
      const keep = refit && this.zoomed && this.keyX ? this.pitchAt(this.sx + this.W / 2) : null;
      Object.assign(this.opts, opts);
      if (refit) this.fit(this.ex, keep);
      else this.layout();
    }
    /** The (fractional) pitch at x on the whole keyboard (before scrolling). */
    pitchAt(x) {
      let best = null;
      for (const [m, k] of this.keyX) if (!k.black && (best == null || Math.abs(k.c - x) < Math.abs(this.keyX.get(best).c - x))) best = m;
      return best;
    }
    /** The keys around everything the exercise plays, with a few more either side. */
    static fitRange(ex) {
      if (!ex) return { lo: 21, hi: 108 };
      let lo = ex.lo - 2;
      let hi = ex.hi + 2;
      lo = Math.min(lo, 36);
      hi = Math.max(hi, lo + 30);
      while (SF.isBlack(lo)) lo--;
      while (SF.isBlack(hi)) hi++;
      while (SF.pc(lo) !== 0 && SF.pc(lo) !== 5) lo--; // start on C or F
      while (SF.pc(hi) !== 11 && SF.pc(hi) !== 4) hi++; // end on B or E
      return { lo: Math.max(21, lo), hi: Math.min(108, hi) };
    }
    static whitesIn(lo, hi) {
      let n = 0;
      for (let m = lo; m <= hi; m++) if (!SF.isBlack(m)) n++;
      return n;
    }
    /** How many white keys fit across the picture now. */
    whitesShown() {
      return Math.round(this.W / this.ww);
    }
    /** ...when it shows the whole exercise. */
    fitWhites() {
      const r = Renderer.fitRange(this.ex);
      return Renderer.whitesIn(r.lo, r.hi);
    }
    /** The keys there are: the exercise's (fit), or all 88 (all, and zoomed in, which scrolls). */
    fit(ex, centre) {
      this.ex = ex || null;
      const r = this.opts.view === 'fit' ? Renderer.fitRange(ex) : { lo: 21, hi: 108 };
      this.lo = r.lo;
      this.hi = r.hi;
      this.layout();
      // a fresh view starts where the exercise is
      if (this.zoomed) {
        const c = centre != null ? centre : ex ? (ex.lo + ex.hi) / 2 : 60;
        this.sx = this.sxTarget = this.clampSx(this.xOf(c) - this.W / 2);
      }
    }
    resize() {
      const r = this.cv.getBoundingClientRect();
      const dpr = Math.min(root.devicePixelRatio || 1, 2);
      this.W = Math.max(200, r.width);
      this.H = Math.max(160, r.height);
      this.cv.width = Math.round(this.W * dpr);
      this.cv.height = Math.round(this.H * dpr);
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.dpr = dpr;
      this.layout();
    }
    /** Heights: the keyboard and the strip under it as set (or automatic), the rest falls. */
    heights() {
      const H = this.H;
      let kbH = this.opts.kbFrac != null ? this.opts.kbFrac * H : SF.clamp(H * 0.16, 56, 128);
      let histH = !this.opts.history ? 0 : this.opts.histFrac != null ? this.opts.histFrac * H : SF.clamp(H * 0.2, 48, 170);
      kbH = SF.clamp(kbH, 36, H * 0.55);
      histH = SF.clamp(histH, 0, H * 0.55);
      // the falling notes keep at least a quarter of the picture
      const over = kbH + histH - H * 0.75;
      if (over > 0) histH = Math.max(0, histH - over);
      return { kbH, histH: this.opts.history ? histH : 0 };
    }
    layout() {
      const W = this.W;
      const H = this.H;
      const { kbH, histH } = this.heights();
      this.kbH = kbH;
      this.histH = histH;
      this.yNow = H - kbH - histH;
      this.pps = this.yNow / this.opts.lookahead;
      // the strip under the keys runs slower, so it holds the last couple of seconds
      this.ppsPast = this.histH ? this.histH / this.opts.pastSec : 1;
      // white keys share the width (or a set number of them does, and the rest scrolls);
      // black keys sit on the boundaries
      const whites = [];
      for (let m = this.lo; m <= this.hi; m++) if (!SF.isBlack(m)) whites.push(m);
      const shown = this.opts.view === 'zoom' ? SF.clamp(Math.round(this.opts.whites), 7, whites.length) : whites.length;
      this.zoomed = shown < whites.length;
      this.ww = W / shown;
      this.bw = this.ww * 0.6;
      this.fullW = whites.length * this.ww;
      this.keyX = new Map();
      whites.forEach((m, i) => this.keyX.set(m, { x: i * this.ww, w: this.ww, c: (i + 0.5) * this.ww, black: false }));
      for (let m = this.lo + 1; m < this.hi; m++) {
        if (!SF.isBlack(m)) continue;
        const left = this.keyX.get(m - 1);
        if (!left) continue;
        const c = left.x + left.w;
        this.keyX.set(m, { x: c - this.bw / 2, w: this.bw, c, black: true });
      }
      this.sx = this.clampSx(this.sx);
      this.sxTarget = this.clampSx(this.sxTarget);
    }
    clampSx(x) {
      return this.zoomed ? SF.clamp(x, 0, Math.max(0, this.fullW - this.W)) : 0;
    }
    /** x of a (fractional) pitch on the whole keyboard (before scrolling): between key centres. */
    xOf(m) {
      const a = Math.floor(m);
      const f = m - a;
      const ka = this.keyX.get(a);
      const kb = this.keyX.get(a + 1);
      if (ka && kb) return ka.c + f * (kb.c - ka.c);
      if (ka) return ka.c;
      if (m < this.lo) return 0;
      return this.fullW;
    }
    /** The same on screen. */
    screenX(m) {
      return this.xOf(m) - this.sx;
    }

    // ---------- scrolling ----------
    /** Scroll by hand (px); the view then stays put for a few seconds unless a note is about to be missed. */
    scrollBy(dx) {
      if (!this.zoomed) return;
      this.sx = this.sxTarget = this.clampSx(this.sx + dx);
      this.manualUntil = SF.now() + 4000;
    }
    scrollTo(x) {
      if (!this.zoomed) return;
      this.sx = this.sxTarget = this.clampSx(x);
      this.manualUntil = SF.now() + 4000;
    }
    /** Keep what is about to be played, and your voice, in view. */
    follow(Pnow, dtMs) {
      if (!this.zoomed) {
        this.sx = 0;
        return;
      }
      const p = this.player;
      const sp = p.speed;
      const span = (a, b) => {
        let lo = Infinity;
        let hi = -Infinity;
        if (p.ex)
          p.forNotes(a, b, (n, seg, P0, P1) => {
            if (P1 <= Pnow - 0.02 * sp && P0 < Pnow) return;
            lo = Math.min(lo, n.pitch);
            hi = Math.max(hi, n.pitch);
          });
        return [lo, hi];
      };
      const view0 = this.sx;
      const view1 = this.sx + this.W;
      const margin = this.ww * 0.8;
      const fits = (lo, hi) => this.xOf(lo) - this.ww / 2 >= view0 + margin * 0.5 && this.xOf(hi) + this.ww / 2 <= view1 - margin * 0.5;
      // soon: what plays in the next second or so must be seen, even right after scrolling by hand
      let [lo, hi] = span(Pnow, Pnow + Math.min(1.2, this.opts.lookahead * 0.6) * sp);
      const urgent = lo <= hi && !fits(lo, hi);
      const lv = this.scorer && this.scorer.live;
      if (SF.now() < this.manualUntil && !urgent) return this.ease(dtMs);
      // otherwise everything on its way down, if it fits
      const [lo2, hi2] = span(Pnow, Pnow + this.opts.lookahead * 0.9 * sp);
      if (lo2 <= hi2 && this.xOf(hi2) - this.xOf(lo2) + 2 * margin + this.ww <= this.W) [lo, hi] = [lo2, hi2];
      if (lv && lv.listening && lv.midi != null) {
        const v = Math.round(lv.midi);
        if (this.xOf(Math.max(hi, v)) - this.xOf(Math.min(lo, v)) + 2 * margin + this.ww <= this.W) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      if (lo <= hi && !fits(lo, hi)) {
        const a = this.xOf(lo) - this.ww / 2 - margin;
        const b = this.xOf(hi) + this.ww / 2 + margin;
        // the least movement that brings it in; centred if it is a long way off
        let t;
        if (b - a >= this.W) t = (a + b) / 2 - this.W / 2;
        else if (a < view0) t = a;
        else t = b - this.W;
        if (Math.abs(t - this.sx) > this.W) t = (a + b) / 2 - this.W / 2;
        this.sxTarget = this.clampSx(t);
      }
      this.ease(dtMs);
    }
    ease(dtMs) {
      const k = 1 - Math.exp(-(dtMs || 16) / 140);
      const d = this.sxTarget - this.sx;
      this.sx = Math.abs(d) < 0.5 ? this.sxTarget : this.sx + d * k;
    }

    // ---------- hit testing (mouse and touch) ----------
    /** The key under a point of the canvas (CSS px), or null. */
    keyAt(x, y) {
      const top = this.yNow;
      if (y < top || y > top + this.kbH) return null;
      const bx = x + this.sx;
      const bh = this.kbH * 0.62;
      if (y <= top + bh) {
        for (const [m, k] of this.keyX) if (k.black && bx >= k.x && bx < k.x + k.w) return m;
      }
      for (const [m, k] of this.keyX) if (!k.black && bx >= k.x && bx < k.x + k.w) return m;
      return null;
    }
    /** Which edge a point is on, for resizing: 'top' of the keyboard, its 'bottom', or null. */
    edgeAt(y) {
      if (Math.abs(y - this.yNow) <= 6) return 'top';
      if (this.opts.history && Math.abs(y - (this.yNow + this.kbH)) <= 6) return 'bottom';
      return null;
    }
    /** Move an edge to y (CSS px): returns the new {kbFrac, histFrac}. */
    dragEdge(edge, y) {
      const H = this.H;
      const top = this.yNow;
      const bottom = this.yNow + this.kbH;
      let kbH = this.kbH;
      let histH = this.histH;
      if (edge === 'top') kbH = SF.clamp(bottom - y, 36, H * 0.55);
      else {
        const nb = SF.clamp(y, top + 36, H);
        kbH = nb - top;
        histH = H - nb;
        if (kbH > H * 0.55) {
          kbH = H * 0.55;
          histH = H - top - kbH;
        }
      }
      if (H - kbH - histH < H * 0.25) return null;
      this.opts.kbFrac = kbH / H;
      this.opts.histFrac = histH / H;
      this.layout();
      return { kbFrac: this.opts.kbFrac, histFrac: this.opts.histFrac };
    }
    /** The strip at the very bottom showing where the view is on the keyboard (when zoomed). */
    inScrollbar(y) {
      return this.zoomed && y >= this.H - 12;
    }
    scrollbarTo(x) {
      // centre the view on the place clicked on the strip
      this.scrollTo((x / this.W) * this.fullW - this.W / 2);
    }
    // ---------- drawing ----------
    draw() {
      const g = this.g;
      const p = this.player;
      const W = this.W;
      const H = this.H;
      const now = SF.now();
      const dt = this.lastDraw ? Math.min(100, now - this.lastDraw) : 16;
      this.lastDraw = now;
      const Pnow = p.position();
      this.follow(Pnow, dt);
      const sx = this.sx;
      const yNow = this.yNow;
      const kbH = this.kbH;
      const yHist = yNow + kbH;
      const sp = p.speed;
      const pps = this.pps;
      const yFut = (P) => yNow - ((P - Pnow) / sp) * pps;
      const yPast = (P) => yHist + ((Pnow - P) / sp) * this.ppsPast;
      const aheadP = this.opts.lookahead * sp;
      const behindP = this.opts.pastSec * sp;
      const fb = this.opts.feedback;
      const colours = fb === 'all';

      // background and lanes
      const grd = g.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, C.bg2);
      grd.addColorStop(1, C.bg);
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
      g.save();
      g.translate(-sx, 0);
      for (const [m, k] of this.keyX) {
        if (k.x + k.w < sx - 2 || k.x > sx + W + 2) continue;
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
      g.restore();
      if (this.histH) {
        g.fillStyle = C.histBg;
        g.fillRect(0, yHist, W, this.histH);
      }
      if (!p.ex) {
        g.save();
        g.translate(-sx, 0);
        this.drawKeyboard(new Map(), null);
        g.restore();
        this.drawFelt();
        this.drawBeam(Pnow);
        this.drawScrollbar();
        return;
      }

      // the beat, when the metronome is on: faint lines, the bar lines a little stronger
      if (this.opts.beats) {
        p.beatsIn(Pnow, Pnow + aheadP, (P, bar) => {
          const y = Math.round(yFut(P)) + 0.5;
          g.fillStyle = bar ? C.bar : C.beat;
          g.fillRect(0, y, W, 1);
        });
      }

      // key changes
      g.font = '600 12px ' + FONT;
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
      g.save();
      g.translate(-sx, 0);
      const active = new Map(); // pitch -> colour, sounding now
      const want = new Map(); // pitch -> true: sing this now
      const labels = this.opts.labels;
      const lv = this.scorer && this.scorer.live;
      p.forNotes(Pnow - behindP, Pnow + aheadP, (n, seg, P0, P1) => {
        const k = this.keyX.get(n.pitch);
        if (!k || k.x + k.w < sx - 2 || k.x > sx + W + 2) {
          if (k && P0 <= Pnow && P1 > Pnow && p.isTarget(n)) want.set(n.pitch, true);
          return;
        }
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
          const singing = colours && target && P0 <= Pnow && lv && lv.listening && lv.target === n.pitch && STATUS[lv.status];
          if (singing && lv.status !== 'silent') {
            // the note you are singing right now shows how you are doing
            const col = STATUS[lv.status];
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
          if (colours && target && res && STATUS[res.status]) {
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
      if (sc && this.histH && fb !== 'none') {
        g.save();
        g.beginPath();
        g.rect(sx, yHist, W, this.histH);
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
            g.strokeStyle = colours ? STATUS[t.st] || C.textLight : C.free;
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
      g.restore();
      this.drawFelt();
      this.drawBeam(Pnow);

      // verdicts popping up over the keys as notes end
      const nowMs = SF.now();
      this.popups = this.popups.filter((pp) => nowMs - pp.t0 < 1400);
      if (colours) {
        for (const pp of this.popups) {
          const k = this.keyX.get(pp.pitch);
          if (!k) continue;
          const age = (nowMs - pp.t0) / 1400;
          const y = yNow - 18 - age * 70;
          g.globalAlpha = 1 - age * age;
          g.font = '800 ' + (pp.big ? 26 : 18) + 'px ' + FONT;
          g.textAlign = 'center';
          g.lineWidth = 4;
          g.strokeStyle = 'rgba(8,13,22,0.9)';
          g.strokeText(pp.text, k.c - sx, y);
          g.fillStyle = pp.color;
          g.fillText(pp.text, k.c - sx, y);
          g.textAlign = 'left';
          g.globalAlpha = 1;
        }
      }
      // notes to sing that are off to the side: an arrow says which way
      if (this.zoomed) this.drawOffscreen(want);
      this.drawScrollbar();
    }
    drawFelt() {
      // the felt strip above the keys is "now"
      const g = this.g;
      g.fillStyle = C.felt;
      g.fillRect(0, this.yNow - 4, this.W, 5);
      g.fillStyle = C.feltDark;
      g.fillRect(0, this.yNow, this.W, 1);
    }
    /** Your pitch: a beam rising from where you are on the keys. Coloured by how close you are
     *  while a note is judged; plain while nothing is (between notes, paused, no exercise). */
    drawBeam() {
      const sc = this.scorer;
      const fb = this.opts.feedback;
      if (fb === 'none' || !sc) return;
      const g = this.g;
      const lv = sc.live;
      let midi = null;
      let col;
      let judged = false;
      if (lv.listening && lv.midi != null) {
        midi = lv.midi;
        judged = fb === 'all';
        col = judged ? STATUS[lv.status] || C.free : C.free;
      } else if (this.free && SF.now() - this.free.at < 220) {
        midi = this.free.midi;
        col = C.free;
      }
      if (midi == null) return;
      const yNow = this.yNow;
      const x = this.screenX(midi);
      if (x < -10 || x > this.W + 10) return;
      const beamTop = Math.max(40, yNow - Math.min(220, yNow * 0.42));
      // where the target is, for comparison
      if (judged && lv.target != null) {
        const tk = this.keyX.get(lv.target);
        if (tk) {
          const grd2 = g.createLinearGradient(0, beamTop, 0, yNow);
          grd2.addColorStop(0, 'rgba(139,211,247,0)');
          grd2.addColorStop(1, 'rgba(139,211,247,0.16)');
          g.fillStyle = grd2;
          g.fillRect(tk.x - this.sx, beamTop, tk.w, yNow - beamTop);
        }
      }
      const grd = g.createLinearGradient(0, beamTop, 0, yNow);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(1, col);
      g.save();
      g.globalAlpha = judged ? 1 : 0.8;
      g.shadowColor = col;
      g.shadowBlur = judged ? 22 : 12;
      g.fillStyle = grd;
      g.fillRect(x - 4, beamTop, 8, yNow - beamTop);
      g.fillStyle = col;
      g.fillRect(x - 3, yNow - 2, 6, this.kbH * 0.6);
      g.beginPath();
      g.arc(x, yNow - 2, judged ? 10 : 8, 0, Math.PI * 2);
      g.fill();
      g.restore();
      // label: the note, and how far off while judged
      const name = SF.noteName(Math.round(midi), true);
      const txt = judged && lv.cents != null ? name + '  ' + SF.fmtCents(lv.cents) : name;
      g.font = '800 ' + (judged ? 18 : 15) + 'px ' + FONT;
      const tw = g.measureText(txt).width;
      const bx = SF.clamp(x - tw / 2 - 10, 4, this.W - tw - 24);
      const by = beamTop - 34;
      g.fillStyle = 'rgba(8,13,22,0.92)';
      g.beginPath();
      if (g.roundRect) g.roundRect(bx, by, tw + 20, 30, 8);
      else g.rect(bx, by, tw + 20, 30);
      g.fill();
      g.strokeStyle = col;
      g.lineWidth = judged ? 2 : 1;
      g.stroke();
      g.fillStyle = judged ? col : C.textLight;
      g.fillText(txt, bx + 10, by + (judged ? 21.5 : 20.5));
    }
    /** When zoomed: notes to sing now that are off screen get an arrow at that edge. */
    drawOffscreen(want) {
      const g = this.g;
      for (const m of want.keys()) {
        const x = this.screenX(m);
        if (x >= 0 && x <= this.W) continue;
        const left = x < 0;
        const ax = left ? 10 : this.W - 10;
        const ay = this.yNow - 26;
        g.fillStyle = C.target;
        g.beginPath();
        g.moveTo(ax + (left ? -6 : 6), ay);
        g.lineTo(ax + (left ? 6 : -6), ay - 9);
        g.lineTo(ax + (left ? 6 : -6), ay + 9);
        g.closePath();
        g.fill();
      }
    }
    drawScrollbar() {
      if (!this.zoomed) return;
      const g = this.g;
      const y = this.H - 6;
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(0, y, this.W, 4);
      const a = (this.sx / this.fullW) * this.W;
      const w = Math.max(24, (this.W / this.fullW) * this.W);
      g.fillStyle = 'rgba(139,211,247,0.55)';
      g.beginPath();
      if (g.roundRect) g.roundRect(a, y, w, 4, 2);
      else g.rect(a, y, w, 4);
      g.fill();
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
        g.font = '700 ' + Math.min(12, Math.floor(w * 0.42)) + 'px ' + FONT;
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
      const sx = this.sx;
      const W = this.W;
      const vis = (k) => k.x + k.w >= sx - 2 && k.x <= sx + W + 2;
      // white keys
      for (const [m, k] of this.keyX) {
        if (k.black || !vis(k)) continue;
        const col = this.pressed.has(m) ? C.pressed : active.get(m);
        g.fillStyle = col ? mix(col) : C.white;
        g.fillRect(k.x, y, k.w, h);
        g.fillStyle = C.whiteEdge;
        g.fillRect(Math.round(k.x), y, 1, h);
        if (want && want.get(m) && !col) this.ring(k.x + 2, y + 2, k.w - 4, h - 4);
        if (SF.pc(m) === 0 && k.w >= 14) {
          g.font = '600 10px ' + FONT;
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
        if (!k.black || !vis(k)) continue;
        const col = this.pressed.has(m) ? C.pressed : active.get(m);
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
    if (col === C.pressed) return darken ? '#b5672a' : '#f5c08e';
    return darken ? '#4f7f6e' : '#bfe0d4';
  }

  SF.Renderer = Renderer;
  SF.COLORS = C;
})(typeof window !== 'undefined' ? window : globalThis);
