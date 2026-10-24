import { C, LIMITS as L, PART as P } from '../src/v1/constants.js';
import { applyAction, leakDamage, partAt, tierAt, type Action, type EnemyGroup, type FightResult, type RunState, type WaveForecast } from '../src/v1/sim.js';
import { actionReason } from './queue.js';
import { isWeapon, statsAt } from './parts.js';
import { plural } from './copy.js';

export function bossPattern(boss: NonNullable<WaveForecast['boss']>, tick?: bigint): string {
  const even = tick !== undefined && tick % 2n === 0n;
  if (boss.pattern === 'gatebreaker') return tick === undefined
    ? `Bites ${boss.biteEven} on even ticks, rests on odd ticks`
    : even ? `Even tick: boss bites ${boss.biteEven}` : 'Odd tick: boss rests';
  const divisor = even ? boss.ballistaDivisorEven : boss.ballistaDivisorOdd;
  return tick === undefined
    ? `Even ticks: Ballista ÷${boss.ballistaDivisorEven} · splash full`
    : `${even ? 'EVEN' : 'ODD'}: ${divisor > 1n ? `÷${divisor} bolts` : 'Full bolts'}`;
}

export function bossLeakThresholds(group: EnemyGroup): string {
  return Array.from({ length: Number(C.BOSS_LEAK_HP) - 1 }, (_, i) => {
    const step = BigInt(i + 1);
    const damage = leakDamage({ ...group, count: 1n, hp: step, maxHp: C.BOSS_LEAK_HP });
    return `${step * 100n / C.BOSS_LEAK_HP}% HP: −${damage} ${plural(damage, 'wall')}`;
  }).join(' · ');
}

export function overclockOption(state: RunState, cell: bigint): { gain: bigint; hp: boolean; reason: string; charged: boolean } {
  const part = partAt(state, cell), charged = !!((state.overclocked ?? 0n) & (1n << cell));
  const current = statsAt(state, cell);
  const boosted = statsAt({ ...state, overclocked: (state.overclocked ?? 0n) | (1n << cell) }, cell);
  let reason = '';
  try { applyAction(state, { type: 'overclock', cell }); }
  catch (error) { reason = actionReason(error); }
  return { gain: part === P.PALISADE ? boosted.hp - current.hp : boosted.value - current.value,
    hp: part === P.PALISADE, reason, charged };
}

/** Each line comes from the resolved frames. Deep gold is a subset of quarry gold. */
export function mechanicRecap(built: RunState, result: Pick<FightResult, 'frames' | 'summary'>, actions?: readonly Action[]): string[] {
  const lines: string[] = [];
  const mitigations = result.frames.flatMap(f => f.mitigations ?? []);
  const bolts = mitigations.reduce((sum, m) => sum + m.ballista, 0n);
  const splash = mitigations.reduce((sum, m) => sum + m.splash, 0n);
  if (bolts || splash) lines.push(`${bolts ? `Shield blocked ${bolts} bolt damage` : ''}${bolts && splash ? ' · ' : ''}${splash ? `Armor blocked ${splash} pooled splash/unit` : ''}`);
  for (const boss of result.frames.at(-1)?.groups.filter(g => g.kind === 'boss') ?? []) {
    const damage = leakDamage(boss);
    lines.push(boss.count ? `Boss ${boss.hp}/${boss.maxHp} HP: −${damage} ${plural(damage, 'wall')} (${boss.leak - damage} saved by chipping)` : 'Boss destroyed: no boss wall damage');
  }
  const cells = Array.from({ length: L.CELLS }, (_, i) => BigInt(i))
    .filter(cell => !!((built.overclocked ?? 0n) & (1n << cell)));
  const purchased = actions?.filter(a => a.type === 'overclock').length ?? cells.length;
  if (purchased) lines.push(`Overclock: ${cells.length} charged · ${BigInt(purchased) * C.OVERCLOCK_COST}g spent · expired`);
  if (result.summary.quarry || result.summary.deepQuarry || result.frames.some(f => f.tramples.some(t => t.part === P.QUARRY)))
    lines.push(`Quarry +${result.summary.quarry}g, includes +${result.summary.deepQuarry ?? 0n}g deep bonus`);
  return lines;
}

export function overclockBenefit(state: RunState, cell: bigint): string {
  const option = overclockOption(state, cell);
  if (option.charged) return 'Overclock charged · this wave';
  return `Overclock ${C.OVERCLOCK_COST}g${tierAt(state, cell) === BigInt(L.TIERS) && (isWeapon(partAt(state, cell)) || option.hp)
    ? `: +${option.gain} ${option.hp ? 'HP' : 'dmg'} this wave` : ''}`;
}
