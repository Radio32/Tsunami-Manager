// Tracks: every track in the project as a sortable, filterable table with batch actions.

import { h, fmtTime, fmtDb, pad4, trackPosition, noteName } from '../util.js';
import { state, emit, select, update, trackByNum, nextFreeNum } from '../state.js';
import { issuesByTrack, estimatePeakDb } from '../validate.js';
import { effectiveNorm } from '../audio.js';
import { importFiles } from '../importer.js';
import * as A from '../actions.js';
import { audition } from './inspector.js';
import { dragSource } from './pads.js';
import { icon, modal, field, numberInput, select as sel, toggle, badge } from '../ui.js';

let lastClicked = null;

function filtered() {
  const p = state.project;
  const q = state.ui.filter.trim().toLowerCase();
  const issues = issuesByTrack(state.issues || []);
  let list = p.tracks.filter(t => {
    if (state.ui.trackFilter === 'assigned' && t.num == null) return false;
    if (state.ui.trackFilter === 'inbox' && t.num != null) return false;
    if (state.ui.trackFilter === 'issues' && !issues.has(t.id)) return false;
    if (state.ui.trackFilter === 'mono' && t.info?.channels !== 1) return false;
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || (t.sourceName || '').toLowerCase().includes(q) ||
      (t.notes || '').toLowerCase().includes(q) || String(t.num) === q;
  });
  const sort = state.ui.trackSort || 'num';
  const cmp = {
    num: (a, b) => (a.num ?? 1e9) - (b.num ?? 1e9),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    dur: (a, b) => (b.info?.duration || 0) - (a.info?.duration || 0),
    peak: (a, b) => (b.info?.peakDb ?? -99) - (a.info?.peakDb ?? -99),
  }[sort];
  return { list: list.sort(cmp), issues };
}

function rowClick(e, t, list) {
  const multi = state.ui.multi;
  if (e.shiftKey && lastClicked) {
    const a = list.findIndex(x => x.id === lastClicked), b = list.findIndex(x => x.id === t.id);
    if (a >= 0 && b >= 0) {
      const [s, en] = a < b ? [a, b] : [b, a];
      for (let i = s; i <= en; i++) multi.add(list[i].id);
      state.ui.selectedId = t.id;
      emit('select');
      return;
    }
  }
  if (e.metaKey || e.ctrlKey) select(t.id, { additive: true });
  else select(t.id);
  lastClicked = t.id;
}

async function numberFromDialog(ids) {
  let start = nextFreeNum(1, trackByNum()) || 1, contiguous = false;
  const ok = await modal({
    title: `Number ${ids.length} track${ids.length === 1 ? '' : 's'}`,
    body: h('div', null,
      h('p', null, 'Tracks are numbered in the order shown in the table.'),
      field('Start at track', numberInput(start, v => { start = v || 1; }, { min: 1, max: 4096 }),
        'Bank b, trigger n = b × 16 + n. Slots on control triggers (your Bank −/+ on 15/16) are skipped unless Contiguous is on.'),
      toggle('Contiguous — move other tracks out of the way (to the Inbox)', contiguous, v => { contiguous = v; })),
    actions: [{ label: 'Cancel', value: false }, { label: 'Number', value: true, primary: true }],
  });
  if (ok) A.autoNumber(ids, start, { contiguous });
}

async function syncedSetDialog(ids) {
  let trig = 1, start = nextFreeNum(1, trackByNum()) || 1;
  const ok = await modal({
    title: 'Make a synced set',
    body: h('div', null,
      h('p', null, `The ${ids.length} selected tracks get consecutive numbers and one trigger starts them all sample-locked, each on its own output (1…${ids.length}). This needs the mono firmware — the project will switch to mono.`),
      field('Trigger', sel(Array.from({ length: 16 }, (_, i) => [i + 1, `Trigger ${i + 1}`]), trig, v => { trig = +v; })),
      field('First track number', numberInput(start, v => { start = v || 1; }, { min: 1, max: 4089 }))),
    actions: [{ label: 'Cancel', value: false }, { label: 'Create', value: true, primary: true }],
  });
  if (ok) A.makeSyncedSet(ids, trig, start);
}

async function gainDialog(ids) {
  let g = 0;
  const ok = await modal({
    title: 'Set gain', body: field('Gain (dB) after normalizing', numberInput(0, v => { g = v || 0; }, { min: -24, max: 24, step: 0.5 })),
    actions: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }],
  });
  if (ok) A.patchEdits(ids, { gain: g });
}

