import { C, PART as P, RNG } from '../../src/v1/constants.js';
import { applyAction, forecast, roll, leakDamage, partAt, shop, tierAt, type Action, type EnemyGroup, type LanePreview, type RunState, type TickFrame } from '../../src/v1/sim.js';
import { groupHp } from '../insights.js';
import { partName, statsAt } from '../parts.js';
import type { ReplayStep } from '../replay.js';

export type Phase = 'build' | 'battle' | 'summary' | 'end';
export function fightForecast(preview: readonly Pick<LanePreview, 'leaks'>[], gold: bigint): string {
  const loss = preview.reduce((n, l) => n + l.leaks, 0n), count = preview.filter(l => l.leaks).length;
  return `${count} ${count === 1 ? 'lane leaks' : 'lanes leak'} · ${loss ? `−${loss} ${loss === 1n ? 'wall' : 'walls'}` : 'no walls lost'} · ${gold}g left`;
}
export const locationOf = (cell: bigint) => `L${cell / 4n + 1n}D${cell % 4n + 1n}`;
export interface FoeSlots { slots: EnemyGroup[]; folded: EnemyGroup[] }
/** Every group owns a slot, including stacks held at a fence. */
export function foeSlots(groups: readonly EnemyGroup[]): FoeSlots {
  return { slots: [...groups].sort((a, b) => Number(a.order - b.order)), folded: [] };
}
/** Queue order names the incoming tracks and legacy recorded pop columns. */
export function assignGroupSlots(groups: readonly EnemyGroup[]): Map<bigint, number> {
  return new Map(foeSlots(groups).slots.map(g => [g.id, Number(g.order)]));
}
/** Half-height stagger fits four groups. A boss reserves a whole track above its predecessor. */
export function groupTrack(g: Pick<EnemyGroup, 'order' | 'kind'>): { column: string; row: string } {
  return { column: g.kind === 'boss' ? '1 / -1' : String(Number(g.order % 2n) + 1),
    row: String((g.kind === 'boss' ? 4 : 5) - Number(g.order)) };
}
/** All queue entries stay visible in their reserved tracks. */
export function incomingSlots(groups: readonly EnemyGroup[]): { group: EnemyGroup; folded: EnemyGroup[]; more: boolean }[] {
  return [...groups].sort((a, b) => Number(a.order - b.order)).map(group => ({ group, folded: [], more: false }));
}
export const chipText = (g: Pick<EnemyGroup, 'count' | 'hp' | 'bodyHp'>) => `${g.count}× ♥${g.count > 1n ? g.bodyHp : g.hp}`;
export function liveVerdict(leaks: bigint, groups: readonly EnemyGroup[]) {
  if (!groups.length) return { kind: 'quiet', text: 'No enemies' };
  // A forecast must never turn into a live leak verdict before wall contact.
  leaks = groups.filter(g => g.status === 'leaked').reduce((sum, g) => sum + leakDamage(g), 0n);
  const boss = groups.find(g => g.kind === 'boss');
  if (leaks) return { kind: 'leak', text: `Leaked −${leaks}` };
  if (boss?.status === 'active') return { kind: 'hold', text: 'Boss in lane' };
  if (boss?.status === 'queued') return { kind: 'hold', text: 'Boss coming' };
  if (boss?.status === 'dead' && !groups.some(g => g.status === 'queued' || g.status === 'active')) return { kind: 'clear', text: `Boss down +${boss.bounty}g` };
  return groups.some(g => g.status === 'queued' || g.status === 'active')
    ? { kind: 'hold', text: 'Holding' } : { kind: 'clear', text: 'Cleared' };
}
/** HP thresholds use the same integer leak formula as the rules. */
export function bossSavings(g: EnemyGroup): string {
  const damage = leakDamage(g);
  const threshold = [3n, 2n, 1n, 0n].map(q => g.maxHp * q / 4n).find(hp => hp < g.hp) ?? 0n;
  return g.hp ? `${g.hp} HP survives → ${damage} walls · ${g.hp - threshold} more damage saves ${threshold ? 1 : damage}` : 'Killed · no walls lost';
}
export const groupsAt = (groups: readonly EnemyGroup[], cell: bigint) => groups.filter(g =>
  g.status === 'active' && g.count > 0n && g.lane === cell / 4n && g.pos === cell % 4n + 1n);
