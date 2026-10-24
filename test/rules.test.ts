import { describe, expect, it } from 'vitest';
import { C, PART, RNG } from '../src/rules/constants.js';
import { RuleError, U64_MAX, emptyState, enemies, fightLane, offers, partAt, play, roll, setPart, start, survey, xorshift } from '../src/rules/sim.js';
import { runBot, seededRandom } from '../src/bots/index.js';
import { bigintSurvey, boardOf, gridOf, legalMoves, place, positionOf, prepareDay, step, survey as fastSurvey } from '../src/bots/kernel.js';

function grid(parts: Record<number, bigint>): bigint {
  return Object.entries(parts).reduce((g, [i, p]) => setPart(g, BigInt(i), p), 0n);
}
const fresh = (day = 20000n) => start(emptyState(), day * 86400n);

describe('board and survey: hand-counted edge-sharing fixtures', () => {
  it('packs cells lane * 4 + row, including the high nibble, and replaces cells', () => {
    const g = grid({ 0: PART.BALLISTA, 4: PART.CAULDRON, 15: PART.PALISADE });
    expect(g).toBe(0x6000000000020001n);
    expect(partAt(setPart(g, 15n, PART.QUARRY), 15n)).toBe(PART.QUARRY);
    expect(partAt(g, 0n)).toBe(PART.BALLISTA);
  });
  it('counts four forge neighbors at an interior cell, excluding diagonal forges', () => {
    // Cell 5 neighbors: 1, 4, 6, 9. Cell 10 is diagonal.
    const s = survey(grid({ 5: PART.BALLISTA, 1: PART.FORGE, 4: PART.FORGE, 6: PART.FORGE, 9: PART.FORGE, 10: PART.FORGE }));
    expect(s.st).toEqual([0n, C.BALLISTA_DMG + 4n * C.FORGE_ST, 0n, 0n]);
    expect(s.aoe).toEqual([0n, 0n, 0n, 0n]);
  });
  it('does not join row 3 to the next lane row 0 or join opposite edges', () => {
    const s = survey(grid({ 3: PART.BALLISTA, 4: PART.FORGE, 12: PART.FORGE, 15: PART.FORGE }));
    expect(s.st).toEqual([C.BALLISTA_DMG, 0n, 0n, 0n]);
  });
  it('boosts cauldrons only from orthogonal forges', () => {
    const s = survey(grid({ 0: PART.CAULDRON, 1: PART.FORGE, 4: PART.FORGE, 5: PART.FORGE }));
    expect(s.aoe).toEqual([C.CAULDRON_DMG + 2n * C.FORGE_AOE, 0n, 0n, 0n]);
  });
  it('watchtowers cover their row across every lane, without stacking or boosting cauldrons', () => {
    const s = survey(grid({ 0: PART.WATCHTOWER, 4: PART.WATCHTOWER, 8: PART.BALLISTA, 12: PART.BALLISTA, 9: PART.BALLISTA, 1: PART.CAULDRON }));
    expect(s.st).toEqual([0n, 0n, 2n * C.BALLISTA_DMG + C.WATCH_BONUS, C.BALLISTA_DMG + C.WATCH_BONUS]);
    expect(s.aoe[0]).toBe(C.CAULDRON_DMG);
  });
  it('counts each quarry edge twice and ignores diagonal or wrapped edges', () => {
    // L cluster: 0--1, 0--4. Isolated 15.
    expect(survey(grid({ 0: PART.QUARRY, 1: PART.QUARRY, 4: PART.QUARRY, 15: PART.QUARRY })).goldGain)
      .toBe(4n * C.QUARRY_GOLD + 4n * C.QUARRY_ADJ);
    expect(survey(grid({ 3: PART.QUARRY, 4: PART.QUARRY, 9: PART.QUARRY })).goldGain).toBe(3n * C.QUARRY_GOLD);
  });
  it('adds palisades only to their own lane', () => {
    expect(survey(grid({ 0: PART.PALISADE, 3: PART.PALISADE, 6: PART.PALISADE })).shield)
      .toEqual([2n * C.PALISADE_SHIELD, C.PALISADE_SHIELD, 0n, 0n]);
  });
});

