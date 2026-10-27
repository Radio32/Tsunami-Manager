// MIDI map: note → track for each of the 32 MIDI banks (track = bank × 128 + note).

import { h, noteName, pad4, clamp } from '../util.js';
import { state, emit, trackByNum, select, update } from '../state.js';
import { MIDI_BANKS } from '../constants.js';
import { audition } from './inspector.js';
import { dragSource } from './pads.js';
import { importFiles, droppedFiles } from '../importer.js';
import { setTrackNum } from '../actions.js';
import { midi, midiPlayTrack, midiProgram } from '../live.js';
import { segmented, icon, badge } from '../ui.js';

const DND_TYPE = 'application/x-ntm-track';
const BLACK = new Set([1, 3, 6, 8, 10]);

function setBank(b) { state.ui.midiBank = clamp(b, 0, MIDI_BANKS - 1); emit('bank'); }

export function renderMidiMap() {
  const p = state.project;
  const tracks = trackByNum();
  const bank = state.ui.midiBank;
  const conv = p.ui.noteConvention;
  const used = new Array(MIDI_BANKS).fill(0);
  for (const n of tracks.keys()) used[Math.floor(n / 128)]++;

  const rows = [];
  for (let oct = 10; oct >= 0; oct--) {
    const cells = [];
    for (let k = 0; k < 12; k++) {
      const note = oct * 12 + k;
      if (note > 127) { cells.push(h('div', { class: 'mcell void' })); continue; }
      const num = bank * 128 + note;
      const t = num >= 1 ? tracks.get(num) : null;
      const cell = h('div', {
        class: 'mcell' + (BLACK.has(k) ? ' black' : '') + (t ? ' has' : '') + (t && state.ui.selectedId === t.id ? ' on' : '') + (num < 1 ? ' void' : ''),
        title: `${noteName(note, conv)} (note ${note}) → track ${num}${t ? ': ' + t.name : ''}`,
        onclick: () => { if (t) select(t.id); },
        ondblclick: () => {
          if (!t) return;
          if (midi.output) midiPlayTrack(t.num); else audition(t);
        },
      },
        h('div', { class: 'mnote' }, noteName(note, conv), h('span', null, note)),
        t ? h('div', { class: 'mname' }, t.name) : h('div', { class: 'mnum' }, num >= 1 ? pad4(num) : ''),
        t && (t.midi.loop || t.midi.out !== 1) ? h('div', { class: 'mflags' }, badge(`${t.midi.loop ? 'L' : 'S'}${t.midi.out}`, t.midi.loop ? 'loop' : 'out')) : null);
      if (num >= 1) {
        if (t) dragSource(cell, t.id);
        cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('drop'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
        cell.addEventListener('drop', e => {
          e.preventDefault(); e.stopPropagation(); cell.classList.remove('drop');
          const id = e.dataTransfer.getData(DND_TYPE);
          if (id) setTrackNum(id, num); else if (e.dataTransfer.files.length) droppedFiles(e.dataTransfer).then(files => importFiles(files, { at: num }));
        });
      }
      cells.push(cell);
    }
    rows.push(h('div', { class: 'mrow' }, h('div', { class: 'moct' }, `${noteName(oct * 12, conv)}`), cells));
  }

  return h('div', { class: 'view midi-view' },
    h('div', { class: 'toolbar' },
      h('div', { class: 'bank-nav' },
        h('button', { class: 'icon-btn', onclick: () => setBank(bank - 1), disabled: bank === 0 }, icon('chevl')),
        h('div', { class: 'bank-label' }, h('span', { class: 'muted small' }, 'MIDI bank'),
          h('input', { class: 'num bank-input', type: 'number', min: 0, max: 31, value: bank, onchange: e => setBank(+e.target.value || 0) })),
        h('button', { class: 'icon-btn', onclick: () => setBank(bank + 1), disabled: bank === 31 }, icon('chev')),
        h('span', { class: 'muted' }, `tracks ${Math.max(1, bank * 128)}–${bank * 128 + 127}`)),
      h('div', { class: 'midi-banks' }, used.map((c, b) => h('button', {
        class: 'mb' + (b === bank ? ' on' : '') + (c ? ' used' : ''), title: `MIDI bank ${b} (Program Change ${b}) · ${c} tracks`, onclick: () => setBank(b),
      }, b))),
      h('div', { class: 'spacer' }),
      segmented([['yamaha', 'C3 = 60'], ['roland', 'C4 = 60']], conv, v => update(pp => { pp.ui.noteConvention = v; }, { undo: false })),
      midi.output ? h('button', { class: 'btn', onclick: () => midiProgram(bank), title: 'Send Program Change to the Nutella' }, `Send PC ${bank}`) : null),
    h('p', { class: 'muted small' },
      'Note-On plays track = MIDI bank × 128 + note. Change bank with Program Change or MIDI Bank Up/Down triggers. ',
      'The L/S + output flag in the file name only applies to MIDI-started tracks. ',
      midi.output ? 'Double-click a key to play it on the hardware.' : 'Connect MIDI on the Live page to play keys on the hardware.'),
    h('div', { class: 'mgrid' }, rows));
}
