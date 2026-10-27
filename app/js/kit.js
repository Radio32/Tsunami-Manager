// Smart kit placement for pads 1–8: recognise drum sounds by file name and
// suggest Kick, Snare, OHH, CHH, Clap, Perc 1, Perc 2, Cymbal.

import { h } from './util.js';
import { trackByNum, isKitSlot } from './state.js';
import { modal, toggle } from './ui.js';

export const KIT_SLOTS = [
  { pad: 1, key: 'kick', label: 'Kick', short: 'KICK' },
  { pad: 2, key: 'snare', label: 'Snare', short: 'SNARE' },
  { pad: 3, key: 'ohh', label: 'Open hi-hat', short: 'OHH' },
  { pad: 4, key: 'chh', label: 'Closed hi-hat', short: 'CHH' },
  { pad: 5, key: 'clap', label: 'Clap', short: 'CLAP' },
  { pad: 6, key: 'perc', label: 'Perc 1', short: 'PERC 1' },
  { pad: 7, key: 'perc', label: 'Perc 2', short: 'PERC 2' },
  { pad: 8, key: 'cym', label: 'Cymbal / crash', short: 'CYM' },
];

// Checked in this order: "snare rim" is a snare, "open hat" beats the generic "hat".
const RULES = [
  ['kick', /\b(kick|kicks|kik|kck|bd|bass ?drum|bassdrum)\b/],
  ['snare', /\b(snare|snares|snr|sn|sd)\b/],
  ['clap', /\b(clap|claps|clp|cp|hand ?clap|handclap|snap|snaps)\b/],
  ['ohh', /\b(ohh|oh|ohat|open ?hh|open ?hi ?hats?|open ?hats?|hh ?open|hi ?hats? ?open|hats? ?open|opn ?hh)\b/],
  ['chh', /\b(chh|ch|chat|closed ?hh|closed ?hi ?hats?|closed ?hats?|hh ?closed|hats? ?closed|cl ?hh|hhc|hh|hats?|hi ?hats?|hihats?)\b/],
  ['cym', /\b(cym|cymbal|cymbals|crash|crashes|crsh|ride|splash|china|cy)\b/],
  ['perc', /\b(perc|percs|percussion|tom|toms|rim|rimshot|rs|conga|congas|bongo|bongos|cowbell|cb|shaker|shk|tamb|tambourine|clave|claves|block|woodblock|cabasa|guiro|agogo|triangle|timbale|timbales|lt|mt|ht|zap|fx)\b/],
];

