// "Virtual Nutella": emulates the trigger functions in the browser so a card can be
// auditioned before it is written. Approximates Tsunami behaviour per the User Guide.

import { state, emit, trackByNum } from './state.js';
import { getRendered, play, audioCtx } from './audio.js';
import { BOARDS, TRIGGER_BANKS, MIDI_BANKS } from './constants.js';
import { dbToGain, clamp } from './util.js';

export const sim = {
  bank: 0, midiBank: 0, outVol: new Array(8).fill(0),
  voices: [], paused: [], inhibit: new Map(), cursor: {}, lastRandom: {}, flash: {},
};

const inRange = (n, t) => n >= t.low && n <= t.high;

function maxVoices() {
  const p = state.project;
  return BOARDS[p.board]?.[p.mode] ?? 18;
}

function removeVoice(v) {
  const i = sim.voices.indexOf(v);
  if (i >= 0) sim.voices.splice(i, 1);
  emit('sim');
}

function flash(trig, kind) {
  sim.flash[trig] = { kind, at: performance.now() };
  emit('sim');
}

export function activeTracks() {
  return new Set(sim.voices.map(v => v.num));
}

async function playTrack(num, { trig, output = 0, loop = false, poly = true, gainDb = 0, lock = false, offset = 0, at } = {}) {
  for (const [, ranges] of sim.inhibit) if (ranges.some(r => num >= r.low && num <= r.high)) return null;
  const track = trackByNum().get(num);
  if (!track?.sourceId) { flash(trig, 'empty'); return null; }
  if (!poly) for (const v of [...sim.voices]) if (v.output === output) { v.handle.stop(); removeVoice(v); }
  if (sim.voices.length >= maxVoices()) {
    const victim = sim.voices.find(v => !v.lock);
    if (victim) { victim.handle.stop(); removeVoice(victim); }
  }
  let r;
  try { r = await getRendered(track, state.project); } catch { flash(trig, 'empty'); return null; }
  const outDb = (state.project.global.outVol[output] || 0) + sim.outVol[output];
  const voice = { num, trig, output, lock, gainDb, loop };
  voice.handle = play(r.channels, { loop, gainDb: gainDb + outDb, offset, onEnd: () => removeVoice(voice), at });
  sim.voices.push(voice);
  emit('sim');
  return voice;
}

function stopWhere(pred) {
  for (const v of [...sim.voices]) if (pred(v)) { v.handle.stop(); removeVoice(v); }
}

export function stopAllSim() {
  stopWhere(() => true);
  sim.paused = [];
  sim.inhibit.clear();
}

export async function press(n) {
  const t = state.project.triggers[n - 1];
  if (!t) return;
  const opts = { trig: n, output: t.output, loop: t.loop, poly: t.poly, gainDb: t.gain, lock: t.lock };
  const mine = sim.voices.filter(v => v.trig === n);

  // Latch: second press stops whatever this trigger started.
  if (t.type === 2 && mine.length && [1, 2, 3, 4, 14].includes(t.func)) { stopWhere(v => v.trig === n); flash(n, 'stop'); return; }
  if (!t.retrigger && mine.length && [1, 2, 3, 4, 14].includes(t.func)) { flash(n, 'busy'); return; }
  if (t.retrigger && t.func === 1) stopWhere(v => v.trig === n && v.num === sim.bank * 16 + n);

  switch (t.func) {
    case 1: await playTrack(sim.bank * 16 + n, opts); break;
    case 2: case 3: {
      const size = t.high - t.low + 1;
      let c = sim.cursor[n];
      if (c == null) c = t.func === 2 ? 0 : size - 1;
      const num = t.low + c;
      sim.cursor[n] = t.func === 2 ? (c + 1) % size : (c - 1 + size) % size;
      await playTrack(num, opts);
      break;
    }
    case 4: {
      const size = t.high - t.low + 1;
      let num;
      do { num = t.low + Math.floor(Math.random() * size); } while (size > 1 && num === sim.lastRandom[n]);
      sim.lastRandom[n] = num;
      await playTrack(num, opts);
      break;
    }
    case 5: {
      for (const v of sim.voices.filter(v => inRange(v.num, t))) {
        sim.paused.push({ ...v, offset: v.handle.position() });
        v.handle.stop(); removeVoice(v);
      }
      break;
    }
    case 6: resumeRange(t); break;
    case 7:
      stopWhere(v => inRange(v.num, t));
      sim.paused = sim.paused.filter(v => !inRange(v.num, t));
      if (t.type === 1) sim.inhibit.set(n, [{ low: t.low, high: t.high }]);
      break;
    case 8: case 9: {
      const d = t.func === 8 ? 1 : -1;
      const outs = t.output === 8 ? [0, 1, 2, 3, 4, 5, 6, 7] : [t.output];
      for (const o of outs) sim.outVol[o] = clamp(sim.outVol[o] + d, -70, 10);
      for (const v of sim.voices) if (outs.includes(v.output))
        v.handle.gain.gain.value = dbToGain(v.gainDb + (state.project.global.outVol[v.output] || 0) + sim.outVol[v.output]);
      break;
    }
    case 10: sim.midiBank = clamp(sim.midiBank + 1, 0, MIDI_BANKS - 1); break;
    case 11: sim.midiBank = clamp(sim.midiBank - 1, 0, MIDI_BANKS - 1); break;
    case 12: sim.bank = clamp(sim.bank + 1, 0, TRIGGER_BANKS - 1); state.ui.padBank = sim.bank; break;
    case 13: sim.bank = clamp(sim.bank - 1, 0, TRIGGER_BANKS - 1); state.ui.padBank = sim.bank; break;
    case 14: {
      const nums = [];
      for (let k = t.low; k <= Math.min(t.high, t.low + 7); k++) nums.push(k);
      // Render first so all voices start on the same audio clock tick (sample-locked).
      const tracks = trackByNum();
      await Promise.all(nums.map(k => tracks.get(k)?.sourceId ? getRendered(tracks.get(k), state.project).catch(() => null) : null));
      const at = audioCtx().currentTime + 0.03;
      nums.forEach((k, i) => playTrack(k, { ...opts, output: Math.min(7, t.output + i), poly: true, at }));
      break;
    }
  }
  flash(n, 'hit');
}

function resumeRange(t) {
  const list = sim.paused.filter(v => inRange(v.num, t));
  sim.paused = sim.paused.filter(v => !inRange(v.num, t));
  for (const v of list) playTrack(v.num, { ...v, offset: v.offset % (v.handle.duration || 1) });
}

export function release(n) {
  const t = state.project.triggers[n - 1];
  if (!t || t.type !== 1) return;
  if ([1, 2, 3, 4, 14].includes(t.func)) stopWhere(v => v.trig === n);
  else if (t.func === 5) resumeRange(t);
  else if (t.func === 7) sim.inhibit.delete(n);
  emit('sim');
}

export function setSimBank(b) { sim.bank = clamp(b, 0, TRIGGER_BANKS - 1); }
