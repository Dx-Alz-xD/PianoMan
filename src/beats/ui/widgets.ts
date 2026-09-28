// Small building blocks for the 4K area's interface.

import { clear, h, icon } from '../../ui/dom';

export type Sfx = (name: 'hover' | 'click' | 'back' | 'select' | 'toggle' | 'error' | 'whoosh') => void;

let sfx: Sfx = () => {};
export function setSfx(fn: Sfx) {
  sfx = fn;
}
export const playSfx = (n: Parameters<Sfx>[0]) => sfx(n);

/** Adds hover/click sounds to an element. */
export function sounding<T extends HTMLElement>(el: T, click: Parameters<Sfx>[0] = 'click'): T {
  el.addEventListener('pointerenter', () => sfx('hover'));
  el.addEventListener('click', () => sfx(click));
  return el;
}

export function btn(label: string | Node, onclick: (e: MouseEvent) => void, opts: { cls?: string; icon?: string; title?: string; disabled?: boolean } = {}) {
  const b = h(
    'button',
    { class: `pb-btn ${opts.cls || ''}`, title: opts.title, disabled: opts.disabled, onclick: (e: MouseEvent) => onclick(e) },
    opts.icon ? icon(opts.icon, 17) : null,
    typeof label === 'string' ? (label ? h('span', null, label) : null) : label,
  );
  return sounding(b);
}

export function row(label: string, control: Node, hint?: string) {
  return h('div', { class: 'pb-row' }, h('div', { class: 'pb-row-label' }, h('span', null, label), hint ? h('small', null, hint) : null), h('div', { class: 'pb-row-control' }, control));
}

export function slider(opts: { value: number; min: number; max: number; step: number; format?: (v: number) => string; onInput: (v: number) => void; reset?: number }) {
  const out = h('output', null, (opts.format || String)(opts.value));
  const input = h('input', {
    type: 'range',
    min: opts.min,
    max: opts.max,
    step: opts.step,
    value: String(opts.value),
    oninput: () => {
      const v = parseFloat(input.value);
      out.textContent = (opts.format || String)(v);
      paint();
      opts.onInput(v);
    },
    ondblclick: () => {
      if (opts.reset === undefined) return;
      input.value = String(opts.reset);
      input.dispatchEvent(new Event('input'));
    },
  }) as HTMLInputElement;
  const paint = () => input.style.setProperty('--fill', `${((parseFloat(input.value) - opts.min) / (opts.max - opts.min)) * 100}%`);
  paint();
  const wrap = h('div', { class: 'pb-slider' }, input, out);
  return Object.assign(wrap, {
    set(v: number) {
      input.value = String(v);
      out.textContent = (opts.format || String)(v);
      paint();
    },
  });
}

export function toggle(value: boolean, onChange: (v: boolean) => void, label?: string) {
  const input = h('input', { type: 'checkbox', checked: value, onchange: () => (sfx('toggle'), onChange(input.checked)) }) as HTMLInputElement;
  return h('label', { class: 'pb-toggle' }, input, h('span', { class: 'pb-toggle-track' }, h('span', { class: 'pb-toggle-knob' })), label ? h('span', { class: 'pb-toggle-label' }, label) : null);
}

export function segmented<T extends string | number>(value: T, options: { value: T; label: string; title?: string; icon?: string }[], onChange: (v: T) => void, cls = '') {
  const el = h('div', { class: `pb-seg ${cls}` });
  const render = (cur: T) => {
    clear(el);
    for (const o of options) {
      el.append(
        sounding(
          h(
            'button',
            {
              class: o.value === cur ? 'on' : '',
              title: o.title,
              onclick: () => {
                render(o.value);
                onChange(o.value);
              },
            },
            o.icon ? icon(o.icon, 15) : null,
            o.label,
          ),
          'toggle',
        ),
      );
    }
  };
  render(value);
  return Object.assign(el, { set: render });
}

export function select<T extends string>(value: T, options: { value: T; label: string }[], onChange: (v: T) => void) {
  const s = h('select', { class: 'pb-select', onchange: () => onChange(s.value as T) }, ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label))) as HTMLSelectElement;
  return s;
}

export function textInput(value: string, onInput: (v: string) => void, opts: { placeholder?: string; multiline?: boolean; maxLength?: number } = {}) {
  if (opts.multiline) {
    const t = h('textarea', { class: 'pb-input', placeholder: opts.placeholder, maxLength: opts.maxLength || 2000, oninput: () => onInput(t.value) }) as HTMLTextAreaElement;
    t.value = value;
    return t;
  }
  const i = h('input', { class: 'pb-input', type: 'text', value, placeholder: opts.placeholder, maxLength: opts.maxLength || 300, oninput: () => onInput(i.value) }) as HTMLInputElement;
  return i;
}

