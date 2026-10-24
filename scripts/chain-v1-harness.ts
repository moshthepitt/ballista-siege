import assert from 'node:assert/strict';
import { compileTemplate, expression } from '@jac0xb/ballista';
import { LiteSVM, Clock, ComputeBudget, FailedTransactionMetadata } from 'litesvm';
import { appendTransactionMessageInstructions, compressTransactionMessageUsingAddressLookupTables, compileTransactionMessage, createTransactionMessage, generateKeyPairSigner, getTransactionEncoder, lamports, pipe, setTransactionMessageFeePayerSigner, signTransactionMessageWithSigners, type Instruction, type TransactionSigner } from '@solana/kit';
import { BALLISTA_ADDRESS, createDeployment, buildUploadPlan, buildLookupTablePlan, getEntryAddresses, buildStartInstructions, buildTurnTransactions, computeBudgetInstruction, decodeRunState, decodeCombatCursor, parseTurnEvents, type LookupTable } from '../src/chain-v1/client.js';
import { packState, newRun, playTurn, xorshift, type Action, type Mode, type RunState } from '../src/v1/sim.js';
import { random, planner } from '../src/v1/bots/index.js';
import { defineTemplates } from '../src/chain-v1/templates.js';
export interface Measurement {
    kind: string;
    cu: number;
    bytes: number;
    accounts: number;
    trace: number;
    depth: number;
}
export async function createHarness(options: { skipEmptyLanes?: boolean } = {}) {
    const svm = new LiteSVM().withTransactionHistory(0n).withLogBytesLimit(1000000n);
    const budget = new ComputeBudget();
    budget.computeUnitLimit = 1350000n;
    budget.maxInstructionTraceLength = 64n;
    budget.maxInstructionStackDepth = 5n;
    svm.withComputeBudget(budget);
    // BALLISTA_SO tests another build, such as one dumped from devnet.
    svm.addProgramFromFile(BALLISTA_ADDRESS, process.env.BALLISTA_SO ?? new URL('../vendor/ballista.so', import.meta.url).pathname);
    const payer = await generateKeyPairSigner();
    svm.airdrop(payer.address, lamports(100000000000n));
    const deployment = await createDeployment(payer.address);
    if (options.skipEmptyLanes === false) {
        // Measurement ablation: retain the same owner, wire protocol and cached kinds.
        const template = defineTemplates(deployment.addresses).lanePhase;
        deployment.compiled.lanePhase = compileTemplate({ ...template, steps: template.steps.map(s => s.kind === 'repeat' ? { ...s, count: expression.u64(1) } : s) });
    }
    let lookup: LookupTable | undefined;
    const measurements: Measurement[] = [];
    async function send(instructions: readonly Instruction[], kind = 'other', signer: TransactionSigner = payer) {
        const budgeted = instructions[0]?.programAddress === computeBudgetInstruction().programAddress ? instructions : [computeBudgetInstruction(), ...instructions];
        let message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(signer, tx), tx => svm.setTransactionMessageLifetimeUsingLatestBlockhash(tx), tx => appendTransactionMessageInstructions(budgeted, tx));
        if (lookup)
            message = compressTransactionMessageUsingAddressLookupTables(message, { [lookup.address]: lookup.addresses }) as typeof message;
        const transaction = await signTransactionMessageWithSigners(message), bytes = getTransactionEncoder().encode(transaction).length;
        assert.ok(bytes <= 1232, `${kind}: ${bytes} transaction bytes`);
        const result = svm.sendTransaction(transaction), meta = result instanceof FailedTransactionMetadata ? result.meta() : result;
        const depths = meta.logs().flatMap(l => { const m = l.match(/^Program \S+ invoke \[(\d+)\]$/); return m ? [Number(m[1])] : []; });
        const compiled = compileTransactionMessage(message);
        const m = { kind, cu: Number(meta.computeUnitsConsumed()), bytes, accounts: compiled.staticAccounts.length + (lookup ? compiled.addressTableLookups?.reduce((n, t) => n + t.readonlyIndexes.length + t.writableIndexes.length, 0) ?? 0 : 0), trace: depths.length, depth: Math.max(0, ...depths) };
        if (!(result instanceof FailedTransactionMetadata))
            measurements.push(m);
        return { result, meta, measurement: m };
    }
    async function success(instructions: readonly Instruction[], kind = 'other') { const sent = await send(instructions, kind); if (sent.result instanceof FailedTransactionMetadata)
        throw Error(kind + ': ' + sent.result.err() + '\n' + sent.meta.logs().join('\n')); return sent; }
    const plans = await buildUploadPlan(deployment);
    for (const plan of plans)
        for (const item of plan.instructions)
            await success([item.instruction], 'upload');
    svm.warpToSlot(10n);
    svm.setSlotHashes([{ slot: 9n, hash: svm.latestBlockhash() }]);
    const recent = 9n;
    const table = await buildLookupTablePlan(deployment, payer.address, recent);
    for (const ix of table.instructions)
        await success([ix], 'lookup');
    svm.warpToSlot(svm.getClock().slot + 1n);
    lookup = table.lookup;
    const entries = await getEntryAddresses(deployment, payer.address);
    const entry = (name: 'run' | 'work') => { const a = svm.getAccount(entries[name]); if (!a.exists)
        throw Error('Missing ' + name); return { data: new Uint8Array(a.data), owner: a.programAddress, template: deployment.addresses.state, player: payer.address }; };
    const read = () => decodeRunState(entry('run')), cursor = () => decodeCombatCursor(entry('work'));
    function setDay(day: bigint, seconds = 0n) { const c = svm.getClock(); svm.setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, day * 86400n + seconds)); }
    async function start(seed: bigint, mode: Mode = 'practice') { return success(await buildStartInstructions(deployment, payer, seed, mode, svm.getAccount(entries.work).exists ? cursor() : 0n), 'start'); }
    async function turn(state: RunState, actions: readonly Action[] | bigint) {
        const receipts = [];
        for (const [i, tx] of (await buildTurnTransactions(deployment, payer, state.wave, actions)).entries())
            receipts.push(await success(tx, i === 0 ? 'prepare' : i === 11 ? 'finish' : 'tick'));
        return { receipts, events: receipts.flatMap(r => parseTurnEvents({ logs: r.meta.logs(), err: null }, deployment)) };
    }
    function seed(state: RunState) { const a = svm.getAccount(entries.run); if (!a.exists)
        throw Error('Start before fixture'); const data = new Uint8Array(a.data), view = new DataView(data.buffer); packState(state).forEach((word, i) => view.setBigUint64(72 + i * 8, word, true)); svm.setAccount({ ...a, data }); }
    return { svm, payer, deployment, measurements, lookup, entries, entry, send, success, read, cursor, setDay, start, turn, seed };
}
export type ChainHarness = Awaited<ReturnType<typeof createHarness>>;
export function summarize(measurements: Measurement[]) {
    return Object.fromEntries([...new Set(measurements.map(m => m.kind))].map(kind => { const rows = measurements.filter(m => m.kind === kind); return [kind, { count: rows.length, averageCu: Math.round(rows.reduce((n, m) => n + m.cu, 0) / rows.length), maxCu: Math.max(...rows.map(m => m.cu)), maxBytes: Math.max(...rows.map(m => m.bytes)), maxAccounts: Math.max(...rows.map(m => m.accounts)), maxTrace: Math.max(...rows.map(m => m.trace)), maxDepth: Math.max(...rows.map(m => m.depth)) }]; }));
}
export async function exerciseRuns(h: ChainHarness, runs = 300, onProgress?: (info: object) => void) {
    let waves = 0, wins = 0, overclocks = 0, overclockTurns = 0, totalCu = 0, maxTurnCu = 0, rng = 0x7e57c0den;
    for (let run = 0; run < runs; run++) {
        rng = xorshift(rng);
        const seed = run === 0 ? 0n : run === 1 ? (1n << 64n) - 1n : rng;
        const mode: Mode = run % 5 === 0 ? 'daily' : 'practice', actualSeed = mode === 'daily' ? seed % 100000n : seed;
        h.setDay(mode === 'daily' ? actualSeed : 25000n);
        let state = newRun(actualSeed, mode);
        await h.start(actualSeed, mode);
        assert.deepEqual(h.read(), state);
        while (!state.done) {
            const actions = run % 2 === 0 ? random(state) : planner(state);
            const boosts = actions.filter(a => a.type === 'overclock').length;
            overclocks += boosts; overclockTurns += Number(boosts > 0);
            const expected = playTurn(state, actions), sent = await h.turn(state, actions);
            assert.deepEqual(h.read(), expected.state, `run ${run}, seed ${actualSeed}, wave ${state.wave}`);
            assert.deepEqual(sent.events, [expected.event], `event run ${run}, wave ${state.wave}`);
            assert.equal(h.cursor(), 0n);
            const cu = sent.receipts.reduce((n, r) => n + r.measurement.cu, 0);
            totalCu += cu;
            maxTurnCu = Math.max(maxTurnCu, cu);
            state = expected.state;
            waves++;
        }
        if (state.won)
            wins++;
        if ((run + 1) % 10 === 0)
            onProgress?.({ runs: run + 1, waves, wins });
    }
    return { runs, waves, wins, overclocks, overclockTurns, averageTurnCu: Math.round(totalCu / waves), maxTurnCu };
}
