// Waveform editor (trim + fade handles) and cheap thumbnails.

import { h, clamp, fmtTime } from '../util.js';
import { SAMPLE_RATE } from '../constants.js';

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function thumb(track, w = 120, hgt = 28, { cls = 'thumb' } = {}) {
  const c = h('canvas', { class: cls, width: w * 2, height: hgt * 2, style: { width: w + 'px', height: hgt + 'px' } });
  const wave = track?.info?.wave;
  if (!wave) return c;
  const g = c.getContext('2d');
  const dur = track.info.duration || 1;
  const s = (track.edits.trimStart || 0) / dur, e = (track.edits.trimEnd ?? dur) / dur;
  const W = c.width, H = c.height, mid = H / 2;
  g.fillStyle = css('--wave');
  const n = wave.length;
  for (let x = 0; x < W; x++) {
    const i = Math.min(n - 1, Math.floor((s + (x / W) * (e - s)) * n));
    const a = (wave[i] / 255) * mid;
    g.fillRect(x, mid - a, 1, Math.max(1, a * 2));
  }
  return c;
}

// d: decoded source {channels}; edits: current edits; onCommit(patch)
export function waveformEditor(track, d, { onCommit, playhead }) {
  const wrap = h('div', { class: 'wave-edit' });
  const canvas = h('canvas', { height: 300 });
  const tip = h('div', { class: 'wave-tip' });
  wrap.append(canvas, tip);
  const total = d.channels[0].length / SAMPLE_RATE;
  let draft = { ...track.edits };
  let peaksCache = null;

  const x2t = x => clamp((x / canvas.clientWidth) * total, 0, total);
  const t2x = t => (t / total) * canvas.clientWidth;
  const trimEnd = () => draft.trimEnd ?? total;

  function peaks(W) {
    if (peaksCache?.W === W) return peaksCache.data;
    const len = d.channels[0].length;
    const chs = d.channels.slice(0, 2);
    const data = chs.map(c => {
      const mn = new Float32Array(W), mx = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        const s = Math.floor((x / W) * len), e = Math.min(len, Math.floor(((x + 1) / W) * len) + 1);
        let lo = 0, hi = 0;
        const step = Math.max(1, Math.floor((e - s) / 400));
        for (let i = s; i < e; i += step) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        mn[x] = lo; mx[x] = hi;
      }
      return { mn, mx };
    });
    peaksCache = { W, data };
    return data;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const Wc = canvas.clientWidth || 300, Hc = 150;
    if (canvas.width !== Math.round(Wc * dpr)) { canvas.width = Math.round(Wc * dpr); canvas.height = Math.round(Hc * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, Wc, Hc);
    const data = peaks(Math.round(Wc));
    const lanes = data.length;
    const laneH = (Hc - 16) / lanes;
    const sx = t2x(draft.trimStart || 0), ex = t2x(trimEnd());
    for (let l = 0; l < lanes; l++) {
      const top = 16 + l * laneH, mid = top + laneH / 2;
      g.fillStyle = css('--wave-bg');
      g.fillRect(0, top + 1, Wc, laneH - 2);
      const { mn, mx } = data[l];
      for (let x = 0; x < mn.length; x++) {
        const inside = x >= sx && x <= ex;
        g.fillStyle = inside ? css('--wave') : css('--wave-dim');
        const y1 = mid - mx[x] * (laneH / 2 - 2), y2 = mid - mn[x] * (laneH / 2 - 2);
        g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    }
    // shaded trim
    g.fillStyle = css('--scrim');
    g.fillRect(0, 16, sx, Hc - 16);
    g.fillRect(ex, 16, Wc - ex, Hc - 16);
    // fades
    const fiX = sx + t2x((draft.fadeIn || 0) / 1000), foX = ex - t2x((draft.fadeOut || 0) / 1000);
    g.strokeStyle = css('--accent-2');
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(sx, Hc); g.lineTo(fiX, 16); g.lineTo(foX, 16); g.lineTo(ex, Hc); g.stroke();
    // handles
    g.fillStyle = css('--accent');
    g.fillRect(sx - 1, 0, 2, Hc); g.fillRect(ex - 1, 0, 2, Hc);
    g.fillRect(sx - 6, 0, 12, 14); g.fillRect(ex - 6, 0, 12, 14);
    g.fillStyle = css('--accent-2');
    g.beginPath(); g.arc(fiX, 18, 5, 0, Math.PI * 2); g.arc(foX, 18, 5, 0, Math.PI * 2); g.fill();
    // ruler
    g.fillStyle = css('--muted');
    g.font = '10px ui-monospace, monospace';
    const step = niceStep(total / (Wc / 70));
    for (let t = 0; t <= total; t += step) { const x = t2x(t); g.fillRect(x, 12, 1, 4); if (x > 14 && x < Wc - 30) g.fillText(fmtTime(t), x + 2, 10); }
    // playhead
    const ph = playhead?.();
    if (ph != null) {
      g.fillStyle = css('--text');
      g.fillRect(sx + t2x(ph), 16, 1, Hc - 16);
    }
  }

  let drag = null;
  function hit(x, y) {
    const sx = t2x(draft.trimStart || 0), ex = t2x(trimEnd());
    const fiX = sx + t2x((draft.fadeIn || 0) / 1000), foX = ex - t2x((draft.fadeOut || 0) / 1000);
    if (y < 28 && Math.abs(x - fiX) < 8) return 'fadeIn';
    if (y < 28 && Math.abs(x - foX) < 8) return 'fadeOut';
    if (Math.abs(x - sx) < 8) return 'start';
    if (Math.abs(x - ex) < 8) return 'end';
    return null;
  }
  canvas.addEventListener('pointermove', e => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (!drag) { canvas.style.cursor = hit(x, y) ? 'ew-resize' : 'default'; return; }
    const t = x2t(x);
    const len = trimEnd() - (draft.trimStart || 0);
    if (drag === 'start') draft.trimStart = clamp(t, 0, trimEnd() - 0.001);
    if (drag === 'end') draft.trimEnd = clamp(t, (draft.trimStart || 0) + 0.001, total);
    if (drag === 'fadeIn') draft.fadeIn = Math.round(clamp(t - (draft.trimStart || 0), 0, len) * 1000);
    if (drag === 'fadeOut') draft.fadeOut = Math.round(clamp(trimEnd() - t, 0, len) * 1000);
    if (draft.trimEnd != null && draft.trimEnd >= total - 0.0005) draft.trimEnd = null;
    tip.textContent = drag === 'start' ? `start ${fmtTime(draft.trimStart)}` : drag === 'end' ? `end ${fmtTime(trimEnd())}` :
      drag === 'fadeIn' ? `fade in ${draft.fadeIn} ms` : `fade out ${draft.fadeOut} ms`;
    tip.style.left = clamp(x, 30, canvas.clientWidth - 60) + 'px';
    draw();
  });
  canvas.addEventListener('pointerdown', e => {
    const r = canvas.getBoundingClientRect();
    drag = hit(e.clientX - r.left, e.clientY - r.top);
    if (drag) { canvas.setPointerCapture(e.pointerId); tip.classList.add('on'); }
  });
  canvas.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null; tip.classList.remove('on');
    const patch = {};
    for (const k of ['trimStart', 'trimEnd', 'fadeIn', 'fadeOut']) if (draft[k] !== track.edits[k]) patch[k] = draft[k];
    if (Object.keys(patch).length) onCommit(patch);
  });

  const ro = new ResizeObserver(() => draw());
  ro.observe(wrap);
  let raf;
  const loop = () => { if (!wrap.isConnected) { ro.disconnect(); return; } if (playhead?.() != null) draw(); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  wrap.redraw = draw;
  return wrap;
}

function niceStep(x) {
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find(s => s >= x) || 600;
}
