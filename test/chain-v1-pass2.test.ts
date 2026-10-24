import assert from 'node:assert/strict';
import { beforeAll, describe, expect, it } from 'vitest';
import { FailedTransactionMetadata } from 'litesvm';
import { buildKitRunInstruction } from '@jac0xb/ballista/kit';
import { C, PART as P } from '../src/v1/constants.js';
import { applyAction, newRun, playTurn, shop, withPart, type Action, type RunState } from '../src/v1/sim.js';
import { buildTurnTransactions, decodeRunState, encodeActions, parseTurnEvents } from '../src/chain-v1/client.js';
import { WORK_OFFSETS } from '../src/chain-v1/state.js';
import { createHarness, type ChainHarness } from '../scripts/chain-v1-harness.js';

describe('Siege pass 5 chain mechanics', () => {
    let h: ChainHarness;
    beforeAll(async () => { h = await createHarness(); await h.start(7n); }, 60000);
    const group = (pos: bigint, count: bigint, hp: bigint, body = hp) => pos | count << 3n | hp << 6n | body << 14n;
    async function helper(name: 'fire' | 'bite' | 'move' | 'survey' | 'lane' | 'quarry', values: Record<string, bigint>) {
        const out = await h.success([buildKitRunInstruction({ compiled: h.deployment.compiled[name], templateAddress: h.deployment.addresses[name], inputs: values, accounts: name === 'lane' ? Object.fromEntries(['ballista', 'fire', 'bite', 'move', 'survey'].map(n => [n, { address: n === 'ballista' ? h.entry('run').owner : h.deployment.addresses[n as 'fire'] }])) : name === 'quarry' ? { ballista: { address: h.entry('run').owner }, board: { address: h.deployment.addresses.board } } : {} })], name);
        const bytes = out.meta.returnData().data();
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true)
            | (bytes.length === 16 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(8, true) << 64n : 0n);
    }
    async function compare(state: RunState, actions: Action[]) {
        h.seed(state);
        const expected = playTurn(state, actions), sent = await h.turn(state, actions);
        assert.deepEqual(h.read(), expected.state);
        assert.deepEqual(sent.events, [expected.event]);
        expect(h.read().overclocked).toBe(0n);
        return expected;
    }

    it('encodes opcode 5, stages all three boosts, and clears them at settlement', async () => {
        let s = { ...newRun(7n, 'practice'), wave: 9n, gold: 100n };
        for (const [cell, part] of [[0n, P.BALLISTA], [5n, P.CAULDRON], [15n, P.PALISADE]]) s = withPart(s, cell, part, 3n);
        const actions: Action[] = [0n, 5n, 15n].map(cell => ({ type: 'overclock', cell }));
        expect(encodeActions([{ type: 'overclock', cell: 15n }])).toBe(1n | (5n | 15n << 3n) << 3n);
        h.seed(s);
        const txs = await buildTurnTransactions(h.deployment, h.payer, s.wave, actions);
        expect(txs).toHaveLength(12);
        await h.success(txs[0], 'prepare');
        const work = h.entry('work').data, view = new DataView(work.buffer, work.byteOffset, work.byteLength);
        expect(view.getUint16(WORK_OFFSETS.build + 14, true)).toBe((1 << 0) | (1 << 5) | (1 << 15));
        const lane = view.getBigUint64(WORK_OFFSETS.lane3, true) | view.getBigUint64(WORK_OFFSETS.lane3 + 8, true) << 64n;
        expect((lane >> (80n + 18n)) & 63n).toBe(60n);
        const events = [];
        for (const tx of txs.slice(1)) {
            const sent = await h.success(tx, 'continue');
            events.push(...parseTurnEvents({ logs: sent.meta.logs(), err: null }, h.deployment));
        }
        expect(h.read()).toEqual(playTurn(s, actions).state);
        expect(events).toEqual([playTurn(s, actions).event]);
    });

    it('allows a fresh boost after selling and rebuilding in six orders', async () => {
        let s = { ...newRun(7n, 'practice'), gold: 100n };
        s = withPart(s, 0n, shop(s)[0].part, 3n);
        await compare(s, [{ type: 'overclock', cell: 0n }, { type: 'sell', cell: 0n }, { type: 'buy', slot: 0n, cell: 0n },
            { type: 'upgrade', cell: 0n }, { type: 'upgrade', cell: 0n }, { type: 'overclock', cell: 0n }]);
        s = { ...s, overclocked: 1n };
        const out = await compare(s, [{ type: 'sell', cell: 0n }, { type: 'buy', slot: 0n, cell: 0n },
            { type: 'upgrade', cell: 0n }, { type: 'upgrade', cell: 0n }, { type: 'overclock', cell: 0n }]);
        expect(out.event.before[3] >> 34n).toBe(1n);
    });

    it('rejects ineligible, repeated, unaffordable and noncanonical boosts atomically', async () => {
        const base = { ...newRun(7n, 'practice'), gold: 100n };
        const weapon = withPart(base, 0n, P.BALLISTA, 3n);
        const cases: [RunState, Action[]][] = [
            [base, [{ type: 'overclock', cell: 0n }]],
            ...[1n, 2n].map(t => [withPart(base, 0n, P.BALLISTA, t), [{ type: 'overclock', cell: 0n }]] as [RunState, Action[]]),
            ...[P.FORGE, P.WATCHTOWER, P.QUARRY].map(p => [withPart(base, 0n, p, 3n), [{ type: 'overclock', cell: 0n }]] as [RunState, Action[]]),
            [{ ...weapon, overclocked: 1n }, [{ type: 'overclock', cell: 0n }]],
            [{ ...weapon, gold: C.OVERCLOCK_COST - 1n }, [{ type: 'overclock', cell: 0n }]],
            [weapon, [{ type: 'overclock', cell: 0n }, { type: 'overclock', cell: 0n }]],
            [base, [{ type: 'buy', slot: 0n, cell: 0n }, { type: 'overclock', cell: 0n }]],
        ];
        for (const [s, actions] of cases) {
            expect(() => actions.reduce(applyAction, s)).toThrow();
            h.seed(s);
            const before = h.entry('work').data;
            const [tx] = await buildTurnTransactions(h.deployment, h.payer, s.wave, actions);
            expect((await h.send(tx, 'illegalBoost')).result).toBeInstanceOf(FailedTransactionMetadata);
            expect(h.read()).toEqual(s);
            expect(h.entry('work').data).toEqual(before);
        }
        h.seed(weapon);
        for (const word of [1n | (5n | 1n << 7n) << 3n, 1n | 6n << 3n, 1n | 7n << 3n]) {
            const [tx] = await buildTurnTransactions(h.deployment, h.payer, 0n, word);
            expect((await h.send(tx, 'badBoostWord')).result).toBeInstanceOf(FailedTransactionMetadata);
            expect(h.read()).toEqual(weapon);
        }
    });

    it('decodes the full 16-bit mask and rejects reserved or ineligible bits', () => {
        let s: RunState = { ...newRun(7n, 'practice'), overclocked: 0n };
        for (let cell = 0n; cell < 16n; cell++) s = withPart(s, cell, P.BALLISTA, 3n);
        s.overclocked = 65535n;
        h.seed(s);
        expect(decodeRunState(h.entry('run')).overclocked).toBe(65535n);
        for (const [offset, bit] of [[102, 4], [103, 8], [103, 128]]) {
            const entry = h.entry('run'), data = entry.data.slice(); data[offset] |= bit;
            expect(() => decodeRunState({ ...entry, data })).toThrow();
        }
        const entry = h.entry('run'), data = entry.data.slice(); data[80] = (data[80] & ~15) | Number(P.FORGE); // Boost on a support is invalid.
        expect(() => decodeRunState({ ...entry, data })).toThrow();
    });

    it('applies armor once to pooled splash and halves pooled odd bolts once', async () => {
        const base = { queue: group(2n, 2n, 9n), kinds: 1n, damageTable: 0n, coverage: 0n, boltDivisor: 1n };
        const one = await helper('fire', { ...base, splash: 1n << 16n });
        const two = await helper('fire', { ...base, splash: 2n << 16n });
        expect((one >> 6n) & 255n).toBe(9n);
        expect((two >> 6n) & 255n).toBe(8n);
        expect((two >> 14n) & 63n).toBe(8n);
        const boss = { queue: group(2n, 1n, 108n, 0n), kinds: 2n, damageTable: 6n << 24n, coverage: 3n << 8n, splash: 0n };
        const shielded = await helper('fire', { ...boss, boltDivisor: 2n });
        const open = await helper('fire', { ...boss, boltDivisor: 1n });
        expect((shielded >> 6n) & 255n).toBe(105n); // Pool two 3-damage bolts, then halve.
        expect((open >> 6n) & 255n).toBe(102n);
    });

    it('uses parity bites and HP-scaled leaks for movement and the storm', async () => {
        const queue = group(2n, 1n, 54n, 0n);
        for (const [tick, hp] of [[2n, 38n], [3n, 48n]]) {
            const out = await helper('lane', { queue, kinds: 2n, hp: 48n, parts: P.PALISADE, tiers: 3n, lane: 0n, wave: 5n, tick, overclocked: 0n });
            expect((out >> 80n) & 63n).toBe(hp);
        }
        for (const [tick, hp] of [[2n, 104n], [3n, 100n]]) {
            const out = await helper('lane', { queue: group(2n, 1n, 108n, 0n), kinds: 2n, hp: 0n, parts: 0x11n, tiers: 0x11n, lane: 0n, wave: 10n, tick, overclocked: 0n });
            expect((out >> 6n) & 255n).toBe(hp);
        }
        expect(await helper('bite', { queue, kinds: 2n, hp: 48n, bossBite: 10n })).toBe(38n);
        expect(await helper('bite', { queue, kinds: 2n, hp: 48n, bossBite: 0n })).toBe(48n);
        for (const [hp, damage] of [[0n, 0n], [1n, 5n], [27n, 5n], [28n, 6n], [54n, 6n], [55n, 7n], [81n, 7n], [82n, 8n], [108n, 8n]]) {
            for (const storm of [false, true]) {
                const out = await helper('move', { queue: group(storm ? 5n : 1n, hp ? 1n : 0n, hp, 0n), kinds: 2n,
                    hp: storm ? 60n << 18n : 0n, parts: 0n, tick: storm ? 10n : 6n, bossHp: 108n });
                expect((out >> 108n) & 255n).toBe(damage);
            }
        }
    });

    it('boosts damage before caps and pays deep income only to active Quarries', async () => {
        let s = withPart(newRun(7n, 'practice'), 1n, P.BALLISTA, 3n);
        for (const c of [0n, 2n, 5n]) s = withPart(s, c, P.FORGE, 3n);
        s = withPart(s, 9n, P.WATCHTOWER, 3n);
        const tiers = Array.from({ length: 16 }, (_, i) => ((s.tiers >> BigInt(2 * i)) & 3n) << BigInt(4 * i)).reduce((a, b) => a | b);
        const towers = await helper('survey', { parts: s.parts, tiers, lane: 0n, overclocked: 2n });
        expect((towers >> 32n) & 63n).toBe(63n);
        for (const [cell, tier, expected] of [[0n, 1n, 2n], [2n, 1n, 3n], [3n, 3n, 7n]]) {
            const mine = withPart(newRun(7n, 'practice'), cell, P.QUARRY, tier);
            expect(await helper('quarry', { parts: mine.parts, tiers: mine.tiers, disabled: 0n })).toBe(expected);
            expect(await helper('quarry', { parts: mine.parts, tiers: mine.tiers, disabled: 1n << cell })).toBe(0n);
        }
        for (const cell of [0n, 2n, 3n]) {
            const out = await compare(withPart(newRun(7n, 'practice'), cell, P.QUARRY, 1n), []);
            const active = (out.frames.at(-1)!.disabled & (1n << cell)) === 0n;
            expect(out.summary.quarry).toBe(active ? 2n + (cell >= 2n ? 1n : 0n) : 0n);
        }
    });
});
