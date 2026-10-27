// Pads: the 16 Nutella trigger inputs × 256 trigger banks.

import { h, fmtTime, pad4, clamp } from '../util.js';
import { state, emit, trackByNum, select, update } from '../state.js';
import { FUNC_BY_CODE, TRIGGER_BANKS } from '../constants.js';
import { thumb } from './waveform.js';
import { importFiles, importToPad, droppedFiles } from '../importer.js';
import { slotFor } from '../kit.js';
import { cycleTriggerOutput, outputLabel } from './outputs.js';
import { audition, stopAudition, fmtPan } from './inspector.js';
import { setTrackNum, pickFiles } from '../actions.js';
import { sim, press, release, activeTracks, stopAllSim, setSimBank } from '../sim.js';
import { segmented, toggle, icon, badge } from '../ui.js';
import { issuesByTrack } from '../validate.js';
import { midi, midiPlayTrack } from '../live.js';
import { loadDemo } from '../demo.js';

export const PERFORM_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i'];

export function setBank(b) {
  state.ui.padBank = clamp(b, 0, TRIGGER_BANKS - 1);
  setSimBank(state.ui.padBank);
  emit('bank');
}

const DND_TYPE = 'application/x-ntm-track';

function dropTarget(el, num) {
  el.addEventListener('dragover', e => {
    if ([...e.dataTransfer.types].some(t => t === 'Files' || t === DND_TYPE)) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('drop');
    const id = e.dataTransfer.getData(DND_TYPE);
    if (id) setTrackNum(id, num);
    else if (e.dataTransfer.files.length) droppedFiles(e.dataTransfer).then(files => importToPad(files, num));
  });
}

// Manual double-click detection: the first click re-renders the grid, which would
// swallow the browser's own dblclick event.
let lastPadClick = { key: null, at: 0 };
function isDoubleClick(key) {
  const now = performance.now();
  const dbl = lastPadClick.key === key && now - lastPadClick.at < 380;
  lastPadClick = dbl ? { key: null, at: 0 } : { key, at: now };
  return dbl;
}

async function browseForPad(num) {
  stopAudition();
  const files = await pickFiles({ multiple: true, accept: 'audio/*,.wav,.aif,.aiff,.flac,.mp3,.ogg,.m4a' });
  if (files.length) importToPad(files, num);
}

function outButton(n, trig) {
  return h('button', {
    class: 'pad-out', title: `Trigger ${n} plays on ${outputLabel(trig.output)} — click for the next output`,
    onclick: e => { e.stopPropagation(); cycleTriggerOutput(n); },
    onpointerdown: e => e.stopPropagation(),
  }, `→${outputLabel(trig.output, true)}`);
}

export function dragSource(el, id) {
  el.draggable = true;
  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData(DND_TYPE, id);
    e.dataTransfer.effectAllowed = 'move';
  });
}

