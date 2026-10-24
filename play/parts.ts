import { C, PART as P, PART_NAMES, LIMITS } from '../src/v1/constants.js';
import { neighbors, partAt, tierAt, type RunState } from '../src/v1/sim.js';

export const partName = (part: bigint) => PART_NAMES[Number(part)] ?? 'Empty';
export const partClass = (part: bigint) => ['', 'ballista', 'cauldron', 'palisade', 'forge', 'watch', 'quarry'][Number(part)] ?? '';
export const isWeapon = (part: bigint) => part === P.BALLISTA || part === P.CAULDRON;

const shapes = [
  '',
  '<path d="M10 42 32 12 54 42 32 32Z"/><path class="detail" d="M14 48 32 35 50 48M32 19v34M19 42l-6 12m32-12 6 12"/>',
  '<circle cx="32" cy="33" r="22"/><circle class="detail" cx="32" cy="33" r="13"/><path class="detail" d="m18 10 3-5m11 3V2m11 8-3-5"/>',
  '<path d="M7 18h10v9h10v-9h10v9h10v-9h10v31H7Z"/><path class="detail" d="M8 36h48M18 37v12m14-12v12m14-12v12"/>',
  '<path d="m32 9 23 23-23 23L9 32Z"/><path class="detail" d="M32 1v10m0 42v10M1 32h10m42 0h10m-31 0 10-10 10 10-10 10Z"/>',
  '<path d="m32 4 13 48H19Z"/><path class="detail" d="M8 23h13m22 0h13M4 36h15m26 0h15M25 58h14M32 17v27"/>',
  '<path d="M18 10h28l14 22-14 22H18L4 32Z"/><path class="detail" d="m16 32 8-12h16l8 12-8 12H24Z"/><circle class="gold-core" cx="32" cy="32" r="5"/>',
];
export function icon(part: bigint, extra = '', tier = 1n): string {
  if (part === P.PALISADE && extra === 'barrier') {
    const rails = Array.from({ length: Number(tier) }, (_, i) => `<path class="detail" d="M2 ${11 + i * 5}h60"/>`).join('');
    const braces = tier > 1n ? '<path class="tier-geometry" d="m5 9 20 12M5 21 25 9m14 0 20 12M39 21 59 9"/>' : '';
    const armor = tier > 2n ? '<path class="tier-core" d="M27 6h10v13l-5 4-5-4Z"/>' : '';
    return `<svg class="shape palisade barrier" data-tier="${tier}" viewBox="0 0 64 24" preserveAspectRatio="none" aria-hidden="true"><path d="M1 1h7v6h7V1h8v6h8V1h8v6h8V1h8v6h8v16H1Z"/>${rails}${braces}${armor}</svg>`;
  }
  // Large inner additions survive the small board icons: twin rails, split pots,
  // braced walls, forge teeth, tower floors, and extra quarry chambers.
  const geometry = part === P.BALLISTA
    ? ['<path d="M22 22v30m20-30v30M12 38l10-16m20 0 10 16"/>', '<path class="tier-core" d="m32 17 7 12-7 19-7-19Z"/><path d="M16 49h32"/>']
    : part === P.CAULDRON
    ? ['<path d="M32 12v42M12 33h40"/><circle class="tier-core" cx="23" cy="33" r="5"/><circle class="tier-core" cx="41" cy="33" r="5"/>', '<circle class="tier-core" cx="32" cy="23" r="6"/><circle class="tier-core" cx="32" cy="44" r="6"/><path d="M7 25H2m60 0h-5M7 43H2m60 0h-5"/>']
    : part === P.PALISADE
    ? ['<path d="m12 29 40 16M12 45l40-16"/>', '<path class="tier-core" d="M28 28h8v20h-8Z"/>']
    : part === P.FORGE
    ? ['<path class="tier-core" d="m17 32 9-9v18Zm30 0-9-9v18Z"/>', '<path class="tier-core" d="m32 14 6 12H26Zm0 36-6-12h12Z"/>']
    : part === P.WATCHTOWER
    ? ['<path d="M19 31h26M16 43h32"/><path class="tier-core" d="M27 25h10v8H27Z"/>', '<path class="tier-core" d="M25 38h14v9H25Z"/><path d="M9 14h46M14 9v10m36-10v10"/>']
    : ['<path class="tier-core" d="M16 23h10v17H16Zm22 0h10v17H38Z"/>', '<path class="tier-core" d="M28 14h8v12h-8Zm0 24h8v12h-8Z"/>'];
  const detail = geometry.slice(0, Number(tier - 1n)).map(markup => `<g class="tier-geometry">${markup}</g>`).join('');
  return `<svg class="shape ${partClass(part)} ${extra}" data-tier="${tier}" viewBox="0 0 64 64" aria-hidden="true">${shapes[Number(part)] ?? ''}${detail}</svg>`;
}

