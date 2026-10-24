import { afterEach, describe, expect, it, vi } from 'vitest';
import { C, PART as P } from '../src/v1/constants.js';
import { applyAction, fight, forecast, newRun, withPart } from '../src/v1/sim.js';
import { incomingQuiet, liveVerdict, battleLanes, heavyLane } from './ui/model.js';
import { planComparison } from './ui/compare.js';
import { plural, settlementRows } from './copy.js';
import { frameLog } from './ui/battle.js';
import { makeTimeline } from './replay.js';
import { scoutEnemyCopy } from './teaching.js';
import { scoutMarkup } from './ui/scout.js';

afterEach(() => vi.unstubAllGlobals());
describe('PL1 copy agrees with combat and settlement', () => {
  it('keeps empty entrances, badges and clear-lane gold in agreement', () => {
    const built = withPart(newRun(13n, 'practice'), 1n, P.BALLISTA, 3n), incoming = forecast(built).waves[0].lanes;
    const result = fight(built), groups = result.frames.at(-1)!.groups;
    for (let lane = 0; lane < incoming.length; lane++) {
      const actual = groups.filter(g => g.lane === BigInt(lane));
      if (!incoming[lane].length) {
        expect(incomingQuiet(false)).toBe('No enemies');
        expect(incomingQuiet(false, true)).toBe('No enemies');
        expect(liveVerdict(0n, actual)).toEqual({ kind: 'quiet', text: 'No enemies' });
      } else expect(incomingQuiet(true)).toBe('All entered');
    }
    expect(result.summary.clear).toBe(BigInt(result.summary.lanes.filter(l => l.spawned && l.kills === l.spawned).length) * C.CLEAR_GOLD);
    expect(settlementRows(result.summary)).toContainEqual(['Clean lanes', C.CLEAR_GOLD]);
  });
  it('a good buy never looks worse when later wall losses hit the cap', () => {
    const before = newRun(13n, 'practice'), after = applyAction(before, { type: 'buy', slot: 1n, cell: 1n });
    expect(planComparison(before, after)).toBe('Walls after W1 16 → 18 · after W3 0 → 0 · 9g left · 1 action');
  });
  it.each([1n, 2n])('uses count %s for lane, kill and action plurals', n => {
    expect(`${n} ${plural(n, 'lane')} ${plural(n, 'leaks', 'leak')}`).toBe(n === 1n ? '1 lane leaks' : '2 lanes leak');
    expect(plural(n, 'kill')).toBe(n === 1n ? 'kill' : 'kills');
    expect(plural(n, 'action')).toBe(n === 1n ? 'action' : 'actions');
  });
  it('never reports Leaked before a group reaches the wall, including seed 13 wave 7', () => {
    const built = { ...newRun(13n, 'practice'), wave: 6n }, groups = forecast(built).waves[0].lanes;
    for (const frame of [null, ...fight(built).frames]) {
      battleLanes(built, frame).forEach((row, lane) => {
        const laneGroups = frame?.groups.filter(g => g.lane === BigInt(lane)) ?? groups[lane];
        const text = liveVerdict(row.leaks, laneGroups).text;
        expect(text.startsWith('Leaked')).toBe(laneGroups.some(g => g.status === 'leaked'));
      });
    }
    // A completed prediction passed accidentally cannot paint its losses onto queued groups.
    for (const lane of groups) expect(liveVerdict(10n, lane).text).not.toMatch(/^Leaked/);
  });
  it('labels weapon hits as damage and wall leaks as walls', () => {
    const built = withPart(newRun(13n, 'practice'), 1n, P.BALLISTA, 1n);
    const lines = makeTimeline(built, fight(built).frames).flatMap(s => frameLog(s, built));
    expect(lines.some(l => l.value.endsWith(' dmg'))).toBe(true);
    for (const line of lines.filter(l => / (hits|kills) /.test(l.text))) expect(line.value).toMatch(/^\d+ dmg$/);
    for (const line of lines.filter(l => /reach wall/.test(l.text))) expect(line.value).toMatch(/^−\d+ walls$/);
  });
  it('shows actual Brute HP, counts with HP in Scout, and the current build boss result', () => {
    const state = { ...newRun(13n, 'practice'), wave: 4n };
    const hp = [...new Set(forecast(state).waves.flatMap(w => w.lanes.flat()).filter(g => g.kind === 'brute').map(g => String(g.bodyHp)))];
    for (const n of hp) expect(scoutEnemyCopy(state, 'brute')).toContain(n);
    expect(scoutEnemyCopy(state, 'brute')).not.toContain('9 HP and up');
    const html = scoutMarkup(state);
    expect(html).toContain('With this build:'); expect(html).not.toContain('At full health:');
    expect(html).toMatch(/×<\/span><span>♥/);
    expect(heavyLane(newRun(13n, 'practice'))).toBe(null);
    const heavy = heavyLane({ ...state, wave: 7n })!;
    expect(forecast({ ...state, wave: 7n }).waves[0].lanes[Number(heavy)].filter(g => g.kind === 'brute')[0].bodyHp)
      .toBeGreaterThan(forecast({ ...state, wave: 7n }).waves[0].lanes[Number((heavy + 1n) % 4n)].filter(g => g.kind === 'brute')[0].bodyHp);
  });
});

