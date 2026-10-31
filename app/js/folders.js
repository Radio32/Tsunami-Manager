// Importing whole folders (with subfolders): screening out files that don't belong,
// then a confirmation dialog that places each folder in its own named trigger bank,
// numbers everything in order, or sends it to the Inbox.

import { AUDIO_EXT, MAX_TRACK, TRIGGER_BANKS } from './constants.js';
import { trackByNum, nextFreeNum, isKitSlot } from './state.js';
import { byName } from './kit.js';
import { parseTrackFileName } from './naming.js';
import { h, fmtBytes } from './util.js';
import { modal, toggle, segmented, numberInput } from './ui.js';

export const FOLDER_LIMIT = 1000;            // audio files per folder import
export const LARGE_FILE = 50 * 1024 * 1024;  // ~5 min of stereo WAV; usually a recording, not a sample
export const SCAN_LIMIT = 20000;             // stop walking a dropped folder after this many files
export const MAX_DEPTH = 8;

// Hidden files, macOS resource forks (._*), Finder/Windows metadata and zip leftovers.
export const JUNK = /^(\.|__MACOSX$|Thumbs\.db$|desktop\.ini$|Icon\r?$)/i;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byPath = (a, b) => collator.compare(a._path || '', b._path || '') || byName(a, b);

/**
 * Sort a folder's files into what can be imported and what is skipped, and why.
 * Files carry `_path` (their folder, relative to the picked/dropped folder).
 */
export function screenFolder(files) {
  const skipped = { hidden: files.hidden || 0, other: 0, empty: 0, deep: files.tooDeep || 0 };
  const audio = [], large = [], dupes = [];
  const seen = new Set();
  for (const f of files) {
    const segs = (f._path || '').split('/').filter(Boolean);
    if (JUNK.test(f.name) || segs.some(s => JUNK.test(s))) { skipped.hidden++; continue; }
    if (segs.length > MAX_DEPTH + 1) { skipped.deep++; continue; }
    if (!AUDIO_EXT.test(f.name)) { skipped.other++; continue; }
    if (f.size < 64) { skipped.empty++; continue; }
    const key = `${f.name.toLowerCase()}|${f.size}`;
    if (seen.has(key)) { dupes.push(f); continue; }
    seen.add(key);
    (f.size > LARGE_FILE ? large : audio).push(f);
  }
  return { audio: audio.sort(byPath), large: large.sort(byPath), dupes: dupes.sort(byPath), skipped, truncated: !!files.truncated };
}

