import { h, icon } from './dom';

let host: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'success' | 'error' | 'warn' = 'info', ms = 4200) {
  if (!host) {
    host = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const iconName = kind === 'error' ? 'x' : kind === 'success' ? 'check' : kind === 'warn' ? 'info' : 'info';
  const el = h('div', { class: `toast toast-${kind}` }, icon(iconName, 16), h('span', null, message));
  el.addEventListener('click', () => el.remove());
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  window.setTimeout(() => {
    el.classList.remove('show');
    window.setTimeout(() => el.remove(), 300);
  }, ms);
}
