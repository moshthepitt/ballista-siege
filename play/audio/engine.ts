export const STORAGE_KEY = 'ballista:siege:audio';
export const VOICE_CAP = 12;
export const MERGE_SECONDS = 0.06;
export const LANE_PANS = [-0.75, -0.25, 0.25, 0.75] as const;
const MIX_GAIN = 3.6;
const CEILING = 0.65;

/** Bounded transfer after compression; the final volume control can only attenuate it. */
export function limiterCurve(): Float32Array<ArrayBuffer> {
  return Float32Array.from({ length: 4097 }, (_, i) => 0.92 * CEILING * Math.tanh((i / 2048 - 1) / CEILING));
}

export type AudioSettings = { master: number; music: number; sfx: number; muted: boolean };
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type EngineOptions = {
  contextFactory?: () => AudioContext;
  storage?: StoragePort | null;
  search?: string;
  gestures?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
};
export type VoiceGraph = {
  context: AudioContext;
  output: GainNode;
  at: number;
  node<T extends AudioNode>(node: T): T;
  source(source: AudioScheduledSourceNode, start: number, end: number): void;
};
export type Voice = {
  kind: string;
  lane?: number;
  at: number;
  end: number;
  count: number;
  gain: GainNode;
  priority: number;
  stop(): void;
};
type VoiceRequest = {
  kind: string;
  lane?: number;
  gain?: number;
  at?: number;
  merge?: boolean;
  bus?: 'sfx' | 'music' | AudioNode;
  duckable?: boolean;
  focus?: number;
  priority?: number;
};

const defaults: AudioSettings = { master: 1, music: 0.4, sfx: 0.7, muted: false };
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export const mergeGain = (count: number) => 1 + Math.log2(Math.max(1, count)) * 0.3;

