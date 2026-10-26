// Triggers: the 16 trigger inputs' function, type and options, plus a live tsunami.ini preview.

import { h } from '../util.js';
import { state, update, emit } from '../state.js';
import { FUNCS, FUNC_BY_CODE, TYPES } from '../constants.js';
import { applyFunctionDefaults, defaultTrigger, isDefaultTrigger, buildIni, funcHasRange, triggerLine } from '../ini.js';
import { field, select as sel, toggle, numberInput, slider, segmented, badge, modal, toast, icon } from '../ui.js';
import { serial, serialCmd } from '../live.js';
import { downloadIni } from '../export.js';

function setTrig(n, fn) {
  update(p => { p.triggers[n - 1] = fn({ ...p.triggers[n - 1] }); }, { reason: 'trigger' });
}

const PRESETS = [
  {
    name: 'All default', desc: 'Every trigger plays its track; no ini lines.',
    apply: p => p.triggers.map(t => defaultTrigger(t.num)),
  },
  {
    name: 'Drum kits + bank switch', desc: 'Triggers 1–14 play pads, 15 = Bank Down, 16 = Bank Up. Each bank is a kit.',
    apply: p => p.triggers.map(t => (t.num === 15 ? applyFunctionDefaults(t, 13) : t.num === 16 ? applyFunctionDefaults(t, 12) : defaultTrigger(t.num))),
  },
  {
    name: 'Gate / sustain', desc: 'All playing triggers become Level type: sound stops when the gate ends.',
    apply: p => p.triggers.map(t => ({ ...t, type: FUNC_BY_CODE[t.func].edgeOnly ? 0 : 1, retrigger: false })),
  },
  {
    name: 'Round-robin pairs', desc: 'Triggers 1–8 each pick randomly from 4 variations (tracks 1–4, 5–8 … 29–32). 9–16 normal.',
    apply: p => p.triggers.map(t => (t.num <= 8 ? { ...applyFunctionDefaults(t, 4), low: (t.num - 1) * 4 + 1, high: t.num * 4 } : defaultTrigger(t.num))),
  },
  {
    name: 'Stem launcher (mono)', desc: 'Trigger 1 starts tracks 1–8 sample-locked on outs 1–8, trigger 2 stops them, 3 pauses, 4 resumes.',
    mode: 'mono',
    apply: p => p.triggers.map(t => {
      if (t.num === 1) return { ...applyFunctionDefaults(t, 14), low: 1, high: 8 };
      if (t.num === 2) return { ...applyFunctionDefaults(t, 7), low: 1, high: 8 };
      if (t.num === 3) return { ...applyFunctionDefaults(t, 5), low: 1, high: 8 };
      if (t.num === 4) return { ...applyFunctionDefaults(t, 6), low: 1, high: 8 };
      return defaultTrigger(t.num);
    }),
  },
  {
    name: 'One output per trigger (mono)', desc: 'Trigger n plays on output ((n−1) mod 8)+1 — separate jacks for separate sounds.',
    mode: 'mono',
    apply: p => p.triggers.map(t => ({ ...defaultTrigger(t.num), output: (t.num - 1) % 8 })),
  },
];

async function applyPreset(pr) {
  const ok = await modal({
    title: `Apply “${pr.name}”?`, body: h('p', null, pr.desc + (pr.mode === 'mono' ? ' Switches the project to the mono firmware.' : '') + ' Replaces all 16 trigger settings (undo with ⌘Z).'),
    actions: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }],
  });
  if (!ok) return;
  update(p => { if (pr.mode) p.mode = pr.mode; p.triggers = pr.apply(p); }, { reason: 'trigger' });
}

