import { h, icon } from './dom';

export interface ModalHandle {
  close(): void;
  body: HTMLElement;
}

export function modal(title: string, content: Node | Node[], opts: { wide?: boolean; actions?: HTMLElement[]; onClose?: () => void } = {}): ModalHandle {
  const body = h('div', { class: 'modal-body' }, ...(Array.isArray(content) ? content : [content]));
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const dialog = h('div', { class: `modal ${opts.wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', title: 'Close', onclick: close }, icon('x'))),
    body,
    opts.actions?.length ? h('footer', { class: 'modal-actions' }, ...opts.actions) : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && close() }, dialog);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  const first = dialog.querySelector<HTMLElement>('input, select, textarea, button.primary');
  first?.focus();
  return { close, body };
}

export function prompt(title: string, label: string, initial = '', placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'text', value: initial, placeholder, class: 'text-input' }) as HTMLInputElement;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(input.value.trim() || null);
    });
    const m = modal(title, [h('label', { class: 'field' }, h('span', null, label), input)], {
      actions: [
        h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => finish(input.value.trim() || null) }, 'OK'),
      ],
      onClose: () => finish(null),
    });
    input.focus();
    input.select();
  });
}

export function confirmDialog(title: string, message: string, okLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal(title, [h('p', null, message)], {
      actions: [h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'), h('button', { class: 'btn primary danger', onclick: () => finish(true) }, okLabel)],
      onClose: () => finish(false),
    });
  });
}
