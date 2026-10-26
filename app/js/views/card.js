// SD Card Doctor: inspect an existing card the way Tsunami sees it, repair, or import.

import { h, fmtBytes, fmtTime, pad4 } from '../util.js';
import { state, emit, update, newTrack, replaceProject, newProject } from '../state.js';
import { inspectWav, rewrapPcm16, encodeWav16 } from '../wav.js';
import { parseTrackFileName, labelFromSourceName } from '../naming.js';
import { parseIni, buildIni } from '../ini.js';
import { decodeBytes, renderChannels } from '../audio.js';
import { defaultEdits } from '../state.js';
import { ingestFile, applyIni } from '../importer.js';
import { canWriteFolders, MANIFEST } from '../export.js';
import { startJob, toast, modal, confirmModal, badge, icon, toggle } from '../ui.js';
import { downloadBlob } from '../util.js';
import { ZipWriter } from '../zip.js';

const JUNK = /^(\._.*|\.DS_Store|\.Spotlight-V100|\.Trashes|\.fseventsd|\.TemporaryItems|System Volume Information)$/;

let card = null; // { name, dir?, files: [{name, file, handle?}], subWavs, junk, report }

async function collectFromHandle(dir) {
  const files = [], junk = [], subWavs = [];
  for await (const [name, hnd] of dir.entries()) {
    if (JUNK.test(name)) { junk.push({ name, kind: hnd.kind }); continue; }
    if (hnd.kind === 'file') files.push({ name, handle: hnd, file: await hnd.getFile() });
    else {
      for await (const [n2, h2] of hnd.entries()) if (h2.kind === 'file' && /\.wav$/i.test(n2) && !n2.startsWith('._')) subWavs.push(`${name}/${n2}`);
    }
  }
  return { name: dir.name, dir, files, junk, subWavs };
}

function collectFromInput(fileList) {
  const files = [], junk = [], subWavs = [];
  let root = '';
  for (const f of fileList) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    root = parts[0];
    const rel = parts.slice(1);
    if (rel.some(p => JUNK.test(p))) { if (rel.length === 1) junk.push({ name: rel[0], kind: 'file' }); continue; }
    if (rel.length === 1) files.push({ name: rel[0], file: f });
    else if (/\.wav$/i.test(rel[rel.length - 1])) subWavs.push(rel.join('/'));
  }
  return { name: root, dir: null, files, junk, subWavs };
}

