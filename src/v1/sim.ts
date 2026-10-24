import { C, LIMITS as L, PART as P, PRICE, RNG } from './constants.js';

export const U64_MAX = (1n << 64n) - 1n;
export class RuleError extends Error { override name = 'RuleError'; }
export function u64(v: bigint): bigint {
  if (typeof v !== 'bigint' || v < 0n || v > U64_MAX) throw new RuleError(`u64 out of range: ${v}`);
  return v;
}
export const add = (a: bigint, b: bigint) => u64(u64(a) + u64(b));
export const sub = (a: bigint, b: bigint) => u64(u64(a) - u64(b));
export const mul = (a: bigint, b: bigint) => u64(u64(a) * u64(b));
export function div(a: bigint, b: bigint): bigint {
  u64(a); u64(b);
  if (b === 0n) throw new RuleError('division by zero');
  return a / b;
}
const min = (a: bigint, b: bigint) => a < b ? a : b;
const max = (a: bigint, b: bigint) => a > b ? a : b;
const cut = (a: bigint, b: bigint) => sub(a, min(a, b));
function index(v: bigint, length: number): number {
  u64(v);
  if (v >= BigInt(length)) throw new RuleError('index out of range');
  return Number(v);
}
export type Mode = 'daily' | 'practice';
export type EnemyKind = 'swarm' | 'brute' | 'boss';
export type BossPattern = 'gatebreaker' | 'last-siege';
export type GroupStatus = 'queued' | 'active' | 'dead' | 'leaked' | 'retreated';
export interface RunState {
  seed: bigint; mode: Mode; wave: bigint; walls: bigint; gold: bigint;
  parts: bigint; tiers: bigint; score: bigint; totalKills: bigint;
  rerolls: bigint; bought: bigint; actionsUsed: bigint; done: boolean; won: boolean;
  /** Current-wave cell mask. Omitted by older clients means zero. */
  overclocked?: bigint;
}
export type Action = { type: 'buy'; slot: bigint; cell: bigint }
  | { type: 'upgrade' | 'sell' | 'overclock'; cell: bigint } | { type: 'reroll' };
export interface Offer { slot: bigint; part: bigint; price: bigint; available: boolean }
export interface EnemyGroup {
  id: bigint; lane: bigint; order: bigint; kind: EnemyKind; spawnTick: bigint;
  count: bigint; hp: bigint; bodyHp: bigint; maxHp: bigint; pos: bigint;
  bite: bigint; leak: bigint; bounty: bigint; status: GroupStatus;
  bossPattern?: BossPattern;
  splashArmor?: bigint;
}
export interface WaveForecast { wave: bigint; lanes: EnemyGroup[][]; boss: {
  name: string; lane: bigint; hp: bigint; pattern: BossPattern;
  biteEven: bigint; biteOdd: bigint; ballistaDivisorEven: bigint; ballistaDivisorOdd: bigint;
  leakMin: bigint; leakMax: bigint;
} | null }
export interface Forecast { waves: WaveForecast[]; bosses: WaveForecast[] }
export interface Shot { from: bigint; group: bigint; damage: bigint }
export interface Splash { from: bigint; targets: { group: bigint; count: bigint; damage: bigint }[] }
export interface Bite { group: bigint; cell: bigint; damage: bigint }
export interface Trample { group: bigint; cell: bigint; part: bigint }
export interface Leak { group: bigint; lane: bigint; count: bigint; damage: bigint }
export interface Kill { group: bigint; lane: bigint; count: bigint; bounty: bigint }
export interface Retreat { group: bigint; lane: bigint; count: bigint }
export interface GoldEvent { reason: 'bounty' | 'income' | 'clear' | 'quarry' | 'salvage'; amount: bigint; source: bigint | null }
export interface TickFrame {
  tick: bigint; groups: EnemyGroup[]; shots: Shot[]; splashes: Splash[]; bites: Bite[];
  palisades: { cell: bigint; hp: bigint }[]; tramples: Trample[]; leaks: Leak[];
  kills: Kill[]; retreats: Retreat[]; goldEvents: GoldEvent[];
  disabled: bigint; walls: bigint; gold: bigint;
  /** Damage removed from the nominal pooled attacks before HP resolution. */
  mitigations?: { group: bigint; ballista: bigint; splash: bigint }[];
}
export interface LaneSummary { spawned: bigint; kills: bigint; leaks: bigint; damage: bigint; retreats: bigint }
export interface Summary {
  wave: bigint; lanes: LaneSummary[]; kills: bigint; damage: bigint; retreats: bigint;
  bounty: bigint; income: bigint; quarry: bigint; clear: bigint; salvage: bigint;
  /** Included in quarry, not a second payout. */
  deepQuarry?: bigint;
}
export interface FightResult { state: RunState; frames: TickFrame[]; summary: Summary }
export interface LanePreview { lane: bigint; result: 'HOLDS' | 'LEAKS'; leaks: bigint; kills: bigint; retreats: bigint }
export interface TurnEvent {
  tag: 'SGV1'; seed: bigint; expectedWave: bigint; actions: bigint;
  before: bigint[]; after: bigint[]; lanes: LaneSummary[];
}

