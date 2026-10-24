import { describe, expect, it, vi, afterEach } from 'vitest';
import { C, PART as P } from '../src/v1/constants.js';
import { fight, forecast, newRun, withPart, type EnemyGroup } from '../src/v1/sim.js';
import { groupHp } from './insights.js';
import { hitSnapshot, makeTimeline } from './replay.js';
import { battleLanes, biteTotals, foeSlots, groupsAt, hitReadouts, incomingSlots, incomingTick, leakCause, actionRows, popPlacement, replacePop, scoreRows, tileReadout, verdictPreview, payout, type Pop } from './ui/model.js';
import { pieceMarkup } from './ui/board.js';
import { frameLog } from './ui/battle.js';
import { auditLabelBoxes, type LabelBox } from './ui/layout.js';
import { inspectorMarkup } from './ui/inspector.js';

const group = (id: number, kind: EnemyGroup['kind'] = 'swarm'): EnemyGroup => ({
  ...forecast(newRun(13n, 'practice')).waves[0].lanes.flat()[0], id: BigInt(id), order: BigInt(id), lane: 0n, pos: 4n, status: 'active', kind,
});
afterEach(() => vi.unstubAllGlobals());
describe('fixed cell slots', () => {
  it('keeps all four groups visible in stable order', () => {
    const groups = [group(3), group(1), group(2), group(0)];
    expect(foeSlots(groups).slots.map(g => g.id)).toEqual([0n, 1n, 2n, 3n]);
    expect(foeSlots(groups).folded.map(g => g.id)).toEqual([]);
    expect(groups[0].id).toBe(3n);
  });
  it('keeps the boss and other groups together without folding', () => {
    const slots = foeSlots([group(0), group(1), group(2, 'boss'), group(3)]);
    expect(slots.slots.map(g => g.kind)).toEqual(['swarm', 'swarm', 'boss', 'swarm']);
    expect(slots.folded).toHaveLength(0);
  });
  it('never shows queued, dead, leaked, other-lane or other-depth groups in a cell', () => {
    expect(groupsAt([group(0), { ...group(1), pos: 3n }, { ...group(2), lane: 1n }, { ...group(3), status: 'dead' }], 3n).map(g => g.id)).toEqual([0n]);
  });
  it('replaces one pop per chip and leaves other cell slots alone', () => {
    const first: Pop = { key: 'a', cell: 3n, slot: 0, text: '−4', kind: '' };
    const other = { ...first, key: 'b', slot: 1 };
    const next = { ...first, key: 'c', text: '−8' };
    expect(replacePop([first, other], next)).toEqual([other, next]);
    expect(replacePop([first], { ...next, cell: 7n })).toHaveLength(2);
  });
  it('lays out all four incoming groups with its boss visible', () => {
    const groups = [group(0), group(1), group(2), group(3, 'boss')];
    const slots = incomingSlots(groups);
    expect(slots).toHaveLength(4); expect(slots[3].group.kind).toBe('boss'); expect(slots.every(s => !s.more && !s.folded.length)).toBe(true);
    expect(incomingSlots(groups.slice(0, 2)).every(s => !s.more)).toBe(true);
  });
  it('shows entry ticks with a clock, never a tier prefix', () => expect(incomingTick(2n)).toBe('◷2'));
  it('shows last two of six orders and counts hidden orders', () => {
    const start = newRun(13n, 'practice');
    const actions = [{ type: 'buy' as const, slot: 2n, cell: 2n }, { type: 'sell' as const, cell: 2n }, { type: 'reroll' as const }, { type: 'buy' as const, slot: 2n, cell: 2n }, { type: 'sell' as const, cell: 2n }, { type: 'reroll' as const }];
    const rows = actionRows(start, actions);
    expect(rows.recent.map(r => r.number)).toEqual([5, 6]); expect(rows.more).toBe(4); expect(rows.all).toHaveLength(6);
    expect(actionRows(start, []).recent).toEqual([]);
  });
  it('shows a verdict before and after the proposed placement, including unchanged leaks', () => {
    expect(verdictPreview({ leaks: 3n }, { leaks: 0n })).toEqual({ kind: 'hold', text: 'Holds', was: '−3' });
    expect(verdictPreview({ leaks: 8n }, { leaks: 8n }).was).toBeNull();
    expect(verdictPreview({ leaks: 0n }, { leaks: 5n }).text).toBe('Leaks −5');
  });
});

