import { InvestmentCache } from '../insights.js';
import type { RunState } from '../../src/v1/sim.js';

const investments = new InvestmentCache();
import { plural } from '../copy.js';
/** Sequential forecasts, with no further purchases; never project beyond a fallen wall. */
export function planComparison(before: RunState, after: RunState): string {
  const left = investments.project(before), right = investments.project(after);
  const wallsAt = (rows: typeof left, wave: bigint, initial: RunState) => rows.find(r => r.state.wave === wave)?.state.walls ?? rows.at(-1)?.state.walls ?? initial.walls;
  const first = before.wave + 1n, last = [...left, ...right].reduce((w, r) => r.state.wave > w ? r.state.wave : w, first);
  const actions = after.actionsUsed - before.actionsUsed;
  return `Walls after W${first} ${wallsAt(left, first, before)} → ${wallsAt(right, first, after)}${last > first ? ` · after W${last} ${wallsAt(left, last, before)} → ${wallsAt(right, last, after)}` : ''} · ${after.gold}g left · ${actions} ${plural(actions, 'action')}`;
}