import { auditLabelBoxes, segmentHitsRect } from './ui/layout.js';
it('models the RD6 charged fence crossing D3 with its measured 19.2×16 overlap', () => {
  expect(auditLabelBoxes([
    { name: 'ruler D3', bounds: { left: 570, top: 400, right: 590, bottom: 416 }, pop: false },
    { name: 'tier-tag T3', bounds: { left: 570.8, top: 400, right: 596, bottom: 416 }, pop: false },
  ], {})).toContain('ruler D3 overlaps tier-tag T3 (19.2×16.0)');
});
it('rejects diagonal or horizontal connectors through text and accepts a route around it', () => {
  const r = { left: 40, top: 40, right: 60, bottom: 60 };
  expect(segmentHitsRect({ x: 0, y: 0 }, { x: 100, y: 100 }, r)).toBe(true);
  expect(segmentHitsRect({ x: 0, y: 50 }, { x: 100, y: 50 }, r)).toBe(true);
  expect(segmentHitsRect({ x: 0, y: 20 }, { x: 100, y: 20 }, r, 2)).toBe(false);
});

import { flashFoeHp, clearHpFlashes } from './ui/board.js';
it.each([false, true])('keeps HP intact and formats the reserved damage cue (compact=%s)', compact => {
  vi.useFakeTimers();
  const rect = { left: 10, top: 100, right: 70, bottom: 120, width: 60, height: 20 };
  const hp = { innerHTML: '<svg></svg>11', textContent: '11' }, pops: { className: string; dataset: Record<string, string>; textContent: string; remove: () => void }[] = [];
  const actor = { dataset: { group: '17' }, classList: { contains: () => compact }, getBoundingClientRect: () => rect, closest: () => null, querySelector: (selector: string) => selector === '.group-cue' ? { prepend: () => {} } : selector === '.h' ? hp : selector === '.foe' ? { getBoundingClientRect: () => rect } : pops[0] ?? null, append: (p: typeof pops[number]) => pops.push(p) };
  vi.stubGlobal('document', { querySelector: () => ({ getBoundingClientRect: () => ({ top: 0 }) }), querySelectorAll: (selector: string) => selector.includes('[data-group]') ? [actor] : [], createElement: () => ({ className: '', style: {}, closest: () => null, getBoundingClientRect: () => ({ width: 24, height: 16 }), dataset: {}, textContent: '', remove: () => pops.splice(0) }) });
  flashFoeHp(17n, '−6×2', 650);
  expect(pops).toHaveLength(1); expect(pops[0].className).toBe('foe-damage'); expect(pops[0].dataset.hitGroup).toBe('17');
  expect(pops[0].textContent).toBe('−6×2'); expect(pops[0].dataset.helpNote).toBe('−6×2 HP lost');
  expect(hp).toEqual({ innerHTML: '<svg></svg>11', textContent: '11' });
  vi.advanceTimersByTime(650); expect(pops).toHaveLength(0);
  flashFoeHp(17n, '−108', 650); expect(pops[0].textContent).toBe('−108');
  expect(pops[0].dataset.helpNote).toBe('−108 HP lost');
  clearHpFlashes(); vi.useRealTimers();
});

import { supportLinks } from './board-teaching.js';
it('keeps Watchtower links from L1 D1 to weapons across the whole row', () => {
  let state = withPart({ ...newRun(13n, 'practice'), wave: 6n }, 0n, P.WATCHTOWER, 1n);
  state = withPart(withPart(state, 4n, P.CAULDRON, 2n), 12n, P.BALLISTA, 3n);
  expect(supportLinks(state)).toEqual([
    { from: 0n, to: 4n, bonus: 2n * C.WATCH_DAMAGE, kind: 'tower' },
    { from: 0n, to: 12n, bonus: 3n * C.WATCH_DAMAGE, kind: 'tower' },
  ]);
});

import { wallContactSnapshot } from './replay.js';
it.each([2n, 6n])('keeps later arrivals queued at tick 1 of wave %s instead of marking their position zero as leaked', wave => {
  const built = { ...newRun(13n, 'practice'), wave };
  const timeline = makeTimeline(built, fight(built).frames), first = timeline[0];
  const groups = wallContactSnapshot(first);
  expect(groups.some(g => g.status === 'queued' && g.pos === 0n)).toBe(true);
  expect(groups.filter(g => g.status === 'leaked')).toEqual([]);
  for (const queued of first.frame.groups.filter(g => g.status === 'queued')) expect(groups.find(g => g.id === queued.id)).toEqual(queued);
  battleLanes(built, { ...first.frame, groups }).forEach((row, lane) => expect(liveVerdict(row.leaks, groups.filter(g => g.lane === BigInt(lane))).text).not.toMatch(/^Leaked/));
});

import { damageNumberPosition } from './ui/layout.js';
it('moves a damage number into free space above its group when a queued track occupies its first position', () => {
  const chip = { left: 10, top: 56, right: 60, bottom: 79 }, upper = { left: 10, top: 30, right: 60, bottom: 53 };
  const spot = damageNumberPosition(chip, { left: 0, right: 110, top: 0, bottom: 100 }, { width: 27, height: 20 }, [chip, upper], 0)!;
  expect(spot).not.toBeNull(); expect(spot.bottom).toBeLessThan(chip.top);
  expect(spot.left >= upper.right + 2 || spot.right <= upper.left - 2 || spot.bottom <= upper.top - 2).toBe(true);
  expect(damageNumberPosition(chip, { left: 0, right: 110, top: 0, bottom: 100 }, { width: 27, height: 20 }, [{ left: 0, top: 0, right: 110, bottom: 100 }], 0)).toBeNull();
});