describe('combat regressions from real sim frames', () => {
  const filled = (wave: bigint) => {
    let state = { ...newRun(13n, 'practice'), wave };
    for (let lane = 0n; lane < 4n; lane++) {
      state = withPart(state, lane * 4n, P.BALLISTA, 3n);
      state = withPart(state, lane * 4n + 1n, P.FORGE, 3n);
      state = withPart(state, lane * 4n + 2n, P.BALLISTA, 3n);
      state = withPart(state, lane * 4n + 3n, P.PALISADE, 3n);
    }
    return state;
  };
  it('keeps a broken Palisade through settlement, then heals on the next build', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const state = withPart({ ...newRun(3n, 'practice'), wave: 4n }, 10n, P.PALISADE, 1n), result = fight(state);
    const broken = result.frames.find(f => f.palisades.some(p => p.cell === 10n && p.hp === 0n))!;
    expect(broken).toBeDefined(); expect(tileReadout(state, 10n, broken).broken).toBe(true);
    expect(pieceMarkup(state, 10n, broken)).toContain('fence broken');
    expect(pieceMarkup(state, 10n, result.frames.at(-1))).toContain('0/16');
    expect(pieceMarkup(result.state, 10n)).toContain('16/16');
    expect(pieceMarkup(result.state, 10n)).not.toContain('fence broken');
  });
  it('labels trampled parts Off and preserves their code until next wave', () => {
    const state = withPart(newRun(13n, 'practice'), 3n, P.FORGE, 1n), result = fight(state);
    const trampled = result.frames.find(f => f.disabled & (1n << 3n))!;
    expect(trampled).toBeDefined(); expect(tileReadout(state, 3n, trampled).off).toBe(true);
    expect(pieceMarkup(state, 3n, trampled)).toContain('Off');
    expect(tileReadout(result.state, 3n).off).toBe(false);
  });
  it('includes deep Quarry gold once and pays nothing when trampled', () => {
    const safe = withPart(newRun(13n, 'practice'), 3n, P.QUARRY, 2n); // this Quarry is exposed
    const lost = fight(safe), last = lost.frames.at(-1)!;
    expect(tileReadout(safe, 3n).stats.income).toBe(C.QUARRY_GOLD * 2n + C.QUARRY_DEEP);
    expect(tileReadout(safe, 3n, last).pill).toBe('0g · Off');
    const quiet = withPart(newRun(13n, 'practice'), 14n, P.QUARRY, 2n); // inactive opening lane
    const result = fight(quiet), gold = result.frames.flatMap(f => f.goldEvents).filter(g => g.reason === 'quarry').reduce((n, g) => n + g.amount, 0n);
    expect(result.summary.deepQuarry).toBe(C.QUARRY_DEEP);
    expect(result.summary.quarry).toBe(C.QUARRY_GOLD * 2n + C.QUARRY_DEEP);
    expect(gold).toBe(result.summary.quarry);
    expect(payout(result.summary)).toBe(result.state.gold - quiet.gold);
  });
  it.each([4n, 9n])('keeps applied HP, shield/armor, kills and boss bounty exact (wave %s)', wave => {
    const state = filled(wave), result = fight(state), timeline = makeTimeline(state, result.frames);
    let tested = 0;
    for (const step of timeline) for (const h of hitReadouts(step)) {
      const before = step.before.find(g => g.id === h.group)!, after = step.frame.groups.find(g => g.id === h.group)!;
      expect(h.applied).toBe(groupHp(before) - groupHp(after));
      expect(h.blockedBolt).toBe(step.frame.mitigations?.find(m => m.group === h.group)?.ballista ?? 0n);
      expect(h.blockedSplash).toBe(step.frame.mitigations?.find(m => m.group === h.group)?.splash ?? 0n);
      expect(h.bounty).toBe(step.frame.kills.filter(k => k.group === h.group).reduce((n, k) => n + k.bounty, 0n));
      tested++;
    }
    expect(tested).toBeGreaterThan(0);
    if (wave === 4n) {
      const boss = forecast(state).waves[0].lanes.flat().find(g => g.kind === 'boss')!;
      const kill = timeline.flatMap(hitReadouts).find(h => h.group === boss.id && h.bounty);
      expect(kill?.bounty).toBe(C.BOSS_BOUNTY);
      expect(timeline.flatMap(step => frameLog(step, state)).some(l => l.text === 'Boss bounty' && l.value === '+8g')).toBe(true);
    } else expect(timeline.flatMap(hitReadouts).some(h => h.blockedBolt > 0n)).toBe(true);
  });
  it('aggregates every bite on each fence, including recovery ticks with zero damage', () => {
    const state = filled(9n), timeline = makeTimeline(state, fight(state).frames);
    let bites = 0;
    for (const step of timeline) for (const [cell, total] of biteTotals(step.frame)) {
      expect(total).toBe(step.frame.bites.filter(b => b.cell === cell).reduce((sum, b) => sum + b.damage, 0n)); bites++;
    }
    expect(bites).toBeGreaterThan(0);
    expect(biteTotals({ bites: [{ cell: 5n, group: 1n, damage: 3n }, { cell: 5n, group: 2n, damage: 2n }, { cell: 5n, group: 3n, damage: 0n }] }).get(5n)).toBe(5n);
  });
  it('uses real inspector prices, arithmetic and walls deltas', () => {
    const state = withPart(withPart(newRun(13n, 'practice'), 0n, P.BALLISTA, 2n), 1n, P.FORGE, 2n);
    const html = inspectorMarkup(state, 0n);
    expect(html).toContain('7g'); expect(html).toContain('>+5g<'); expect(html).toContain('Base 4 × tier 2'); expect(html).toContain('16 dmg'); expect(html).toContain('Compare walls left after'); expect(html).toMatch(/class="walls-delta">walls lost \d+ → \d+<\/small>/);
    const oc = inspectorMarkup({ ...state, gold: 100n, parts: withPart(state, 0n, P.BALLISTA, 3n).parts, tiers: withPart(state, 0n, P.BALLISTA, 3n).tiers }, 0n);
    expect(oc).toContain('8g'); expect(oc).toContain('+12 dmg');
  });
});

