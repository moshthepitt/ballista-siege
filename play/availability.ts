import { C, LIMITS as L, PART as P } from '../src/v1/constants.js';
import { partAt, shop, tierAt, upgradeCost, type RunState } from '../src/v1/sim.js';

/** Copy priority is independent of simulator validation order. */
export function cardReason(state: RunState, slot: number): string {
  const offer = shop(state)[slot];
  if (state.actionsUsed >= BigInt(L.ACTIONS)) return 'No actions left. Fight, or undo one.';
  if (!offer.available) return 'Bought. A reroll or the next wave brings new offers.';
  if (offer.price > state.gold) return `Need ${offer.price - state.gold} more gold.`;
  if (Array.from({ length: L.CELLS }, (_, i) => partAt(state, BigInt(i))).every(Boolean)) return 'Every cell is full. Sell a part first.';
  return '';
}
export function inspectorReason(state: RunState, cell: bigint, action: 'upgrade' | 'overclock' | 'sell'): string {
  const part = partAt(state, cell), tier = tierAt(state, cell);
  if (action === 'upgrade' && tier >= BigInt(L.TIERS)) return 'Max tier';
  if (action === 'overclock') {
    if (part > P.PALISADE) return 'Weapons and Palisades only';
    if (tier !== BigInt(L.TIERS)) return 'Tier 3 only';
    if ((state.overclocked ?? 0n) & (1n << cell)) return 'Overclocked for this fight';
  }
  const cost = action === 'upgrade' ? upgradeCost(part, tier) : action === 'overclock' ? C.OVERCLOCK_COST : 0n;
  if (cost > state.gold) return `Need ${cost - state.gold} more gold`;
  if (state.actionsUsed >= BigInt(L.ACTIONS)) return 'No actions left';
  return '';
}
export function rerollReason(state: RunState): string {
  return state.actionsUsed >= BigInt(L.ACTIONS) ? 'No actions left' : state.gold < state.rerolls + 1n ? `Need ${state.rerolls + 1n - state.gold} more gold` : '';
}
