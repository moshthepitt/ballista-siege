import type { EnemyGroup, FightResult } from '../src/v1/sim.js';

export const plural = (count: number | bigint, one: string, many = `${one}s`): string =>
  count === 1 || count === 1n ? one : many;

export const groupLabel = (group: EnemyGroup, bossName = 'Boss'): string =>
  group.kind === 'boss' ? bossName : `${group.count} ${group.kind === 'swarm' ? 'Swarm' : plural(group.count, 'Brute')}`;

/** Deep Quarry gold is already included in the Quarry total. */
export function settlementRows(s: FightResult['summary']): [string, bigint][] {
  const deep = s.deepQuarry ?? 0n;
  const rows: [string, bigint][] = [['Base', s.income], ['Clean lanes', s.clear], ['Bounty', s.bounty], ['Quarry', s.quarry - deep], ['Deep Quarry', deep], ['Salvage', s.salvage]];
  return rows.filter(([label, value]) => label === 'Base' || value > 0n);
}
export function settlementText(s: FightResult['summary']): string {
  const rows = settlementRows(s);
  return [...rows.map(([label, value]) => `${label} +${value}`), `Total +${rows.reduce((sum, [, value]) => sum + value, 0n)}g`].join(' · ');
}

/** Keep compact controls readable; callers retain the full seed in their accessible label. */
export function compactSeed(seed: bigint): string {
  const value = String(seed);
  return value.length > 8 ? `${value.slice(0, 3)}…${value.slice(-3)}` : value;
}
