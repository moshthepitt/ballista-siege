import { AudioEngine, getAudioEngine, type Voice } from './engine.js';
import { Synth } from './synth.js';

export const SOUND_KINDS = [
  'ballista-fire', 'bolt-hit', 'cauldron-fire', 'splash', 'armour-block', 'unit-killed',
  'boss-killed', 'fence-bite', 'fence-break', 'trample', 'leak', 'storm', 'gold', 'place',
  'upgrade', 'sell', 'reroll', 'overclock', 'ui-click', 'wave-won', 'run-won', 'run-lost',
] as const;
export type SoundKind = typeof SOUND_KINDS[number];
export type PlayOptions = { lane?: number; intensity?: number };
export const SOUND_LABELS: Record<SoundKind, string> = {
  'ballista-fire': 'Ballista fires', 'bolt-hit': 'Bolt hits', 'cauldron-fire': 'Cauldron fires',
  splash: 'Splash lands', 'armour-block': 'Armour blocks', 'unit-killed': 'Unit killed',
  'boss-killed': 'Boss killed', 'fence-bite': 'Bite on a fence', 'fence-break': 'Fence breaks',
  trample: 'Trample', leak: 'Leak', storm: 'Storm', gold: 'Coin / gold', place: 'Place a part',
  upgrade: 'Upgrade', sell: 'Sell', reroll: 'Reroll', overclock: 'Overclock',
  'ui-click': 'UI click / pick card', 'wave-won': 'Wave won', 'run-won': 'Run won', 'run-lost': 'Run lost',
};

export const effects: Record<SoundKind, (s: Synth, intensity: number) => void> = {
  'ballista-fire': s => { s.tone('sawtooth', 550, 120, 0.24, 0.064, 0, 0.004, 0.02, 2500); s.tone('triangle', 1105, 240, 0.18, 0.026); s.noise(1800, 700, 0.025, 0.011); },
  'bolt-hit': (s, i) => { s.tone('triangle', 240, 105, 0.14, 0.38 + i * 0.04); s.tone('sine', 620, 380, 0.05, 0.14); s.noise(1600, 650, 0.018, 0.045); },
  'cauldron-fire': s => {
    s.noise(350, 750, 0.22, 0.12, 0.055, 'bandpass', 0.035, 3.5);
    [0.045, 0.105, 0.16, 0.215].forEach((d, i) => s.tone('sine', 360 + i * 45, 150 + i * 22, 0.06, 0.28, d, 0.008));
  },
  splash: s => {
    s.tone('sine', 390, 230, 0.045, 0.075, 0.025, 0.008);
    s.noise(1300, 650, 0.18, 0.028, 0.13, 'bandpass', 0.03, 1.1);
    s.noise(550, 180, 0.2, 0.02, 0.16, 'lowpass', 0.03);
    [0.16, 0.215, 0.27].forEach((d, i) => s.tone('sine', 300 + i * 35, 210 + i * 15, 0.04, 0.045, d, 0.008));
  },
  'armour-block': s => { s.tone('sine', 460, 448, 0.17, 0.32); s.tone('sine', 745, 729, 0.13, 0.22); s.tone('triangle', 230, 180, 0.06, 0.1); },
  'unit-killed': s => { s.tone('sine', 1550, 1080, 0.029, 0.19, 0.035); s.noise(2800, 1800, 0.012, 0.016, 0.035, 'highpass'); },
  'boss-killed': s => { s.tone('sine', 140, 35, 1.1, 0.48, 0.06); s.noise(600, 90, 1.3, 0.27, 0.085, 'lowpass', 0.04); s.tone('sawtooth', 180, 46, 0.9, 0.085, 0.085, 0.035, 0, 450); },
  'fence-bite': s => { s.noise(400, 150, 0.055, 0.09); s.tone('triangle', 150, 65, 0.085, 0.38); },
  'fence-break': s => {
    s.tone('triangle', 280, 85, 0.24, 0.34, 0.15);
    [0.16, 0.215, 0.29, 0.37].forEach((d, i) => {
      s.noise(1800 - i * 200, 850, 0.035, 0.2 - i * 0.025, d, 'bandpass', 0.003, 2.3);
      s.tone('triangle', 850 - i * 110, 300, 0.025, 0.08, d);
    });
  },
  trample: s => { s.tone('sine', 280, 65, 0.13, 0.5); s.noise(1000, 500, 0.04, 0.2, 0, 'bandpass'); s.tone('sawtooth', 880, 180, 0.13, 0.2, 0.02, 0.008, 0, 1400); },
  leak: (s, i) => {
    s.tone('sine', 100, 40, 0.06, 0.6, 0.1); s.tone('triangle', 300, 160, 0.1, 0.4, 0.1);
    s.noise(1450, 750, 0.1, 0.2, 0.16, 'bandpass'); s.tone('triangle', 420, 210, 0.08, 0.24, 0.16);
    s.tone('sine', 72, 32, 0.75 + i * 0.14, 0.4, 0.1); s.noise(260, 60, 0.8 + i * 0.15, 0.24, 0.1, 'lowpass', 0.02);
    s.tone('triangle', 780, 650, 0.15, 0.22, 0.1); s.tone('triangle', 590, 500, 0.23, 0.22, 0.29);
  },
  storm: s => {
    s.tone('sawtooth', 349, 355, 0.67, 0.075, 0.2, 0.26, 0.06, 1500); s.tone('triangle', 523, 530, 0.67, 0.09, 0.2, 0.26, 0.06);
    for (let i = 0; i < 7; i++) { s.noise(1800, 750, 0.045, 0.18, 0.58 + i * 0.055, 'bandpass'); s.tone('sine', 200, 110, 0.055, 0.19, 0.58 + i * 0.055); }
  },
  gold: s => { s.tone('sine', 880, 880, 0.1, 0.07, 0.42); s.tone('sine', 1318.5, 1318.5, 0.14, 0.055, 0.505); },
  place: s => { s.tone('triangle', 170, 75, 0.13, 0.25); s.noise(900, 280, 0.055, 0.12); },
  upgrade: s => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => s.tone('sine', f, f * 1.01, 0.32, 0.14, i * 0.07)); },
  sell: s => { s.tone('sine', 1568, 784, 0.19, 0.18); s.tone('sine', 1046.5, 523.25, 0.18, 0.14, 0.09); },
  reroll: s => { [0, 0.045, 0.095, 0.15].forEach(d => s.noise(3000, 1200, 0.045, 0.14, d, 'bandpass')); },
  overclock: s => { s.tone('sawtooth', 120, 880, 0.55, 0.12, 0, 0.12); s.tone('sine', 240, 1760, 0.6, 0.12, 0, 0.12); },
  'ui-click': s => { s.tone('sine', 640, 400, 0.035, 0.1); },
  'wave-won': s => { s.chord([523.25, 659.25, 783.99], 0.5, 0.28, 0.08); },
  'run-won': s => { s.chord([392, 523.25, 659.25, 783.99, 1046.5], 0.65, 0.3, 0.12); s.tone('triangle', 130.81, 130.81, 0.8, 0.16, 0.48); },
  'run-lost': s => { [392, 311.13, 261.63, 196].forEach((f, i) => s.tone('triangle', f, f * 0.98, 0.5, 0.2, i * 0.16)); },
};

