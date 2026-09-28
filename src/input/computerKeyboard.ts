// Computer keyboard → notes. Uses KeyboardEvent.code, so it works the same on
// QWERTY, AZERTY, QWERTZ etc. (physical key positions).

export type KeyLayout = 'tracker' | 'single';

const LOWER = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM', 'Comma', 'KeyL', 'Period', 'Semicolon', 'Slash'];
const UPPER = ['KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU', 'KeyI', 'Digit9', 'KeyO', 'Digit0', 'KeyP', 'BracketLeft', 'Equal', 'BracketRight'];
const SINGLE = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ', 'KeyK', 'KeyO', 'KeyL', 'KeyP', 'Semicolon', 'Quote'];

const CHARS: Record<string, string> = {
  Comma: ',', Period: '.', Semicolon: ';', Slash: '/', BracketLeft: '[', BracketRight: ']', Equal: '=', Quote: "'", Minus: '-',
};

export const keyChar = (code: string) => CHARS[code] || code.replace(/^Key|^Digit/, '');

/** MIDI note for a key, or null. `octave` is the octave of the upper/main row's C (4 → C4 = 60). */
export function keyToMidi(code: string, layout: KeyLayout, octave: number): number | null {
  const c = (octave + 1) * 12;
  if (layout === 'single') {
    const i = SINGLE.indexOf(code);
    return i < 0 ? null : c + i;
  }
  const u = UPPER.indexOf(code);
  if (u >= 0) return c + u;
  const l = LOWER.indexOf(code);
  if (l >= 0) return c - 12 + l;
  return null;
}

/** The key label to print on an on-screen piano key. */
export function midiToKeyLabel(midi: number, layout: KeyLayout, octave: number): string | null {
  const c = (octave + 1) * 12;
  if (layout === 'single') {
    const i = midi - c;
    return i >= 0 && i < SINGLE.length ? keyChar(SINGLE[i]) : null;
  }
  const u = midi - c;
  if (u >= 0 && u < UPPER.length) return keyChar(UPPER[u]);
  const l = midi - (c - 12);
  if (l >= 0 && l < LOWER.length) return keyChar(LOWER[l]);
  return null;
}
