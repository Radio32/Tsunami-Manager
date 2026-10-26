// Talking to real hardware from the browser:
//  - Web MIDI → Nutella's MIDI input (works with any USB-MIDI interface)
//  - Web Serial → Tsunami serial header via a 3.3 V FTDI adapter (Configurator-style "Test")

import { CMD, TRK, RSP } from './constants.js';
import { triggerFlags, funcHasRange } from './ini.js';
import { emit } from './state.js';

// ---------------- MIDI ----------------

export const midi = {
  access: null, output: null, channel: 0, error: null, midiBank: 0,
  followSelection: false,
};

export async function midiConnect() {
  if (!navigator.requestMIDIAccess) { midi.error = 'Web MIDI is not available in this browser (use Chrome or Edge).'; emit('live'); return; }
  try {
    midi.access = await navigator.requestMIDIAccess({ sysex: false });
    midi.access.onstatechange = () => emit('live');
    const outs = midiOutputs();
    if (!midi.output && outs.length) midi.output = outs[0];
    midi.error = null;
  } catch (e) { midi.error = e.message; }
  emit('live');
}

export function midiOutputs() { return midi.access ? [...midi.access.outputs.values()] : []; }
export function midiSelect(id) { midi.output = midiOutputs().find(o => o.id === id) || null; emit('live'); }

function send(bytes) { midi.output?.send(bytes); }

export function midiProgram(bank) {
  midi.midiBank = bank;
  send([0xc0 | midi.channel, bank & 0x7f]);
}

// Play a track via MIDI: switches MIDI bank by Program Change when needed.
export function midiPlayTrack(num, velocity = 127) {
  if (!midi.output) return false;
  const bank = Math.floor(num / 128), note = num % 128;
  if (bank !== midi.midiBank) midiProgram(bank);
  send([0x90 | midi.channel, note, velocity]);
  return { bank, note };
}

export function midiStopTrack(num) {
  send([0x80 | midi.channel, num % 128, 0]);
}

export function midiPanic() {
  send([0xb0 | midi.channel, 123, 0]);
  send([0xfc]);
}

export function midiCC(cc, value) { send([0xb0 | midi.channel, cc, value & 0x7f]); }

// ---------------- Serial ----------------

export const serial = {
  port: null, reader: null, writer: null, connected: false, error: null,
  version: null, sysinfo: null, playing: [], log: [],
};

const SOM1 = 0xf0, SOM2 = 0xaa, EOM = 0x55;

function frame(code, data = []) {
  return new Uint8Array([SOM1, SOM2, data.length + 5, code, ...data, EOM]);
}

function logLine(s) {
  serial.log.push(`${new Date().toLocaleTimeString()}  ${s}`);
  if (serial.log.length > 200) serial.log.shift();
  emit('live');
}

export async function serialConnect(baud = 57600) {
  if (!navigator.serial) { serial.error = 'Web Serial is not available in this browser (use Chrome or Edge).'; emit('live'); return; }
  try {
    serial.port = await navigator.serial.requestPort();
    await serial.port.open({ baudRate: baud });
    serial.writer = serial.port.writable.getWriter();
    serial.connected = true;
    serial.error = null;
    logLine(`Connected at ${baud} baud`);
    readLoop();
    await serialSend(CMD.GET_VERSION);
    await serialSend(CMD.GET_SYS_INFO);
  } catch (e) {
    if (e.name !== 'NotFoundError') serial.error = e.message;
  }
  emit('live');
}

export async function serialDisconnect() {
  serial.connected = false;
  try {
    await serial.reader?.cancel();
    serial.writer?.releaseLock();
    await serial.port?.close();
  } catch { /* ignore */ }
  Object.assign(serial, { port: null, reader: null, writer: null, connected: false });
  logLine('Disconnected');
}

async function readLoop() {
  const buf = [];
  while (serial.port?.readable && serial.connected) {
    serial.reader = serial.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await serial.reader.read();
        if (done) break;
        buf.push(...value);
        parseIncoming(buf);
      }
    } catch (e) {
      logLine('Read error: ' + e.message);
      break;
    } finally {
      serial.reader.releaseLock();
    }
  }
}

function parseIncoming(buf) {
  for (;;) {
    const s = buf.findIndex((b, i) => b === SOM1 && buf[i + 1] === SOM2);
    if (s < 0) { buf.length = 0; return; }
    if (s > 0) buf.splice(0, s);
    if (buf.length < 3) return;
    const len = buf[2];
    if (len < 5 || len > 64) { buf.splice(0, 2); continue; }
    if (buf.length < len) return;
    const msg = buf.splice(0, len);
    if (msg[len - 1] !== EOM) continue;
    const code = msg[3], data = msg.slice(4, len - 1);
    if (code === RSP.VERSION) { serial.version = String.fromCharCode(...data).replace(/\0/g, '').trim(); logLine('Version: ' + serial.version); }
    else if (code === RSP.SYS_INFO) { serial.sysinfo = { voices: data[0], tracks: data[1] | (data[2] << 8) }; logLine(`Voices ${serial.sysinfo.voices}, tracks on card ${serial.sysinfo.tracks}`); }
    else if (code === RSP.STATUS) { serial.playing = []; for (let i = 0; i + 1 < data.length; i += 2) serial.playing.push(data[i] | (data[i + 1] << 8)); }
    else if (code === RSP.TRACK_REPORT) {
      const t = data[0] | (data[1] << 8);
      logLine(`Track ${t} ${data[3] ? 'started' : 'stopped'} (voice ${data[2]})`);
    }
    emit('live');
  }
}

export async function serialSend(code, data = []) {
  if (!serial.writer) return;
  await serial.writer.write(frame(code, data));
}

const le16 = v => [v & 0xff, (v >> 8) & 0xff];

export const serialCmd = {
  play: (track, out = 0, poly = true, lock = false) =>
    serialSend(CMD.TRACK_CONTROL, [poly ? TRK.PLAY_POLY : TRK.PLAY_SOLO, ...le16(track), out, lock ? 1 : 0]),
  stop: (track) => serialSend(CMD.TRACK_CONTROL, [TRK.STOP, ...le16(track), 0, 0]),
  stopAll: () => serialSend(CMD.STOP_ALL),
  outputVolume: (out, db) => serialSend(CMD.OUTPUT_VOLUME, [out, ...le16(db & 0xffff)]),
  trackVolume: (track, db) => serialSend(CMD.TRACK_VOLUME, [...le16(track), ...le16(db & 0xffff)]),
  triggerBank: (bank) => serialSend(CMD.SET_TRIGGER_BANK, [bank]),
  midiBank: (bank) => serialSend(CMD.SET_MIDI_BANK, [bank]),
  reporting: (on) => serialSend(CMD.SET_REPORTING, [on ? 1 : 0]),
  status: () => serialSend(0x07),
  inputMix: (mask) => serialSend(CMD.SET_INPUT_MIX, [mask & 0x0f]),
  // Same message the Configurator's "Test" button sends: applies to RAM until reset.
  pushTrigger: (t) => {
    const lo = funcHasRange(t.func) ? t.low : 0, hi = funcHasRange(t.func) ? t.high : 0;
    return serialSend(CMD.TRIGGER_SET, [t.num - 1, triggerFlags(t), t.gain & 0xff, t.output, t.func, ...le16(lo), ...le16(hi)]);
  },
};