function groupByFolder(list) {
  const groups = new Map();
  for (const f of list) {
    const k = f._path || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  return groups;
}

// Default bank name: the folder's own name, or its path below the top folder when two folders share a name.
function defaultNames(paths) {
  const last = p => p.split('/').filter(Boolean).pop() || '(loose files)';
  const counts = new Map();
  for (const p of paths) counts.set(last(p), (counts.get(last(p)) || 0) + 1);
  return new Map(paths.map(p => [p, counts.get(last(p)) > 1 ? p.split('/').slice(1).join(' / ') || last(p) : last(p)]));
}

const usedBanks = taken => new Set([...taken.keys()].map(n => Math.floor((n - 1) / 16)));
const bankSlots = b => Array.from({ length: 16 }, (_, k) => b * 16 + k + 1).filter(n => isKitSlot(n));

function firstEmptyBank() {
  const used = usedBanks(trackByNum());
  for (let b = 0; b < TRIGGER_BANKS; b++) if (!used.has(b)) return b;
  return 0;
}

/**
 * Resolves to { out: [{ file, num|null }], bankNames: { bank: name } } or null when cancelled.
 * defaults: { mode: 'banks' | 'order' | 'inbox', useNames }
 */
export async function folderDialog(scan, title, defaults = {}) {
  const opts = { mode: defaults.mode || 'banks', useNames: !!defaults.useNames, large: false, dupes: false, start: firstEmptyBank() };
  const names = new Map(); // folder path → bank name typed by the user
  let plan;

  function chosen() {
    const all = [...scan.audio, ...(opts.large ? scan.large : []), ...(opts.dupes ? scan.dupes : [])].sort(byPath);
    return { list: all.slice(0, FOLDER_LIMIT), cut: Math.max(0, all.length - FOLDER_LIMIT) };
  }

  function replan() {
    const { list, cut } = chosen();
    const taken = trackByNum();
    const out = [], groups = [];
    if (opts.mode === 'banks') {
      const used = usedBanks(taken);
      const g = groupByFolder(list);
      const defs = defaultNames([...g.keys()]);
      let b = opts.start;
      for (const [path, files] of g) {
        const row = { path, files, banks: [], inbox: 0, def: defs.get(path) };
        const queue = [...files];
        while (queue.length) {
          while (b < TRIGGER_BANKS && (used.has(b) || !bankSlots(b).length)) b++;
          if (b >= TRIGGER_BANKS) break;
          const slots = bankSlots(b);
          queue.splice(0, slots.length).forEach((file, i) => out.push({ file, num: slots[i] }));
          row.banks.push(b);
          used.add(b++);
        }
        row.inbox = queue.length;
        queue.forEach(file => out.push({ file, num: null }));
        groups.push(row);
      }
    } else if (opts.mode === 'order') {
      let cursor = 1;
      for (const file of list) {
        const parsed = opts.useNames ? parseTrackFileName(file.name) : null;
        let num = parsed?.valid && !taken.has(parsed.num) ? parsed.num : nextFreeNum(cursor, taken);
        if (num != null && num <= MAX_TRACK) {
          taken.set(num, file);
          if (!(parsed?.valid && num === parsed.num)) cursor = num + 1;
        } else num = null;
        out.push({ file, num });
      }
    } else {
      for (const file of list) out.push({ file, num: null });
    }
    plan = { out, groups, cut, count: list.length, folders: groupByFolder(list).size, bytes: list.reduce((n, f) => n + f.size, 0) };
  }

  const body = h('div', { class: 'folderplan' });

  function skippedList() {
    const s = scan.skipped, items = [];
    if (s.hidden) items.push(`${s.hidden} hidden or system file${s.hidden === 1 ? '' : 's'} (._ files, .DS_Store, __MACOSX…)`);
    if (s.other) items.push(`${s.other} file${s.other === 1 ? '' : 's'} that aren’t audio (documents, images, project files…)`);
    if (s.empty) items.push(`${s.empty} empty or broken file${s.empty === 1 ? '' : 's'}`);
    if (s.deep) items.push(`${s.deep} item${s.deep === 1 ? '' : 's'} nested deeper than ${MAX_DEPTH} folders`);
    if (scan.truncated) items.push(`Scanning stopped after ${SCAN_LIMIT.toLocaleString()} files — import subfolders separately for the rest`);
    return items;
  }

  function draw() {
    replan();
    const skipped = skippedList();
    const placed = plan.out.filter(x => x.num != null);
    const nums = placed.map(x => x.num);
    body.replaceChildren(h('frag', null,
      h('p', null, h('strong', null, `${plan.count} audio file${plan.count === 1 ? '' : 's'}`),
        ` in ${plan.folders} folder${plan.folders === 1 ? '' : 's'} · ${fmtBytes(plan.bytes)}`),
      skipped.length ? h('div', { class: 'fp-skip' }, h('span', { class: 'field-label' }, 'Left out'), h('ul', { class: 'plain small muted' }, skipped.map(t => h('li', null, t)))) : null,
      scan.large.length || scan.dupes.length ? h('div', { class: 'toggles col' },
        scan.large.length ? toggle(`Include ${scan.large.length} very large file${scan.large.length === 1 ? '' : 's'} (over ${LARGE_FILE / 1024 / 1024} MB — usually recordings, not samples)`, opts.large, v => { opts.large = v; draw(); },
          { title: scan.large.slice(0, 20).map(f => `${f._path}/${f.name} · ${fmtBytes(f.size)}`).join('\n') }) : null,
        scan.dupes.length ? toggle(`Include ${scan.dupes.length} duplicate${scan.dupes.length === 1 ? '' : 's'} (same name and size as another file)`, opts.dupes, v => { opts.dupes = v; draw(); },
          { title: scan.dupes.slice(0, 20).map(f => `${f._path}/${f.name}`).join('\n') }) : null) : null,
      plan.cut ? h('p', { class: 'warn small' }, `Only the first ${FOLDER_LIMIT} files are imported at a time; ${plan.cut} are left out. Import the remaining subfolders separately.`) : null,
      plan.bytes > 1024 ** 3 ? h('p', { class: 'warn small' }, `About ${fmtBytes(plan.bytes)} will be stored in this browser, and decoding takes a while.`) : null,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Place the files'),
        segmented([['banks', 'One bank per folder'], ['order', 'Numbered in order'], ['inbox', 'Inbox']], opts.mode, v => { opts.mode = v; draw(); })),
      opts.mode === 'banks' ? [
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'First bank'),
            numberInput(opts.start, v => { opts.start = Math.round(v ?? 0); draw(); }, { min: 0, max: TRIGGER_BANKS - 1, width: '5em' })),
          h('p', { class: 'muted small fp-note' }, `${bankSlots(opts.start).length} pads per bank (the triggers set to Normal). Banks that already hold tracks are skipped, so nothing is replaced. A folder with more files continues in the next free bank.`)),
        h('div', { class: 'fp-wrap' }, h('table', { class: 'grid fp-table' },
          h('thead', null, h('tr', null, h('th', null, 'Folder'), h('th', { class: 'r' }, 'Files'), h('th', null, 'Bank'), h('th', null, 'Bank name'))),
          h('tbody', null, plan.groups.map(g => h('tr', null,
            h('td', { class: 'fp-path', title: g.path }, g.path || '(loose files)'),
            h('td', { class: 'r mono' }, g.files.length),
            h('td', { class: 'mono' }, g.banks.length ? (g.banks.length === 1 ? `B${g.banks[0]}` : `B${g.banks[0]}–B${g.banks[g.banks.length - 1]}`) : '—',
              g.inbox ? h('span', { class: 'warn small' }, ` +${g.inbox} to Inbox`) : null),
            h('td', null, h('input', {
              type: 'text', class: 'cell-input', maxlength: 32, value: names.get(g.path) ?? g.def, disabled: !g.banks.length,
              'aria-label': `Bank name for ${g.path}`, oninput: e => names.set(g.path, e.target.value),
            })))))))] : null,
      opts.mode === 'order' ? [
        toggle('Use numbers at the start of file names (0001_…) when they’re free', opts.useNames, v => { opts.useNames = v; draw(); }),
        h('p', { class: 'muted small' }, placed.length ? `Tracks ${Math.min(...nums)}–${Math.max(...nums)}, skipping numbers already in use and the control-trigger slots.` : 'No free track numbers left.')] : null,
      opts.mode === 'inbox' ? h('p', { class: 'muted small' }, 'Files go to the Inbox without numbers. Drag them onto pads or use “Number from…” on the Tracks page.') : null,
      placed.length < plan.out.length && opts.mode !== 'inbox' ? h('p', { class: 'muted small' }, `${plan.out.length - placed.length} file${plan.out.length - placed.length === 1 ? '' : 's'} didn’t fit and go to the Inbox.`) : null));
  }
  draw();

  const ok = await modal({
    title,
    wide: true,
    body,
    actions: [{ label: 'Cancel', value: false }, { label: 'Import', value: true, primary: true }],
  });
  if (!ok || !plan.count) return null;
  const bankNames = {};
  if (opts.mode === 'banks') {
    for (const g of plan.groups) {
      const name = (names.get(g.path) ?? g.def).trim().slice(0, 32);
      if (name) g.banks.forEach((b, i) => { bankNames[b] = i ? `${name} ${i + 1}` : name; });
    }
  }
  return { out: plan.out, bankNames };
}
