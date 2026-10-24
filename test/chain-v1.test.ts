import assert from 'node:assert/strict';
import { beforeAll, describe, it, expect } from 'vitest';
import { FailedTransactionMetadata } from 'litesvm';
import { buildKitRunInstruction } from '@jac0xb/ballista/kit';
import { generateKeyPairSigner, lamports } from '@solana/kit';
import { C, PART as P } from '../src/v1/constants.js';
import { newRun, playTurn, withPart, encodeActions, RuleError, xorshift, packState, decodeActions, type RunState, type Action } from '../src/v1/sim.js';
import { buildStartInstructions, buildTurnTransactions, buildStepInstruction, decodeCombatCursor, decodeRunState, decodeSessionState, parseTurnEvents, turnSteps, BALLISTA_ADDRESS } from '../src/chain-v1/client.js';
import { TEMPLATE_NAMES } from '../src/chain-v1/templates.js';
import { createHarness, exerciseRuns, type ChainHarness } from '../scripts/chain-v1-harness.js';
import { benchmarkReport, hashFile } from '../scripts/chain-v1-bench.js';
describe('Siege v1 Ballista port', () => {
    let h: ChainHarness;
    beforeAll(async () => { h = await createHarness(); }, 60000);
    it('finalizes every template and freezes the deployed native lookup table', () => {
        for (const name of TEMPLATE_NAMES) {
            const stats = h.deployment.compiled[name].stats;
            expect(stats.instructions, name).toBeLessThanOrEqual(128);
            expect(stats.registers, name).toBeLessThanOrEqual(64);
            expect(stats.maxExpandedCpis, name).toBeLessThanOrEqual(64);
            expect(h.svm.getAccount(h.deployment.addresses[name]).exists).toBe(true);
        }
        const table = h.svm.getAccount(h.lookup.address);
        assert.ok(table.exists);
        expect(table.data[21]).toBe(0); // Frozen ALT has no authority.
    });
    it('matches every state and complete event in 300 random/planner full runs', async () => {
        const hash = hashFile('src/v1/constants.ts');
        const corpus = await exerciseRuns(h, 300, info => console.log('CHAIN_V1_PROGRESS', JSON.stringify(info)));
        expect(hashFile('src/v1/constants.ts')).toBe(hash);
        expect(corpus.runs).toBe(300);
        expect(corpus.waves).toBeGreaterThan(300);
        expect(corpus.overclocks).toBeGreaterThan(0);
        const report = benchmarkReport(h, corpus);
        expect(report.metrics.tick.maxCu).toBeLessThan(1350000);
        expect(report.metrics.tick.maxBytes).toBeLessThanOrEqual(1232);
        expect(report.metrics.tick.maxTrace).toBeLessThanOrEqual(64);
        expect(report.metrics.tick.maxDepth).toBeLessThanOrEqual(5);
        console.log('CHAIN_V1_CORPUS', JSON.stringify({ corpus, metrics: report.metrics }));
    }, 3600000);
    it('matches 96 dense late-wave boards, including cross-lane support loss and the final storm', async () => {
        await h.start(0n);
        let rng = 0x8badf00dn, bosses = 0, damage = 0n;
        for (let sample = 0; sample < 96; sample++) {
            rng = xorshift(rng);
            let state: RunState = { ...newRun(sample % 2 ? ((1n << 64n) - 1n) : rng, 'practice'), wave: BigInt(sample % 10), gold: 500n };
            for (let cell = 0n; cell < 16n; cell++) {
                rng = xorshift(rng);
                const p = rng % 7n;
                state = withPart(state, cell, p, p ? 1n + (rng >> 8n) % 3n : 0n);
            }
            h.seed(state);
            const actions: Action[] = [];
            for (let cell = 0n; cell < 16n; cell++) {
                const p = (state.parts >> (4n * cell)) & 15n, t = (state.tiers >> (2n * cell)) & 3n;
                if (p > 0n && p <= P.PALISADE && t === 3n && actions.length < 6) actions.push({ type: 'overclock', cell });
            }
            const expected = playTurn(state, actions), sent = await h.turn(state, actions);
            assert.deepEqual(h.read(), expected.state, `dense ${sample}`);
            assert.deepEqual(sent.events, [expected.event], `dense event ${sample}`);
            if (state.wave === 4n || state.wave === 9n)
                bosses++;
            damage += expected.summary.damage;
        }
        expect(bosses).toBeGreaterThan(0);
        expect(damage).toBeGreaterThan(0n);
    }, 120000);
    it('handles six actions, rerolls, upgrades, tier-three refunds, and sell-funded purchases', async () => {
        const cases: Action[][] = [Array.from({ length: 6 }, () => ({ type: 'reroll' as const })), [{ type: 'buy', slot: 0n, cell: 1n }, { type: 'upgrade', cell: 1n }, { type: 'upgrade', cell: 1n }, { type: 'sell', cell: 1n }, { type: 'reroll' }, { type: 'buy', slot: 0n, cell: 5n }]];
        for (const actions of cases) {
            await h.start(0n);
            const s = { ...newRun(0n, 'practice'), gold: 100n };
            h.seed(s);
            const expected = playTurn(s, actions), sent = await h.turn(s, actions);
            expect(h.read()).toEqual(expected.state);
            expect(sent.events).toEqual([expected.event]);
        }
    });
    it('fails illegal actions atomically, including a legal prefix before the error', async () => {
        await h.start(11n);
        const state = newRun(11n, 'practice');
        const cases: Action[][] = [[{ type: 'upgrade', cell: 0n }], [{ type: 'sell', cell: 0n }], [{ type: 'buy', slot: 0n, cell: 0n }, { type: 'buy', slot: 0n, cell: 1n }], [{ type: 'buy', slot: 0n, cell: 0n }, { type: 'buy', slot: 1n, cell: 0n }], Array.from({ length: 6 }, () => ({ type: 'reroll' as const }))];
        for (const actions of cases) {
            expect(() => playTurn(state, actions)).toThrow(RuleError);
            const [tx] = await buildTurnTransactions(h.deployment, h.payer, state.wave, actions);
            const before = h.entry('work').data;
            const sent = await h.send(tx, 'illegal');
            expect(sent.result).toBeInstanceOf(FailedTransactionMetadata);
            expect(h.read()).toEqual(state);
            expect(h.entry('work').data).toEqual(before);
            expect(parseTurnEvents({ logs: sent.meta.logs(), err: sent.result }, h.deployment)).toEqual([]);
        }
        for (const word of [7n, 1n, 1n | (2n << 3n) | (1n << 10n), 1n | (4n << 3n) | (1n << 6n), 1n << 63n]) {
            expect(() => decodeActions(word)).toThrow();
            const [tx] = await buildTurnTransactions(h.deployment, h.payer, 0n, word);
            expect((await h.send(tx, 'malformed')).result).toBeInstanceOf(FailedTransactionMetadata);
            expect(h.cursor()).toBe(0n);
        }
    });
    it('rejects stale waves, altered routing, skipped steps, and another player entry', async () => {
        await h.start(42n);
        const s = newRun(42n, 'practice'), step = turnSteps(0n, 0n)[0];
        for (const bad of [{ ...step, expectedWave: 1n }, { ...step, target: 0n }, { ...step, next: 99n }, { ...step, cursor: 1n }, { ...step, op: 8n }]) {
            const sent = await h.send([await buildStepInstruction(h.deployment, h.payer, bad)], 'badStep');
            expect(sent.result).toBeInstanceOf(FailedTransactionMetadata);
            expect(h.read()).toEqual(s);
        }
        const other = await generateKeyPairSigner();
        h.svm.airdrop(other.address, lamports(1000000000n));
        const ix = buildKitRunInstruction({ compiled: h.deployment.compiled.state, templateAddress: h.deployment.addresses.state, inputs: { ...step }, accounts: { player: { address: other.address, signer: other }, run: { address: h.entries.run }, work: { address: h.entries.work }, systemProgram: { address: '11111111111111111111111111111111' as import('@solana/kit').Address }, ballista: { address: BALLISTA_ADDRESS }, ...Object.fromEntries(TEMPLATE_NAMES.filter(n => n !== 'state').map(n => [n, { address: h.deployment.addresses[n] }])) } });
        expect((await h.send([ix], 'wrongPlayer', other)).result).toBeInstanceOf(FailedTransactionMetadata);
    });
    it('resumes after a failed continuation and exposes the saved state during partial commit', async () => {
        await h.start(17n);
        const state = newRun(17n, 'practice'), expected = playTurn(state, []), txs = await buildTurnTransactions(h.deployment, h.payer, 0n, []);
        await h.success(txs[0], 'prepare');
        await h.success(txs[1], 'tick');
        const cursor = h.cursor();
        expect(cursor).toBe(14n);
        expect(h.read()).toEqual(state);
        expect((await h.send(txs[1], 'replay')).result).toBeInstanceOf(FailedTransactionMetadata);
        expect(h.cursor()).toBe(cursor);
        for (const tx of await buildTurnTransactions(h.deployment, h.payer, 0n, [], cursor)) {
            await h.success(tx, 'resume');
        }
        expect(h.read()).toEqual(expected.state);
        expect(h.cursor()).toBe(0n);
        await h.start(17n);
        const steps = turnSteps(0n, encodeActions([]));
        for (const tx of (await buildTurnTransactions(h.deployment, h.payer, 0n, [])).slice(0, 11))
            await h.success(tx, 'partial');
        for (const step of steps.filter(s => s.cursor >= 95n && s.cursor <= 96n))
            await h.success([await buildStepInstruction(h.deployment, h.payer, step)], 'partialCommit');
        const session = decodeSessionState(h.entry('run'), h.entry('work'));
        expect(session.cursor).toBe(97n);
        expect(session.pending).toBe(true);
        expect(session.state).toEqual(state);
        for (const tx of await buildTurnTransactions(h.deployment, h.payer, 0n, [], 97n))
            await h.success(tx, 'resumeCommit');
        expect(h.read()).toEqual(expected.state);
    });
    it('checks daily seed against Clock and rejects terminal turns', async () => {
        h.setDay(25000n);
        await h.start(25000n, 'daily');
        const before = h.entry('run').data;
        expect((await h.send(await buildStartInstructions(h.deployment, h.payer, 24999n, 'daily'), 'wrongDay')).result).toBeInstanceOf(FailedTransactionMetadata);
        expect(h.entry('run').data).toEqual(before);
        h.setDay(25001n);
        const [tx] = await buildTurnTransactions(h.deployment, h.payer, 0n, []);
        expect((await h.send(tx, 'expiredDay')).result).toBeInstanceOf(FailedTransactionMetadata);
        await h.start(0n);
        let terminal = { ...newRun(0n, 'practice'), wave: 10n, done: true, won: true };
        h.seed(terminal);
        const [ended] = await buildTurnTransactions(h.deployment, h.payer, 10n, []);
        expect((await h.send(ended, 'terminal')).result).toBeInstanceOf(FailedTransactionMetadata);
    });
    it('validates registry identity and refuses failed, truncated, and standalone helper events', async () => {
        await h.start(1n);
        const state = newRun(1n, 'practice'), sent = await h.turn(state, []), last = sent.receipts.at(-1)!;
        expect(parseTurnEvents({ logs: last.meta.logs(), err: null }, h.deployment)).toHaveLength(1);
        expect(parseTurnEvents({ logs: last.meta.logs(), err: 'failed' }, h.deployment)).toEqual([]);
        expect(parseTurnEvents({ logs: last.meta.logs().slice(0, -4), err: null }, h.deployment)).toEqual([]);
        const entry = h.entry('run'), other = (await generateKeyPairSigner()).address;
        expect(() => decodeRunState({ ...entry, player: other })).toThrow();
        const damaged = new Uint8Array(entry.data);
        damaged[5] = 1;
        expect(() => decodeRunState({ ...entry, data: damaged })).toThrow();
        const out = await h.success([buildKitRunInstruction({ compiled: h.deployment.compiled.event, templateAddress: h.deployment.addresses.event, inputs: { after0: 0n, after1: 0n, after2: 0n }, accounts: { run: { address: h.entries.run }, work: { address: h.entries.work } } })], 'standaloneEvent');
        expect(parseTurnEvents({ logs: out.meta.logs(), err: null }, h.deployment)).toEqual([]);
    });
});
