import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunState, TickFrame } from '../src/v1/sim.js';
import { makeTimeline, type ReplayStep } from './replay.js';
import { biteEffects, bountyDelay, trampleEffects, stormEffects, unitRemovals } from './battle-effects.js';
import { playBattle } from './ui/battle.js';
import { renderParts, renderFoes } from './ui/board.js';
import { toast } from './ui/dom.js';
vi.mock('./ui/board.js', () => ({ layoutFoeCells: vi.fn(), renderParts: vi.fn(), renderFoes: vi.fn(), renderIncoming: vi.fn(), renderVerdicts: vi.fn(), flashFoeHp: vi.fn(), clearHpFlashes: vi.fn(), cellNode: () => ({ style: { setProperty: vi.fn() }, classList: { add: vi.fn(), remove: vi.fn() }, getBoundingClientRect: () => ({ height: 80 }), querySelector: (s: string) => s === '.cell-effects' || s === '.part-layer' ? { append: vi.fn(), insertAdjacentHTML: vi.fn() } : null }) }));
vi.mock('./ui/tutorial.js', () => ({ positionTutorial: vi.fn() }));
vi.mock('./ui/dom.js', async original => ({ ...await original<typeof import('./ui/dom.js')>(), toast: vi.fn() }));
vi.mock('./audio/game.js', async original => ({ ...await original<typeof import('./audio/game.js')>(), playBattleSounds: vi.fn(), followMusic: vi.fn() }));
const recording = JSON.parse(readFileSync(new URL('./audio/fixtures/seed13.json', import.meta.url), 'utf8'), (_k, v) => typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v) as { built: RunState; frames: TickFrame[] }[];
const wave = (n: number) => makeTimeline(recording[n - 1].built, recording[n - 1].frames);
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function playback(step: ReplayStep, waveNumber = 5, bitingBody?: { animate: ReturnType<typeof vi.fn>; getBoundingClientRect: () => object }) {
  let currentPhase = '';
  vi.useFakeTimers();
  type Node = { innerHTML: string; textContent: string; hidden: boolean; dataset: Record<string, string>; getBoundingClientRect: () => object; classList: object; style: object; querySelector: () => null; append: () => void; remove: () => void; animate: () => void };
  const nodes = new Map<string, Node>();
  const node = (selector: string): Node => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', hidden: false, dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }), classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() }, style: { setProperty: vi.fn() }, querySelector: () => null, append: vi.fn(), remove: vi.fn(), animate: vi.fn() });
    return nodes.get(selector)!;
  };
  vi.stubGlobal('document', { querySelector: (s: string) => s.startsWith('#board .enemy-group') ? currentPhase === 'Bite' && bitingBody ? { querySelector: () => bitingBody } : null : s.startsWith('.death-body') ? null : node(s), querySelectorAll: () => [], createElement: () => node('created') });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const promise = playBattle(recording[waveNumber - 1].built, [step], { skip: false, cancelled: false }, { speed: () => 1, hud: vi.fn(), tick: (_tick, phase) => { currentPhase = phase; } });
  return { promise, node };
}

