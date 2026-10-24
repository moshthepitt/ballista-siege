import assert from 'node:assert/strict';
import { LiteSVM, Clock, FailedTransactionMetadata, type TransactionMetadata } from 'litesvm';
import {
  appendTransactionMessageInstructions, compileTransactionMessage, createTransactionMessage,
  generateKeyPairSigner, getTransactionEncoder, lamports, pipe,
  setTransactionMessageFeePayerSigner, signTransactionMessageWithSigners,
  type Instruction, type TransactionSigner,
} from '@solana/kit';
import {
  BALLISTA_ADDRESS, buildPlayInstructions, buildStartInstructions, buildUploadPlan,
  createDeployment, decodeRunState, getEntryAddress, parseWaveEvents,
} from '../src/chain/client.js';
import { emptyState, play, start, type RunState } from '../src/rules/sim.js';
import { SECONDS_PER_DAY } from '../src/rules/constants.js';
import { STATE_FIELDS } from '../src/chain/templates.js';

export interface ActionMeasurement { kind: string; cu: number; bytes: number; accounts: number }

export async function createHarness() {
  const svm = new LiteSVM().withTransactionHistory(0n);
  svm.addProgramFromFile(BALLISTA_ADDRESS, new URL('../vendor/ballista.so', import.meta.url).pathname);
  const payer = await generateKeyPairSigner();
  svm.airdrop(payer.address, lamports(10_000_000_000n));
  const deployment = await createDeployment(payer.address);
  const measurements: ActionMeasurement[] = [];
  async function send(instructions: readonly Instruction[], kind = 'other', signer: TransactionSigner = payer) {
    const message = pipe(
      createTransactionMessage({ version: 'legacy' }),
      tx => setTransactionMessageFeePayerSigner(signer, tx),
      tx => svm.setTransactionMessageLifetimeUsingLatestBlockhash(tx),
      tx => appendTransactionMessageInstructions(instructions, tx),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    const result = svm.sendTransaction(transaction);
    const meta = result instanceof FailedTransactionMetadata ? result.meta() : result;
    const measurement = {
      kind, cu: Number(meta.computeUnitsConsumed()), bytes: getTransactionEncoder().encode(transaction).length,
      accounts: compileTransactionMessage(message).staticAccounts.length,
    };
    if (!(result instanceof FailedTransactionMetadata)) measurements.push(measurement);
    return { result, meta, measurement };
  }
  async function success(instructions: readonly Instruction[], kind = 'other') {
    const sent = await send(instructions, kind);
    if (sent.result instanceof FailedTransactionMetadata) {
      throw new Error(`${kind}: ${sent.result.err().toString()}\n${sent.meta.logs().join('\n')}`);
    }
    return sent;
  }
  const plans = await buildUploadPlan(deployment);
  for (const plan of plans) for (const item of plan.instructions) await success([item.instruction], 'upload');
  const entryAddress = await getEntryAddress(deployment, payer.address);
  function read(): RunState {
    const entry = svm.getAccount(entryAddress);
    if (!entry.exists) throw new Error('Missing game entry');
    return decodeRunState({ data: Uint8Array.from(entry.data), owner: entry.programAddress, template: deployment.addresses.state, player: payer.address });
  }
  function setDay(day: bigint, seconds = 0n) {
    svm.setClock(new Clock(1n, 0n, 0n, 0n, day * SECONDS_PER_DAY + seconds));
  }
  async function startRun() { return success(await buildStartInstructions(deployment, payer), 'start'); }
  async function playWave(wave: bigint, pick: bigint, cell: bigint) {
    return success(await buildPlayInstructions(deployment, payer, wave, pick, cell), 'play');
  }
  const events = (meta: TransactionMetadata) => parseWaveEvents({ logs: meta.logs(), err: null }, deployment);
  function seed(state: RunState) {
    const entry = svm.getAccount(entryAddress);
    if (!entry.exists) throw new Error('Start before seeding a fixture');
    const data = Uint8Array.from(entry.data);
    const view = new DataView(data.buffer);
    let offset = 72;
    for (const key of Object.keys(STATE_FIELDS) as (keyof RunState)[]) {
      const value = state[key];
      if (typeof value === 'boolean') data[offset++] = value ? 1 : 0;
      else { view.setBigUint64(offset, value, true); offset += 8; }
    }
    svm.setAccount({ ...entry, data });
  }
  return { svm, payer, deployment, measurements, entryAddress, send, success, read, setDay, startRun, playWave, events, seed };
}

export type ChainHarness = Awaited<ReturnType<typeof createHarness>>;

/** Repeatable PRNG avoids a flaky corpus while varying days, picks, and replacement cells. */
export function randomSource(seed = 0x5e1e9e21) {
  let state = seed >>> 0;
  return (maximum: number) => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % maximum;
  };
}

export async function exerciseRandomRuns(h: ChainHarness, runs = 200) {
  const random = randomSource();
  let state = emptyState();
  let waves = 0, wins = 0;
  for (let run = 0; run < runs; run++) {
    const day = BigInt(15_000 + random(100_000));
    const seconds = BigInt(random(Number(SECONDS_PER_DAY)));
    h.setDay(day, seconds);
    const started = await h.startRun();
    state = start(state, day * SECONDS_PER_DAY + seconds);
    assert.deepEqual(h.read(), state, `start ${run}`);
    assert.deepEqual(h.events(started.meta), []);
    while (!state.done) {
      const pick = BigInt(random(3)), cell = BigInt(random(16));
      const expected = play(state, state.wave, pick, cell);
      const sent = await h.playWave(state.wave, pick, cell);
      assert.deepEqual(h.read(), expected.state, `state run=${run}, day=${day}, wave=${state.wave}, pick=${pick}, cell=${cell}`);
      assert.deepEqual(h.events(sent.meta), [expected.event], `event run=${run}, wave=${state.wave}`);
      state = expected.state;
      waves++;
    }
    if (state.won) wins++;
  }
  return { runs, waves, wins };
}

export function summarizeMeasurements(measurements: ActionMeasurement[]) {
  return Object.fromEntries(['upload', 'start', 'play'].map(kind => {
    const rows = measurements.filter(row => row.kind === kind);
    return [kind, {
      count: rows.length, averageCu: Math.round(rows.reduce((sum, row) => sum + row.cu, 0) / rows.length),
      maxCu: Math.max(...rows.map(row => row.cu)), maxBytes: Math.max(...rows.map(row => row.bytes)),
      maxAccounts: Math.max(...rows.map(row => row.accounts)),
    }];
  }));
}
