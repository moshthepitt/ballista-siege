// Search-only number arithmetic. Accepted plans are replayed by the checked bigint sim.
// The conservative bound below rejects constants outside this kernel's exact integer range.
import { C } from '../rules/constants.js';
import { enemies, offers, type RunState, type Survey } from '../rules/sim.js';

export interface Move { pick: number; cell: number }
export interface Board { lo: number; hi: number }
export interface Position extends Board { walls: number; gold: number }
export interface Stats { st: number[]; aoe: number[]; shield: number[]; goldGain: number }
export interface Wave {
  offers: number[]; swarm: number[]; brute: number[]; swarmHp: number; bruteHp: number;
}
export type Rules = { [K in keyof typeof C]: number };
export interface Day { day: bigint; rules: Rules; waves: Wave[] }

export const adjacent = Array.from({ length: 16 }, (_, i) =>
  [i % 4 > 0 ? i - 1 : -1, i % 4 < 3 ? i + 1 : -1,
    i >= 4 ? i - 4 : -1, i < 12 ? i + 4 : -1].filter(n => n >= 0));

export function prepareDay(day: bigint): Day {
  const rules = Object.fromEntries(Object.entries(C).map(([k, v]) => [k, Number(v)])) as Rules;
  const knobs = Object.entries(rules).filter(([k]) => k !== 'STARTING_GRID' && k !== 'OFFER_TABLE');
  // At most 16 parts, 4 neighbors, 100 waves; worst-case products stay < 2^53.
  if (rules.WAVES < 1 || rules.WAVES > 100 ||
      knobs.some(([, v]) => !Number.isSafeInteger(v) || v < 0 || v > 10_000)) {
    throw new Error('Search kernel constants exceed exact number arithmetic bounds');
  }
  const waves = Array.from({ length: rules.WAVES }, (_, i) => {
    const w = BigInt(i + 1), e = enemies(day, w);
    return { offers: offers(day, w).map(Number), swarm: e.swarm.map(Number),
      brute: e.brute.map(Number), swarmHp: Number(e.swarmHp), bruteHp: Number(e.bruteHp) };
  });
  return { day, rules, waves };
}

export const boardOf = (grid: bigint): Board => ({ lo: Number(grid & 0xffffffffn) >>> 0, hi: Number(grid >> 32n) >>> 0 });
export const gridOf = (b: Board): bigint => BigInt(b.lo >>> 0) | (BigInt(b.hi >>> 0) << 32n);
export const partAt = (b: Board, i: number): number => ((i < 8 ? b.lo : b.hi) >>> ((i & 7) * 4)) & 15;
export function place(b: Board, cell: number, part: number): Board {
  const shift = (cell & 7) * 4, mask = ~(15 << shift);
  return cell < 8 ? { lo: ((b.lo & mask) | (part << shift)) >>> 0, hi: b.hi }
    : { lo: b.lo, hi: ((b.hi & mask) | (part << shift)) >>> 0 };
}

export function survey(b: Board, c: Rules): Stats {
  const st = [0, 0, 0, 0], aoe = [0, 0, 0, 0], shield = [0, 0, 0, 0];
  let watched = 0, goldGain = 0;
  for (let i = 0; i < 16; i++) if (partAt(b, i) === 4) watched |= 1 << (i & 3);
  for (let i = 0; i < 16; i++) {
    const p = partAt(b, i), lane = i >> 2;
    if (p === 1 || p === 2 || p === 5) {
      let count = 0;
      for (const n of adjacent[i]) if (partAt(b, n) === (p === 5 ? 5 : 3)) count++;
      if (p === 1) st[lane] += c.BALLISTA_DMG + c.FORGE_ST * count + ((watched & (1 << (i & 3))) ? c.WATCH_BONUS : 0);
      if (p === 2) aoe[lane] += c.CAULDRON_DMG + c.FORGE_AOE * count;
      if (p === 5) goldGain += c.QUARRY_GOLD + c.QUARRY_ADJ * count;
    } else if (p === 6) shield[lane] += c.PALISADE_SHIELD;
  }
  return { st, aoe, shield, goldGain };
}

export function damage(s: Stats, e: Wave, c: Rules): number {
  let hit = 0;
  for (let l = 0; l < 4; l++) {
    const bEff = Math.max(0, e.bruteHp - s.aoe[l]), sEff = Math.max(0, e.swarmHp - s.aoe[l]);
    const bk = bEff === 0 ? e.brute[l] : Math.min(e.brute[l], Math.floor(s.st[l] / bEff));
    const rest = s.st[l] - bk * bEff;
    const sk = sEff === 0 ? e.swarm[l] : Math.min(e.swarm[l], Math.floor(rest / sEff));
    hit += Math.max(0, c.BRUTE_LEAK * (e.brute[l] - bk) + c.SWARM_LEAK * (e.swarm[l] - sk) - s.shield[l]);
  }
  return hit;
}

export function step(p: Position, wave: number, move: Move, d: Day): Position {
  const b = place(p, move.cell, d.waves[wave].offers[move.pick]), s = survey(b, d.rules);
  return { ...b, walls: Math.max(0, p.walls - damage(s, d.waves[wave], d.rules)), gold: p.gold + s.goldGain };
}

export const positionOf = (s: RunState): Position => ({ ...boardOf(s.grid), walls: Number(s.walls), gold: Number(s.gold) });
export const bigintSurvey = (s: Stats): Survey => ({ st: s.st.map(BigInt), aoe: s.aoe.map(BigInt), shield: s.shield.map(BigInt), goldGain: BigInt(s.goldGain) });

export function legalMoves(d: Day, wave: number, deduplicate = true): Move[] {
  const out: Move[] = [], seen = new Set<number>();
  d.waves[wave].offers.forEach((part, pick) => {
    if (deduplicate && seen.has(part)) return;
    seen.add(part);
    for (let cell = 0; cell < 16; cell++) out.push({ pick, cell });
  });
  return out;
}
