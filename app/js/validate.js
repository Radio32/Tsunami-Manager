// Project preflight: everything that would make the card misbehave on hardware.

import { MAX_TRACK, BOARDS, FUNC_BY_CODE } from './constants.js';
import { buildFileName } from './naming.js';
import { funcHasRange } from './ini.js';
import { effectiveNorm } from './audio.js';

export function estimateBytes(track, project) {
  if (!track.info) return 0;
  const e = track.edits;
  const end = e.trimEnd ?? track.info.duration;
  const dur = Math.max(0, end - (e.trimStart || 0));
  return 44 + Math.round(dur * 44100) * (project.mode === 'mono' ? 1 : 2) * 2;
}

// Peak after the edit chain, estimated without decoding (exact value comes from render).
export function estimatePeakDb(track, project) {
  if (!track.info || !isFinite(track.info.peakDb)) return null;
  const { mode, target } = effectiveNorm(track, project);
  const base = mode === 'peak' ? target : track.info.peakDb;
  return base + (track.edits.gain || 0);
}

export function validateProject(project) {
  const issues = [];
  const add = (sev, msg, extra = {}) => issues.push({ sev, msg, ...extra });
  const mono = project.mode === 'mono';
  const outputs = mono ? 8 : 4;
  const nums = new Map();
  const names = new Map();

  for (const t of project.tracks) {
    if (t.num == null) continue;
    if (!(t.num >= 1 && t.num <= MAX_TRACK)) add('error', `Track number ${t.num} is outside 1–4096.`, { trackId: t.id });
    if (nums.has(t.num)) add('error', `Two tracks share number ${t.num}.`, { trackId: t.id });
    nums.set(t.num, t);
    if (!t.sourceId) add('error', `Track ${t.num} has no audio.`, { trackId: t.id });
    if (t.info?.error) add('error', `Track ${t.num}: ${t.info.error}`, { trackId: t.id });

    const fn = buildFileName(t, project.naming, project.mode);
    const key = fn.toLowerCase();
    if (names.has(key)) add('error', `File name collision: ${fn}`, { trackId: t.id });
    names.set(key, t);
    if (fn.length > 200) add('warn', `Track ${t.num}: very long file name.`, { trackId: t.id });

    if (!mono && t.midi?.out > 4) add('error', `Track ${t.num}: MIDI output ${t.midi.out} doesn't exist in stereo mode (pairs 1–4).`, { trackId: t.id });

    const pk = estimatePeakDb(t, project);
    if (pk != null && pk > 0.05) add('warn', `Track ${t.num} will clip (peak ≈ ${pk.toFixed(1)} dBFS). Lower its gain.`, { trackId: t.id });

    if (t.info && mono && t.info.channels > 1 && t.edits.chan === 'auto')
      add('info', `Track ${t.num} is stereo and will be summed to mono.`, { trackId: t.id, group: 'downmix' });
    const slotTrig = project.triggers[(t.num - 1) % 16];
    if (slotTrig.func !== 1 && !project.triggers.some(x => funcHasRange(x.func) && FUNC_BY_CODE[x.func].plays && t.num >= x.low && t.num <= x.high))
      add('warn', `Track ${t.num} sits on trigger ${slotTrig.num}'s slot (${FUNC_BY_CODE[slotTrig.func].label}) — no trigger can play it, only MIDI.`, { trackId: t.id, group: 'navslot' });
    if (t.edits.trimEnd != null && t.edits.trimEnd <= (t.edits.trimStart || 0))
      add('error', `Track ${t.num}: trim end is before trim start.`, { trackId: t.id });
  }

  const monoSrc = project.tracks.filter(t => t.num != null && t.info?.channels === 1).length;
  if (!mono && monoSrc)
    add('info', `${monoSrc} mono source${monoSrc === 1 ? '' : 's'} will be converted to stereo (same signal on L and R) on export — the stereo firmware can't play mono files.`, { group: 'upmix' });

  const inbox = project.tracks.filter(t => t.num == null).length;
  if (inbox) add('info', `${inbox} track${inbox === 1 ? ' is' : 's are'} in the Inbox without a number and won't be exported.`, { group: 'inbox' });

  // Triggers
  for (const tr of project.triggers) {
    const f = FUNC_BY_CODE[tr.func];
    const label = `Trigger ${tr.num} (${f?.label || '?'})`;
    if (f?.monoOnly && !mono) add('error', `${label} only works with the mono firmware.`, { trigger: tr.num });
    if (funcHasRange(tr.func)) {
      if (!(tr.low >= 1 && tr.high >= tr.low && tr.high <= MAX_TRACK)) add('error', `${label}: range ${tr.low}–${tr.high} is invalid.`, { trigger: tr.num });
      else {
        if (tr.high > 2048) add('info', `${label}: ranges above 2048 can't be entered in the official Configurator, but are written here as-is.`, { trigger: tr.num });
        if (f.plays) {
          const missing = [];
          for (let n = tr.low; n <= tr.high && missing.length < 50; n++) if (!nums.has(n)) missing.push(n);
          if (missing.length === tr.high - tr.low + 1) add('warn', `${label}: no tracks exist in ${tr.low}–${tr.high}.`, { trigger: tr.num });
          else if (missing.length) add('info', `${label}: ${missing.length} empty slot${missing.length === 1 ? '' : 's'} in ${tr.low}–${tr.high} will be skipped.`, { trigger: tr.num });
        }
      }
      if (tr.func === 14) {
        const count = tr.high - tr.low + 1;
        if (count > 8) add('error', `${label}: a synced set plays at most 8 tracks (has ${count}).`, { trigger: tr.num });
        if (tr.output + count > 8) add('error', `${label}: ${count} tracks from output ${tr.output + 1} would run past output 8.`, { trigger: tr.num });
      }
    }
    if (f?.plays || tr.func === 8 || tr.func === 9) {
      const isAll = (tr.func === 8 || tr.func === 9) && tr.output === 8; // "All" outputs
      if (tr.output >= outputs && !isAll) add('error', `${label}: output ${tr.output + 1} doesn't exist in ${mono ? 'mono' : 'stereo'} mode.`, { trigger: tr.num });
    }
    if (tr.iface || tr.invert)
      add('warn', `${label}: interface/invert changed from default. Nutella's trigger inputs are built for the default (contact closure, active low) setting.`, { trigger: tr.num });
  }
  const bankUp = project.triggers.some(t => t.func === 12), bankDn = project.triggers.some(t => t.func === 13);
  const maxNum = Math.max(0, ...nums.keys());
  if (maxNum > 16 && !bankUp && !bankDn && !project.triggers.some(t => funcHasRange(t.func)))
    add('info', 'Tracks above 16 exist but no trigger is set to Bank Up/Down — they are only reachable by MIDI or serial.', { group: 'banks' });

  if (project.global.dbnc == null)
    add('info', 'Debounce is at the firmware default (~50 ms). Set it to 5 ms in Settings for fast rolls/ratchets (Nutella manual).', { group: 'dbnc' });

  const voices = BOARDS[project.board]?.[project.mode];
  const loudPoly = project.tracks.filter(t => t.num != null && (estimatePeakDb(t, project) ?? -99) > -3).length;
  if (loudPoly > 8 && voices)
    add('info', `${loudPoly} tracks peak above −3 dBFS. Tsunami sums up to ${voices} voices before the output stage; layering hot tracks will clip.`, { group: 'headroom' });

  return issues;
}

export function issuesByTrack(issues) {
  const m = new Map();
  for (const i of issues) {
    if (!i.trackId || i.sev === 'info') continue;
    const cur = m.get(i.trackId);
    const rank = { error: 3, warn: 2, info: 1 };
    if (!cur || rank[i.sev] > rank[cur]) m.set(i.trackId, i.sev);
  }
  return m;
}