export function xorshift(value: bigint): bigint {
  let x = u64(value);
  x ^= (x & ((1n << 51n) - 1n)) << 13n;
  x ^= x >> 7n;
  x ^= (x & ((1n << 47n) - 1n)) << 17n;
  return u64(x);
}
/** XOR the full seed instead of multiplying it: every u64 practice seed is legal. */
export function roll(seed: bigint, wave: bigint, salt: bigint, rerolls = 0n): bigint {
  return xorshift(xorshift(u64(seed) ^ RNG.BASE ^ add(add(mul(wave, RNG.WAVE), salt), mul(rerolls, RNG.REROLL))));
}
export const utcDay = (unixSeconds: bigint) => div(unixSeconds, 86400n);
export function newRun(seed: bigint, mode: Mode): RunState {
  u64(seed);
  if (mode !== 'daily' && mode !== 'practice') throw new RuleError('invalid mode');
  return { seed, mode, wave: 0n, walls: C.START_WALLS, gold: C.START_GOLD,
    parts: 0n, tiers: 0n, score: 0n, totalKills: 0n, rerolls: 0n, bought: 0n,
    actionsUsed: 0n, done: false, won: false, overclocked: 0n };
}
export function partAt(state: Pick<RunState, 'parts'>, cell: bigint): bigint {
  index(cell, L.CELLS); return (u64(state.parts) >> (cell * 4n)) & 15n;
}
export function tierAt(state: Pick<RunState, 'tiers'>, cell: bigint): bigint {
  index(cell, L.CELLS); return (u64(state.tiers) >> (cell * 2n)) & 3n;
}
export const cellOf = (lane: bigint, depth: bigint) => {
  index(lane, L.LANES);
  if (depth < 1n || depth > BigInt(L.DEPTHS)) throw new RuleError('bad depth');
  return add(mul(lane, BigInt(L.DEPTHS)), sub(depth, 1n));
};
export function withPart(state: RunState, cell: bigint, part: bigint, tier: bigint): RunState {
  index(cell, L.CELLS); index(part, PRICE.length); u64(tier); u64(state.parts); u64(state.tiers);
  if (tier < 0n || tier > BigInt(L.TIERS) || (part === 0n) !== (tier === 0n)) throw new RuleError('bad tier');
  const ps = cell * 4n, ts = cell * 2n;
  return { ...state, parts: (state.parts & (U64_MAX ^ (15n << ps))) | (part << ps),
    tiers: (state.tiers & (U64_MAX ^ (3n << ts))) | (tier << ts),
    overclocked: partAt(state, cell) === part && tier === 3n ? state.overclocked ?? 0n
      : (state.overclocked ?? 0n) & (U64_MAX ^ (1n << cell)) };
}
export function neighbors(cell: bigint): bigint[] {
  index(cell, L.CELLS);
  const lane = cell / 4n, row = cell % 4n, out: bigint[] = [];
  if (row > 0n) out.push(cell - 1n);
  if (row < 3n) out.push(cell + 1n);
  if (lane > 0n) out.push(cell - 4n);
  if (lane < 3n) out.push(cell + 4n);
  return out;
}
export function validateState(s: RunState): void {
  for (const k of ['seed', 'wave', 'walls', 'gold', 'parts', 'tiers', 'score', 'totalKills', 'rerolls', 'bought', 'actionsUsed'] as const) u64(s[k]);
  const overclocked = u64(s.overclocked ?? 0n);
  if (overclocked >> 16n || (s.done && overclocked !== 0n) || (s.mode !== 'daily' && s.mode !== 'practice') || typeof s.done !== 'boolean' || typeof s.won !== 'boolean'
    || s.wave > BigInt(L.WAVES) || s.walls > C.START_WALLS || s.tiers >> 32n || s.bought > 15n
    || s.rerolls > BigInt(L.ACTIONS) || s.actionsUsed > BigInt(L.ACTIONS) || s.rerolls > s.actionsUsed
    || s.totalKills > 4095n || s.done !== (s.walls === 0n || s.wave === BigInt(L.WAVES))
    || s.won !== (s.walls > 0n && s.wave === BigInt(L.WAVES))) throw new RuleError('invalid state');
  for (let i = 0n; i < BigInt(L.CELLS); i++) {
    const p = partAt(s, i), t = tierAt(s, i);
    if (p > P.QUARRY || (p === 0n) !== (t === 0n)) throw new RuleError('invalid board');
    if ((overclocked & (1n << i)) !== 0n && (t !== 3n || p < P.BALLISTA || p > P.PALISADE)) throw new RuleError('invalid overclock');
  }
}
export function shop(s: RunState): Offer[] {
  validateState(s);
  let x = roll(s.seed, add(s.wave, 1n), RNG.SHOP_SALT, s.rerolls);
  const firstWeapon = roll(s.seed, add(s.wave, 1n), RNG.SHOP_SALT) & 1n;
  const weapon = add(1n, firstWeapon ^ (s.rerolls & 1n));
  const deck = [1n, 2n, 3n, 4n, 5n, 6n].filter(p => p !== weapon);
  for (let k = deck.length - 1; k > 0; k--) {
    x = xorshift(x); const j = Number(x % BigInt(k + 1));
    [deck[k], deck[j]] = [deck[j], deck[k]];
  }
  // Two opening threats can both be killed for 10g, without discovering rerolls.
  const parts = s.wave === 0n && s.rerolls === 0n
    ? [weapon, weapon === P.BALLISTA ? P.CAULDRON : P.BALLISTA, P.PALISADE,
      deck.find(p => p >= P.FORGE)!]
    : [weapon, ...deck.slice(0, L.SHOP_SLOTS - 1)];
  return parts.map((p, k) => {
    const slot = BigInt(k);
    return { slot, part: p, price: PRICE[Number(p)], available: (s.bought & (1n << slot)) === 0n };
  });
}
export function upgradeCost(part: bigint, tier: bigint): bigint {
  index(part, PRICE.length); u64(tier);
  if (part === 0n || tier < 1n || tier >= BigInt(L.TIERS)) throw new RuleError('cannot upgrade');
  return tier === 1n ? PRICE[Number(part)] : div(mul(PRICE[Number(part)], C.UPGRADE_3_NUM), C.UPGRADE_3_DEN);
}
export function sellValue(part: bigint, tier: bigint): bigint {
  index(part, PRICE.length); u64(tier);
  if (part === 0n || tier < 1n || tier > BigInt(L.TIERS)) throw new RuleError('cannot sell');
  let paid: bigint = PRICE[Number(part)];
  if (tier >= 2n) paid = add(paid, upgradeCost(part, 1n));
  if (tier >= 3n) paid = add(paid, upgradeCost(part, 2n));
  return div(paid, 2n);
}
export function applyAction(state: RunState, action: Action): RunState {
  validateState(state);
  if (state.done) throw new RuleError('run is over');
  if (state.actionsUsed >= BigInt(L.ACTIONS)) throw new RuleError('too many actions');
  let s = { ...state, actionsUsed: add(state.actionsUsed, 1n) };
  let cost = 0n;
  switch (action.type) {
    case 'reroll': cost = add(s.rerolls, 1n); s.rerolls = cost; s.bought = 0n; break;
    case 'buy': {
      index(action.slot, L.SHOP_SLOTS); index(action.cell, L.CELLS);
      const offer = shop(state)[Number(action.slot)];
      if (!offer.available) throw new RuleError('offer sold');
      if (partAt(s, action.cell) !== 0n) throw new RuleError('cell occupied');
      cost = offer.price;
      s = withPart(s, action.cell, offer.part, 1n);
      s.bought |= 1n << action.slot;
      break;
    }
    case 'upgrade': {
      const p = partAt(s, action.cell), t = tierAt(s, action.cell);
      cost = upgradeCost(p, t); s = withPart(s, action.cell, p, add(t, 1n)); break;
    }
    case 'sell': {
      const refund = sellValue(partAt(s, action.cell), tierAt(s, action.cell));
      s = withPart(s, action.cell, 0n, 0n); s.gold = add(s.gold, refund);
      s.overclocked = (s.overclocked ?? 0n) & (U64_MAX ^ (1n << action.cell)); break;
    }
    case 'overclock': {
      const p = partAt(s, action.cell), t = tierAt(s, action.cell), bit = 1n << action.cell;
      if (t !== 3n || p < P.BALLISTA || p > P.PALISADE) throw new RuleError('overclock needs tier-three weapon or Palisade');
      if (((s.overclocked ?? 0n) & bit) !== 0n) throw new RuleError('already overclocked');
      cost = C.OVERCLOCK_COST; s.overclocked = (s.overclocked ?? 0n) | bit; break;
    }
    default: throw new RuleError('unknown action');
  }
  if (cost > s.gold) throw new RuleError('not enough gold');
  s.gold = sub(s.gold, cost);
  return s;
}