export interface Pop { key: string; cell: bigint; slot: number; column?: string; text: string; kind: string; group?: bigint; title?: string }
/** Capture the firing layout before deaths remove chips. Never size a pop from the live DOM. */
export function popPlacement(groups: readonly EnemyGroup[], cell: bigint, group: bigint, assigned?: ReadonlyMap<bigint, number>): Pick<Pop, 'slot' | 'column'> {
  if (assigned?.has(group)) {
    const slot = assigned.get(group)!;
    return { slot, column: String(slot % 2 + 1) };
  }
  const { slots } = foeSlots(groupsAt(groups, cell));
  const index = slots.findIndex(g => g.id === group);
  const slot = Math.max(0, index < 0 ? slots.length - 1 : index);
  return { slot, column: slots.length === 1 ? '1 / -1' : String(slot + 1) };
}
/** Only actual Move events warn a part; storm bypasses add no tramples. */
export function trampleWarnings(frames: readonly Pick<TickFrame, 'tick' | 'tramples'>[]): Map<bigint, bigint> {
  const out = new Map<bigint, bigint>();
  for (const frame of frames) for (const event of frame.tramples)
    if (!out.has(event.cell) || out.get(event.cell)! > frame.tick) out.set(event.cell, frame.tick);
  return out;
}
/** Same chip receives one pop. A later event replaces its predecessor. */
export function replacePop(pops: readonly Pop[], next: Pop): Pop[] {
  return [...pops.filter(p => p.cell !== next.cell || p.slot !== next.slot), next];
}
export function biteTotals(frame: Pick<TickFrame, 'bites'>): Map<bigint, bigint> {
  const totals = new Map<bigint, bigint>();
  for (const b of frame.bites) totals.set(b.cell, (totals.get(b.cell) ?? 0n) + b.damage);
  return totals;
}
export interface HitReadout { group: bigint; cell: bigint; applied: bigint; bolt: bigint; splash: bigint; blockedBolt: bigint; blockedSplash: bigint; kills: bigint; bounty: bigint }
export function hitDamageText(hit: HitReadout, group: Pick<EnemyGroup, 'count' | 'hp' | 'bodyHp'>): string {
  if (hit.splash && !hit.bolt && group.count > 1n) {
    const damage = hit.splash - hit.blockedSplash;
    const front = damage < group.hp ? damage : group.hp;
    const body = damage < group.bodyHp ? damage : group.bodyHp;
    return front === body ? `−${body}×${group.count}` : `−${front} + ${body}×${group.count - 1n}`;
  }
  return `−${hit.applied}`;
}
export function hitReadouts(step: ReplayStep): HitReadout[] {
  return step.before.filter(g => g.status === 'active').flatMap(g => {
    const next = step.frame.groups.find(n => n.id === g.id);
    if (!next) return [];
    const bolt = step.frame.shots.filter(s => s.group === g.id).reduce((sum, s) => sum + s.damage, 0n);
    const splash = step.frame.splashes.flatMap(s => s.targets).filter(t => t.group === g.id).reduce((sum, t) => sum + t.damage, 0n);
    const mitigation = step.frame.mitigations?.find(m => m.group === g.id);
    const kill = step.frame.kills.filter(k => k.group === g.id);
    if (!bolt && !splash && !mitigation) return [];
    return [{ group: g.id, cell: g.lane * 4n + (g.pos > 4n ? 3n : g.pos - 1n),
      applied: groupHp(g) - groupHp(next), bolt, splash,
      blockedBolt: mitigation?.ballista ?? 0n, blockedSplash: mitigation?.splash ?? 0n,
      kills: kill.reduce((sum, k) => sum + k.count, 0n), bounty: kill.reduce((sum, k) => sum + k.bounty, 0n) }];
  });
}
export function tileReadout(state: RunState, cell: bigint, frame?: Pick<TickFrame, 'disabled' | 'palisades'> | null) {
  const s = statsAt(state, cell, frame?.disabled ?? 0n);
  const off = !!((frame?.disabled ?? 0n) & (1n << cell));
  const hp = frame?.palisades.find(p => p.cell === cell)?.hp ?? s.hp;
  const broken = s.part === P.PALISADE && hp === 0n;
  const pill = off ? (s.part === P.QUARRY ? '0g · Off' : 'Off')
    : s.part === P.BALLISTA ? `${s.value} dmg`
    : s.part === P.CAULDRON ? `${s.value} each`
    : s.part === P.FORGE ? `Bolt +${C.FORGE_BALLISTA * s.tier} · Splash +${C.FORGE_CAULDRON * s.tier}`
    : s.part === P.WATCHTOWER ? `Row +${C.WATCH_DAMAGE * s.tier} · Range +${C.WATCH_RANGE}`
    : s.part === P.QUARRY ? `${s.income}g/wave` : `${hp} hp`;
  return { stats: s, hp, off, broken, pill, tier: tierAt(state, cell) };
}
export function verdict(lane: Pick<LanePreview, 'leaks'>, cleared = false) {
  return { kind: lane.leaks ? 'leak' : cleared ? 'clear' : 'hold', text: lane.leaks ? `Leaks −${lane.leaks}` : cleared ? 'Cleared' : 'Holds' };
}
export function verdictPreview(before: Pick<LanePreview, 'leaks'>, after?: Pick<LanePreview, 'leaks'>) {
  const now = verdict(after ?? before);
  return { ...now, was: after && before.leaks !== after.leaks ? before.leaks ? `−${before.leaks}` : 'Holds' : null };
}
/** Survivor counts come from the resolved preview, including HP-scaled boss leaks. */
export function leakCause(groups: readonly EnemyGroup[], lane: bigint): string {
  const leaked = groups.filter(g => g.lane === lane && g.status === 'leaked');
  const boss = leaked.find(g => g.kind === 'boss');
  if (boss) return `${boss.bossPattern === 'gatebreaker' ? 'Gatebreaker' : 'Last Siege'} gets through`;
  const count = leaked.reduce((sum, g) => sum + g.count, 0n);
  if (!count) return '';
  const kind = leaked.every(g => g.kind === 'swarm') ? 'Swarm' : leaked.every(g => g.kind === 'brute') ? count === 1n ? 'Brute' : 'Brutes' : 'enemies';
  return `${count} ${kind} ${count === 1n ? 'gets' : 'get'} through`;
}
export function battleLanes(built: RunState, frame: TickFrame | null): LanePreview[] {
  const lanes = forecast(built).waves[0]?.lanes ?? [];
  return lanes.map((spawned, i) => {
    const groups = frame?.groups.filter(g => g.lane === BigInt(i)) ?? spawned;
    const leaks = groups.filter(g => g.status === 'leaked').reduce((sum, g) => sum + leakDamage(g), 0n);
    const kills = spawned.reduce((sum, g) => sum + g.count, 0n) - groups.reduce((sum, g) => sum + g.count, 0n);
    return { lane: BigInt(i), leaks, kills, retreats: 0n, result: leaks ? 'LEAKS' : 'HOLDS' };
  });
}
const actionLocation = (cell: bigint) => `L${cell / 4n + 1n} D${cell % 4n + 1n}`;
export function actionLabel(action: Action, before: RunState): string {
  if (action.type === 'reroll') return `Reroll supply · ${before.rerolls + 1n}g`;
  if (action.type === 'buy') return `Buy ${partName(shop(before)[Number(action.slot)].part)} at ${actionLocation(action.cell)}`;
  return `${action.type === 'upgrade' ? `Upgrade ${partName(partAt(before, action.cell))} to tier ${tierAt(before, action.cell) + 1n}` : action.type === 'sell' ? `Sell ${partName(partAt(before, action.cell))}` : `Overclock ${partName(partAt(before, action.cell))}`} at ${actionLocation(action.cell)}`;
}
export function actionRows(start: RunState, actions: readonly Action[]) {
  let state = start;
  const all = actions.map((a, i) => { const row = { number: i + 1, part: a.type === 'reroll' ? 0n : a.type === 'buy' ? shop(state)[Number(a.slot)].part : partAt(state, a.cell), text: actionLabel(a, state) }; state = applyAction(state, a); return row; });
  return { all, recent: all.length <= 3 ? all : all.slice(-2), more: all.length <= 3 ? 0 : all.length - 2 };
}
export const incomingTick = (tick: bigint) => `◷${tick}`;
export function scoreRows(state: RunState) {
  const waves = state.walls > 0n ? state.wave : state.wave > 0n ? state.wave - 1n : 0n;
  return [{ label: 'Waves survived', count: waves, weight: C.SCORE_WAVE, points: waves * C.SCORE_WAVE },
    { label: 'Walls left', count: state.walls, weight: C.SCORE_WALL, points: state.walls * C.SCORE_WALL },
    { label: 'Kills', count: state.totalKills, weight: C.SCORE_KILL, points: state.totalKills * C.SCORE_KILL }];
}
export const payout = (s: { income: bigint; clear: bigint; quarry: bigint; bounty: bigint; salvage: bigint }) => s.income + s.clear + s.quarry + s.bounty + s.salvage;

/** Shared quiet state for an entrance and its wall; empty lanes earn no clear gold. */
export function incomingQuiet(hasEnemies: boolean, _settled = false): string {
  return hasEnemies ? 'All entered' : 'No enemies';
}

export const heavyLane = (state: RunState): bigint | null => state.wave + 1n >= C.BRUTE_FROM ? (roll(state.seed, state.wave + 1n, RNG.ENEMY_SALT) >> 40n) & 3n : null;

export const CHIP_KEY = '◷ arrival tick · 2×♥2 = 2 units, 2 HP each';
