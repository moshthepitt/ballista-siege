import { AudioEngine, getAudioEngine, type Voice } from './engine.js';
import { Synth } from './synth.js';

export type MusicPhase = 'build' | 'battle' | 'boss' | 'outro';
export const LOOKAHEAD_MS = 25;
export const SCHEDULE_HORIZON = 0.1;
export const STEPS_PER_BAR = 16;
export const BUILD_BAR_SECONDS = 60 / 80 * 4;
export const barSeconds = (phase: MusicPhase, tickMs: number): number =>
  phase === 'battle' || phase === 'boss' ? tickMs / 1000 : BUILD_BAR_SECONDS;

export type MusicStep = {
  at: number; bar: number; step: number; phase: MusicPhase; barDuration: number; transition: boolean;
};

/** Audio-clock transport. Tempo and phase requests take effect at the next unscheduled bar. */
export class MusicTimeline {
  private phase: MusicPhase;
  private pendingPhase: MusicPhase | null = null;
  private tickMs = 3000;
  private pendingTickMs: number | null = null;
  private index = 0;
  private nextAt: number;
  private duration: number;

  constructor(startAt = 0, phase: MusicPhase = 'build') {
    this.nextAt = startAt; this.phase = phase; this.duration = barSeconds(phase, this.tickMs);
  }
  setPhase(phase: MusicPhase): void { this.pendingPhase = phase; }
  syncTick(tickMs: number): void {
    if (!Number.isFinite(tickMs) || tickMs <= 0) throw new RangeError('tickMs must be positive');
    this.pendingTickMs = tickMs;
  }
  get nextBarAt(): number {
    return this.nextAt + ((STEPS_PER_BAR - this.index % STEPS_PER_BAR) % STEPS_PER_BAR) * this.duration / STEPS_PER_BAR;
  }