function makeGroup(wave: bigint, lane: bigint, order: bigint, kind: EnemyKind, count: bigint, leader: boolean): EnemyGroup {
  const escalation = cut(add(wave, 1n), C.LATE_FROM);
  const baseHp = kind === 'swarm' ? add(C.SWARM_HP, div(wave, C.SWARM_HP_STEP))
    : kind === 'brute' ? add(C.BRUTE_HP, div(mul(wave, C.BRUTE_HP_WAVE), C.BRUTE_HP_DIV))
    : wave === 5n ? C.BOSS_5_HP : C.BOSS_10_HP;
  const step = add(C.LATE_BRUTE_HP_STEP, leader ? C.LATE_LEADER_HP_STEP : 0n);
  const hp = kind === 'brute' ? add(baseHp, mul(escalation, step)) : baseHp;
  if (hp >= 1n << BigInt(L.HP_BITS) || count >= 1n << BigInt(L.COUNT_BITS)) throw new RuleError('group width exceeded');
  return { id: add(mul(lane, BigInt(L.GROUPS_PER_LANE)), order), lane, order, kind,
    spawnTick: add(order, 1n), count, hp, bodyHp: hp, maxHp: hp, pos: 0n, status: 'queued',
    bite: kind === 'swarm' ? C.SWARM_BITE : kind === 'brute' ? C.BRUTE_BITE : C.BOSS_BITE,
    leak: kind === 'swarm' ? C.SWARM_LEAK : kind === 'brute' ? C.BRUTE_LEAK : C.BOSS_LEAK,
    bounty: kind === 'swarm' ? C.SWARM_BOUNTY : kind === 'brute' ? C.BRUTE_BOUNTY : C.BOSS_BOUNTY,
    splashArmor: kind === 'brute' ? C.BRUTE_SPLASH_ARMOR : 0n,
    ...(kind === 'boss' ? { bossPattern: wave === 5n ? 'gatebreaker' as const : 'last-siege' as const } : {}) };
}
export function waveForecast(seed: bigint, wave: bigint): WaveForecast {
  u64(seed);
  if (wave < 1n || wave > BigInt(L.WAVES)) throw new RuleError('bad wave');
  const y = roll(seed, wave, RNG.ENEMY_SALT), heavy = (y >> 40n) & 3n;
  const bossLane = (y >> 48n) & 3n;
  const lanes: EnemyGroup[][] = [];
  for (let lane = 0n; lane < BigInt(L.LANES); lane++) {
    if (wave === 1n && lane !== 0n && lane !== add(1n, heavy % 3n)) { lanes.push([]); continue; }
    const b = (y >> (lane * 8n)) & 255n;
    const count = add(add(C.SWARM_BASE, div(wave, C.SWARM_GROWTH_DIV)), b % C.SWARM_SPREAD);
    const kinds: [EnemyKind, bigint][] = [['swarm', count]];
    if (wave >= C.BRUTE_FROM && (lane === heavy || wave >= C.BRUTE_ALL_FROM)) kinds.push(['brute', add(1n, lane === heavy && wave >= C.HEAVY_BRUTE_FROM ? 1n : 0n)]);
    if (wave >= C.THIRD_GROUP_FROM) kinds.push(['swarm', add(count, lane === heavy ? 1n : 0n)]);
    if (wave >= C.FOURTH_GROUP_FROM) kinds.push(['brute', 1n]);
    if (kinds.length > L.GROUPS_PER_LANE) kinds.length = L.GROUPS_PER_LANE;
    if ((wave === 5n || wave === 10n) && lane === bossLane) {
      // Replace the last group if full; boss is always the last arrival.
      if (kinds.length === L.GROUPS_PER_LANE) kinds.pop();
      kinds.push(['boss', 1n]);
    }
    lanes.push(kinds.map(([kind, n], k) => makeGroup(wave, lane, BigInt(k), kind, n, lane === heavy)));
  }
  const boss = (wave === 5n || wave === 10n) ? { name: wave === 5n ? 'Gatebreaker' : 'Last Siege', lane: bossLane,
    hp: lanes[Number(bossLane)].find(g => g.kind === 'boss')!.maxHp,
    pattern: wave === 5n ? 'gatebreaker' as const : 'last-siege' as const,
    biteEven: wave === 5n ? C.GATEBREAKER_BITE_EVEN : C.BOSS_BITE,
    biteOdd: wave === 5n ? C.GATEBREAKER_BITE_ODD : C.BOSS_BITE,
    ballistaDivisorEven: wave === 10n ? C.LAST_SIEGE_BOLT_DIVISOR : 1n, ballistaDivisorOdd: 1n,
    leakMin: add(C.BOSS_LEAK_BASE, 1n), leakMax: add(C.BOSS_LEAK_BASE, C.BOSS_LEAK_HP) } : null;
  return { wave, lanes, boss };
}
/** Count includes the upcoming wave; bosses remain visible even outside that horizon. */
export function forecast(s: RunState, waves = 3): Forecast {
  validateState(s);
  if (!Number.isInteger(waves) || waves < 0 || waves > L.WAVES) throw new RuleError('bad forecast horizon');
  const out: WaveForecast[] = [];
  for (let k = 1; k <= waves && s.wave + BigInt(k) <= BigInt(L.WAVES); k++) out.push(waveForecast(s.seed, s.wave + BigInt(k)));
  return { waves: out, bosses: [5n, 10n].filter(w => w > s.wave).map(w => waveForecast(s.seed, w)) };
}

