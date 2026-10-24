import { describe, expect, it } from 'vitest';
import { PART as P } from '../src/v1/constants.js';
import { applyAction, fight, forecast, newRun, shop, withPart } from '../src/v1/sim.js';
import { advanceTutorial, createTutorial, tutorialCallout, type TutorialContext } from './tutorial.js';

it('walks seed 13 through the opening using threatened lanes from its forecast', () => {
  let state = newRun(13n, 'practice'), context: TutorialContext = { state, phase: 'build' };
  let t = createTutorial(state);
  expect(t.lanes).toEqual(forecast(state).waves[0].lanes.flatMap((groups, lane) => groups.length ? [BigInt(lane)] : []));
  const view = () => tutorialCallout(t, context)!;
  expect(view().id).toBe('incoming'); expect(view().text).toContain('lanes 1 and 2');
  t = advanceTutorial(t, context, 'next'); expect(view().id).toBe('weapon');
  context.selected = P.BALLISTA; t = advanceTutorial(t, context); expect(view().id).toBe('place-ballista');
  expect(view().anchor).toBe('[data-cell="1"]');
  state = applyAction(state, { type: 'buy', slot: shop(state).find(o => o.part === P.BALLISTA)!.slot, cell: t.lanes[0] * 4n + 1n });
  context = { state, phase: 'build' }; t = advanceTutorial(t, context); expect(view().id).toBe('cauldron');
  context.selected = P.CAULDRON; expect(view().anchor).toBe('[data-cell="5"]');
  state = applyAction(state, { type: 'buy', slot: shop(state).find(o => o.part === P.CAULDRON)!.slot, cell: t.lanes[1] * 4n + 1n });
  context = { state, phase: 'build' }; t = advanceTutorial(t, context); expect(view().id).toBe('fight');
  expect(view().text).toBe('Both lanes hold and you have 4 gold left. Fight.');
  expect(fight(state).summary.damage).toBe(0n);
  context.phase = 'battle'; context.tick = 1n; t = advanceTutorial(t, context); expect(view().id).toBe('tick');
  t = advanceTutorial(t, context, 'next'); expect(tutorialCallout(t, context)).toBeNull();
  context = { state: fight(state).state, phase: 'summary' }; t = advanceTutorial(t, context); expect(view().id).toBe('receipt');
  t = advanceTutorial(t, context, 'next'); expect(t.step).toBe(7);
});

describe('later tutorial triggers', () => {
  const later = (state: TutorialContext['state'], seen: ReturnType<typeof createTutorial>['seen'] = []) => {
    const context: TutorialContext = { state, phase: 'build' };
    return { context, t: advanceTutorial(createTutorial(state, { seen }), context) };
  };
  it('shows the first later Palisade offer and advances after a purchase', () => {
    let state = { ...newRun(13n, 'practice'), wave: 1n, gold: 100n };
    while (!shop(state).some(o => o.part === P.PALISADE)) state = applyAction(state, { type: 'reroll' });
    const { t, context } = later(state); expect(t.active).toBe('palisade');
    const action = { type: 'buy' as const, slot: shop(state).find(o => o.part === P.PALISADE)!.slot, cell: 2n };
    const next = advanceTutorial(t, { ...context, state: applyAction(state, action), action });
    expect(next.active).not.toBe('palisade'); expect(next.seen).toContain('palisade');
  });
  it('teaches the first forecast Brute and first offered Forge or Watchtower once', () => {
    let state = { ...newRun(13n, 'practice'), wave: 1n, gold: 100n };
    let { t, context } = later(state, ['palisade']); expect(t.active).toBe('brute');
    t = advanceTutorial(t, context, 'next');
    while (!shop(state).some(o => o.part === P.FORGE || o.part === P.WATCHTOWER)) state = applyAction(state, { type: 'reroll' });
    context = { state, phase: 'build' }; t = advanceTutorial(t, context);
    expect(t.active).toBe('support'); expect(tutorialCallout(t, context)?.text).toMatch(/Forge between|share a single Watchtower/);
    t = advanceTutorial(t, context, 'next'); expect(t.active).toBeUndefined();
    expect(advanceTutorial(t, context).active).toBeUndefined();
  });
  it('warns during wave 4 build, before the wave 5 boss', () => {
    const { t, context } = later({ ...newRun(13n, 'practice'), wave: 3n });
    expect(t.active).toBe('boss'); expect(tutorialCallout(t, context)?.text).toContain('Boss next wave.');
  });
  it('uses the actual first trample cell and never repeats it', () => {
    const state = withPart({ ...newRun(13n, 'practice'), wave: 1n }, 3n, P.FORGE, 1n);
    const frame = fight(state).frames.find(f => f.tramples.length)!;
    const context: TutorialContext = { state, phase: 'battle', frame };
    let t = advanceTutorial(createTutorial(state), context);
    expect(t.active).toBe('trample'); expect(tutorialCallout(t, context)?.anchor).toBe(`[data-cell="${frame.tramples[0].cell}"]`);
    t = advanceTutorial(t, context, 'next'); expect(t.active).toBeUndefined();
    expect(advanceTutorial(t, context).active).toBeUndefined();
  });
  it('remembers skip and stops after the first win', () => {
    const state = newRun(13n, 'practice'), context: TutorialContext = { state, phase: 'build' };
    expect(advanceTutorial(createTutorial(state), context, 'skip').done).toBe(true);
    expect(tutorialCallout(createTutorial(state, { done: true }), context)).toBeNull();
    expect(advanceTutorial(createTutorial(state), { ...context, state: { ...state, won: true }, phase: 'end' }).done).toBe(true);
  });
});

it('rewinds the opening lesson after undo instead of claiming an undefended lane holds', () => {
  const start = newRun(13n, 'practice');
  const placed = applyAction(start, { type: 'buy', slot: 1n, cell: 1n });
  const t = advanceTutorial(createTutorial(start), { state: placed, phase: 'build' });
  expect(t.step).toBe(3);
  const undone = advanceTutorial(t, { state: start, phase: 'build' });
  expect(undone.step).toBe(1);
});

it('waits for trample contact instead of announcing a future Move event during Fire', () => {
  const state = withPart({ ...newRun(13n, 'practice'), wave: 1n }, 3n, P.FORGE, 1n);
  const frame = fight(state).frames.find(f => f.tramples.length)!;
  const t = createTutorial(state);
  expect(advanceTutorial(t, { state, phase: 'battle', frame: { ...frame, disabled: 0n } }).active).toBeUndefined();
  expect(advanceTutorial(t, { state, phase: 'battle', frame }).active).toBe('trample');
});

it.each([P.FORGE, P.WATCHTOWER])('shows the first support offer synergy for part %s', part => {
  const states = Array.from({ length: 64 }, (_, seed) => ({ ...newRun(BigInt(seed), 'practice'), wave: 1n }));
  const state = states.find(s => shop(s).find(o => o.part === P.FORGE || o.part === P.WATCHTOWER)?.part === part)!;
  expect(state).toBeDefined();
  const context: TutorialContext = { state, phase: 'build' };
  const t = advanceTutorial(createTutorial(state, { seen: ['palisade', 'brute'] }), context);
  expect(t.support).toBe(part);
  expect(tutorialCallout(t, context)?.text).toBe(part === P.FORGE ? 'A Forge between two weapons boosts both.' : "Weapons in one row share a single Watchtower's bonus.");
});
