import {
  newRun, shop, previewLanes, playTurn,
  type Action, type FightResult, type LanePreview, type Mode, type Offer, type RunState,
} from '../src/v1/sim.js';

/** A turn is submitted from its start state, never from an optimistic build. */
export interface BackendStatus {
  pending: boolean;
  phase: string;
  completed: number;
  signature?: string;
  computeUnits?: bigint;
  error?: string;
  warning?: string;
  mismatch?: string[];
}
export interface GameBackend {
  readonly state: RunState;
  status?(): BackendStatus;
  subscribe?(listener: () => void): () => void;
  retry?(): Promise<void>;
  shop(state?: RunState): Offer[];
  preview(state?: RunState): LanePreview[];
  playTurn(actions: readonly Action[]): Promise<FightResult>;
}

export class LocalBackend implements GameBackend {
  private current: RunState;
  constructor(seed: bigint, mode: Mode, start?: RunState) {
    this.current = start ? { ...start, seed, mode } : newRun(seed, mode);
  }
  get state(): RunState { return { ...this.current }; }
  shop(state = this.current): Offer[] { return shop(state); }
  preview(state = this.current): LanePreview[] { return previewLanes(state); }
  async playTurn(actions: readonly Action[]): Promise<FightResult> {
    const result = playTurn(this.current, actions);
    this.current = result.state;
    return result;
  }
}