async function panDialog(ids) {
  let v = 0;
  const ok = await modal({
    title: 'Set pan', body: field('Pan (−100 = left, 100 = right), written into the WAV', numberInput(0, x => { v = Math.max(-100, Math.min(100, Math.round(x || 0))); }, { min: -100, max: 100, step: 5 })),
    actions: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }],
  });
  if (ok) A.patchEdits(ids, { pan: v });
}

function batchBar(ids) {
  const mono = state.project.mode === 'mono';
  return h('div', { class: 'batch' },
    h('strong', null, `${ids.length} selected`),
    h('button', { class: 'btn tiny', onclick: () => numberFromDialog(ids) }, 'Number from…'),
    sel([['', 'Normalize…'], ['project', 'Project default'], ['peak', 'Peak'], ['rms', 'Loudness (RMS)'], ['none', 'Off']], '', v => v && A.patchEdits(ids, { norm: v, normTarget: null }), { class: 'tiny' }),
    h('button', { class: 'btn tiny', onclick: () => gainDialog(ids) }, 'Gain…'),
    mono ? null : h('button', { class: 'btn tiny', onclick: () => panDialog(ids) }, 'Pan…'),
    sel([['', 'Channels…'], ...(mono ? [['auto', 'Sum L+R'], ['left', 'Left'], ['right', 'Right']] : [['auto', 'As is'], ['sum', 'Mono sum'], ['left', 'Left'], ['right', 'Right']])], '', v => v && A.patchEdits(ids, { chan: v }), { class: 'tiny' }),
    sel([['', 'MIDI…'], ['S', 'One-shot'], ['L', 'Loop'], ...Array.from({ length: mono ? 8 : 4 }, (_, i) => [`o${i + 1}`, `Output ${i + 1}`])], '',
      v => v && A.patchTracks(ids, t => { if (v === 'S') t.midi.loop = false; else if (v === 'L') t.midi.loop = true; else t.midi.out = +v.slice(1); }), { class: 'tiny' }),
    h('button', { class: 'btn tiny', onclick: () => A.autoTrim(ids) }, 'Auto-trim'),
    h('button', { class: 'btn tiny', onclick: () => syncedSetDialog(ids), disabled: ids.length > 8 }, 'Synced set…'),
    h('button', { class: 'btn tiny', onclick: () => A.resetEdits(ids) }, 'Reset edits'),
    h('button', { class: 'btn tiny', onclick: () => A.moveToInbox(ids) }, 'To inbox'),
    h('button', { class: 'btn tiny danger', onclick: () => A.deleteTracks(ids) }, 'Delete'),
    h('button', { class: 'btn tiny', onclick: () => { state.ui.multi.clear(); emit('select'); } }, 'Clear'));
}

