// Project model, mutations with undo/redo, and autosave.

import { TRIGGERS, MAX_TRACK } from './constants.js';
import { defaultTrigger, defaultGlobal, applyFunctionDefaults } from './ini.js';
import { saveProject, loadProject } from './store.js';
import { uid, debounce } from './util.js';

export const PROJECT_VERSION = 1;

export function defaultEdits() {
  return {
    gain: 0, norm: 'project', normTarget: null,
    trimStart: 0, trimEnd: null, fadeIn: 0, fadeOut: 0, fadeCurve: 'linear',
    chan: 'auto', reverse: false, pan: 0,
  };
}

// Nutella default for this user: 14 sounds per bank, T15 = Bank Down, T16 = Bank Up.
export function defaultKitTriggers() {
  return Array.from({ length: TRIGGERS }, (_, i) => {
    const t = defaultTrigger(i + 1);
    if (i === 14) return applyFunctionDefaults(t, 13);
    if (i === 15) return applyFunctionDefaults(t, 12);
    return t;
  });
}

export function newProject(name = 'Untitled project') {
  return {
    version: PROJECT_VERSION,
    id: uid(),
    name,
    mode: 'stereo',
    board: 'original',
    tracks: [],
    triggers: defaultKitTriggers(),
    global: defaultGlobal(),
    processing: { norm: 'peak', peakTarget: -1, rmsTarget: -18, dither: true },
    naming: { digits: 4, sep: '_', ascii: true, alwaysSuffix: false, maxLen: 64 },
    export: { cleanOrphans: false, skipUnchanged: true, writeManifest: true },
    ui: { noteConvention: 'yamaha', padLayout: '4x4' },
    created: new Date().toISOString(),
  };
}

export function newTrack(fields) {
  return {
    id: uid(), num: null, name: 'untitled', sourceId: null, sourceName: '',
    tags: [], notes: '', color: null,
    midi: { loop: false, out: 1 },
    edits: defaultEdits(),
    info: null, // { duration, channels, origRate, peakDb, rmsDb, wave[] , bytes }
    ...fields,
  };
}

// Bring older/foreign project JSON up to the current shape.
export function normalizeProject(p) {
  const base = newProject();
  const out = { ...base, ...p };
  out.global = { ...base.global, ...p.global, outVol: [...(p.global?.outVol || base.global.outVol)] };
  out.processing = { ...base.processing, ...p.processing };
  out.naming = { ...base.naming, ...p.naming };
  out.export = { ...base.export, ...p.export };
  out.ui = { ...base.ui, ...p.ui };
  out.triggers = base.triggers.map((t, i) => ({ ...t, ...(p.triggers?.[i] || {}), num: i + 1 }));
  out.tracks = (p.tracks || []).map(t => {
    const n = newTrack(t);
    n.edits = { ...defaultEdits(), ...t.edits };
    n.midi = { loop: false, out: 1, ...t.midi };
    return n;
  });
  return out;
}

// ---------- store ----------

const listeners = new Set();
const undoStack = [];
const redoStack = [];
let saveState = 'saved';

export const state = {
  project: newProject(),
  ui: {
    view: 'pads',
    selectedId: null,
    multi: new Set(),
    padBank: 0,
    midiBank: 0,
    perform: false,
    filter: '',
    trackFilter: 'all',
    inspectorOpen: true,
  },
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(reason) { for (const fn of listeners) fn(reason); }
export const getSaveState = () => saveState;

const persist = debounce(async () => {
  saveState = 'saving'; emit('save');
  try {
    await saveProject(state.project);
    saveState = 'saved';
  } catch (e) {
    saveState = 'error';
    console.error(e);
  }
  emit('save');
}, 400);

// Every user-visible change goes through here so it can be undone.
export function update(fn, { undo = true, reason = 'update' } = {}) {
  if (undo) {
    undoStack.push(JSON.stringify(state.project));
    if (undoStack.length > 150) undoStack.shift();
    redoStack.length = 0;
  }
  fn(state.project);
  saveState = 'dirty';
  persist();
  emit(reason);
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(state.project));
  state.project = JSON.parse(undoStack.pop());
  persist(); emit('undo');
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(state.project));
  state.project = JSON.parse(redoStack.pop());
  persist(); emit('undo');
}

export function replaceProject(p) {
  state.project = normalizeProject(p);
  undoStack.length = 0; redoStack.length = 0;
  state.ui.selectedId = null; state.ui.multi.clear();
  state.ui.padBank = 0; state.ui.midiBank = 0;
  persist(); emit('load');
}

export async function boot() {
  try {
    const p = await loadProject();
    if (p) state.project = normalizeProject(p);
  } catch (e) { console.error('Could not load saved project', e); }
}

// ---------- queries ----------

export function trackByNum() {
  const m = new Map();
  for (const t of state.project.tracks) if (t.num != null) m.set(t.num, t);
  return m;
}

export const trackById = id => state.project.tracks.find(t => t.id === id);
export const selectedTrack = () => (state.ui.selectedId ? trackById(state.ui.selectedId) : null);

// A slot is playable from the panel when its trigger input is set to Normal.
export function isKitSlot(n, project = state.project) {
  return project.triggers[(n - 1) % 16].func === 1;
}

// Next free number; by default skips slots whose trigger is a control (e.g. T15/T16 bank nav).
export function nextFreeNum(start = 1, taken = trackByNum(), { kitSlots = true } = {}) {
  for (let n = Math.max(1, start); n <= MAX_TRACK; n++) if (!taken.has(n) && (!kitSlots || isKitSlot(n))) return n;
  return null;
}

export function select(id, { additive = false } = {}) {
  if (additive) {
    if (state.ui.multi.has(id)) state.ui.multi.delete(id); else state.ui.multi.add(id);
  } else {
    state.ui.multi.clear();
    if (id) state.ui.multi.add(id);
  }
  state.ui.selectedId = id;
  emit('select');
}

export function setView(v) { state.ui.view = v; emit('view'); }
