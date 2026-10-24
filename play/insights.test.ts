import { describe, expect, it } from 'vitest';
import { LIMITS, PART } from '../src/v1/constants.js';
import { applyAction, fight, newRun, shop, withPart } from '../src/v1/sim.js';
import { InvestmentCache, enemyDetails, enemyNumbers, laneCauses, replayStart } from './insights.js';
import { makeTimeline } from './replay.js';
import { LocalBackend } from './backend.js';
import { BuildQueue } from './queue.js';

describe('investment forecasts and battle lessons', () => {
  it('projects exact settlements on copies, caches repeats, and separates candidate purchases', () => {
    const start = { ...newRun(20748n, 'practice'), gold: 100n };
    const frozen = { ...start };
    const cache = new InvestmentCache();
    const baseline = cache.project(start);
    expect(cache.project({ ...start })).toBe(baseline);
    expect(start).toEqual(frozen);
    let state = start;
    for (const wave of baseline) {
      const expected = fight({ ...state });
      expect(wave).toEqual(expected); state = expected.state;
    }
    expect(baseline.length).toBeLessThanOrEqual(3);
    const quarry = shop(start).find(o => o.part === PART.QUARRY);
    const candidate = quarry ? applyAction(start, { type: 'buy', cell: 0n, slot: quarry.slot })
      : withPart(start, 0n, PART.QUARRY, 1n);
    const projection = cache.project(candidate);
    expect(projection).not.toBe(baseline);
    expect(projection[0]).toEqual(fight(candidate));
    expect(cache.project(start)).toBe(baseline);
    const final = { ...candidate, wave: BigInt(LIMITS.WAVES - 1) };
    expect(cache.project(final)).toHaveLength(1);
    expect(cache.project(fight(final).state)).toHaveLength(0);
  });

  it('connects a trampled support to lost damage in another lane using resolved frames', () => {
    let built = { ...newRun(20748n, 'practice'), wave: 9n };
    for (let lane = 0n; lane < 4n; lane++) built = withPart(built, lane * 4n + 1n, PART.BALLISTA, 2n);
    built = withPart(built, 13n, PART.WATCHTOWER, 2n);
    const timeline = makeTimeline(built, fight(built).frames);
    const trample = timeline.find(s => s.frame.tramples.some(t => t.cell === 13n))!;
    expect(trample).toBeDefined();
    const causes = laneCauses(built, timeline, 0n);
    const support = causes.find(c => c.kind === 'trample' && c.text.includes('Watchtower'))!;
    expect(support.tick).toBe(trample.frame.tick);
    expect(support.text).toContain('Ballista');
    expect(support.text).toContain('range shrinks');
    const start = replayStart(timeline, causes);
    expect(start).toBe(Math.max(0, Number(causes.find(c => c.kind === 'trample' || c.kind === 'break' || c.kind === 'hit')!.tick) - 1));
    expect(start).toBeLessThan(timeline.length);
  });

  it('shows the actual survivor, leak, bite and bounty, without mutating replay state', () => {
    const built = newRun(20748n, 'practice'), snapshot = { ...built };
    const result = fight(built), timeline = makeTimeline(built, result.frames);
    const step = timeline.find(s => s.frame.leaks.length)!;
    const leak = step.frame.leaks[0], group = step.frame.groups.find(g => g.id === leak.group)!;
    const causes = laneCauses(built, timeline, group.lane, group.id);
    expect(causes.at(-1)?.tick).toBe(step.frame.tick);
    expect(causes.at(-1)?.text).toContain(`−${leak.damage} walls`);
    expect(enemyDetails(group)).toContain(`bite ${group.bite}`);
    expect(enemyDetails(group)).toContain(`leak ${group.leak}`);
    expect(built).toEqual(snapshot);
  });

  it('states unit HP literally and separates an injured first unit from the others', () => {
    const group = fight(newRun(13n, 'practice')).frames[0].groups[0];
    expect(enemyNumbers({ ...group, count: 2n, hp: 39n, bodyHp: 39n, maxHp: 40n }))
      .toBe('2 units · 39 HP each · 78 HP total');
    expect(enemyNumbers({ ...group, count: 2n, hp: 12n, bodyHp: 39n, maxHp: 40n }))
      .toBe('2 units · 39 HP each · 51 HP total · front ♥12');
    expect(enemyNumbers({ ...group, count: 2n, hp: 2n, bodyHp: 2n, maxHp: 2n }))
      .toBe('2 units · 2 HP each · 4 HP total');
  });
});

