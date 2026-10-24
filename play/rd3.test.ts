import { describe, expect, it } from 'vitest';
import { PART as P } from '../src/v1/constants.js';
import { applyAction, fight, forecast, newRun, withPart } from '../src/v1/sim.js';
import { enemyNumbers, enemyDetails } from './insights.js';
import { makeTimeline, playTimeline } from './replay.js';
import { assignGroupSlots, bossSavings, chipText, incomingSlots, liveVerdict, actionRows, popPlacement } from './ui/model.js';
import { planComparison } from './ui/compare.js';
import { causeOrder, costliestCause, lossReport } from './ui/loss-report.js';
import { replanComparison } from './ui/screens.js';

function rd2Wave5() {
  let built = { ...newRun(13n, 'practice'), wave: 4n };
  for (const [cell, part, tier] of [[0n, P.FORGE, 2n], [1n, P.BALLISTA, 2n], [4n, P.CAULDRON, 1n], [5n, P.PALISADE, 1n], [8n, P.FORGE, 1n], [9n, P.BALLISTA, 2n], [10n, P.PALISADE, 1n], [12n, P.CAULDRON, 1n], [13n, P.PALISADE, 1n]]) built = withPart(built, cell, part, tier);
  const result = fight(built);
  return { start: built, built, result, timeline: makeTimeline(built, result.frames) };
}

describe('RD3 replay clock', () => {
  it('drives every active phase from its own duration, halves at 2× and skips the empty tail', async () => {
    let built = newRun(13n, 'practice');
    for (let lane = 0n; lane < 4n; lane++) built = withPart(built, lane * 4n + 1n, P.CAULDRON, 3n);
    const timeline = makeTimeline(built, fight(built).frames);
    expect(timeline.some(s => s.duration === 0)).toBe(true);
    for (const speed of [1, 2]) {
      const calls: string[] = [], waits: number[] = [];
      await playTimeline(timeline, () => speed, () => false, (step, phase, ms) => {
        expect(ms).toBe(step.phases[phase] / speed); calls.push(`${step.frame.tick}:${phase}`);
      }, async ms => { waits.push(ms); });
      expect(calls).toEqual(timeline.filter(s => s.duration).flatMap(s => Object.entries(s.phases).filter(([, ms]) => ms).map(([phase]) => `${s.frame.tick}:${phase}`)));
      expect(waits.reduce((a, b) => a + b, 0)).toBe(timeline.reduce((n, s) => n + s.duration, 0) / speed);
      const finalKill = timeline.findIndex(s => s.frame.kills.length && s.frame.groups.every(g => g.status !== 'queued' && g.status !== 'active'));
      expect(timeline[finalKill].phases.hit + timeline.slice(finalKill + 1).reduce((n, s) => n + s.duration, 0)).toBeLessThanOrEqual(640);
    }
  });
  it('gives active volleys readable contact windows and lets Skip cut the next phase', async () => {
    const { timeline } = rd2Wave5();
    const mid = timeline.find(s => s.frame.tick === 6n)!;
    expect(mid.duration).toBeGreaterThanOrEqual(750); expect(mid.duration).toBeLessThanOrEqual(1600);
    let skip = false; const seen: string[] = [];
    await playTimeline(timeline, () => 1, () => skip, (_, phase) => { seen.push(phase); skip = true; }, async () => {});
    expect(seen).toEqual(['move']);
  });
});

