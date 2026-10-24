import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Action, EnemyGroup, RunState, TickFrame } from '../../src/v1/sim.js';
import { makeTimeline, isStorm, type ReplayPhase, type ReplayStep } from '../replay.js';
import { actionSound, battleSounds, damageIntensity, followMusic, musicState, pickSound, playBattleSounds, resultSound, settlementSound } from './game.js';
import { battleTrack } from './track.js';

const recording = JSON.parse(readFileSync(new URL('./fixtures/seed13.json', import.meta.url), 'utf8'), (_key, value) =>
  typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value) as { start: RunState; built: RunState; actions: Action[]; frames: TickFrame[] }[];
const phases: ReplayPhase[] = ['fire', 'hit', 'bite', 'move', 'impact'];

// This oracle reads frame arrays directly; it does not use the presentation readouts.
function expected(step: ReplayStep, phase: ReplayPhase): [string, number][] {
  const f = step.frame, events: { kind: string; lane: number; at: number }[] = [];
  const add = (kind: string, lane: bigint, at = 0) => { if (!events.some(e => e.kind === kind && e.lane === Number(lane) && e.at === at)) events.push({ kind, lane: Number(lane), at }); };
  if (phase === 'fire') {
    const sources = [...f.shots.map(s => ({ from: s.from, kind: 'ballista-fire' })), ...f.splashes.map(s => ({ from: s.from, kind: 'cauldron-fire' }))].sort((a, b) => Number(a.from - b.from));
    sources.forEach((s, i) => add(s.kind, s.from / 4n, 20 + i * 40));
  }
  if (phase === 'hit') for (const g of step.before.filter(g => g.status === 'active')) {
    if (f.shots.some(s => s.group === g.id && s.damage > 0n)) add('bolt-hit', g.lane);
    if (f.splashes.some(s => s.targets.some(t => t.group === g.id && t.damage > 0n))) add('splash', g.lane);
    if (f.mitigations?.some(m => m.group === g.id && (m.ballista || m.splash))) add('armour-block', g.lane);
    const kills = f.kills.filter(k => k.group === g.id);
    for (let unit = 0n; unit < kills.reduce((n, k) => n + k.count, 0n); unit++) add(g.kind === 'boss' ? 'boss-killed' : 'unit-killed', g.lane, Number(unit) * 40);
    if (kills.some(k => k.bounty > 0n)) add('gold', g.lane, g.kind === 'boss' ? 700 : 0);
  }
  if (phase === 'bite') {
    f.bites.filter(b => b.damage > 0n).forEach(b => add('fence-bite', b.cell / 4n, 200));
    f.palisades.filter(p => !p.hp && f.bites.some(b => b.cell === p.cell && b.damage > 0n)).forEach(p => add('fence-break', p.cell / 4n, 200));
  }
  if (phase === 'move') f.tramples.forEach(t => add('trample', t.cell / 4n, 255));
  if (phase === 'impact') {
    f.leaks.filter(l => !isStorm(step, l.group)).forEach(l => add('leak', l.lane));
    [...new Set(f.leaks.filter(l => isStorm(step, l.group)).map(l => l.lane))].forEach((lane, i) => {
      add('storm', lane, i * 350); add('leak', lane, (i + 1) * 350);
    });
  }
  return events.sort((a, b) => a.at - b.at).map(e => [e.kind, e.lane]);
}

