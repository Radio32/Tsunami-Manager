// Presets: your own trigger setups — a name and settings for each of the 16 triggers —
// saved in this browser, applied to any project, and exported or imported as a .json file.

import { h } from '../util.js';
import { state, emit } from '../state.js';
import { FUNC_BY_CODE } from '../constants.js';
import { isDefaultTrigger } from '../ini.js';
import { slotFor, triggerName } from '../kit.js';
import { field, segmented, icon, modal, confirmModal, toast } from '../ui.js';
import { pickFiles } from '../actions.js';
import {
  listPresets, getPreset, createPreset, changePreset, deletePreset, presetFromProject,
  applyPresetToProject, exportPresets, importPresetFile,
} from '../presets.js';
import { card, tile } from './triggers.js';

function presetCtx(pr) {
  return {
    set: (n, fn) => changePreset(pr.id, x => { x.triggers[n - 1] = { ...fn({ ...x.triggers[n - 1] }), num: n }; }),
    all: fn => changePreset(pr.id, x => fn(x.triggers)),
    select: n => { state.ui.presetTrig = n; emit('view'); },
    live: false,
  };
}

const open = pr => { state.ui.presetSel = pr.id; state.ui.presetTrig = 1; emit('view'); };

async function askName(title, value) {
  let name = value;
  const ok = await modal({
    title,
    body: field('Preset name', h('input', { type: 'text', value, maxlength: 48, oninput: e => { name = e.target.value; } })),
    actions: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }],
  });
  return ok ? name.trim() || value : null;
}

async function newBlank() {
  const name = await askName('New preset', 'My triggers');
  if (name) open(createPreset({ name, mode: state.project.mode, triggers: [] }));
}

async function fromProject() {
  const name = await askName('Save the project\'s triggers as a preset', 'My triggers');
  if (name) open(presetFromProject(name));
}

async function importFile() {
  const [file] = await pickFiles({ multiple: false, accept: '.json,application/json' });
  if (!file) return;
  try {
    const n = await importPresetFile(file);
    toast(`Imported ${n} preset${n === 1 ? '' : 's'} from ${file.name}`, { kind: 'ok' });
    open(listPresets()[listPresets().length - 1]);
  } catch (e) { toast(e.message, { kind: 'warn', ms: 6000 }); }
}

async function apply(pr) {
  const ok = await confirmModal(`Apply “${pr.name}”?`,
    `Replaces all 16 trigger settings and names in “${state.project.name}”` +
    (pr.mode !== state.project.mode ? ` and switches it to the ${pr.mode} firmware` : '') + '. Undo with ⌘Z.', { ok: 'Apply' });
  if (!ok) return;
  applyPresetToProject(pr);
  toast(`“${pr.name}” applied to the project`, { kind: 'ok' });
}

async function remove(pr) {
  if (await confirmModal(`Delete “${pr.name}”?`, 'The preset is removed from this browser. Projects it was applied to keep their triggers. This can\'t be undone, so export it first if you might want it back.', { ok: 'Delete', danger: true })) {
    deletePreset(pr.id);
  }
}

function setMode(pr, mode) {
  changePreset(pr.id, x => {
    x.mode = mode;
    // Stereo has 4 output pairs; fold outputs 5–8 onto them.
    if (mode === 'stereo') for (const t of x.triggers) if (FUNC_BY_CODE[t.func].plays && t.output > 3) t.output %= 4;
  });
}

function summary(pr) {
  const named = pr.triggers.filter(t => triggerName(t)).length;
  const custom = pr.triggers.filter(t => !isDefaultTrigger(t)).length;
  return `${pr.mode === 'mono' ? 'Mono' : 'Stereo'} · ${named} named · ${custom} custom`;
}