describe('RD3 quantities and build decisions', () => {
  it('formats unit HP separately from total HP and names an injured front', () => {
    const group = forecast(newRun(13n, 'practice')).waves[0].lanes.flat()[0];
    expect(chipText({ ...group, count: 3n, hp: 1n, bodyHp: 3n })).toBe('3× ♥3');
    expect(chipText({ ...group, count: 1n, hp: 1n, bodyHp: 3n })).toBe('1× ♥1');
    expect(enemyNumbers({ ...group, count: 2n, hp: 2n, bodyHp: 2n })).toBe('2 units · 2 HP each · 4 HP total');
    expect(enemyDetails({ ...group, hp: 1n, bodyHp: 3n })).toContain('front unit 1 of 3 HP');
  });
  it('keeps every real wave-10 entry, including fourth-slot bosses', () => {
    const groups = forecast({ ...newRun(13n, 'practice'), wave: 9n }).waves[0].lanes.flat();
    const boss = groups.find(g => g.kind === 'boss')!;
    const lane = incomingSlots(groups.filter(g => g.lane === boss.lane));
    expect(lane).toHaveLength(4); expect(lane[3].group).toBe(boss);
    expect(lane.every(s => !s.more && !s.folded.length)).toBe(true);
  });
  it('derives every boss saving from integer leakDamage thresholds', () => {
    const boss = forecast({ ...newRun(13n, 'practice'), wave: 4n }).waves[0].lanes.flat().find(g => g.kind === 'boss')!;
    expect(bossSavings(boss)).toBe('54 HP survives → 8 walls · 14 more damage saves 1');
    expect(bossSavings({ ...boss, hp: 27n })).toBe('27 HP survives → 6 walls · 14 more damage saves 1');
  });
  it('shows all three orders, then last two plus the exact hidden count', () => {
    const state = { ...newRun(13n, 'practice'), gold: 100n };
    const commands = Array.from({ length: 4 }, () => ({ type: 'reroll' as const }));
    expect(actionRows(state, commands.slice(0, 3)).recent).toHaveLength(3);
    expect(actionRows(state, commands.slice(0, 3)).more).toBe(0);
    expect(actionRows(state, commands).recent.map(r => r.number)).toEqual([3, 4]);
    expect(actionRows(state, commands).more).toBe(2);
  });
  it('compares this wave and two sequential future waves without mutating the plan', () => {
    const before = { ...newRun(13n, 'practice'), gold: 100n }, after = applyAction(before, { type: 'buy', slot: 0n, cell: 1n });
    const original = { ...before };
    expect(planComparison(before, after)).toMatch(/^Walls after W1 \d+ → \d+ · after W3 \d+ → \d+ · 95g left · 1 action$/);
    expect(before).toEqual(original);
  });
  it('never declares safety with a live or queued enemy in the lane', () => {
    const groups = forecast({ ...newRun(13n, 'practice'), wave: 4n }).waves[0].lanes.flat();
    const boss = groups.find(g => g.kind === 'boss')!, swarm = groups.find(g => g.kind === 'swarm')!;
    for (const status of ['queued', 'active'] as const) {
      expect(liveVerdict(0n, [{ ...boss, status }])).toEqual({ kind: 'hold', text: status === 'active' ? 'Boss in lane' : 'Boss coming' });
      expect(liveVerdict(0n, [{ ...swarm, status }])).toEqual({ kind: 'hold', text: 'Holding' });
    }
    expect(liveVerdict(0n, [])).toEqual({ kind: 'quiet', text: 'No enemies' });
    expect(liveVerdict(7n, [{ ...boss, status: 'leaked' }])).toEqual({ kind: 'leak', text: 'Leaked −8' });
  });
});

describe('RD3b stable group slots', () => {
  const base = forecast(newRun(4n, 'practice')).waves[0].lanes.flat()[0];
  const groups = Array.from({ length: 4 }, (_, i) => ({ ...base, id: BigInt(i), order: BigInt(i) }));
  it('keeps an existing occupant when an earlier-order group spawns into its cell', () => {
    const previous = assignGroupSlots([groups[1]]);
    expect([...assignGroupSlots(groups.slice(0, 2))]).toEqual([[0n, 0], [1n, 1]]);
    expect([...previous]).toEqual([[1n, 1]]);
  });
  it('keeps queue tracks vacant after deaths, independent of history', () => {
    const previous = assignGroupSlots(groups);
    const survivors = [groups[0], groups[2], groups[3]];
    const afterKill = assignGroupSlots(survivors);
    expect([...afterKill]).toEqual([[0n, 0], [2n, 2], [3n, 3]]);
    expect([...assignGroupSlots(groups)]).toEqual([[0n, 0], [1n, 1], [2n, 2], [3n, 3]]);
  });
  it.each([3, 4])('keeps %i groups in their own slots through reordering and departures', count => {
    const occupied = groups.slice(0, count), slots = assignGroupSlots(occupied);
    expect([...assignGroupSlots([...occupied].reverse())]).toEqual([...slots]);
    expect([...assignGroupSlots(occupied.slice(1))]).toEqual([...slots].slice(1));
  });
  it('anchors a surviving group\'s pop to its assigned column after another group dies', () => {
    const group = { ...groups[1], pos: 4n, lane: 0n, status: 'active' as const };
    expect(popPlacement([group], 3n, group.id, new Map([[group.id, 1]]))).toEqual({ slot: 1, column: '2' });
  });
});

