import { describe, expect, it } from 'vitest';
import { C, SECONDS_PER_DAY } from '../src/rules/constants.js';
import { emptyState, play, start } from '../src/rules/sim.js';
import { LocalBackend, dayFromSearch } from './backend.js';

describe('local game backend', () => {
  it('starts from UTC clock and refreshes the day on restart', async () => {
    let now = Number(20000n * SECONDS_PER_DAY * 1000n + 86399999n);
    const backend = new LocalBackend({ now: () => now });
    await backend.start();
    expect(backend.state()).toEqual(start(emptyState(), BigInt(Math.floor(now / 1000))));
    expect(backend.state().day).toBe(20000n);
    now += 1;
    await backend.start();
    expect(backend.state().day).toBe(20001n);
  });

  it('matches simulator state and every WaveEvent for a complete run', async () => {
    const backend = new LocalBackend({ day: 123n });
    await backend.start();
    let reference = start(emptyState(), 123n * SECONDS_PER_DAY);
    while (!reference.done) {
      const pick = reference.wave % 3n;
      const cell = (reference.wave * 5n) % 16n;
      const next = play(reference, reference.wave, pick, cell);
      expect(await backend.play(pick, cell)).toEqual(next.event);
      expect(backend.state()).toEqual(next.state);
      reference = next.state;
    }
    await expect(backend.play(0n, 0n)).rejects.toThrow('run is over');
    expect(backend.state()).toEqual(reference);
  });

  it('returns snapshots and leaves state unchanged after rejected moves', async () => {
    const backend = new LocalBackend({ day: 42n });
    await expect(backend.play(0n, 0n)).rejects.toThrow('Start a run');
    await backend.start();
    const before = backend.state();
    const snapshot = backend.state();
    snapshot.walls = 999n;
    expect(backend.state()).toEqual(before);
    await expect(backend.play(3n, 0n)).rejects.toThrow('bad pick');
    await expect(backend.play(0n, 16n)).rejects.toThrow('bad cell');
    expect(backend.state()).toEqual(before);
  });

  it('restarts the same puzzle while keeping the daily best', async () => {
    const backend = new LocalBackend({ day: 42n });
    await backend.start();
    while (!backend.state().done) await backend.play(0n, 0n);
    const finished = backend.state();
    await backend.start();
    expect(backend.state()).toEqual({
      ...start(emptyState(), 42n * SECONDS_PER_DAY),
      bestDay: finished.bestDay,
      bestScore: finished.bestScore,
    });
    expect(backend.state().walls).toBe(C.WALLS_START);
  });

  it('rejects an overflowing day before starting', async () => {
    const backend = new LocalBackend({ day: 1n << 64n });
    await expect(backend.start()).rejects.toThrow('u64 out of range');
    expect(backend.state()).toEqual(emptyState());
  });
});

describe('test day URL', () => {
  it('uses UTC clock when no override is supplied', () => {
    expect(dayFromSearch('')).toBeUndefined();
    expect(dayFromSearch('?other=123')).toBeUndefined();
  });

  it('accepts day zero and exact integer overrides', () => {
    expect(dayFromSearch('?day=0')).toBe(0n);
    expect(dayFromSearch('?day=20748')).toBe(20748n);
  });

  it('rejects malformed and overflowing overrides', () => {
    for (const value of ['', '-1', '1.5', 'abc', 'Infinity']) {
      expect(() => dayFromSearch(`?day=${value}`)).toThrow('non-negative integer');
    }
    expect(() => dayFromSearch(`?day=${1n << 64n}`)).toThrow('u64 range');
  });
});