  schedule(now: number, horizon = SCHEDULE_HORIZON): MusicStep[] {
    const events: MusicStep[] = [];
    // A sleeping tab resumes without scheduling a burst of notes from missed bars.
    if (this.nextAt < now - this.duration) {
      const bars = Math.floor((now - this.nextAt) / this.duration);
      this.nextAt += bars * this.duration; this.index += bars * STEPS_PER_BAR;
    }
    while (this.nextAt < now + horizon - 1e-9) {
      const step = this.index % STEPS_PER_BAR;
      let transition = this.index === 0;
      if (step === 0) {
        if (this.pendingTickMs !== null) { this.tickMs = this.pendingTickMs; this.pendingTickMs = null; }
        if (this.pendingPhase !== null) {
          transition ||= this.phase !== this.pendingPhase;
          this.phase = this.pendingPhase; this.pendingPhase = null;
        }
        this.duration = barSeconds(this.phase, this.tickMs);
      }
      if (this.nextAt >= now - 0.001) events.push({ at: this.nextAt, bar: Math.floor(this.index / STEPS_PER_BAR), step, phase: this.phase, barDuration: this.duration, transition });
      if (step === 15 && this.phase === 'outro' && !this.pendingPhase) this.pendingPhase = 'build';
      this.nextAt += this.duration / STEPS_PER_BAR; this.index++;
    }
    return events;
  }
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let n = state;
    n = Math.imul(n ^ n >>> 15, n | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}

export function phraseForBar(seed: number, bar: number, phase: MusicPhase) {
  const random = seededRandom(seed ^ Math.imul(bar + 1, 0x9e3779b9) ^ { build: 7, battle: 19, boss: 31, outro: 43 }[phase]);
  return {
    variant: Math.floor(random() * 16),
    root: [0, 0, 5, 7][Math.floor(random() * 4)]!,
    notes: Array.from({ length: 8 }, () => Math.floor(random() * 5)),
  };
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
type Layer = { node: GainNode; retireAt: number };
type TimerPort = { set: (callback: () => void, ms: number) => unknown; clear: (id: unknown) => void };
const browserTimer: TimerPort = { set: (callback, ms) => setInterval(callback, ms), clear: id => clearInterval(id as ReturnType<typeof setInterval>) };

export class MusicSequencer {
  private timeline: MusicTimeline | null = null;
  private phase: MusicPhase = 'build';
  private intensity = 0;
  private tickMs = 3000;
  private timerId: unknown = null;
  private started = false;
  private layer: Layer | null = null;
  private layers: Layer[] = [];
  private voices = new Set<Voice>();
  private removeUnlock: () => void;

  constructor(private engine: AudioEngine, private seed = 0x51e9e, private timer: TimerPort = browserTimer) {
    this.removeUnlock = engine.onUnlock(() => { if (this.started) this.begin(); });
  }
  setPhase(phase: MusicPhase): void { this.phase = phase; this.timeline?.setPhase(phase); this.start(); }
  setIntensity(intensity: number): void { this.intensity = Math.max(0, Math.min(3, Math.round(intensity))); }
  /** Actual playback tick duration: pass baseTickMs / speed for 1x or 2x. */
  syncTick(tickMs: number): void {
    if (!Number.isFinite(tickMs) || tickMs <= 0) throw new RangeError('tickMs must be positive');
    this.tickMs = tickMs; this.timeline?.syncTick(tickMs);
  }
  start(): void { this.started = true; this.begin(); }
  private begin(): void {
    const context = this.engine.getContext();
    if (!context || this.timerId !== null) return;
    this.timeline = new MusicTimeline(context.currentTime + 0.02, this.phase);
    this.timeline.syncTick(this.tickMs);
    this.pump();
    this.timerId = this.timer.set(() => this.pump(), LOOKAHEAD_MS);
  }
  stop(): void {
    this.started = false;
    if (this.timerId !== null) this.timer.clear(this.timerId);
    this.timerId = null; this.timeline = null;
    for (const voice of this.voices) voice.stop();
    this.voices.clear();
    for (const layer of this.layers) layer.node.disconnect();
    this.layers = []; this.layer = null;
  }
  dispose(): void { this.stop(); this.removeUnlock(); }

  private pump(): void {
    const context = this.engine.getContext();
    if (!context || !this.timeline) return;
    for (const layer of this.layers) if (layer.retireAt <= context.currentTime) layer.node.disconnect();
    this.layers = this.layers.filter(layer => layer.retireAt > context.currentTime);
    for (const voice of this.voices) if (voice.end <= context.currentTime) this.voices.delete(voice);
    for (const step of this.timeline.schedule(context.currentTime)) {
      if (step.transition || !this.layer) this.crossfade(step);
      this.scheduleStep(step);
    }
  }
  private crossfade(step: MusicStep): void {
    const context = this.engine.getContext()!;
    const fade = Math.min(0.35, step.barDuration / 4);
    if (this.layer) {
      this.layer.node.gain.setValueAtTime(1, step.at);
      this.layer.node.gain.linearRampToValueAtTime(0, step.at + fade);
      this.layer.retireAt = step.at + fade + 0.05;
    }
    const node = context.createGain(); node.connect(this.engine.getMusicBus()!);
    node.gain.setValueAtTime(0, step.at); node.gain.linearRampToValueAtTime(1, step.at + fade);
    this.layer = { node, retireAt: Infinity }; this.layers.push(this.layer);
  }
  private note(kind: string, step: MusicStep, build: (synth: Synth) => void): void {
    const core = ['pad', 'bass', 'kick', 'pluck'].includes(kind);
    const gain = step.phase === 'boss' ? 1.5 : step.phase === 'battle' ? 1.45 : 1.25;
    const voice = this.engine.render({ kind: `music:${kind}`, bus: this.layer!.node, at: step.at, merge: false, gain, priority: core ? 1 : 0 }, graph => build(new Synth(graph)));
    if (voice) this.voices.add(voice);
  }
  private scheduleStep(step: MusicStep): void {
    const { at, bar, phase, barDuration: duration } = step;
    const n = step.step, intensity = this.intensity;
    const phrase = phraseForBar(this.seed, bar, phase);
    const scale = phase === 'boss' || phase === 'outro' ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9];
    const boss = phase === 'boss';
    const root = boss ? 45 + [0, 0, 5, 3, 0, 7, 5, 0][bar % 8]! : 48 + phrase.root;
    if (n === 0) this.note('pad', step, s => {
      const notes = [root, root + (phase === 'boss' ? 3 : scale[2]!), root + 7];
      notes.forEach(midi => s.tone('sine', hz(midi), hz(midi), duration + 0.4, 0.045, 0, 0.25));
      notes.forEach(midi => s.tone('triangle', hz(midi) * 1.003, hz(midi) * 1.003, duration + 0.3, boss ? 0.022 : 0.016, 0, 0.16, duration * 0.3, 650));
      if (boss) s.tone('triangle', 55, 55, duration + 0.25, 0.05, 0, 0.08, duration * 0.4);
    });
    if (boss && (n === 0 || n === 5 || n === 8 || (n === 13 && phrase.variant % 3 !== 0))) {
      // An eight-bar minor phrase, with a held answer and a breathing final bar.
      const melody = bar % 4 < 2 ? [0, 2, 1, 4] : [3, 2, 1, 0];
      const index = n === 0 ? 0 : n === 5 ? 1 : n === 8 ? 2 : 3;
      const midi = root + 12 + scale[melody[index]!]!;
      if (!(bar % 8 === 7 && n > 8)) this.note('pluck', step, s => {
        const length = Math.min(0.5, duration * (index === 2 ? 0.32 : 0.24));
        s.tone('sawtooth', hz(midi), hz(midi) * 0.997, length, 0.055, 0, 0.025, length * 0.2, 900);
        s.tone('sine', hz(midi) * 1.003, hz(midi), length, 0.025, 0, 0.025, length * 0.15);
      });
    } else if (!boss && n % (phase === 'build' ? 4 : 2) === 0 && (phrase.variant + n) % 5 !== 0) {
      const midi = root + 12 + scale[phrase.notes[n / 2 % 8]!]!;
      this.note('pluck', step, s => s.tone('triangle', hz(midi), hz(midi) * 0.998, Math.min(0.4, duration / 5), 0.075));
    }
    if (phase === 'build' || phase === 'outro') return;
    if (n % (intensity >= 2 ? 2 : 4) === 0) {
      const midi = root - 12 + (intensity >= 2 && n % 4 === 2 ? 7 : 0);
      this.note('bass', step, s => {
        s.tone('triangle', hz(midi), hz(midi), duration / (intensity >= 2 ? 10 : 6), boss ? 0.26 : 0.15);
        if (boss) s.tone('sine', hz(midi) * 2, hz(midi) * 2, duration / 7, 0.075, 0, 0.008);
      });
    }
    if (n === 0 || n === 8 || (intensity >= 2 && n === 10) || (phase === 'boss' && n === 14)) {
      this.note('kick', step, s => s.tone('sine', phase === 'boss' ? 120 : 145, 38, Math.min(0.2, duration / 6), phase === 'boss' ? 0.52 : 0.24));
    }
    if (intensity >= 1 && (n === 4 || n === 12)) {
      this.note('snare', step, s => { s.noise(2500, 1300, Math.min(0.13, duration / 8), boss ? 0.14 : 0.1, 0, 'bandpass', 0.008); s.tone('triangle', 170, 90, 0.07, boss ? 0.1 : 0.07); });
    }
    if (intensity >= 2 && n % (intensity === 3 ? 1 : 2) === 0) {
      this.note('hat', { ...step, at: at + (n % 2 ? duration / 160 : 0) }, s => s.noise(6500, 4500, 0.035, n % 4 ? 0.03 : 0.05, 0, 'bandpass', 0.005, 1.4));
    }
  }
}

let sharedMusic: MusicSequencer | undefined;
export function getMusic(): MusicSequencer { return sharedMusic ??= new MusicSequencer(getAudioEngine()); }
export const setPhase = (phase: MusicPhase): void => getMusic().setPhase(phase);
export const setIntensity = (intensity: number): void => getMusic().setIntensity(intensity);
export const syncTick = (tickMs: number): void => getMusic().syncTick(tickMs);