interface CellStats { part: bigint; tier: bigint; lane: bigint; depth: bigint; forge: bigint; watch: bigint; overclocked: boolean }
function cellStats(s: RunState, disabled: bigint): CellStats[] {
  const active = (i: bigint) => (disabled & (1n << i)) === 0n;
  const watch = [0n, 0n, 0n, 0n];
  for (let i = 0n; i < 16n; i++) if (active(i) && partAt(s, i) === P.WATCHTOWER) watch[Number(i % 4n)] = max(watch[Number(i % 4n)], tierAt(s, i));
  return Array.from({ length: L.CELLS }, (_, j) => {
    const i = BigInt(j), part = active(i) ? partAt(s, i) : 0n;
    let forge = 0n;
    if (part === P.BALLISTA || part === P.CAULDRON) for (const n of neighbors(i)) {
      if (active(n) && partAt(s, n) === P.FORGE) forge = add(forge, tierAt(s, n));
    }
    return { part, tier: tierAt(s, i), lane: i / 4n, depth: add(i % 4n, 1n), forge, watch: watch[j % 4],
      overclocked: ((s.overclocked ?? 0n) & (1n << i)) !== 0n };
  });
}

/** Requested wall damage, for ordinary movement and the final storm alike. */
export function leakDamage(g: EnemyGroup): bigint {
  const scaled = add(C.BOSS_LEAK_BASE, div(add(mul(C.BOSS_LEAK_HP, g.hp), cut(g.maxHp, 1n)), max(g.maxHp, 1n)));
  return mul(g.count, g.kind === 'boss' ? scaled : g.leak);
}

