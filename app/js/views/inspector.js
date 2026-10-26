// Right-hand panel: everything about one track.

import { h, fmtTime, fmtDb, fmtBytes, trackPosition, noteName, pad4 } from '../util.js';
import { state, update, selectedTrack, select, emit } from '../state.js';
import { getDecoded, getRendered, play, effectiveNorm } from '../audio.js';
import { buildFileName } from '../naming.js';
import { estimateBytes, estimatePeakDb } from '../validate.js';
import { field, select as sel, toggle, numberInput, slider, segmented, icon, badge, modal } from '../ui.js';
import { waveformEditor } from './waveform.js';
import * as A from '../actions.js';
import { midi, midiPlayTrack } from '../live.js';

let voice = null;          // current audition
let auditionLoop = false;
let auditionOriginal = false;

export function stopAudition() { if (voice) { voice.stop(); voice = null; emit('audition'); } }

export async function audition(track, { original = auditionOriginal, loop = auditionLoop } = {}) {
  stopAudition();
  if (!track?.sourceId) return;
  try {
    const chs = original ? (await getDecoded(track.sourceId)).channels : (await getRendered(track, state.project)).channels;
    voice = play(chs, { loop, onEnd: h0 => { if (voice === h0) { voice = null; emit('audition'); } } });
    voice.trackId = track.id;
    voice.original = original;
    emit('audition');
  } catch (e) {
    console.error(e);
  }
}