async function copyTo(n) {
  const targets = new Set();
  const ok = await modal({
    title: `Copy trigger ${n} settings to…`,
    body: h('div', { class: 'copy-grid' }, Array.from({ length: 16 }, (_, i) => i + 1).filter(i => i !== n)
      .map(i => toggle(`Trigger ${i}`, false, v => (v ? targets.add(i) : targets.delete(i))))),
    actions: [{ label: 'Cancel', value: false }, { label: 'Copy', value: true, primary: true }],
  });
  if (!ok || !targets.size) return;
  update(p => { const src = p.triggers[n - 1]; for (const i of targets) p.triggers[i - 1] = { ...src, num: i }; }, { reason: 'trigger' });
}

function card(t, mono) {
  const f = FUNC_BY_CODE[t.func];
  const outputs = mono ? 8 : 4;
  const isVol = t.func === 8 || t.func === 9;
  const outOpts = Array.from({ length: outputs }, (_, i) => [i, mono ? `Out ${i + 1}` : `Pair ${i + 1}`]);
  if (isVol) outOpts.push([8, 'All']);
  const def = isDefaultTrigger(t);
  const playsAudio = f.plays;

  return h('div', { class: 'tcard' + (def ? ' default' : ''), id: 'trig-' + t.num },
    h('div', { class: 'tcard-head' },
      h('span', { class: 'tnum' }, t.num),
      sel(FUNCS.map(x => [x.code, x.label, x.monoOnly && !mono]), t.func, v => setTrig(t.num, x => applyFunctionDefaults(x, +v)), { 'aria-label': `Trigger ${t.num} function` }),
      def ? badge('default', 'muted') : badge('custom', 'pos')),
    h('p', { class: 'tcard-help' }, f.help),
    h('div', { class: 'tcard-body' },
      h('div', { class: 'row' },
        field('Type', segmented(TYPES.map(x => [x.code, x.label, x.help]), t.type, v => setTrig(t.num, x => ({ ...x, type: +v, retrigger: +v === 0 ? x.retrigger : false })), { class: f.edgeOnly ? 'disabled' : '' })),
        funcHasRange(t.func) ? field('Track range', h('div', { class: 'row tight' },
          numberInput(t.low, v => setTrig(t.num, x => ({ ...x, low: Math.round(v || 1) })), { min: 1, max: 4096, width: '5em' }),
          h('span', null, '–'),
          numberInput(t.high, v => setTrig(t.num, x => ({ ...x, high: Math.round(v || 1) })), { min: 1, max: 4096, width: '5em' }))) : null,
        playsAudio || isVol ? field(isVol ? 'Output' : 'Output', sel(outOpts, t.output, v => setTrig(t.num, x => ({ ...x, output: +v })))) : null),
      playsAudio ? field('Trigger gain', slider(t.gain, v => setTrig(t.num, x => ({ ...x, gain: v })), { min: -20, max: 10, step: 1, format: v => `${v > 0 ? '+' : ''}${v} dB` })) : null,
      playsAudio ? h('div', { class: 'toggles' },
        toggle('Retrigger', t.retrigger, v => setTrig(t.num, x => ({ ...x, retrigger: v })), { title: 'Allow restarting while the previous sound is still playing' }),
        toggle('Polyphonic', t.poly, v => setTrig(t.num, x => ({ ...x, poly: v })), { title: 'Off = stop everything on the same output first' }),
        toggle('Loop', t.loop, v => setTrig(t.num, x => ({ ...x, loop: v })), { title: 'Loop seamlessly until stopped' }),
        toggle('Lock voice', t.lock, v => setTrig(t.num, x => ({ ...x, lock: v })), { title: 'Never stolen when voices run out' })) : null,
      h('details', { class: 'adv' }, h('summary', null, 'Electrical (advanced)'),
        h('p', { class: 'muted small' }, 'Nutella\'s input circuit is designed for the defaults. Only change these if you know your hardware needs it.'),
        h('div', { class: 'row' },
          field('Interface', sel([[0, 'Contact closure'], [1, 'Active 3.3 V']], t.iface, v => setTrig(t.num, x => ({ ...x, iface: +v, invert: +v === 1 })))),
          toggle('Invert (active high)', t.invert, v => setTrig(t.num, x => ({ ...x, invert: v })))))),
    h('div', { class: 'tcard-foot' },
      h('code', { class: 'muted small' }, def ? '(no ini line)' : triggerLine(t)),
      h('div', { class: 'spacer' }),
      serial.connected ? h('button', { class: 'btn tiny', title: 'Send to Tsunami RAM over serial (until reset)', onclick: () => serialCmd.pushTrigger(t).then(() => toast(`Trigger ${t.num} sent`)) }, 'Test') : null,
      h('button', { class: 'btn tiny', onclick: () => copyTo(t.num) }, 'Copy to…'),
      !def ? h('button', { class: 'btn tiny', onclick: () => setTrig(t.num, () => defaultTrigger(t.num)) }, 'Reset') : null));
}