describe('RD2 seed 13 wave 5 regression', () => {
  let built = { ...newRun(13n, 'practice'), wave: 4n };
  for (const [cell, part, tier] of [[0n, P.FORGE, 2n], [1n, P.BALLISTA, 2n], [4n, P.CAULDRON, 1n], [5n, P.PALISADE, 1n], [8n, P.FORGE, 1n], [9n, P.BALLISTA, 2n], [10n, P.PALISADE, 1n], [12n, P.CAULDRON, 1n], [13n, P.PALISADE, 1n]]) built = withPart(built, cell, part, tier);
  const result = fight(built), timeline = makeTimeline(built, result.frames), step = timeline[4];
  it('maps killed Swarm and surviving Brute to separate explicit pop columns', () => {
    const hits = hitReadouts(step).filter(h => h.cell === 14n);
    expect(hits.map(h => [h.applied, h.kills])).toEqual([[3n, 3n], [1n, 0n]]);
    expect(groupsAt(hitSnapshot(step), 14n).map(g => g.kind)).toEqual(['brute']);
    const placements = hits.map(h => popPlacement(step.before, h.cell, h.group));
    expect(placements).toEqual([{ slot: 0, column: '1' }, { slot: 1, column: '2' }]);
    const pops = hits.map((h, i) => ({ key: String(h.group), cell: h.cell, ...placements[i], group: h.group, text: `−${h.applied}`, kind: 'splash' }));
    // Brute's bite replaces its own hit; the dead Swarm's pop keeps column one.
    const next = { ...pops[1], text: '−3', kind: 'bite' };
    expect(replacePop(pops, next)).toEqual([pops[0], next]);
    const later = timeline[5], hit = hitReadouts(later).find(h => h.group === hits[1].group)!;
    expect(popPlacement(later.before, hit.cell, hit.group)).toEqual({ slot: 0, column: '1 / -1' });
  });
  it('spans singleton pops and keeps each stacked group in its own slot', () => {
    expect(popPlacement([group(0)], 3n, 0n)).toEqual({ slot: 0, column: '1 / -1' });
    expect(popPlacement([group(0), group(1, 'boss')], 3n, 1n)).toEqual({ slot: 1, column: '2' });
    expect(popPlacement([group(0), group(1), group(2)], 3n, 2n)).toEqual({ slot: 2, column: '3' });
  });
  it('logs rest and armour accurately, with remaining fence HP and named kills', () => {
    const lines = frameLog(step, built);
    expect(lines).toContainEqual({ tick: 5n, text: 'Gatebreaker rests (odd tick)', value: '' });
    expect(lines.some(l => l.value.includes('−0'))).toBe(false);
    expect(lines).toContainEqual({ tick: 5n, text: 'Brute armour blocks 1 splash', value: '' });
    expect(lines).toContainEqual({ tick: 5n, text: 'L4 Brute bites the fence', value: '10/16' });
    expect(lines).toContainEqual({ tick: 5n, text: 'L4 Cauldron kills Swarm ×3', value: '2 dmg', kills: 3n });
    expect(frameLog(timeline[5], built).some(l => l.text === 'Gatebreaker rests (odd tick)')).toBe(false);
  });
  it('uses current cumulative battle losses and kills rather than the build projection', () => {
    expect(battleLanes(built, null).every(l => l.leaks === 0n && l.kills === 0n)).toBe(true);
    const lanes = battleLanes(built, result.frames.at(-1)!);
    expect(lanes.map(l => [l.leaks, l.kills])).toEqual(result.summary.lanes.map(l => [l.damage, l.kills]));
    expect(leakCause(result.frames.at(-1)!.groups, 1n)).toBe('Gatebreaker gets through');
    expect(leakCause([{ ...group(0), status: 'leaked', count: 2n }], 0n)).toBe('2 Swarm get through');
    expect(leakCause([{ ...group(0, 'brute'), status: 'leaked', count: 1n }], 0n)).toBe('1 Brute gets through');
  });
});

