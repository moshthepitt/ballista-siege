import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIMITS } from '../src/v1/constants.js';

interface Metrics {
  seeds: number;
  offset: string;
  emptyThreatPct: number;
  results: Record<string, { winPct: number; spentPct: number; tensionPct: number; partPct: Record<string, number>;
    wins?: number; winningArchetypes?: Record<string, { wins: number }>; distinctWinningArchetypes?: number;
    affordableLeakFixesLeft: number; palisadeUsefulTurns: number; zeroWeaponTankLanes: number; zeroWeaponTankHolds: number }>;
}
const paths = process.argv.slice(2);
if (!paths.length) throw Error('Pass one or more v1-funtest JSON reports');
assert(LIMITS.TICKS * LIMITS.GROUPS_PER_LANE <= 40, 'Measured fight pass bound');
for (const path of paths) {
  const m = JSON.parse(readFileSync(path, 'utf8')) as Metrics;
  const { random, greedy, planner } = m.results;
  assert(random && greedy && planner, `${path}: need all three policies`);
  assert(planner.winPct >= 60 && planner.winPct <= 85, `${path}: planner win rate ${planner.winPct}`);
  assert(greedy.winPct >= 15 && greedy.winPct <= 40, `${path}: greedy win rate ${greedy.winPct}`);
  assert(random.winPct < 5, `${path}: random win rate ${random.winPct}`);
  assert(planner.spentPct >= 80, `${path}: planner spending ${planner.spentPct}`);
  assert(planner.tensionPct >= 30, `${path}: tension wins ${planner.tensionPct}`);
  assert.equal(planner.affordableLeakFixesLeft, 0, `${path}: planner leaves an immediate leak fix`);
  assert(planner.palisadeUsefulTurns > 0, `${path}: blockers buy useful firing time`);
  assert(planner.zeroWeaponTankLanes > 0, `${path}: weaponless ablation includes tanks`);
  assert.equal(planner.zeroWeaponTankHolds, 0, `${path}: weaponless lanes cannot hold tanks`);
  assert.equal(m.emptyThreatPct, 100, `${path}: empty-board threat`);
  assert.equal(Object.keys(planner.partPct).length, 6, `${path}: all parts measured`);
  for (const [part, share] of Object.entries(planner.partPct)) {
    assert(share >= 10 && share <= 40, `${path}: ${part} share ${share}`);
  }
  if (planner.winningArchetypes) {
    const buckets = Object.values(planner.winningArchetypes);
    assert.equal(buckets.reduce((n, b) => n + b.wins, 0), planner.wins, `${path}: archetypes partition wins`);
    assert.equal(buckets.length, planner.distinctWinningArchetypes, `${path}: distinct archetype count`);
  }
  console.log(`${path}: all targets pass (${m.seeds} seeds from ${m.offset})`);
}
