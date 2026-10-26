// Rendering the project to an SD card folder (File System Access API) or a ZIP.

import { getDecoded, renderChannels, renderKey } from './audio.js';
import { encodeWav16, inspectWav } from './wav.js';
import { buildFileName, parseTrackFileName } from './naming.js';
import { buildIni } from './ini.js';
import { ZipWriter, crc32 } from './zip.js';
import { getSource } from './store.js';
import { state, update } from './state.js';
import { startJob, toast, modal } from './ui.js';
import { downloadBlob, h, fmtBytes } from './util.js';

export const MANIFEST = '_ntm_manifest.json';
export const canWriteFolders = () => 'showDirectoryPicker' in window;

export function planExport(project) {
  return project.tracks
    .filter(t => t.num != null && t.sourceId)
    .sort((a, b) => a.num - b.num)
    .map(t => ({ track: t, fileName: buildFileName(t, project.naming, project.mode) }));
}

async function renderFile(track, project) {
  const d = await getDecoded(track.sourceId);
  const r = renderChannels(track, d, project);
  const { bytes, clipped } = encodeWav16(r.channels, { dither: project.processing.dither });
  return { bytes, clipped, peakDb: r.peakDb, duration: r.duration };
}

function recordRenders(results) {
  if (!results.length) return;
  update(p => {
    for (const r of results) {
      const t = p.tracks.find(x => x.id === r.id);
      if (t?.info) t.info.lastRender = { peakDb: r.peakDb, clipped: r.clipped, at: Date.now() };
    }
  }, { undo: false, reason: 'render' });
}

async function listRoot(dir) {
  const out = new Map();
  for await (const [name, handle] of dir.entries()) out.set(name, handle);
  return out;
}

async function readManifest(entries) {
  const hnd = entries.get(MANIFEST);
  if (!hnd || hnd.kind !== 'file') return { files: {} };
  try { return JSON.parse(await (await hnd.getFile()).text()); } catch { return { files: {} }; }
}

async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
  return fh;
}

export async function pickCardFolder() {
  try {
    return await window.showDirectoryPicker({ id: 'tsunami-sd', mode: 'readwrite', startIn: 'desktop' });
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message, { kind: 'error' });
    return null;
  }
}

export async function exportToFolder(dir, log = () => {}) {
  const project = state.project;
  if ((await dir.requestPermission?.({ mode: 'readwrite' })) === 'denied') throw new Error('Write permission denied');
  const plan = planExport(project);
  const planned = new Set(plan.map(p => p.fileName.toLowerCase()));
  const plannedNums = new Set(plan.map(p => p.track.num));
  const entries = await listRoot(dir);
  const manifest = await readManifest(entries);

  // WAVs already on the card that would collide with (same number) or be left over from earlier exports.
  const conflicts = [], orphans = [];
  for (const [name, hnd] of entries) {
    if (hnd.kind !== 'file' || !/\.wav$/i.test(name) || planned.has(name.toLowerCase())) continue;
    const p = parseTrackFileName(name);
    if (!p?.valid) continue;
    (plannedNums.has(p.num) ? conflicts : orphans).push(name);
  }
  const toDelete = [...conflicts];
  if (conflicts.length || (orphans.length && project.export.cleanOrphans)) {
    const delOrphans = project.export.cleanOrphans ? orphans : [];
    const choice = await modal({
      title: 'Existing WAV files on the card',
      wide: true,
      body: h('div', null,
        conflicts.length ? h('div', null,
          h('p', null, h('strong', null, `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} use the same track number`),
            ' as files you are writing. Tsunami would see two files with the same number and play the wrong one.'),
          h('ul', { class: 'plain scroll' }, conflicts.slice(0, 200).map(n => h('li', null, n)))) : null,
        delOrphans.length ? h('div', null,
          h('p', null, `${delOrphans.length} other numbered WAV file${delOrphans.length === 1 ? '' : 's'} are not part of this project (“Remove other tracks” is on).`),
          h('ul', { class: 'plain scroll' }, delOrphans.slice(0, 200).map(n => h('li', null, n)))) : null),
      actions: [
        { label: 'Cancel export', value: 'cancel' },
        conflicts.length ? { label: 'Keep them (not recommended)', value: 'keep' } : null,
        { label: `Delete ${conflicts.length + delOrphans.length} file${conflicts.length + delOrphans.length === 1 ? '' : 's'}`, value: 'delete', danger: true },
      ].filter(Boolean),
    });
    if (choice === 'cancel' || choice == null) return { cancelled: true };
    if (choice === 'delete') toDelete.push(...delOrphans);
    else toDelete.length = 0;
  } else if (orphans.length) {
    log(`${orphans.length} other numbered WAV file(s) on the card were left untouched.`);
  }

  for (const name of toDelete) {
    await dir.removeEntry(name);
    log(`Deleted ${name}`);
  }

  const job = startJob('Writing to card', plan.length);
  const newManifest = { app: 'Nutella Tsunami Manager', project: project.name, mode: project.mode, written: new Date().toISOString(), files: {} };
  const renders = [];
  let written = 0, skipped = 0, bytesOut = 0;
  const current = await listRoot(dir);
  try {
    for (const { track, fileName } of plan) {
      if (job.cancelled) { log('Cancelled.'); break; }
      const key = renderKey(track, project);
      const prev = manifest.files?.[fileName];
      const existing = current.get(fileName);
      if (project.export.skipUnchanged && prev?.key === key && existing?.kind === 'file') {
        const f = await existing.getFile();
        if (f.size === prev.size) {
          newManifest.files[fileName] = prev;
          skipped++; job.tick(1, `${fileName} (unchanged)`);
          continue;
        }
      }
      const r = await renderFile(track, project);
      await writeFile(dir, fileName, r.bytes);
      newManifest.files[fileName] = { key, size: r.bytes.length, crc32: crc32(r.bytes).toString(16).padStart(8, '0'), track: track.num };
      renders.push({ id: track.id, peakDb: r.peakDb, clipped: r.clipped });
      if (r.clipped) log(`⚠ ${fileName}: ${r.clipped} samples clipped`);
      written++; bytesOut += r.bytes.length;
      job.tick(1, fileName);
    }
  } finally {
    job.end();
  }
  await writeFile(dir, 'tsunami.ini', buildIni(project));
  log('Wrote tsunami.ini');
  if (project.export.writeManifest) await writeFile(dir, MANIFEST, JSON.stringify(newManifest, null, 1));
  recordRenders(renders);
  log(`Wrote ${written} file(s) (${fmtBytes(bytesOut)}), ${skipped} unchanged.`);

  const verify = await verifyFolder(dir, plan, newManifest);
  log(verify.bad.length ? `Verification found ${verify.bad.length} problem(s).` : `Verified ${verify.checked} file(s): all Tsunami-safe.`);
  for (const b of verify.bad) log(`✗ ${b}`);
  return { written, skipped, deleted: toDelete.length, verify };
}