export function renderInspector() {
  const t = selectedTrack();
  const p = state.project;
  if (!t) {
    return h('div', { class: 'insp empty' },
      h('div', { class: 'empty-state' },
        h('h3', null, 'No track selected'),
        h('p', null, 'Click a pad or a row to edit it here. Drop audio files anywhere in the window to import them.'),
        h('ul', { class: 'plain muted' },
          h('li', null, h('kbd', null, 'Space'), ' audition selected'),
          h('li', null, h('kbd', null, '⌘Z'), ' / ', h('kbd', null, '⇧⌘Z'), ' undo / redo'),
          h('li', null, h('kbd', null, '←'), h('kbd', null, '→'), ' change bank (Pads)'),
          h('li', null, h('kbd', null, 'Del'), ' delete selected'))));
  }
  const pos = t.num != null ? trackPosition(t.num) : null;
  const e = t.edits;
  const mono = p.mode === 'mono';
  const commit = patch => update(pp => { Object.assign(pp.tracks.find(x => x.id === t.id).edits, patch); }, { reason: 'edit' });
  const setT = fn => update(pp => fn(pp.tracks.find(x => x.id === t.id)), { reason: 'edit' });
  const norm = effectiveNorm(t, p);
  const pk = estimatePeakDb(t, p);

  const waveHost = h('div', { class: 'wave-host' }, h('div', { class: 'wave-loading' }, t.sourceId ? 'Decoding…' : 'No audio'));
  if (t.sourceId) {
    getDecoded(t.sourceId).then(d => {
      if (!waveHost.isConnected) return;
      waveHost.replaceChildren(waveformEditor(t, d, {
        onCommit: commit,
        playhead: () => (voice && voice.trackId === t.id && !voice.stopped && !voice.original ? voice.position() : null),
      }));
    }).catch(err => waveHost.replaceChildren(h('div', { class: 'wave-loading error' }, err.message)));
  }

  const playing = voice && voice.trackId === t.id && !voice.stopped;
  return h('div', { class: 'insp' },
    h('div', { class: 'insp-head' },
      h('div', { class: 'insp-num' },
        h('span', { class: 'muted small' }, 'Track'),
        numberInput(t.num, v => A.setTrackNum(t.id, v == null ? null : Math.round(v)), { min: 1, max: 4096, width: '5.2em', placeholder: 'inbox' })),
      h('input', { class: 'insp-name', value: t.name, 'aria-label': 'Track name', onchange: ev => setT(x => { x.name = ev.target.value.trim() || 'untitled'; }) }),
      h('button', { class: 'icon-btn', title: 'Close', onclick: () => select(null) }, icon('x'))),
    h('div', { class: 'insp-pos' },
      pos ? [
        badge(`Bank ${pos.trigBank} · Trigger ${pos.trigger}`, 'pos'),
        badge(`MIDI bank ${pos.midiBank} · ${noteName(pos.note, p.ui.noteConvention)} (${pos.note})`, 'pos'),
      ] : badge('Inbox — not exported', 'warn')),
    waveHost,
    h('div', { class: 'transport' },
      h('button', { class: 'btn primary', onclick: () => (playing ? stopAudition() : audition(t)), title: 'Space' },
        icon(playing ? 'stop' : 'play'), playing ? 'Stop' : 'Play'),
      toggle('Loop', auditionLoop, v => { auditionLoop = v; if (playing) audition(t); }),
      toggle('Original', auditionOriginal, v => { auditionOriginal = v; if (playing) audition(t); }, { title: 'A/B: hear the source before processing' }),
      midi.output && t.num != null ? h('button', { class: 'btn', title: 'Play this track on the Nutella via MIDI', onclick: () => midiPlayTrack(t.num) }, 'On hardware') : null),
    h('div', { class: 'stats' },
      stat('Source', t.info ? `${t.info.origRate ? (t.info.origRate / 1000).toFixed(1) + ' kHz' : '?'} · ${t.info.channels === 1 ? 'mono' : t.info.channels === 2 ? 'stereo' : t.info.channels + ' ch'} · ${fmtTime(t.info.duration)}` : '—', t.sourceName),
      stat('Output', `44.1 kHz · 16-bit · ${mono ? 'mono' : 'stereo'} · ${fmtTime((e.trimEnd ?? t.info?.duration ?? 0) - (e.trimStart || 0))} · ${fmtBytes(estimateBytes(t, p))}`),
      stat('Peak', t.info ? `${fmtDb(t.info.peakDb)} → ${pk != null ? fmtDb(pk) : '—'}` : '—', pk != null && pk > 0.05 ? 'will clip' : null, pk != null && pk > 0.05 ? 'bad' : ''),
      t.info?.lastRender ? stat('Last export', `peak ${fmtDb(t.info.lastRender.peakDb)}${t.info.lastRender.clipped ? ` · ${t.info.lastRender.clipped} clipped samples` : ''}`) : null),

    section('Trim & fades',
      h('div', { class: 'row' },
        field('Start (s)', numberInput(round3(e.trimStart || 0), v => commit({ trimStart: v ?? 0 }), { min: 0, step: 0.001 })),
        field('End (s)', numberInput(e.trimEnd != null ? round3(e.trimEnd) : null, v => commit({ trimEnd: v }), { min: 0, step: 0.001, placeholder: 'end' })),
        h('button', { class: 'btn', onclick: () => A.autoTrim([t.id]), title: 'Trim silence below −50 dBFS at both ends' }, 'Auto-trim')),
      h('div', { class: 'row' },
        field('Fade in (ms)', numberInput(e.fadeIn, v => commit({ fadeIn: v ?? 0 }), { min: 0, max: 60000 })),
        field('Fade out (ms)', numberInput(e.fadeOut, v => commit({ fadeOut: v ?? 0 }), { min: 0, max: 60000 })),
        field('Curve', sel([['linear', 'Linear'], ['smooth', 'Smooth'], ['exp', 'Exponential']], e.fadeCurve, v => commit({ fadeCurve: v })))),
      toggle('Reverse', e.reverse, v => commit({ reverse: v }))),

    section('Level',
      field('Normalize', h('div', { class: 'row tight' },
        sel([['project', `Project default (${p.processing.norm === 'none' ? 'off' : p.processing.norm})`], ['none', 'Off'], ['peak', 'Peak'], ['rms', 'Loudness (RMS)']], e.norm, v => commit({ norm: v, normTarget: null })),
        norm.mode !== 'none' ? numberInput(e.normTarget ?? norm.target, v => commit({ normTarget: v }), { min: -40, max: 0, step: 0.5, width: '4.5em' }) : null,
        norm.mode !== 'none' ? h('span', { class: 'muted' }, norm.mode === 'rms' ? 'dB RMS' : 'dBFS') : null)),
      field('Gain', slider(e.gain, v => commit({ gain: v }), { min: -24, max: 24, step: 0.5, format: v => fmtDb(v) }), 'Applied after normalizing. Double-click to reset.')),

    section('Channels',
      !mono && t.info?.channels === 1 ? null : mono
        ? segmented([['auto', 'Sum L+R'], ['left', 'Left'], ['right', 'Right']], e.chan === 'sum' ? 'auto' : e.chan, v => commit({ chan: v }))
        : segmented([['auto', 'As is'], ['sum', 'Mono sum'], ['left', 'Left'], ['right', 'Right'], ['swap', 'Swap']], e.chan, v => commit({ chan: v })),
      !mono && t.info?.channels === 1 ? h('p', { class: 'small ch-conv' }, 'Mono source → written as stereo with the same signal on L and R.') : null,
      mono && t.info?.channels > 1 ? h('button', {
        class: 'btn', onclick: () => splitDialog(t),
        title: 'Keep stereo on the mono firmware: L and R on consecutive tracks, played in sync',
      }, 'Split to synced L/R pair…') : null),

    section('MIDI playback',
      h('p', { class: 'muted small' }, 'Only used when the track is started by a MIDI note. Encoded in the file name.'),
      h('div', { class: 'row' },
        segmented([[false, 'One-shot'], [true, 'Loop']], !!t.midi.loop, v => setT(x => { x.midi.loop = v === true || v === 'true'; })),
        field('Output', sel(Array.from({ length: mono ? 8 : 4 }, (_, i) => [i + 1, mono ? `Out ${i + 1}` : `Pair ${i + 1}`]), t.midi.out, v => setT(x => { x.midi.out = +v; }))))),

    section('File',
      h('code', { class: 'filename' }, t.num != null ? buildFileName(t, p.naming, p.mode) : '(assign a track number)'),
      field('Notes', h('textarea', { rows: 2, value: t.notes || '', onchange: ev => setT(x => { x.notes = ev.target.value; }) }))),

    h('div', { class: 'insp-actions' },
      h('button', { class: 'btn', onclick: () => A.duplicateTrack(t.id) }, 'Duplicate'),
      h('button', { class: 'btn', onclick: async () => { const [f] = await A.pickFiles({ multiple: false, accept: 'audio/*' }); if (f) A.replaceSource(t.id, f); } }, 'Replace audio…'),
      h('button', { class: 'btn', onclick: () => A.resetEdits([t.id]) }, 'Reset edits'),
      t.num != null ? h('button', { class: 'btn', onclick: () => A.moveToInbox([t.id]) }, 'To inbox') : null,
      h('button', { class: 'btn danger', onclick: () => A.deleteTracks([t.id]) }, icon('trash'), 'Delete')));
}

