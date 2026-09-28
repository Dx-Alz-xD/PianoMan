// Generates the bundled demo scores in public/demos/ (public-domain pieces,
// simple two-hand arrangements) using PianoMan's own MusicXML writer.
//   node scripts/build-demos.mjs
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';

const server = await createServer({ configFile: 'vite.config.ts', server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { generateMusicXml } = await server.ssrLoadModule('/src/score/notation.ts');

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const m = (name) => {
  const r = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  return (parseInt(r[3], 10) + 1) * 12 + PC[r[1]] + (r[2] === '#' ? 1 : r[2] === 'b' ? -1 : 0);
};

/** Sequential melody: "E4:1 D4:0.5 ..." (durations in quarters, "r" = rest). */
function line(spec, hand, start = 0, velocity = 0.62) {
  const notes = [];
  let beat = start;
  for (const tok of spec.trim().split(/\s+/)) {
    const [pitch, dur] = tok.split(':');
    const beats = parseFloat(dur);
    if (pitch !== 'r') {
      for (const p of pitch.split('+')) notes.push({ midi: m(p), beat, beats, time: 0, duration: 0, velocity, hand, track: hand === 'R' ? 0 : 1 });
    }
    beat += beats;
  }
  return notes;
}

const demos = [];
function add(file, meta, notes, opts = {}) {
  const { xml } = generateMusicXml({
    title: meta.title,
    composer: meta.composer,
    notes,
    timeSignatures: [{ beat: 0, num: opts.num || 4, den: opts.den || 4 }],
    tempos: [{ beat: 0, bpm: opts.bpm || 100 }],
    keyFifths: opts.key ?? 0,
    pickupBeats: opts.pickup,
    pedals: opts.pedals,
  });
  writeFileSync(`public/demos/${file}`, xml);
  demos.push({ file, ...meta });
}

// Twinkle, Twinkle, Little Star (French melody, 18th c.)
{
  const rh = line(`C4:1 C4:1 G4:1 G4:1 A4:1 A4:1 G4:2 F4:1 F4:1 E4:1 E4:1 D4:1 D4:1 C4:2
    G4:1 G4:1 F4:1 F4:1 E4:1 E4:1 D4:2 G4:1 G4:1 F4:1 F4:1 E4:1 E4:1 D4:2
    C4:1 C4:1 G4:1 G4:1 A4:1 A4:1 G4:2 F4:1 F4:1 E4:1 E4:1 D4:1 D4:1 C4:2`, 'R');
  const lh = line(`C3+G3:4 F3+A3:2 C3+G3:2 F3+A3:2 C3+G3:2 G2+D3:2 C3+G3:2
    C3+G3:2 F3+A3:2 C3+G3:2 G2+D3:2 C3+G3:2 F3+A3:2 C3+G3:2 G2+D3:2
    C3+G3:4 F3+A3:2 C3+G3:2 F3+A3:2 C3+G3:2 G2+D3:2 C3+G3:2`, 'L', 0, 0.45);
  add('twinkle.musicxml', { title: 'Twinkle, Twinkle, Little Star', composer: 'Traditional', level: 'Beginner', description: 'The first tune everyone learns – perfect for clicker mode.' }, [...rh, ...lh], { bpm: 96 });
}

// Ode to Joy (Beethoven, Symphony No. 9)
{
  const rh = line(`E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1 E4:1.5 D4:0.5 D4:2
    E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1 D4:1.5 C4:0.5 C4:2
    D4:1 D4:1 E4:1 C4:1 D4:1 E4:0.5 F4:0.5 E4:1 C4:1 D4:1 E4:0.5 F4:0.5 E4:1 D4:1 C4:1 D4:1 G3:2
    E4:1 E4:1 F4:1 G4:1 G4:1 F4:1 E4:1 D4:1 C4:1 C4:1 D4:1 E4:1 D4:1.5 C4:0.5 C4:2`, 'R', 0, 0.66);
  const lh = line(`C3+G3:4 G2+D3:4 C3+G3:4 G2+D3:4 C3+G3:4 G2+D3:4 C3+G3:4 G2+D3:2 C3+G3:2
    G2+D3:4 C3+G3:2 G2+D3:2 C3+G3:2 G2+D3:2 G2+D3:4
    C3+G3:4 G2+D3:4 C3+G3:4 G2+D3:2 C3+G3:2`, 'L', 0, 0.45);
  add('ode-to-joy.musicxml', { title: 'Ode to Joy', composer: 'Ludwig van Beethoven', level: 'Beginner', description: 'The theme from the finale of the Ninth Symphony.' }, [...rh, ...lh], { bpm: 108 });
}

// Minuet in G (Christian Petzold, from the Anna Magdalena Bach notebook)
{
  const a1 = `D5:1 G4:0.5 A4:0.5 B4:0.5 C5:0.5 D5:1 G4:1 G4:1 E5:1 C5:0.5 D5:0.5 E5:0.5 F#5:0.5 G5:1 G4:1 G4:1
    C5:1 D5:0.5 C5:0.5 B4:0.5 A4:0.5 B4:1 C5:0.5 B4:0.5 A4:0.5 G4:0.5 F#4:1 G4:0.5 A4:0.5 B4:0.5 G4:0.5 A4:3`;
  const a2 = `D5:1 G4:0.5 A4:0.5 B4:0.5 C5:0.5 D5:1 G4:1 G4:1 E5:1 C5:0.5 D5:0.5 E5:0.5 F#5:0.5 G5:1 G4:1 G4:1
    C5:1 D5:0.5 C5:0.5 B4:0.5 A4:0.5 B4:1 C5:0.5 B4:0.5 A4:0.5 G4:0.5 A4:1 B4:0.5 A4:0.5 G4:0.5 F#4:0.5 G4:3`;
  const rh = line(`${a1} ${a2}`, 'R');
  const lh = line(`G2+D3:3 B2:3 C3:3 B2:3 A2:3 G2:3 D3:3 D3+F#3:3
    G2+D3:3 B2:3 C3:3 B2:3 A2:3 G2:3 D3:3 G2:3`, 'L', 0, 0.45);
  add('minuet-in-g.musicxml', { title: 'Minuet in G major', composer: 'Christian Petzold', level: 'Easy', description: 'From the Notebook for Anna Magdalena Bach (1725).' }, [...rh, ...lh], { num: 3, den: 4, bpm: 116, key: 1 });
}

// Für Elise – opening theme (Beethoven, WoO 59)
{
  const s = 0.25;
  const rh = line(`E5:${s} D#5:${s}
    E5:${s} D#5:${s} E5:${s} B4:${s} D5:${s} C5:${s}
    A4:${2 * s} r:${s} C4:${s} E4:${s} A4:${s}
    B4:${2 * s} r:${s} E4:${s} G#4:${s} B4:${s}
    C5:${2 * s} r:${s} E4:${s} E5:${s} D#5:${s}
    E5:${s} D#5:${s} E5:${s} B4:${s} D5:${s} C5:${s}
    A4:${2 * s} r:${s} C4:${s} E4:${s} A4:${s}
    B4:${2 * s} r:${s} E4:${s} C5:${s} B4:${s}
    A4:${6 * s}`, 'R', 0, 0.42);
  const arp = (a, b, c, start) => line(`${a}:${s} ${b}:${s} ${c}:${s}`, 'L', start, 0.32);
  const bar = (k) => 0.5 + (k - 1) * 1.5;
  const lh = [
    ...arp('A2', 'E3', 'A3', bar(2)), ...arp('E2', 'E3', 'G#3', bar(3)), ...arp('A2', 'E3', 'A3', bar(4)),
    ...arp('A2', 'E3', 'A3', bar(6)), ...arp('E2', 'E3', 'G#3', bar(7)), ...arp('A2', 'E3', 'A3', bar(8)),
  ];
  const pedals = [];
  for (const k of [2, 3, 4, 6, 7, 8]) pedals.push({ beat: bar(k) + 0.02, value: 1 }, { beat: bar(k) + 1.45, value: 0 });
  add('fur-elise.musicxml', { title: 'Für Elise (opening)', composer: 'Ludwig van Beethoven', level: 'Intermediate', description: 'The famous A-minor theme, with pedalling.' }, [...rh, ...lh], { num: 3, den: 8, bpm: 72, pickup: 0.5, pedals });
}

// Prelude in C major, BWV 846 (J. S. Bach) – first eleven bars and a final cadence
{
  const chords = [
    'C4 E4 G4 C5 E5', 'C4 D4 A4 D5 F5', 'B3 D4 G4 D5 F5', 'C4 E4 G4 C5 E5', 'C4 E4 A4 E5 A5', 'C4 D4 F#4 A4 D5',
    'B3 D4 G4 D5 G5', 'B3 C4 E4 G4 C5', 'A3 C4 E4 G4 C5', 'D3 A3 D4 F#4 C5', 'G3 B3 D4 G4 B4', 'G3 Bb3 E4 G4 C#5',
  ];
  const notes = [];
  chords.forEach((c, bi) => {
    const [n1, n2, n3, n4, n5] = c.split(' ').map(m);
    for (let half = 0; half < 2; half++) {
      const b = bi * 4 + half * 2;
      notes.push({ midi: n1, beat: b, beats: 2, hand: 'L', velocity: 0.45, track: 1, time: 0, duration: 0 });
      notes.push({ midi: n2, beat: b + 0.25, beats: 1.75, hand: 'L', velocity: 0.42, track: 1, time: 0, duration: 0 });
      [n3, n4, n5, n3, n4, n5].forEach((p, i) => notes.push({ midi: p, beat: b + 0.5 + i * 0.25, beats: 0.25, hand: 'R', velocity: 0.5, track: 0, time: 0, duration: 0 }));
    }
  });
  const end = chords.length * 4;
  for (const p of ['C2', 'C3']) notes.push({ midi: m(p), beat: end, beats: 4, hand: 'L', velocity: 0.5, track: 1, time: 0, duration: 0 });
  for (const p of ['E4', 'G4', 'C5']) notes.push({ midi: m(p), beat: end, beats: 4, hand: 'R', velocity: 0.5, track: 0, time: 0, duration: 0 });
  const pedals = [];
  for (let bi = 0; bi <= chords.length; bi++) pedals.push({ beat: bi * 4 + 0.05, value: 1 }, { beat: bi * 4 + 3.9, value: 0 });
  add('prelude-in-c.musicxml', { title: 'Prelude in C major, BWV 846 (bars 1–12)', composer: 'Johann Sebastian Bach', level: 'Intermediate', description: 'Opening of the Well-Tempered Clavier – flowing broken chords.' }, notes, { bpm: 66, pedals });
}

mkdirSync('public/demos', { recursive: true });
writeFileSync('public/demos/index.json', JSON.stringify(demos, null, 2) + '\n');
console.log(`wrote ${demos.length} demos`);
await server.close();