async function analyzeCard(c) {
  const job = startJob('Scanning card', c.files.length);
  const wavs = [], other = [];
  let ini = null, hex = false, manifest = false;
  for (const f of c.files) {
    if (/\.wav$/i.test(f.name)) {
      const info = await inspectWav(f.file);
      const parsed = parseTrackFileName(f.name);
      wavs.push({ ...f, info, parsed });
    } else if (/^tsunami\.ini$/i.test(f.name)) {
      ini = { name: f.name, text: await f.file.text() };
      ini.parsed = parseIni(ini.text);
    } else if (/^tsunamix\.hex$/i.test(f.name)) hex = true;
    else if (f.name === MANIFEST) manifest = true;
    else other.push(f.name);
    job.tick(1, f.name);
  }
  job.end();
  wavs.sort((a, b) => (a.parsed?.num ?? 1e9) - (b.parsed?.num ?? 1e9) || a.name.localeCompare(b.name));
  const byNum = new Map();
  for (const w of wavs) if (w.parsed?.valid) (byNum.get(w.parsed.num) || byNum.set(w.parsed.num, []).get(w.parsed.num)).push(w);
  const dupes = [...byNum.values()].filter(l => l.length > 1);
  const chCounts = { 1: 0, 2: 0 };
  for (const w of wavs) if (w.info.fmt && w.parsed?.valid) chCounts[w.info.fmt.channels] = (chCounts[w.info.fmt.channels] || 0) + 1;
  const mode = ini?.parsed.mode || state.project.mode;
  const wantCh = mode === 'mono' ? 1 : 2;
  for (const w of wavs) {
    w.issues = [...w.info.problems];
    if (!w.parsed) w.issues.push({ sev: 'warn', msg: 'Name doesn\'t start with a number — Tsunami ignores this file.' });
    else if (!w.parsed.valid) w.issues.push({ sev: 'error', msg: 'Track number must be 1–4096.' });
    if (w.parsed?.midi && !w.parsed.midi.upper) w.issues.push({ sev: 'warn', msg: `Lower-case MIDI flag “${w.parsed.midi.raw}” — use upper case (_L/_S).` });
    if (w.parsed?.midi && mode === 'stereo' && w.parsed.midi.out > 4) w.issues.push({ sev: 'error', msg: `MIDI output ${w.parsed.midi.out} doesn't exist in stereo mode.` });
    if (w.info.fmt && w.info.fmt.channels <= 2 && w.info.fmt.channels !== wantCh) w.issues.push({ sev: 'error', code: 'channels', msg: `${w.info.fmt.channels === 1 ? 'Mono' : 'Stereo'} file, but the card is set up for ${mode} firmware — it won't play.` });
    if (w.parsed?.valid && byNum.get(w.parsed.num).length > 1) w.issues.push({ sev: 'error', msg: `Track number ${w.parsed.num} is used by ${byNum.get(w.parsed.num).length} files — only one will play.` });
    w.sev = w.issues.some(i => i.sev === 'error') ? 'error' : w.issues.some(i => i.sev === 'warn') ? 'warn' : 'ok';
    w.repairable = w.info.fmt && w.issues.some(i => i.code === 'meta' || i.code === 'format' || i.code === 'channels');
    w.monoToStereo = mode === 'stereo' && w.info.fmt?.channels === 1;
  }
  c.report = { wavs, ini, hex, manifest, other, dupes, mode, chCounts, modeFromIni: !!ini?.parsed.mode };
  return c;
}

async function openCard() {
  if (canWriteFolders()) {
    try {
      const dir = await window.showDirectoryPicker({ id: 'tsunami-sd', mode: 'read' });
      card = await analyzeCard(await collectFromHandle(dir));
    } catch (e) { if (e.name !== 'AbortError') toast(e.message, { kind: 'error' }); return; }
  } else {
    const input = h('input', { type: 'file', webkitdirectory: true, multiple: true });
    const files = await new Promise(r => { input.onchange = () => r([...input.files]); input.click(); });
    if (!files.length) return;
    card = await analyzeCard(collectFromInput(files));
  }
  emit('card');
}

// Used by tests/e2e.mjs to examine a set of Files as if they were a card's root folder.
export async function loadCardFromFiles(files, name = 'test card') {
  card = await analyzeCard({ name, dir: null, files: files.map(f => ({ name: f.name, file: f })), junk: [], subWavs: [] });
  emit('card');
  return card.report;
}

async function rescan() { if (card?.dir) { card = await analyzeCard(await collectFromHandle(card.dir)); emit('card'); } }

async function ensureWrite() {
  if (!card?.dir) { toast('Open the card with Chrome/Edge to make changes.', { kind: 'warn' }); return false; }
  const perm = await card.dir.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') { toast('Write permission was not granted.', { kind: 'warn' }); return false; }
  return true;
}

async function convertOne(w, mode) {
  const f = w.info.fmt;
  if (f.format === 1 && f.bits === 16 && f.rate === 44100 && f.channels === (mode === 'mono' ? 1 : 2)) return rewrapPcm16(w.file, w.info);
  const d = await decodeBytes(await w.file.arrayBuffer());
  const r = renderChannels({ edits: { ...defaultEdits(), norm: 'none' } }, d, { mode, processing: { norm: 'none', dither: true } });
  return encodeWav16(r.channels).bytes;
}

