import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyAction, newRun, withPart, fight, forecast, type RunState, type TickFrame } from '../src/v1/sim.js';
import { PART as P } from '../src/v1/constants.js';
import { cellSlots, cellGroupLayout, type GroupBox } from './cell-groups.js';
import { supportTrampleEffects } from './battle-effects.js';
import { makeTimeline } from './replay.js';
import { liveVerdict } from './ui/model.js';
import { lastTryChallenge, lastTryDelta, readLastTry, saveLastTry, type LastTry } from './retry.js';
import { compactEffect, renderShop } from './ui/shop.js';
import { scoutMarkup } from './ui/scout.js';
import { glossary } from './teaching.js';
import { formationMarkup } from './ui/board.js';
import type { Recap } from './ui/screens.js';
const recording = JSON.parse(readFileSync(new URL('./audio/fixtures/seed13.json', import.meta.url), 'utf8'), (_k, v) => typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v) as { built: RunState; frames: TickFrame[] }[];
const overlap = (a: GroupBox, b: GroupBox) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
afterEach(() => vi.unstubAllGlobals());

describe('RD9 cell occupants', () => {
  const groups = forecast({ ...newRun(13n, 'practice'), wave: 9n }).waves[0].lanes.find(l => l.some(g => g.kind === 'boss'))!;
  it('keeps slots through arrivals and deaths, assigning each new arrival a vacancy', () => {
    const first = cellSlots([groups[1]]);
    const second = cellSlots([groups[0], groups[1], groups[2]], first);
    expect(second.get(groups[1].id)).toBe(first.get(groups[1].id));
    const third = cellSlots([groups[1], groups[2], groups[3]], second);
    expect(third.get(groups[1].id)).toBe(second.get(groups[1].id));
    expect(third.get(groups[2].id)).toBe(second.get(groups[2].id));
    expect(third.get(groups[3].id)).toBe(second.get(groups[0].id));
  });
  it('expands a last survivor inside the cell while retaining its slot identity', () => {
    const assigned = cellSlots(groups.slice(0, 3));
    const survivor = cellSlots([groups[2]], assigned);
    const layout = cellGroupLayout(77, 88, survivor).get(groups[2].id)!;
    expect(layout.slot).toBe(2); expect(layout.label.top).toBeGreaterThanOrEqual(2);
    expect(layout.body.top + layout.body.height).toBeLessThanOrEqual(88);
  });
  it('keeps surviving high slots in their two-row layout after other groups die', () => {
    const slots = cellSlots(groups), survivors = cellSlots(groups.slice(2), slots);
    const layouts = [...cellGroupLayout(63, 60, survivors, 15, 14).values()];
    expect(layouts.map(l => l.slot)).toEqual([2, 3]);
    for (const l of layouts) { expect(l.compact).toBe(true); expect(l.label.top + l.label.height).toBeLessThanOrEqual(45); }
    expect(overlap(layouts[0].label, layouts[1].body)).toBe(false);
  });
  it('fits the 13px cue line between phone chips at the smoke audit’s 2px tolerance', () => {
    const slots = cellSlots(groups.slice(0, 2));
    const [first, second] = [...cellGroupLayout(77, 60, slots).values()];
    expect(overlap(first.cue, second.label)).toBe(false);
    expect(first.cue).toEqual(first.label);
  });
  it.each([1, 2, 3, 4])('separates bodies, labels and effect bands for %i Swarm/Brute/boss occupants, with a part and without', count => {
    for (const [width, height] of [[220, 140], [180, 110], [77, 170]]) for (const part of [0, 34]) for (const tag of [0, 16]) {
      const assigned = cellSlots(groups.slice(4 - count)), layouts = [...cellGroupLayout(width, height, assigned, part, tag, new Set(groups.filter(g => g.kind === 'boss').map(g => g.id))).values()];
      // Crowded readouts replace their own HP during a cue; both states must fit.
      const all = layouts.flatMap(l => [l.body, l.label]);
      for (const l of layouts.filter(l => l.compact)) expect(l.cue).toEqual(l.label);
      for (let i = 0; i < all.length; i++) {
        expect(all[i].left).toBeGreaterThanOrEqual(0); expect(all[i].top).toBeGreaterThanOrEqual(tag);
        expect(all[i].left + all[i].width).toBeLessThanOrEqual(width);
        expect(all[i].top + all[i].height).toBeLessThanOrEqual(height - part);
        for (const b of all.slice(i + 1)) expect(overlap(all[i], b), JSON.stringify({ count, width, height, part, a: all[i], b })).toBe(false);
      }
    }
  });
  it.each([2, 3, 4])('fits %i groups above a part and trample tag in actual short phone cells', count => {
    for (const width of [63, 77]) for (const height of [60, 84]) for (const part of [0, 15]) for (const tag of [0, 14]) {
      const layouts = [...cellGroupLayout(width, height, cellSlots(groups.slice(4 - count)), part, tag).values()];
      for (const l of layouts) if (l.compact) expect(l.label.width).toBeGreaterThanOrEqual(14);
      for (const l of layouts) if (l.compact) expect(l.body.top).toBeGreaterThanOrEqual(tag + 2);
      for (const cue of [false, true]) {
        const boxes = layouts.flatMap(l => [l.body, cue ? l.cue : l.label]);
        for (const [i, a] of boxes.entries()) {
          expect(a.width).toBeGreaterThan(0); expect(a.height).toBeGreaterThan(0);
          expect(a.top).toBeGreaterThanOrEqual(tag); expect(a.top + a.height).toBeLessThanOrEqual(height - part);
          expect(a.left + a.width).toBeLessThanOrEqual(width);
          for (const b of boxes.slice(i + 1)) expect(overlap(a, b)).toBe(false);
        }
      }
    }
  });
  it('keeps one count pip per surviving unit and a representative front after recorded deaths', () => {
    const swarm = { ...groups[0], kind: 'swarm' as const, count: 2n };
    const html = formationMarkup(swarm, 2);
    expect(html.match(/data-front="true"/g)).toHaveLength(1);
    expect(html).toContain('data-unit="2" data-front="true"');
    expect(html).toContain('<span class="count-pips"><i data-unit="2"></i><i data-unit="3"></i></span>');
  });
});

