// Tsunami filename rules (User Guide, "WAV Files and Tracks"):
//  - name must start with the track number 1..4096 (1–4 digits, leading zeros optional)
//  - optional "_FN" immediately after the number (F = L|S, N = 1..8) sets MIDI loop + output
//  - everything after that is free text; long filenames are allowed; root folder only

import { MAX_TRACK } from './constants.js';

export function parseTrackFileName(fileName) {
  const m = /^(\d+)(.*)$/.exec(fileName);
  if (!m) return null;
  const num = m[1].length > 4 ? NaN : parseInt(m[1], 10);
  let rest = m[2];
  let midi = null;
  const sfx = /^_([LS])([1-8])/i.exec(rest);
  if (sfx) {
    midi = { loop: sfx[1].toUpperCase() === 'L', out: parseInt(sfx[2], 10), raw: sfx[0], upper: sfx[1] === sfx[1].toUpperCase() };
    rest = rest.slice(sfx[0].length);
  }
  const label = rest.replace(/\.[^.]+$/, '').replace(/^[\s_\-~.]+/, '').trim();
  return { num, valid: num >= 1 && num <= MAX_TRACK, midi, label, digits: m[1].length };
}

const TRANSLIT = { æ: 'ae', Æ: 'AE', ø: 'o', Ø: 'O', å: 'a', Å: 'A', ß: 'ss', œ: 'oe', Œ: 'OE', ð: 'd', þ: 'th', ł: 'l', Ł: 'L' };

export function sanitizeLabel(label, { ascii = true, maxLen = 64 } = {}) {
  let s = String(label || '');
  if (ascii) {
    s = s.replace(/[æÆøØåÅßœŒðþłŁ]/g, c => TRANSLIT[c]).normalize('NFD').replace(/[̀-ͯ]/g, '');
    s = s.replace(/[^\x20-\x7e]/g, '');
  }
  s = s.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

// Strip things that are clearly not a cue label from an imported file name.
export function labelFromSourceName(fileName) {
  const parsed = parseTrackFileName(fileName);
  const base = parsed ? parsed.label : fileName.replace(/\.[^.]+$/, '');
  return base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'untitled';
}

export function midiSuffix(track, naming, mode) {
  const out = track.midi?.out || 1;
  const loop = !!track.midi?.loop;
  if (!naming.alwaysSuffix && !loop && out === 1) return '';
  return `_${loop ? 'L' : 'S'}${mode === 'stereo' ? Math.min(out, 4) : out}`;
}

export function buildFileName(track, naming, mode) {
  const num = naming.digits > 0 ? String(track.num).padStart(naming.digits, '0') : String(track.num);
  const sfx = midiSuffix(track, naming, mode);
  const label = sanitizeLabel(track.name, naming);
  let sep = naming.sep ?? '_';
  // Without a suffix, "_S2 bass" would be misread by Tsunami as a MIDI suffix.
  if (!sfx && sep === '_' && /^[LS][1-8]/i.test(label)) sep = '-';
  if (!label) return `${num}${sfx}.wav`;
  return `${num}${sfx}${sfx ? ' ' : sep}${label}.wav`;
}
