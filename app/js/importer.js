// Importing audio files, tsunami.ini files and saved project bundles.

import { AUDIO_EXT, MAX_TRACK } from './constants.js';
import { decodeBytes, analyze, overview, cacheDecoded } from './audio.js';
import { putSource } from './store.js';
import { update, newTrack, trackByNum, nextFreeNum, select, replaceProject, isKitSlot } from './state.js';
import { kitDialog, byName } from './kit.js';
import { parseTrackFileName, labelFromSourceName } from './naming.js';
import { parseIni } from './ini.js';
import { readZip } from './zip.js';
import { uid, h } from './util.js';
import { startJob, toast, modal } from './ui.js';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Turn a file into a stored source + analysis; does not touch the project.
export async function ingestFile(file) {
  const data = await file.arrayBuffer();
  const d = await decodeBytes(data);
  const id = uid();
  await putSource({ id, name: file.name, type: file.type, size: file.size, data, addedAt: Date.now() });
  cacheDecoded(id, d);
  const a = analyze(d.channels);
  return {
    sourceId: id,
    info: {
      duration: d.channels[0].length / 44100,
      channels: d.origChannels,
      origRate: d.origRate,
      bytes: file.size,
      peakDb: a.peakDb,
      rmsDb: a.rmsDb,
      wave: overview(d.channels),
    },
  };
}

/**
 * placement:
 *   { at: n }        first file replaces track n, further files fill free numbers after n
 *   { useNames: true } honour leading numbers in file names when free
 *   default           files go to the inbox (unnumbered)
 */
export async function importFiles(fileList, placement = {}) {
  const files = [...fileList];
  const iniFile = files.find(f => /^tsunami\.ini$/i.test(f.name) || /\.ini$/i.test(f.name));
  const zipFile = files.find(f => /\.(zip|ntm)$/i.test(f.name));
  if (zipFile) return openProjectBundle(zipFile);
  if (iniFile) await importIniFile(iniFile);

  const audio = audioOnly(files);
  if (!audio.length) {
    if (!iniFile) toast('No audio files found in the drop.', { kind: 'warn' });
    return [];
  }
  const { results, failed } = await ingestAll(audio);

  let firstId = null;
  update(p => {
    const taken = trackByNum();
    let cursor = placement.at ?? 1;
    results.forEach((r, i) => {
      const parsed = parseTrackFileName(r.file.name);
      const t = newTrack({
        name: labelFromSourceName(r.file.name),
        sourceId: r.sourceId, sourceName: r.file.name, info: r.info,
      });
      if (parsed?.midi) t.midi = { loop: parsed.midi.loop, out: parsed.midi.out };
      if (placement.at != null) {
        if (i === 0) {
          const old = taken.get(cursor);
          if (old) old.num = null; // displaced into the inbox
          t.num = cursor;
        } else {
          t.num = nextFreeNum(cursor, taken);
        }
        if (t.num != null) { taken.set(t.num, t); cursor = t.num + 1; }
      } else if (placement.useNames && parsed?.valid && !taken.has(parsed.num)) {
        t.num = parsed.num;
        taken.set(t.num, t);
      } else if (placement.useNames || placement.autoNumber) {
        t.num = nextFreeNum(placement.autoNumber ?? 1, taken);
        if (t.num != null) taken.set(t.num, t);
      }
      if (t.num != null && t.num > MAX_TRACK) t.num = null;
      p.tracks.push(t);
      firstId ??= t.id;
    });
  }, { reason: 'import' });
  if (firstId) select(firstId);
  const inbox = results.length && placement.at == null && !placement.useNames && !placement.autoNumber;
  toast(`Imported ${results.length} file${results.length === 1 ? '' : 's'}${inbox ? ' into the Inbox' : ''}.`, { kind: 'ok' });
  showFailed(failed);
  return results;
}