describe('RD9 recorded trample and safe lane badges', () => {
  it('maps only actual tramples to a 250 ms pulse and top-edge tag', () => {
    for (const turn of recording) for (const [index, step] of makeTimeline(turn.built, turn.frames).entries()) {
      const effects = supportTrampleEffects(turn.built, step, index ? turn.frames[index - 1].disabled : 0n);
      expect(effects.map(e => ({ cell: e.cell, group: e.group, part: e.part }))).toEqual(step.frame.tramples);
      effects.forEach(e => { expect(e.pulse).toBe(250); expect(e.tagEdge).toBe('top'); });
    }
  });
  it('shows exact lost Forge damage, tier multiplication, overclock and Watchtower ties', () => {
    let built = withPart(withPart(newRun(13n, 'practice'), 0n, P.FORGE, 3n), 1n, P.BALLISTA, 2n);
    const step = makeTimeline(built, fight(built).frames)[0];
    const trample = { ...step, frame: { ...step.frame, tramples: [{ cell: 0n, group: 0n, part: P.FORGE }] } };
    expect(supportTrampleEffects(built, trample, 0n)[0].weapons).toEqual([{ cell: 1n, oldDamage: 20n, newDamage: 8n, oldLow: 2, newLow: 2, oldHigh: 4, newHigh: 4 }]);
    const charged = { ...withPart(built, 1n, P.BALLISTA, 3n), overclocked: 2n };
    expect(supportTrampleEffects(charged, trample, 0n)[0].weapons[0]).toMatchObject({ oldDamage: 45n, newDamage: 18n });
    built = withPart(withPart(withPart(newRun(13n, 'practice'), 0n, P.WATCHTOWER, 2n), 4n, P.BALLISTA, 3n), 8n, P.WATCHTOWER, 2n);
    const tied = supportTrampleEffects(built, { ...trample, frame: { ...trample.frame, tramples: [{ cell: 0n, group: 0n, part: P.WATCHTOWER }] } }, 0n)[0];
    expect(tied.weapons[0]).toMatchObject({ cell: 4n, oldDamage: 18n, newDamage: 18n, oldHigh: 4, newHigh: 4 });
    expect(supportTrampleEffects(built, { ...trample, frame: { ...trample.frame, tramples: [] } }, 0n)).toEqual([]);
  });
  it('uses Holding and Boss in lane before contact; only actual leaked groups show a loss', () => {
    const groups = forecast({ ...newRun(13n, 'practice'), wave: 9n }).waves[0].lanes.flat();
    const boss = groups.find(g => g.kind === 'boss')!, swarm = groups[0];
    expect(liveVerdict(8n, [{ ...swarm, status: 'active' }])).toEqual({ kind: 'hold', text: 'Holding' });
    expect(liveVerdict(8n, [{ ...boss, status: 'active' }])).toEqual({ kind: 'hold', text: 'Boss in lane' });
    expect(liveVerdict(0n, [{ ...boss, status: 'dead' }, { ...swarm, status: 'active' }]).text).toBe('Holding');
    expect(liveVerdict(0n, [{ ...boss, status: 'leaked' }]).text).toBe('Leaked −8');
  });
});

