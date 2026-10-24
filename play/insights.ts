import { LIMITS as L, PART as P } from '../src/v1/constants.js';
import { fight, forecast, partAt, leakDamage, type EnemyGroup, type FightResult, type RunState } from '../src/v1/sim.js';
import { isWeapon, partName, statsAt } from './parts.js';
import { isStorm, type ReplayStep } from './replay.js';
import { plural } from './copy.js';

export const groupHp = (g: EnemyGroup): bigint => g.count ? g.hp + (g.count - 1n) * g.bodyHp : 0n;
export const enemyNumbers = (g: EnemyGroup): string =>
  `${g.count} ${plural(g.count, 'unit')} · ${g.count > 1n ? g.bodyHp : g.hp} HP each · ${groupHp(g)} HP total${g.hp !== g.bodyHp ? ` · front ♥${g.hp}` : ''}`;
export const enemyDetails = (g: EnemyGroup): string => {
  const name = g.kind === 'boss' ? g.bossPattern === 'gatebreaker' ? 'Gatebreaker' : 'Last Siege'
    : g.kind === 'brute' ? plural(g.count, 'Brute') : 'Swarm';
  return `${g.count} ${name} · ${g.count > 1n ? g.bodyHp : g.hp} HP each${g.count > 1n && g.hp < g.bodyHp ? ` · front unit ${g.hp} of ${g.bodyHp} HP` : ''} · bite ${g.bite}${g.bossPattern === 'gatebreaker' ? ' (even ticks only)' : ''} · leak ${leakDamage(g) / (g.count || 1n)} · armour ${g.splashArmor ?? 0n}`;
};

/** Repeated hover and inspector renders share immutable simulation results. */
export class InvestmentCache {
  private readonly entries = new Map<string, readonly FightResult[]>();
  compare(before: RunState, after: RunState) {
    const metrics = (state: RunState) => {
      const result = this.project(state)[0];
      return { gold: state.gold, actions: state.actionsUsed,
        walls: result ? state.walls - result.state.walls : 0n,
        boss: result ? survivingBossHp(result) : null,
        income: result ? result.state.gold - state.gold : 0n };
    };
    return { before: metrics(before), after: metrics(after) };
  }
  project(state: RunState): readonly FightResult[] {
    const key = JSON.stringify(state, (_, v: unknown) => typeof v === 'bigint' ? String(v) : v);
    const saved = this.entries.get(key);
    if (saved) return saved;
    const results: FightResult[] = [];
    let next = { ...state };
    for (const wave of forecast(next, 3).waves) {
      if (next.done || wave.wave > BigInt(L.WAVES)) break;
      const result = fight({ ...next });
      results.push(result); next = { ...result.state };
    }
    if (this.entries.size >= 80) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, results);
    return results;
  }
}

export interface Cause { tick: bigint; phase: 'Fire' | 'Bite' | 'Move' | 'Storm' | 'Result'; text: string; kind: 'trample' | 'break' | 'hit' | 'mitigation' | 'leak' | 'held'; group?: bigint }
const cellLabel = (cell: bigint) => `L${cell / 4n + 1n} D${cell % 4n + 1n}`;