export interface PartStats {
  part: bigint; tier: bigint; base: bigint; forge: bigint; watch: bigint;
  value: bigint; low: number; high: number; hp: bigint; income: bigint; overclock: bigint; deepIncome: bigint;
}
/** Display-only breakdown. Lane outcomes always come from backend.preview(). */
export function statsAt(state: RunState, cell: bigint, disabled = 0n): PartStats {
  const part = partAt(state, cell), tier = tierAt(state, cell), depth = Number(cell % 4n + 1n);
  const active = (i: bigint) => !(disabled & (1n << i));
  let forge = 0n, watch = 0n, adjacentQuarries = 0n;
  for (const n of neighbors(cell)) if (active(n)) {
    if (partAt(state, n) === P.FORGE) forge += tierAt(state, n);
    if (partAt(state, n) === P.QUARRY) adjacentQuarries++;
  }
  for (let lane = 0n; lane < 4n; lane++) {
    const n = lane * 4n + cell % 4n;
    if (active(n) && partAt(state, n) === P.WATCHTOWER && tierAt(state, n) > watch) watch = tierAt(state, n);
  }
  const base = part === P.BALLISTA ? C.BALLISTA_DAMAGE : C.CAULDRON_DAMAGE;
  const forgeDamage = forge * (part === P.BALLISTA ? C.FORGE_BALLISTA : C.FORGE_CAULDRON);
  const watchDamage = watch * C.WATCH_DAMAGE;
  const range = Number(part === P.BALLISTA ? C.BALLISTA_RANGE : C.CAULDRON_RANGE);
  const nominal = (base + forgeDamage + watchDamage) * tier;
  const overclocked = !!((state.overclocked ?? 0n) & (1n << cell));
  const overclock = overclocked ? nominal / 2n : 0n;
  const rawDamage = nominal + overclock;
  const cap = part === P.BALLISTA ? C.BALLISTA_CAP : C.CAULDRON_CAP;
  return { part, tier, base, forge: forgeDamage, watch: watchDamage,
    value: rawDamage > cap ? cap : rawDamage,
    low: Math.max(1, depth - (watch > 0n ? Number(C.WATCH_RANGE) : 0)),
    high: Math.min(5, depth + range + (watch > 0n ? Number(C.WATCH_RANGE) : 0)),
    hp: C.PALISADE_HP * tier + (overclocked ? C.OVERCLOCK_HP : 0n), overclock,
    deepIncome: active(cell) && depth >= 3 ? C.QUARRY_DEEP : 0n,
    income: active(cell) ? C.QUARRY_GOLD * tier + C.QUARRY_ADJACENT * adjacentQuarries + (depth >= 3 ? C.QUARRY_DEEP : 0n) : 0n };
}

/** Contributors only: adjacent Forges and the strongest Watchtower(s) in this depth row. */
export function supportingCells(state: RunState, cell: bigint, disabled = 0n): bigint[] {
  if (!isWeapon(partAt(state, cell))) return [];
  const active = (i: bigint) => !(disabled & (1n << i));
  const forges = neighbors(cell).filter(i => active(i) && partAt(state, i) === P.FORGE);
  const towers = Array.from({ length: 4 }, (_, lane) => BigInt(lane) * 4n + cell % 4n)
    .filter(i => active(i) && partAt(state, i) === P.WATCHTOWER);
  const best = towers.reduce((n, i) => tierAt(state, i) > n ? tierAt(state, i) : n, 0n);
  return [...forges, ...towers.filter(i => tierAt(state, i) === best)];
}

export function statPill(s: PartStats, hp = s.hp): string {
  if (isWeapon(s.part)) return `${s.value} ${s.part === P.BALLISTA ? 'DMG' : 'DMG/UNIT'}`;
  if (s.part === P.PALISADE) return `♥ ${hp}/${s.hp}`;
  if (s.part === P.FORGE) return `+${C.FORGE_BALLISTA * s.tier} Ballista / +${C.FORGE_CAULDRON * s.tier} Cauldron`;
  if (s.part === P.WATCHTOWER) return `+${C.WATCH_DAMAGE * s.tier} DMG +${C.WATCH_RANGE} RNG`;
  return s.income ? `${s.income}g/wave total` : '0g this wave · trampled';
}

export function ruleCopy(part: bigint): string {
  if (part === P.BALLISTA) return `${C.BALLISTA_DAMAGE} dmg to the front group · reaches ${C.BALLISTA_RANGE} cells ahead · own lane`;
  if (part === P.CAULDRON) return `${C.CAULDRON_DAMAGE} damage per enemy · own lane, own + ${C.CAULDRON_RANGE} ahead · Brutes block ${C.BRUTE_SPLASH_ARMOR} pooled splash/unit each tick`;
  if (part === P.PALISADE) return `Blocks entry to its cell · ${C.PALISADE_HP} HP; survivors storm the wall at tick ${LIMITS.TICKS} · heals each wave`;
  if (part === P.FORGE) return `Adjacent weapons: +${C.FORGE_BALLISTA} Ballista / +${C.FORGE_CAULDRON} Cauldron damage per tier`;
  if (part === P.WATCHTOWER) return `Row weapons: +${C.WATCH_DAMAGE} dmg/tier (strongest tower only) · +${C.WATCH_RANGE} range ahead/behind`;
  return `+${C.QUARRY_GOLD}g/tier · +${C.QUARRY_ADJACENT}g per adjacent Quarry · +${C.QUARRY_DEEP}g at D3-D4. Trampled: 0g this wave.`;
}

export function quarryArithmetic(s: PartStats): string {
  if (!s.income) return '0g this wave · trampled';
  const base = C.QUARRY_GOLD * s.tier;
  return `${base} base + ${s.income - base - s.deepIncome} adjacent + ${s.deepIncome} deep = ${s.income}g/wave`;
}

export function damageArithmetic(s: PartStats): string {
  const raw = (s.base + s.forge + s.watch) * s.tier + s.overclock;
  return `(${s.base} base + ${s.forge} Forge + ${s.watch} Watchtower) × ${s.tier}${s.overclock ? ` + ${s.overclock} Overclock` : ''} = ${s.value}${raw > s.value ? ` (capped from ${raw})` : ''}`;
}
