// Petits utilitaires d'interface : construction DOM sûre (aucun innerHTML
// avec des données), dialogues, notifications.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple' || k === 'required') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function toast(message, { error = false, details = null, timeout = 4500 } = {}) {
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const list = details ? [].concat(details) : [];
  const t = h('div', { class: `toast${error ? ' error' : ''}` }, h('div', {}, message), list.length ? h('ul', {}, list.map((d) => h('li', {}, typeof d === 'string' ? d : JSON.stringify(d)))) : null);
  box.append(t);
  setTimeout(() => t.remove(), error ? timeout * 2 : timeout);
}

export function modal(title, body, actions = [], { wide = false } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { style: wide ? { maxWidth: 'min(1100px, 98vw)' } : null });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const foot = h('div', { class: 'dlg-foot' }, actions.map((a) => h('button', { class: a.class || '', onclick: async () => {
      if (a.onClick) { const r = await a.onClick(); if (r === false) return; close(r === undefined ? a.value : r); } else close(a.value);
    } }, a.label)));
    dlg.append(h('div', { class: 'dlg-head' }, h('h2', {}, title), h('button', { class: 'ghost right', 'aria-label': 'Fermer', onclick: () => close(null) }, '✕')), h('div', { class: 'dlg-body' }, body));
    if (actions.length) dlg.append(foot);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    dlg.closeWith = close;
    document.body.append(dlg);
    dlg.showModal();
  });
}

export async function confirmDialog(title, text, { ok = 'Confirmer', danger = false } = {}) {
  const r = await modal(title, h('div', {}, text), [{ label: 'Annuler', value: false }, { label: ok, value: true, class: danger ? 'danger' : 'primary' }]);
  return r === true;
}

export async function promptDialog(title, label, value = '', { type = 'text' } = {}) {
  const input = h('input', { type, value, style: { width: '100%' } });
  return modal(title, h('label', { class: 'field' }, label, input), [{ label: 'Annuler', value: null }, { label: 'Valider', class: 'primary', onClick: () => input.value }]);
}

export function fmtTime(t) {
  return t ? new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
}
export function fmtDate(t) {
  return t ? new Date(t).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';
}
export function select(options, value, attrs = {}) {
  return h('select', attrs, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
}
