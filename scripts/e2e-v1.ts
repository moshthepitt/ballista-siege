import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyPairSignerFromBytes, generateKeyPairSigner } from '@solana/kit';
import { LIMITS } from '../src/v1/constants.js';
import { planner } from '../src/v1/bots/planner.js';
import { applyAction, newRun, playTurn, type Action, type RunState } from '../src/v1/sim.js';
import { ChainBackend, differences } from '../play/chain-backend.js';
import { RpcConnection, errorMessage } from '../play/chain-rpc.js';
import { isLocalRpc, readManifest, validateRpcUrl } from '../play/deployment.js';

/** Seed 4 reaches wave ten with planner overclocks and a sell/replacement. */
export function planRun(seed = 4n) {
  let state = newRun(seed, 'practice');
  const turns: { before: RunState; actions: Action[]; expected: ReturnType<typeof playTurn> }[] = [];
  while (!state.done) {
    const actions = planner(state);
    const built = actions.reduce(applyAction, state);
    // Exercise paid shop refresh too, after the final planner purchases.
    if (state.wave === BigInt(LIMITS.WAVES - 1) && built.actionsUsed < BigInt(LIMITS.ACTIONS) && built.gold >= built.rerolls + 1n) {
      actions.push({ type: 'reroll' });
    }
    const expected = playTurn(state, actions);
    turns.push({ before: state, actions, expected });
    state = expected.state;
  }
  return turns;
}

/** Uses the browser backend, including signing, LUT compression, confirmation and event authentication. */
export async function runE2e(backend: ChainBackend): Promise<void> {
  const turns = planRun();
  const coverage = new Set(turns.flatMap(turn => turn.actions.map(action => action.type)));
  for (const type of ['buy', 'upgrade', 'overclock', 'reroll', 'sell'] as const) {
    assert(coverage.has(type), `Planner fixture no longer exercises ${type}; update the e2e fixture.`);
  }
  let label = 'start', seen = 0, totalCU = 0n;
  const runStarted = performance.now();
  const printReceipts = () => {
    while (seen < backend.receipts.length) {
      const receipt = backend.receipts[seen++];
      totalCU += receipt.computeUnits ?? 0n;
      console.log(`[e2e:v1] ${label} tx=${backend.status().completed}${label === 'start' ? '' : '/12'} signature=${receipt.signature} CU=${receipt.computeUnits ?? 'unavailable'} slot=${receipt.slot}`);
    }
  };
  const unsubscribe = backend.subscribe(printReceipts);
  try {
    console.log(`[e2e:v1] Start seed=4 practice; ${turns.length} planned turns; actions=${[...coverage].join(',')}`);
    await backend.start(4n, 'practice');
    await backend.waitForConfirmation();
    assert.deepEqual(backend.state, newRun(4n, 'practice'), 'start state mismatch');
    assert.equal(seen, 1, 'start must use one atomic transaction');
    for (const { before, actions, expected } of turns) {
      label = `wave=${before.wave + 1n}`;
      console.log(`[e2e:v1] ${label} orders=${actions.map(action => action.type).join(',') || '(none)'}; sending 12 transactions in order`);
      const start = performance.now();
      const previous: number = seen;
      const replay = await backend.playTurn(actions);
      assert.deepEqual(replay, expected, `${label}: optimistic replay mismatch`);
      await backend.waitForConfirmation();
      const mismatch = [...differences(expected.state, backend.state, 'state'), ...differences(expected.event, backend.lastEvent, 'event')];
      assert.equal(mismatch.length, 0, `${label}: ${mismatch.join('\n')}`);
      assert.equal(seen - previous, 12, `${label}: unexpected transaction count`);
      console.log(`[e2e:v1] MATCH ${label} walls=${backend.state.walls} gold=${backend.state.gold} score=${backend.state.score} wallMs=${Math.round(performance.now() - start)}`);
    }
    assert(backend.state.done, 'run did not terminate');
    console.log(`[e2e:v1] PASS full run: turns=${turns.length} transactions=${seen} CU=${totalCU} won=${backend.state.won} score=${backend.state.score} wallMs=${Math.round(performance.now() - runStarted)}`);
  } catch (error) {
    const status = backend.status();
    throw new Error(`${label} ${status.completed}/12; last signature=${status.signature ?? '(none)'} CU=${status.computeUnits ?? 'unavailable'}\n${errorMessage(error)}`, { cause: error });
  } finally { unsubscribe(); }
}

async function main(): Promise<void> {
  const rpcUrl = validateRpcUrl(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const connection = new RpcConnection(rpcUrl);
  const genesis = await connection.rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(10_000) });
  const cluster = genesis === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' ? 'devnet' : isLocalRpc(rpcUrl) ? 'localnet' : null;
  if (!cluster) throw new Error('E2E supports devnet or localhost only.');
  let input: unknown;
  try { input = JSON.parse(await readFile(new URL(`../play/deployments/${cluster}.json`, import.meta.url), 'utf8')); }
  catch (error) { throw new Error(`Cannot read play/deployments/${cluster}.json. Run pnpm deploy:v1 first.\n${errorMessage(error)}`); }
  const { manifest } = await readManifest(input);
  if (process.env.RPC_URL) manifest.rpcUrl = validateRpcUrl(process.env.RPC_URL);
  // Devnet has no automatic airdrop: E2E_PLAYER names a funded Solana CLI keypair file.
  const player = process.env.E2E_PLAYER
    ? await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(await readFile(process.env.E2E_PLAYER, 'utf8'))))
    : await generateKeyPairSigner();
  console.log(`[e2e:v1] RPC ${manifest.rpcUrl}; ${process.env.E2E_PLAYER ? 'player' : 'fresh burner'} ${player.address}`);
  await runE2e(await ChainBackend.create(manifest, { player }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(`[e2e:v1] FAILED: ${errorMessage(error)}`);
    console.error('[e2e:v1] Check RPC_URL, validator logs, deployment manifest and the signature above. Rerunning uses a fresh burner.');
    process.exitCode = 1;
  });
}