function tile(t, sel) {
  const f = FUNC_BY_CODE[t.func];
  const def = isDefaultTrigger(t);
  const detail = funcHasRange(t.func) ? `${t.low}–${t.high}` : t.func === 1 ? 'bank track' : '';
  return h('button', {
    class: 'ttile' + (sel ? ' on' : '') + (def ? '' : ' custom') + (f.plays ? '' : ' ctl'),
    title: `Trigger ${t.num}: ${f.label}${detail ? ' ' + detail : ''}`,
    onclick: () => { state.ui.trigSel = t.num; emit('view'); },
  },
    h('span', { class: 'tt-num' }, t.num),
    h('span', { class: 'tt-func' }, f.short),
    h('span', { class: 'tt-detail' }, detail),
    h('span', { class: 'tt-flags' },
      t.type === 1 ? 'GATE' : t.type === 2 ? 'LATCH' : '',
      t.loop ? ' LOOP' : '',
      f.plays && t.output ? ` OUT${t.output + 1}` : ''));
}

export function renderTriggers() {
  const p = state.project;
  const mono = p.mode === 'mono';
  const ini = buildIni(p);
  if (state.ui.triggerFocus) { state.ui.trigSel = state.ui.triggerFocus; state.ui.triggerFocus = null; }
  const n = state.ui.trigSel || 1;
  const t = p.triggers[n - 1];
  const go = d => { state.ui.trigSel = ((n - 1 + d + 16) % 16) + 1; emit('view'); };
  return h('div', { class: 'view triggers-view' },
    h('div', { class: 'toolbar' },
      h('span', { class: 'muted' }, 'Presets'),
      PRESETS.map(pr => h('button', { class: 'btn tiny', title: pr.desc, onclick: () => applyPreset(pr) }, pr.name))),
    h('div', { class: 'ttiles' }, p.triggers.map(x => tile(x, x.num === n))),
    h('div', { class: 'triggers-main' },
      h('div', { class: 'tedit' },
        h('div', { class: 'tedit-nav' },
          h('button', { class: 'icon-btn', title: 'Previous trigger', onclick: () => go(-1) }, icon('chevl')),
          h('span', { class: 'muted small' }, `Trigger ${n} of 16`),
          h('button', { class: 'icon-btn', title: 'Next trigger', onclick: () => go(1) }, icon('chev'))),
        card(t, mono)),
      h('aside', { class: 'ini-side' },
        h('div', { class: 'side-title' }, 'tsunami.ini', h('span', { class: 'muted small' }, ` ${mono ? 'mono' : 'stereo'} firmware`)),
        h('pre', { class: 'ini' }, ini),
        h('div', { class: 'row' },
          h('button', { class: 'btn tiny', onclick: () => navigator.clipboard.writeText(ini).then(() => toast('Copied')) }, 'Copy'),
          h('button', { class: 'btn tiny', onclick: downloadIni }, 'Download')),
        h('p', { class: 'muted small' }, 'Changes apply immediately — no Add/Update step. Only non-default triggers are written, exactly like the Robertsonics Configurator.'))));
}
