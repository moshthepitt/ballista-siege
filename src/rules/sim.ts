// Reference implementation of docs/rules.md. Pure functions over bigint with checked u64 math:
// anything the chain would reject (overflow, underflow, bad input) throws RuleError here.
import { C, CELLS, LANES, PART, RNG, ROWS, SECONDS_PER_DAY } from './constants.js';

export const U64_MAX = (1n << 64n) - 1n;

export class RuleError extends Error {}

function check(v: bigint): bigint {
  if (v < 0n || v > U64_MAX) throw new RuleError(`u64 out of range: ${v}`);
  return v;
}
const add = (a: bigint, b: bigint) => check(a + b);
const sub = (a: bigint, b: bigint) => check(a - b);
const mul = (a: bigint, b: bigint) => check(a * b);
const div = (a: bigint, b: bigint) => {
  if (b === 0n) throw new RuleError('division by zero');
  return a / b;
};
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

export interface RunState {
  day: bigint;
  wave: bigint;
  walls: bigint;
  gold: bigint;
  grid: bigint;
  score: bigint;
  done: boolean;
  won: boolean;
  bestDay: bigint;
  bestScore: bigint;
}

export interface LaneResult {
  swarm: bigint;
  brute: bigint;
  sk: bigint;
  bk: bigint;
  hit: bigint;
}

export interface WaveEvent {
  w: bigint;
  pick: bigint;
  cell: bigint;
  part: bigint;
  walls: bigint;
  gold: bigint;
  goldGain: bigint;
  score: bigint;
  done: boolean;
  won: boolean;
  lanes: LaneResult[];
}

export interface Survey {
  st: bigint[];
  aoe: bigint[];
  shield: bigint[];
  goldGain: bigint;
}

export interface Enemies {
  swarm: bigint[];
  brute: bigint[];
  swarmHp: bigint;
  bruteHp: bigint;
}

/** A freshly created registry entry: every field zero. */
export function emptyState(): RunState {
  return {
    day: 0n, wave: 0n, walls: 0n, gold: 0n, grid: 0n, score: 0n,
    done: false, won: false, bestDay: 0n, bestScore: 0n,
  };
}

export function xorshift(x: bigint): bigint {
  x = x ^ ((x & ((1n << 51n) - 1n)) << 13n);
  x = x ^ (x >> 7n);
  x = x ^ ((x & ((1n << 47n) - 1n)) << 17n);
  return x;
}

export function roll(day: bigint, w: bigint, salt: bigint): bigint {
  const mix = add(add(mul(day, RNG.DAY_MUL), mul(w, RNG.WAVE_MUL)), salt);
  return xorshift(xorshift(RNG.BASE ^ mix));
}

export function offers(day: bigint, w: bigint): bigint[] {
  const x = roll(day, w, RNG.SALT_OFFERS);
  return [0n, 1n, 2n].map((k) => (C.OFFER_TABLE >> (4n * ((x >> (16n * k)) & 0xfn))) & 0xfn);
}

export function enemies(day: bigint, w: bigint): Enemies {
  const y = roll(day, w, RNG.SALT_ENEMIES);
  const heavy = (y >> 32n) & 3n;
  const swarm: bigint[] = [];
  const brute: bigint[] = [];
  for (let l = 0n; l < LANES; l++) {
    const b = (y >> (8n * l)) & 0xffn;
    const isHeavy = l === heavy;
    const scaled = div(mul(C.SWARM_NUM, w), C.SWARM_DEN);
    const heavyExtra = isHeavy ? div(mul(C.HEAVY_NUM, w), C.HEAVY_DEN) : 0n;
    swarm.push(add(add(add(C.SWARM_BASE, scaled), b % add(w, C.SWARM_SPREAD)), heavyExtra));
    const base = w >= C.BRUTE_FROM_WAVE ? (b >> 5n) % add(div(w, C.BRUTE_DIV), 1n) : 0n;
    brute.push(add(base, isHeavy && w >= C.HEAVY_BRUTE_FROM_WAVE ? 1n : 0n));
  }
  return {
    swarm,
    brute,
    swarmHp: add(C.SWARM_HP_BASE, div(w, C.SWARM_HP_STEP)),
    bruteHp: add(C.BRUTE_HP_BASE, mul(C.BRUTE_HP_PER_WAVE, w)),
  };
}

export const cellOf = (lane: bigint, row: bigint) => lane * ROWS + row;
export const partAt = (grid: bigint, i: bigint) => (grid >> (4n * i)) & 0xfn;
export function setPart(grid: bigint, i: bigint, part: bigint): bigint {
  return (grid & ~(0xfn << (4n * i)) & U64_MAX) | (part << (4n * i));
}

