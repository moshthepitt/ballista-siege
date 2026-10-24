import { describe, expect, it, vi } from 'vitest';
import { AudioEngine, LANE_PANS, STORAGE_KEY, VOICE_CAP, limiterCurve, mergeGain, type VoiceGraph } from './engine.js';
import { MockContext, type MockNode, memoryStorage, reaches } from './test-audio.js';

function setup(search = '') {
  const context = new MockContext(), storage = memoryStorage(), gestures = new EventTarget();
  const factory = vi.fn(() => context.asAudioContext());
  const engine = new AudioEngine({ contextFactory: factory, storage, search, gestures });
  return { engine, context, storage, gestures, factory };
}
function tone(graph: VoiceGraph) {
  const oscillator = graph.context.createOscillator(); oscillator.connect(graph.output);
  graph.source(oscillator, graph.at, graph.at + 2);
}

describe('audio engine', () => {
  it.each(['pointerdown', 'keydown'])('creates one context only after %s and gates pre-unlock playback', async gesture => {
    const { engine, factory, gestures } = setup();
    const build = vi.fn(tone);
    expect(engine.render({ kind: 'hit' }, build)).toBeNull();
    expect(factory).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled();
    gestures.dispatchEvent(new Event(gesture)); await engine.unlock();
    expect(engine.unlocked).toBe(true);
    expect(engine.render({ kind: 'hit' }, build)).not.toBeNull();
    gestures.dispatchEvent(new Event('pointerdown')); await engine.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    await engine.dispose();
  });
  it('keeps playback gated while resume is pending and retries a rejected unlock', async () => {
    const { engine, context, gestures } = setup();
    context.resume.mockImplementationOnce(() => Promise.reject(new Error('blocked')));
    gestures.dispatchEvent(new Event('pointerdown'));
    await expect(engine.unlock()).rejects.toThrow('blocked');
    expect(engine.render({ kind: 'hit' }, tone)).toBeNull();
    gestures.dispatchEvent(new Event('keydown')); await engine.unlock();
    expect(engine.unlocked).toBe(true);
  });
  it('notifies subscribers when a new context is already running', async () => {
    const context = new MockContext(); context.state = 'running';
    const engine = new AudioEngine({ contextFactory: () => context.asAudioContext(), storage: null, gestures: null });
    const listener = vi.fn(); engine.onUnlock(listener);
    await engine.unlock(); await engine.unlock();
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('connects both buses through master and compressor, with four lane panners', async () => {
    const { engine, context } = setup(); await engine.unlock();
    const panners = context.nodes.filter(n => n.kind === 'panner');
    expect(panners.map(p => p.pan.value)).toEqual([...LANE_PANS]);
    const sfx = engine.getSfxBus() as unknown as MockNode;
    const music = engine.getMusicBus() as unknown as MockNode;
    expect(reaches(sfx, context.destination)).toBe(true); expect(reaches(music, context.destination)).toBe(true);
    expect(sfx.connections[0]).toBe(music.connections[0]!.connections[0]);
    expect(sfx.connections[0]!.connections[0]!.kind).toBe('compressor');
    const compressor = sfx.connections[0]!.connections[0]!;
    expect(compressor.connections[0]!.kind).toBe('limiter');
    expect(compressor.connections[0]!.connections[0]!.connections).toEqual([context.destination]);
    expect(compressor.connections[0]!.oversample).toBe('4x');
    const voice = engine.render({ kind: 'lane-hit', lane: 3 }, tone)!;
    expect((voice.gain as unknown as MockNode).connections).toEqual([panners[3]]);
  });
  it('bounds both polarities below -1 dBFS and preserves silence and monotonicity', () => {
    const curve = limiterCurve();
    expect(curve[2048]).toBe(0);
    expect(Math.max(...curve.map(Math.abs))).toBeLessThan(10 ** (-1 / 20));
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]!);
    expect(curve[0]).toBeCloseTo(-curve[curve.length - 1]!);
  });
  it('ducks active and newly started routine fire, restores it, and protects a threat at the voice cap', async () => {
    const { engine, context } = setup(); await engine.unlock();
    const fire = engine.render({ kind: 'fire', duckable: true }, tone)!;
    const routine = (fire.gain as unknown as MockNode).connections[0]!;
    engine.render({ kind: 'storm', focus: 1.1 }, tone);
    expect(routine.gain.cancelAndHoldAtTime).toHaveBeenCalledWith(0);
    expect(routine.gain.events).toContainEqual({ method: 'linear', value: 0.22, time: 0.012 });
    expect(routine.gain.events).toContainEqual({ method: 'linear', value: 1, time: 1.28 });
    context.currentTime = 0.1;
    const splash = engine.render({ kind: 'splash', duckable: true }, tone)!;
    expect((splash.gain as unknown as MockNode).connections[0]!.gain.events[0]).toEqual({ method: 'set', value: 0.22, time: 0.1 });
    for (let i = 0; i < VOICE_CAP; i++) engine.render({ kind: `fire-${i}` }, tone);
    expect(context.nodes.filter(n => n.kind === 'oscillator')[1]!.stop).not.toHaveBeenCalledWith(0.1);
    const resumed = engine.render({ kind: 'fire-later', duckable: true, at: 1.4 }, tone)!;
    expect((resumed.gain as unknown as MockNode).connections[0]!.gain.events).toEqual([]);
  });
  it('caps event voices at 12 and steals the oldest across music and effects', async () => {
    const { engine, context } = setup(); await engine.unlock();
    const first = engine.render({ kind: 'old-music', bus: 'music' }, tone)!;
    for (let i = 0; i < VOICE_CAP; i++) engine.render({ kind: `hit-${i}` }, tone);
    expect(engine.activeVoiceCount).toBe(12);
    expect((first.gain as unknown as MockNode).disconnect).toHaveBeenCalled();
    expect(context.nodes.find(n => n.kind === 'oscillator')!.stop).toHaveBeenLastCalledWith(0);
  });
  it('merges only the same kind and lane within a fixed 60 ms window', async () => {
    const { engine, context } = setup(); await engine.unlock();
    const first = engine.render({ kind: 'hit', lane: 0 }, tone)!;
    context.currentTime = 0.059;
    expect(engine.render({ kind: 'hit', lane: 0 }, tone)).toBe(first);
    expect(first.count).toBe(2); expect(first.gain.gain.value).toBeCloseTo(mergeGain(2));
    expect(engine.render({ kind: 'hit', lane: 1 }, tone)).not.toBe(first);
    expect(engine.render({ kind: 'other', lane: 0 }, tone)).not.toBe(first);
    context.currentTime = 0.06;
    expect(engine.render({ kind: 'hit', lane: 0 }, tone)).not.toBe(first);
    expect(engine.activeVoiceCount).toBe(4);
  });
  it('merges five repeats into one graph with logarithmic gain', async () => {
    const { engine } = setup(); await engine.unlock(); const build = vi.fn(tone);
    let voice;
    for (let i = 0; i < 5; i++) voice = engine.render({ kind: 'click' }, build);
    expect(build).toHaveBeenCalledTimes(1); expect(voice?.count).toBe(5);
    expect(voice?.gain.gain.value).toBeCloseTo(1 + Math.log2(5) * 0.3);
  });
  it('releases ended graphs and removes them before counting voices', async () => {
    const { engine, context } = setup(); await engine.unlock();
    const voice = engine.render({ kind: 'hit' }, tone)!;
    context.currentTime = 3;
    expect(engine.activeVoiceCount).toBe(0);
    expect((voice.gain as unknown as MockNode).disconnect).toHaveBeenCalled();
  });
  it('persists all volumes and mute and applies them after unlock', async () => {
    const { engine, storage } = setup();
    engine.setSettings({ master: 0.8, sfx: 0.5, music: 0.2, muted: true });
    const context = new MockContext();
    const restored = new AudioEngine({ contextFactory: () => context.asAudioContext(), storage, gestures: null });
    expect(restored.getSettings()).toEqual({ master: 0.8, sfx: 0.5, music: 0.2, muted: true });
    await restored.unlock(); expect(restored.render({ kind: 'hit' }, tone)).toBeNull();
    restored.toggleMute();
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).muted).toBe(false);
    expect(restored.getSfxBus()?.gain.value).toBe(0.5); expect(restored.getMusicBus()?.gain.value).toBe(0.2);
  });
  it('?mute=1 forces silence without overwriting the saved mute preference', async () => {
    const { engine, storage } = setup('?backend=local&mute=1'); await engine.unlock();
    engine.setSettings({ muted: false });
    expect(engine.muted).toBe(true); expect(engine.render({ kind: 'hit' }, tone)).toBeNull();
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).muted).toBe(false);
  });
  it('uses defaults for broken storage, clamps volumes, ignores invalid fields', () => {
    const storage = memoryStorage(); storage.data.set(STORAGE_KEY, '{broken');
    const engine = new AudioEngine({ storage, gestures: null });
    expect(engine.getSettings()).toEqual({ master: 1, music: 0.4, sfx: 0.7, muted: false });
    engine.setSettings({ music: 4, sfx: -1, master: NaN });
    expect(engine.getSettings()).toEqual({ master: 1, music: 1, sfx: 0, muted: false });
  });
  it('registers the shared engine before the first pointer gesture without creating a context at import', async () => {
    const gestures = new EventTarget(), context = new MockContext();
    const factory = vi.fn(function () { return context.asAudioContext(); });
    vi.stubGlobal('window', gestures); vi.stubGlobal('AudioContext', factory); vi.resetModules();
    try {
      const { getAudioEngine } = await import('./engine.js');
      expect(factory).not.toHaveBeenCalled();
      gestures.dispatchEvent(new Event('pointerdown'));
      await getAudioEngine().unlock();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(getAudioEngine().render({ kind: 'first-click' }, tone)).not.toBeNull();
      await getAudioEngine().dispose();
    } finally { vi.unstubAllGlobals(); }
  });
});
