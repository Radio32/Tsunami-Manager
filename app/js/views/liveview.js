// Live: drive the real Nutella/Tsunami over MIDI or serial.

import { h, noteName } from '../util.js';
import { state, trackByNum } from '../state.js';
import { midi, midiConnect, midiOutputs, midiSelect, midiPlayTrack, midiPanic, midiProgram, midiCC, serial, serialConnect, serialDisconnect, serialCmd } from '../live.js';
import { field, select as sel, toggle, numberInput, slider, icon } from '../ui.js';

let testTrack = 1;

export function renderLive() {
  const p = state.project;
  const mono = p.mode === 'mono';
  const outs = midiOutputs();
  const tracks = trackByNum();
  const t = tracks.get(testTrack);

  const midiPanel = h('section', { class: 'panel' },
    h('h3', null, 'MIDI → Nutella'),
    h('p', { class: 'muted small' }, 'Connect a USB-MIDI interface to Nutella\'s MIDI input. Audition tracks on the real hardware, switch MIDI banks, set volumes live.'),
    !midi.access
      ? h('button', { class: 'btn primary', onclick: midiConnect }, 'Enable MIDI')
      : h('div', null,
        h('div', { class: 'row' },
          field('Output port', sel(outs.length ? outs.map(o => [o.id, o.name]) : [['', 'No MIDI outputs found']], midi.output?.id || '', midiSelect)),
          field('Channel', sel(Array.from({ length: 16 }, (_, i) => [i, `Ch ${i + 1}`]), midi.channel, v => { midi.channel = +v; }))),
        p.global.midiChannel && p.global.midiChannel - 1 !== midi.channel ? h('p', { class: 'warn small' }, `The project's ini listens on channel ${p.global.midiChannel} only.`) : null,
        toggle('Double-click on pads plays on hardware instead of in the browser', midi.followSelection, v => { midi.followSelection = v; }),
        h('div', { class: 'row' },
          field('Track', numberInput(testTrack, v => { testTrack = Math.round(v || 1); }, { min: 1, max: 4096, width: '6em' })),
          h('div', { class: 'muted small' }, t ? t.name : 'empty', h('br'), `MIDI bank ${Math.floor(testTrack / 128)}, note ${testTrack % 128} (${noteName(testTrack % 128, p.ui.noteConvention)})`),
          h('button', { class: 'btn primary', disabled: !midi.output, onclick: () => midiPlayTrack(testTrack) }, icon('play'), 'Play'),
          h('button', { class: 'btn danger', disabled: !midi.output, onclick: midiPanic }, 'Panic')),
        field('MIDI bank (Program Change)', h('div', { class: 'row tight' },
          numberInput(midi.midiBank, v => midiProgram(Math.round(v || 0)), { min: 0, max: 31, width: '5em' }))),
        h('details', { class: 'adv' }, h('summary', null, 'Output volumes & envelopes (CC)'),
          h('div', { class: 'outs' }, Array.from({ length: 8 }, (_, i) => field(`Out ${i + 1} (CC${20 + i})`,
            slider(100, v => midiCC(20 + i, v), { min: 0, max: 127, step: 1, live: v => midiCC(20 + i, v) })))),
          field('Attack (CC73)', slider(0, v => midiCC(73, v), { min: 0, max: 127, live: v => midiCC(73, v) })),
          field('Release (CC72)', slider(0, v => midiCC(72, v), { min: 0, max: 127, live: v => midiCC(72, v) })))),
    midi.error ? h('p', { class: 'warn small' }, midi.error) : null);

  const serialPanel = h('section', { class: 'panel' },
    h('h3', null, 'Serial → Tsunami (advanced)'),
    h('p', { class: 'muted small' }, 'Needs a 3.3 V FTDI-style adapter on the Tsunami serial header (pin-compatible with SparkFun FTDI Basic 3.3V). Tsunami\'s RX is NOT 5 V tolerant.'),
    !serial.connected
      ? h('button', { class: 'btn', onclick: () => serialConnect(p.global.baud) }, `Connect (${p.global.baud} baud)`)
      : h('div', null,
        h('div', { class: 'row' },
          h('div', { class: 'small' }, h('strong', null, serial.version || 'Tsunami'), serial.sysinfo ? ` · ${serial.sysinfo.voices} voices · ${serial.sysinfo.tracks} tracks on card` : ''),
          h('button', { class: 'btn tiny', onclick: serialDisconnect }, 'Disconnect')),
        serial.sysinfo && serial.sysinfo.tracks !== tracks.size ? h('p', { class: 'warn small' }, `The card has ${serial.sysinfo.tracks} tracks; this project has ${tracks.size}. Write the card and press RESET to sync.`) : null,
        h('div', { class: 'row' },
          field('Track', numberInput(testTrack, v => { testTrack = Math.round(v || 1); }, { min: 1, max: 4096, width: '6em' })),
          h('button', { class: 'btn primary', onclick: () => serialCmd.play(testTrack, t?.midi.out ? t.midi.out - 1 : 0) }, icon('play'), 'Play'),
          h('button', { class: 'btn', onclick: () => serialCmd.stop(testTrack) }, 'Stop'),
          h('button', { class: 'btn danger', onclick: serialCmd.stopAll }, 'Stop all')),
        h('div', { class: 'row' },
          field('Trigger bank', numberInput(1, v => serialCmd.triggerBank(Math.round(v || 1)), { min: 1, max: 32, width: '5em' })),
          field('MIDI bank', numberInput(1, v => serialCmd.midiBank(Math.round(v || 1)), { min: 1, max: 32, width: '5em' })),
          toggle('Track reporting', false, v => serialCmd.reporting(v))),
        h('details', { class: 'adv' }, h('summary', null, 'Output volume'),
          h('div', { class: 'outs' }, Array.from({ length: mono ? 8 : 4 }, (_, i) => field(`Out ${i + 1}`,
            slider(0, v => serialCmd.outputVolume(i, v), { min: -70, max: 10, step: 1, format: v => `${v} dB` }))))),
        h('p', { class: 'muted small' }, 'On the Triggers page, each card gets a “Test” button that pushes that trigger\'s settings into Tsunami\'s RAM (like the Configurator) until the next reset.'),
        h('div', { class: 'log' }, serial.log.slice(-60).map(l => h('div', null, l)))),
    serial.error ? h('p', { class: 'warn small' }, serial.error) : null);

  return h('div', { class: 'view live-view' }, h('div', { class: 'panels two' }, midiPanel, serialPanel));
}