function neighbors(i: bigint): bigint[] {
  const lane = i / ROWS;
  const row = i % ROWS;
  const out: bigint[] = [];
  if (row > 0n) out.push(i - 1n);
  if (row < ROWS - 1n) out.push(i + 1n);
  if (lane > 0n) out.push(i - ROWS);
  if (lane < LANES - 1n) out.push(i + ROWS);
  return out;
}

const countAdj = (grid: bigint, i: bigint, part: bigint) =>
  BigInt(neighbors(i).filter((n) => partAt(grid, n) === part).length);

export function survey(grid: bigint): Survey {
  const st = [0n, 0n, 0n, 0n];
  const aoe = [0n, 0n, 0n, 0n];
  const shield = [0n, 0n, 0n, 0n];
  let goldGain = 0n;
  const watchedRows = new Set<bigint>();
  for (let i = 0n; i < CELLS; i++) if (partAt(grid, i) === PART.WATCHTOWER) watchedRows.add(i % ROWS);

  for (let i = 0n; i < CELLS; i++) {
    const lane = Number(i / ROWS);
    const p = partAt(grid, i);
    if (p === PART.BALLISTA) {
      const bonus = watchedRows.has(i % ROWS) ? C.WATCH_BONUS : 0n;
      st[lane] = add(st[lane], add(add(C.BALLISTA_DMG, mul(C.FORGE_ST, countAdj(grid, i, PART.FORGE))), bonus));
    } else if (p === PART.CAULDRON) {
      aoe[lane] = add(aoe[lane], add(C.CAULDRON_DMG, mul(C.FORGE_AOE, countAdj(grid, i, PART.FORGE))));
    } else if (p === PART.PALISADE) {
      shield[lane] = add(shield[lane], C.PALISADE_SHIELD);
    } else if (p === PART.QUARRY) {
      goldGain = add(goldGain, add(C.QUARRY_GOLD, mul(C.QUARRY_ADJ, countAdj(grid, i, PART.QUARRY))));
    }
  }
  return { st, aoe, shield, goldGain };
}

export function fightLane(
  swarm: bigint, brute: bigint, swarmHp: bigint, bruteHp: bigint,
  st: bigint, aoe: bigint, shield: bigint,
): LaneResult {
  const sEff = sub(swarmHp, min(aoe, swarmHp));
  const bEff = sub(bruteHp, min(aoe, bruteHp));
  const bk = bEff === 0n ? brute : min(brute, div(st, bEff));
  const rest = sub(st, mul(bk, bEff));
  const sk = sEff === 0n ? swarm : min(swarm, div(rest, sEff));
  const leak = add(mul(C.BRUTE_LEAK, sub(brute, bk)), mul(C.SWARM_LEAK, sub(swarm, sk)));
  const hit = sub(leak, min(leak, shield));
  return { swarm, brute, sk, bk, hit };
}

export function start(state: RunState, unixTs: bigint): RunState {
  if (unixTs < 0n) throw new RuleError('negative clock');
  return {
    ...state,
    day: unixTs / SECONDS_PER_DAY,
    wave: 0n,
    walls: C.WALLS_START,
    gold: 0n,
    grid: C.STARTING_GRID,
    score: 0n,
    done: false,
    won: false,
  };
}

export function play(
  state: RunState, expectedWave: bigint, pick: bigint, cell: bigint,
): { state: RunState; event: WaveEvent } {
  if (state.done) throw new RuleError('run is over');
  if (expectedWave !== state.wave) throw new RuleError('stale wave');
  if (pick < 0n || pick > 2n) throw new RuleError('bad pick');
  if (cell < 0n || cell > 15n) throw new RuleError('bad cell');
  const w = add(state.wave, 1n);

  const part = offers(state.day, w)[Number(pick)];
  const grid = setPart(state.grid, cell, part);

  const s = survey(grid);
  const e = enemies(state.day, w);
  const lanes: LaneResult[] = [];
  let totalHit = 0n;
  for (let l = 0; l < 4; l++) {
    const r = fightLane(e.swarm[l], e.brute[l], e.swarmHp, e.bruteHp, s.st[l], s.aoe[l], s.shield[l]);
    lanes.push(r);
    totalHit = add(totalHit, r.hit);
  }

  const walls = sub(state.walls, min(state.walls, totalHit));
  const gold = add(state.gold, s.goldGain);
  const done = walls === 0n || w === C.WAVES;
  const won = walls > 0n && w === C.WAVES;
  const score = add(add(mul(100n, walls > 0n ? w : sub(w, 1n)), mul(10n, walls)), gold);

  let { bestDay, bestScore } = state;
  if (done) {
    if (bestDay === state.day) bestScore = max(bestScore, score);
    else {
      bestDay = state.day;
      bestScore = score;
    }
  }

  const next: RunState = { ...state, wave: w, walls, gold, grid, score, done, won, bestDay, bestScore };
  const event: WaveEvent = {
    w, pick, cell, part, walls, gold, goldGain: s.goldGain, score, done, won, lanes,
  };
  return { state: next, event };
}
