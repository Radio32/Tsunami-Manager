// App shell: layout, routing, render scheduling, shortcuts, global drag & drop.

import { h, $, fmtBytes } from './util.js';
import { state, subscribe, boot, setView, undo, redo, canUndo, canRedo, getSaveState, update, selectedTrack, emit } from './state.js';
import { validateProject, estimateBytes } from './validate.js';
import { BOARDS } from './constants.js';
import { importFiles, droppedFiles } from './importer.js';
import { requestPersistence } from './store.js';
import { icon, segmented, toast } from './ui.js';
import { deleteTracks } from './actions.js';
import { renderPads, padsKeydown, padsKeyup, refreshPadActivity } from './views/pads.js';
import { renderTracks } from './views/tracks.js';
import { renderMidiMap } from './views/midimap.js';
import { renderTriggers } from './views/triggers.js';
import { renderSettings } from './views/settings.js';
import { renderCard } from './views/card.js';
import { renderExport } from './views/exportview.js';
import { renderLive } from './views/liveview.js';
import { renderInspector, audition, stopAudition } from './views/inspector.js';
import { renderGlobal, toggleGlobal } from './views/global.js';
import { stopAll } from './audio.js';
import { sim, stopAllSim } from './sim.js';

const VIEWS = [
  { key: 'pads', label: 'Pads', icon: 'pads', render: renderPads, help: '16 triggers × banks' },
  { key: 'tracks', label: 'Tracks', icon: 'tracks', render: renderTracks, help: 'All tracks, batch edits' },
  { key: 'midi', label: 'MIDI map', icon: 'midi', render: renderMidiMap, help: 'Notes × MIDI banks' },
  { key: 'triggers', label: 'Triggers', icon: 'triggers', render: renderTriggers, help: 'Functions & tsunami.ini' },
  { key: 'settings', label: 'Settings', icon: 'settings', render: renderSettings, help: 'Firmware, outputs, MIDI' },
  { key: 'card', label: 'Card doctor', icon: 'card', render: renderCard, help: 'Inspect & repair a card' },
  { key: 'live', label: 'Live', icon: 'live', render: renderLive, help: 'MIDI / serial to hardware' },
  { key: 'export', label: 'Export', icon: 'export', render: renderExport, help: 'Preflight & write card' },
];

// ---------- render scheduling ----------

const dirty = { header: true, nav: true, main: true, insp: true, global: true };
let scheduled = false, pointerDown = false, renderedBank = null;

function schedule(parts) {
  for (const k of parts) dirty[k] = true;
  if (scheduled || pointerDown) return;
  scheduled = true;
  requestAnimationFrame(flush);
}

const PROJECT_CHANGES = new Set(['update', 'import', 'renumber', 'inbox', 'delete', 'duplicate', 'edit', 'replace', 'split', 'synced', 'trigger', 'settings', 'ini', 'undo', 'load', 'render']);

subscribe(reason => {
  if (PROJECT_CHANGES.has(reason)) { state.issues = validateProject(state.project); schedule(['header', 'nav', 'main', 'insp', 'global']); return; }
  switch (reason) {
    case 'save': schedule(['header']); break;
    case 'global': schedule(['header', 'global']); break;
    case 'audition': schedule(['insp']); break;
    case 'sim':
      if (state.ui.view === 'pads') {
        refreshPadActivity();
        if (sim.bank !== renderedBank && state.ui.perform) { state.ui.padBank = sim.bank; schedule(['main']); }
      }
      break;
    case 'live': if (['live', 'triggers', 'midi', 'pads'].includes(state.ui.view)) schedule(['main']); schedule(['insp']); break;
    case 'log': case 'card': case 'filter': case 'bank': schedule(['main']); break;
    case 'select': schedule(['main', 'insp']); break;
    case 'view': schedule(['nav', 'main', 'insp']); break;
    default: schedule(['header', 'nav', 'main', 'insp']);
  }
});

function captureFocus() {
  const a = document.activeElement;
  if (!a || !a.dataset?.fk) return null;
  return { fk: a.dataset.fk, s: a.selectionStart, e: a.selectionEnd };
}
function restoreFocus(f) {
  if (!f) return;
  const el = document.querySelector(`[data-fk="${f.fk}"]`);
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(f.s, f.e); } catch { /* not a text input */ }
}