export function keyName(code: string): string {
  const names: Record<string, string> = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Backquote: '`', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Enter: 'Enter', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt', Tab: 'Tab', CapsLock: 'Caps', Escape: 'Esc',
  };
  if (names[code]) return names[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/** Four key-binding buttons: click one, then press a key. */
export function keyBinder(keys: string[], colors: string[], onChange: (keys: string[]) => void) {
  const wrap = h('div', { class: 'pb-keys' });
  let listening = -1;
  const render = () => {
    clear(wrap);
    keys.forEach((k, i) => {
      const b = sounding(
        h('button', { class: `pb-key ${listening === i ? 'listening' : ''}`, style: { borderColor: colors[i % colors.length] }, title: 'Click, then press a key', onclick: () => {
          listening = listening === i ? -1 : i;
          render();
        } }, listening === i ? '…' : keyName(k)),
      );
      wrap.append(b);
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (listening < 0) return false;
    e.preventDefault();
    e.stopPropagation();
    if (e.code !== 'Escape') {
      const next = [...keys];
      const dup = next.indexOf(e.code);
      if (dup >= 0) next[dup] = next[listening];
      next[listening] = e.code;
      keys = next;
      onChange(next);
    }
    listening = -1;
    render();
    return true;
  };
  render();
  return Object.assign(wrap, {
    onKey,
    get listening() {
      return listening >= 0;
    },
    set(k: string[]) {
      keys = k;
      render();
    },
  });
}

// --------------------------------------------------------------- modal ----

export interface ModalHandle {
  el: HTMLElement;
  close(): void;
  body: HTMLElement;
}

let modalDepth = 0;
export const modalOpen = () => modalDepth > 0;

export function modal(title: string, content: Node | Node[], opts: { wide?: boolean; onClose?: () => void; cls?: string; actions?: Node[] } = {}): ModalHandle {
  const body = h('div', { class: 'pb-modal-body' });
  for (const c of Array.isArray(content) ? content : [content]) body.append(c);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    modalDepth--;
    backdrop.classList.add('out');
    window.removeEventListener('keydown', onKey, true);
    setTimeout(() => backdrop.remove(), 220);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      sfx('back');
      close();
    }
  };
  const dialog = h(
    'div',
    { class: `pb-modal ${opts.wide ? 'wide' : ''} ${opts.cls || ''}`, role: 'dialog' },
    h('div', { class: 'pb-modal-head' }, h('h2', null, title), sounding(h('button', { class: 'pb-icon-btn', title: 'Close (Esc)', onclick: close }, icon('x', 18)), 'back')),
    body,
    opts.actions?.length ? h('div', { class: 'pb-modal-actions' }, ...opts.actions) : null,
  );
  const backdrop = h('div', { class: 'pb-modal-backdrop', onpointerdown: (e: PointerEvent) => e.target === backdrop && close() }, dialog);
  (document.getElementById('beats') || document.body).append(backdrop);
  modalDepth++;
  window.addEventListener('keydown', onKey, true);
  return { el: dialog, close, body };
}

export function confirmDialog(title: string, text: string, ok = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal(title, h('p', { class: 'pb-muted' }, text), {
      onClose: () => !answered && resolve(false),
      actions: [
        btn('Cancel', () => m.close(), { cls: 'ghost' }),
        btn(ok, () => {
          answered = true;
          resolve(true);
          m.close();
        }, { cls: danger ? 'danger' : 'primary' }),
      ],
    });
  });
}

// --------------------------------------------------------------- toast ----

export function toast(text: string, kind: 'info' | 'ok' | 'error' = 'info', ms = 3200) {
  let host = document.querySelector('.pb-toasts');
  if (!host) {
    host = h('div', { class: 'pb-toasts' });
    (document.getElementById('beats') || document.body).append(host);
  }
  const t = h('div', { class: `pb-toast ${kind}` }, icon(kind === 'error' ? 'x' : kind === 'ok' ? 'check' : 'info', 16), h('span', null, text));
  host.append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ------------------------------------------------------------ progress ----

export function progressBar() {
  const fill = h('div', { class: 'pb-progress-fill' });
  const label = h('div', { class: 'pb-progress-label' });
  const el = h('div', { class: 'pb-progress' }, h('div', { class: 'pb-progress-track' }, fill), label);
  return Object.assign(el, {
    set(text: string, fraction: number | null) {
      label.textContent = text;
      el.classList.toggle('indeterminate', fraction === null);
      if (fraction !== null) fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
    },
  });
}

export function formatTime(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const neg = s < 0;
  const a = Math.abs(s);
  const m = Math.floor(a / 60);
  const sec = Math.floor(a % 60);
  return `${neg ? '-' : ''}${m}:${String(sec).padStart(2, '0')}`;
}

export function stars(level: number): string {
  return `${level.toFixed(1)}★`;
}

/** Colour for a star rating (easy green → expert red/purple). */
export function levelColor(level: number): string {
  const stops: [number, string][] = [[0, '#4dffa1'], [2, '#4dd6ff'], [3.5, '#8c6cff'], [5, '#ffd24d'], [6.5, '#ff7a45'], [8, '#ff3c6d'], [10, '#c03cff']];
  let c = stops[0][1];
  for (const [l, col] of stops) if (level >= l) c = col;
  return c;
}
