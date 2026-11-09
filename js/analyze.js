/* Works out what a MIDI file asks the singer to do — from the notes alone.
 *
 * Output: every note gets a role ('sing' or 'acc'), sung notes get a voice
 * (0 = top), and the file is cut into rounds (one key each) or, for songs,
 * phrases. Nothing here knows any file names.
 *
 * How roles are decided, first rule that applies wins:
 *  1. The user's own choice of parts (opts.roles).
 *  2. Track names: a track called "sing", "melody", "voice", "lead"… is sung.
 *  3. Several tracks/channels: the single-line part(s) are sung, the rest accompany.
 *     Single-line parts that move together become voices you can choose between.
 *  4. One part, built like the scale generator's files (a reference chord, the
 *     exercise, the chord again, repeated in other keys): find that repeating
 *     round. Its opening chord, and the same chord at its end, are references;
 *     everything between is sung — one line, or several voices if the exercise
 *     itself is in chords (like "voices").
 *  5. Otherwise: chords standing on their own (nothing else sounding) are
 *     references, single notes are sung.
 */
(function (root) {
  'use strict';
  const SF = root.SF;

  const SING_RE = /(sing|sung|voice|vocal|vox|melod|lead|target|guide|soprano|alto|tenor|baritone)/i;

  const byOn = (a, b) => a.on - b.on || a.pitch - b.pitch;

  /** Group notes whose onsets are within tol ticks. Adds block/isolated flags. */
  function clusterByOnset(notes, tol) {
    const sorted = notes.slice().sort(byOn);
    const out = [];
    let cur = null;
    for (const n of sorted) {
      if (cur && n.on - cur.on <= tol) cur.notes.push(n);
      else {
        cur = { on: n.on, notes: [n] };
        out.push(cur);
      }
    }
    let maxOff = -Infinity;
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      c.notes.sort((a, b) => a.pitch - b.pitch);
      c.lo = c.notes[0].pitch;
      c.hi = c.notes[c.notes.length - 1].pitch;
      c.shape = c.notes.map((n) => n.pitch - c.lo).join(',');
      let mn = Infinity;
      let mx = -Infinity;
      for (const n of c.notes) {
        if (n.off < mn) mn = n.off;
        if (n.off > mx) mx = n.off;
      }
      c.off = mx;
      c.dur = mx - c.on;
      c.block = mx - mn <= tol;
      c.isoPrev = maxOff <= c.on + tol;
      if (mx > maxOff) maxOff = mx;
    }
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      c.isoNext = i + 1 >= out.length || out[i + 1].on >= c.off - tol;
      c.isolated = c.isoPrev && c.isoNext;
    }
    return out;
  }

  // ---------- chords and keys ----------
  const CHORDS = [
    ['major', [0, 4, 7], 'major'],
    ['minor', [0, 3, 7], 'minor'],
    ['7', [0, 4, 7, 10], 'major'],
    ['maj7', [0, 4, 7, 11], 'major'],
    ['m7', [0, 3, 7, 10], 'minor'],
    ['6', [0, 4, 7, 9], 'major'],
    ['m6', [0, 3, 7, 9], 'minor'],
    ['sus4', [0, 5, 7], 'major'],
    ['sus2', [0, 2, 7], 'major'],
    ['dim', [0, 3, 6], 'other'],
    ['aug', [0, 4, 8], 'other'],
    ['m7♭5', [0, 3, 6, 10], 'other'],
    ['dim7', [0, 3, 6, 9], 'other'],
    ['5', [0, 7], 'major'],
    ['major 3rd', [0, 4], 'major'],
    ['minor 3rd', [0, 3], 'minor'],
  ];
  /** Root and quality of a chord given as MIDI pitches. */
  function chordKey(pitches) {
    const bass = Math.min(...pitches);
    const pcs = [...new Set(pitches.map(SF.pc))];
    const cands = [SF.pc(bass)].concat(pcs.filter((p) => p !== SF.pc(bass)));
    for (const [name, iv, quality] of CHORDS) {
      if (iv.length !== pcs.length) continue;
      for (const r of cands) {
        const rel = pcs.map((p) => SF.pc(p - r)).sort((a, b) => a - b);
        if (rel.join() === iv.join()) return makeKey(r, quality, name, bass);
      }
    }
    return makeKey(SF.pc(bass), 'other', '', bass);
  }
  function makeKey(rootPc, quality, chord, bass) {
    // The MIDI note of the root as it sounds in the chord (lowest instance at/above the bass).
    let rootMidi = bass;
    while (SF.pc(rootMidi) !== rootPc) rootMidi++;
    return {
      root: rootPc,
      rootMidi,
      quality,
      chord,
      flats: SF.keyUsesFlats(rootPc, quality),
      // movable do; la-based minor
      doPc: quality === 'minor' ? SF.pc(rootPc + 3) : rootPc,
    };
  }
  function keyFromSignature(ks) {
    const majorPc = SF.pc(ks.sf * 7);
    const root = ks.mi ? SF.pc(majorPc + 9) : majorPc;
    return makeKey(root, ks.mi ? 'minor' : 'major', ks.mi ? 'minor' : 'major', 60 + root);
  }
  // Krumhansl–Kessler key profiles, for songs without a key signature.
  const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  /** Key from how long each pitch class sounds (notes may carry a weight w). */
  function keyScores(notes) {
    const h = new Array(12).fill(0);
    for (const n of notes) h[SF.pc(n.pitch)] += (n.off - n.on) * (n.w == null ? 1 : n.w);
    const corr = (prof, r) => {
      const xs = [];
      for (let i = 0; i < 12; i++) xs.push(h[(i + r) % 12]);
      const mx = SF.mean(xs);
      const my = SF.mean(prof);
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < 12; i++) {
        sxy += (xs[i] - mx) * (prof[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (prof[i] - my) ** 2;
      }
      return sxx && syy ? sxy / Math.sqrt(sxx * syy) : -1;
    };
    const out = [];
    for (let r = 0; r < 12; r++) {
      out.push({ r, mi: 0, c: corr(KK_MAJ, r) });
      out.push({ r, mi: 1, c: corr(KK_MIN, r) });
    }
    return out.sort((a, b) => b.c - a.c);
  }
  const keyOfScore = (b) => makeKey(b.r, b.mi ? 'minor' : 'major', b.mi ? 'minor' : 'major', 60 + b.r);
  function estimateKey(notes) {
    return keyOfScore(keyScores(notes)[0]);
  }
  /** Songs: each section's key from its own notes (and a little of its neighbours'),
   *  changing from the song's overall key only when the section clearly says so. */
  function sectionKeys(rounds, overall) {
    return rounds.map((r, i) => {
      const pool = [];
      for (const [j, w] of [[i - 1, 0.5], [i, 1], [i + 1, 0.5]]) {
        if (j < 0 || j >= rounds.length) continue;
        for (const n of rounds[j].notes) pool.push({ pitch: n.pitch, on: n.on, off: n.off, w });
      }
      if (pool.length < 4) return overall;
      const sc = keyScores(pool);
      const best = sc[0];
      const cur = sc.find((x) => x.r === overall.root && x.mi === (overall.quality === 'minor' ? 1 : 0));
      if (!cur || best.c - cur.c > 0.12) return keyOfScore(best);
      return overall;
    });
  }

  // ---------- the repeating-round finder ----------
  /** Template entries sorted by time then pitch. */
  const tcmp = (a, b) => a.dt - b.dt || a.dp - b.dp;

  function findTemplate(notes, clusters, tol) {
    if (clusters.length < 3) return null;
    const c0 = clusters[0];
    if (c0.notes.length < 2 || !c0.block || !c0.isolated) return null;
    const isRef = (c) =>
      c.notes.length === c0.notes.length && c.block && c.isolated && c.shape === c0.shape && Math.abs(c.dur - c0.dur) <= tol;
    const refs = clusters.filter((c, i) => i > 0 && isRef(c));
    if (!refs.length) return null;
    const sorted = notes.slice().sort(byOn);
    const ons = sorted.map((n) => n.on);
    const notesIn = (a, b) => sorted.slice(SF.lowerBound(ons, a, (x) => x), SF.lowerBound(ons, b, (x) => x));

    // Each later chord like the opening one is a candidate start for round 2.
    for (const c1 of refs) {
      const L = c1.on - c0.on;
      if (L <= c0.dur - tol) continue;
      const tmpl = notesIn(c0.on - tol, c1.on - tol)
        .map((n) => ({ dt: n.on - c0.on, d: n.off - n.on, dp: n.pitch - c0.lo }))
        .sort(tcmp);
      const rounds = tile(sorted, ons, refs, c0, L, tmpl, tol, notesIn);
      if (rounds) return { L, tmpl, rounds, c0 };
    }
    return null;
  }

  function tile(sorted, ons, refs, c0, L, tmpl, tol, notesIn) {
    const refOns = refs.map((c) => c.on);
    const refNear = (t) => {
      const i = SF.lowerBound(refOns, t - 2 * tol, (x) => x);
      return i < refs.length && Math.abs(refs[i].on - t) <= 2 * tol ? refs[i] : null;
    };
    const rounds = [];
    let start = c0;
    let covered = 0;
    for (let guard = 0; guard < 100000; guard++) {
      const delta = start.lo - c0.lo;
      const next = refNear(start.on + L);
      const rnotes = notesIn(start.on - tol, next ? next.on - tol : Infinity);
      const match = compareRound(rnotes, tmpl, start.on, c0.lo + delta, tol, !next);
      if (!match) return null;
      rounds.push({ on: start.on, next: next ? next.on : null, delta, notes: rnotes, match });
      covered += rnotes.length;
      if (!next) break;
      start = next;
    }
    if (covered !== sorted.length || rounds.length < 2) return null;
    return rounds;
  }

  /** Match a round's notes to the template. Returns template index per note, or null. */
  function compareRound(rnotes, tmpl, start, lo, tol, last) {
    if (!rnotes.length) return null;
    if (!last && rnotes.length !== tmpl.length) return null;
    if (last && rnotes.length > tmpl.length) return null;
    const used = new Uint8Array(tmpl.length);
    const out = new Array(rnotes.length);
    let maxDt = -Infinity;
    for (let i = 0; i < rnotes.length; i++) {
      const n = rnotes[i];
      const dt = n.on - start;
      const d = n.off - n.on;
      const dp = n.pitch - lo;
      if (dt > maxDt) maxDt = dt;
      let found = -1;
      // template is sorted by dt: start the scan near dt
      let j = SF.lowerBound(tmpl, dt - tol - 0.5, (x) => x.dt);
      for (; j < tmpl.length && tmpl[j].dt <= dt + tol; j++) {
        if (used[j] || tmpl[j].dp !== dp) continue;
        if (Math.abs(tmpl[j].d - d) > tol) continue;
        found = j;
        break;
      }
      if (found < 0) return null;
      used[found] = 1;
      out[i] = found;
    }
    if (last) {
      // Only the end of the round may be missing (the generator drops the final closing chord).
      for (let j = 0; j < tmpl.length; j++) if (!used[j] && tmpl[j].dt < maxDt - tol) return null;
    }
    return out;
  }

  /** Which template entries are reference chords: the opening chord, the same chord closing the round,
   *  and — when the exercise is mostly single notes — any other chord standing on its own. */
  function classifyTemplate(tmpl, tol) {
    const pseudo = tmpl.map((e, i) => ({ on: e.dt, off: e.dt + e.d, pitch: e.dp, idx: i }));
    const cl = clusterByOnset(pseudo, tol);
    const ref = new Set([0]);
    const first = cl[0];
    const lastI = cl.length - 1;
    const last = cl[lastI];
    if (lastI > 0 && last.shape === first.shape && last.lo === first.lo && last.block && last.isolated) ref.add(lastI);
    const rest = cl.filter((c, i) => !ref.has(i));
    const singles = rest.filter((c) => c.notes.length === 1).length;
    if (rest.length && singles >= rest.length / 2) {
      cl.forEach((c, i) => {
        if (!ref.has(i) && c.notes.length >= 2 && c.block && c.isolated) ref.add(i);
      });
    }
    const role = new Array(tmpl.length).fill('sing');
    cl.forEach((c, i) => {
      if (ref.has(i)) for (const n of c.notes) role[n.idx] = 'acc';
    });
    if (role.every((r) => r === 'acc')) return null; // nothing left to sing
    return role;
  }

  // ---------- parts ----------
  function buildParts(notes, midi, tol) {
    const map = new Map();
    for (const n of notes) {
      const key = n.trk + ':' + n.ch;
      if (!map.has(key)) {
        const t = midi.tracks[n.trk] || {};
        map.set(key, { key, trk: n.trk, ch: n.ch, name: t.name || '', notes: [] });
      }
      map.get(key).notes.push(n);
    }
    const parts = [...map.values()].sort((a, b) => a.trk - b.trk || a.ch - b.ch);
    for (const p of parts) {
      const cl = clusterByOnset(p.notes, tol);
      p.onsets = new Set(cl.map((c) => Math.round(c.on / tol)));
      p.mono = cl.filter((c) => c.notes.length === 1).length >= 0.9 * cl.length;
      p.lo = Math.min(...p.notes.map((n) => n.pitch));
      p.hi = Math.max(...p.notes.map((n) => n.pitch));
      p.mean = SF.mean(p.notes.map((n) => n.pitch));
      p.label = (p.name ? p.name + ', ' : '') + 'track ' + (p.trk + 1) + ', channel ' + (p.ch + 1);
    }
    return parts;
  }
  function sharedOnsets(a, b) {
    let s = 0;
    for (const x of a.onsets) if (b.onsets.has(x) || b.onsets.has(x - 1) || b.onsets.has(x + 1)) s++;
    return s / Math.max(1, Math.min(a.onsets.size, b.onsets.size));
  }

  // ---------- voices ----------
  /** Give each sung note a voice: 0 = top. Uses parts when the voices come in separate parts. */
  function assignVoices(sung, voiceParts, tol) {
    if (voiceParts && voiceParts.length > 1) {
      const order = voiceParts.slice().sort((a, b) => b.mean - a.mean);
      const idx = new Map(order.map((p, i) => [p.key, i]));
      for (const n of sung) n.voice = idx.get(n.trk + ':' + n.ch);
      return { V: order.length, demoted: [] };
    }
    const cl = clusterByOnset(sung, tol);
    const multi = cl.filter((c) => c.notes.length > 1).length;
    const demoted = [];
    if (!cl.length) return { V: 0, demoted };
    if (multi < 0.3 * cl.length) {
      // A line with the odd double-stop: sing the top note, the rest accompanies.
      for (const c of cl) {
        const top = c.notes[c.notes.length - 1];
        for (const n of c.notes) {
          if (n === top) n.voice = 0;
          else {
            n.voice = -1;
            demoted.push(n);
          }
        }
      }
      return { V: 1, demoted };
    }
    const V = Math.max(...cl.map((c) => c.notes.length));
    const last = new Array(V).fill(null);
    for (const c of cl) {
      const desc = c.notes.slice().sort((a, b) => b.pitch - a.pitch);
      if (desc.length === V) {
        desc.forEach((n, i) => (n.voice = i));
      } else {
        // fewer notes than voices: give each to the voice it is closest to
        const free = new Set(Array.from({ length: V }, (_, i) => i));
        for (const n of desc) {
          let best = -1;
          let bd = Infinity;
          for (const v of free) {
            const ref = last[v] == null ? n.pitch : last[v];
            const dist = Math.abs(ref - n.pitch) + v * 1e-3;
            if (dist < bd) {
              bd = dist;
              best = v;
            }
          }
          n.voice = best;
          free.delete(best);
        }
      }
      for (const n of c.notes) last[n.voice] = n.pitch;
    }
    return { V, demoted };
  }

  function voiceLabels(V) {
    if (V === 2) return ['Upper', 'Lower'];
    if (V === 3) return ['Top', 'Middle', 'Bottom'];
    if (V === 4) return ['Top', 'Upper middle', 'Lower middle', 'Bottom'];
    return Array.from({ length: V }, (_, i) => 'Voice ' + (i + 1) + (i === 0 ? ' (top)' : i === V - 1 ? ' (bottom)' : ''));
  }

  // ---------- sections when there is no repeating round ----------
  function roundsFromReferenceChords(all, tol) {
    const cl = clusterByOnset(all, tol);
    // when is something being sung?
    const sungIv = all.filter((n) => n.role === 'sing').map((n) => [n.on, n.off]);
    sungIv.sort((a, b) => a[0] - b[0]);
    const overlapsSung = (c) => {
      for (const [a, b] of sungIv) {
        if (a >= c.off - tol) break;
        if (b > c.on + tol) return true;
      }
      return false;
    };
    for (const c of cl) {
      const hasSing = c.notes.some((n) => n.role === 'sing');
      c.kind = hasSing ? 'sing' : c.notes.length >= 2 && !overlapsSung(c) ? 'ref' : 'acc';
    }
    // Only an exercise whose chords mostly stand apart from the singing has rounds;
    // a song whose accompaniment plays under the tune has phrases instead.
    const accCl = cl.filter((c) => c.kind !== 'sing');
    const refCl = cl.filter((c) => c.kind === 'ref');
    if (refCl.length < 2 || refCl.length < 0.6 * accCl.length) return null;
    const rounds = [];
    let cur = null;
    let prev = null;
    for (let i = 0; i < cl.length; i++) {
      const c = cl[i];
      const next = cl[i + 1];
      if (c.kind === 'ref') {
        let starts = !cur;
        if (cur && prev && prev.kind === 'ref' && cur.hasSing) starts = true; // closing chord, then the next opening chord
        if (cur && prev && prev.kind === 'sing' && next && next.kind !== 'ref') starts = true; // one chord between phrases
        if (starts) {
          cur = { on: c.on, refs: [c], hasSing: false };
          rounds.push(cur);
        } else cur.refs.push(c);
      } else {
        if (!cur) {
          cur = { on: c.on, refs: [], hasSing: false };
          rounds.push(cur);
        }
        if (c.kind === 'sing') cur.hasSing = true;
      }
      prev = c;
    }
    // a "round" with nothing to sing belongs to the one before it
    const merged = [];
    for (const r of rounds) {
      if (!r.hasSing && merged.length) merged[merged.length - 1].refs.push(...r.refs);
      else merged.push(r);
    }
    if (merged.length < 2 || !merged.some((r) => r.refs.length)) return null;
    return merged.map((r) => ({ on: r.on, refs: r.refs }));
  }

  /** Songs: cut at the breaths (rests of half a beat or more), keep sections 2–8 bars long. */
  function phraseSections(all, ppq, bar) {
    const sung = all.filter((n) => n.role === 'sing').sort(byOn);
    if (!sung.length) return [{ on: Math.min(...all.map((n) => n.on)) }];
    let starts = [sung[0].on];
    let maxOff = sung[0].off;
    for (let i = 1; i < sung.length; i++) {
      if (sung[i].on - maxOff >= 0.45 * ppq) starts.push(sung[i].on);
      maxOff = Math.max(maxOff, sung[i].off);
    }
    const end = maxOff;
    // merge sections shorter than 2 bars into the one before
    const merged = [];
    for (let i = 0; i < starts.length; i++) {
      const next = i + 1 < starts.length ? starts[i + 1] : end;
      if (merged.length && next - starts[i] < 2 * bar && starts[i] - merged[merged.length - 1] < 8 * bar) continue;
      merged.push(starts[i]);
    }
    // split sections longer than 8 bars every 4 bars, at the next note onset
    const onsets = sung.map((n) => n.on);
    starts = [];
    for (let i = 0; i < merged.length; i++) {
      const s = merged[i];
      const e = i + 1 < merged.length ? merged[i + 1] : end;
      starts.push(s);
      if (e - s <= 8 * bar) continue;
      for (let t = s + 4 * bar; e - t >= 2 * bar; t += 4 * bar) {
        const j = SF.lowerBound(onsets, t, (x) => x);
        if (j < onsets.length && onsets[j] < e - 2 * bar && onsets[j] > starts[starts.length - 1]) starts.push(onsets[j]);
      }
    }
    const out = starts.map((on) => ({ on }));
    out[0].on = Math.min(out[0].on, Math.min(...all.map((n) => n.on)));
    return out;
  }

  // ---------- main ----------
  function analyze(midi, opts) {
    opts = opts || {};
    const ppq = midi.ppq;
    const tol = Math.max(2, Math.round(ppq / 160));
    const tempo = new SF.TempoMap(ppq, midi.tempos);
    const notes = midi.notes
      .filter((n) => n.ch !== 9 && n.off > n.on)
      .map((n) => Object.assign({}, n))
      .sort(byOn);
    if (!notes.length) throw new Error('This MIDI file has no notes to play');
    notes.forEach((n, i) => {
      n.id = i;
      n.role = 'sing';
      n.voice = -1;
    });

    const parts = buildParts(notes, midi, tol);
    const clusters = clusterByOnset(notes, tol);
    const template = findTemplate(notes, clusters, tol);
    let method = '';
    let voiceParts = null;

    const roles = opts.roles || null;
    const chosen = roles && parts.some((p) => roles[p.key]) ? parts.filter((p) => roles[p.key] === 'sing') : null;
    const named = parts.filter((p) => SING_RE.test(p.name));
    const mono = parts.filter((p) => p.mono && p.notes.length >= 3);

    let singParts = null;
    if (chosen && chosen.length) {
      singParts = chosen;
      method = 'chosen';
    } else if (named.length && named.length < parts.length) {
      singParts = named;
      method = 'named';
    } else if (parts.length >= 2 && mono.length && !template) {
      // The top single-line part is the tune; other single-line parts that move with it are more voices.
      const top = mono.slice().sort((a, b) => b.mean - a.mean)[0];
      singParts = [top].concat(mono.filter((p) => p !== top && sharedOnsets(p, top) >= 0.7));
      method = 'parts';
    }

    const troles = template && !singParts ? classifyTemplate(template.tmpl, tol) : null;
    if (singParts) {
      const keys = new Set(singParts.map((p) => p.key));
      for (const n of notes) n.role = keys.has(n.trk + ':' + n.ch) ? 'sing' : 'acc';
      if (singParts.length > 1 && singParts.every((p) => p.mono)) voiceParts = singParts;
    } else if (troles) {
      for (const r of template.rounds) r.notes.forEach((n, i) => (n.role = troles[r.match[i]]));
      method = 'template';
    } else {
      // Chords on their own are references; single notes are sung; a melody on top of chords is sung.
      const cl = clusters;
      const singles = cl.filter((c) => c.notes.length === 1).length;
      if (singles >= 0.4 * cl.length) {
        for (const c of cl) {
          if (c.notes.length >= 2 && c.block && c.isolated) for (const n of c.notes) n.role = 'acc';
          else if (c.notes.length >= 2) {
            const top = c.notes[c.notes.length - 1];
            for (const n of c.notes) n.role = n === top ? 'sing' : 'acc';
          }
        }
        method = notes.some((n) => n.role === 'acc') ? 'chords' : 'melody';
      } else {
        method = 'melody';
      }
    }

    const sung = notes.filter((n) => n.role === 'sing');
    if (!sung.length) {
      // Everything turned out to be accompaniment: sing the top line instead.
      for (const c of clusters) c.notes[c.notes.length - 1].role = 'sing';
      method = 'melody';
    }
    const sungNotes = notes.filter((n) => n.role === 'sing');
    const { V, demoted } = assignVoices(sungNotes, voiceParts, tol);
    for (const n of demoted) n.role = 'acc';
    // slots: sung notes that start together
    const sungFinal = notes.filter((n) => n.role === 'sing');
    clusterByOnset(sungFinal, tol).forEach((c, i) => c.notes.forEach((n) => (n.slot = i)));
    // sung notes that start as a chord stops: the piano is still ringing for a moment
    const accOffs = new Set();
    for (const n of notes) if (n.role === 'acc') accOffs.add(Math.round(n.off / tol));
    for (const n of sungFinal) {
      const k = Math.round(n.on / tol);
      n.afterChord = accOffs.has(k) || accOffs.has(k - 1) || accOffs.has(k + 1);
    }

    // ---------- rounds / sections ----------
    let secs;
    let structure;
    if (template) {
      secs = template.rounds.map((r) => {
        const opening = r.notes.filter((n) => n.on - r.on <= tol && n.role === 'acc');
        return { on: r.on, refs: opening.length ? [{ notes: opening }] : [] };
      });
      structure = 'rounds';
    } else {
      secs = roundsFromReferenceChords(notes, tol);
      structure = secs ? 'rounds' : 'sections';
      if (!secs) {
        const ts0 = midi.timeSigs[0] || { num: 4, den: 4 };
        secs = phraseSections(notes, ppq, (ppq * 4 * ts0.num) / ts0.den);
      }
    }
    let globalKey = null;
    if (structure === 'sections') {
      globalKey = midi.keySigs.length ? keyFromSignature(midi.keySigs[0]) : estimateKey(sungFinal.length ? sungFinal : notes);
    }
    const lastOff = Math.max(...notes.map((n) => n.off));
    const rounds = secs.map((s, i) => {
      const end = i + 1 < secs.length ? secs[i + 1].on : lastOff;
      let key = globalKey;
      if (s.refs && s.refs.length) key = chordKey(s.refs[0].notes.map((n) => n.pitch));
      return { i, on: s.on, end, key, notes: [] };
    });
    for (const n of notes) {
      let r = SF.lowerBound(rounds, n.on + tol + 1, (x) => x.on) - 1;
      if (r < 0) r = 0;
      n.round = r;
      n.s0 = tempo.sec(n.on);
      n.s1 = tempo.sec(n.off);
      rounds[r].notes.push(n);
    }
    // The key is always worked out from each section's own notes; key-signature events,
    // if a file has any, only seed the songs' overall key.
    if (structure === 'sections' && globalKey) {
      const ks = sectionKeys(rounds, globalKey);
      rounds.forEach((r, i) => (r.key = ks[i]));
    }
    for (const r of rounds) {
      if (r.key && r.key.quality === 'other' && r.notes.length >= 4) {
        // a reference chord that isn't plainly major or minor: let the round's notes decide
        const k = estimateKey(r.notes);
        const chordPcs = new Set(r.notes.filter((n) => n.role === 'acc').map((n) => SF.pc(n.pitch)));
        if (chordPcs.has(k.root)) r.key = k;
      }
    }
    for (const r of rounds) {
      r.s0 = tempo.sec(r.on);
      r.s1 = tempo.sec(r.end);
      const s = r.notes.filter((n) => n.role === 'sing');
      r.sungCount = s.length;
      r.singLo = s.length ? Math.min(...s.map((n) => n.pitch)) : null;
      r.singHi = s.length ? Math.max(...s.map((n) => n.pitch)) : null;
      r.voiceLo = [];
      r.voiceHi = [];
      for (let v = 0; v < V; v++) {
        const vs = s.filter((n) => n.voice === v);
        r.voiceLo.push(vs.length ? Math.min(...vs.map((n) => n.pitch)) : null);
        r.voiceHi.push(vs.length ? Math.max(...vs.map((n) => n.pitch)) : null);
      }
      r.firstSing = s.length ? Math.min(...s.map((n) => n.s0)) : null;
      r.lastSing = s.length ? Math.max(...s.map((n) => n.s1)) : null;
      if (!r.key && s.length) {
        r.key = makeKey(SF.pc(s[0].pitch), 'major', '', s[0].pitch);
        r.key.guessed = true;
      }
      r.label =
        structure === 'rounds' && r.key ? SF.pcName(r.key.root, r.key.flats) + SF.octave(r.key.rootMidi) : 'Part ' + (r.i + 1);
    }

    const maxVel = { sing: 1, acc: 1 };
    for (const n of notes) maxVel[n.role] = Math.max(maxVel[n.role], n.vel);
    const all = notes.map((n) => n.pitch);
    const ts = midi.timeSigs[0] || { num: 4, den: 4 };
    const hasAcc = notes.some((n) => n.role === 'acc');
    const what =
      V > 1
        ? V + ' voices to choose from'
        : structure === 'rounds' && hasAcc
        ? 'a reference chord and one line to sing'
        : hasAcc
        ? 'a melody with accompaniment'
        : 'a melody on its own';
    const ex = {
      ppq,
      tol,
      tempo,
      bpm: tempo.bpm,
      timeSig: ts,
      notes,
      rounds,
      structure,
      method,
      voices: V,
      voiceLabels: voiceLabels(V),
      parts: parts.map((p) => ({
        key: p.key,
        label: p.label,
        name: p.name,
        count: p.notes.length,
        lo: p.lo,
        hi: p.hi,
        mono: p.mono,
        role: p.notes.every((n) => n.role === 'sing') ? 'sing' : p.notes.every((n) => n.role === 'acc') ? 'acc' : 'mixed',
      })),
      maxVel,
      lo: Math.min(...all),
      hi: Math.max(...all),
      duration: tempo.sec(lastOff),
      globalKey,
      summary:
        rounds.length +
        (structure === 'rounds' ? (rounds.length === 1 ? ' key' : ' keys') : rounds.length === 1 ? ' section' : ' sections') +
        ', ' +
        what,
    };
    return ex;
  }

  SF.analyze = analyze;
  SF.analyzeInternals = { clusterByOnset, chordKey, findTemplate, estimateKey };
})(typeof window !== 'undefined' ? window : globalThis);