/** Same combat kernel for preview, search and traced playback. No alternate numeric rules. */
function resolve(state: RunState, trace: boolean): FightResult {
  validateState(state);
  if (state.done) throw new RuleError('run is over');
  const wave = add(state.wave, 1n), incoming = waveForecast(state.seed, wave);
  const groups = incoming.lanes.flat().map(g => ({ ...g }));
  const lanes: LaneSummary[] = incoming.lanes.map(gs => ({ spawned: gs.reduce((a, g) => add(a, g.count), 0n), kills: 0n, leaks: 0n, damage: 0n, retreats: 0n }));
  const summary: Summary = { wave, lanes, kills: 0n, damage: 0n, retreats: 0n, bounty: 0n, income: C.INCOME, quarry: 0n, clear: 0n, salvage: 0n, deepQuarry: 0n };
  const hp = Array.from({ length: L.CELLS }, (_, i) => {
    const value = partAt(state, BigInt(i)) === P.PALISADE ? add(mul(C.PALISADE_HP, tierAt(state, BigInt(i))),
      ((state.overclocked ?? 0n) & (1n << BigInt(i))) !== 0n ? C.OVERCLOCK_HP : 0n) : 0n;
    if (value >= 1n << BigInt(L.PALISADE_HP_BITS)) throw new RuleError('Palisade width exceeded');
    return value;
  });
  let disabled = 0n, walls = state.walls, gold = state.gold;
  const frames: TickFrame[] = [];
  for (let tick = 1n; tick <= BigInt(L.TICKS); tick++) {
    const frame: TickFrame = { tick, groups: [], shots: [], splashes: [], bites: [], palisades: [], tramples: [], leaks: [], kills: [], retreats: [], goldEvents: [], disabled, walls, gold, mitigations: [] };
    const grant = (reason: GoldEvent['reason'], amount: bigint, source: bigint | null = null) => {
      gold = add(gold, amount);
      if (trace && amount > 0n) frame.goldEvents.push({ reason, amount, source });
    };
    const stats = cellStats(state, disabled);
    const single = groups.map(() => 0n), splash = groups.map(() => 0n);
    const blocked = (g: EnemyGroup) => g.pos > 1n && g.pos <= 5n && hp[Number(cellOf(g.lane, sub(g.pos, 1n)))] > 0n;
    // Fire: targets and support use start-of-tick state. All damage lands together.
    for (let i = 0; i < stats.length; i++) {
      const s = stats[i];
      if (s.part !== P.BALLISTA && s.part !== P.CAULDRON) continue;
      const range = s.part === P.BALLISTA ? C.BALLISTA_RANGE : C.CAULDRON_RANGE;
      const low = cut(s.depth, s.watch > 0n ? C.WATCH_RANGE : 0n);
      const high = add(add(s.depth, range), s.watch > 0n ? C.WATCH_RANGE : 0n);
      const targets: number[] = [];
      for (let k = 0; k < groups.length; k++) {
        const g = groups[k];
        if (g.status === 'active' && g.lane === s.lane && g.pos >= low && g.pos <= high) targets.push(k);
      }
      const damage = () => { const base = mul(add(add(s.part === P.BALLISTA ? C.BALLISTA_DAMAGE : C.CAULDRON_DAMAGE,
        mul(s.forge, s.part === P.BALLISTA ? C.FORGE_BALLISTA : C.FORGE_CAULDRON)),
        mul(s.watch, C.WATCH_DAMAGE)), s.tier);
        return min(s.part === P.BALLISTA ? C.BALLISTA_CAP : C.CAULDRON_CAP, add(base, s.overclocked ? div(base, 2n) : 0n)); };
      if (s.part === P.BALLISTA && targets.length) {
        let k = targets[0];
        for (const candidate of targets) if (groups[candidate].pos < groups[k].pos) k = candidate;
        const d = damage(); single[k] = add(single[k], d);
        if (trace) frame.shots.push({ from: BigInt(i), group: groups[k].id, damage: d });
      } else if (s.part === P.CAULDRON && targets.length) {
        const events: Splash['targets'] = [];
        for (const k of targets) { const d = damage(); splash[k] = add(splash[k], d);
          if (trace) events.push({ group: groups[k].id, count: groups[k].count, damage: d }); }
        if (trace) frame.splashes.push({ from: BigInt(i), targets: events });
      }
    }
    for (let k = 0; k < groups.length; k++) {
      const g = groups[k];
      if (g.status !== 'active') continue;
      const bolts = g.bossPattern === 'last-siege' && tick % 2n === 0n ? div(single[k], C.LAST_SIEGE_BOLT_DIVISOR) : single[k];
      const area = cut(splash[k], g.splashArmor ?? 0n);
      if (trace && (bolts !== single[k] || area !== splash[k])) frame.mitigations!.push({ group: g.id,
        ballista: sub(single[k], bolts), splash: sub(splash[k], area) });
      const before = g.count;
      const front = cut(g.hp, area);
      const body = cut(g.bodyHp, area);
      // Splash lands on every unit, then pooled bolts cleave within this group.
      // A positive denominator keeps both branches safe in Ballista's eager select.
      const spill = cut(bolts, front), divisor = max(body, 1n);
      const killedByBolts = bolts >= front ? add(1n, div(spill, divisor)) : 0n;
      g.count = body === 0n ? 0n : cut(before, killedByBolts);
      g.hp = g.count === 0n ? 0n : bolts < front ? cut(front, bolts) : sub(body, spill % divisor);
      g.bodyHp = body;
      const killed = sub(before, g.count);
      if (g.count === 0n) g.status = 'dead';
      if (killed > 0n) {
        const bounty = mul(killed, g.bounty), lane = lanes[Number(g.lane)];
        lane.kills = add(lane.kills, killed); summary.kills = add(summary.kills, killed);
        summary.bounty = add(summary.bounty, bounty); grant('bounty', bounty, g.id);
        if (trace) frame.kills.push({ group: g.id, lane: g.lane, count: killed, bounty });
      }
    }
    // Bite: every surviving blocked unit bites; broken blockers cease blocking this Move.
    const bitten = hp.map(() => 0n);
    for (const g of groups) if (g.status === 'active' && blocked(g)) {
      const bite = g.bossPattern === 'gatebreaker' ? (tick % 2n === 0n ? C.GATEBREAKER_BITE_EVEN : C.GATEBREAKER_BITE_ODD) : g.bite;
      const cell = cellOf(g.lane, sub(g.pos, 1n)), d = mul(g.count, bite);
      bitten[Number(cell)] = add(bitten[Number(cell)], d);
      if (trace) frame.bites.push({ group: g.id, cell, damage: d });
    }
    for (let i = 0; i < hp.length; i++) hp[i] = cut(hp[i], bitten[i]);
    // Same-speed Move, then spawn. Groups may share a cell but cannot overtake.
    for (const g of groups) {
      if (g.status === 'active' && !blocked(g)) {
        g.pos = sub(g.pos, 1n);
        if (g.pos === 0n) {
          const damage = leakDamage(g), lane = lanes[Number(g.lane)];
          g.status = 'leaked'; walls = cut(walls, damage);
          lane.leaks = add(lane.leaks, g.count); lane.damage = add(lane.damage, damage); summary.damage = add(summary.damage, damage);
          if (trace) frame.leaks.push({ group: g.id, lane: g.lane, count: g.count, damage });
        } else {
          const cell = cellOf(g.lane, g.pos), p = partAt(state, cell);
          if (p !== P.EMPTY && p !== P.PALISADE && (disabled & (1n << cell)) === 0n) {
            disabled |= 1n << cell;
            if (trace) frame.tramples.push({ group: g.id, cell, part: p });
          }
        }
      } else if (g.status === 'queued' && g.spawnTick === tick) { g.status = 'active'; g.pos = 5n; }
    }
    if (tick === BigInt(L.TICKS)) {
      for (const g of groups) if (g.status === 'active') {
        // The siege deadline is a storm, never a harmless timeout victory.
        const damage = leakDamage(g), lane = lanes[Number(g.lane)];
        g.status = 'leaked'; g.pos = 0n; walls = cut(walls, damage);
        lane.leaks = add(lane.leaks, g.count); lane.damage = add(lane.damage, damage);
        summary.damage = add(summary.damage, damage);
        if (trace) frame.leaks.push({ group: g.id, lane: g.lane, count: g.count, damage });
      }
      summary.clear = mul(BigInt(lanes.filter(l => l.spawned > 0n && l.kills === l.spawned).length), C.CLEAR_GOLD);
      summary.salvage = div(summary.kills, C.SALVAGE_KILLS);
      for (let i = 0n; i < 16n; i++) if (partAt(state, i) === P.QUARRY && (disabled & (1n << i)) === 0n) {
        const adjacent = BigInt(neighbors(i).filter(n => partAt(state, n) === P.QUARRY && (disabled & (1n << n)) === 0n).length);
        const amount = add(add(mul(C.QUARRY_GOLD, tierAt(state, i)), mul(C.QUARRY_ADJACENT, adjacent)), i % 4n >= 2n ? C.QUARRY_DEEP : 0n);
        summary.deepQuarry = add(summary.deepQuarry!, i % 4n >= 2n ? C.QUARRY_DEEP : 0n);
        summary.quarry = add(summary.quarry, amount); grant('quarry', amount, i);
      }
      grant('income', C.INCOME); grant('clear', summary.clear); grant('salvage', summary.salvage);
    }
    if (trace) {
      frame.groups = groups.map(g => ({ ...g }));
      frame.palisades = hp.flatMap((v, i) => partAt(state, BigInt(i)) === P.PALISADE ? [{ cell: BigInt(i), hp: v }] : []);
      frame.disabled = disabled; frame.walls = walls; frame.gold = gold; frames.push(frame);
    }
  }
  return { state: settle(state, wave, walls, gold, add(state.totalKills, summary.kills)), frames, summary };
}
function settle(s: RunState, wave: bigint, walls: bigint, gold: bigint, totalKills: bigint): RunState {
  const done = walls === 0n || wave === BigInt(L.WAVES), won = walls > 0n && wave === BigInt(L.WAVES);
  const survived = walls > 0n ? wave : sub(wave, 1n);
  const score = add(add(mul(C.SCORE_WAVE, survived), mul(C.SCORE_WALL, walls)), mul(C.SCORE_KILL, totalKills));
  return { ...s, wave, walls, gold, totalKills, done, won, score, actionsUsed: 0n, bought: 0n, rerolls: 0n, overclocked: 0n };
}
export const fight = (s: RunState): FightResult => resolve(s, true);
/** Fast, allocation-light trace omission, used only by bots and preview. */
export const evaluateFight = (s: RunState): FightResult => resolve(s, false);
export function previewLanes(s: RunState): LanePreview[] {
  return evaluateFight(s).summary.lanes.map((r, lane) => ({ lane: BigInt(lane), result: r.damage === 0n ? 'HOLDS' : 'LEAKS', leaks: r.damage, kills: r.kills, retreats: r.retreats }));
}
/** Reconstruct persistent state from the event stream, without calling combat. */
export function replayFrames(s: RunState, frames: TickFrame[]): RunState {
  validateState(s);
  if (s.done || frames.length !== L.TICKS) throw new RuleError('incomplete replay');
  let gold = s.gold, walls = s.walls, kills = s.totalKills;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.tick !== BigInt(i + 1)) throw new RuleError('out of order replay');
    for (const e of f.goldEvents) gold = add(gold, e.amount);
    for (const e of f.leaks) walls = cut(walls, e.damage);
    for (const e of f.kills) kills = add(kills, e.count);
    if (f.gold !== gold || f.walls !== walls) throw new RuleError('replay mismatch');
  }
  return settle(s, add(s.wave, 1n), walls, gold, kills);
}