describe('fightLane', () => {
  it('aoe at least both HP values kills every enemy without single-target damage', () => {
    expect(fightLane(9n, 3n, 4n, 12n, 0n, 12n, 0n)).toEqual({ swarm: 9n, brute: 3n, sk: 9n, bk: 3n, hit: 0n });
  });
  it('spends ST on brutes first, then floors remaining damage against swarm', () => {
    // Effective HP: swarm 2, brute 6. ST 15 kills two brutes and one swarm.
    expect(fightLane(7n, 2n, 3n, 7n, 15n, 1n, 0n)).toEqual({ swarm: 7n, brute: 2n, sk: 1n, bk: 2n, hit: 6n * C.SWARM_LEAK });
    expect(fightLane(7n, 2n, 3n, 7n, 5n, 1n, 0n).bk).toBe(0n);
  });
  it('shield absorbs all or part of leak and never heals walls', () => {
    const leak = 4n * C.SWARM_LEAK + 2n * C.BRUTE_LEAK;
    expect(fightLane(4n, 2n, 3n, 8n, 0n, 0n, leak + 1n).hit).toBe(0n);
    expect(fightLane(4n, 2n, 3n, 8n, 0n, 0n, leak - 1n).hit).toBe(1n);
  });
  it('bEff=0 avoids division by zero and leaves all ST for swarm', () => {
    expect(fightLane(5n, 3n, 10n, 2n, 9n, 2n, 0n)).toEqual({ swarm: 5n, brute: 3n, sk: 1n, bk: 3n, hit: 4n * C.SWARM_LEAK });
  });
  it('empty lanes produce no hit', () => {
    expect(fightLane(0n, 0n, 1n, 1n, 99n, 99n, 99n).hit).toBe(0n);
  });
});

describe('daily determinism and checked arithmetic', () => {
  it('uses OFFER_TABLE nibbles rather than modulo-six part selection', () => {
    const table = Array.from({ length: 16 }, (_, i) => (C.OFFER_TABLE >> BigInt(i * 4)) & 15n);
    for (let day = 20000n; day < 20020n; day++) for (let w = 1n; w <= C.WAVES; w++) {
      const x = roll(day, w, 0n);
      expect(offers(day, w)).toEqual([0n, 16n, 32n].map(shift => table[Number((x >> shift) & 15n)]));
      expect(offers(day, w).every(p => p >= 1n && p <= 6n)).toBe(true);
    }
    expect(new Set(table).size).toBe(6);
  });
  it('matches an independently masked xorshift and roll', () => {
    const shift = (v: bigint) => {
      v = BigInt.asUintN(64, v ^ (v << 13n));
      v ^= v >> 7n;
      return BigInt.asUintN(64, v ^ (v << 17n));
    };
    for (const x of [0n, 1n, U64_MAX, RNG.BASE]) expect(xorshift(x)).toBe(shift(x));
    expect(roll(20000n, 3n, 1n)).toBe(shift(shift(RNG.BASE ^ (20000n * 2654435761n + 3n * 40503n + 1n))));
    expect(() => roll(U64_MAX, 1n, 0n)).toThrow(RuleError);
    expect(() => fightLane(U64_MAX, U64_MAX, 1n, 1n, 0n, 0n, 0n)).toThrow(RuleError);
  });
  it('enemy generation matches hand-applied wave formulas', () => {
    const day = 20123n, w = 6n, y = roll(day, w, 1n), heavy = (y >> 32n) & 3n, e = enemies(day, w);
    for (let lane = 0n; lane < 4n; lane++) {
      const b = (y >> (8n * lane)) & 255n;
      expect(e.swarm[Number(lane)]).toBe(C.SWARM_BASE + C.SWARM_NUM * w / C.SWARM_DEN + b % (w + C.SWARM_SPREAD) + (lane === heavy ? C.HEAVY_NUM * w / C.HEAVY_DEN : 0n));
      expect(e.brute[Number(lane)]).toBe((w >= C.BRUTE_FROM_WAVE ? (b >> 5n) % (w / C.BRUTE_DIV + 1n) : 0n) + (lane === heavy && w >= C.HEAVY_BRUTE_FROM_WAVE ? 1n : 0n));
    }
  });
});

