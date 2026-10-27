// Global drawer: the settings you reach for while building a card, from any page.

import { h } from '../util.js';
import { state, emit, setView } from '../state.js';
import { icon } from '../ui.js';
import { firmwarePanel, outputsPanel, triggerInputsPanel, midiPanel, processingPanel } from './settings.js';

export function toggleGlobal(open = !state.ui.globalOpen) {
  state.ui.globalOpen = open;
  emit('global');
}

export function renderGlobal() {
  if (!state.ui.globalOpen) return null;
  return h('div', { class: 'gdrawer-back', onmousedown: e => { if (e.target.classList.contains('gdrawer-back')) toggleGlobal(false); } },
    h('aside', { class: 'gdrawer', role: 'dialog', 'aria-label': 'Global settings' },
      h('div', { class: 'gdrawer-head' },
        h('h2', null, 'Global'),
        h('span', { class: 'muted small' }, 'Applies to the whole card · saved in tsunami.ini'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn tiny', onclick: () => { toggleGlobal(false); setView('settings'); } }, 'All settings'),
        h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: () => toggleGlobal(false) }, icon('x'))),
      h('div', { class: 'gdrawer-body' },
        firmwarePanel(), outputsPanel(), triggerInputsPanel(), midiPanel(), processingPanel())));
}