describe('score points', () => {
  it.each([0n, 4n, 9n])('rows sum to settled score, including loss at wave %s', wave => {
    const result = fight({ ...newRun(13n, 'practice'), wave });
    expect(scoreRows(result.state).reduce((n, row) => n + row.points, 0n)).toBe(result.state.score);
    expect(scoreRows(result.state).map(r => r.weight)).toEqual([C.SCORE_WAVE, C.SCORE_WALL, C.SCORE_KILL]);
  });
});

describe('smoke label geometry', () => {
  const cell = { left: 0, top: 0, right: 82, bottom: 74 };
  const label = (name: string, top: number, bottom: number, pop = false): LabelBox => ({ name, cell: '3', pop, bounds: { left: 4, right: 78, top, bottom } });
  it('accepts separate slots and at most two pixels of border intersection', () => {
    expect(auditLabelBoxes([label('pop', 1, 23, true), label('foe', 24, 46), label('pill', 47, 65)], { 3: cell })).toEqual([]);
    expect(auditLabelBoxes([label('a', 0, 24), label('b', 23, 45)], {})).toEqual([]);
    expect(auditLabelBoxes([label('a', 0, 25), label('b', 23, 45)], {})).toEqual([]);
  });
  it('catches pop/chip/pill overlap beyond the border tolerance', () => expect(auditLabelBoxes([label('pop', 1, 26, true), label('foe', 23, 48)], { 3: cell })[0]).toContain('overlaps'));
  it('rejects pops in adjacent cells or outside their own bounds', () => {
    expect(auditLabelBoxes([label('pop', -2, 20, true)], { 3: cell })[0]).toContain('own cell');
    expect(auditLabelBoxes([{ ...label('pop', 1, 23, true), cell: '7' }], { 3: cell })[0]).toContain('own cell');
  });
});