async function ingestAll(files) {
  const job = startJob('Importing', files.length);
  const results = [], failed = [];
  try {
    for (const f of files) {
      if (job.cancelled) break;
      try {
        results.push({ file: f, ...(await ingestFile(f)) });
      } catch (e) {
        console.warn(f.name, e);
        failed.push(f.name);
      }
      job.tick(1, f.name);
    }
  } finally {
    job.end();
  }
  return { results, failed };
}

function showFailed(failed) {
  if (!failed.length) return;
  modal({
    title: `${failed.length} file${failed.length === 1 ? '' : 's'} could not be decoded`,
    body: h('div', null,
      h('p', null, 'Your browser could not decode these files. Try converting them to WAV or FLAC first.'),
      h('ul', { class: 'plain' }, failed.map(n => h('li', null, n)))),
  });
}

/**
 * Files from a drop, including the contents of dropped folders (scanned recursively).
 * Each file gets `_folder` = the top-level folder it came from ('' for loose files).
 * Must be called synchronously inside the drop handler: the browser clears the
 * DataTransfer items once the handler yields.
 */
export function droppedFiles(dt) {
  const entries = [...(dt.items || [])].map(i => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null));
  if (!entries.some(e => e?.isDirectory)) {
    const files = [...dt.files];
    files.forEach(f => { f._folder = ''; });
    return Promise.resolve(files);
  }
  const loose = [...dt.files];
  return (async () => {
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      if (e.isFile) {
        const f = await new Promise((res, rej) => e.file(res, rej)).catch(() => loose[i]);
        if (f) { f._folder = ''; out.push(f); }
      } else await walk(e, e.name, out);
    }
    return out;
  })();
}

async function walk(dir, top, out, depth = 0) {
  if (depth > 8) return;
  const reader = dir.createReader();
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
    if (!batch.length) break;
    for (const e of batch) {
      if (e.name.startsWith('.')) continue;
      if (e.isFile) {
        if (!AUDIO_EXT.test(e.name)) continue;
        const f = await new Promise((res, rej) => e.file(res, rej)).catch(() => null);
        if (f) { f._folder = top; out.push(f); }
      } else await walk(e, top, out, depth + 1);
    }
  }
}

const audioOnly = files => [...files].filter(f => AUDIO_EXT.test(f.name) && !f.name.startsWith('._'))
  .sort((a, b) => collator.compare(a._folder || '', b._folder || '') || byName(a, b));

// Import with explicit numbers. A track already on a target number moves to the Inbox.
export async function importAssigned(assignments) {
  const { results, failed } = await ingestAll(assignments.map(a => a.file));
  const numOf = new Map(assignments.map(a => [a.file, a.num]));
  let firstId = null, placed = 0, inboxed = 0;
  update(p => {
    for (const r of results) {
      const num = numOf.get(r.file) ?? null;
      const t = newTrack({ name: labelFromSourceName(r.file.name), sourceId: r.sourceId, sourceName: r.file.name, info: r.info });
      const parsed = parseTrackFileName(r.file.name);
      if (parsed?.midi) t.midi = { loop: parsed.midi.loop, out: parsed.midi.out };
      if (num != null) {
        for (const old of p.tracks) if (old.num === num) old.num = null;
        t.num = num; placed++;
        firstId ??= t.id;
      } else inboxed++;
      p.tracks.push(t);
    }
  }, { reason: 'import' });
  if (firstId) select(firstId);
  if (results.length) toast(`Placed ${placed} sample${placed === 1 ? '' : 's'}${inboxed ? `, ${inboxed} to the Inbox` : ''}.`, { kind: 'ok' });
  showFailed(failed);
  return results;
}

/**
 * Files dropped on (or browsed for) a pad.
 *  - one file: goes exactly on that pad
 *  - several files on pads 1–8: smart kit placement by name (Kick, Snare, OHH, CHH, Clap, Perc 1, Perc 2, Cym)
 *  - several files on pads 9+: filled onto that pad and the following ones in name order; overflow to the Inbox
 */