/** Six words, little endian on wire: seed, parts, tiers, metadata, gold, score. */
export function packState(s: RunState): bigint[] {
  validateState(s);
  const meta = (s.mode === 'daily' ? 1n : 0n) | field(s.wave, 4, 1) | field(s.walls, 5, 5)
    | field(s.rerolls, 3, 10) | field(s.bought, 4, 13) | field(s.actionsUsed, 3, 17)
    | (BigInt(s.done) << 20n) | (BigInt(s.won) << 21n) | field(s.totalKills, 12, 22) | field(s.overclocked ?? 0n, 16, 34);
  return [s.seed, s.parts, s.tiers, u64(meta), s.gold, s.score];
}
export function unpackState(words: readonly bigint[]): RunState {
  if (words.length !== 6) throw new RuleError('bad state length');
  words.forEach(u64);
  const [seed, parts, tiers, m, gold, score] = words;
  if (m >> 50n) throw new RuleError('reserved state bits');
  const s: RunState = { seed, parts, tiers, gold, score, mode: m & 1n ? 'daily' : 'practice', wave: (m >> 1n) & 15n,
    walls: (m >> 5n) & 31n, rerolls: (m >> 10n) & 7n, bought: (m >> 13n) & 15n,
    actionsUsed: (m >> 17n) & 7n, done: !!(m & (1n << 20n)), won: !!(m & (1n << 21n)), totalKills: (m >> 22n) & 4095n,
    overclocked: (m >> 34n) & 65535n };
  validateState(s); return s;
}
/** count:3, then six canonical 9-bit commands: opcode:3, cell:4, slot:2. */
export function encodeActions(actions: readonly Action[]): bigint {
  if (actions.length > L.ACTIONS) throw new RuleError('too many actions');
  let word = BigInt(actions.length);
  actions.forEach((a, k) => {
    const op = a.type === 'buy' ? 1n : a.type === 'upgrade' ? 2n : a.type === 'sell' ? 3n : a.type === 'reroll' ? 4n : a.type === 'overclock' ? 5n : 0n;
    if (op === 0n) throw new RuleError('unknown action');
    let command = op;
    if (a.type !== 'reroll') { index(a.cell, L.CELLS); command |= a.cell << 3n; }
    if (a.type === 'buy') { index(a.slot, L.SHOP_SLOTS); command |= a.slot << 7n; }
    word |= command << BigInt(3 + 9 * k);
  });
  return u64(word);
}
export function decodeActions(word: bigint): Action[] {
  u64(word); const n = Number(word & 7n);
  if (n > L.ACTIONS || word >> BigInt(3 + n * 9)) throw new RuleError('noncanonical actions');
  const actions: Action[] = [];
  for (let k = 0; k < n; k++) {
    const c = (word >> BigInt(3 + 9 * k)) & 511n, op = c & 7n, cell = (c >> 3n) & 15n, slot = c >> 7n;
    if (op === 1n) actions.push({ type: 'buy', cell, slot });
    else if ((op === 2n || op === 3n || op === 5n) && slot === 0n) actions.push({ type: op === 2n ? 'upgrade' : op === 3n ? 'sell' : 'overclock', cell });
    else if (op === 4n && (c >> 3n) === 0n) actions.push({ type: 'reroll' });
    else throw new RuleError('noncanonical actions');
  }
  return actions;
}
export function playTurn(s: RunState, actions: readonly Action[]): FightResult & { event: TurnEvent } {
  if (s.actionsUsed !== 0n) throw new RuleError('playTurn requires start of turn');
  const encoded = encodeActions(actions);
  let built = s;
  for (const a of actions) built = applyAction(built, a);
  const result = fight(built);
  return { ...result, event: { tag: 'SGV1', seed: s.seed, expectedWave: s.wave, actions: encoded,
    before: packState(s), after: packState(result.state), lanes: result.summary.lanes } };
}

