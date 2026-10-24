import { C, SECONDS_PER_DAY } from '../src/rules/constants.js';
import {
  emptyState,
  enemies,
  offers,
  play as simulatePlay,
  start as simulateStart,
  type RunState,
  type WaveEvent,
} from '../src/rules/sim.js';

export interface GameBackend {
  state(): RunState;
  start(): Promise<void>;
  play(pick: bigint, cell: bigint): Promise<WaveEvent>;
  status?(): BackendStatus;
  subscribe?(listener: () => void): () => void;
}

export interface BackendStatus {
  pending: boolean;
  phase: string;
  signature?: string;
  computeUnits?: bigint;
  optimisticEvent?: WaveEvent;
  mismatch?: string;
  error?: string;
  warning?: string;
}

/** Optional test day; normal play uses the current UTC day. */
export function dayFromSearch(search: string): bigint | undefined {
  const value = new URLSearchParams(search).get('day');
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new Error('Use a non-negative integer for ?day=N.');
  const day = BigInt(value);
  try {
    offers(day, C.WAVES);
    enemies(day, C.WAVES);
  } catch {
    throw new Error('That day exceeds the simulator’s u64 range.');
  }
  return day;
}

export class LocalBackend implements GameBackend {
  private current = emptyState();
  private started = false;
  private readonly day: bigint | undefined;
  private readonly now: () => number;

  constructor(options: { day?: bigint; now?: () => number } = {}) {
    this.day = options.day;
    this.now = options.now ?? Date.now;
  }

  state(): RunState {
    return { ...this.current };
  }

  async start(): Promise<void> {
    const unixTs = this.day === undefined
      ? BigInt(Math.floor(this.now() / 1_000))
      : this.day * SECONDS_PER_DAY;
    const next = simulateStart(this.current, unixTs);
    // Validate before committing state, including explicit constructor day overrides.
    offers(next.day, C.WAVES);
    enemies(next.day, C.WAVES);
    this.current = next;
    this.started = true;
  }

  async play(pick: bigint, cell: bigint): Promise<WaveEvent> {
    if (!this.started) throw new Error('Start a run before placing a part.');
    const { state, event } = simulatePlay(this.current, this.current.wave, pick, cell);
    this.current = state;
    return event;
  }
}

