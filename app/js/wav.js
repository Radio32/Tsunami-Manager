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
        comp: aifc ? id(off + 26) : 'NONE',
      };
    } else if (cid === 'SSND') {
      ssnd = { start: off + 16 + dv.getUint32(off + 8) };
    }
    off += 8 + size + (size & 1);
  }
  if (!comm || !ssnd) throw new Error('AIFF: missing COMM or SSND chunk');
  const { channels: nch, frames, bits, comp } = comm;
  const little = comp === 'sowt';
  const isFloat = comp === 'fl32' || comp === 'FL32' || comp === 'fl64' || comp === 'FL64';
  if (!['NONE', 'sowt', 'fl32', 'FL32', 'fl64', 'FL64', 'twos'].includes(comp)) throw new Error(`AIFF-C compression "${comp}" is not supported`);
  const bytes = isFloat ? (comp.toLowerCase() === 'fl64' ? 8 : 4) : Math.ceil(bits / 8);
  const out = Array.from({ length: nch }, () => new Float32Array(frames));
  let p = ssnd.start;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, p += bytes) {
      if (p + bytes > ab.byteLength) break;
      let s;
      if (isFloat) s = bytes === 8 ? dv.getFloat64(p) : dv.getFloat32(p);
      else if (bytes === 1) s = dv.getInt8(p) / 128;
      else if (bytes === 2) s = dv.getInt16(p, little) / 32768;
      else if (bytes === 3) {
        const b0 = dv.getUint8(p), b1 = dv.getUint8(p + 1), b2 = dv.getUint8(p + 2);
        let x = little ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2;
        if (x & 0x800000) x -= 0x1000000;
        s = x / 8388608;
      } else s = dv.getInt32(p, little) / 2147483648;
      out[c][i] = s;
    }
  }
  return { rate: comm.rate, channels: out };
}
