/* The results drawer: how a run went, note by note (by scale degree and the way the voice
 * moved to it, by note, by key), with the few things worth saying out loud; and the same over
 * time, from the runs saved before.
 *
 * Draws into elements it is given; the numbers come from SF.Report.
 */
(function (root) {
  'use strict';
  const SF = root.SF;
  const R = () => SF.Report;

  const STATUS = [
    ['hit', 'In tune'],
    ['close', 'Close'],
    ['off', 'Off'],
    ['silent', 'Not heard'],
  ];
  const SVGNS = 'http://www.w3.org/2000/svg';

  /** h('div', {class: 'x'}, child, 'text', ...) */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.startsWith('on')) el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  }
  function s(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    return el;
  }
  const pct = (x) => (x == null ? '–' : Math.round(x * 100) + '%');
  const centsTxt = (c) => (c == null ? '' : Math.abs(Math.round(c)) < 1 ? 'on pitch' : Math.abs(Math.round(c)) + '¢ ' + (c < 0 ? 'flat' : 'sharp'));
  const centsShort = (c) => (c == null ? '' : (Math.round(c) > 0 ? '+' : Math.round(c) < 0 ? '−' : '±') + Math.abs(Math.round(c)) + '¢');
  const score = (c) => (c.n ? (c.hit + 0.5 * c.close) / c.n : null);

  /** A thin bar split by verdict: in tune, close, off, not heard. */
  function statusBar(c) {
    const bar = h('div', { class: 'sbar', role: 'img', 'aria-label': describe(c) });
    if (!c.n) return bar;
    for (const [k] of STATUS) {
      if (!c[k]) continue;
      bar.append(h('i', { class: 'st-' + k, style: 'flex-grow:' + c[k] }));
    }
    return bar;
  }
  function describe(c) {
    if (!c.n) return 'nothing judged';
    const parts = [c.hit + ' of ' + c.n + ' in tune'];
    if (c.close) parts.push(c.close + ' close');
    if (c.off) parts.push(c.off + ' off');
    if (c.silent) parts.push(c.silent + ' not heard');
    const b = R().bias(c);
    if (b != null && c.cn >= 2) parts.push(centsTxt(b) + ' on average');
    return parts.join(', ');
  }
  function legend() {
    return h('div', { class: 'legend' }, STATUS.map(([k, l]) => h('span', null, h('i', { class: 'st-' + k }), l)));
  }
  function tile(label, value, sub, title) {
    return h('div', { class: 'tile', title }, h('span', { class: 'tl' }, label), h('b', null, value), sub ? h('span', { class: 'ts' }, sub) : null);
  }

  // ---------------------------------------------------------------- this run
  /**
   * run: {notes: [detail], rounds: [per-key result], started, bpm, live}
   * hist: the saved runs of this exercise; opts: {noteName(m), exName, onWeak, onAll}
   */
  function renderRun(el, run, hist, opts) {
    el.innerHTML = '';
    const notes = (run && run.notes) || [];
    const rounds = (run && run.rounds) || [];
    if (!notes.length && !rounds.length && !(run && run.summary)) {
      el.append(h('p', { class: 'hint', text: 'Sing an exercise with the mic on: every note you sing is judged, and how it went shows up here as you go.' }));
      return;
    }
    // (a run saved earlier comes as its summary: the notes themselves aren't kept)
    const s = run.summary || R().summarize(notes);
    const all = s.all;
    const when = new Date(run.started || Date.now());
    const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    el.append(
      h('p', { class: 'run-head' }, run.live ? 'This run so far' : 'Your last run, ' + (sameDay(when) ? 'at ' + time : when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + time), ': ' + rounds.length + (rounds.length === 1 ? ' key' : ' keys') + (run.bpm ? ' at ' + run.bpm + ' bpm' : '') + '.')
    );
    // the numbers
    const sc = score(all);
    const missed = all.off + all.silent;
    const b = R().bias(all);
    const tiles = h('div', { class: 'tiles' });
    tiles.append(tile('In tune', pct(sc), all.hit + ' of ' + all.n + ' hit' + (all.close ? ', ' + all.close + ' close' : ''), 'A close note counts half'));
    tiles.append(tile('Missed', String(missed), missed ? [all.off ? all.off + ' off pitch' : '', all.silent ? all.silent + ' not heard' : ''].filter(Boolean).join(', ') : 'none', 'Off by more than twice the tolerance, or not sung'));
    tiles.append(tile('Tuning', b == null ? '–' : Math.abs(Math.round(b)) < 3 ? 'centred' : centsTxt(b), 'on average, of the notes you sang', 'How far your notes sit from the target on average: flat is below, sharp above'));
    tiles.append(
      tile(
        'Settling',
        s.reach == null ? '–' : Math.round(s.reach / 10) * 10 + ' ms',
        s.lateShare == null ? 'time to land on each note' : pct(s.lateShare) + ' of notes took over ' + R().LATE_MS + ' ms',
        'How long after a note starts your voice is on it (the middle of all your notes)'
      )
    );
    tiles.append(tile('Steadiness', s.wobble == null ? '–' : '±' + Math.round(s.wobble) + '¢', 'how much the pitch wavers in a note', 'The spread of your pitch within each note, once you are on it'));
    el.append(tiles);
    // what stands out
    const prev = (hist || []).slice(0, run.live ? hist.length : Math.max(0, hist.length - 1));
    const ins = R().insights(s, { noteName: opts.noteName, prev, score: sc });
    if (ins.length) {
      el.append(h('h4', { text: 'What stands out' }));
      el.append(h('ul', { class: 'insights' }, ins.map((t) => h('li', { text: t }))));
    }
    if (s.byDeg.size) {
      el.append(h('h4', { text: 'By scale degree, and the way you moved to it' }));
      el.append(legend());
      el.append(degreeTable(s.byDeg));
      el.append(h('h4', { text: 'By note' }));
      el.append(pitchList(s.byPitch, opts.noteName));
    }
    if (rounds.length) {
      el.append(h('h4', { text: 'By key' }));
      el.append(roundList(rounds));
      const row = h('div', { class: 'row', style: 'margin-top:10px' });
      if (opts.onWeak) row.append(h('button', { onclick: opts.onWeak, text: 'Practise the weak keys' }));
      if (opts.onAll) row.append(h('button', { class: 'link', onclick: opts.onAll, text: 'All keys again' }));
      el.append(row);
    }
  }
  const sameDay = (d) => d.toDateString() === new Date().toDateString();

  /** Scale degree by direction: a row per degree, a column for up, down and the rest. */
  function degreeTable(byDeg) {
    const t = h('div', { class: 'deg-table', role: 'table', 'aria-label': 'Results by scale degree and direction' });
    t.append(h('span', { class: 'dh', role: 'columnheader' }, ''));
    for (const [, , label] of R().DIRS) t.append(h('span', { class: 'dh', role: 'columnheader', text: label }));
    // the weakest cell (with enough notes to say)
    let worst = null;
    for (const [deg, v] of byDeg)
      for (const [k] of R().DIRS) {
        const c = v[k];
        if (c.n >= 3 && (!worst || score(c) < worst.r)) worst = { deg, k, r: score(c) };
      }
    const degs = [...byDeg.keys()].sort((a, b) => R().DEG_ORDER.indexOf(a) - R().DEG_ORDER.indexOf(b));
    for (const deg of degs) {
      const v = byDeg.get(deg);
      t.append(h('span', { class: 'deg', role: 'rowheader', text: deg }));
      for (const [k, , label] of R().DIRS) {
        const c = v[k];
        if (!c.n) {
          t.append(h('span', { class: 'cell none', role: 'cell', text: '–' }));
          continue;
        }
        const b = R().bias(c);
        const weak = worst && worst.deg === deg && worst.k === k && worst.r < 0.85;
        t.append(
          h(
            'div',
            { class: 'cell' + (weak ? ' weak' : ''), role: 'cell', title: deg + ', ' + label.toLowerCase() + ': ' + describe(c) },
            statusBar(c),
            h('span', { class: 'cn' }, c.hit + '/' + c.n),
            h('span', { class: 'cc' }, b != null && c.cn ? centsShort(b) : '')
          )
        );
      }
    }
    return t;
  }
  function pitchList(byPitch, noteName) {
    const list = h('div', { class: 'res-list' });
    for (const p of [...byPitch.keys()].sort((a, b) => b - a)) {
      const c = byPitch.get(p);
      const b = R().bias(c);
      list.append(h('div', { class: 'res-row', title: describe(c) }, h('span', { text: noteName(p) }), statusBar(c), h('span', { class: 'ct' }, c.hit + '/' + c.n + (b != null && c.cn ? '  ' + centsShort(b) : ''))));
    }
    return list;
  }
  function roundList(rounds) {
    const list = h('div', { class: 'res-list' });
    for (const r of rounds) {
      const c = { n: r.n, hit: r.hit, close: r.close, off: r.off, silent: r.silent, cs: 0, cn: 0 };
      list.append(h('div', { class: 'res-row', title: describe(c) + (r.cents != null ? ', ' + centsTxt(r.cents) + ' on average' : '') }, h('span', { text: r.label }), statusBar(c), h('span', { class: 'ct', text: pct(r.score) + (r.cents == null ? '' : '  ' + centsShort(r.cents)) })));
    }
    return list;
  }

  // ---------------------------------------------------------------- over time
  /** hist: the saved runs of this exercise (oldest first); opts: {noteName, onCsv, onClear} */
  function renderTime(el, hist, opts) {
    el.innerHTML = '';
    if (!hist.length) {
      el.append(h('p', { class: 'hint', text: 'Nothing saved yet. A run is saved when it ends, or when you open another exercise.' }));
      return;
    }
    const runs = hist.slice(-30);
    const best = hist.reduce((m, x) => Math.max(m, x.score || 0), 0);
    const last5 = hist.slice(-5);
    const avg5 = last5.reduce((a, x) => a + x.score, 0) / last5.length;
    const tiles = h('div', { class: 'tiles' });
    tiles.append(tile('Runs', String(hist.length), 'since ' + new Date(hist[0].t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear(hist[0].t) ? undefined : 'numeric' })));
    tiles.append(tile('Lately', pct(avg5), 'in tune, the last ' + (last5.length === 1 ? 'run' : last5.length + ' runs')));
    tiles.append(tile('Best', pct(best), 'in tune'));
    el.append(tiles);

    el.append(h('h4', { text: 'In tune, run by run' }));
    el.append(
      lineChart(
        runs.map((x, i) => ({ i, y: x.score, tip: when(x.t) + ': ' + pct(x.score) + ' in tune, ' + x.keys + (x.keys === 1 ? ' key' : ' keys') + (x.bpm ? ' at ' + x.bpm + ' bpm' : '') })),
        { min: 0, max: 1, ticks: [0, 0.5, 1], fmt: pct, label: 'Share of notes in tune in each run', first: runs[0].t, last: runs[runs.length - 1].t }
      )
    );
    // tuning: from the breakdown where kept, else from the keys' averages
    const tuning = runs.map((x, i) => ({ i, y: biasOf(x), x })).filter((p) => p.y != null);
    if (tuning.length >= 2) {
      const m = Math.max(15, ...tuning.map((p) => Math.abs(p.y)));
      const lim = Math.ceil(m / 10) * 10;
      el.append(h('h4', { text: 'Tuning, run by run' }));
      el.append(
        lineChart(
          tuning.map((p) => ({ i: p.i, y: p.y, tip: when(p.x.t) + ': ' + (Math.abs(Math.round(p.y)) < 1 ? 'on pitch' : centsTxt(p.y)) + ' on average' })),
          { min: -lim, max: lim, ticks: [-lim, 0, lim], fmt: (v) => (v === 0 ? 'on pitch' : centsShort(v)), zero: true, label: 'Average cents flat (below) or sharp (above) in each run', first: runs[0].t, last: runs[runs.length - 1].t, n: runs.length }
        )
      );
    }
    const settle = runs.map((x, i) => ({ i, y: x.bd && x.bd.rt != null ? x.bd.rt : null, x })).filter((p) => p.y != null);
    if (settle.length >= 2) {
      const top = Math.max(300, Math.ceil(Math.max(...settle.map((p) => p.y)) / 100) * 100);
      el.append(h('h4', { text: 'Settling on each note, run by run' }));
      el.append(
        lineChart(
          settle.map((p) => ({ i: p.i, y: p.y, tip: when(p.x.t) + ': ' + p.y + ' ms to land on a note' + (p.x.bd.ls != null ? ', ' + p.x.bd.ls + '% over ' + R().LATE_MS + ' ms' : '') })),
          { min: 0, max: top, ticks: [0, top / 2, top], fmt: (v) => Math.round(v) + ' ms', label: 'Milliseconds to settle on a note in each run', first: runs[0].t, last: runs[runs.length - 1].t, n: runs.length }
        )
      );
    }
    // the notes missed most, and what changed
    const withBd = hist.filter((x) => x.bd);
    if (withBd.length) {
      const merged = R().expand(withBd.map((x) => x.bd));
      const cells = [];
      for (const [deg, v] of merged.byDeg) for (const [k, , label] of R().DIRS) if (v[k].n >= 6) cells.push({ deg, k, label, c: v[k], r: score(v[k]) });
      cells.sort((a, b) => a.r - b.r);
      const weak = cells.filter((x) => x.r < 0.85).slice(0, 4);
      el.append(h('h4', { text: 'Missed most, over ' + (withBd.length === 1 ? 'the run' : 'the last ' + withBd.length + ' runs') }));
      if (weak.length) {
        el.append(legend());
        const list = h('div', { class: 'res-list' });
        for (const x of weak) list.append(h('div', { class: 'res-row wide', title: describe(x.c) }, h('span', { text: x.deg + ' ' + dirWord(x.k) }), statusBar(x.c), h('span', { class: 'ct', text: pct(x.r) })));
        el.append(list);
      } else el.append(h('p', { class: 'hint', text: cells.length ? 'Nothing below 85%: every scale degree, up or down, goes well.' : 'Not enough notes yet to say.' }));
      // then and now
      if (withBd.length >= 4) {
        const half = Math.floor(withBd.length / 2);
        const old = R().expand(withBd.slice(0, half).map((x) => x.bd));
        const now = R().expand(withBd.slice(half).map((x) => x.bd));
        const ch = [];
        for (const [deg, v] of now.byDeg) {
          const o = old.byDeg.get(deg);
          if (!o) continue;
          for (const [k] of R().DIRS) if (v[k].n >= 4 && o[k].n >= 4) ch.push({ deg, k, a: score(o[k]), b: score(v[k]) });
        }
        const up = ch.filter((x) => x.b - x.a >= 0.1).sort((x, y) => y.b - y.a - (x.b - x.a)).slice(0, 3);
        const down = ch.filter((x) => x.a - x.b >= 0.1).sort((x, y) => x.b - x.a - (y.b - y.a)).slice(0, 3);
        el.append(h('h4', { text: 'Then and now' }));
        el.append(h('p', { class: 'hint', text: 'Your first ' + half + ' runs with a breakdown against the ' + (withBd.length - half) + ' since.' }));
        if (!up.length && !down.length) el.append(h('p', { class: 'hint', text: 'About the same on every scale degree.' }));
        const line = (x, better) => h('li', null, h('b', { text: x.deg + ' ' + dirWord(x.k) }), ': ' + pct(x.a) + ' then, ' + pct(x.b) + ' now', h('span', { class: better ? 'up' : 'down', text: better ? '  better' : '  lower' }));
        if (up.length || down.length) el.append(h('ul', { class: 'insights' }, up.map((x) => line(x, true)), down.map((x) => line(x, false))));
      }
    }
    el.append(h('h4', { text: 'Every run' }));
    const box = h('div');
    for (const x of hist.slice(-15).reverse()) {
      const d = new Date(x.t);
      box.append(
        h(
          'div',
          { class: 'hist-row' },
          h('span', { text: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }),
          h('span', { text: x.keys + (x.keys === 1 ? ' key' : ' keys') + ', ' + x.bpm + ' bpm' + (x.guide === false ? ', chord only' : '') }),
          h('span', { class: 's', text: pct(x.score) })
        )
      );
    }
    el.append(box);
    const row = h('div', { class: 'row', style: 'margin-top:12px' });
    if (opts.onCsv) row.append(h('button', { onclick: opts.onCsv, text: 'Export all results (CSV)' }));
    if (opts.onClear) row.append(h('button', { class: 'link', onclick: opts.onClear, text: 'Clear this exercise’s history' }));
    el.append(row);
  }
  const dirWord = (k) => (k === 'up' ? 'going up' : k === 'down' ? 'going down' : 'repeated or first');
  const sameYear = (t) => new Date(t).getFullYear() === new Date().getFullYear();
  const when = (t) => {
    const d = new Date(t);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };
  function biasOf(x) {
    if (x.bd && x.bd.b != null) return x.bd.b;
    let s = 0;
    let n = 0;
    for (const r of x.rounds || []) {
      if (r.ct == null) continue;
      const k = r.n - r.s;
      s += r.ct * k;
      n += k;
    }
    return n ? s / n : null;
  }

  /**
   * A small line chart: one series of points {i, y, tip} over runs (i: 0..n-1), with a
   * hover readout. opts: {min, max, ticks, fmt, zero, label, first, last, n}
   */
  function lineChart(pts, opts) {
    const wrap = h('div', { class: 'chart' });
    const W = 520;
    const H = 132;
    const L = 64;
    const Rm = 10;
    const T = 10;
    const B = 22;
    const n = Math.max(2, opts.n || pts.length);
    const x = (i) => L + (n === 1 ? 0 : (i / (n - 1)) * (W - L - Rm));
    const y = (v) => T + (1 - (SF.clamp(v, opts.min, opts.max) - opts.min) / (opts.max - opts.min)) * (H - T - B);
    const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.label, preserveAspectRatio: 'none' });
    svg.style.width = '100%';
    svg.style.height = H + 'px';
    for (const t of opts.ticks) {
      svg.append(s('line', { x1: L, x2: W - Rm, y1: y(t), y2: y(t), class: t === 0 && opts.zero ? 'zero' : 'grid' }));
      const tx = s('text', { x: L - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' });
      tx.textContent = opts.fmt(t);
      svg.append(tx);
    }
    const dates = [
      [opts.first, 'start'],
      [opts.last, 'end'],
    ];
    for (const [t, anchor] of dates) {
      if (!t) continue;
      const tx = s('text', { x: anchor === 'start' ? L : W - Rm, y: H - 5, 'text-anchor': anchor, class: 'tick' });
      tx.textContent = new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      svg.append(tx);
    }
    const d = pts.map((p, k) => (k ? 'L' : 'M') + x(p.i).toFixed(1) + ' ' + y(p.y).toFixed(1)).join(' ');
    svg.append(s('path', { d, class: 'line' }));
    for (const p of pts) svg.append(s('circle', { cx: x(p.i), cy: y(p.y), r: 4, class: 'pt' }));
    const hi = s('circle', { r: 6, class: 'pt-hi', cx: 0, cy: 0, visibility: 'hidden' });
    svg.append(hi);
    wrap.append(svg);
    const tip = h('div', { class: 'tip', hidden: true });
    wrap.append(tip);
    // the nearest run to the pointer
    const show = (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      let best = null;
      for (const p of pts) if (!best || Math.abs(x(p.i) - px) < Math.abs(x(best.i) - px)) best = p;
      if (!best) return;
      hi.setAttribute('cx', x(best.i));
      hi.setAttribute('cy', y(best.y));
      hi.setAttribute('visibility', 'visible');
      tip.textContent = best.tip;
      tip.hidden = false;
      const left = (x(best.i) / W) * r.width;
      tip.style.left = SF.clamp(left, 70, r.width - 70) + 'px';
      tip.style.top = Math.max(0, (y(best.y) / H) * r.height - 38) + 'px';
    };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', () => {
      tip.hidden = true;
      hi.setAttribute('visibility', 'hidden');
    });
    // the same numbers as a table, for screen readers
    const tbl = h('table', { class: 'sr-only' }, h('caption', { text: opts.label }), pts.map((p) => h('tr', null, h('td', { text: p.tip }))));
    wrap.append(tbl);
    return wrap;
  }

  SF.ResultsView = { renderRun, renderTime, statusBar, describe };
})(typeof window !== 'undefined' ? window : globalThis);