function flush() {
  scheduled = false;
  const focus = captureFocus();
  if (dirty.header) { $('#header').replaceChildren(renderHeader()); dirty.header = false; }
  if (dirty.nav) { $('#nav').replaceChildren(renderNav()); dirty.nav = false; }
  if (dirty.main) {
    const v = VIEWS.find(x => x.key === state.ui.view) || VIEWS[0];
    const main = $('#main');
    const scroll = main.firstElementChild?.dataset.view === v.key ? main.scrollTop : 0;
    let el;
    try { el = v.render(); } catch (e) { console.error(e); el = h('div', { class: 'view' }, h('p', { class: 'warn' }, 'This view failed to render: ' + e.message)); }
    el.dataset.view = v.key;
    main.replaceChildren(el);
    main.scrollTop = scroll;
    renderedBank = state.ui.padBank;
    dirty.main = false;
  }
  if (dirty.insp) {
    const insp = $('#inspector');
    const scroll = insp.scrollTop;
    const sameTrack = insp.dataset.track === String(state.ui.selectedId);
    insp.replaceChildren(renderInspector());
    insp.dataset.track = String(state.ui.selectedId);
    insp.scrollTop = sameTrack ? scroll : 0;
    document.body.classList.toggle('has-selection', !!state.ui.selectedId && ['pads', 'tracks', 'midi'].includes(state.ui.view));
    dirty.insp = false;
  }
  if (dirty.global) {
    const g = $('#global');
    const scroll = g.querySelector('.gdrawer-body')?.scrollTop || 0;
    const el = renderGlobal();
    g.replaceChildren(...(el ? [el] : []));
    const body = g.querySelector('.gdrawer-body');
    if (body) body.scrollTop = scroll;
    dirty.global = false;
  }
  restoreFocus(focus);
}

// Re-rendering between mousedown and click would swallow the click; wait for pointerup.
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
const release = () => {
  if (!pointerDown) return;
  pointerDown = false;
  setTimeout(() => { if (Object.values(dirty).some(Boolean) && !scheduled) { scheduled = true; requestAnimationFrame(flush); } }, 0);
};
document.addEventListener('pointerup', release, true);
document.addEventListener('pointercancel', release, true);

// ---------- chrome ----------

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'parchment' ? 'night' : 'parchment';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('ntm-theme', next); } catch { /* private mode */ }
  emit('theme'); // canvases read colours at draw time
}

function renderHeader() {
  const p = state.project;
  const issues = state.issues || [];
  const errors = issues.filter(i => i.sev === 'error').length, warns = issues.filter(i => i.sev === 'warn').length;
  const numbered = p.tracks.filter(t => t.num != null);
  const bytes = numbered.reduce((s, t) => s + estimateBytes(t, p), 0);
  const save = getSaveState();
  return h('frag', null,
    h('div', { class: 'brand' },
      h('div', { class: 'logo', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span')),
      h('div', null, h('div', { class: 'brand-name' }, 'Nutella Tsunami'), h('div', { class: 'brand-sub' }, 'card manager'))),
    h('input', { class: 'proj-name', value: p.name, 'aria-label': 'Project name', onchange: e => update(pp => { pp.name = e.target.value.trim() || 'Untitled project'; }) }),
    segmented([['stereo', 'Stereo'], ['mono', 'Mono']], p.mode, v => update(pp => { pp.mode = v; }, { reason: 'settings' }), { class: 'mode-seg' }),
    h('span', { class: 'chip-info', title: BOARDS[p.board].label }, `${BOARDS[p.board][p.mode]} voices`),
    h('span', { class: 'chip-info' }, `${numbered.length} tracks · ${fmtBytes(bytes)}`),
    h('button', {
      class: 'chip-issues ' + (errors ? 'bad' : warns ? 'warn' : 'ok'), onclick: () => setView('export'),
      title: 'Open the preflight report',
    }, errors ? `${errors} error${errors > 1 ? 's' : ''}` : warns ? `${warns} warning${warns > 1 ? 's' : ''}` : numbered.length ? 'Tsunami-safe' : 'No tracks yet'),
    h('div', { class: 'spacer' }),
    h('span', { class: 'save-state ' + save }, save === 'saved' ? 'Saved' : save === 'error' ? 'Save failed' : 'Saving…'),
    h('button', { class: 'btn global-btn' + (state.ui.globalOpen ? ' on' : ''), title: 'Global settings: firmware, outputs, debounce, MIDI, processing (G)', onclick: () => toggleGlobal() }, icon('settings'), 'Global'),
    h('button', { class: 'icon-btn', title: 'Switch theme: Night / Parchment', onclick: toggleTheme }, icon('theme')),
    h('button', { class: 'icon-btn', title: 'Undo (⌘Z)', disabled: !canUndo(), onclick: undo }, icon('undo')),
    h('button', { class: 'icon-btn', title: 'Redo (⇧⌘Z)', disabled: !canRedo(), onclick: redo }, icon('redo')),
    h('button', { class: 'btn primary', onclick: () => setView('export') }, icon('export'), 'Export'));
}

function renderNav() {
  const p = state.project;
  const inbox = p.tracks.filter(t => t.num == null).length;
  const errors = (state.issues || []).filter(i => i.sev === 'error').length;
  const custom = p.triggers.filter(t => !(t.func === 1 && t.type === 0 && t.retrigger && t.poly && !t.loop && !t.lock && !t.gain && !t.output && !t.iface && !t.invert)).length;
  const counts = { tracks: inbox ? `${inbox} inbox` : null, triggers: custom || null, export: errors || null };
  return h('nav', null, VIEWS.map(v => h('button', {
    class: 'nav-item' + (state.ui.view === v.key ? ' on' : ''), title: v.help,
    onclick: () => setView(v.key), 'aria-current': state.ui.view === v.key ? 'page' : null,
  }, icon(v.icon), h('span', { class: 'nav-label' }, v.label),
  counts[v.key] ? h('span', { class: 'nav-count' + (v.key === 'export' ? ' bad' : '') }, counts[v.key]) : null)));
}

// ---------- drag & drop from the OS ----------

let dragDepth = 0;
function dropBar() {
  const zone = (label, sub, placement) => {
    const z = h('div', { class: 'dz' }, h('strong', null, label), h('span', null, sub));
    z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('on'); });
    z.addEventListener('dragleave', () => z.classList.remove('on'));
    z.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); hideDrop(); droppedFiles(e.dataTransfer).then(files => importFiles(files, placement)); });
    return z;
  };
  return h('div', { class: 'dropbar', id: 'dropbar' },
    zone('Inbox', 'number them later', {}),
    zone('Keep numbers', 'use 0001_… in file names', { useNames: true }),
    zone('Next free', 'number in order from 1', { autoNumber: 1 }),
    h('div', { class: 'dz-hint' }, 'or drop on a pad / key to place exactly'));
}
function hideDrop() { dragDepth = 0; document.body.classList.remove('dragging'); }