export function renderTracks() {
  const p = state.project;
  const { list, issues } = filtered();
  const multi = state.ui.multi;
  const ids = [...multi].filter(id => p.tracks.some(t => t.id === id));
  const allOn = list.length > 0 && list.every(t => multi.has(t.id));
  const counts = { all: p.tracks.length, assigned: p.tracks.filter(t => t.num != null).length, inbox: p.tracks.filter(t => t.num == null).length, issues: issues.size, mono: p.tracks.filter(t => t.info?.channels === 1).length };

  const toolbar = h('div', { class: 'toolbar' },
    h('input', { class: 'search', type: 'search', 'data-fk': 'track-search', placeholder: 'Search name, file, notes or number…', value: state.ui.filter, oninput: e => { state.ui.filter = e.target.value; emit('filter'); } }),
    h('div', { class: 'seg' }, ['all', 'assigned', 'inbox', 'issues', 'mono'].map(k => h('button', {
      class: state.ui.trackFilter === k ? 'on' : '', onclick: () => { state.ui.trackFilter = k; emit('filter'); },
    }, `${k[0].toUpperCase() + k.slice(1)} ${counts[k]}`))),
    sel([['num', 'Sort: number'], ['name', 'Sort: name'], ['dur', 'Sort: length'], ['peak', 'Sort: source peak']], state.ui.trackSort || 'num', v => { state.ui.trackSort = v; emit('filter'); }),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: async () => importFiles(await A.pickFiles(), { useNames: true }) }, icon('plus'), 'Import (use numbers in names)'),
    h('button', { class: 'btn', onclick: async () => importFiles(await A.pickFiles()) }, icon('plus'), 'Import to inbox'));

  if (!p.tracks.length) {
    return h('div', { class: 'view' }, toolbar, h('div', { class: 'empty-state big' },
      h('h3', null, 'No tracks yet'),
      h('p', null, 'Drop audio files (WAV, AIFF, FLAC, MP3, OGG, M4A…) anywhere in this window. Files whose names start with a number keep that number when you use “Import (use numbers in names)”.')));
  }

  const head = h('tr', null,
    h('th', { class: 'c-check' }, h('input', { type: 'checkbox', checked: allOn, onchange: e => { list.forEach(t => (e.target.checked ? multi.add(t.id) : multi.delete(t.id))); emit('select'); } })),
    h('th', { class: 'c-num' }, '#'), h('th', null, 'Bank · Trig'), h('th', null, 'MIDI'),
    h('th', null, 'Name'), h('th', null, 'Source'), h('th', { class: 'r' }, 'Length'), h('th', null, 'Ch'),
    h('th', { class: 'r' }, 'Peak in → out'), h('th', null, 'MIDI file flag'), h('th', null, ''));

  const rows = list.map(t => {
    const pos = t.num != null ? trackPosition(t.num) : null;
    const pk = estimatePeakDb(t, p);
    const sev = issues.get(t.id);
    const n = effectiveNorm(t, p);
    const tr = h('tr', {
      class: (state.ui.selectedId === t.id ? 'sel ' : '') + (multi.has(t.id) ? 'multi ' : '') + (t.num == null ? 'inbox' : ''),
      onclick: e => { if (e.target.closest('input,button,select')) return; rowClick(e, t, list); },
      ondblclick: e => { if (!e.target.closest('input')) audition(t); },
    },
      h('td', { class: 'c-check' }, h('input', { type: 'checkbox', checked: multi.has(t.id), onchange: () => select(t.id, { additive: true }) })),
      h('td', { class: 'c-num mono' }, t.num != null ? pad4(t.num) : h('span', { class: 'muted' }, 'inbox')),
      h('td', { class: 'mono muted' }, pos ? `B${pos.trigBank} · T${pos.trigger}` : ''),
      h('td', { class: 'mono muted' }, pos ? `${pos.midiBank}:${noteName(pos.note, p.ui.noteConvention)}` : ''),
      h('td', { class: 'c-name' }, h('input', { class: 'cell-input', value: t.name, onchange: e => update(pp => { pp.tracks.find(x => x.id === t.id).name = e.target.value.trim() || 'untitled'; }) })),
      h('td', { class: 'c-src muted', title: t.sourceName }, t.sourceName),
      h('td', { class: 'r mono' }, fmtTime((t.edits.trimEnd ?? t.info?.duration ?? 0) - (t.edits.trimStart || 0))),
      h('td', null, !t.info ? '—' : t.info.channels === 1 ? (p.mode === 'stereo' ? h('span', { class: 'ch-conv', title: 'Mono source, converted to stereo on export' }, 'M→S') : 'M') : t.info.channels === 2 ? (p.mode === 'mono' ? h('span', { class: 'ch-conv', title: 'Stereo source, summed to mono on export' }, 'S→M') : 'S') : t.info.channels),
      h('td', { class: 'r mono' + (pk != null && pk > 0.05 ? ' bad' : '') }, t.info ? `${fmtDb(t.info.peakDb)} → ${pk != null ? fmtDb(pk) : '—'}` : '—',
        n.mode !== 'none' ? h('span', { class: 'muted small' }, ` ${n.mode}`) : null),
      h('td', { class: 'mono' }, t.midi.loop || t.midi.out !== 1 ? badge(`${t.midi.loop ? 'L' : 'S'}${t.midi.out}`, t.midi.loop ? 'loop' : 'out') : h('span', { class: 'muted' }, '—')),
      h('td', null, sev ? h('span', { class: 'sev-dot ' + sev, title: (state.issues || []).filter(i => i.trackId === t.id).map(i => i.msg).join('\n') }, icon('warn')) : null));
    dragSource(tr, t.id);
    return tr;
  });

  return h('div', { class: 'view tracks-view' },
    toolbar,
    ids.length ? batchBar(ids) : null,
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' }, h('thead', null, head), h('tbody', null, rows))),
    h('p', { class: 'muted small foot-hint' }, 'Click to select · ⇧-click for a range · ⌘-click to add · double-click to audition · drag a row onto a pad to place it.'));
}