it('keeps boss HP progress when an upgrade leaves the wall-loss forecast unchanged', () => {
  let start = { ...newRun(4n, 'practice'), wave: 4n, gold: 100n };
  for (let lane = 0n; lane < 4n; lane++) start = withPart(start, lane * 4n + 2n, PART.PALISADE, 3n);
  start = withPart(start, 12n, PART.CAULDRON, 2n);
  const after = applyAction(start, { type: 'upgrade', cell: 12n });
  const comparison = new InvestmentCache().compare(start, after);
  expect(fight(start).summary.damage).toBe(fight(after).summary.damage);
  expect(comparison.before.walls).toBe(comparison.after.walls);
  expect(comparison.before.boss).toBe(50n);
  expect(comparison.after.boss).toBe(48n);
  expect(comparison.after.gold).toBeLessThan(comparison.before.gold);
  expect(comparison.after.actions).toBe(comparison.before.actions + 1n);
  expect(comparison.after.income).toBe(fight(after).state.gold - after.gold);
});

it('orders the wave-five last shot before same-tick trample and storm for each survivor', () => {
  let built = { ...newRun(13n, 'practice'), wave: 4n };
  for (const [cell, part, tier] of [
    [0n, PART.FORGE, 2n], [1n, PART.BALLISTA, 2n], [4n, PART.CAULDRON, 1n],
    [5n, PART.PALISADE, 1n], [8n, PART.FORGE, 1n], [9n, PART.BALLISTA, 2n],
    [10n, PART.PALISADE, 1n], [12n, PART.CAULDRON, 1n], [13n, PART.PALISADE, 1n],
  ]) built = withPart(built, cell, part, tier);
  const timeline = makeTimeline(built, fight(built).frames);
  const brute = laneCauses(built, timeline, 3n, 13n);
  const final = brute.filter(c => c.tick === 10n);
  expect(final.map(c => c.phase)).toEqual(['Fire', 'Fire', 'Move', 'Storm']);
  expect(final.find(c => c.kind === 'hit')?.text).toContain('dealt 1 HP; Brute remains at 5 HP');
  expect(final.find(c => c.kind === 'trample')?.text).toContain('(after its last shot)');
  expect(final.at(-1)?.text).toContain('−3 walls');
  const boss = laneCauses(built, timeline, 1n, 5n);
  expect(boss.at(-1)?.text).toContain('Gatebreaker: 34/54');
  expect(boss.at(-1)?.text).toContain('−7 walls');
  expect(boss.some(c => c.text.includes('Brute'))).toBe(false);
});

it('resumes an exact pre-build shop in an isolated backend without changing the completed run', async () => {
  const completed = new LocalBackend(4n, 'practice');
  const start = completed.state;
  const action = { type: 'buy' as const, slot: 2n, cell: 2n };
  await completed.playTurn([action, { type: 'reroll' }]);
  const settled = completed.state;
  const branch = new LocalBackend(start.seed, 'practice', start);
  const orders = new BuildQueue(branch.state);
  expect(branch.state).toEqual(start);
  expect(branch.shop()).toEqual(shop(start));
  expect(orders.actions).toEqual([]);
  expect(orders.state.actionsUsed).toBe(0n);
  const result = await branch.playTurn([action]);
  expect(result.state).toEqual((await new LocalBackend(start.seed, start.mode).playTurn([action])).state);
  expect(completed.state).toEqual(settled);
  expect(start).toEqual(newRun(4n, 'practice'));
});

it('explains the last applied hit and distinguishes a storm past a standing wall', () => {
  let built = { ...newRun(4n, 'practice'), wave: 9n };
  for (let lane = 0n; lane < 4n; lane++) {
    built = withPart(built, lane * 4n, PART.BALLISTA, 1n);
    built = withPart(built, lane * 4n + 1n, PART.CAULDRON, 1n);
    built = withPart(built, lane * 4n + 2n, PART.PALISADE, 3n);
  }
  const timeline = makeTimeline(built, fight(built).frames);
  const leaks = timeline.flatMap(s => s.frame.leaks);
  expect(leaks.length).toBeGreaterThan(0);
  const chains = leaks.map(leak => laneCauses(built, timeline, leak.lane, leak.group));
  const hitChain = chains.find(c => c.some(e => e.kind === 'hit' && e.text.startsWith('Last damaging hit:')))!;
  expect(hitChain).toBeDefined();
  const hit = hitChain.find(c => c.kind === 'hit')!;
  const step = timeline.find(s => s.frame.tick === hit.tick)!;
  const prior = step.before.find(g => g.id === hit.group)!, next = step.frame.groups.find(g => g.id === hit.group)!;
  const hp = (g: typeof prior) => g.count ? g.hp + (g.count - 1n) * g.bodyHp : 0n;
  expect(hit.text).toContain(`dealt ${hp(prior) - hp(next)} HP`);
  expect(replayStart(timeline, hitChain)).toBeLessThanOrEqual(Number(hit.tick) - 1);

  let blocked = { ...newRun(4n, 'practice'), wave: 9n };
  for (let cell = 0n; cell < 16n; cell++) blocked = withPart(blocked, cell, PART.PALISADE, 3n);
  const frames = makeTimeline(blocked, fight(blocked).frames);
  expect([0n, 1n, 2n, 3n].flatMap(lane => laneCauses(blocked, frames, lane)).some(c => c.text.includes('past a standing Palisade'))).toBe(true);
});
