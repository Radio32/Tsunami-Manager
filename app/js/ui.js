// Toasts, modal dialogs, progress bar and small form widgets.

import { h, $ } from './util.js';

export function toast(msg, { kind = 'info', ms = 3500 } = {}) {
  const host = $('#toasts');
  const el = h('div', { class: `toast ${kind}` }, msg);
  host.appendChild(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

export function modal({ title, body, actions = [{ label: 'OK', value: true, primary: true }], wide = false }) {
  return new Promise(resolve => {
    const close = v => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    const back = h('div', { class: 'modal-back', onmousedown: e => { if (e.target === back) close(null); } },
      h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-label': title },
        h('h2', null, title),
        h('div', { class: 'modal-body' }, body),
        h('div', { class: 'modal-actions' },
          actions.map(a => h('button', {
            class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''),
            onclick: () => close(typeof a.value === 'function' ? a.value() : a.value),
          }, a.label)))));
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey);
    back.querySelector('.btn.primary, .btn')?.focus();
  });
}

export const confirmModal = (title, text, { ok = 'Continue', danger = false } = {}) =>
  modal({ title, body: h('p', null, text), actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: !danger, danger }] });

// One global progress strip in the status bar.
let job = null;
export function startJob(label, total) {
  job = { label, total, done: 0, cancelled: false };
  renderJob();
  return {
    tick(n = 1, sub) { job.done += n; job.sub = sub; renderJob(); },
    get cancelled() { return job?.cancelled; },
    end() { job = null; renderJob(); },
  };
}
function renderJob() {
  const el = $('#job');
  if (!el) return;
  el.replaceChildren();
  el.hidden = !job;
  if (!job) return;
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  el.append(
    h('span', { class: 'job-label' }, `${job.label} ${job.done}/${job.total}`),
    h('div', { class: 'bar' }, h('div', { style: { width: pct + '%' } })),
    job.sub ? h('span', { class: 'job-sub' }, job.sub) : null,
    h('button', { class: 'btn tiny', onclick: () => { if (job) job.cancelled = true; } }, 'Cancel'),
  );
}

// ---------- form widgets ----------

export function field(label, control, hint) {
  return h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function select(options, value, onChange, props = {}) {
  return h('select', { ...props, onchange: e => onChange(e.target.value) },
    options.map(o => {
      const [v, l, dis] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: String(v) === String(value), disabled: dis }, l);
    }));
}

export function toggle(label, checked, onChange, props = {}) {
  return h('label', { class: 'toggle' + (props.disabled ? ' disabled' : ''), title: props.title },
    h('input', { type: 'checkbox', checked, disabled: props.disabled, onchange: e => onChange(e.target.checked) }),
    h('span', { class: 'knob' }),
    h('span', null, label));
}

export function numberInput(value, onChange, { min, max, step = 1, width, placeholder, disabled } = {}) {
  return h('input', {
    type: 'number', class: 'num', value: value ?? '', min, max, step, placeholder, disabled,
    style: width ? { width } : null,
    onchange: e => {
      const raw = e.target.value;
      if (raw === '') return onChange(null);
      let v = parseFloat(raw);
      if (isNaN(v)) return;
      if (min != null) v = Math.max(min, v);
      if (max != null) v = Math.min(max, v);
      onChange(v);
    },
  });
}

export function slider(value, onChange, { min, max, step = 1, format = v => v, live } = {}) {
  const out = h('output', null, format(value));
  const input = h('input', {
    type: 'range', min, max, step, value,
    oninput: e => { out.textContent = format(parseFloat(e.target.value)); live?.(parseFloat(e.target.value)); },
    onchange: e => onChange(parseFloat(e.target.value)),
    ondblclick: () => onChange(0),
  });
  return h('div', { class: 'slider' }, input, out);
}

export function segmented(options, value, onChange, props = {}) {
  return h('div', { class: 'seg ' + (props.class || ''), role: 'radiogroup' },
    options.map(([v, l, title]) => h('button', {
      class: String(v) === String(value) ? 'on' : '', title, role: 'radio', 'aria-checked': String(v) === String(value),
      onclick: () => onChange(v),
    }, l)));
}

export function badge(text, kind = '') { return h('span', { class: `badge ${kind}` }, text); }

export function icon(name) {
  const paths = {
    pads: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    tracks: 'M4 6h16M4 12h16M4 18h10',
    midi: 'M3 5h18v14H3zM7 5v8M11 5v8M15 5v8M5 13h4M13 13h4',
    triggers: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 8a4 4 0 100 8 4 4 0 000-8z',
    settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6',
    card: 'M7 3h8l4 4v14H7zM10 3v4M13 3v4M16 7v0',
    export: 'M12 3v12M7 10l5 5 5-5M5 21h14',
    live: 'M2 12h3l3-8 4 16 3-8h7',
    play: 'M7 4l13 8-13 8z',
    stop: 'M6 6h12v12H6z',
    loop: 'M17 2l3 3-3 3M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 01-4 4H4',
    undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3',
    redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3',
    plus: 'M12 5v14M5 12h14',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    warn: 'M12 3l10 18H2zM12 10v5M12 18v.5',
    folder: 'M3 6h6l2 2h10v11H3z',
    x: 'M6 6l12 12M18 6L6 18',
    chev: 'M9 6l6 6-6 6',
    chevl: 'M15 6l-6 6 6 6',
    theme: 'M12 3a9 9 0 109 9 7 7 0 01-9-9z',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths[name] || '');
  svg.appendChild(p);
  return svg;
}