async function verifyFolder(dir, plan, manifest) {
  const bad = [];
  let checked = 0;
  for (const { fileName } of plan) {
    try {
      const f = await (await dir.getFileHandle(fileName)).getFile();
      const info = await inspectWav(f);
      const exp = manifest.files[fileName]?.size;
      if (!info.ok) bad.push(`${fileName}: ${info.problems.map(p => p.msg).join(' ')}`);
      else if (exp && f.size !== exp) bad.push(`${fileName}: size ${f.size} ≠ ${exp}`);
      checked++;
    } catch (e) {
      bad.push(`${fileName}: ${e.message}`);
    }
  }
  return { checked, bad };
}

export async function exportZip(log = () => {}) {
  const project = state.project;
  const plan = planExport(project);
  const zip = new ZipWriter();
  const job = startJob('Rendering ZIP', plan.length);
  const renders = [];
  const lines = [];
  try {
    for (const { track, fileName } of plan) {
      if (job.cancelled) return;
      const r = await renderFile(track, project);
      zip.add(fileName, r.bytes);
      lines.push(`${crc32(r.bytes).toString(16).padStart(8, '0')}  ${String(r.bytes.length).padStart(10)}  ${fileName}`);
      renders.push({ id: track.id, peakDb: r.peakDb, clipped: r.clipped });
      job.tick(1, fileName);
    }
  } finally {
    job.end();
  }
  zip.add('tsunami.ini', buildIni(project));
  zip.add('MANIFEST.txt', `${project.name} — ${project.mode} firmware — ${new Date().toISOString()}\r\nCRC32     bytes       file\r\n${lines.join('\r\n')}\r\n`);
  recordRenders(renders);
  downloadBlob(zip.blob(), `${safeName(project.name)}-sd-card.zip`);
  log(`ZIP with ${plan.length} WAV file(s) downloaded. Unzip its contents to the root of the SD card.`);
}

export function downloadIni() {
  downloadBlob(new Blob([buildIni(state.project)], { type: 'text/plain' }), 'tsunami.ini');
}

const safeName = s => (s || 'project').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'project';

// Project bundle: project.json + original sources, for backup / moving computers.
export async function saveProjectBundle() {
  const project = state.project;
  const zip = new ZipWriter();
  zip.add('project.json', JSON.stringify(project, null, 1));
  const ids = [...new Set(project.tracks.map(t => t.sourceId).filter(Boolean))];
  const job = startJob('Packing project', ids.length);
  try {
    for (const id of ids) {
      const rec = await getSource(id);
      if (rec) zip.add(`sources/${id}/${rec.name}`, new Uint8Array(rec.data));
      job.tick();
    }
  } finally {
    job.end();
  }
  downloadBlob(zip.blob(), `${safeName(project.name)}.ntm.zip`);
  toast('Project saved as a .ntm.zip bundle.', { kind: 'ok' });
}
