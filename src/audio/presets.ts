// Factory presets: an instrument plus a full set of sound settings.

import { DEFAULT_SOUND, type SoundSettings } from '../core/settings';

export interface FactoryPreset {
  id: string;
  name: string;
  group: string;
  description: string;
  sound: Partial<SoundSettings>;
}

export const FACTORY_PRESETS: FactoryPreset[] = [
  // Acoustic
  {
    id: 'concert-grand', name: 'Concert Grand', group: 'Acoustic',
    description: 'Steinway D on stage in a concert hall.',
    sound: { instrument: 'splendid-grand', reverbType: 'hall', reverbMix: 0.24, reverbDecay: 2.4, stretch: 0.6, hardness: 0.3, keyPan: 0.45 },
  },
  {
    id: 'studio-grand', name: 'Studio Grand', group: 'Acoustic',
    description: 'Close, present grand for recordings – a little brighter and compressed.',
    sound: { instrument: 'splendid-grand', reverbType: 'studio', reverbMix: 0.14, reverbDecay: 1.1, reverbPreDelay: 8, brightness: 0.15, eqHigh: 1.5, eqLow: 1, compThreshold: -20, compRatio: 3, stretch: 0.5 },
  },
  {
    id: 'yamaha-c5', name: 'Yamaha C5', group: 'Acoustic',
    description: 'Salamander grand in a warm chamber. Fast to download.',
    sound: { instrument: 'salamander', reverbType: 'chamber', reverbMix: 0.2, reverbDecay: 1.7, hardness: 0.55, stretch: 0.5 },
  },
  {
    id: 'steinway-pedal', name: 'Steinway B – Pedal Aware', group: 'Acoustic',
    description: 'Switches to samples recorded with the dampers lifted when you hold the sustain pedal.',
    sound: { instrument: 'vcsl-steinway-b', reverbType: 'hall', reverbMix: 0.2, reverbDecay: 2.1, resonance: 0.2, stretch: 0.4, hardness: 0.3 },
  },
  {
    id: 'kawai-warm', name: 'Warm Kawai', group: 'Acoustic',
    description: 'Mellow grand for ballads.',
    sound: { instrument: 'vcsl-kawai-grand', reverbType: 'hall', reverbMix: 0.26, reverbDecay: 2.6, brightness: -0.1, lid: 'half', stretch: 0.5 },
  },
  {
    id: 'felt-piano', name: 'Felt Piano', group: 'Acoustic',
    description: 'Upright with felt between hammers and strings – soft, intimate, cinematic.',
    sound: {
      instrument: 'vcsl-upright-yamaha', brightness: -0.55, hardness: 0.2, lid: 'closed', touch: 'light', dynamicRange: 28,
      reverbType: 'room', reverbMix: 0.3, reverbDecay: 1.2, releaseNoise: 0.8, pedalNoise: 0.6, stereoWidth: 0.8, eqLow: 2, keyPan: 0.2,
    },
  },
  {
    id: 'vintage-upright', name: 'Vintage Upright', group: 'Acoustic',
    description: 'Old upright in the living room, with all its mechanical noises.',
    sound: { instrument: 'vcsl-upright-knight', reverbType: 'room', reverbMix: 0.18, reverbDecay: 0.8, pedalNoise: 0.7, releaseNoise: 0.7, stretch: 0.8, unisonDetune: 3 },
  },
  {
    id: 'lofi-keys', name: 'Lo-fi Keys', group: 'Acoustic',
    description: 'Dusty, narrow, slightly detuned – beat-tape piano.',
    sound: {
      instrument: 'salamander', brightness: -0.6, hardness: 0.1, eqLow: 3, eqHigh: -6, eqMid: -2, eqMidFreq: 900,
      drive: 0.25, stereoWidth: 0.5, chorusMix: 0.25, chorusRate: 0.3, chorusDepth: 0.6, unisonDetune: 6,
      reverbType: 'room', reverbMix: 0.2, compThreshold: -24, compRatio: 4,
    },
  },
  {
    id: 'honky-tonk', name: 'Honky-Tonk Saloon', group: 'Acoustic',
    description: 'Out-of-tune saloon upright in Pythagorean tuning.',
    sound: { instrument: 'mk-honkytonk', unisonDetune: 12, temperament: 'pythagorean', reverbType: 'room', reverbMix: 0.14, brightness: 0.2, keyPan: 0.3 },
  },
  {
    id: 'pop-grand', name: 'Bright Pop Grand', group: 'Acoustic',
    description: 'Cuts through a band mix.',
    sound: { instrument: 'fluid-bright', brightness: 0.25, eqHigh: 3, eqLow: -1, compThreshold: -22, compRatio: 4, reverbType: 'plate', reverbMix: 0.16, reverbDecay: 1.5 },
  },

  // Electric
  {
    id: 'wurli', name: 'Wurlitzer', group: 'Electric',
    description: 'Wurlitzer EP200 through its little amp with tremolo.',
    sound: { instrument: 'gs-wurlitzer', tremoloDepth: 0.35, tremoloRate: 5.5, drive: 0.2, reverbType: 'spring', reverbMix: 0.18, stretch: 0, resonance: 0, keyPan: 0.2 },
  },
  {
    id: 'suitcase', name: 'Suitcase Tines', group: 'Electric',
    description: 'Rhodes-style tines with stereo auto-pan and chorus.',
    sound: { instrument: 'fluid-ep1', tremoloDepth: 0.55, tremoloRate: 4, autoPan: true, chorusMix: 0.3, reverbType: 'plate', reverbMix: 0.2, stretch: 0, resonance: 0 },
  },
  {
    id: 'cp80', name: 'CP-80 Ballad', group: 'Electric',
    description: 'Yamaha electric grand with chorus – pure 80s.',
    sound: { instrument: 'gs-cp80', chorusMix: 0.45, chorusRate: 0.6, reverbType: 'hall', reverbMix: 0.25, stretch: 0.2, resonance: 0 },
  },
  {
    id: 'dx-ep', name: 'FM Electric Piano', group: 'Electric',
    description: 'Glassy DX-style electric piano.',
    sound: { instrument: 'fluid-ep2', chorusMix: 0.35, reverbType: 'plate', reverbMix: 0.22, stretch: 0, resonance: 0 },
  },
  {
    id: 'tx81z', name: 'TX81Z Piano', group: 'Electric',
    description: 'Late-80s FM rack piano.',
    sound: { instrument: 'vcsl-tx81z', chorusMix: 0.2, reverbType: 'hall', reverbMix: 0.2, stretch: 0, resonance: 0 },
  },
  {
    id: 'pianet', name: 'Pianet', group: 'Electric',
    description: 'Hohner Pianet T with a touch of drive.',
    sound: { instrument: 'gs-pianet', drive: 0.15, tremoloDepth: 0.15, reverbType: 'room', reverbMix: 0.15, stretch: 0, resonance: 0 },
  },

  // Historic & other keys
  {
    id: 'baroque-harpsichord', name: 'Baroque Harpsichord', group: 'Keys',
    description: 'Flemish harpsichord at A = 415 Hz in Werckmeister III – as Bach would have heard it.',
    sound: {
      instrument: 'vcsl-harpsichord', a4: 415, temperament: 'werckmeister3', temperamentRoot: 0, stretch: 0, dynamicRange: 6,
      hardness: 0, touch: 'linear', reverbType: 'chamber', reverbMix: 0.22, resonance: 0, releaseNoise: 0.7, release: 0.12,
    },
  },
  {
    id: 'clavinet', name: 'Funk Clavinet', group: 'Keys',
    description: 'Clavinet with drive – play it percussive.',
    sound: { instrument: 'fluid-clavinet', drive: 0.35, eqMid: 3, eqMidFreq: 1800, reverbType: 'room', reverbMix: 0.1, stretch: 0, resonance: 0, release: 0.08 },
  },
  {
    id: 'celesta', name: 'Celesta', group: 'Keys',
    description: 'Tchaikovsky’s sugar-plum celesta.',
    sound: { instrument: 'mk-celesta', reverbType: 'hall', reverbMix: 0.32, reverbDecay: 2.8, stretch: 0, resonance: 0 },
  },
  {
    id: 'music-box', name: 'Music Box Dreams', group: 'Keys',
    description: 'Music box in a cathedral.',
    sound: { instrument: 'mk-musicbox', reverbType: 'cathedral', reverbMix: 0.4, reverbDecay: 5.5, reverbPreDelay: 35, stretch: 0, resonance: 0 },
  },
  {
    id: 'vibes', name: 'Lounge Vibraphone', group: 'Keys',
    description: 'Vibes with motor tremolo. The sustain pedal is the damper bar.',
    sound: { instrument: 'vcsl-vibraphone', tremoloDepth: 0.3, tremoloRate: 5, reverbType: 'plate', reverbMix: 0.25, stretch: 0, resonance: 0, release: 0.2 },
  },
  {
    id: 'marimba', name: 'Marimba', group: 'Keys',
    description: 'Rosewood marimba in a studio.',
    sound: { instrument: 'vcsl-marimba', reverbType: 'studio', reverbMix: 0.18, stretch: 0, resonance: 0 },
  },
  {
    id: 'glockenspiel', name: 'Glockenspiel', group: 'Keys',
    description: 'Orchestral bells.',
    sound: { instrument: 'vcsl-glockenspiel', reverbType: 'hall', reverbMix: 0.3, stretch: 0, resonance: 0 },
  },
  {
    id: 'toy-keyboard', name: 'Toy Keyboard', group: 'Keys',
    description: '80s Casio home keyboard.',
    sound: { instrument: 'casio', reverbType: 'room', reverbMix: 0.08, stretch: 0, resonance: 0, touch: 'fixed', fixedVelocity: 100 },
  },

  // Organs
  {
    id: 'pipe-organ', name: 'Cathedral Organ', group: 'Organ',
    description: 'Pipe organ in a huge stone cathedral.',
    sound: { instrument: 'vcsl-pipe-organ', reverbType: 'cathedral', reverbMix: 0.45, reverbDecay: 6.5, reverbPreDelay: 45, stretch: 0, resonance: 0, touch: 'fixed', fixedVelocity: 100, dynamicRange: 6 },
  },
  {
    id: 'church-organ', name: 'Full Church Organ', group: 'Organ',
    description: 'Full registration.',
    sound: { instrument: 'fluid-church-organ', reverbType: 'cathedral', reverbMix: 0.35, reverbDecay: 4.5, stretch: 0, resonance: 0, touch: 'fixed', fixedVelocity: 100 },
  },

  // Offline
  {
    id: 'synth-piano', name: 'Offline Synth Piano', group: 'Offline',
    description: 'Synthesised piano – no download needed.',
    sound: { instrument: 'synth-piano', reverbType: 'hall', reverbMix: 0.22, stretch: 0.3 },
  },
  {
    id: 'synth-ep', name: 'Offline FM Tines', group: 'Offline',
    description: 'Synthesised FM electric piano with tremolo.',
    sound: { instrument: 'synth-epiano', tremoloDepth: 0.35, autoPan: true, chorusMix: 0.25, reverbType: 'plate', reverbMix: 0.2, stretch: 0, resonance: 0 },
  },
  {
    id: 'synth-organ', name: 'Offline Drawbar Organ', group: 'Offline',
    description: 'Tonewheel organ with chorus/vibrato.',
    sound: { instrument: 'synth-organ', chorusMix: 0.5, chorusRate: 6, chorusDepth: 0.3, drive: 0.2, reverbType: 'room', reverbMix: 0.15, stretch: 0, resonance: 0 },
  },
];

export function presetSound(p: FactoryPreset): SoundSettings {
  return { ...DEFAULT_SOUND, ...p.sound };
}

export function getFactoryPreset(id: string): FactoryPreset | undefined {
  return FACTORY_PRESETS.find((p) => p.id === id);
}
