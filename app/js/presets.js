// Custom trigger presets: named sets of all 16 trigger settings and trigger names,
// kept in this browser's localStorage and exportable as a .json file.

import { uid, downloadBlob } from './util.js';
import { state, update, emit } from './state.js';
import { defaultTrigger } from './ini.js';
import { FUNC_BY_CODE, TYPES } from './constants.js';
import { toast } from './ui.js';

const KEY = 'ntm-trigger-presets';
const FORMAT = 'nutella-tsunami-trigger-presets';
const FIELDS = ['func', 'type', 'iface', 'invert', 'retrigger', 'loop', 'poly', 'lock', 'gain', 'output', 'low', 'high'];

let cache = null;

// Keep only known trigger fields, with sane values, so a hand-edited or foreign file can't break the project.
export function cleanTrigger(t, num) {
  const d = defaultTrigger(num);
  const out = { ...d };
  for (const k of FIELDS) if (t && typeof t[k] === typeof d[k]) out[k] = t[k];
  if (!FUNC_BY_CODE[out.func]) out.func = 1;
  if (!TYPES.some(x => x.code === out.type)) out.type = 0;
  out.output = Math.max(0, Math.min(8, out.output | 0));
  out.gain = Math.max(-20, Math.min(10, Math.round(out.gain)));
  out.low = Math.max(0, Math.min(4096, out.low | 0));
  out.high = Math.max(0, Math.min(4096, out.high | 0));
  out.label = typeof t?.label === 'string' ? t.label.slice(0, 24) : '';
  return out;
}

function cleanPreset(pr) {
  return {
    id: typeof pr.id === 'string' && pr.id ? pr.id : uid(),
    name: (typeof pr.name === 'string' && pr.name.trim()) || 'Untitled preset',
    mode: pr.mode === 'mono' ? 'mono' : 'stereo',
    triggers: Array.from({ length: 16 }, (_, i) => cleanTrigger(pr.triggers?.[i], i + 1)),
    updated: pr.updated || new Date().toISOString(),
  };
}

export function listPresets() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    cache = Array.isArray(raw) ? raw.map(cleanPreset) : [];
  } catch { cache = []; }
  return cache;
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); }
  catch { toast('Couldn’t save presets in this browser (private window or storage blocked). Use Export to keep them.', { kind: 'warn', ms: 6000 }); }
  emit('view');
}

export const getPreset = id => listPresets().find(x => x.id === id) || null;

export function createPreset({ name, mode, triggers }) {
  const pr = cleanPreset({ name, mode, triggers, id: uid() });
  listPresets().push(pr);
  persist();
  return pr;
}

export function changePreset(id, fn) {
  const pr = getPreset(id);
  if (!pr) return;
  fn(pr);
  Object.assign(pr, cleanPreset(pr), { updated: new Date().toISOString() });
  persist();
}

export function deletePreset(id) {
  cache = listPresets().filter(x => x.id !== id);
  persist();
}

export function presetFromProject(name) {
  const p = state.project;
  return createPreset({ name, mode: p.mode, triggers: p.triggers });
}

// Replaces the project's 16 triggers (settings and names) and firmware mode. Undo restores both.
export function applyPresetToProject(pr) {
  update(p => {
    p.mode = pr.mode;
    p.triggers = pr.triggers.map((t, i) => ({ ...cleanTrigger(t, i + 1) }));
  }, { reason: 'trigger' });
}

export function exportPresets(list = listPresets()) {
  const json = JSON.stringify({ format: FORMAT, version: 1, presets: list }, null, 2);
  const name = list.length === 1 ? `${list[0].name.replace(/[^\w\- ]+/g, '').trim() || 'preset'}.json` : 'trigger-presets.json';
  downloadBlob(new Blob([json], { type: 'application/json' }), name);
}

// Accepts an export file (one or many presets) or a bare preset object. Returns how many were added.
export async function importPresetFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} isn’t a preset file (not JSON).`); }
  const items = Array.isArray(data?.presets) ? data.presets : Array.isArray(data) ? data : data?.triggers ? [data] : null;
  if (!items?.length) throw new Error(`${file.name} has no trigger presets in it.`);
  const list = listPresets();
  const ids = new Set(list.map(x => x.id));
  for (const raw of items) {
    const pr = cleanPreset(raw);
    if (ids.has(pr.id)) pr.id = uid();
    ids.add(pr.id);
    list.push(pr);
  }
  persist();
  return items.length;
}
