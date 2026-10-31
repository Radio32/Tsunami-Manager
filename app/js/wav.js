// WAV encoding/inspection and an AIFF decoder (Chrome can't decode AIFF natively).

import { SAMPLE_RATE } from './constants.js';

// Canonical 44-byte header: RIFF / fmt (PCM 16) / data. Nothing else, so no metadata ever.
export function encodeWav16(channels, { sampleRate = SAMPLE_RATE, dither = true } = {}) {
  const nch = channels.length;
  const frames = channels[0]?.length || 0;
  const dataBytes = frames * nch * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);

  const pcm = new Int16Array(buf, 44, frames * nch);
  let clipped = 0;
  for (let c = 0; c < nch; c++) {
    const ch = channels[c];
    for (let i = 0, j = c; i < frames; i++, j += nch) {
      let s = ch[i] * 32767;
      if (dither) s += (Math.random() - Math.random()); // TPDF, ±1 LSB
      s = Math.round(s);
      if (s > 32767) { s = 32767; clipped++; } else if (s < -32768) { s = -32768; clipped++; }
      pcm[j] = s;
    }
  }
  return { bytes: new Uint8Array(buf), clipped };
}

const FORMAT_NAMES = { 1: 'PCM', 3: 'IEEE float', 6: 'A-law', 7: 'µ-law', 0xfffe: 'Extensible', 0x55: 'MP3', 2: 'ADPCM', 0x11: 'IMA ADPCM' };

// Walk the RIFF chunk list of a Blob/File without reading the audio.
export async function inspectWav(blob) {
  const res = { ok: false, chunks: [], problems: [], fmt: null, dataOffset: 0, dataSize: 0, size: blob.size };
  const head = new DataView(await blob.slice(0, 12).arrayBuffer());
  const id4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (head.byteLength < 12 || id4(head, 0) !== 'RIFF' || id4(head, 8) !== 'WAVE') {
    if (head.byteLength >= 12 && id4(head, 0) === 'RF64') res.problems.push({ sev: 'error', msg: 'RF64 (64-bit) WAV is not supported by Tsunami.' });
    else res.problems.push({ sev: 'error', msg: 'Not a RIFF/WAVE file.' });
    return res;
  }
  let off = 12;
  let guard = 0;
  while (off + 8 <= blob.size && guard++ < 256) {
    const dv = new DataView(await blob.slice(off, off + 8).arrayBuffer());
    const id = id4(dv, 0);
    const size = dv.getUint32(4, true);
    const chunk = { id, offset: off, size };
    res.chunks.push(chunk);
    if (id === 'fmt ') {
      const f = new DataView(await blob.slice(off + 8, off + 8 + Math.min(size, 40)).arrayBuffer());
      let format = f.getUint16(0, true);
      if (format === 0xfffe && size >= 40) format = f.getUint16(24, true); // SubFormat GUID first 2 bytes
      res.fmt = {
        format, formatName: FORMAT_NAMES[format] || `0x${format.toString(16)}`,
        extensible: f.getUint16(0, true) === 0xfffe,
        channels: f.getUint16(2, true), rate: f.getUint32(4, true),
        blockAlign: f.getUint16(12, true), bits: f.getUint16(14, true), fmtSize: size,
      };
    } else if (id === 'data') {
      res.dataOffset = off + 8;
      res.dataSize = Math.min(size, blob.size - off - 8);
      if (size > blob.size - off - 8) res.problems.push({ sev: 'warn', msg: 'Data chunk is truncated (file shorter than header claims).' });
    }
    off += 8 + size + (size & 1);
  }
  const dataIdx = res.chunks.findIndex(c => c.id === 'data');
  const fmtIdx = res.chunks.findIndex(c => c.id === 'fmt ');
  if (fmtIdx < 0) res.problems.push({ sev: 'error', msg: 'No fmt chunk.' });
  if (dataIdx < 0) res.problems.push({ sev: 'error', msg: 'No data chunk.' });
  if (dataIdx >= 0) {
    const before = res.chunks.slice(0, dataIdx).filter(c => c.id !== 'fmt ');
    if (before.length) res.problems.push({
      sev: 'error', code: 'meta',
      msg: `Metadata before audio: ${before.map(c => c.id.trim()).join(', ')}. Tsunami will not play this file.`,
    });
    const after = res.chunks.slice(dataIdx + 1);
    if (after.length) res.problems.push({ sev: 'info', msg: `Chunks after audio (${after.map(c => c.id.trim()).join(', ')}) — usually harmless.` });
  }
  if (res.fmt) {
    const f = res.fmt;
    if (f.format !== 1) res.problems.push({ sev: 'error', code: 'format', msg: `${f.formatName} encoding — must be 16-bit PCM.` });
    else if (f.extensible) res.problems.push({ sev: 'warn', code: 'format', msg: 'WAVE_FORMAT_EXTENSIBLE header — use a plain PCM header to be safe.' });
    if (f.bits !== 16) res.problems.push({ sev: 'error', code: 'format', msg: `${f.bits}-bit — must be 16-bit.` });
    if (f.rate !== SAMPLE_RATE) res.problems.push({ sev: 'error', code: 'format', msg: `${f.rate} Hz — must be 44100 Hz.` });
    if (f.channels > 2) res.problems.push({ sev: 'error', code: 'format', msg: `${f.channels} channels — must be mono or stereo.` });
    if (f.fmtSize !== 16 && !f.extensible) res.problems.push({ sev: 'info', msg: `fmt chunk is ${f.fmtSize} bytes (canonical is 16).` });
  }
  res.ok = !res.problems.some(p => p.sev === 'error');
  res.chunkSummary = res.chunks.map(c => c.id.trim()).join(' · ');
  return res;
}