// dest: 'inplace' overwrites on the card, 'folder' writes copies elsewhere, 'zip' downloads copies.
async function repairFiles(list, { title } = {}) {
  if (!list.length) return;
  const mode = card.report.mode;
  const canFolder = canWriteFolders();
  const dest = await modal({
    title: title || `Repair ${list.length} file${list.length === 1 ? '' : 's'}`,
    body: h('div', null,
      h('p', null, `Each file becomes 44.1 kHz 16-bit ${mode} PCM with a clean header, keeping its name. 16-bit 44.1 kHz files with the right channel count are copied losslessly; mono → stereo puts the same signal on L and R.`),
      h('p', { class: 'muted small' }, 'Overwriting is permanent — keep a backup of the card, or write copies instead.')),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Download ZIP of copies', value: 'zip' },
      canFolder ? { label: 'Copies to another folder…', value: 'folder' } : null,
      card.dir ? { label: 'Overwrite in place', value: 'inplace', danger: true } : null,
    ].filter(Boolean),
  });
  if (!dest) return;
  let outDir = null, zip = null;
  if (dest === 'inplace' && !(await ensureWrite())) return;
  if (dest === 'folder') {
    try { outDir = await window.showDirectoryPicker({ id: 'tsunami-convert', mode: 'readwrite' }); } catch { return; }
  }
  if (dest === 'zip') zip = new ZipWriter();
  const job = startJob('Converting', list.length);
  let done = 0;
  for (const w of list) {
    if (job.cancelled) break;
    try {
      const bytes = await convertOne(w, mode);
      if (zip) zip.add(w.name, bytes);
      else {
        const fh = outDir ? await outDir.getFileHandle(w.name, { create: true }) : w.handle;
        const wr = await fh.createWritable();
        await wr.write(bytes); await wr.close();
      }
      done++;
    } catch (e) { toast(`${w.name}: ${e.message}`, { kind: 'error' }); }
    job.tick(1, w.name);
  }
  job.end();
  if (zip) downloadBlob(zip.blob(), `${card.name || 'card'}-converted.zip`);
  toast(`Converted ${done} file${done === 1 ? '' : 's'}${outDir ? ` into “${outDir.name}”` : zip ? ' (ZIP downloaded)' : ''}.`, { kind: 'ok' });
  if (dest === 'inplace') rescan();
}

async function cleanJunk() {
  if (!(await ensureWrite())) return;
  let n = 0;
  for (const j of card.junk) {
    try { await card.dir.removeEntry(j.name, { recursive: j.kind === 'directory' }); n++; } catch { /* some system folders are protected */ }
  }
  toast(`Removed ${n} item${n === 1 ? '' : 's'}.`, { kind: 'ok' });
  rescan();
}

async function writeIniToCard() {
  if (!(await ensureWrite())) return;
  const fh = await card.dir.getFileHandle('tsunami.ini', { create: true });
  const w = await fh.createWritable(); await w.write(buildIni(state.project)); await w.close();
  toast('tsunami.ini written from the current project.', { kind: 'ok' });
  rescan();
}

async function importCard() {
  const r = card.report;
  const usable = r.wavs.filter(w => w.parsed?.valid);
  let replace = state.project.tracks.length === 0;
  const ok = await modal({
    title: 'Import card into project',
    body: h('div', null,
      h('p', null, `${usable.length} numbered WAV file${usable.length === 1 ? '' : 's'}${r.ini ? ' and tsunami.ini' : ''} will be copied into the project. Files that fail to decode are skipped.`),
      state.project.tracks.length ? toggle('Replace the current project (otherwise merge; existing numbers win)', replace, v => { replace = v; }) : null),
    actions: [{ label: 'Cancel', value: false }, { label: 'Import', value: true, primary: true }],
  });
  if (!ok) return;
  if (replace) replaceProject({ ...newProject(card.name || 'SD card'), mode: r.mode });
  if (r.ini) applyIni(r.ini.parsed);
  const job = startJob('Importing card', usable.length);
  const created = [];
  for (const w of usable) {
    if (job.cancelled) break;
    try {
      const res = await ingestFile(w.file);
      created.push({ w, res });
    } catch { /* skipped */ }
    job.tick(1, w.name);
  }
  job.end();
  update(p => {
    const taken = new Set(p.tracks.map(t => t.num));
    for (const { w, res } of created) {
      const t = newTrack({ name: labelFromSourceName(w.name), sourceId: res.sourceId, sourceName: w.name, info: res.info });
      if (w.parsed.midi) t.midi = { loop: w.parsed.midi.loop, out: w.parsed.midi.out };
      t.edits.norm = 'none'; // keep card levels as they are
      t.num = taken.has(w.parsed.num) ? null : w.parsed.num;
      taken.add(t.num);
      p.tracks.push(t);
    }
    if (!replace) return;
    p.mode = r.mode;
  }, { reason: 'import' });
  toast(`Imported ${created.length} tracks from the card. Normalization is off for these so levels match the card.`, { kind: 'ok', ms: 6000 });
  state.ui.view = 'pads'; emit('view');
}

