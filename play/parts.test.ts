import { describe, expect, it } from 'vitest';
import { C, PART } from '../src/v1/constants.js';
import { fight, newRun, withPart } from '../src/v1/sim.js';
import { quarryArithmetic, ruleCopy, statPill, statsAt } from './parts.js';

describe('weapon numbers shown on the board', () => {
  it('matches capped simulator damage under stacked Forge and Watchtower buffs', () => {
    for (const weapon of [PART.BALLISTA, PART.CAULDRON]) {
      let state = withPart(newRun(20748n, 'practice'), 5n, weapon, 3n);
      for (const cell of [1n, 4n, 6n, 9n]) state = withPart(state, cell, PART.FORGE, 3n);
      state = withPart(state, 13n, PART.WATCHTOWER, 3n);
      const stats = statsAt(state, 5n);
      const result = fight(state);
      const damage = result.frames.flatMap(f => weapon === PART.BALLISTA
        ? f.shots.filter(e => e.from === 5n).map(e => e.damage)
        : f.splashes.filter(e => e.from === 5n).flatMap(e => e.targets.map(t => t.damage)));
      expect(damage.length).toBeGreaterThan(0);
      expect(damage[0]).toBe(stats.value);
      expect(stats.value).toBeLessThanOrEqual(weapon === PART.BALLISTA ? C.BALLISTA_CAP : C.CAULDRON_CAP);
    }
  });

  it('drops disabled support from damage and backward range', () => {
    let state = withPart(newRun(20748n, 'practice'), 5n, PART.BALLISTA, 2n);
    state = withPart(state, 4n, PART.FORGE, 3n);
    state = withPart(state, 13n, PART.WATCHTOWER, 2n);
    const active = statsAt(state, 5n), disabled = statsAt(state, 5n, (1n << 4n) | (1n << 13n));
    expect(active.value).toBe((C.BALLISTA_DAMAGE + 3n * C.FORGE_BALLISTA + 2n * C.WATCH_DAMAGE) * 2n);
    expect(disabled.value).toBe(C.BALLISTA_DAMAGE * 2n);
    expect(disabled.low).toBe(2);
    expect(active.low).toBe(1);
  });
});

describe('live Quarry income', () => {
  it('drops lost adjacency at trample and matches recorded simulator settlement at every tier', () => {
    for (const tier of [1n, 2n, 3n]) {
      let state = withPart(newRun(20748n, 'practice'), 1n, PART.BALLISTA, 3n);
      state = withPart(state, 2n, PART.QUARRY, tier);
      state = withPart(state, 3n, PART.QUARRY, 1n);
      const initial = statsAt(state, 2n), result = fight(state);
      expect(initial.income).toBe(C.QUARRY_GOLD * tier + C.QUARRY_ADJACENT + C.QUARRY_DEEP);
      expect(statPill(initial)).toBe(`${initial.income}g/wave total`);
      expect(quarryArithmetic(initial)).toBe(`${C.QUARRY_GOLD * tier} base + 1 adjacent + 1 deep = ${initial.income}g/wave`);
      const trample = result.frames.findIndex(f => f.tramples.some(t => t.cell === 3n));
      expect(trample).toBeGreaterThan(0);
      expect(statsAt(state, 2n, result.frames[trample - 1].disabled).income).toBe(initial.income);
      for (const frame of result.frames.slice(trample)) {
        expect(statsAt(state, 2n, frame.disabled).income).toBe(initial.income - C.QUARRY_ADJACENT);
        const lost = statsAt(state, 3n, frame.disabled);
        expect(lost.income).toBe(0n);
        expect(lost.deepIncome).toBe(0n);
        expect(statPill(lost)).toBe('0g this wave · trampled');
        expect(quarryArithmetic(lost)).toBe('0g this wave · trampled');
      }
      const final = result.frames.at(-1)!;
      const shown = [2n, 3n].reduce((sum, cell) => sum + statsAt(state, cell, final.disabled).income, 0n);
      expect(shown).toBe(result.summary.quarry);
      expect(shown).toBe(final.goldEvents.filter(e => e.reason === 'quarry').reduce((sum, e) => sum + e.amount, 0n));
    }
  });

  it('counts only active orthogonal Quarries across lanes and states included deep income in shop copy', () => {
    let state = withPart(newRun(3n, 'practice'), 2n, PART.QUARRY, 2n);
    for (const cell of [1n, 3n, 6n, 7n]) state = withPart(state, cell, PART.QUARRY, 3n);
    expect(statsAt(state, 2n).income).toBe(8n);
    expect(quarryArithmetic(statsAt(state, 2n, (1n << 1n) | (1n << 6n))))
      .toBe('4 base + 1 adjacent + 1 deep = 6g/wave');
    expect(statPill(statsAt(state, 1n))).toBe('7g/wave total');
    expect(ruleCopy(PART.QUARRY)).toContain('+1g at D3-D4');
  });
});
