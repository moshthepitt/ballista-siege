import assert from 'node:assert/strict';
import { it } from 'vitest';
import { FailedTransactionMetadata } from 'litesvm';
import { createHarness } from '../scripts/chain-v1-harness.js';
import { planner } from '../src/v1/bots/planner.js';
import { newRun, playTurn } from '../src/v1/sim.js';
import { ChainBackend } from './chain-backend.js';
import { SettledTransactionError, type ChainConnection, type ChainReceipt, type Submission } from './chain-rpc.js';
import { makeManifest } from '../scripts/manifest-v1.js';

for (const failure of ['expired', 'landed-timeout', 'presign'] as const) it(`resumes a ${failure} turn transaction without duplicate writes`, async () => {
  const h = await createHarness();
  assert(h.lookup);
  const receipts = new Map<string, ChainReceipt>();
  let submittedCount = 0, canSign = true;
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  const funding: (bigint | undefined)[] = [];
  const connection: ChainConnection = {
    async accounts(keys) {
      return keys.map(key => {
        const account = h.svm.getAccount(key);
        return account.exists ? { owner: account.programAddress, data: new Uint8Array(account.data), executable: account.executable } : null;
      });
    },
    async fund(_player, minimum) { funding.push(minimum); },
    async send(instructions, signer, submitted) {
      const signature = `fixture-${++submittedCount}`;
      if (submittedCount === 5 && failure === 'presign') throw new Error('Injected presign failure');
      submitted({ signature, lastValidBlockHeight: 1n });
      if (submittedCount === 5 && failure === 'expired') throw new SettledTransactionError('Injected expired transaction');
      const { result, meta } = await h.send(instructions, 'wire-v1', signer);
      if (result instanceof FailedTransactionMetadata) throw new Error(`${result.err()}: ${meta.logs().join('\n')}`);
      const receipt = { signature, slot: h.svm.getClock().slot, logs: meta.logs(), err: null, computeUnits: meta.computeUnitsConsumed() };
      receipts.set(signature, receipt);
      if (submittedCount === 5 && failure === 'landed-timeout') throw new Error('Injected timeout after landing');
      return receipt;
    },
    async confirm(tx: Submission) {
      const receipt = receipts.get(tx.signature);
      if (!receipt) throw new SettledTransactionError('Expired fixture signature');
      return receipt;
    },
  };
  const manifest = await makeManifest(h.deployment, h.lookup, 'http://127.0.0.1:8899', '0'.repeat(64));
  const backend = await ChainBackend.create(manifest, { player: h.payer, connection, storage, canSign: () => canSign });
  backend.useConnection(connection, 'http://127.0.0.1:8899');
  await backend.start(4n, 'practice');
  await backend.waitForConfirmation();
  assert.deepEqual(backend.state, newRun(4n, 'practice'));

  const before = backend.state;
  const actions = planner(before);
  const expected = playTurn(before, actions);
  assert.deepEqual(await backend.playTurn(actions), expected);
  assert.equal(backend.status().pending, true);
  assert.throws(() => backend.useConnection(connection, 'https://api.devnet.solana.com'), /active transaction/);
  await assert.rejects(backend.waitForConfirmation(), /Injected (expired transaction|timeout after landing|presign failure)/);
  assert(backend.status().completed > 0);

  canSign = false; const attempts = submittedCount;
  await backend.retry(); await assert.rejects(backend.waitForConfirmation(), /Ballista changed/);
  assert.equal(submittedCount, attempts, 'Known program mismatch signed another transaction');
  canSign = true;
  // An idle failed operation can move RPC while keeping its original signature journal.
  backend.useConnection(connection, 'http://127.0.0.1:8899');
  await backend.retry();
  await backend.waitForConfirmation();
  assert.deepEqual(backend.state, expected.state);
  assert.deepEqual(backend.lastEvent, expected.event);
  assert.equal(backend.receipts.length, 13);
  assert.equal(receipts.size, 13);
  assert.equal(submittedCount, failure === 'landed-timeout' ? 13 : 14);
  // Existing registry entries never incur another first-run funding requirement.
  await backend.start(13n, 'practice'); await backend.waitForConfirmation();
  assert.deepEqual(backend.state, newRun(13n, 'practice'));
  assert.equal(funding[0], 3_360_000n);
  assert(funding.slice(1).every(minimum => minimum === 60_000n));
});