/** Explain only events present in the frames, including support lost in another lane. */
export function laneCauses(built: RunState, timeline: readonly ReplayStep[], lane: bigint, group?: bigint): Cause[] {
  const causes: Cause[] = [];
  let disabled = 0n;
  const boss = forecast(built).waves[0]?.boss?.name ?? 'Boss';
  const lastTick = group === undefined ? BigInt(L.TICKS)
    : timeline.find(s => s.frame.leaks.some(e => e.group === group))?.frame.tick ?? BigInt(L.TICKS);
  for (const step of timeline) {
    const f = step.frame;
    if (f.tick > lastTick) break;
    for (const mitigation of f.mitigations ?? []) {
      const g = f.groups.find(g => g.id === mitigation.group);
      if (!g || g.lane !== lane || (group !== undefined && group !== g.id)) continue;
      causes.push({ tick: f.tick, phase: 'Fire', kind: 'mitigation', group: g.id, text: mitigation.ballista
        ? `${boss} shield blocked ${mitigation.ballista} pooled Ballista damage; splash stayed full`
        : `Brute armor blocked ${mitigation.splash} pooled splash damage per unit` });
    }
    for (const trample of f.tramples) {
      const after = disabled | (1n << trample.cell);
      const changes: string[] = [];
      for (let d = 0n; d < BigInt(L.DEPTHS); d++) {
        const cell = lane * BigInt(L.DEPTHS) + d;
        if (!isWeapon(partAt(built, cell)) || (disabled & (1n << cell))) continue;
        const prior = statsAt(built, cell, disabled), next = statsAt(built, cell, after);
        if (cell === trample.cell) changes.push(`${partName(prior.part)} ${prior.value} to 0 damage`);
        else if (prior.value !== next.value || prior.low !== next.low || prior.high !== next.high)
          changes.push(`${partName(prior.part)} ${prior.value} to ${next.value} damage${prior.low !== next.low || prior.high !== next.high ? ', range shrinks' : ''}`);
      }
      if (trample.cell / BigInt(L.DEPTHS) === lane || changes.length)
        causes.push({ tick: f.tick, phase: 'Move', kind: 'trample', text: `${partName(trample.part)} trampled at ${cellLabel(trample.cell)}${f.shots.some(s => s.from === trample.cell) || f.splashes.some(s => s.from === trample.cell) ? ' (after its last shot)' : ''}${changes.length ? `; ${changes.join('; ')}` : '; disabled this wave'}` });
      disabled = after;
    }
    for (const p of f.palisades) if (p.cell / BigInt(L.DEPTHS) === lane && p.hp === 0n
      && f.bites.some(b => b.cell === p.cell)) {
      const previous = timeline[Number(f.tick) - 2]?.frame.palisades.find(v => v.cell === p.cell)?.hp;
      if (previous !== 0n) causes.push({ tick: f.tick, phase: 'Bite', kind: 'break', text: `Palisade breaks at ${cellLabel(p.cell)}; lane opens` });
    }
    for (const leak of f.leaks.filter(e => e.lane === lane && (group === undefined || e.group === group))) {
      const g = f.groups.find(e => e.id === leak.group)!;
      causes.push({ tick: f.tick, phase: isStorm(step, g.id) ? 'Storm' : 'Move', kind: 'leak', group: g.id,
        text: `${g.kind === 'boss' ? boss : g.kind === 'swarm' ? 'Swarm' : 'Brute'}: ${groupHp(g)}/${g.count * g.maxHp} survivor HP left; ${isStorm(step, g.id)
          ? `final storm${f.palisades.some(p => p.hp > 0n && p.cell / BigInt(L.DEPTHS) === lane && p.cell % BigInt(L.DEPTHS) < (step.before.find(g => g.id === leak.group)?.pos ?? 0n) - 1n) ? ' past a standing Palisade' : ' at the deadline'}`
          : 'normal leak: reached the wall'}; −${leak.damage} ${plural(leak.damage, 'wall')}` });
    }
  }
  if (!causes.some(c => c.kind === 'leak')) {
    const kills = timeline.flatMap(s => s.frame.kills.filter(k => k.lane === lane).map(k => ({ tick: s.frame.tick, count: k.count })));
    const count = kills.reduce((sum, k) => sum + k.count, 0n);
    causes.push({ tick: kills.at(-1)?.tick ?? BigInt(L.TICKS), phase: 'Result', kind: 'held', text: count ? `${count} ${plural(count, 'enemy', 'enemies')} killed; no walls lost` : 'No walls lost' });
  }
  // Report the last damaging volley for each leaker, using applied HP loss, not nominal firepower.
  const leaks = causes.filter(c => c.kind === 'leak');
  for (const leak of leaks) {
    let hit: Cause | undefined;
    for (const step of timeline) {
      if (step.frame.tick > leak.tick) break;
      const prior = step.before.find(g => g.id === leak.group);
      const next = step.frame.groups.find(g => g.id === leak.group);
      if (!prior || !next || prior.status !== 'active') continue;
      const applied = groupHp(prior) - groupHp(next);
      if (applied <= 0n) continue;
      const sources = [...step.frame.shots.filter(s => s.group === leak.group).map(s => `Ballista at ${cellLabel(s.from)}`),
        ...step.frame.splashes.filter(s => s.targets.some(t => t.group === leak.group && t.damage > 0n)).map(s => `Cauldron at ${cellLabel(s.from)}`)];
      hit = { tick: step.frame.tick, phase: 'Fire', kind: 'hit', group: leak.group,
        text: `Last damaging hit: ${sources.join(' + ')} dealt ${applied} HP; ${next.kind === 'boss' ? boss : next.kind === 'brute' ? 'Brute' : 'Swarm'} remains at ${groupHp(next)} HP` };
    }
    causes.push(hit ?? { tick: leak.tick, phase: 'Fire', kind: 'hit', group: leak.group, text: 'No damaging hit: this survivor reached the wall untouched' });
  }
  const order: Record<Cause['kind'], number> = { mitigation: 0, hit: 1, break: 2, trample: 3, leak: 4, held: 5 };
  return causes.sort((a, b) => Number(a.tick - b.tick) || order[a.kind] - order[b.kind]);
}

export function replayStart(timeline: readonly ReplayStep[], causes: readonly Cause[]): number {
  const event = causes.find(c => c.kind === 'trample' || c.kind === 'break' || c.kind === 'hit' || c.kind === 'mitigation') ?? causes.find(c => c.kind === 'leak');
  return Math.max(0, timeline.findIndex(s => s.frame.tick === (event?.tick ?? 1n)));
}

/** Boss progress remains visible even when the wall-loss forecast has not changed. */
export function survivingBossHp(result: FightResult): bigint | null {
  const bosses = result.frames.at(-1)?.groups.filter(g => g.kind === 'boss');
  return bosses?.length ? bosses.reduce((sum, g) => sum + groupHp(g), 0n) : null;
}