const KINDS: EnemyKind[] = ['swarm', 'brute', 'boss'];
const STATUSES: GroupStatus[] = ['queued', 'active', 'dead', 'leaked', 'retreated'];
function field(value: bigint, bits: number, shift: number): bigint {
  u64(value);
  if (bits + shift > 64 || value >= (1n << BigInt(bits))) throw new RuleError('packed field overflow');
  return u64(value << BigInt(shift));
}
/** One 32-bit slot per group, two slots per u64. HP widths are deliberately knobs. */
export function packGroup(g: EnemyGroup): bigint {
  const pos = L.POSITION_BITS, count = L.COUNT_BITS, hp = L.HP_BITS;
  const kind = KINDS.indexOf(g.kind), status = STATUSES.indexOf(g.status);
  u64(g.maxHp);
  if (kind < 0 || status < 0 || pos + count + hp * 2 + 5 > 32 || g.pos > 5n
    || g.hp > g.bodyHp || g.bodyHp > g.maxHp
    || (g.status === 'dead' ? g.count !== 0n || g.hp !== 0n : g.count === 0n || g.hp === 0n)
    || ((g.status === 'queued' || g.status === 'leaked') ? g.pos !== 0n : g.status !== 'dead' && g.pos === 0n)) throw new RuleError('bad group layout');
  return field(g.pos, pos, 0) | field(g.count, count, pos) | field(g.hp, hp, pos + count)
    | field(g.bodyHp, hp, pos + count + hp) | field(BigInt(kind), 2, pos + count + hp * 2)
    | field(BigInt(status), 3, pos + count + hp * 2 + 2);
}
export function unpackGroup(word: bigint, original: EnemyGroup): EnemyGroup {
  u64(word);
  const p = L.POSITION_BITS, c = L.COUNT_BITS, h = L.HP_BITS;
  const get = (bits: number, shift: number) => (word >> BigInt(shift)) & ((1n << BigInt(bits)) - 1n);
  const kind = KINDS[Number(get(2, p + c + h * 2))], status = STATUSES[Number(get(3, p + c + h * 2 + 2))];
  if (!kind || !status || kind !== original.kind || word >> BigInt(p + c + h * 2 + 5)) throw new RuleError('bad packed group');
  const group = { ...original, kind, status, pos: get(p, 0), count: get(c, p), hp: get(h, p + c), bodyHp: get(h, p + c + h) };
  packGroup(group);
  return group;
}
/** SGV1 + three u64s + two six-u64 snapshots + four packed lane summaries = 156 bytes. */
export function encodeEvent(event: TurnEvent): Uint8Array {
  if (event.tag !== 'SGV1' || event.before.length !== 6 || event.after.length !== 6 || event.lanes.length !== L.LANES) throw new RuleError('bad event');
  decodeActions(event.actions);
  const before = unpackState(event.before), after = unpackState(event.after);
  if (before.seed !== event.seed || after.seed !== event.seed || before.wave !== event.expectedWave || after.wave !== add(before.wave, 1n)) throw new RuleError('inconsistent event');
  const lanes = event.lanes.map(l => field(l.spawned, 8, 0) | field(l.kills, 8, 8) | field(l.leaks, 8, 16)
    | field(l.damage, 16, 24) | field(l.retreats, 8, 40));
  const words = [event.seed, event.expectedWave, event.actions, ...event.before, ...event.after, ...lanes];
  const bytes = new Uint8Array(4 + words.length * 8), view = new DataView(bytes.buffer);
  bytes.set([83, 71, 86, 49]);
  words.forEach((w, i) => view.setBigUint64(4 + i * 8, u64(w), true));
  return bytes;
}

export function decodeEvent(bytes: Uint8Array): TurnEvent {
  if (bytes.byteLength !== 156 || bytes[0] !== 83 || bytes[1] !== 71 || bytes[2] !== 86 || bytes[3] !== 49) throw new RuleError('bad event bytes');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = Array.from({ length: 19 }, (_, i) => view.getBigUint64(4 + 8 * i, true));
  const lanes = words.slice(15).map(w => {
    if (w >> 48n) throw new RuleError('reserved lane bits');
    return { spawned: w & 255n, kills: (w >> 8n) & 255n, leaks: (w >> 16n) & 255n,
      damage: (w >> 24n) & 65535n, retreats: (w >> 40n) & 255n };
  });
  const event: TurnEvent = { tag: 'SGV1', seed: words[0], expectedWave: words[1], actions: words[2],
    before: words.slice(3, 9), after: words.slice(9, 15), lanes };
  encodeEvent(event);
  return event;
}