window.addEventListener('dragenter', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) hideDrop(); });
window.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', e => {
  e.preventDefault();
  hideDrop();
  if (e.dataTransfer.files.length) droppedFiles(e.dataTransfer).then(files => importFiles(files, {}));
});

// ---------- keyboard ----------

const typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(a.type)) || a.isContentEditable);
};

document.addEventListener('keydown', e => {
  if (document.querySelector('.modal-back')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing()) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y' && !typing()) { e.preventDefault(); redo(); return; }
  if (typing()) return;
  if (padsKeydown(e)) { e.preventDefault(); return; }
  if (e.key === ' ') {
    e.preventDefault();
    const t = selectedTrack();
    if (t) audition(t); else stopAll();
  } else if (e.key === 'Escape') {
    if (state.ui.globalOpen) { toggleGlobal(false); return; }
    stopAudition(); stopAllSim(); stopAll();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    const ids = state.ui.multi.size > 1 ? [...state.ui.multi] : state.ui.selectedId ? [state.ui.selectedId] : [];
    if (ids.length) { e.preventDefault(); deleteTracks(ids); }
  } else if (e.key.toLowerCase() === 'g' && !mod && !state.ui.perform) {
    toggleGlobal();
  } else if (/^[1-8]$/.test(e.key) && e.altKey) {
    setView(VIEWS[+e.key - 1].key);
  }
});
document.addEventListener('keyup', padsKeyup);

// ---------- boot ----------

async function start() {
  document.body.append(dropBar());
  await boot();
  state.issues = validateProject(state.project);
  if (!('showDirectoryPicker' in window)) {
    $('#banner').hidden = false;
    $('#banner').textContent = 'Tip: open this app in Chrome or Edge to write straight to the SD card and use MIDI/serial. Other browsers can still prepare a ZIP.';
  }
  flush();
  subscribe(reason => { if (reason === 'import') requestPersistence(); });
  const q = new URLSearchParams(location.search);
  if (q.has('demo') && !state.project.tracks.length) {
    const { loadDemo } = await import('./demo.js');
    await loadDemo();
  }
  if (q.get('view')) setView(q.get('view'));
}

window.addEventListener('beforeunload', e => {
  if (getSaveState() === 'saving' || getSaveState() === 'dirty') { e.preventDefault(); e.returnValue = ''; }
});

window.ntm = { state, emit, toast }; // handy in the console
start();
