import { expect, it } from 'vitest';
import { PART } from '../src/v1/constants.js';
import { fight, newRun, withPart, type FightResult } from '../src/v1/sim.js';
import { groupLabel, plural, settlementRows, settlementText } from './copy.js';

it('uses singular only for one, for number and bigint counts', () => {
  for (const count of [0, 0n, 2, 2n, 6, 6n]) expect(plural(count, 'kill')).toBe('kills');
  for (const count of [1, 1n]) {
    for (const noun of ['kill', 'unit', 'wall', 'group', 'lane']) expect(plural(count, noun)).toBe(noun);
  }
  expect(plural(1n, 'enemy', 'enemies')).toBe('enemy');
  expect(plural(2n, 'enemy', 'enemies')).toBe('enemies');
});

it('names grouped enemies without a targeting-order suffix', () => {
  const group = fight(newRun(13n, 'practice')).frames[0].groups[0];
  expect(groupLabel({ ...group, kind: 'brute', count: 1n })).toBe('1 Brute');
  expect(groupLabel({ ...group, kind: 'brute', count: 2n })).toBe('2 Brutes');
  expect(groupLabel({ ...group, kind: 'swarm', count: 5n })).toBe('5 Swarm');
  expect(groupLabel({ ...group, kind: 'boss' }, 'Gatebreaker')).toBe('Gatebreaker');
});

it('explains cleared lanes and omits absent income sources', () => {
  const held = { spawned: 2n, kills: 2n, leaks: 0n, damage: 0n, retreats: 0n };
  const summary: FightResult['summary'] = { wave: 1n, lanes: [held, held], kills: 4n,
    damage: 0n, retreats: 0n, income: 5n, clear: 2n, quarry: 0n, salvage: 0n, bounty: 0n };
  expect(settlementText(summary)).toBe('Base +5 · Clean lanes +2 · Total +7g');
  expect(settlementText({ ...summary, lanes: [held], clear: 1n }))
    .toBe('Base +5 · Clean lanes +1 · Total +6g');
  expect(settlementText({ ...summary, clear: 0n })).toBe('Base +5 · Total +5g');
  expect(settlementText({ ...summary, bounty: 1n })).toBe('Base +5 · Clean lanes +2 · Bounty +1 · Total +8g');
  expect(settlementRows({ ...summary, income: 0n, clear: 0n })).toEqual([['Base', 0n]]);
});

it('reconciles settlement with recorded gold, counting deep Quarry gold once', () => {
  let built = { ...newRun(20748n, 'practice'), wave: 4n };
  for (let lane = 0n; lane < 4n; lane++) {
    built = withPart(built, lane * 4n, PART.BALLISTA, 3n);
    built = withPart(built, lane * 4n + 1n, PART.CAULDRON, 3n);
    built = withPart(built, lane * 4n + 2n, PART.QUARRY, 1n);
  }
  const result = fight(built), s = result.summary;
  const recorded = result.frames.flatMap(frame => frame.goldEvents).reduce((sum, event) => sum + event.amount, 0n);
  expect(recorded).toBe(result.state.gold - built.gold);
  expect(s.deepQuarry).toBeGreaterThan(0n);
  expect(s.bounty).toBeGreaterThan(0n);
  const text = settlementText(s);
  expect(text).toContain(`Quarry +${s.quarry - s.deepQuarry!} · Deep Quarry +${s.deepQuarry}`);
  expect(text).toContain(`Bounty +${s.bounty}`);
  expect(text).toContain(`Total +${recorded}g`);
  expect(settlementText({ ...s, salvage: 3n })).toContain('Salvage +3');
  expect(settlementRows(s).reduce((sum, [, amount]) => sum + amount, 0n)).toBe(recorded);
});
