// Settings: firmware/board, outputs, MIDI, debounce, processing defaults, naming, project data.

import { h, fmtBytes, fmtDb } from '../util.js';
import { state, update, replaceProject, newProject } from '../state.js';
import { BOARDS, BAUDS } from '../constants.js';
import { buildFileName } from '../naming.js';
import { field, select as sel, toggle, numberInput, slider, segmented, confirmModal, toast } from '../ui.js';
import { saveProjectBundle } from '../export.js';
import { importFiles } from '../importer.js';
import { pickFiles } from '../actions.js';
import { storageEstimate, clearSources } from '../store.js';
import { clearCaches } from '../audio.js';

const set = fn => update(fn, { reason: 'settings' });

function panel(title, desc, ...body) {
  return h('section', { class: 'panel' }, h('h3', null, title), desc ? h('p', { class: 'muted small' }, desc) : null, body);
}

export function renderSettings() {
  const p = state.project;
  const g = p.global;
  const mono = p.mode === 'mono';
  const voices = BOARDS[p.board];
  const sample = { num: 17, name: 'Kick 808', midi: { loop: false, out: 1 } };
  const sampleMidi = { num: 101, name: 'Violin A3', midi: { loop: true, out: 3 } };
  const est = h('span', { class: 'muted' }, '…');
  storageEstimate().then(e => { if (e) est.textContent = `${fmtBytes(e.usage)} used of ${fmtBytes(e.quota)} available`; });

  return h('div', { class: 'view settings-view' }, h('div', { class: 'panels' },
    panel('Firmware & board', 'Must match the firmware flashed on your Tsunami. All WAVs are rendered for this mode.',
      field('Firmware', segmented([['stereo', 'Stereo'], ['mono', 'Mono']], p.mode, v => set(pp => { pp.mode = v; }))),
      h('p', { class: 'small' }, mono
        ? `Mono: ${voices.mono} voices, 8 mono outputs, Synced Set available. WAVs are rendered mono.`
        : `Stereo: ${voices.stereo} voices, 4 stereo output pairs. WAVs are rendered stereo.`),
      field('Board', sel(Object.entries(BOARDS).map(([k, b]) => [k, `${b.label} — ${b.mono} mono / ${b.stereo} stereo voices`]), p.board, v => set(pp => { pp.board = v; }))),
      h('details', { class: 'adv' }, h('summary', null, 'Switching firmware'),
        h('ol', { class: 'small' },
          h('li', null, 'Download the mono or stereo .hex for your board from robertsonics.com/downloads.'),
          h('li', null, 'Copy it to the card root and rename it to ', h('code', null, 'tsunamix.hex'), '.'),
          h('li', null, 'Hold USER, tap RESET, wait for the LED to go solid, then tap RESET again.')))),

    panel('Outputs', 'Initial output volume (#VOLn). Use track gain to avoid clipping — output volume only scales the already-mixed signal.',
      h('div', { class: 'outs' }, Array.from({ length: mono ? 8 : 4 }, (_, i) => field(mono ? `Out ${i + 1}` : `Pair ${i + 1}`,
        slider(g.outVol[i] || 0, v => set(pp => { pp.global.outVol[i] = v; }), { min: -70, max: 10, step: 1, format: v => fmtDb(v, 0) })))),
      h('details', { class: 'adv' }, h('summary', null, 'Audio input mix (#IMIX)'),
        h('p', { class: 'muted small' }, 'Mix Tsunami\'s line input into output pairs.'),
        h('div', { class: 'toggles' }, [0, 1, 2, 3].map(b => toggle(`Pair ${b + 1}`, !!(g.imix & (1 << b)), v => set(pp => { pp.global.imix = v ? pp.global.imix | (1 << b) : pp.global.imix & ~(1 << b); })))))),

    panel('Trigger inputs', null,
      field('Debounce (#DBNC)', h('div', { class: 'row tight' },
        numberInput(g.dbnc, v => set(pp => { pp.global.dbnc = v == null ? null : Math.round(v); }), { min: 0, max: 100, width: '5em', placeholder: '50' }),
        h('span', { class: 'muted' }, 'ms'),
        g.dbnc == null ? h('button', { class: 'btn tiny', onclick: () => set(pp => { pp.global.dbnc = 5; }) }, 'Use 5 ms (recommended)') : null),
        'Firmware default is ~50 ms (fine for beats, too slow for rolls). The Nutella manual recommends 5 ms; it also lets Tsunami accept shorter triggers.')),

    panel('MIDI', 'Nutella\'s MIDI input. Note-On plays track = MIDI bank × 128 + note.',
      h('div', { class: 'row' },
        field('Channel', sel([[0, 'Omni (all)'], ...Array.from({ length: 16 }, (_, i) => [i + 1, `Channel ${i + 1}`])], g.midiChannel, v => set(pp => { pp.global.midiChannel = +v; }))),
        field('Pitch bend range', sel([1, 2, 3, 4, 5].map(n => [n, `±${n} semitone${n > 1 ? 's' : ''}`]), g.bend, v => set(pp => { pp.global.bend = +v; })))),
      field('Default release', slider(g.release, v => set(pp => { pp.global.release = v; }), { min: 0, max: 127, step: 1, format: v => `${v} ms` }), 'Release time after Note-Off (CC72/CC1 override it live).'),
      h('div', { class: 'toggles' },
        toggle('Ignore velocity', g.ignoreVel, v => set(pp => { pp.global.ignoreVel = v; })),
        toggle('Ignore Note-Off', g.ignoreOff, v => set(pp => { pp.global.ignoreOff = v; })))),

    panel('Processing defaults', 'Used by every track set to “Project default”.',
      field('Normalize', segmented([['none', 'Off'], ['peak', 'Peak'], ['rms', 'Loudness (RMS)']], p.processing.norm, v => set(pp => { pp.processing.norm = v; }))),
      h('div', { class: 'row' },
        field('Peak target', h('div', { class: 'row tight' }, numberInput(p.processing.peakTarget, v => set(pp => { pp.processing.peakTarget = v ?? -1; }), { min: -40, max: 0, step: 0.5, width: '5em' }), h('span', { class: 'muted' }, 'dBFS'))),
        field('RMS target', h('div', { class: 'row tight' }, numberInput(p.processing.rmsTarget, v => set(pp => { pp.processing.rmsTarget = v ?? -18; }), { min: -40, max: -3, step: 0.5, width: '5em' }), h('span', { class: 'muted' }, 'dB')))),
      h('p', { class: 'muted small' }, 'Tsunami sums voices digitally before the output stage; if you layer many tracks, a lower peak target (−6 dBFS) leaves headroom.'),
      toggle('TPDF dither when reducing to 16-bit', p.processing.dither, v => set(pp => { pp.processing.dither = v; }))),

    panel('File naming', 'How exported WAV files are named on the card.',
      h('div', { class: 'row' },
        field('Number digits', sel([[0, 'No padding (17)'], [3, '017'], [4, '0017']], p.naming.digits, v => set(pp => { pp.naming.digits = +v; }))),
        field('Separator', sel([['_', 'Underscore'], [' ', 'Space'], ['-', 'Dash']], p.naming.sep, v => set(pp => { pp.naming.sep = v; }))),
        field('Max name length', numberInput(p.naming.maxLen, v => set(pp => { pp.naming.maxLen = Math.round(v || 64); }), { min: 0, max: 200, width: '5em' }))),
      h('div', { class: 'toggles' },
        toggle('ASCII only (ø → o, é → e)', p.naming.ascii, v => set(pp => { pp.naming.ascii = v; })),
        toggle('Always write the MIDI flag (_S1)', p.naming.alwaysSuffix, v => set(pp => { pp.naming.alwaysSuffix = v; }))),
      h('div', { class: 'examples' },
        h('code', null, buildFileName(sample, p.naming, p.mode)),
        h('code', null, buildFileName(sampleMidi, p.naming, p.mode)))),

    panel('Serial (advanced)', 'Only matters if you control Tsunami over its serial header.',
      field('Baud rate (#BAUD)', sel(BAUDS.map(b => [b, b === 57600 ? '57600 (default)' : String(b)]), g.baud, v => set(pp => { pp.global.baud = +v; }))),
      field('Extra ini lines', h('textarea', { rows: 3, class: 'mono', placeholder: '#XXXX value', value: g.extraLines, onchange: e => set(pp => { pp.global.extraLines = e.target.value; }) }),
        'Written verbatim after the global settings. Unknown lines from imported ini files land here.')),

    panel('Project data', 'Projects autosave in this browser (audio included). Save a bundle to back up or move to another computer.',
      field('Project name', h('input', { value: p.name, onchange: e => set(pp => { pp.name = e.target.value.trim() || 'Untitled project'; }) })),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: saveProjectBundle }, 'Save project bundle (.ntm.zip)'),
        h('button', { class: 'btn', onclick: async () => { const f = await pickFiles({ multiple: false, accept: '.zip' }); if (f.length) importFiles(f); } }, 'Open bundle…'),
        h('button', {
          class: 'btn danger', onclick: async () => {
            if (!(await confirmModal('Start a new project?', 'This clears the current project and its stored audio from this browser. Save a bundle first if you want to keep it.', { ok: 'Clear and start new', danger: true }))) return;
            await clearSources(); clearCaches(); replaceProject(newProject()); toast('New project started.');
          },
        }, 'New project')),
      h('p', { class: 'small' }, 'Browser storage: ', est))));
}