describe('RD9 copy and shop states', () => {
  it('keeps a compact effect beside bought and unaffordable status text', () => {
    const nodes = new Map<string, { innerHTML: string; hidden: boolean; classList: { toggle: () => void } }>();
    vi.stubGlobal('document', { querySelector: (s: string) => { if (!nodes.has(s)) nodes.set(s, { innerHTML: '', hidden: false, classList: { toggle: () => {} } }); return nodes.get(s); } });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    let state = newRun(13n, 'practice');
    for (const [slot, cell] of [[1n, 1n], [0n, 4n], [3n, 0n]]) state = applyAction(state, { type: 'buy', slot, cell });
    renderShop(state, null, false, false);
    const html = nodes.get('#shop')!.innerHTML;
    for (const p of [P.BALLISTA, P.CAULDRON, P.PALISADE, P.FORGE]) expect(html).toContain(compactEffect(p));
    expect(html).toContain('Bought · next wave / reroll');
    expect(html).toContain('Need 2 more gold.');
    expect(html.indexOf('Lane splash')).toBeLessThan(html.indexOf('Bought · next wave / reroll'));
  });
  it('states standing-fence entry and names the later forecast wave', () => {
    expect(glossary.Trample).toContain('A standing Palisade blocks entry until its HP reaches 0.');
    expect(scoutMarkup({ ...newRun(13n, 'practice'), wave: 5n })).toContain('Wave 10 forecast: this board, no more purchases');
  });
});

const record: LastTry = { version: 1, seed: '13', walls: [20, 20, 19, 18, 8], losses: [0, 0, 1, 1, 10] };
describe('RD9 retry challenge', () => {
  it('stores one last try per seed, replaces it, and reads it without bigint JSON', () => {
    const data = new Map<string, string>(), source = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
    const recaps = record.walls.map((walls, i) => ({ built: { seed: 13n, walls: BigInt(walls + record.losses[i]) }, result: { state: { wave: BigInt(i + 1), walls: BigInt(walls) } } })) as Recap[];
    expect(saveLastTry(13n, recaps, source)).toEqual(record); expect(readLastTry(13n, source)).toEqual(record);
    saveLastTry(13n, recaps.slice(0, 2), source); expect(readLastTry(13n, source)?.walls).toEqual([20, 20]);
    expect(saveLastTry(13n, recaps, { getItem: () => null, setItem: () => { throw new Error('denied'); } })).toEqual(record);
    expect(data.size).toBe(1); expect(readLastTry(4n, source)).toBeUndefined();
  });
  it('shows the costliest wave and wall deltas only for played waves', () => {
    expect(lastTryChallenge(record)).toBe('Last try: W5 −10 walls');
    expect(lastTryDelta(record, 5n, 10n)).toBe('+2 vs last try');
    expect(lastTryDelta(record, 5n, 6n)).toBe('−2 vs last try');
    expect(lastTryDelta(record, 5n, 8n)).toBe('0 vs last try');
    expect(lastTryDelta(record, 6n, 8n)).toBe(''); expect(lastTryChallenge()).toBe('');
  });
  it('degrades quietly with denied, missing, corrupt or another seed’s storage', () => {
    vi.stubGlobal('localStorage', undefined); expect(readLastTry(13n)).toBeUndefined();
    const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readLastTry(13n, denied)).toBeUndefined();
    for (const raw of ['bad', '{}', JSON.stringify({ ...record, seed: '4' }), JSON.stringify({ ...record, walls: [21] }), JSON.stringify({ ...record, losses: [0] })])
      expect(readLastTry(13n, { ...denied, getItem: () => raw })).toBeUndefined();
    expect(lastTryDelta(undefined, 5n, 8n)).toBe('');
  });
});
