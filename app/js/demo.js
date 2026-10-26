// Synthesizes two small drum kits so the app can be tried without any samples.

import { encodeWav16 } from './wav.js';
import { importFiles } from './importer.js';

const SR = 44100;

async function synth(seconds, build) {
  const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
  build(ctx, ctx.destination);
  const buf = await ctx.startRendering();
  return buf.getChannelData(0);
}

function noise(ctx, seconds) {
  const b = ctx.createBuffer(1, Math.round(SR * seconds), SR);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource();
  s.buffer = b;
  return s;
}

function env(ctx, peak, attack, decay, t0 = 0) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  return g;
}

const drum = (f0, f1, decay, len = 0.6) => synth(len, (ctx, out) => {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(f0, 0);
  o.frequency.exponentialRampToValueAtTime(f1, decay * 0.6);
  const g = env(ctx, 0.9, 0.002, decay);
  o.connect(g).connect(out); o.start();
});

const hiss = (type, freq, q, decay, len, gain = 0.6) => synth(len, (ctx, out) => {
  const n = noise(ctx, len);
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = env(ctx, gain, 0.001, decay);
  n.connect(f).connect(g).connect(out); n.start();
});

const snare = (tone, decay) => synth(0.4, (ctx, out) => {
  const n = noise(ctx, 0.4);
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500;
  n.connect(f).connect(env(ctx, 0.5, 0.001, decay)).connect(out); n.start();
  const o = ctx.createOscillator(); o.frequency.value = tone;
  o.connect(env(ctx, 0.5, 0.001, decay * 0.5)).connect(out); o.start();
});

const clap = () => synth(0.4, (ctx, out) => {
  const n = noise(ctx, 0.4);
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200; f.Q.value = 0.8;
  const g = ctx.createGain(); g.gain.value = 0;
  [0, 0.012, 0.024].forEach(t => { g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.01); });
  g.gain.setValueAtTime(0.6, 0.036); g.gain.exponentialRampToValueAtTime(0.0001, 0.3);
  n.connect(f).connect(g).connect(out); n.start();
});

const bell = (f1, f2, decay) => synth(decay + 0.1, (ctx, out) => {
  const g = env(ctx, 0.35, 0.001, decay);
  for (const f of [f1, f2]) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f; o.connect(g); o.start(); }
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = (f1 + f2); bp.Q.value = 1.5;
  g.connect(bp).connect(out);
});

const tone = (freq, type, len, attack, decay, gain = 0.4) => synth(len, (ctx, out) => {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
  const lp = ctx.createBiquadFilter(); lp.frequency.value = freq * 6;
  o.connect(lp).connect(env(ctx, gain, attack, decay)).connect(out); o.start();
});

async function kit(variant) {
  const p = variant ? 0.8 : 1; // second kit is lower and longer
  return [
    ['Kick', await drum(160 * p, 42 * p, 0.45 / p)],
    ['Snare', await snare(190 * p, 0.18 / p)],
    ['Closed Hat', await hiss('highpass', 7000 * p, 0.7, 0.05, 0.12)],
    ['Open Hat', await hiss('highpass', 6500 * p, 0.7, 0.45, 0.6)],
    ['Clap', await clap()],
    ['Low Tom', await drum(120 * p, 70 * p, 0.4)],
    ['Mid Tom', await drum(170 * p, 100 * p, 0.35)],
    ['High Tom', await drum(240 * p, 140 * p, 0.3)],
    ['Rim', await hiss('bandpass', 2500 * p, 6, 0.03, 0.08, 0.9)],
    ['Cowbell', await bell(540 * p, 800 * p, 0.35)],
    ['Shaker', await hiss('bandpass', 9000, 2, 0.07, 0.15, 0.5)],
    ['Crash', await hiss('highpass', 4000 * p, 0.5, 1.4, 1.6, 0.5)],
    ['Bass C', await tone(65.4 * p, 'sawtooth', 0.8, 0.005, 0.7)],
    ['Bass G', await tone(98 * p, 'sawtooth', 0.8, 0.005, 0.7)],
  ];
}

export async function loadDemo() {
  const files = [];
  for (let v = 0; v < 2; v++) {
    const sounds = await kit(v);
    sounds.forEach(([name, data], i) => {
      const { bytes } = encodeWav16([data], { dither: false });
      const num = v * 16 + i + 1; // slots 1–14 of bank v; 15/16 are bank nav
      files.push(new File([bytes], `${String(num).padStart(4, '0')}_${name}${v ? ' (kit B)' : ''}.wav`, { type: 'audio/wav' }));
    });
  }
  return importFiles(files, { useNames: true });
}
