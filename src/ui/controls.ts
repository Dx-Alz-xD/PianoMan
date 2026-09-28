import { h } from './dom';

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  defaultValue?: number;
  format?: (v: number) => string;
  help?: string;
  onInput: (v: number) => void;
}

export interface Control<T> {
  el: HTMLElement;
  set(v: T): void;
}

/** Labelled range slider. Double-click resets to default, mouse wheel nudges. */
export function slider(o: SliderOptions): Control<number> {
  const fmt = o.format || ((v: number) => String(v));
  const out = h('output', { class: 'ctl-value' }, fmt(o.value));
  const input = h('input', { type: 'range', min: String(o.min), max: String(o.max), step: String(o.step), value: String(o.value), 'aria-label': o.label }) as HTMLInputElement;
  const paint = () => {
    const pct = ((parseFloat(input.value) - o.min) / (o.max - o.min)) * 100;
    input.style.setProperty('--fill', `${pct}%`);
  };
  const emit = () => {
    const v = parseFloat(input.value);
    out.textContent = fmt(v);
    paint();
    o.onInput(v);
  };
  input.addEventListener('input', emit);
  input.addEventListener('dblclick', () => {
    if (o.defaultValue === undefined) return;
    input.value = String(o.defaultValue);
    emit();
  });
  input.addEventListener(
    'wheel',
    (e) => {
      if (document.activeElement !== input && !e.shiftKey) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      input.value = String(Math.min(o.max, Math.max(o.min, parseFloat(input.value) + dir * o.step)));
      emit();
    },
    { passive: false },
  );
  paint();
  const el = h('label', { class: 'ctl ctl-slider', title: o.help ? `${o.help}${o.defaultValue !== undefined ? '\nDouble-click to reset.' : ''}` : undefined },
    h('span', { class: 'ctl-head' }, h('span', { class: 'ctl-label' }, o.label), out),
    input,
  );
  return {
    el,
    set(v: number) {
      input.value = String(v);
      out.textContent = fmt(v);
      paint();
    },
  };
}

export function select(o: { label?: string; value: string; options: { value: string; label: string; group?: string }[]; help?: string; onChange: (v: string) => void; cls?: string }): Control<string> {
  const sel = h('select', { 'aria-label': o.label || 'select' }) as HTMLSelectElement;
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const opt of o.options) {
    const option = h('option', { value: opt.value }, opt.label);
    if (opt.group) {
      let g = groups.get(opt.group);
      if (!g) {
        g = h('optgroup', { label: opt.group });
        groups.set(opt.group, g);
        sel.append(g);
      }
      g.append(option);
    } else sel.append(option);
  }
  sel.value = o.value;
  sel.addEventListener('change', () => o.onChange(sel.value));
  const el = o.label
    ? h('label', { class: `ctl ctl-select ${o.cls || ''}`, title: o.help }, h('span', { class: 'ctl-label' }, o.label), sel)
    : h('span', { class: `ctl-select-bare ${o.cls || ''}`, title: o.help }, sel);
  return { el, set: (v: string) => (sel.value = v) };
}

export function toggle(o: { label: string; value: boolean; help?: string; onChange: (v: boolean) => void }): Control<boolean> {
  const input = h('input', { type: 'checkbox', checked: o.value, role: 'switch' }) as HTMLInputElement;
  input.addEventListener('change', () => o.onChange(input.checked));
  const el = h('label', { class: 'ctl ctl-toggle', title: o.help }, h('span', { class: 'ctl-label' }, o.label), h('span', { class: 'switch' }, input, h('span', { class: 'switch-track' })));
  return { el, set: (v: boolean) => (input.checked = v) };
}

export function segmented<T extends string>(o: { value: T; options: { value: T; label: string; icon?: Node; title?: string }[]; onChange: (v: T) => void; cls?: string }): Control<T> {
  const buttons = new Map<T, HTMLButtonElement>();
  const el = h('div', { class: `segmented ${o.cls || ''}`, role: 'tablist' });
  for (const opt of o.options) {
    const b = h('button', { class: 'seg', role: 'tab', title: opt.title || opt.label, onclick: () => set(opt.value, true) }, opt.icon || null, h('span', null, opt.label));
    buttons.set(opt.value, b);
    el.append(b);
  }
  const set = (v: T, fire = false) => {
    for (const [k, b] of buttons) {
      b.classList.toggle('active', k === v);
      b.setAttribute('aria-selected', String(k === v));
    }
    if (fire) o.onChange(v);
  };
  set(o.value);
  return { el, set: (v: T) => set(v) };
}