describe('RD8 recorded effect order', () => {
  it('requires recorded bites, kills, tramples and storm leaks', () => {
    const steps = [...wave(5), ...wave(10)];
    for (const s of steps) {
      for (const b of biteEffects(s)) { expect(b.windup).toBe(100); expect(b.contact).toBe(200); expect(b.windup).toBeLessThan(b.contact); }
      for (const k of s.frame.kills) {
        const g = s.before.find(g => g.id === k.group)!;
        const deaths = unitRemovals(s, k.group);
        expect(deaths).toHaveLength(Number(k.count));
        for (const d of deaths) expect(d.duration).toBe(g.kind === 'boss' ? 600 : 280);
        if (g.kind === 'boss') { expect(deaths[0].at).toBe(100); expect(bountyDelay(s, g.id)).toBe(deaths[0].at + deaths[0].duration); }
      }
      for (const t of trampleEffects(s)) {
        expect(s.frame.tramples).toContainEqual({ group: t.group, cell: t.cell, part: t.part });
        expect(t.at).toBe(255); expect(t.duration).toBe(180); expect(t.disabledAt).toBe(435); expect(s.phases.move).toBeGreaterThanOrEqual(t.disabledAt);
      }
      for (const e of stormEffects(s)) { expect(s.frame.leaks.some(l => l.group === e.group)).toBe(true); expect(e.contact).toBeGreaterThan(0); expect(e.pulse).toBe(500); expect(e.shake).toBe(200); }
    }
    const quiet = { ...steps[0], frame: { ...steps[0].frame, bites: [], kills: [], tramples: [], leaks: [] } };
    expect(biteEffects(quiet)).toEqual([]); expect(trampleEffects(quiet)).toEqual([]); expect(stormEffects(quiet)).toEqual([]);
    expect(unitRemovals(quiet, quiet.before[0].id)).toEqual([]); expect(bountyDelay(quiet, quiet.before[0].id)).toBe(0);
  });
  it('keeps HP and the feed unchanged through flight, then commits fence HP and bite text at contact', async () => {
    const step = wave(5)[5], { promise, node } = playback(step);
    await vi.advanceTimersByTimeAsync(step.phases.fire - 1);
    expect(vi.mocked(renderFoes).mock.calls.at(-1)![0]).toEqual(step.before);
    expect(node('#battle-panel').innerHTML).not.toContain('bites the fence');
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(renderFoes).mock.calls.at(-1)![0]).not.toEqual(step.before);
    await vi.advanceTimersByTimeAsync(step.phases.hit + 199);
    expect(renderParts).not.toHaveBeenCalled();
    expect(node('#battle-panel').innerHTML).not.toContain('bites the fence');
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(renderParts).mock.calls.at(-1)![1].frame!.palisades).toEqual(step.frame.palisades);
    expect(node('#battle-panel').innerHTML).toContain('bites the fence');
    await vi.runAllTimersAsync(); await promise;
  });
  it('keeps the body wind-up and fence contact on the same linear 100/200 ms clock', async () => {
    const step = wave(5)[5], body = { animate: vi.fn(), getBoundingClientRect: () => ({ bottom: 100 }) };
    const { promise } = playback(step, 5, body);
    await vi.advanceTimersByTimeAsync(step.phases.fire + step.phases.hit);
    const [keys, timing] = body.animate.mock.calls[0];
    expect(timing).toMatchObject({ duration: 350, easing: 'linear' });
    expect(keys[1].offset * timing.duration).toBe(100);
    expect(keys[2].offset * timing.duration).toBe(200);
    await vi.runAllTimersAsync(); await promise;
  });
  it('compresses a recorded part before latching disabled and appending trample text', async () => {
    const step = wave(5)[8], { promise, node } = playback(step);
    const moveStart = step.phases.fire + step.phases.hit + step.phases.bite;
    await vi.advanceTimersByTimeAsync(moveStart + 434);
    expect(vi.mocked(renderParts).mock.calls.some(([, o]) => !!(o.frame!.disabled & 1n << step.frame.tramples[0].cell))).toBe(false);
    expect(node('#battle-panel').innerHTML).not.toContain('trampled');
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(renderParts).mock.calls.some(([, o]) => !!(o.frame!.disabled & 1n << step.frame.tramples[0].cell))).toBe(true);
    expect(node('#battle-panel').innerHTML).toContain('trampled');
    await vi.runAllTimersAsync(); await promise;
  });
  it('waits through the boss impact hold and collapse before showing its bounty', async () => {
    const step = wave(10).find(s => s.frame.kills.some(k => s.before.find(g => g.id === k.group)?.kind === 'boss'))!;
    const { promise, node } = playback(step, 10);
    await vi.advanceTimersByTimeAsync(step.phases.fire + 699);
    expect(toast).not.toHaveBeenCalled(); expect(node('#battle-panel').innerHTML).not.toContain('Boss bounty');
    await vi.advanceTimersByTimeAsync(1);
    expect(toast).toHaveBeenCalledWith('Last Siege down · +8g'); expect(node('#battle-panel').innerHTML).toContain('Boss bounty');
    await vi.runAllTimersAsync(); await promise;
  });
});