describe('RD3 wall-loss reports', () => {
  it('keeps all actual losses, meaningful causes and rule order, with no armour noise', () => {
    const recap = rd2Wave5(), causes = lossReport(recap.built, recap.timeline);
    expect(causes.filter(c => c.kind === 'leak').length).toBeGreaterThan(0);
    expect(causes.some(c => c.kind === 'mitigation' || c.text.includes('armor blocked'))).toBe(false);
    expect([...causes].sort(causeOrder)).toEqual(causes);
    expect(causes.some(c => c.kind === 'break' && c.text.includes('Gatebreaker broke the L2 fence on tick 8'))).toBe(true);
    expect(costliestCause(recap.built, recap.timeline)).toContain('Gatebreaker broke the L2 fence on tick 8');
    expect(costliestCause(recap.built, recap.timeline)).toContain('leaked −7');
    const fire = causes.find(c => c.phase === 'Fire')!;
    expect([{ ...fire, phase: 'Move' as const }, { ...fire, phase: 'Bite' as const }, fire].sort(causeOrder).map(c => c.phase)).toEqual(['Fire', 'Bite', 'Move']);
    const last = recap.timeline.at(-1)!.frame;
    expect(causes.filter(c => c.kind === 'leak').length).toBe(recap.result.frames.flatMap(f => f.leaks).length);
    expect(last.walls).toBe(recap.result.state.walls);
  });
  it('does not attribute standing fences or unrelated Quarries to storm losses', () => {
    let built = { ...newRun(13n, 'practice'), wave: 9n };
    for (let cell = 0n; cell < 16n; cell++) built = withPart(built, cell, P.PALISADE, 3n);
    const causes = lossReport(built, makeTimeline(built, fight(built).frames));
    expect(causes.filter(c => c.kind === 'leak').every(c => c.phase === 'Storm')).toBe(true);
    const standing = fight(built).frames.at(-1)!.palisades.filter(p => p.hp > 0n);
    expect(standing.length).toBeGreaterThan(0);
    for (const p of standing) expect(causes.some(c => c.kind === 'break' && c.text.includes(`L${p.cell / 4n + 1n} fence`) && c.text.includes(`(D${p.cell % 4n + 1n})`))).toBe(false);
  });
  it('colors a replan by actual wall losses', () => {
    const recap = rd2Wave5();
    expect(replanComparison({ ...recap, beforeLoss: 14n })).toContain('better');
    expect(replanComparison({ ...recap, beforeLoss: 1n })).toContain('worse');
    expect(replanComparison({ ...recap, beforeLoss: 10n })).toContain('Before −10 → now −10');
    expect(replanComparison(recap)).toBe('');
  });
});

it('renders four incoming entries as a grid and keeps desktop Tick words beside clocks', async () => {
  const { vi } = await import('vitest');
  const { renderIncoming } = await import('./ui/board.js');
  type Row = { dataset: Record<string, string>; style: Record<string, string>; innerHTML: string; className: string; querySelector: () => null; remove: () => void };
  const lanes = Array.from({ length: 4 }, () => {
    const rows: Row[] = [];
    return { rows, insertAdjacentHTML: vi.fn(), dataset: {}, innerHTML: '', classList: { toggle: vi.fn() }, append: (r: Row) => rows.push(r), querySelectorAll: () => rows,
      querySelector: (selector: string) => rows.find(r => selector === `[data-entry-id="${r.dataset.entryId}"]`) ?? null };
  });
  vi.stubGlobal('document', {
    querySelector: (selector: string) => lanes[Number(selector.match(/data-spawn="(\d+)"/)![1])],
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, style: {}, innerHTML: '', className: '', querySelector: () => null, remove: vi.fn() }),
  });
  try {
    const built = { ...newRun(13n, 'practice'), wave: 9n };
    renderIncoming(built);
    const boss = forecast(built).waves[0].lanes.flat().find(g => g.kind === 'boss')!;
    const lane = lanes[Number(boss.lane)];
    expect(lane.rows).toHaveLength(4);
    expect(lane.classList.toggle).toHaveBeenCalledWith('incoming-grid', true);
    expect(lane.rows[3].innerHTML).toContain('foe boss');
    expect(lane.rows.every(r => r.innerHTML.includes('tick-word">Tick '))).toBe(true);
    expect(lane.rows.every(r => !r.innerHTML.includes('+2 groups'))).toBe(true);
    const layout = lane.rows.map(r => [r.dataset.entryId, r.style.gridColumn, r.style.gridRow]);
    expect(layout.map(r => r.slice(1))).toEqual([['1', '5'], ['2', '4'], ['1', '3'], ['1 / -1', '1']]);
    const groups = forecast(built).waves[0].lanes.flat();
    renderIncoming(built, groups.map(g => g.order === 0n ? { ...g, status: 'active', pos: 4n } : g));
    expect(lane.rows.map(r => [r.dataset.entryId, r.style.gridColumn, r.style.gridRow])).toEqual(layout);
    expect(lane.classList.toggle).toHaveBeenLastCalledWith('incoming-grid', true);
  } finally { vi.unstubAllGlobals(); }
});