describe('run actions, settlement and records', () => {
  it('start resets current run at the day boundary and preserves records', () => {
    const previous = { ...fresh(), grid: U64_MAX, gold: 88n, wave: 3n, score: 900n, done: true, won: true, bestDay: 7n, bestScore: 1234n };
    expect(start(previous, 2n * 86400n + 86399n)).toEqual({ ...previous, day: 2n, wave: 0n, walls: C.WALLS_START, grid: C.STARTING_GRID, gold: 0n, score: 0n, done: false, won: false });
    expect(() => start(previous, -1n)).toThrow('negative clock');
  });
  it('rejects stale wave, finished runs, and picks/cells outside the unsigned range', () => {
    const s = fresh();
    expect(() => play(s, 1n, 0n, 0n)).toThrow('stale wave');
    expect(() => play({ ...s, done: true }, 0n, 0n, 0n)).toThrow('run is over');
    for (const pick of [-1n, 3n]) expect(() => play(s, 0n, pick, 0n)).toThrow('bad pick');
    for (const cell of [-1n, 16n]) expect(() => play(s, 0n, 0n, cell)).toThrow('bad cell');
    expect(s).toEqual(fresh());
  });
  it('replaces the selected cell, settles gold, and emits the same state', () => {
    const s = fresh(), result = play(s, 0n, 2n, 15n), next = result.state, event = result.event;
    expect(partAt(next.grid, 15n)).toBe(offers(s.day, 1n)[2]);
    expect(next.gold).toBe(survey(next.grid).goldGain);
    expect(next.walls).toBe(s.walls - event.lanes.reduce((sum, l) => sum + l.hit, 0n));
    expect(next.score).toBe(100n + 10n * next.walls + next.gold);
    expect(event).toMatchObject({ w: 1n, pick: 2n, cell: 15n, walls: next.walls, gold: next.gold, score: next.score, done: next.done, won: next.won });
  });
  it('floors walls at zero and scores only previously survived waves on death', () => {
    const s = { ...fresh(), wave: C.WAVES - 1n, walls: 1n, grid: 0n };
    const { state, event } = play(s, s.wave, 0n, 0n);
    expect(event.lanes.reduce((sum, l) => sum + l.hit, 0n)).toBeGreaterThan(1n);
    expect(state.walls).toBe(0n); expect(state.done).toBe(true); expect(state.won).toBe(false);
    expect(state.score).toBe(100n * (C.WAVES - 1n) + state.gold);
  });
  it('final wave wins with walls remaining and records max score only on the same day', () => {
    const base = { ...fresh(), wave: C.WAVES - 1n, walls: 100000n, gold: 17n };
    const lower = play({ ...base, bestDay: base.day, bestScore: U64_MAX }, base.wave, 0n, 0n).state;
    expect(lower.done).toBe(true); expect(lower.won).toBe(true); expect(lower.bestScore).toBe(U64_MAX);
    const higher = play({ ...base, bestDay: base.day, bestScore: 1n }, base.wave, 0n, 0n).state;
    expect(higher.bestScore).toBe(higher.score); expect(higher.bestDay).toBe(base.day);
    const newDay = play({ ...base, bestDay: base.day - 1n, bestScore: U64_MAX }, base.wave, 0n, 0n).state;
    expect(newDay.bestScore).toBe(newDay.score); expect(newDay.bestDay).toBe(base.day);
    expect(higher.score).toBe(100n * C.WAVES + 10n * higher.walls + higher.gold);
  });
  it('keeps records untouched before the run ends and updates them on death', () => {
    const s = { ...fresh(), bestDay: 2n, bestScore: 999n };
    expect(play(s, 0n, 0n, 0n).state).toMatchObject({ bestDay: 2n, bestScore: 999n, done: false });
    const death = play({ ...s, wave: C.WAVES - 1n, walls: 1n, grid: 0n }, C.WAVES - 1n, 0n, 0n).state;
    expect(death.bestDay).toBe(s.day); expect(death.bestScore).toBe(death.score);
  });
});

describe('search kernel and bots against the bigint reference', () => {
  it('agrees on 200 random full boards and every one of 48 next actions', () => {
    const random = seededRandom(12345);
    for (let i = 0; i < 200; i++) {
      let g = 0n;
      for (let cell = 0; cell < 16; cell++) g = setPart(g, BigInt(cell), BigInt(Math.floor(random() * 7)));
      const d = prepareDay(20000n + BigInt(i)), w = i % Number(C.WAVES);
      const s = { ...fresh(d.day), grid: g, walls: 10000n, gold: BigInt(i), wave: BigInt(w) };
      expect(gridOf(boardOf(g))).toBe(g);
      expect(bigintSurvey(fastSurvey(boardOf(g), d.rules))).toEqual(survey(g));
      for (const m of legalMoves(d, w, false)) {
        const actual = play(s, s.wave, BigInt(m.pick), BigInt(m.cell)).state;
        const fast = step(positionOf(s), w, m, d);
        expect(gridOf(fast)).toBe(actual.grid);
        expect(BigInt(fast.walls)).toBe(actual.walls); expect(BigInt(fast.gold)).toBe(actual.gold);
        expect(gridOf(place(boardOf(g), m.cell, d.waves[w].offers[m.pick]))).toBe(actual.grid);
      }
    }
  });
  it('all four bots produce legal, deterministic complete reference runs', () => {
    for (const bot of ['random', 'greedy', 'heuristic', 'expert'] as const) {
      const run = runBot(20123n, bot, { width: 12 });
      expect(run.state.done).toBe(true); expect(run.moves).toHaveLength(Number(run.state.wave));
      expect(runBot(20123n, bot, { width: 12 }).state).toEqual(run.state);
    }
  });
});
