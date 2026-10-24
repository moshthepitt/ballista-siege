import { describe, expect, it } from 'vitest';
import { AudioEngine } from './engine.js';
import { SOUND_KINDS, SOUND_LABELS, createSfx, effects } from './sfx.js';
import { MockContext, type MockNode, reaches } from './test-audio.js';

describe('synthesized effects (node-graph fallback without OfflineAudioContext)', () => {
  it('includes every event in the audio plan, including the three result stingers', () => {
    expect(Object.keys(effects)).toEqual([...SOUND_KINDS]);
    expect(Object.values(SOUND_LABELS)).toEqual([
      'Ballista fires', 'Bolt hits', 'Cauldron fires', 'Splash lands', 'Armour blocks', 'Unit killed',
      'Boss killed', 'Bite on a fence', 'Fence breaks', 'Trample', 'Leak', 'Storm', 'Coin / gold',
      'Place a part', 'Upgrade', 'Sell', 'Reroll', 'Overclock', 'UI click / pick card', 'Wave won', 'Run won', 'Run lost',
    ]);
  });
  it.each(SOUND_KINDS)('%s builds finite envelopes and connects every source to the sfx bus', async kind => {
    const context = new MockContext();
    const engine = new AudioEngine({ contextFactory: () => context.asAudioContext(), storage: null, gestures: null });
    await engine.unlock();
    createSfx(engine, () => 0.5)(kind, { lane: 2, intensity: 3 });
    const sources = context.nodes.filter(n => n.kind === 'oscillator' || n.kind === 'noise');
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(reaches(source, engine.getSfxBus() as unknown as MockNode)).toBe(true);
      const start = source.start.mock.calls[0]![0] as number;
      const end = source.stop.mock.calls[0]![0] as number;
      expect(Number.isFinite(start) && Number.isFinite(end)).toBe(true); expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThan(3);
    }
  });
  it('varies pitch by at most 4% and length by at most 8% for the whole event', async () => {
    for (const [random, pitch, length] of [[0, 0.96, 0.92], [1, 1.04, 1.08]]) {
      const context = new MockContext();
      const engine = new AudioEngine({ contextFactory: () => context.asAudioContext(), storage: null, gestures: null });
      await engine.unlock(); createSfx(engine, () => random!)('ballista-fire');
      const source = context.nodes.find(n => n.kind === 'oscillator')!;
      expect(source.frequency.events[0]!.value).toBeCloseTo(550 * pitch!);
      expect(source.stop.mock.calls[0]![0]).toBeCloseTo(0.24 * length!);
    }
  });
  it('keeps each staggered unit death instead of merging adjacent 40 ms pops', async () => {
    const context = new MockContext();
    const engine = new AudioEngine({ contextFactory: () => context.asAudioContext(), storage: null, gestures: null });
    await engine.unlock(); const play = createSfx(engine, () => 0.5);
    const first = play('unit-killed', { lane: 1 });
    context.currentTime = 0.04;
    const second = play('unit-killed', { lane: 1 });
    expect(second).not.toBe(first);
    expect(second!.gain.gain.value).toBeCloseTo(0.88);
    expect(engine.activeVoiceCount).toBe(2);
    context.currentTime = 1;
    expect(play('unit-killed', { lane: 1 })!.gain.gain.value).toBe(1);
  });
  it('gives mixed volleys extra bubble/wood presence and leaves solo fire at its normal gain', async () => {
    const context = new MockContext();
    const engine = new AudioEngine({ contextFactory: () => context.asAudioContext(), storage: null, gestures: null });
    await engine.unlock(); const play = createSfx(engine, () => 0.5);
    expect(play('cauldron-fire', { lane: 1 })!.gain.gain.value).toBe(1);
    context.currentTime = 1;
    play('ballista-fire', { lane: 0 });
    expect(play('cauldron-fire', { lane: 1 })!.gain.gain.value).toBe(1.5);
    context.currentTime = 1.22;
    play('bolt-hit', { lane: 0 });
    expect(context.nodes.some(n => n.kind === 'oscillator' && n.frequency.events[0]?.value === 720)).toBe(true);
    play('unit-killed', { lane: 0 });
    expect(play('armour-block', { lane: 1 })!.at).toBeCloseTo(1.385);
    context.currentTime = 2;
    expect(play('armour-block', { lane: 1 })!.at).toBeCloseTo(2.025);
  });
  it('makes high-damage hits louder and large leaks longer', async () => {
    const inspect = async (kind: 'bolt-hit' | 'leak', intensity: number) => {
      const context = new MockContext();
      const engine = new AudioEngine({ contextFactory: () => context.asAudioContext(), storage: null, gestures: null });
      await engine.unlock(); const voice = createSfx(engine, () => 0.5)(kind, { intensity })!;
      return { end: voice.end, peak: Math.max(...context.nodes.flatMap(n => n.gain.events.filter(e => e.method === 'linear').map(e => e.value))) };
    };
    expect((await inspect('bolt-hit', 3)).peak).toBeGreaterThan((await inspect('bolt-hit', 0)).peak);
    expect((await inspect('leak', 3)).end).toBeGreaterThan((await inspect('leak', 0)).end);
  });
  it.each(['wave-won', 'run-won'] as const)('keeps settlement coins audible after the complete %s fanfare at both jitter extremes', async kind => {
    for (const random of [0, 1]) {
      const context = new MockContext();
      const engine = new AudioEngine({ contextFactory: () => context.asAudioContext(), storage: null, gestures: null });
      await engine.unlock(); const play = createSfx(engine, () => random);
      const fanfare = play(kind)!;
      const before = context.nodes.length;
      context.currentTime = 0.02;
      play('gold');
      const coins = context.nodes.slice(before).filter(n => n.kind === 'oscillator');
      expect(coins).toHaveLength(2);
      expect(Math.min(...coins.map(n => n.start.mock.calls[0]![0] as number))).toBeGreaterThan(fanfare.end);
      context.currentTime = 3;
      expect(play('gold')!.at).toBe(3);
    }
  });
  it('protects hit, block and splash attacks when a full volley and death burst fill the voice budget', async () => {
    const context = new MockContext();
    const engine = new AudioEngine({ contextFactory: () => context.asAudioContext(), storage: null, gestures: null });
    await engine.unlock(); const play = createSfx(engine, () => 0.5);
    const hit = play('bolt-hit', { lane: 0 })!;
    const block = play('armour-block', { lane: 3 })!;
    const splash = play('splash', { lane: 2 })!;
    for (let n = 0; n < 16; n++) play('unit-killed', { lane: n % 4 });
    expect(engine.activeVoiceCount).toBe(12);
    expect((hit.gain as unknown as MockNode).disconnect).not.toHaveBeenCalled();
    expect((block.gain as unknown as MockNode).disconnect).not.toHaveBeenCalled();
    expect((splash.gain as unknown as MockNode).disconnect).not.toHaveBeenCalled();
  });
});
