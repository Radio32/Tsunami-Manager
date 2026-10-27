// Output assignment: which output (stereo pair or mono jack) each trigger plays on.
// Writes the Output field of the #TRIG lines; applies to that pad in every bank.

import { h } from '../util.js';
import { state, update } from '../state.js';
import { FUNC_BY_CODE } from '../constants.js';
import { KIT_SLOTS } from '../kit.js';

export const outputCount = () => (state.project.mode === 'mono' ? 8 : 4);
export const outputLabel = (o, short = false) => {
  if (o === 8) return 'All';
  if (state.project.mode === 'mono') return short ? `${o + 1}` : `Out ${o + 1}`;
  return short ? `${o + 1}` : `Pair ${o + 1}`;
};

export function setTriggerOutput(n, out) {
  update(p => { p.triggers[n - 1] = { ...p.triggers[n - 1], output: out }; }, { reason: 'trigger' });
}

// Next output in turn, for the quick button on each pad.
export function cycleTriggerOutput(n) {
  const t = state.project.triggers[n - 1];
  setTriggerOutput(n, ((t.output >= 8 ? 0 : t.output) + 1) % outputCount());
}

export function outputMatrix() {
  const p = state.project;
  const outs = outputCount();
  const mono = p.mode === 'mono';
  const allSame = o => p.triggers.filter(t => FUNC_BY_CODE[t.func].plays).every(t => t.output === o);
  return h('div', { class: 'omatrix-wrap' },
    h('div', { class: 'field-label' }, 'Output assignment'),
    h('table', { class: 'omatrix' },
      h('thead', null, h('tr', null,
        h('th', null, 'Trigger'),
        Array.from({ length: outs }, (_, o) => h('th', null,
          h('button', {
            class: 'linkish' + (allSame(o) ? ' on' : ''), title: `Send every playing trigger to ${outputLabel(o)}`,
            onclick: () => update(pp => { pp.triggers = pp.triggers.map(t => (FUNC_BY_CODE[t.func].plays ? { ...t, output: o } : t)); }, { reason: 'trigger' }),
          }, mono ? `${o + 1}` : `${o * 2 + 1}/${o * 2 + 2}`))))),
      h('tbody', null, p.triggers.map(t => {
        const f = FUNC_BY_CODE[t.func];
        const isVol = t.func === 8 || t.func === 9;
        const usable = f.plays || isVol;
        const slot = t.num <= 8 ? KIT_SLOTS[t.num - 1].short : null;
        return h('tr', { class: usable ? '' : 'off' },
          h('th', null, h('span', { class: 'om-n' }, t.num),
            h('span', { class: 'om-f' }, t.func === 1 ? (slot || 'Pad') : f.short)),
          Array.from({ length: outs }, (_, o) => h('td', null,
            usable ? h('button', {
              class: 'om-cell' + (t.output === o ? ' on' : ''), 'aria-pressed': t.output === o,
              'aria-label': `Trigger ${t.num} to ${outputLabel(o)}`,
              onclick: () => setTriggerOutput(t.num, o),
            }) : h('span', { class: 'om-na' }, '·'))));
      }))),
    h('p', { class: 'muted small' },
      mono ? 'Mono firmware: 8 separate jacks. A Synced Set starts on its trigger\'s output and uses the next ones.'
        : 'Stereo firmware: 4 stereo pairs (jacks 1/2, 3/4, 5/6, 7/8). Click a column header to send everything there. MIDI-started tracks use the output in their file name (Inspector → MIDI playback).'));
}