const round3 = v => Math.round(v * 1000) / 1000;

function stat(label, value, sub, cls = '') {
  return h('div', { class: 'stat ' + cls }, h('span', { class: 'stat-l' }, label), h('span', { class: 'stat-v' }, value), sub ? h('span', { class: 'stat-s' }, sub) : null);
}

function section(title, ...body) {
  return h('details', { class: 'sect', open: true }, h('summary', null, title), h('div', { class: 'sect-body' }, body));
}

async function splitDialog(t) {
  const free = state.project.triggers.filter(x => x.func === 1).map(x => x.num);
  let trig = free[free.length - 1] ?? 16;
  const v = await modal({
    title: 'Split stereo into a synced pair',
    body: h('div', null,
      h('p', null, `Track ${t.num != null ? pad4(t.num) : ''} becomes the left channel; the right channel goes on the next track number. A Synced Set trigger starts both sample-locked on outputs 1 and 2.`),
      field('Synced Set on trigger', sel([['', 'Don\'t create a trigger'], ...Array.from({ length: 16 }, (_, i) => [i + 1, `Trigger ${i + 1}`])], trig, x => { trig = x ? +x : null; }))),
    actions: [{ label: 'Cancel', value: false }, { label: 'Split', value: true, primary: true }],
  });
  if (v) A.splitStereo(t.id, trig);
}