export function tokens(name) {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function classify(name) {
  const t = tokens(name);
  for (const [key, re] of RULES) if (re.test(t)) return key;
  return null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// Compare without the extension so "Kick.wav" sorts before "Kick 2.wav".
export const byName = (a, b) => collator.compare(a.name.replace(/\.[^.]+$/, ''), b.name.replace(/\.[^.]+$/, ''));

// Pure suggestion: which file goes to which of the 8 slots, what's left over.
export function suggestKit(files) {
  const sorted = [...files].sort(byName);
  const byKey = new Map();
  const unmatched = [];
  for (const f of sorted) {
    const k = classify(f.name);
    if (!k) { unmatched.push(f); continue; }
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(f);
  }
  const slots = KIT_SLOTS.map(() => null);
  const used = new Set();
  KIT_SLOTS.forEach((s, i) => {
    const f = (byKey.get(s.key) || []).find(x => !used.has(x));
    if (f) { slots[i] = f; used.add(f); }
  });
  const extras = new Map(); // slot index -> further matches for that slot's category
  KIT_SLOTS.forEach((s, i) => {
    if (s.key === 'perc' && i === 6) return; // perc extras are collected once, under Perc 1
    const more = (byKey.get(s.key) || []).filter(x => !used.has(x));
    if (more.length) extras.set(i, more);
  });
  return { slots, extras, unmatched, byKey };
}

export const MAX_KIT_BANKS = 8;

export const folderOf = f => f._folder || '';

// "Rim 3.wav" and "rim_1.wav" share the stem "rim".
export const stem = name => tokens(name).replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();

// Percussion for pads 6 and 7: each naming style keeps to one pad (rims on 6, toms on 7…).
// With a single style the files alternate between the two pads.
function percQueues(list) {
  const stems = new Map();
  for (const f of list) {
    const k = stem(f.name);
    if (!stems.has(k)) stems.set(k, []);
    stems.get(k).push(f);
  }
  if (stems.size < 2) return [list.filter((_, k) => k % 2 === 0), list.filter((_, k) => k % 2 === 1)];
  const q = [[], []];
  for (const group of stems.values()) (q[0].length <= q[1].length ? q[0] : q[1]).push(...group);
  return q;
}

// Queue of files for each of the 8 pads; same-category files line up behind each other.
function padQueues(files) {
  const { byKey } = suggestKit(files);
  const perc = percQueues(byKey.get('perc') || []);
  return KIT_SLOTS.map((s, i) => (s.key === 'perc' ? perc[i - 5] : byKey.get(s.key) || []));
}

/**
 * Pure kit plan. Rows are banks relative to the drop bank (row 0 = drop bank).
 *  perFolder: one bank per top-level folder (extras of a folder go to leftovers)
 *  spread:    same-category extras continue on the same pad in the next banks
 * At most `maxBanks` rows; everything that doesn't fit is in `leftovers`.
 */
export function planKit(files, { perFolder = false, spread = true, maxBanks = MAX_KIT_BANKS } = {}) {
  const rows = [];
  const placed = new Set();
  if (perFolder) {
    const groups = new Map();
    for (const f of files) {
      const k = folderOf(f);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    }
    const names = [...groups.keys()].sort((x, y) => collator.compare(x, y));
    names.slice(0, maxBanks).forEach(name => {
      const cells = padQueues(groups.get(name)).map(q => q[0] || null);
      cells.forEach(c => c && placed.add(c));
      rows.push({ label: name || '(loose files)', folder: name, cells });
    });
  } else {
    const queues = padQueues(files);
    const depth = spread ? Math.min(maxBanks, Math.max(1, ...queues.map(q => q.length))) : 1;
    for (let r = 0; r < depth; r++) {
      const cells = queues.map(q => q[r] || null);
      cells.forEach(c => c && placed.add(c));
      rows.push({ label: r === 0 ? 'drop bank' : `+${r}`, cells });
    }
  }
  const sorted = [...files].sort((x, y) => collator.compare(folderOf(x), folderOf(y)) || byName(x, y));
  return { rows, leftovers: sorted.filter(f => !placed.has(f)) };
}

/**
 * Placement dialog for several files dropped on pads 1–8 of `bank`.
 * Resolves to [{ file, num|null }] (null = Inbox) or null when cancelled.
 */
export async function kitDialog(files, bank) {
  const tracks = trackByNum();
  const folders = new Set(files.map(folderOf));
  const opts = { perFolder: folders.size > 1, spread: true, inboxRest: true };
  const maxBanks = Math.min(MAX_KIT_BANKS, 256 - bank);
  let plan;
  const replan = () => { plan = planKit(files, { ...opts, maxBanks }); };
  replan();

  const body = h('div', { class: 'kitplan' });
  const tag = f => { const k = classify(f.name); return k ? KIT_SLOTS.find(s => s.key === k).short : '—'; };

  function cellEl(r, i) {
    const row = plan.rows[r];
    const num = (bank + r) * 16 + KIT_SLOTS[i].pad;
    if (!isKitSlot(num)) return h('td', { class: 'kp-cell off', title: 'This trigger is not set to Normal' }, 'ctl');
    const f = row.cells[i];
    const old = tracks.get(num);
    const td = h('td', {
      class: 'kp-cell' + (f ? ' has' : '') + (f && old ? ' repl' : ''),
      title: (f ? `${folderOf(f) ? folderOf(f) + '/' : ''}${f.name}` : 'empty') + (old ? `\nreplaces “${old.name}”` : '') + '\nClick to change',
    }, f ? f.name.replace(/\.[^.]+$/, '') : h('span', { class: 'muted' }, old ? `keep ${old.name}` : '—'));
    td.addEventListener('click', () => {
      if (td.querySelector('select')) return;
      const pool = row.folder != null ? files.filter(x => folderOf(x) === row.folder) : files;
      const key = KIT_SLOTS[i].key;
      const ordered = [...pool].sort((x, y) => (classify(y.name) === key) - (classify(x.name) === key) || byName(x, y));
      const sel = h('select', {
        onchange: e => {
          const v = +e.target.value;
          const pick = v >= 0 ? files[v] : null;
          if (pick) for (const rr of plan.rows) rr.cells = rr.cells.map(c => (c === pick ? null : c)); // a file sits on one pad only
          row.cells[i] = pick;
          plan.leftovers = files.filter(x => !plan.rows.some(rr => rr.cells.includes(x)));
          draw();
        },
        onblur: () => draw(),
      },
        h('option', { value: -1, selected: !f }, '(empty)'),
        ordered.map(x => h('option', { value: files.indexOf(x), selected: x === f }, `${x.name} · ${tag(x)}`)));
      td.replaceChildren(sel);
      sel.focus();
    });
    return td;
  }

  function draw() {
    const placedCount = plan.rows.reduce((n, r) => n + r.cells.filter(Boolean).length, 0);
    body.replaceChildren(
      h('p', null, `${placedCount} of ${files.length} samples placed${plan.rows.length > 1 ? ` across banks ${bank}–${bank + plan.rows.length - 1}` : ` in bank ${bank}`}. Click a cell to change it. Nothing is imported until you confirm.`),
      h('div', { class: 'kp-wrap' }, h('table', { class: 'kp' },
        h('thead', null, h('tr', null, h('th', null, 'Bank'), KIT_SLOTS.map(s => h('th', null, h('span', null, s.pad), ' ', s.short)))),
        h('tbody', null, plan.rows.map((row, r) => h('tr', null,
          h('th', { class: 'kp-bank' }, h('strong', null, `B${bank + r}`), h('span', { class: 'muted small' }, row.label)),
          KIT_SLOTS.map((_, i) => cellEl(r, i))))))),
      h('div', { class: 'toggles col' },
        folders.size > 1 ? toggle(`One bank per folder (${folders.size} folders${folders.size > maxBanks ? `, first ${maxBanks} used` : ''})`, opts.perFolder, v => { opts.perFolder = v; replan(); draw(); }) : null,
        !opts.perFolder ? toggle(`Same kind of sample continues on the same pad in the next banks (max ${maxBanks} banks)`, opts.spread, v => { opts.spread = v; replan(); draw(); }) : null,
        toggle(`Import the rest to the Inbox (${plan.leftovers.length})`, opts.inboxRest, v => { opts.inboxRest = v; })),
      h('p', { class: 'muted small' }, '↻ = replaces the sample already on that pad (it moves to the Inbox; undo with ⌘Z).'));
  }
  draw();

  const ok = await modal({
    title: `Place ${files.length} samples on pads 1–8`,
    wide: true,
    body,
    actions: [{ label: 'Cancel', value: false }, { label: 'Place samples', value: true, primary: true }],
  });
  if (!ok) return null;

  const out = [];
  plan.rows.forEach((row, r) => row.cells.forEach((f, i) => {
    const num = (bank + r) * 16 + KIT_SLOTS[i].pad;
    if (f && isKitSlot(num)) out.push({ file: f, num });
  }));
  if (opts.inboxRest) {
    const placed = new Set(out.map(o => o.file));
    for (const f of files) if (!placed.has(f)) out.push({ file: f, num: null });
  }
  return out;
}

export function slotFor(n) { return n >= 1 && n <= 8 ? KIT_SLOTS[n - 1] : null; }