function padEl(n, tracks, issues, layout) {
  const p = state.project;
  const trig = p.triggers[n - 1];
  const f = FUNC_BY_CODE[trig.func];
  const bank = state.ui.padBank;
  const num = bank * 16 + n;
  const t = trig.func === 1 ? tracks.get(num) : null;
  const active = activeTracks();
  const fl = sim.flash[n];
  const flashing = fl && performance.now() - fl.at < 160;
  const slot = slotFor(n);
  const classes = ['pad'];
  if (slot) classes.push('kit');
  if (trig.func !== 1) classes.push('func');
  else if (!t) classes.push('empty');
  if (t && state.ui.selectedId === t.id) classes.push('selected');
  if (t && active.has(t.num)) classes.push('active');
  if (trig.func !== 1 && sim.voices.some(v => v.trig === n)) classes.push('active');
  if (flashing) classes.push('flash-' + fl.kind);
  const sev = t && issues.get(t.id);
  if (sev) classes.push('sev-' + sev);

  const typeBadge = trig.type === 1 ? badge('GATE', 'type') : trig.type === 2 ? badge('LATCH', 'type') : null;
  const el = h('div', {
    class: classes.join(' '), role: 'button', tabindex: 0, 'data-trig': n,
    'aria-label': `Trigger ${n}${t ? ', ' + t.name : ''}`,
    title: trig.func === 1
      ? `Trigger ${n} · track ${num}${slot ? ` · ${slot.label} slot` : ''}${t ? ' · ' + t.name : ''}\nClick: audition · Double-click: browse for samples · Drop files here${slot ? ' (several files = smart kit placement on pads 1–8)' : ''}`
      : `Trigger ${n}: ${f.label}. ${f.help}`,
  },
    h('div', { class: 'pad-top' },
      h('span', { class: 'pad-trig' }, `${n}`, h('small', null, state.ui.perform ? PERFORM_KEYS[n - 1].toUpperCase() : '')),
      trig.func === 1 ? h('span', { class: 'pad-tnum' }, pad4(num)) : null,
      slot && trig.func === 1 ? h('span', { class: 'pad-slot' }, slot.short) : null,
      h('span', { class: 'pad-badges' },
        typeBadge,
        trig.loop ? badge('LOOP', 'loop') : null,
        !trig.poly && f.plays ? badge('SOLO', 'type') : null,
        trig.gain ? badge(`${trig.gain > 0 ? '+' : ''}${trig.gain}dB`, 'out') : null)),
    trig.func !== 1
      ? h('div', { class: 'pad-func' },
        h('div', { class: 'pad-func-name' }, f.short),
        f.range ? h('div', { class: 'pad-func-range' }, `${trig.low}–${trig.high}`, h('span', null, ` · ${countRange(tracks, trig)} tracks`)) : null)
      : t
        ? [h('div', { class: 'pad-name' }, t.name), thumb(t, layout === '2x8' ? 110 : 150, 26),
          h('div', { class: 'pad-foot' },
            h('span', null, fmtTime((t.edits.trimEnd ?? t.info?.duration ?? 0) - (t.edits.trimStart || 0))),
            p.mode === 'stereo' && t.edits.pan ? h('span', { class: 'pad-pan', title: 'Pan' }, fmtPan(t.edits.pan)) : null,
            sev ? h('span', { class: 'sev-dot ' + sev }, icon('warn')) : null,
            state.ui.perform ? null : outButton(n, trig))]
        : [h('div', { class: 'pad-empty' }, slot ? h('strong', null, slot.label) : null, h('span', null, 'drop or double-click')),
          state.ui.perform ? null : h('div', { class: 'pad-foot' }, h('span'), outButton(n, trig))]);

  if (state.ui.perform) {
    el.addEventListener('pointerdown', e => { e.preventDefault(); el.setPointerCapture(e.pointerId); press(n); });
    el.addEventListener('pointerup', () => release(n));
  } else {
    el.addEventListener('click', () => {
      if (trig.func !== 1) { state.ui.triggerFocus = n; state.ui.view = 'triggers'; emit('view'); return; }
      if (isDoubleClick(num)) { browseForPad(num); return; }
      if (!t) return;
      select(t.id);
      if (midi.output && midi.followSelection) midiPlayTrack(t.num);
      else audition(t);
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' && t) audition(t); });
    if (t) dragSource(el, t.id);
    if (trig.func === 1) dropTarget(el, num);
  }
  return el;
}

function countRange(tracks, t) {
  let c = 0;
  for (let k = t.low; k <= t.high; k++) if (tracks.has(k)) c++;
  return c;
}

function bankMap(tracks) {
  const counts = new Array(TRIGGER_BANKS).fill(0);
  for (const n of tracks.keys()) counts[Math.floor((n - 1) / 16)]++;
  const grid = h('div', { class: 'bankmap', role: 'grid', 'aria-label': 'Trigger bank overview' });
  for (let b = 0; b < TRIGGER_BANKS; b++) {
    const c = counts[b];
    grid.appendChild(h('button', {
      class: 'bm' + (b === state.ui.padBank ? ' on' : '') + (c ? ' used' : ''),
      style: c ? { '--fill': (0.25 + 0.75 * c / 16).toFixed(2) } : null,
      title: `Bank ${b}: tracks ${b * 16 + 1}–${b * 16 + 16}${c ? ` · ${c} used` : ''}`,
      onclick: () => setBank(b),
    }));
  }
  return { grid, counts };
}

function inboxStrip() {
  const inbox = state.project.tracks.filter(t => t.num == null);
  return h('div', { class: 'inbox-strip' },
    h('div', { class: 'inbox-head' },
      h('strong', null, 'Inbox'), h('span', { class: 'muted' }, inbox.length ? ` ${inbox.length} unnumbered — drag onto a pad` : ' empty'),
      h('button', { class: 'btn tiny', onclick: async () => importFiles(await pickFiles()) }, icon('plus'), 'Import files')),
    inbox.length ? h('div', { class: 'chips' }, inbox.slice(0, 200).map(t => {
      const c = h('button', { class: 'chip' + (state.ui.selectedId === t.id ? ' on' : ''), onclick: () => select(t.id), ondblclick: () => audition(t) }, t.name);
      dragSource(c, t.id);
      return c;
    })) : null);
}

function lanesView(tracks, counts) {
  const p = state.project;
  const last = counts.reduce((m, c, i) => (c ? i : m), 0);
  const nBanks = Math.max(8, last + 2);
  const table = h('table', { class: 'lanes' });
  table.appendChild(h('thead', null, h('tr', null, h('th', null, 'Trig'),
    Array.from({ length: nBanks }, (_, b) => h('th', { class: b === state.ui.padBank ? 'on' : '' },
      h('button', { class: 'linkish', onclick: () => { setBank(b); state.ui.padsMode = 'pads'; emit('view'); } }, `B${b}`))))));
  const body = h('tbody');
  for (let n = 1; n <= 16; n++) {
    const trig = p.triggers[n - 1];
    const row = h('tr', null, h('th', null, n));
    for (let b = 0; b < nBanks; b++) {
      const num = b * 16 + n;
      const t = tracks.get(num);
      const td = h('td', {
        class: (t ? 'has' : '') + (t && state.ui.selectedId === t.id ? ' on' : '') + (trig.func !== 1 ? ' dim' : ''),
        title: `Track ${num}${t ? ': ' + t.name : ''}${trig.func !== 1 ? ` — trigger ${n} is set to ${FUNC_BY_CODE[trig.func].label}` : ''}`,
        onclick: () => t && select(t.id),
        ondblclick: () => t && audition(t),
      }, t ? t.name : h('span', { class: 'muted' }, pad4(num)));
      if (t) dragSource(td, t.id);
      dropTarget(td, num);
      row.appendChild(td);
    }
    body.appendChild(row);
  }
  table.appendChild(body);
  return h('div', { class: 'lanes-wrap' },
    h('p', { class: 'muted small' }, 'Each row is one trigger input across banks — keep the same kind of sound in a row (kick on 1, snare on 2…) and Bank Up/Down switches whole kits.'),
    table);
}

export function renderPads() {
  const p = state.project;
  const tracks = trackByNum();
  const issues = issuesByTrack(state.issues || []);
  const layout = p.ui.padLayout || '4x4';
  const { grid, counts } = bankMap(tracks);
  const bank = state.ui.padBank;
  const mode = state.ui.padsMode || 'pads';

  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'bank-nav' },
      h('button', { class: 'icon-btn', title: 'Previous bank (←)', onclick: () => setBank(bank - 1), disabled: bank === 0 }, icon('chevl')),
      h('div', { class: 'bank-label' },
        h('span', { class: 'muted small' }, 'Trigger bank'),
        h('input', { class: 'num bank-input', type: 'number', min: 0, max: 255, value: bank, onchange: e => setBank(+e.target.value || 0) })),
      h('button', { class: 'icon-btn', title: 'Next bank (→)', onclick: () => setBank(bank + 1), disabled: bank === 255 }, icon('chev')),
      h('span', { class: 'muted' }, `tracks ${bank * 16 + 1}–${bank * 16 + 16}`)),
    h('div', { class: 'spacer' }),
    segmented([['pads', 'Pads'], ['lanes', 'Lanes']], mode, v => { state.ui.padsMode = v; emit('view'); }),
    mode === 'pads' ? segmented([['4x4', '4×4'], ['2x8', '2×8']], layout, v => update(pp => { pp.ui.padLayout = v; }, { undo: false })) : null,
    toggle('Perform', state.ui.perform, v => { state.ui.perform = v; setSimBank(bank); emit('view'); }, { title: 'Play the pads like the hardware: trigger functions, banks, gates, round-robin' }),
    state.ui.perform ? h('button', { class: 'btn', onclick: () => { stopAllSim(); emit('sim'); } }, icon('stop'), 'Stop all') : null);

  const perfInfo = state.ui.perform ? h('div', { class: 'perf-info' },
    h('span', null, `Voices ${sim.voices.length}`),
    h('span', null, `Bank ${sim.bank}`),
    h('span', null, `MIDI bank ${sim.midiBank}`),
    h('span', { class: 'muted' }, 'Keys 1–8 and Q–I play triggers 1–16 · Space stops all · hold for Gate triggers')) : null;

  const welcome = p.tracks.length ? null : h('div', { class: 'welcome' },
    h('div', null,
      h('h2', null, 'Build a Tsunami card'),
      h('p', null, 'Drop audio files on a pad (or anywhere), open an existing SD card in the Card doctor, or start from a demo kit. Every file is converted to 44.1 kHz 16-bit ', p.mode, ' WAV with a clean header when you export.')),
    h('div', { class: 'welcome-actions' },
      h('button', { class: 'btn primary', onclick: async () => importFiles(await pickFiles(), { useNames: true }) }, icon('plus'), 'Import audio…'),
      h('button', { class: 'btn', onclick: () => { state.ui.view = 'card'; emit('view'); } }, icon('card'), 'Open SD card…'),
      h('button', { class: 'btn', onclick: loadDemo }, 'Load demo kits')));

  return h('div', { class: 'view pads-view' },
    welcome,
    toolbar,
    perfInfo,
    h('div', { class: 'pads-main' },
      mode === 'pads'
        ? h('div', { class: `pad-grid l${layout}` }, Array.from({ length: 16 }, (_, i) => padEl(i + 1, tracks, issues, layout)))
        : lanesView(tracks, counts),
      h('aside', { class: 'bank-side' },
        h('div', { class: 'side-title' }, 'Bank map', h('span', { class: 'muted small' }, ` ${counts.filter(Boolean).length} of 256 in use`)),
        grid,
        h('p', { class: 'muted small' }, 'Each cell is one bank of 16 tracks; brighter = more pads filled.'))),
    inboxStrip());
}