function browserStorage(): StoragePort | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** A voice is one event or musical note, including all of its oscillator/noise layers. */
export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private music: GainNode | null = null;
  private sfx: GainNode | null = null;
  private musicDuck: GainNode | null = null;
  private duckUntil = 0;
  private routine = new Map<Voice, GainNode>();
  private lanes: StereoPannerNode[] = [];
  private voices: Voice[] = [];
  private storage: StoragePort | null;
  private gestures: EngineOptions['gestures'];
  private factory: () => AudioContext;
  private settings: AudioSettings = { ...defaults };
  private listeners = new Set<() => void>();
  private unlockListeners = new Set<() => void>();
  private unlocking: Promise<void> | null = null;
  readonly forcedMute: boolean;

  constructor(options: EngineOptions = {}) {
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.gestures = options.gestures === undefined ? (typeof window === 'undefined' ? null : window) : options.gestures;
    this.factory = options.contextFactory ?? (() => new AudioContext());
    this.forcedMute = new URLSearchParams(options.search ?? (typeof location === 'undefined' ? '' : location.search)).get('mute') === '1';
    try {
      const saved: unknown = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? 'null');
      if (saved && typeof saved === 'object') this.assignSettings(saved as Partial<AudioSettings>);
    } catch { /* Private browsing and damaged settings use defaults. */ }
    this.gestures?.addEventListener('pointerdown', this.onGesture, { capture: true });
    this.gestures?.addEventListener('keydown', this.onGesture, { capture: true });
  }

  private onGesture = () => { void this.unlock().catch(() => {}); };
  get unlocked(): boolean { return this.context?.state === 'running'; }
  get muted(): boolean { return this.forcedMute || this.settings.muted; }
  getSettings(): AudioSettings { return { ...this.settings }; }
  getContext(): AudioContext | null { return this.unlocked ? this.context : null; }
  getMusicBus(): GainNode | null { return this.music; }
  getSfxBus(): GainNode | null { return this.sfx; }
  get activeVoiceCount(): number { this.prune(); return this.voices.length; }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onUnlock(listener: () => void): () => void { this.unlockListeners.add(listener); return () => this.unlockListeners.delete(listener); }

  /** Call only inside a user gesture. Importing the module never creates a context. */
  unlock(): Promise<void> {
    if (this.unlocking) return this.unlocking;
    const wasRunning = this.unlocked;
    try {
      if (!this.context) {
        const context = this.factory();
        this.context = context;
        this.master = context.createGain();
        this.music = context.createGain();
        this.sfx = context.createGain();
        this.musicDuck = context.createGain();
        const drive = context.createGain(); drive.gain.value = MIX_GAIN;
        const compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -14;
        compressor.knee.value = 6;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.004;
        compressor.release.value = 0.12;
        const limiter = context.createWaveShaper(); limiter.curve = limiterCurve(); limiter.oversample = '4x';
        this.music.connect(this.musicDuck).connect(drive);
        this.sfx.connect(drive);
        drive.connect(compressor).connect(limiter).connect(this.master).connect(context.destination);
        this.lanes = LANE_PANS.map(pan => {
          const node = context.createStereoPanner(); node.pan.value = pan; node.connect(this.sfx!); return node;
        });
        this.applySettings();
      }
      const resumed = this.context.state === 'running' ? Promise.resolve() : this.context.resume();
      this.unlocking = resumed.then(() => {
        if (!this.unlocked) return;
        this.detachGestures();
        if (!wasRunning) for (const listener of this.unlockListeners) listener();
        for (const listener of this.listeners) listener();
      }).finally(() => { this.unlocking = null; });
      return this.unlocking;
    } catch (error) { return Promise.reject(error); }
  }

  setSettings(update: Partial<AudioSettings>): void {
    this.assignSettings(update);
    this.applySettings();
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* Audio still works without storage. */ }
    for (const listener of this.listeners) listener();
  }
  toggleMute(): void { this.setSettings({ muted: !this.settings.muted }); }

  private assignSettings(update: Partial<AudioSettings>): void {
    for (const key of ['master', 'music', 'sfx'] as const) {
      if (typeof update[key] === 'number' && Number.isFinite(update[key])) this.settings[key] = clamp(update[key]);
    }
    if (typeof update.muted === 'boolean') this.settings.muted = update.muted;
  }
  private applySettings(): void {
    if (!this.context) return;
    const at = this.context.currentTime;
    this.master?.gain.setTargetAtTime(this.muted ? 0 : this.settings.master, at, 0.015);
    this.music?.gain.setTargetAtTime(this.settings.music, at, 0.015);
    this.sfx?.gain.setTargetAtTime(this.settings.sfx, at, 0.015);
  }
  private detachGestures(): void {
    this.gestures?.removeEventListener('pointerdown', this.onGesture, { capture: true });
    this.gestures?.removeEventListener('keydown', this.onGesture, { capture: true });
  }
  private prune(): void {
    const now = this.context?.currentTime ?? 0;
    for (const voice of [...this.voices]) if (voice.end <= now) voice.stop();
  }

  private duck(param: AudioParam, at: number, end: number, level: number): void {
    param.cancelAndHoldAtTime(at);
    param.linearRampToValueAtTime(level, at + 0.012);
    param.setValueAtTime(level, end);
    param.linearRampToValueAtTime(1, end + 0.18);
  }

  render(request: VoiceRequest, build: (graph: VoiceGraph) => void): Voice | null {
    const context = this.getContext();
    if (!context || this.muted) return null;
    this.prune();
    const at = Math.max(context.currentTime, request.at ?? context.currentTime);
    const priority = request.focus ? 2 : request.priority ?? 0;
    if (request.focus) {
      this.duckUntil = Math.max(this.duckUntil, at + request.focus);
      for (const node of this.routine.values()) this.duck(node.gain, at, this.duckUntil, 0.22);
      this.duck(this.musicDuck!.gain, at, this.duckUntil, 0.65);
    }
    const lane = request.lane === undefined ? undefined : Math.max(0, Math.min(3, Math.round(request.lane)));
    const baseGain = Math.max(0, request.gain ?? 1);
    if (request.merge !== false && (!request.bus || request.bus === 'sfx')) {
      const match = this.voices.find(v => v.kind === request.kind && v.lane === lane && Math.abs(v.at - at) < MERGE_SECONDS - 1e-9);
      if (match) {
        match.count++;
        match.gain.gain.setTargetAtTime(baseGain * mergeGain(match.count), context.currentTime, 0.004);
        return match;
      }
    }
    if (this.voices.length >= VOICE_CAP) {
      const lowest = Math.min(...this.voices.map(v => v.priority));
      const victim = lowest <= priority ? this.voices.find(v => v.priority === lowest) : undefined;
      if (!victim) return null;
      victim.stop();
    }
    const output = context.createGain(); output.gain.value = baseGain;
    const bus = typeof request.bus === 'object' ? request.bus : request.bus === 'music' ? this.music! : lane === undefined ? this.sfx! : this.lanes[lane]!;
    const nodes: AudioNode[] = [output], sources: AudioScheduledSourceNode[] = [];
    let duck: GainNode | null = null;
    if (request.duckable) {
      duck = context.createGain(); nodes.push(duck); output.connect(duck).connect(bus);
      if (at < this.duckUntil) {
        duck.gain.setValueAtTime(0.22, at);
        duck.gain.setValueAtTime(0.22, this.duckUntil);
        duck.gain.linearRampToValueAtTime(1, this.duckUntil + 0.18);
      }
    } else output.connect(bus);
    let remaining = 0, sealed = false, stopped = false;
    const dispose = () => {
      if (stopped) return;
      stopped = true;
      for (const node of nodes) node.disconnect();
      this.routine.delete(voice);
      this.voices = this.voices.filter(v => v !== voice);
    };
    const voice: Voice = {
      kind: request.kind, lane, at, end: at, count: 1, gain: output, priority,
      stop: () => {
        if (stopped) return;
        output.gain.cancelScheduledValues(context.currentTime);
        output.gain.setValueAtTime(0, context.currentTime);
        for (const source of sources) { try { source.stop(context.currentTime); } catch { /* Already ended. */ } }
        dispose();
      },
    };
    this.voices.push(voice);
    if (duck) this.routine.set(voice, duck);
    try {
      build({
        context, output, at,
        node: node => { nodes.push(node); return node; },
        source: (source, start, end) => {
          sources.push(source); nodes.push(source); remaining++; voice.end = Math.max(voice.end, end);
          source.onended = () => { remaining--; if (sealed && remaining === 0) dispose(); };
          source.start(start); source.stop(end);
        },
      });
      sealed = true;
      if (!remaining) dispose();
      return voice;
    } catch (error) { voice.stop(); throw error; }
  }

  async dispose(): Promise<void> {
    this.detachGestures();
    for (const voice of [...this.voices]) voice.stop();
    this.listeners.clear(); this.unlockListeners.clear();
    await this.context?.close();
    this.context = null;
  }
}

// Register gestures at import time so a first-click play() never misses pointerdown.
// Only the manager exists here; the AudioContext is still created by the gesture.
const shared = new AudioEngine();
export function getAudioEngine(): AudioEngine { return shared; }
