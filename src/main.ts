import './styles/app.css';
import { App } from './app';

const root = document.getElementById('app')!;
try {
  const app = new App(root);
  (window as unknown as { pianoman_app?: App }).pianoman_app = app;
} catch (err) {
  console.error(err);
  document.getElementById('splash')?.remove();
  root.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = `PianoMan failed to start:\n\n${err instanceof Error ? err.stack || err.message : String(err)}`;
  root.append(pre);
}
