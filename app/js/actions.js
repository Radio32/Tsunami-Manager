// Project-level operations shared by several views.

import { MAX_TRACK } from './constants.js';
import { state, update, newTrack, trackByNum, nextFreeNum, select, defaultEdits } from './state.js';
import { applyFunctionDefaults } from './ini.js';
import { getDecoded, detectSilence } from './audio.js';
import { ingestFile } from './importer.js';
import { toast, confirmModal } from './ui.js';
import { uid } from './util.js';

// Give a track a number; if another track holds it, the two swap.
export function setTrackNum(id, num) {
  if (num != null && !(num >= 1 && num <= MAX_TRACK)) { toast('Track numbers run from 1 to 4096.', { kind: 'warn' }); return; }
  update(p => {
    const t = p.tracks.find(x => x.id === id);
    if (!t || t.num === num) return;
    const other = num != null ? p.tracks.find(x => x.num === num && x.id !== id) : null;
    if (other) other.num = t.num;
    t.num = num;
  }, { reason: 'renumber' });
}

export function moveToInbox(ids) {
  update(p => { for (const t of p.tracks) if (ids.includes(t.id)) t.num = null; }, { reason: 'inbox' });
}

export async function deleteTracks(ids) {
  if (!ids.length) return;
  if (ids.length > 1 && !(await confirmModal('Delete tracks?', `Delete ${ids.length} tracks from the project? (Undo with ⌘Z.)`, { ok: 'Delete', danger: true }))) return;
  update(p => { p.tracks = p.tracks.filter(t => !ids.includes(t.id)); }, { reason: 'delete' });
  state.ui.multi.clear();
  if (ids.includes(state.ui.selectedId)) select(null);
}

export function duplicateTrack(id) {
  let nid;
  update(p => {
    const t = p.tracks.find(x => x.id === id);
    if (!t) return;
    const c = structuredClone(t);
    c.id = uid();
    c.name = t.name + ' copy';
    c.num = t.num != null ? nextFreeNum(t.num + 1, trackByNum()) : null;
    p.tracks.push(c);
    nid = c.id;
  }, { reason: 'duplicate' });
  if (nid) select(nid);
}

export function patchEdits(ids, patch) {
  update(p => { for (const t of p.tracks) if (ids.includes(t.id)) Object.assign(t.edits, patch); }, { reason: 'edit' });
}

export function patchTracks(ids, fn) {
  update(p => { for (const t of p.tracks) if (ids.includes(t.id)) fn(t); }, { reason: 'edit' });
}

export function resetEdits(ids) {
  update(p => { for (const t of p.tracks) if (ids.includes(t.id)) t.edits = defaultEdits(); }, { reason: 'edit' });
}

// Assign numbers to tracks in their current order, starting at `start`, skipping taken slots.
export function autoNumber(ids, start = 1, { contiguous = false } = {}) {
  update(p => {
    const list = p.tracks.filter(t => ids.includes(t.id));
    for (const t of list) t.num = null;
    const taken = new Map(p.tracks.filter(t => t.num != null).map(t => [t.num, t]));
    let n = start;
    for (const t of list) {
      if (contiguous) {
        const other = taken.get(n);
        if (other) other.num = null;
      } else {
        n = nextFreeNum(n, taken);
      }
      if (n == null || n > MAX_TRACK) break;
      t.num = n;
      taken.set(n, t);
      n++;
    }
  }, { reason: 'renumber' });
}

export async function autoTrim(ids, thresholdDb = -50) {
  for (const id of ids) {
    const t = state.project.tracks.find(x => x.id === id);
    if (!t?.sourceId) continue;
    const d = await getDecoded(t.sourceId);
    const { start, end } = detectSilence(d.channels, thresholdDb);
    const total = d.channels[0].length / 44100;
    patchEdits([id], { trimStart: Math.max(0, start - 0.002), trimEnd: end >= total - 0.001 ? null : Math.min(total, end + 0.01), fadeOut: Math.max(t.edits.fadeOut || 0, 5) });
  }
}

// Mono firmware: put L and R of a stereo source on two consecutive tracks and
// (optionally) create a Synced Set trigger that plays them sample-locked.
export function splitStereo(id, trigNum = null) {
  const src = state.project.tracks.find(x => x.id === id);
  if (!src) return;
  const taken = trackByNum();
  const free = n => !taken.has(n) || taken.get(n).id === id;
  let base = src.num;
  if (base == null || base + 1 > MAX_TRACK || !free(base + 1)) {
    base = null;
    for (let n = 1; n < MAX_TRACK; n++) if (free(n) && free(n + 1)) { base = n; break; }
  }
  if (base == null) { toast('No two consecutive free track numbers left.', { kind: 'warn' }); return; }
  update(p => {
    const t = p.tracks.find(x => x.id === id);
    t.num = base;
    t.edits.chan = 'left';
    t.name = t.name.replace(/\s*\(L\)$/, '') + ' (L)';
    const r = newTrack({ ...structuredClone(t), id: uid(), num: base + 1, name: t.name.replace(/\(L\)$/, '(R)') });
    r.edits.chan = 'right';
    p.tracks.push(r);
    if (trigNum) {
      const tr = applyFunctionDefaults(p.triggers[trigNum - 1], 14);
      p.triggers[trigNum - 1] = { ...tr, low: base, high: base + 1, output: 0 };
    }
  }, { reason: 'split' });
  toast(`Split into tracks ${base} (L) and ${base + 1} (R)${trigNum ? `, Synced Set on trigger ${trigNum}` : ''}.`, { kind: 'ok' });
}

export function makeSyncedSet(ids, trigNum, start) {
  if (ids.length > 8) { toast('A synced set holds at most 8 tracks.', { kind: 'warn' }); return; }
  autoNumber(ids, start, { contiguous: true });
  update(p => {
    const tr = applyFunctionDefaults(p.triggers[trigNum - 1], 14);
    p.triggers[trigNum - 1] = { ...tr, low: start, high: start + ids.length - 1, output: 0 };
    if (p.mode !== 'mono') p.mode = 'mono';
  }, { reason: 'synced' });
  toast(`Tracks ${start}–${start + ids.length - 1} play in sync from trigger ${trigNum} (mono firmware).`, { kind: 'ok' });
}

export async function replaceSource(id, file) {
  const r = await ingestFile(file);
  update(p => {
    const t = p.tracks.find(x => x.id === id);
    if (!t) return;
    t.sourceId = r.sourceId; t.sourceName = file.name; t.info = r.info;
    t.edits.trimStart = 0; t.edits.trimEnd = null;
  }, { reason: 'replace' });
}

export function pickFiles({ multiple = true, accept = 'audio/*,.wav,.aif,.aiff,.flac,.mp3,.ogg,.m4a,.ini,.zip' } = {}) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = multiple; input.accept = accept;
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}
