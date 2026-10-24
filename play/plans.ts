import { BuildQueue } from './queue.js';
import { InvestmentCache } from './insights.js';
import type { RunState } from '../src/v1/sim.js';

export type PlanName = 'A' | 'B';
/** Each queue owns its actions and reroll undo floor. Only the visible queue fights. */
export class BuildPlans {
  private queues: Record<PlanName, BuildQueue>;
  selected: PlanName = 'A';
  constructor(start: RunState) { this.queues = { A: new BuildQueue(start), B: new BuildQueue(start) }; }
  get current() { return this.queues[this.selected]; }
  get(name: PlanName) { return this.queues[name]; }
  switch(name: PlanName) { this.selected = name; return this.current; }
}
const projections = new InvestmentCache();
export function planValues(state: RunState) {
  const results = projections.project(state), first = results[0]?.state.walls ?? state.walls;
  const last = results.at(-1)?.state.walls ?? first;
  return { wave: state.wave + 1n, loss: state.walls - first, nextTwoLoss: first - last,
    throughWave: results.at(-1)?.state.wave ?? state.wave, gold: state.gold, actions: state.actionsUsed };
}