// Rebuild a WAV with a canonical header, copying 16-bit PCM data byte-for-byte.
export async function rewrapPcm16(blob, info) {
  const data = new Uint8Array(await blob.slice(info.dataOffset, info.dataOffset + info.dataSize).arrayBuffer());
  const nch = info.fmt.channels;
  const usable = data.length - (data.length % (2 * nch));
  const out = new Uint8Array(44 + usable);
  const v = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + usable, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, info.fmt.rate, true); v.setUint32(28, info.fmt.rate * nch * 2, true);
  v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, usable, true);
  out.set(data.subarray(0, usable), 44);
  return out;
}

// ---------- AIFF / AIFC ----------

function readExtended(dv, o) {
  const exp = ((dv.getUint8(o) & 0x7f) << 8) | dv.getUint8(o + 1);
  const hi = dv.getUint32(o + 2), lo = dv.getUint32(o + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const sign = dv.getUint8(o) & 0x80 ? -1 : 1;
  return sign * (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
}

export function isAiff(ab) {
  if (ab.byteLength < 12) return false;
  const s = new TextDecoder('latin1').decode(new Uint8Array(ab, 0, 12));
  return s.startsWith('FORM') && (s.slice(8) === 'AIFF' || s.slice(8) === 'AIFC');
}

// AIFF and AIFF-C, covering every encoding Apple tools write: NONE/twos/in16/in24/in32
// (big-endian PCM), sowt (little-endian), raw (unsigned 8-bit), fl32/fl64, ulaw/alaw
// and ima4 (Apple IMA ADPCM, used by older Logic/GarageBand exports).
export function decodeAiff(ab) {
  const dv = new DataView(ab);
  const id = o => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  const aifc = id(8) === 'AIFC';
  let off = 12, comm = null, ssnd = null;
  while (off + 8 <= ab.byteLength) {
    const cid = id(off), size = dv.getUint32(off + 4);
    if (cid === 'COMM') {
      comm = {
        channels: dv.getUint16(off + 8), frames: dv.getUint32(off + 10),
        bits: dv.getUint16(off + 14), rate: readExtended(dv, off + 16),
        comp: aifc && size >= 22 ? id(off + 26) : 'NONE',
      };
    } else if (cid === 'SSND') {
      const start = off + 16 + dv.getUint32(off + 8);
      ssnd = { start, end: Math.min(ab.byteLength, off + 8 + size) };
    }
    off += 8 + size + (size & 1);
  }
  if (!comm || !ssnd) throw new Error('AIFF: missing COMM or SSND chunk');
  if (!comm.channels || !(comm.rate > 0)) throw new Error('AIFF: invalid header');
  const comp = comm.comp.toLowerCase();
  const nch = comm.channels;
  if (comp === 'ima4') return { rate: comm.rate, channels: decodeIma4(dv, ssnd, nch) };

  let read, bytes;
  const little = comp === 'sowt';
  if (['none', 'twos', 'sowt', 'in16', 'in24', 'in32'].includes(comp)) {
    const bits = comp === 'in16' ? 16 : comp === 'in24' ? 24 : comp === 'in32' ? 32 : comm.bits;
    bytes = Math.ceil(bits / 8);
    if (bytes === 1) read = p => dv.getInt8(p) / 128;
    else if (bytes === 2) read = p => dv.getInt16(p, little) / 32768;
    else if (bytes === 3) read = p => {
      const b0 = dv.getUint8(p), b1 = dv.getUint8(p + 1), b2 = dv.getUint8(p + 2);
      let x = little ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2;
      if (x & 0x800000) x -= 0x1000000;
      return x / 8388608;
    };
    else if (bytes === 4) read = p => dv.getInt32(p, little) / 2147483648;
    else throw new Error(`AIFF: ${bits}-bit samples are not supported`);
  } else if (comp === 'raw ') { bytes = 1; read = p => (dv.getUint8(p) - 128) / 128; }
  else if (comp === 'fl32') { bytes = 4; read = p => dv.getFloat32(p); }
  else if (comp === 'fl64') { bytes = 8; read = p => dv.getFloat64(p); }
  else if (comp === 'ulaw') { bytes = 1; read = p => ULAW[dv.getUint8(p)]; }
  else if (comp === 'alaw') { bytes = 1; read = p => ALAW[dv.getUint8(p)]; }
  else throw new Error(`AIFF-C compression “${comm.comp.trim()}” isn't supported — re-export as plain AIFF or WAV`);

  const frames = Math.min(comm.frames || Infinity, Math.floor((ssnd.end - ssnd.start) / (bytes * nch)));
  const out = Array.from({ length: nch }, () => new Float32Array(frames));
  let p = ssnd.start;
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++, p += bytes) out[c][i] = read(p);
  return { rate: comm.rate, channels: out };
}

// G.711 lookup tables (8-bit code → float).
const ULAW = Float32Array.from({ length: 256 }, (_, u) => {
  u = ~u & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return ((u & 0x80) ? 0x84 - t : t - 0x84) / 32768;
});
const ALAW = Float32Array.from({ length: 256 }, (_, a) => {
  a ^= 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8; else if (seg === 1) t += 0x108; else t = (t + 0x108) << (seg - 1);
  return ((a & 0x80) ? t : -t) / 32768;
});

const IMA_STEPS = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166,
  1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
  9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

// Apple IMA4: per channel, 34-byte packets = 2-byte header (predictor | step index) + 64 nibbles.
function decodeIma4(dv, ssnd, nch) {
  const packets = Math.floor((ssnd.end - ssnd.start) / (34 * nch));
  const out = Array.from({ length: nch }, () => new Float32Array(packets * 64));
  let p = ssnd.start;
  for (let k = 0; k < packets; k++) {
    for (let c = 0; c < nch; c++) {
      const head = dv.getUint16(p);
      let pred = (head & 0xff80) << 16 >> 16;
      let idx = Math.min(88, head & 0x7f);
      const dst = out[c];
      let o = k * 64;
      for (let b = 0; b < 32; b++) {
        const byte = dv.getUint8(p + 2 + b);
        for (const n of [byte & 0x0f, byte >> 4]) {
          const step = IMA_STEPS[idx];
          let diff = step >> 3;
          if (n & 1) diff += step >> 2;
          if (n & 2) diff += step >> 1;
          if (n & 4) diff += step;
          pred += n & 8 ? -diff : diff;
          pred = pred < -32768 ? -32768 : pred > 32767 ? 32767 : pred;
          idx = Math.min(88, Math.max(0, idx + IMA_INDEX[n]));
          dst[o++] = pred / 32768;
        }
      }
      p += 34;
    }
  }
  return out;
}