function namesGrid(pr, ctx) {
  return h('div', { class: 'pnames' }, pr.triggers.map(t => {
    const f = FUNC_BY_CODE[t.func];
    const slot = slotFor(t.num);
    return h('label', { class: 'pname' + (t.num === (state.ui.presetTrig || 1) ? ' on' : '') },
      h('span', { class: 'pname-num' }, t.num),
      h('input', {
        type: 'text', maxlength: 24, value: t.label || '', 'data-fk': `pname-${t.num}`,
        placeholder: t.func === 1 ? (slot ? slot.label : `Pad ${t.num}`) : f.label,
        'aria-label': `Trigger ${t.num} name`,
        onfocus: () => { if (state.ui.presetTrig !== t.num) { state.ui.presetTrig = t.num; emit('view'); } },
        onchange: e => ctx.set(t.num, x => ({ ...x, label: e.target.value.trim() })),
      }));
  }));
}

export function renderPresets() {
  const list = listPresets();
  const pr = getPreset(state.ui.presetSel) || list[0] || null;
  if (pr) state.ui.presetSel = pr.id;

  const toolbar = h('div', { class: 'toolbar' },
    h('button', { class: 'btn', onclick: newBlank }, icon('plus'), 'New preset'),
    h('button', { class: 'btn', onclick: fromProject, title: 'Copy the open project\'s 16 triggers and names into a new preset' }, 'From current project'),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: importFile }, 'Import file…'),
    list.length ? h('button', { class: 'btn', onclick: () => exportPresets(), title: 'Download every preset as one .json file' }, 'Export all') : null);

  if (!pr) {
    return h('div', { class: 'view' }, toolbar, h('div', { class: 'empty-state big' },
      h('h3', null, 'No presets yet'),
      h('p', null, 'A preset is your own trigger map: a name and settings for each of the 16 triggers. Presets are kept in this browser and can be applied to any project. Use Export to back them up or move them to another computer.'),
      h('button', { class: 'btn primary', onclick: fromProject }, 'Start from the current project')));
  }

  const ctx = presetCtx(pr);
  const mono = pr.mode === 'mono';
  const n = state.ui.presetTrig || 1;

  return h('div', { class: 'view presets-view' },
    toolbar,
    h('div', { class: 'presets-main' },
      h('nav', { class: 'plist', 'aria-label': 'My presets' }, list.map(x => h('button', {
        class: 'plist-item' + (x.id === pr.id ? ' on' : ''), onclick: () => open(x),
      }, h('span', { class: 'plist-name' }, x.name), h('span', { class: 'plist-sub' }, summary(x))))),
      h('div', { class: 'pedit' },
        h('div', { class: 'pedit-head' },
          h('input', {
            class: 'pedit-name', type: 'text', maxlength: 48, value: pr.name, 'data-fk': 'preset-name', 'aria-label': 'Preset name',
            onchange: e => changePreset(pr.id, x => { x.name = e.target.value.trim() || x.name; }),
          }),
          segmented([['stereo', 'Stereo'], ['mono', 'Mono']], pr.mode, v => setMode(pr, v)),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn primary', onclick: () => apply(pr) }, 'Apply to project'),
          h('button', { class: 'btn', onclick: () => open(createPreset({ ...pr, name: `${pr.name} copy` })) }, 'Duplicate'),
          h('button', { class: 'btn', onclick: () => exportPresets([pr]) }, 'Export'),
          h('button', { class: 'btn danger', onclick: () => remove(pr) }, 'Delete')),
        h('h3', { class: 'psect' }, 'Trigger names'),
        h('p', { class: 'muted small' }, 'Shown on the pads, trigger tiles and output grid once the preset is applied. Leave a name empty to keep the built-in label.'),
        namesGrid(pr, ctx),
        h('h3', { class: 'psect' }, 'Trigger settings'),
        h('div', { class: 'ttiles' }, pr.triggers.map(t => tile(t, t.num === n, mono, ctx))),
        h('div', { class: 'tedit' }, card(pr.triggers[n - 1], mono, ctx)))));
}
