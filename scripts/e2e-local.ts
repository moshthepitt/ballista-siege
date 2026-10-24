import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSigner } from '@solana/kit';
import { C, SECONDS_PER_DAY } from '../src/rules/constants.js';
import { emptyState, play, start, type RunState } from '../src/rules/sim.js';
import { ChainBackend, differences } from '../web/chain-backend.js';
import { errorMessage } from '../web/chain-rpc.js';
import { readManifest, validateRpcUrl } from '../web/deployment.js';

function greedy(state: RunState): { pick: bigint; cell: bigint } {
  let best: { pick: bigint; cell: bigint; value: bigint } | undefined;
  for (let pick = 0n; pick < 3n; pick++) for (let cell = 0n; cell < 16n; cell++) {
    const next = play(state, state.wave, pick, cell);
    // Preserve walls first; use income to break ties. This is a smoke-test player.
    const value = next.state.walls * 100_000n + (next.state.won ? 1_000_000_000n : 0n) + next.event.goldGain * 100n + next.state.gold;
    if (!best || value > best.value) best = { pick, cell, value };
  }
  return best!;
}

async function main(): Promise<void> {
  const file = new URL('../web/public/deployment.json', import.meta.url);
  let input: unknown;
  try { input = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read deployment.json. Run pnpm deploy:local first.\n${errorMessage(error)}`); }
  const { manifest } = await readManifest(input);
  if (process.env.RPC_URL) manifest.rpcUrl = validateRpcUrl(process.env.RPC_URL);
  const player = await generateKeyPairSigner();
  console.log(`[e2e] RPC ${manifest.rpcUrl}; fresh burner ${player.address}`);
  const backend = await ChainBackend.create(manifest, { player });
  let transactions = 0;
  let totalCU = 0n;
  function receipt(label: string): void {
    const status = backend.status();
    assert.equal(status.pending, false, `${label}: pending after confirmation`);
    assert.ok(status.signature, `${label}: missing signature`);
    assert.equal(status.mismatch, undefined, status.mismatch);
    assert.equal(status.error, undefined, status.error);
    transactions++;
    totalCU += status.computeUnits ?? 0n;
    console.log(`[e2e] ${label} signature=${status.signature} CU=${status.computeUnits ?? 'unavailable'}`);
  }
  await backend.start();
  receipt('start');
  // Start uses the chain clock. Never infer a validator day from the host clock.
  let reference = start(emptyState(), backend.state().day * SECONDS_PER_DAY);
  assert.deepEqual(backend.state(), reference, 'start state mismatch');
  while (!reference.done) {
    const { pick, cell } = greedy(reference);
    const expected = play(reference, reference.wave, pick, cell);
    const event = await backend.play(pick, cell);
    receipt(`wave=${expected.event.w} pick=${pick} cell=${cell}`);
    const mismatch = [...differences(expected.state, backend.state(), 'state'), ...differences(expected.event, event, 'event')];
    assert.equal(mismatch.length, 0, mismatch.join('\n'));
    reference = expected.state;
    console.log(`[e2e] MATCH wave=${reference.wave}/${C.WAVES} walls=${reference.walls} gold=${reference.gold} score=${reference.score}`);
  }
  assert.ok(reference.wave > 0n && reference.wave <= C.WAVES);
  console.log(`[e2e] PASS: full run, ${reference.wave} waves, ${transactions} transactions, ${totalCU} CU, won=${reference.won}, score=${reference.score}`);
}

main().catch(error => {
  console.error(`[e2e] FAILED: ${errorMessage(error)}`);
  process.exitCode = 1;
});
