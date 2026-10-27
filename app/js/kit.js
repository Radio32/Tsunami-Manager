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

// Pure suggestion: which file goes to which of the 8 slots, what's left over.
export function suggestKit(files) {
  const sorted = [...files].sort((a, b) => collator.compare(a.name, b.name));
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

/**
 * Show the placement dialog for files dropped on pads 1–8 of `bank`.
 * Resolves to [{ file, num|null }] (null = Inbox) or null when cancelled.
 */
export async function kitDialog(files, bank) {
  const tracks = trackByNum();
  const sug = suggestKit(files);
  const choice = sug.slots.map(f => (f ? files.indexOf(f) : -1));
  let spread = false, inboxRest = true;

  const opts = files.map((f, i) => {
    const k = classify(f.name);
    const tag = k ? KIT_SLOTS.find(s => s.key === k).short : '—';
    return [i, `${f.name}  ·  ${tag}`];
  });

  const rows = KIT_SLOTS.map((s, i) => {
    const num = bank * 16 + s.pad;
    const playable = isKitSlot(num);
    const current = tracks.get(num);
    const selEl = h('select', {
      disabled: !playable,
      onchange: e => { choice[i] = +e.target.value; },
    },
      h('option', { value: -1, selected: choice[i] === -1 }, current ? `(keep “${current.name}”)` : '(leave empty)'),
      opts.map(([v, l]) => h('option', { value: v, selected: v === choice[i] }, l)));
    return h('tr', { class: 'kit-row' },
      h('td', { class: 'mono' }, s.pad),
      h('td', null, h('strong', null, s.label)),
      h('td', null, playable ? selEl : h('span', { class: 'muted small' }, 'trigger is not set to Normal')),
      h('td', { class: 'muted small' }, current ? `replaces “${current.name}”` : ''));
  });

  const unmatchedCount = sug.unmatched.length + [...sug.extras.values()].reduce((s, l) => s + l.length, 0);
  const ok = await modal({
    title: `Place ${files.length} samples on pads 1–8 (bank ${bank})`,
    wide: true,
    body: h('div', null,
      h('p', null, 'Suggested from the file names. Change any pad before placing — nothing is imported until you confirm.'),
      h('table', { class: 'grid kit-table' },
        h('thead', null, h('tr', null, h('th', null, 'Pad'), h('th', null, 'Slot'), h('th', null, 'Sample'), h('th', null, ''))),
        h('tbody', null, rows)),
      unmatchedCount ? h('div', { class: 'toggles col' },
        sug.extras.size ? toggle('Extra matches go to the same pad in the next banks (kick 2 → bank ' + (bank + 1) + ' pad 1 …)', spread, v => { spread = v; }) : null,
        toggle(`Import samples that don't get a pad to the Inbox (${unmatchedCount})`, inboxRest, v => { inboxRest = v; })) : null),
    actions: [{ label: 'Cancel', value: false }, { label: 'Place samples', value: true, primary: true }],
  });
  if (!ok) return null;

  const out = [];
  const placed = new Set();
  choice.forEach((fi, i) => {
    if (fi < 0 || placed.has(files[fi])) return;
    placed.add(files[fi]);
    out.push({ file: files[fi], num: bank * 16 + KIT_SLOTS[i].pad });
  });
  if (spread) {
    const taken = new Set([...tracks.keys(), ...out.map(o => o.num)]);
    for (const [i, list] of sug.extras) {
      let b = bank + 1;
      for (const f of list) {
        if (placed.has(f)) continue;
        // Perc extras alternate between pads 6 and 7.
        const pads = KIT_SLOTS[i].key === 'perc' ? [6, 7] : [KIT_SLOTS[i].pad];
        let num = null;
        for (; b < 256 && num == null; b++) {
          for (const pad of pads) { const n = b * 16 + pad; if (!taken.has(n) && isKitSlot(n)) { num = n; break; } }
          if (num != null) break;
        }
        if (num == null) break;
        taken.add(num); placed.add(f);
        out.push({ file: f, num });
      }
    }
  }
  if (inboxRest) for (const f of files) if (!placed.has(f)) out.push({ file: f, num: null });
  return out;
}

export function slotFor(n) { return n >= 1 && n <= 8 ? KIT_SLOTS[n - 1] : null; }