export async function importToPad(fileList, num) {
  const files = [...fileList];
  if (files.some(f => /\.(zip|ntm|ini)$/i.test(f.name))) return importFiles(files, { at: num });
  const audio = audioOnly(files);
  if (!audio.length) { toast('No audio files found.', { kind: 'warn' }); return []; }
  const pad = ((num - 1) % 16) + 1, bank = Math.floor((num - 1) / 16);
  if (audio.length === 1) return importAssigned([{ file: audio[0], num }]);
  if (pad <= 8) {
    const plan = await kitDialog(audio, bank);
    return plan ? importAssigned(plan) : [];
  }
  const slots = [];
  for (let k = pad; k <= 16; k++) if (isKitSlot(bank * 16 + k)) slots.push(bank * 16 + k);
  const plan = audio.map((file, i) => ({ file, num: slots[i] ?? null }));
  const over = plan.filter(x => x.num == null).length;
  if (over) toast(`Only ${slots.length} pad${slots.length === 1 ? '' : 's'} from pad ${pad} up — ${over} sample${over === 1 ? '' : 's'} go to the Inbox.`, { kind: 'warn', ms: 5000 });
  return importAssigned(plan);
}

export async function importIniFile(file) {
  const text = await file.text();
  const parsed = parseIni(text);
  const ok = await modal({
    title: `Import ${file.name}?`,
    body: h('div', null,
      h('p', null, `Found ${parsed.triggers.length} trigger setting${parsed.triggers.length === 1 ? '' : 's'}` +
        (parsed.mode ? ` for the ${parsed.mode} firmware.` : '.')),
      parsed.warnings.length ? h('ul', { class: 'plain warn' }, parsed.warnings.map(w => h('li', null, w))) : null,
      h('p', { class: 'muted' }, 'This replaces the trigger, output and MIDI settings in the current project.')),
    actions: [{ label: 'Cancel', value: false }, { label: 'Replace settings', value: true, primary: true }],
  });
  if (!ok) return false;
  applyIni(parsed);
  toast('Settings imported from ' + file.name, { kind: 'ok' });
  return true;
}

export function applyIni(parsed) {
  update(p => {
    if (parsed.mode) p.mode = parsed.mode;
    p.global = parsed.global;
    p.triggers = p.triggers.map(t => parsed.triggers.find(x => x.num === t.num) || { ...t, ...defaultTriggerFor(t.num) });
  }, { reason: 'ini' });
}

function defaultTriggerFor(num) {
  return { num, func: 1, type: 0, iface: 0, invert: false, retrigger: true, loop: false, poly: true, lock: false, gain: 0, output: 0, low: 0, high: 0 };
}

// ---------- project bundles (.ntm.zip) ----------

export async function openProjectBundle(file) {
  let entries;
  try { entries = await readZip(file); } catch (e) { toast(e.message, { kind: 'error' }); return; }
  const pj = entries.find(e => e.name === 'project.json');
  if (!pj) { toast('This ZIP is not a Nutella Tsunami Manager project.', { kind: 'error' }); return; }
  const project = JSON.parse(new TextDecoder().decode(pj.data));
  const job = startJob('Loading project audio', project.tracks.length);
  const srcEntries = new Map(entries.filter(e => e.name.startsWith('sources/')).map(e => [e.name.slice(8).split('/')[0], e]));
  for (const t of project.tracks) {
    const e = srcEntries.get(t.sourceId);
    if (e) {
      const name = e.name.split('/').slice(2).join('/') || t.sourceName;
      await putSource({ id: t.sourceId, name, size: e.data.length, data: e.data.slice().buffer, addedAt: Date.now() });
    }
    job.tick();
  }
  job.end();
  replaceProject(project);
  toast(`Opened “${project.name}”.`, { kind: 'ok' });
}

