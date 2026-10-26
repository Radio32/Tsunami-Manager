// Small DOM + math helpers shared by every module.

export function h(tag, props, ...children) {
  const el = tag === 'frag' ? document.createDocumentFragment() : document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'indeterminate') el[k] = !!v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const dbToGain = db => Math.pow(10, db / 20);
export const gainToDb = g => (g <= 0 ? -Infinity : 20 * Math.log10(g));

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function fmtDb(db, digits = 1) {
  if (db == null || !isFinite(db)) return '−∞ dB';
  return (db > 0 ? '+' : db < 0 ? '−' : '') + Math.abs(db).toFixed(digits) + ' dB';
}

export function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  if (sec < 10) return sec.toFixed(2) + 's';
  if (sec < 60) return sec.toFixed(1) + 's';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
// convention: 'yamaha' => C3 = 60 (used by the Nutella manual: note 31 = G0, 48 = C2)
//             'roland' => C4 = 60
export function noteName(n, convention = 'yamaha') {
  const off = convention === 'yamaha' ? 2 : 1;
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - off);
}

export const pad4 = n => String(n).padStart(4, '0');

export function trackPosition(num) {
  return {
    trigBank: Math.floor((num - 1) / 16),
    trigger: ((num - 1) % 16) + 1,
    midiBank: Math.floor(num / 128),
    note: num % 128,
  };
}

export function downloadBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
