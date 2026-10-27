// Audio engine: decode any browser-supported format to 44.1 kHz float, apply the
// per-track edit chain, analyze, and audition. All processing is local.

import { SAMPLE_RATE } from './constants.js';
import { decodeAiff, isAiff } from './wav.js';
import { getSource } from './store.js';
import { dbToGain, gainToDb } from './util.js';

class LRU {
  constructor(budget) { this.budget = budget; this.used = 0; this.map = new Map(); }
  get(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k); this.map.set(k, e);
    return e.v;
  }
  set(k, v, size) {
    if (this.map.has(k)) this.delete(k);
    this.map.set(k, { v, size });
    this.used += size;
    for (const [key] of this.map) {
      if (this.used <= this.budget || this.map.size <= 1) break;
      this.delete(key);
    }
  }
  delete(k) {
    const e = this.map.get(k);
    if (e) { this.used -= e.size; this.map.delete(k); }
  }
  clear() { this.map.clear(); this.used = 0; }
}

const sizeOf = chs => chs.reduce((s, c) => s + c.byteLength, 0);
const decoded = new LRU(512 * 1024 * 1024);
const rendered = new LRU(256 * 1024 * 1024);
const pending = new Map();

async function resample(channels, fromRate) {
  if (fromRate === SAMPLE_RATE) return channels;
  const len = channels[0].length;
  const outLen = Math.max(1, Math.round(len * SAMPLE_RATE / fromRate));
  const ctx = new OfflineAudioContext(channels.length, outLen, SAMPLE_RATE);
  const buf = ctx.createBuffer(channels.length, len, fromRate);
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return Array.from({ length: out.numberOfChannels }, (_, i) => out.getChannelData(i).slice());
}

// Returns { channels: Float32Array[] @44.1k, origRate, origChannels, origBits? }
export async function decodeBytes(ab) {
  if (isAiff(ab)) {
    const a = decodeAiff(ab);
    return { channels: await resample(a.channels, a.rate), origRate: Math.round(a.rate), origChannels: a.channels.length };
  }
  const origRate = sniffWavRate(ab);
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const buf = await ctx.decodeAudioData(ab.slice(0));
  const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
  return { channels, origRate: origRate || null, origChannels: buf.numberOfChannels };
}

function sniffWavRate(ab) {
  try {
    const dv = new DataView(ab);
    if (dv.getUint32(0) !== 0x52494646) return null;
    let off = 12;
    while (off + 8 < Math.min(ab.byteLength, 1 << 20)) {
      const id = dv.getUint32(off), size = dv.getUint32(off + 4, true);
      if (id === 0x666d7420) return dv.getUint32(off + 12, true);
      off += 8 + size + (size & 1);
    }
  } catch { /* not a wav */ }
  return null;
}

export async function getDecoded(sourceId) {
  const hit = decoded.get(sourceId);
  if (hit) return hit;
  if (pending.has(sourceId)) return pending.get(sourceId);
  const p = (async () => {
    const rec = await getSource(sourceId);
    if (!rec) throw new Error('Source audio is missing from browser storage');
    const d = await decodeBytes(rec.data);
    decoded.set(sourceId, d, sizeOf(d.channels));
    return d;
  })();
  pending.set(sourceId, p);
  try { return await p; } finally { pending.delete(sourceId); }
}

export function cacheDecoded(sourceId, d) { decoded.set(sourceId, d, sizeOf(d.channels)); }
export function forgetSource(sourceId) { decoded.delete(sourceId); }
export function clearCaches() { decoded.clear(); rendered.clear(); }

export function analyze(channels) {
  let peak = 0, sum = 0, n = 0;
  for (const c of channels) {
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]);
      if (a > peak) peak = a;
      sum += c[i] * c[i];
    }
    n += c.length;
  }
  return { peakDb: gainToDb(peak), rmsDb: n ? gainToDb(Math.sqrt(sum / n)) : -Infinity };
}

// Overview of max |sample| per bucket, 0..255, for cheap waveform thumbnails.
export function overview(channels, buckets = 160) {
  const len = channels[0]?.length || 0;
  const out = new Array(buckets).fill(0);
  if (!len) return out;
  const step = len / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * step), e = Math.min(len, Math.floor((b + 1) * step) + 1);
    let m = 0;
    for (const c of channels) for (let i = s; i < e; i += 4) { const a = Math.abs(c[i]); if (a > m) m = a; }
    out[b] = Math.min(255, Math.round(Math.sqrt(m) * 255));
  }
  return out;
}

export function targetChannels(project) { return project.mode === 'mono' ? 1 : 2; }

export function effectiveNorm(track, project) {
  const e = track.edits;
  const mode = e.norm === 'project' ? project.processing.norm : e.norm;
  const target = e.normTarget ?? (mode === 'rms' ? project.processing.rmsTarget : project.processing.peakTarget);
  return { mode, target };
}

export function renderKey(track, project) {
  const n = effectiveNorm(track, project);
  return JSON.stringify([track.sourceId, track.edits, project.mode, n, project.processing.dither]);
}

function mapChannels(src, T, chan) {
  const [L, R = L] = src;
  const avg = () => { const o = new Float32Array(L.length); for (let i = 0; i < o.length; i++) o[i] = (L[i] + R[i]) * 0.5; return o; };
  if (T === 1) {
    if (chan === 'left') return [L];
    if (chan === 'right') return [R];
    return [src.length > 1 ? avg() : L];
  }
  if (src.length === 1) return [L, L];
  if (chan === 'left') return [L, L];
  if (chan === 'right') return [R, R];
  if (chan === 'sum') { const m = avg(); return [m, m]; }
  if (chan === 'swap') return [R, L];
  return [L, R];
}

