import { describe, expect, it } from 'vitest';
import { C, LIMITS } from '../src/v1/constants.js';
import { applyAction, newRun, shop, type Action } from '../src/v1/sim.js';
import { BuildQueue, rebuild } from './queue.js';
import { LocalBackend } from './backend.js';

const start = () => ({ ...newRun(20748n, 'practice'), gold: 100n });

describe('turn queue and undo', () => {
  it('rebuilds from turn start, restoring gold, stock, part, and tier on undo', () => {
    const initial = start(), queue = new BuildQueue(initial);
    const buy: Action = { type: 'buy', slot: 0n, cell: 1n };
    const upgraded: Action = { type: 'upgrade', cell: 1n };
    expect(queue.attempt(buy)).toEqual({ ok: true });
    const boughtState = applyAction(initial, buy);
    expect(queue.attempt(upgraded)).toEqual({ ok: true });
    expect(queue.state).toEqual(rebuild(initial, [buy, upgraded]));
    expect(queue.undo()).toEqual({ ok: true });
    expect(queue.state).toEqual(boughtState);
    expect(queue.undo()).toEqual({ ok: true });
    expect(queue.state).toEqual(initial);
    expect(queue.actions).toEqual([]);
    expect(initial).toEqual(start());
  });

  it('restores a sold, upgraded part without calculating a reverse transaction', () => {
    const initial = start(), queue = new BuildQueue(initial);
    const actions: Action[] = [{ type: 'buy', slot: 0n, cell: 2n }, { type: 'upgrade', cell: 2n }];
    actions.forEach(action => expect(queue.attempt(action).ok).toBe(true));
    const beforeSale = queue.state;
    expect(queue.attempt({ type: 'sell', cell: 2n }).ok).toBe(true);
    queue.undo();
    expect(queue.state).toEqual(beforeSale);
    expect(queue.state).toEqual(rebuild(initial, actions));
  });

  it('commits prior orders on reroll and only undoes later orders', () => {
    const queue = new BuildQueue(start());
    queue.attempt({ type: 'buy', slot: 0n, cell: 0n });
    queue.attempt({ type: 'reroll' });
    const committed = queue.state, offers = shop(committed);
    expect(queue.canUndo).toBe(false);
    expect(queue.locked).toBe(2);
    expect(queue.undo().ok).toBe(false);
    queue.attempt({ type: 'buy', slot: offers[0].slot, cell: 4n });
    expect(queue.canUndo).toBe(true);
    queue.undo();
    expect(queue.state).toEqual(committed);
    expect(shop(queue.state)).toEqual(offers);
    expect(queue.undo().ok).toBe(false);
  });

  it('returns copies so callers cannot corrupt the next rebuild', () => {
    const queue = new BuildQueue(start());
    queue.attempt({ type: 'buy', slot: 0n, cell: 0n });
    const state = queue.state, actions = queue.actions as Action[];
    state.gold = 0n;
    actions[0] = { type: 'reroll' };
    expect(queue.state.gold).not.toBe(0n);
    expect(queue.actions[0].type).toBe('buy');
  });
});

describe('illegal actions stay inline and atomic', () => {
  it('rejects occupied cells and sold offers without altering queued state', () => {
    const queue = new BuildQueue(start());
    queue.attempt({ type: 'buy', slot: 0n, cell: 0n });
    const before = queue.state, actions = queue.actions;
    const occupied = queue.attempt({ type: 'buy', slot: 1n, cell: 0n });
    expect(occupied).toMatchObject({ ok: false, reason: expect.stringContaining('occupied') });
    expect(queue.attempt({ type: 'buy', slot: 0n, cell: 1n })).toMatchObject({ ok: false, reason: expect.stringContaining('sold') });
    expect(queue.state).toEqual(before);
    expect(queue.actions).toEqual(actions);
  });

  it('handles missing gold, empty upgrade/sale, invalid indexes, and action cap', () => {
    const poor = new BuildQueue({ ...start(), gold: 0n });
    expect(poor.attempt({ type: 'buy', slot: 0n, cell: 0n })).toMatchObject({ ok: false, reason: expect.stringContaining('gold') });
    expect(poor.attempt({ type: 'upgrade', cell: 1n }).ok).toBe(false);
    expect(poor.attempt({ type: 'sell', cell: 1n }).ok).toBe(false);
    expect(poor.attempt({ type: 'buy', slot: 99n, cell: 0n }).ok).toBe(false);
    expect(poor.actions).toHaveLength(0);
    const full = new BuildQueue(start());
    for (let i = 0; i < LIMITS.ACTIONS; i++) expect(full.attempt({ type: 'reroll' }).ok).toBe(true);
    const before = full.state;
    expect(full.attempt({ type: 'reroll' })).toMatchObject({ ok: false, reason: expect.stringContaining('Max 6') });
    expect(full.state).toEqual(before);
  });

  it('leaves backend turn start intact when a later command fails', async () => {
    const backend = new LocalBackend(20748n, 'practice'), before = backend.state;
    await expect(backend.playTurn([
      { type: 'buy', slot: 0n, cell: 0n }, { type: 'buy', slot: 1n, cell: 0n },
    ])).rejects.toThrow('cell occupied');
    expect(backend.state).toEqual(before);
    expect(backend.state.gold).toBe(C.START_GOLD);
    expect(backend.shop().every(offer => offer.available)).toBe(true);
  });
});