// Light-weight update for Perform mode: toggles classes on existing pads instead of
// re-rendering (which would break pointer capture while a Gate pad is held).
export function refreshPadActivity() {
  const active = activeTracks();
  const now = performance.now();
  for (const el of document.querySelectorAll('.pad[data-trig]')) {
    const n = +el.dataset.trig;
    const trig = state.project.triggers[n - 1];
    const on = (trig.func === 1 && active.has(state.ui.padBank * 16 + n)) || sim.voices.some(v => v.trig === n);
    el.classList.toggle('active', on);
    const fl = sim.flash[n];
    if (fl && now - fl.at < 50) {
      el.classList.remove('flash-hit', 'flash-empty', 'flash-busy', 'flash-stop');
      void el.offsetWidth;
      el.classList.add('flash-' + fl.kind);
    }
  }
  const pi = document.querySelector('.perf-info span');
  if (pi) pi.textContent = `Voices ${sim.voices.length}`;
}

export function padsKeydown(e) {
  if (state.ui.view !== 'pads') return false;
  if (state.ui.perform) {
    const i = PERFORM_KEYS.indexOf(e.key.toLowerCase());
    if (i >= 0 && !e.repeat && !e.metaKey && !e.ctrlKey) { press(i + 1); return true; }
    if (e.key === ' ') { stopAllSim(); emit('sim'); return true; }
  }
  if (e.key === 'ArrowLeft') { setBank(state.ui.padBank - 1); return true; }
  if (e.key === 'ArrowRight') { setBank(state.ui.padBank + 1); return true; }
  return false;
}

export function padsKeyup(e) {
  if (state.ui.view !== 'pads' || !state.ui.perform) return;
  const i = PERFORM_KEYS.indexOf(e.key.toLowerCase());
  if (i >= 0) release(i + 1);
}