const deathBursts = new WeakMap<AudioEngine, Map<number, { at: number; count: number }>>();
type Contacts = { ballista: number; mixed: number; boss: number; coinsAfter: number; kills: Map<number, number> };
const contacts = new WeakMap<AudioEngine, Contacts>();
export function createSfx(engine: AudioEngine, random: () => number = Math.random) {
  return (kind: SoundKind, options: PlayOptions = {}): Voice | null => {
    const context = engine.getContext();
    if (!context || engine.muted) return null;
    const now = context.currentTime, lane = options.lane ?? -1;
    let contact = contacts.get(engine);
    if (!contact) { contact = { ballista: -Infinity, mixed: -Infinity, boss: -Infinity, coinsAfter: -Infinity, kills: new Map() }; contacts.set(engine, contact); }
    if (kind === 'ballista-fire') contact.ballista = now;
    if (kind === 'cauldron-fire' && now - contact.ballista < 0.06) contact.mixed = now;
    if (kind === 'boss-killed') contact.boss = now;
    if (kind === 'wave-won' || kind === 'run-won') contact.coinsAfter = now + (kind === 'run-won' ? 1.15 : 0.65);
    if (kind === 'unit-killed') contact.kills.set(lane, now);
    const intensity = Math.max(0, Math.min(3, options.intensity ?? 1));
    const focus = ({ storm: 1.1, trample: 0.4, leak: 0.55, 'boss-killed': 1.25 } as Partial<Record<SoundKind, number>>)[kind];
    const duckable = ['ballista-fire', 'bolt-hit', 'cauldron-fire', 'splash', 'fence-bite', 'gold'].includes(kind);
    const priority = ['bolt-hit', 'armour-block', 'splash'].includes(kind) ? 2 : ['unit-killed', 'gold'].includes(kind) ? 1 : 0;
    let gain = kind === 'cauldron-fire' && now - contact.ballista < 0.06 ? 1.5 : 1;
    const crowded = kind === 'armour-block' && (now - contact.boss < 0.06
      || [...contact.kills].some(([other, at]) => other !== lane && now - at < 0.06));
    if (kind === 'unit-killed') {
      let bursts = deathBursts.get(engine);
      if (!bursts) { bursts = new Map(); deathBursts.set(engine, bursts); }
      const previous = bursts.get(lane);
      const count = previous && now - previous.at < 0.07 ? previous.count + 1 : 0;
      bursts.set(lane, { at: now, count }); gain = 0.88 ** Math.min(4, count);
    }
    // Settlement coins answer the completed fanfare; battle coins stay with the hit.
    const settlement = kind === 'gold' && now < contact.coinsAfter;
    if (settlement) gain = 2;
    const delay = kind === 'gold' ? Math.max(0, contact.coinsAfter - now) : crowded ? 0.165 : kind === 'armour-block' ? 0.025 : 0;
    return engine.render({ kind, lane: options.lane, focus, duckable, priority, gain, at: now + delay, merge: kind !== 'unit-killed' }, graph => {
      const variation = ['cauldron-fire', 'fence-bite', 'splash'].includes(kind) ? 0.24 : 0.04;
      const synth = new Synth(graph, (settlement ? 1.5 : 1) * (1 + (random() * 2 - 1) * variation), 1 + (random() * 2 - 1) * 0.08);
      effects[kind](synth, intensity);
      if (kind === 'bolt-hit' && now - contact.mixed < 0.45) synth.tone('sine', 720, 650, 0.018, 0.17, 0.02);
    });
  };
}

export function play(kind: SoundKind, options: PlayOptions = {}): Voice | null {
  return createSfx(getAudioEngine())(kind, options);
}
