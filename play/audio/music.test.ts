import { describe, expect, it, vi } from 'vitest';
import { AudioEngine } from './engine.js';
import { BUILD_BAR_SECONDS, LOOKAHEAD_MS, MusicSequencer, MusicTimeline, barSeconds, phraseForBar, seededRandom } from './music.js';
import { MockContext, type MockNode, reaches } from './test-audio.js';

describe('music timing', () => {
  it('uses a 25 ms timer and 100 ms scheduling horizon', () => {
    expect(LOOKAHEAD_MS).toBe(25);
    const timeline = new MusicTimeline();
    expect(timeline.schedule(0).map(e => e.at)).toEqual([0]);
    expect(timeline.schedule(0.025)).toEqual([]);
    expect(timeline.schedule(0.1).map(e => e.at)).toEqual([0.1875]);
  });
  it('puts 16 steps in each 80 bpm build bar without drift', () => {
    const timeline = new MusicTimeline();
    const events = timeline.schedule(0, 30.01);
    const bars = events.filter(e => e.step === 0);
    expect(BUILD_BAR_SECONDS).toBe(3); expect(bars).toHaveLength(11);
    bars.forEach((e, i) => expect(e.at).toBeCloseTo(i * 3, 9));
  });
  it.each([[1, 3000, 3], [2, 1500, 1.5]])('syncs a battle bar to one tick at %sx', (_speed, tickMs, duration) => {
    const timeline = new MusicTimeline(0, 'battle'); timeline.syncTick(tickMs!);
    const bars = timeline.schedule(0, duration! * 3 + 0.01).filter(e => e.step === 0);
    expect(bars.map(e => e.at)).toEqual([0, duration, duration! * 2, duration! * 3]);
    expect(barSeconds('boss', tickMs!)).toBe(duration);
  });
  it('queues phase crossfades for the next bar and keeps the old bar intact', () => {
    const timeline = new MusicTimeline(); timeline.schedule(0);
    timeline.setPhase('boss'); timeline.syncTick(1500);
    expect(timeline.nextBarAt).toBe(3);
    const events = timeline.schedule(0.1, 3.01);
    expect(events.filter(e => e.at < 3).every(e => e.phase === 'build')).toBe(true);
    const boundary = events.find(e => e.step === 0)!;
    expect(boundary).toMatchObject({ at: 3, phase: 'boss', transition: true, barDuration: 1.5 });
  });
  it('applies a speed change at the next battle bar', () => {
    const timeline = new MusicTimeline(0, 'battle'); timeline.schedule(0);
    timeline.syncTick(1500);
    const bars = timeline.schedule(0.1, 6).filter(e => e.step === 0);
    expect(bars.map(e => e.at)).toEqual([3, 4.5, 6]);
  });
  it('keeps already scheduled bars committed when a phase request arrives inside lookahead', () => {
    const timeline = new MusicTimeline(); timeline.schedule(0, 3.05);
    timeline.setPhase('battle');
    expect(timeline.nextBarAt).toBeCloseTo(6);
    expect(timeline.schedule(3.1, 3.01).find(e => e.transition)?.at).toBeCloseTo(6);
  });
  it('returns from outro to build after one bar', () => {
    const timeline = new MusicTimeline(0, 'outro');
    const bars = timeline.schedule(0, 6.01).filter(e => e.step === 0);
    expect(bars.map(e => e.phase)).toEqual(['outro', 'build', 'build']);
  });
  it('does not emit past notes after a sleeping tab resumes', () => {
    const timeline = new MusicTimeline(); timeline.schedule(0);
    expect(timeline.schedule(500).every(e => e.at >= 499.999)).toBe(true);
  });
  it('chooses reproducible, varied phrases independently for each bar', () => {
    const phrases = Array.from({ length: 32 }, (_, bar) => phraseForBar(42, bar, 'battle'));
    expect(phrases).toEqual(Array.from({ length: 32 }, (_, bar) => phraseForBar(42, bar, 'battle')));
    expect(new Set(phrases.map(p => JSON.stringify(p))).size).toBeGreaterThan(25);
    expect(phraseForBar(43, 0, 'battle')).not.toEqual(phrases[0]);
    const random = seededRandom(99), again = seededRandom(99);
    expect(Array.from({ length: 8 }, random)).toEqual(Array.from({ length: 8 }, again));
  });
  it('rejects invalid tick lengths', () => {
    const timeline = new MusicTimeline();
    for (const n of [0, -1, NaN, Infinity]) expect(() => timeline.syncTick(n)).toThrow(RangeError);
  });
});

describe('music graph and lifecycle', () => {
  it('waits for unlock, runs one scheduler, crossfades on the bar, and stops cleanly', async () => {
    const context = new MockContext();
    const engine = new AudioEngine({ contextFactory: () => context.asAudioContext(), storage: null, gestures: null });
    let pump = () => {};
    const timer = { set: vi.fn((callback: () => void, _ms: number) => { pump = callback; return 1; }), clear: vi.fn() };
    const music = new MusicSequencer(engine, 42, timer);
    music.start(); expect(timer.set).not.toHaveBeenCalled();
    await engine.unlock(); music.start();
    expect(timer.set).toHaveBeenCalledTimes(1);
    expect(timer.set.mock.calls[0]![1]).toBe(25);
    const firstLayer = (engine.getMusicBus() as unknown as MockNode);
    expect(context.nodes.filter(n => n.kind === 'oscillator').some(n => reaches(n, firstLayer))).toBe(true);
    music.setPhase('boss'); music.setIntensity(3);
    for (let i = 1; i <= 120; i++) { context.currentTime = i * 0.025; pump(); }
    const fades = context.nodes.flatMap(n => n.gain.events).filter(e => e.method === 'linear' && e.value === 0);
    expect(fades.some(e => Math.abs(e.time - 3.37) < 0.001)).toBe(true);
    music.stop(); expect(timer.clear).toHaveBeenCalledWith(1); expect(engine.activeVoiceCount).toBe(0);
    music.dispose(); await engine.dispose();
  });
});