describe('battle frame audio', () => {
  it.each([5, 10])('plays recorded seed 13 wave %i in frame order, once per merged contact', async wave => {
    vi.useFakeTimers();
    try {
      const turn = recording[wave - 1], timeline = makeTimeline(turn.built, turn.frames);
      const emit = vi.fn(); const ordered: [string, number][] = [];
      for (const step of timeline.filter(s => s.duration)) for (const phase of phases.filter(p => step.phases[p])) {
        emit.mockClear();
        playBattleSounds(step, phase, 1, (fn, ms) => setTimeout(fn, ms), emit);
        await vi.advanceTimersByTimeAsync(step.phases[phase]);
        const calls = emit.mock.calls.map(([kind, opts]) => [kind, opts.lane] as [string, number]);
        expect(calls, `T${step.frame.tick} ${phase}`).toEqual(expected(step, phase)); ordered.push(...calls);
      }
      expect(ordered.length).toBeGreaterThan(30);
      expect(ordered.some(([kind]) => kind === 'armour-block')).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('stretches kills with their collapse and halves all contact delays at 2×', () => {
    const turn = recording[4], step = makeTimeline(turn.built, turn.frames).find(s => s.frame.kills.some(k => k.count > 1n))!;
    const delayed: number[] = [], emit = vi.fn();
    playBattleSounds(step, 'hit', 2, (_fn, ms) => delayed.push(ms), emit);
    expect(delayed).toContain(20); expect(delayed.every(ms => ms % 20 === 0)).toBe(true);
    expect(battleSounds(step, 'hit').filter(s => s.kind === 'unit-killed' && s.delay === 0).length).toBeGreaterThan(0);
  });
  it('maps bounded damage and wall loss into 0–3 without unsafe bigint conversion', () => {
    expect([0n, 2n, 3n, 5n, 6n, 10n, 11n, 2n ** 64n].map(damageIntensity)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
  it('bases leak intensity on walls actually lost, including overkill', () => {
    const turn = recording[4], step = makeTimeline(turn.built, turn.frames).find(s => s.frame.leaks.length)!;
    const sounds = battleSounds({ ...step, wallsBefore: 1n }, 'impact').filter(s => s.kind === 'leak');
    expect(sounds.length).toBeGreaterThan(0); expect(sounds.every(s => s.intensity === 0)).toBe(true);
  });
  it('gives offline rendering the same ordered contacts and 1× clock', async () => {
    vi.useFakeTimers();
    try {
      const turn = recording[4], timeline = makeTimeline(turn.built, turn.frames), track = battleTrack(timeline, 5n);
      let at = 0;
      const heard: { at: number; kind: string; lane: number }[] = [];
      for (const step of timeline.filter(s => s.duration)) for (const phase of phases.filter(p => step.phases[p])) {
        playBattleSounds(step, phase, 1, (fn, ms) => setTimeout(fn, ms), (kind, opts) => heard.push({ at: Date.now(), kind, lane: opts!.lane! }));
        await vi.advanceTimersByTimeAsync(step.phases[phase]); at += step.phases[phase];
      }
      const sounds = track.events.filter(e => e.type === 'sound').slice(0, -2);
      expect(heard.map(e => [e.at - (Date.now() - at), e.kind, e.lane])).toEqual(sounds.map(e => [e.at, e.kind, e.options.lane]));
      expect(track.duration).toBe(at + 4000);
    } finally { vi.useRealTimers(); }
  });
});

describe('build and result audio', () => {
  it.each([
    [{ type: 'buy', slot: 0n, cell: 9n }, 'place', 2],
    [{ type: 'upgrade', cell: 4n }, 'upgrade', 1],
    [{ type: 'sell', cell: 12n }, 'sell', 3],
    [{ type: 'overclock', cell: 1n }, 'overclock', 0],
    [{ type: 'reroll' }, 'reroll', undefined],
  ] as const)('plays action after success', (action, kind, lane) => {
    const emit = vi.fn(); actionSound(action, emit); expect(emit).toHaveBeenCalledExactlyOnceWith(kind, lane === undefined ? {} : { lane });
  });
  it('ticks a card pick or UI click once', () => { const emit = vi.fn(); pickSound(emit); expect(emit).toHaveBeenCalledExactlyOnceWith('ui-click'); });
  it.each([['summary', false, 'wave-won'], ['end', true, 'run-won'], ['end', false, 'run-lost']] as const)('plays %s result', (phase, won, kind) => {
    const emit = vi.fn(); resultSound(phase, won, emit); expect(emit).toHaveBeenCalledExactlyOnceWith(kind);
  });
  it('chimes for the settlement coin', () => { const emit = vi.fn(); settlementSound(emit); expect(emit).toHaveBeenCalledExactlyOnceWith('gold'); });
});

describe('music follows seed 13', () => {
  it('maps every phase and active depth across ten recorded waves at both speeds', () => {
    const port = { setPhase: vi.fn(), setIntensity: vi.fn(), syncTick: vi.fn() }, seen = new Set<string>();
    for (const turn of recording) {
      const wave = turn.start.wave + 1n;
      followMusic('build', wave, [], undefined, 1, port); expect(port.setPhase).toHaveBeenLastCalledWith('build');
      for (const step of makeTimeline(turn.built, turn.frames).filter(s => s.duration)) for (const groups of [step.before, step.frame.groups]) {
        const active = groups.filter(g => g.status === 'active' && g.count > 0n);
        const phase = [5n, 10n].includes(wave) && active.some(g => g.kind === 'boss') ? 'boss' : 'battle';
        const intensity = active.length ? Math.max(0, Math.min(3, 4 - Math.min(...active.map(g => Number(g.pos))))) : 0;
        for (const speed of [1, 2]) {
          followMusic('battle', wave, groups, step.duration, speed, port);
          expect(port.setPhase).toHaveBeenLastCalledWith(phase); expect(port.setIntensity).toHaveBeenLastCalledWith(intensity);
          expect(port.syncTick).toHaveBeenLastCalledWith(step.duration / speed); seen.add(phase); seen.add(String(intensity));
        }
      }
      for (const phase of ['summary', 'end'] as const) { followMusic(phase, wave, [], undefined, 1, port); expect(port.setPhase).toHaveBeenLastCalledWith('outro'); }
    }
    expect([...seen].sort()).toEqual(['0', '1', '2', '3', 'battle', 'boss']);
  });
  it.each(['dead', 'queued', 'leaked', 'retreated'] as const)('ignores %s bosses and nearby groups', status => {
    const g = { kind: 'boss', status, count: 1n, pos: 1n } as EnemyGroup;
    expect(musicState('battle', 5n, [g])).toEqual({ phase: 'battle', intensity: 0 });
  });
});