function downloadReport() {
  const r = card.report;
  const lines = [`SD card report: ${card.name}`, `Mode: ${r.mode}${r.modeFromIni ? ' (from tsunami.ini)' : ' (guessed from files)'}`, ''];
  for (const w of r.wavs) lines.push(`${w.sev.toUpperCase().padEnd(5)}  ${w.name}  [${w.info.chunkSummary}]  ${w.issues.map(i => i.msg).join(' | ')}`);
  if (r.ini) lines.push('', '--- tsunami.ini ---', r.ini.text);
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/plain' }), 'sd-card-report.txt');
}

export function renderCard() {
  const intro = h('div', { class: 'empty-state big' },
    h('h3', null, 'SD Card Doctor'),
    h('p', null, 'Open a Tsunami SD card (or any folder) to see exactly what Tsunami will see: track numbers, duplicates, wrong formats, hidden metadata chunks that stop files from playing, and stray macOS files. Works on sample-library folders too: convert every mono file to stereo, as copies or in place.'),
    h('button', { class: 'btn primary', onclick: openCard }, icon('folder'), 'Open SD card…'),
    !canWriteFolders() ? h('p', { class: 'muted small' }, 'This browser can only read folders. Use Chrome or Edge to repair files in place.') : null);
  if (!card) return h('div', { class: 'view card-view' }, intro);

  const r = card.report;
  const errors = r.wavs.filter(w => w.sev === 'error');
  const repairable = r.wavs.filter(w => w.repairable);
  const monoFiles = r.wavs.filter(w => w.monoToStereo);
  const valid = r.wavs.filter(w => w.parsed?.valid && w.sev !== 'error');
  const total = r.wavs.reduce((s, w) => s + w.info.size, 0);
  const iniMismatch = r.ini?.parsed.mode && r.ini.parsed.mode !== state.project.mode;

  return h('div', { class: 'view card-view' },
    h('div', { class: 'toolbar' },
      h('strong', null, card.name || 'Card'),
      h('span', { class: 'muted' }, `${r.wavs.length} WAV · ${fmtBytes(total)}`),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: openCard }, icon('folder'), 'Open another…'),
      card.dir ? h('button', { class: 'btn', onclick: rescan }, 'Rescan') : null,
      h('button', { class: 'btn', onclick: downloadReport }, 'Report'),
      h('button', { class: 'btn primary', onclick: importCard, disabled: !r.wavs.length }, 'Import into project')),
    h('div', { class: 'card-summary' },
      sumTile(valid.length, 'tracks Tsunami will play', valid.length ? 'ok' : ''),
      sumTile(errors.length, 'files with errors', errors.length ? 'bad' : 'ok'),
      sumTile(r.dupes.length, 'duplicate numbers', r.dupes.length ? 'bad' : 'ok'),
      sumTile(r.mode, r.modeFromIni ? 'mode from tsunami.ini' : 'mode from project', ''),
      sumTile(card.junk.length, 'macOS / system files', card.junk.length ? 'warn' : 'ok'),
      sumTile(card.subWavs.length, 'WAVs in subfolders (ignored)', card.subWavs.length ? 'warn' : 'ok')),
    h('div', { class: 'row wrap' },
      monoFiles.length ? h('button', { class: 'btn primary', onclick: () => repairFiles(monoFiles, { title: `Convert ${monoFiles.length} mono file${monoFiles.length === 1 ? '' : 's'} to stereo` }) }, `Convert ${monoFiles.length} mono → stereo`) : null,
      repairable.length ? h('button', { class: 'btn', onclick: () => repairFiles(repairable) }, `Repair all ${repairable.length} fixable file${repairable.length === 1 ? '' : 's'}…`) : null,
      card.junk.length ? h('button', { class: 'btn', onclick: cleanJunk, title: card.junk.map(j => j.name).join('\n') }, `Remove ${card.junk.length} macOS/system item${card.junk.length === 1 ? '' : 's'}`) : null,
      card.dir ? h('button', { class: 'btn', onclick: writeIniToCard }, 'Write project tsunami.ini to card') : null),
    h('div', { class: 'card-notes' },
      r.ini ? h('details', null, h('summary', null, `tsunami.ini · ${r.ini.parsed.triggers.length} trigger setting(s)${iniMismatch ? ` · ⚠ ${r.ini.parsed.mode} but project is ${state.project.mode}` : ''}`),
        r.ini.parsed.warnings.map(w => h('p', { class: 'warn small' }, w)), h('pre', { class: 'ini' }, r.ini.text))
        : h('p', { class: 'muted small' }, 'No tsunami.ini on the card — Tsunami runs with defaults. Files are checked against the project mode (' + state.project.mode + ').'),
      r.hex ? h('p', { class: 'small' }, badge('tsunamix.hex', 'pos'), ' firmware file present. It is only flashed when you hold USER and press RESET — leaving it on the card is harmless.') : null,
      card.subWavs.length ? h('p', { class: 'small warn' }, `Tsunami only reads the root folder. Ignored: ${card.subWavs.slice(0, 8).join(', ')}${card.subWavs.length > 8 ? '…' : ''}`) : null),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Track'), h('th', null, 'File'), h('th', null, 'Format'), h('th', null, 'Chunks'), h('th', { class: 'r' }, 'Size'), h('th', { class: 'r' }, 'Length'), h('th', null, 'Findings'))),
      h('tbody', null, r.wavs.map(w => {
        const f = w.info.fmt;
        const dur = f && f.blockAlign ? w.info.dataSize / f.blockAlign / f.rate : null;
        return h('tr', { class: 'sev-' + w.sev },
          h('td', null, h('span', { class: 'sev-dot ' + (w.sev === 'ok' ? 'ok' : w.sev) }, w.sev === 'ok' ? '✓' : icon('warn'))),
          h('td', { class: 'mono' }, w.parsed?.valid ? pad4(w.parsed.num) + (w.parsed.midi ? ` ${w.parsed.midi.loop ? 'L' : 'S'}${w.parsed.midi.out}` : '') : '—'),
          h('td', { class: 'c-src' }, w.name),
          h('td', { class: 'mono small' }, f ? `${f.formatName} ${f.bits}-bit ${(f.rate / 1000).toFixed(1)}k ${f.channels === 1 ? 'mono' : f.channels === 2 ? 'stereo' : f.channels + 'ch'}` : '—'),
          h('td', { class: 'mono small' }, w.info.chunks.map((c, i) => h('span', { class: 'chunk' + (c.id !== 'fmt ' && c.id !== 'data' && i < w.info.chunks.findIndex(x => x.id === 'data') ? ' bad' : '') }, c.id.trim()))),
          h('td', { class: 'r mono' }, fmtBytes(w.info.size)),
          h('td', { class: 'r mono' }, dur != null ? fmtTime(dur) : '—'),
          h('td', { class: 'small' }, w.issues.length ? w.issues.map(i => h('div', { class: i.sev }, i.msg)) : h('span', { class: 'muted' }, 'Tsunami-safe')));
      })))));
}

function sumTile(value, label, kind) {
  return h('div', { class: 'sum-tile ' + kind }, h('div', { class: 'sum-v' }, value), h('div', { class: 'sum-l' }, label));
}
