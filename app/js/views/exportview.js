// Export: preflight report, options and the write-to-card / ZIP actions.

import { h, fmtBytes, fmtTime } from '../util.js';
import { state, update, select, emit } from '../state.js';
import { applyFunctionDefaults } from '../ini.js';
import { planExport, exportToFolder, exportZip, downloadIni, pickCardFolder, canWriteFolders } from '../export.js';
import { estimateBytes } from '../validate.js';
import { toggle, icon, toast } from '../ui.js';

const log = [];
let busy = false;
function addLog(s) { log.push(`${new Date().toLocaleTimeString()}  ${s}`); emit('log'); }

function groupIssues(issues) {
  // Collapse many identical info lines (e.g. "track N will be summed") into one.
  const out = [], groups = new Map();
  for (const i of issues) {
    if (i.group && i.trackId) {
      const g = groups.get(i.group) || { ...i, count: 0, ids: [] };
      g.count++; g.ids.push(i.trackId);
      groups.set(i.group, g);
    } else out.push(i);
  }
  for (const g of groups.values()) {
    if (g.count === 1) out.push(g);
    else out.push({ ...g, msg: g.group === 'downmix' ? `${g.count} stereo tracks will be summed to mono.` : g.group === 'navslot' ? `${g.count} tracks sit on bank-navigation trigger slots — no trigger can play them, only MIDI. Use “Number from…” to renumber them (it skips those slots).` : g.msg, trackId: g.ids[0] });
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
}

const FIXES = {
  dbnc: ['Set 5 ms', () => update(p => { p.global.dbnc = 5; }, { reason: 'settings' })],
  banks: ['Make T15 / T16 Bank − / +', () => update(p => {
    p.triggers[14] = applyFunctionDefaults(p.triggers[14], 13);
    p.triggers[15] = applyFunctionDefaults(p.triggers[15], 12);
  }, { reason: 'trigger' })],
  headroom: ['Peak target −6 dBFS', () => update(p => { p.processing.peakTarget = -6; p.processing.norm = 'peak'; }, { reason: 'settings' })],
};

function goTo(i) {
  if (i.trackId) { select(i.trackId); state.ui.view = 'tracks'; emit('view'); }
  else if (i.trigger) { state.ui.triggerFocus = i.trigger; state.ui.view = 'triggers'; emit('view'); }
}

async function run(kind) {
  if (busy) return;
  const errors = (state.issues || []).filter(i => i.sev === 'error');
  if (errors.length && !confirm(`There ${errors.length === 1 ? 'is 1 error' : `are ${errors.length} errors`} in the preflight. Export anyway?`)) return;
  busy = true; emit('log');
  try {
    if (kind === 'folder') {
      const dir = await pickCardFolder();
      if (!dir) return;
      addLog(`Writing to “${dir.name}”…`);
      const r = await exportToFolder(dir, addLog);
      if (r.cancelled) addLog('Export cancelled.');
      else toast(r.verify.bad.length ? 'Export finished with problems — see the log.' : 'Card ready. Eject it, insert into Nutella and press RESET.', { kind: r.verify.bad.length ? 'warn' : 'ok', ms: 6000 });
    } else {
      await exportZip(addLog);
    }
  } catch (e) {
    console.error(e);
    addLog('✗ ' + e.message);
    toast(e.message, { kind: 'error' });
  } finally {
    busy = false; emit('log');
  }
}

export function renderExport() {
  const p = state.project;
  const plan = planExport(p);
  const issues = groupIssues(state.issues || []);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const i of state.issues || []) counts[i.sev]++;
  const bytes = plan.reduce((s, x) => s + estimateBytes(x.track, p), 0);
  const dur = plan.reduce((s, x) => s + ((x.track.edits.trimEnd ?? x.track.info?.duration ?? 0) - (x.track.edits.trimStart || 0)), 0);
  const ready = counts.error === 0 && plan.length > 0;

  return h('div', { class: 'view export-view' },
    h('div', { class: 'export-grid' },
      h('section', { class: 'panel' },
        h('h3', null, 'Preflight'),
        h('div', { class: 'card-summary' },
          tile(plan.length, 'WAV files'), tile(fmtBytes(bytes), 'estimated size'), tile(fmtTime(dur), 'total audio'),
          tile(counts.error, 'errors', counts.error ? 'bad' : 'ok'), tile(counts.warn, 'warnings', counts.warn ? 'warn' : 'ok')),
        h('div', { class: 'verdict ' + (ready ? 'ok' : 'bad') },
          ready ? `Ready: ${plan.length} files for the ${p.mode} firmware, 44.1 kHz 16-bit PCM with clean headers.` :
            plan.length ? 'Fix the errors below before writing the card.' : 'Add and number some tracks first.'),
        h('ul', { class: 'issues' }, issues.length ? issues.map(i => h('li', { class: i.sev },
          h('span', { class: 'sev-dot ' + i.sev }, icon('warn')),
          h('span', null, i.msg),
          FIXES[i.group] ? h('button', { class: 'btn tiny', onclick: FIXES[i.group][1] }, FIXES[i.group][0]) : null,
          i.trackId || i.trigger ? h('button', { class: 'linkish', onclick: () => goTo(i) }, 'show') : null))
          : h('li', { class: 'muted' }, 'No issues found.'))),
      h('section', { class: 'panel' },
        h('h3', null, 'Write'),
        h('div', { class: 'toggles col' },
          toggle('Skip files that haven\'t changed since the last export', p.export.skipUnchanged, v => update(pp => { pp.export.skipUnchanged = v; }, { undo: false })),
          toggle('Remove other numbered WAVs from the card', p.export.cleanOrphans, v => update(pp => { pp.export.cleanOrphans = v; }, { undo: false })),
          toggle(`Write ${'_ntm_manifest.json'} (enables skipping + checksums)`, p.export.writeManifest, v => update(pp => { pp.export.writeManifest = v; }, { undo: false }))),
        h('p', { class: 'muted small' }, 'Files using a track number you\'re writing are always flagged, because two files with the same number confuse Tsunami.'),
        h('div', { class: 'export-actions' },
          h('button', { class: 'btn primary big', disabled: busy || !plan.length || !canWriteFolders(), onclick: () => run('folder') }, icon('card'), 'Write to SD card…'),
          h('button', { class: 'btn big', disabled: busy || !plan.length, onclick: () => run('zip') }, icon('export'), 'Download ZIP'),
          h('button', { class: 'btn', onclick: downloadIni }, 'tsunami.ini only')),
        !canWriteFolders() ? h('p', { class: 'warn small' }, 'Direct card writing needs Chrome or Edge. Use the ZIP and copy its contents to the card root.') : null,
        h('details', { class: 'adv', open: true }, h('summary', null, 'After writing'),
          h('ol', { class: 'small' },
            h('li', null, 'Eject the card properly (on macOS, Finder may add ._ files — harmless, but the Card Doctor can remove them).'),
            h('li', null, 'Insert it into Nutella and press RESET — no power cycle needed.'),
            h('li', null, 'The blue LED blinks 3 times right away = card and files found. One long blink = card not read / no WAVs.'),
            h('li', null, 'Use class 4 or 10 non-UHS cards formatted FAT16/FAT32 for best results.'))),
        h('div', { class: 'log' }, log.length ? log.slice(-200).map(l => h('div', null, l)) : h('span', { class: 'muted' }, 'Export log appears here.')))));
}

function tile(v, l, kind = '') { return h('div', { class: 'sum-tile ' + kind }, h('div', { class: 'sum-v' }, v), h('div', { class: 'sum-l' }, l)); }
