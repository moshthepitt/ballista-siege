import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { C, LIMITS as L, PART, PART_NAMES } from '../src/v1/constants.js';
import { bots, legalActions, planner, type Bot } from '../src/v1/bots/index.js';
import { applyAction, evaluateFight, fight, newRun, partAt, shop, tierAt, waveForecast, withPart, type RunState } from '../src/v1/sim.js';

const seeds = Number(process.env.SEEDS ?? 200), offset = BigInt(process.env.OFFSET ?? 0);
if (!Number.isInteger(seeds) || seeds < 1) throw new Error('SEEDS must be positive');
const policies: Record<string, Bot> = { ...bots,
  noPalisade: s => planner(s, { excludeParts: [PART.PALISADE] }),
  noUpgrades: s => planner(s, { upgrades: false }),
  noOverclock: s => planner(s, { overclock: false }),
  palisadeOnly: s => planner(s, { excludeParts: [PART.BALLISTA, PART.CAULDRON, PART.FORGE, PART.WATCHTOWER, PART.QUARRY] }),
};
const names = (process.env.BOTS ?? 'random,greedy,planner').split(',');
const sampledStates: RunState[] = [];
function measure(bot: Bot, name: string) {
  const archetypes: Record<string, { wins: number; seeds: string[]; tiers: number[] }> = {};
  const bosses = { Gatebreaker: { encounters: 0, kills: 0, chippedLeaks: 0, walls: 0, wallsSavedByChipping: 0 },
    'Last Siege': { encounters: 0, kills: 0, chippedLeaks: 0, walls: 0, wallsSavedByChipping: 0 } };
  function classify(s: RunState) {
    const tiers = Array(7).fill(0) as number[];
    let blockers = 0;
    for (let cell = 0n; cell < 16n; cell++) {
      const p = Number(partAt(s, cell)); tiers[p] += Number(tierAt(s, cell));
      if (p === Number(PART.PALISADE)) blockers++;
    }
    // Fixed bins, defined before fresh validation. Weapon tiers: >60% leads.
    const weapon = tiers[1] > 1.5 * tiers[2] ? 'Ballista' : tiers[2] > 1.5 * tiers[1] ? 'Cauldron' : 'mixed';
    const support = [4, 5, 6].sort((a, b) => tiers[b] - tiers[a] || a - b)[0];
    const key = `${weapon}/${PART_NAMES[support]}/${blockers >= 2 ? '2+ Palisades' : '0-1 Palisades'}`;
    const bucket = archetypes[key] ??= { wins: 0, seeds: [], tiers: Array(7).fill(0) };
    bucket.wins++; if (bucket.seeds.length < 5) bucket.seeds.push(String(s.seed));
    tiers.forEach((v, i) => bucket.tiers[i] += v);
  }
  const totals = { runs: seeds, wins: 0, turns: 0, actions: 0, spent: 0, available: 0, upgrades: 0,
    overclocks: 0, overclockTurns: 0, overclockCost: 0, overclockUsefulTurns: 0, overclockDamageSaved: 0, overclockKillsAdded: 0,
    overclocksByWave: Array(10).fill(0) as number[],
    deepQuarryBonus: 0, deepQuarryPaidTurns: 0,
    midUpgrades: 0, rerolls: 0, sells: 0, tensionWins: 0, wallsOnWins: 0, kills: 0, retreats: 0,
    ticks: 0, occupied: 0, parts: Array(7).fill(0) as number[], tiered: 0,
    phases: { early: { turns: 0, occupied: 0, parts: Array(7).fill(0) as number[], quarryBuys: 0, quarryIncome: 0, quarryRuns: 0 },
      later: { turns: 0, occupied: 0, parts: Array(7).fill(0) as number[], quarryBuys: 0, quarryIncome: 0, quarryRuns: 0 } },
    zeroActionLeakTurns: 0, zeroActionLeakWithGold: 0,
    damageByWave: Array(10).fill(0) as number[], turnsByWave: Array(10).fill(0) as number[],
    spendByWave: Array(10).fill(0) as number[], actionsByWave: Array(10).fill(0) as number[],
    idleDamageByWave: Array(10).fill(0) as number[], lateRescues: 0, lateImprovements: 0,
    frozenLateRuns: 0, frozenLateWins: 0, frozenLateDamage: 0,
    retreatsByWave: Array(10).fill(0) as number[],
    affordableLeakFixesLeft: 0, palisadeUsefulTurns: 0, palisadeDamageSaved: 0, palisadeKillsAdded: 0,
    zeroWeaponTankLanes: 0, zeroWeaponTankHolds: 0 };
  for (let i = 0; i < seeds; i++) {
    let s = newRun(offset + BigInt(i), 'practice');
    const quarrySeen = { early: false, later: false };
    totals.available += Number(s.gold);
    while (!s.done) {
      const wave = Number(s.wave), actions = bot(s);
      const phase = wave < 4 ? 'early' : 'later', phaseTotals = totals.phases[phase];
      phaseTotals.turns++;
      const idle = wave >= 7 ? evaluateFight(s) : null;
      if (wave === 7) {
        let frozen = s, damage = 0;
        while (!frozen.done) { const r = evaluateFight(frozen); damage += Number(r.summary.damage); frozen = r.state; }
        totals.frozenLateRuns++; totals.frozenLateWins += Number(frozen.won); totals.frozenLateDamage += damage;
      }
      for (const a of actions) {
        if (a.type === 'buy' && shop(s)[Number(a.slot)].part === PART.QUARRY) phaseTotals.quarryBuys++;
        const before = s.gold; s = applyAction(s, a);
        if (a.type === 'sell') { totals.sells++; totals.available += Number(s.gold - before); }
        else { totals.spent += Number(before - s.gold); totals.spendByWave[wave] += Number(before - s.gold); }
        if (a.type === 'upgrade') { totals.upgrades++; if (wave >= 3 && wave <= 7) totals.midUpgrades++; }
        if (a.type === 'reroll') totals.rerolls++;
        if (a.type === 'overclock') { totals.overclocks++; totals.overclockCost += Number(before - s.gold); totals.overclocksByWave[wave]++; }
      }
      totals.actions += actions.length; totals.turns++; totals.ticks += L.TICKS;
      if (name === 'planner' && process.env.STATES) sampledStates.push(s);
      totals.actionsByWave[wave] += actions.length;
      for (let cell = 0n; cell < 16n; cell++) {
        const p = Number(partAt(s, cell));
        if (p) {
          totals.parts[p]++; totals.occupied++; phaseTotals.parts[p]++; phaseTotals.occupied++;
          if (p === Number(PART.QUARRY)) quarrySeen[phase] = true;
          if (tierAt(s, cell) > 1n) totals.tiered++;
        }
      }
      const result = s.wave === 4n || s.wave === 9n ? fight(s) : evaluateFight(s);
      if (result.frames.length) {
        const boss = result.frames.at(-1)!.groups.find(g => g.kind === 'boss')!;
        const b = bosses[s.wave === 4n ? 'Gatebreaker' : 'Last Siege']; b.encounters++;
        if (boss.status === 'dead') b.kills++;
        else {
          const damage = result.frames.flatMap(f => f.leaks).find(l => l.group === boss.id)!.damage;
          b.walls += Number(damage); b.wallsSavedByChipping += Number(C.BOSS_LEAK - damage);
          if (boss.hp < boss.maxHp) b.chippedLeaks++;
        }
      }
      totals.deepQuarryBonus += Number(result.summary.deepQuarry ?? 0n);
      if (result.summary.deepQuarry) totals.deepQuarryPaidTurns++;
      if (s.overclocked) {
        totals.overclockTurns++;
        const cold = evaluateFight({ ...s, overclocked: 0n });
        const saved = Number(cold.summary.damage - result.summary.damage), added = Number(result.summary.kills - cold.summary.kills);
        if (saved > 0 || added > 0) totals.overclockUsefulTurns++;
        totals.overclockDamageSaved += saved; totals.overclockKillsAdded += added;
      }
      phaseTotals.quarryIncome += Number(result.summary.quarry);
      if (!actions.length && result.summary.damage > 0n) {
        totals.zeroActionLeakTurns++;
        if (s.gold >= 5n) totals.zeroActionLeakWithGold++;
      }
      if (name === 'planner') {
        if (result.summary.damage > 0n) for (const action of legalActions(s)) {
          if (action.type === 'sell' || action.type === 'reroll') continue;
          if (evaluateFight(applyAction(s, action)).summary.damage < result.summary.damage) {
            totals.affordableLeakFixesLeft++; break;
          }
        }
        let withoutPalisades = s, withoutWeapons = s;
        for (let cell = 0n; cell < 16n; cell++) {
          const part = partAt(s, cell);
          if (part === PART.PALISADE) withoutPalisades = withPart(withoutPalisades, cell, 0n, 0n);
          if (part === PART.BALLISTA || part === PART.CAULDRON) withoutWeapons = withPart(withoutWeapons, cell, 0n, 0n);
        }
        if (withoutPalisades.parts !== s.parts) {
          const removed = evaluateFight(withoutPalisades);
          const damageSaved = Number(removed.summary.damage - result.summary.damage);
          const killsAdded = Number(result.summary.kills - removed.summary.kills);
          if (damageSaved > 0 || killsAdded > 0) totals.palisadeUsefulTurns++;
          totals.palisadeDamageSaved += damageSaved; totals.palisadeKillsAdded += killsAdded;
        }
        const unarmed = evaluateFight(withoutWeapons);
        waveForecast(s.seed, s.wave + 1n).lanes.forEach((groups, lane) => {
          if (groups.some(g => g.kind === 'brute' || g.kind === 'boss')) {
            totals.zeroWeaponTankLanes++;
            if (unarmed.summary.lanes[lane].damage === 0n) totals.zeroWeaponTankHolds++;
          }
        });
      }
      if (idle) {
        totals.idleDamageByWave[wave] += Number(idle.summary.damage);
        if (result.summary.damage < idle.summary.damage) totals.lateImprovements++;
        if (idle.state.done && !idle.state.won && result.state.walls > 0n) totals.lateRescues++;
      }
      // Final-wave income cannot be spent. It is excluded from spendable gold.
      if (!result.state.done) totals.available += Number(result.state.gold - s.gold);
      totals.kills += Number(result.summary.kills); totals.retreats += Number(result.summary.retreats);
      totals.damageByWave[wave] += Number(result.summary.damage); totals.turnsByWave[wave]++;
      totals.retreatsByWave[wave] += Number(result.summary.retreats);
      s = result.state;
    }
    for (const phase of ['early', 'later'] as const) if (quarrySeen[phase]) totals.phases[phase].quarryRuns++;
    if (s.won) { totals.wins++; classify(s); totals.wallsOnWins += Number(s.walls); if (s.walls * 2n <= C.START_WALLS) totals.tensionWins++; }
  }
  return { ...totals, bosses, winPct: totals.wins / seeds * 100, actionsPerTurn: totals.actions / totals.turns,
    winningArchetypes: Object.fromEntries(Object.entries(archetypes).sort((a, b) => b[1].wins - a[1].wins)),
    distinctWinningArchetypes: Object.keys(archetypes).length,
    effectiveWinningArchetypes: Math.exp(-Object.values(archetypes).reduce((sum, b) => { const p = b.wins / totals.wins; return sum + p * Math.log(p); }, 0)),
    largestWinningArchetypePct: totals.wins ? Math.max(...Object.values(archetypes).map(b => b.wins)) / totals.wins * 100 : 0,
    spentPct: totals.spent / totals.available * 100, tensionPct: totals.wins ? totals.tensionWins / totals.wins * 100 : 0,
    meanWinWalls: totals.wins ? totals.wallsOnWins / totals.wins : 0,
    partPct: Object.fromEntries(PART_NAMES.slice(1).map((name, i) => [name, totals.parts[i + 1] / totals.occupied * 100])),
    phasePartPct: Object.fromEntries(Object.entries(totals.phases).map(([phase, data]) => [phase,
      Object.fromEntries(PART_NAMES.slice(1).map((name, i) => [name, data.parts[i + 1] / (data.occupied || 1) * 100]))])),
    meanDamageByWave: totals.damageByWave.map((v, i) => v / (totals.turnsByWave[i] || 1)) };
}
const started = performance.now(), results: Record<string, ReturnType<typeof measure>> = {};
for (const name of names) {
  if (!policies[name]) throw new Error(`Unknown bot ${name}`);
  const t = performance.now(); results[name] = measure(policies[name], name);
  console.log(name, JSON.stringify(results[name]));
  console.error(`${name}: ${((performance.now() - t) / 1000).toFixed(1)}s`);
}
let emptyLanes = 0;
for (let i = 0; i < seeds; i++) if (evaluateFight(newRun(offset + BigInt(i), 'practice')).summary.lanes.filter(l => l.damage > 0n).length >= 2) emptyLanes++;
const report = { seeds, offset: String(offset), emptyThreatPct: emptyLanes / seeds * 100, seconds: (performance.now() - started) / 1000, results };
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(report, null, 2) + '\n');
if (process.env.STATES) writeFileSync(process.env.STATES, JSON.stringify(sampledStates, (_, v) => typeof v === 'bigint' ? `${v}n` : v) + '\n');
console.log(JSON.stringify({ seeds, emptyThreatPct: report.emptyThreatPct, seconds: report.seconds }));