// Balance-style pan baked into the file: centre is unity, the far side fades out
// on a constant-power curve. Never boosts, so panning can't cause clipping.
export function panGains(p) {
  const a = Math.min(1, Math.abs(p)) * Math.PI / 2;
  return p < 0 ? [1, Math.cos(a)] : [Math.cos(a), 1];
}

function applyPan(chs, p) {
  const [gl, gr] = panGains(p);
  if (gl !== 1) for (let i = 0; i < chs[0].length; i++) chs[0][i] *= gl;
  if (gr !== 1) for (let i = 0; i < chs[1].length; i++) chs[1][i] *= gr;
}

function fadeCurve(x, curve) {
  if (curve === 'smooth') return Math.sin(x * Math.PI / 2);
  if (curve === 'exp') return x * x * x;
  return x;
}

// Full edit chain. Returns new arrays; never mutates the decoded source.
export function renderChannels(track, d, project) {
  const e = track.edits;
  const T = targetChannels(project);
  const total = d.channels[0].length;
  const s0 = Math.max(0, Math.min(total, Math.round((e.trimStart || 0) * SAMPLE_RATE)));
  const s1 = e.trimEnd != null ? Math.max(s0, Math.min(total, Math.round(e.trimEnd * SAMPLE_RATE))) : total;
  const mapped = mapChannels(d.channels, T, e.chan || 'auto');
  const out = mapped.map(c => {
    const seg = c.slice(s0, Math.max(s0 + 1, s1));
    if (e.reverse) seg.reverse();
    return seg;
  });
  if (out.length === 2 && e.pan) applyPan(out, e.pan / 100);
  const len = out[0].length;
  const fi = Math.min(len, Math.round((e.fadeIn || 0) * SAMPLE_RATE / 1000));
  const fo = Math.min(len, Math.round((e.fadeOut || 0) * SAMPLE_RATE / 1000));
  for (const c of out) {
    for (let i = 0; i < fi; i++) c[i] *= fadeCurve(i / fi, e.fadeCurve);
    for (let i = 0; i < fo; i++) c[len - 1 - i] *= fadeCurve(i / fo, e.fadeCurve);
  }
  const pre = analyze(out);
  const { mode, target } = effectiveNorm(track, project);
  let normDb = 0;
  if (isFinite(pre.peakDb)) {
    if (mode === 'peak') normDb = target - pre.peakDb;
    else if (mode === 'rms') normDb = Math.min(target - pre.rmsDb, -0.3 - pre.peakDb);
  }
  const totalDb = normDb + (e.gain || 0);
  if (totalDb !== 0) {
    const g = dbToGain(totalDb);
    for (const c of out) for (let i = 0; i < c.length; i++) c[i] *= g;
  }
  return {
    channels: out, normDb, totalDb,
    peakDb: pre.peakDb + totalDb, rmsDb: pre.rmsDb + totalDb,
    duration: len / SAMPLE_RATE,
  };
}

export async function getRendered(track, project) {
  const key = renderKey(track, project);
  const hit = rendered.get(key);
  if (hit) return hit;
  const d = await getDecoded(track.sourceId);
  const r = renderChannels(track, d, project);
  rendered.set(key, r, sizeOf(r.channels));
  return r;
}

// Find first/last sample above threshold.
export function detectSilence(channels, thresholdDb = -50) {
  const th = dbToGain(thresholdDb);
  const len = channels[0].length;
  let s = 0, e = len - 1;
  const loud = i => channels.some(c => Math.abs(c[i]) > th);
  while (s < len && !loud(s)) s++;
  while (e > s && !loud(e)) e--;
  return { start: s / SAMPLE_RATE, end: (e + 1) / SAMPLE_RATE };
}

// ---------- Playback ----------

let ctx;
export function audioCtx() {
  ctx ??= new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

const playing = new Set();

export function play(channels, { loop = false, gainDb = 0, offset = 0, onEnd, at } = {}) {
  const c = audioCtx();
  const buf = c.createBuffer(channels.length, channels[0].length, SAMPLE_RATE);
  channels.forEach((ch, i) => buf.copyToChannel(ch, i));
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = loop;
  const g = c.createGain();
  g.gain.value = dbToGain(gainDb);
  src.connect(g).connect(c.destination);
  const handle = {
    src, gain: g, duration: buf.duration, startedAt: (at ?? c.currentTime) - offset, loop, stopped: false,
    position() { const t = c.currentTime - this.startedAt; return loop ? t % this.duration : Math.min(t, this.duration); },
    stop(releaseMs = 8) {
      if (this.stopped) return;
      this.stopped = true;
      const now = c.currentTime;
      g.gain.setTargetAtTime(0, now, releaseMs / 3000);
      try { src.stop(now + releaseMs / 1000 + 0.02); } catch { /* already stopped */ }
    },
  };
  src.onended = () => { handle.stopped = true; playing.delete(handle); onEnd?.(handle); };
  src.start(at ?? c.currentTime, offset);
  playing.add(handle);
  return handle;
}

export function stopAll() { for (const p of [...playing]) p.stop(); }
