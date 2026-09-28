import '@fontsource-variable/outfit';
import './styles/app.css';
import './styles/launcher.css';
import './styles/beats.css';
import { Shell } from './shell';

const root = document.getElementById('app')!;
try {
  const shell = new Shell(root);
  const w = window as unknown as { pianoman_app?: unknown; pianobeats?: Shell };
  w.pianoman_app = shell.piano;
  w.pianobeats = shell;
} catch (err) {
  console.error(err);
  document.getElementById('splash')?.remove();
  root.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = `PIANO-BEATS failed to start:\n\n${err instanceof Error ? err.stack || err.message : String(err)}`;
  root.append(pre);
}
