import { beforeAll, describe, it, expect } from 'vitest';
import { Clock, FailedTransactionMetadata } from 'litesvm';
import { generateKeyPairSigner } from '@solana/kit';
import { createHarness, type ChainHarness } from '../scripts/chain-v1-harness.js';
import { buildStartInstructions, buildStepInstruction, buildTurnTransactions, decodeSessionState, turnSteps } from '../src/chain-v1/client.js';
import { newRun, playTurn } from '../src/v1/sim.js';
import {C} from '../src/v1/constants.js';
import {checkTuning} from '../src/chain-v1/templates.js';
describe('Siege v1 client boundaries', () => {
    let h: ChainHarness;
    beforeAll(async () => { h = await createHarness(); }, 60000);
    it('rejects a tuning change whose pooled clear grant would truncate', () => {
        const tuning = C as unknown as { CLEAR_GOLD: bigint };
        const old = tuning.CLEAR_GOLD;
        try {
            tuning.CLEAR_GOLD = 64n;
            expect(checkTuning).toThrow('chain packing');
        } finally {
            tuning.CLEAR_GOLD = old;
        }
    });
    it('binds all three start words to the stored seed', async () => {
        h.setDay(25000n);
        await h.start(7n);
        const before = h.entry('run').data, base = turnSteps(0n, 0n)[0];
        const first = await buildStepInstruction(h.deployment, h.payer, { ...base, op: 0n, cursor: 0n, next: 1001n, target: 0n, seed: 17n, mode: 0n });
        const second = await buildStepInstruction(h.deployment, h.payer, { ...base, op: 0n, cursor: 1001n, next: 1002n, target: 1n, seed: 25000n, mode: 1n });
        expect((await h.send([first, second], 'mixedStart')).result).toBeInstanceOf(FailedTransactionMetadata);
        expect(h.entry('run').data).toEqual(before);
        expect(h.cursor()).toBe(0n);
    });
    it('ignores negative Clock for practice and rejects it for daily', async () => {
        const c = h.svm.getClock();
        h.svm.setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, -1n));
        await h.start(0n);
        expect(h.read()).toEqual(newRun(0n, 'practice'));
        expect((await h.send(await buildStartInstructions(h.deployment, h.payer, 0n, 'daily'), 'negativeDaily')).result).toBeInstanceOf(FailedTransactionMetadata);
        h.setDay(25000n);
    });
    it('rejects invalid cursors, mismatched sessions, and substituted immutable helpers', async () => {
        await h.start(1n);
        await expect(buildTurnTransactions(h.deployment, h.payer, 0n, [], 500n)).rejects.toThrow('cursor');
        await expect(buildStartInstructions(h.deployment, h.payer, 0n, 'bad' as 'practice')).rejects.toThrow('mode');
        const other = (await generateKeyPairSigner()).address;
        expect(() => decodeSessionState(h.entry('run'), { ...h.entry('work'), player: other })).toThrow('Mismatched');
        const [tx] = await buildTurnTransactions(h.deployment, h.payer, 0n, []), ix = tx[1];
        const changed = { ...ix, accounts: ix.accounts!.map(meta => meta.address === h.deployment.addresses.roll ? { ...meta, address: h.deployment.addresses.shop } : meta) };
        expect((await h.send([changed], 'substitution')).result).toBeInstanceOf(FailedTransactionMetadata);
        expect(h.read()).toEqual(newRun(1n, 'practice'));
    });
    it('authenticates the final event at the normal 10KB log limit', async () => {
        h.svm.withLogBytesLimit(10000n);
        await h.start(0n);
        const state = newRun(0n, 'practice'), sent = await h.turn(state, []);
        expect(sent.events).toEqual([playTurn(state, []).event]);
        expect(h.read()).toEqual(playTurn(state, []).state);
        h.svm.withLogBytesLimit(1000000n);
    });
});
