import { afterEach, describe, expect, it, vi } from 'vitest';
import { FailedTransactionMetadata } from 'litesvm';
import { address, generateKeyPairSigner, getSignatureFromTransaction, getTransactionDecoder } from '@solana/kit';
import { createHarness } from '../scripts/chain-harness.js';
import { deployTemplates } from '../scripts/localnet-deploy.js';
import { SECONDS_PER_DAY } from '../src/rules/constants.js';
import { emptyState, play, start } from '../src/rules/sim.js';
import { buildUploadPlan, createDeployment } from '../src/chain/client.js';
import { BURNER_KEY, ChainBackend, loadBurner } from './chain-backend.js';
import { RpcConnection } from './chain-rpc.js';
import { makeManifest, readManifest } from './deployment.js';

afterEach(() => vi.unstubAllGlobals());

/** In-memory RPC responses, real Kit signatures, real Ballista executable. No listener. */
async function rpcHarness() {
  const h = await createHarness();
  h.setDay(20000n);
  const receipts = new Map<string, unknown>();
  const calls: { method: string; params: unknown[] }[] = [];
  let failSend = false;
  let corruptState = false;
  let omitLogs = false;
  let receiptPolls = 0;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    const { method, params } = request;
    calls.push({ method, params });
    let result: unknown;
    const context = { slot: 100 };
    switch (method) {
      case 'getAccountInfo': {
        const account = h.svm.getAccount(address(String(params[0])));
        result = { context, value: account.exists ? {
          owner: account.programAddress, data: [Buffer.from(account.data).toString('base64'), 'base64'],
          executable: account.executable, lamports: Number(account.lamports), rentEpoch: 0, space: account.data.length,
        } : null };
        break;
      }
      case 'getBalance': result = { context, value: Number(h.svm.getBalance(address(String(params[0]))) ?? 0n) }; break;
      case 'getLatestBlockhash': result = { context, value: { blockhash: h.svm.latestBlockhash(), lastValidBlockHeight: 500 } }; break;
      case 'sendTransaction': {
        if (failSend) return Response.json({ jsonrpc: '2.0', id: request.id, error: {
          code: -32002, message: 'Transaction simulation failed', data: { err: 'fixture rejection', logs: ['Program log: fixture failure'] },
        } });
        const tx = getTransactionDecoder().decode(Buffer.from(String(params[0]), 'base64'));
        const signature = getSignatureFromTransaction(tx);
        const sent = h.svm.sendTransaction(tx);
        if (sent instanceof FailedTransactionMetadata) throw new Error(`${sent.err()}: ${sent.meta().logs().join('\n')}`);
        if (corruptState) {
          const account = h.svm.getAccount(h.entryAddress);
          if (!account.exists) throw new Error('Missing fixture state');
          const data = Uint8Array.from(account.data);
          data[96] ^= 1; // Alter confirmed gold while keeping the registry valid.
          h.svm.setAccount({ ...account, data });
        }
        receipts.set(signature, {
          slot: 100, blockTime: Number(20000n * SECONDS_PER_DAY), version: 'legacy',
          meta: { err: null, logMessages: omitLogs ? [] : sent.logs(), computeUnitsConsumed: Number(sent.computeUnitsConsumed()) },
          transaction: { signatures: [signature] },
        });
        result = signature;
        break;
      }
      case 'getTransaction': {
        result = receiptPolls-- > 0 ? null : receipts.get(String(params[0])) ?? null;
        break;
      }
      case 'getSignatureStatuses': result = { context, value: (params[0] as string[]).map(() => ({
        slot: 100, confirmations: 1, confirmationStatus: 'confirmed', err: null, status: { Ok: null },
      })) }; break;
      case 'getBlockHeight': result = 100; break;
      default: throw new Error(`Unexpected RPC ${method}`);
    }
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  });
  vi.stubGlobal('fetch', fetch);
  const manifest = await makeManifest(h.deployment, 'http://127.0.0.1:8899', '0'.repeat(64));
  const backend = await ChainBackend.create(manifest, { player: h.payer });
  return {
    h, manifest, backend, calls,
    failNextSend: () => { failSend = true; },
    corruptNextState: () => { corruptState = true; },
    omitNextLogs: () => { omitLogs = true; },
    delayNextReceipt: () => { receiptPolls = 1; },
  };
}

describe('chain backend over HTTP-shaped RPC', () => {
  it('signs and confirms a full Ballista run; every state and wave event matches sim', async () => {
    const { backend, calls, delayNextReceipt } = await rpcHarness();
    delayNextReceipt();
    await backend.start();
    let reference = start(emptyState(), 20000n * SECONDS_PER_DAY);
    expect(backend.state()).toEqual(reference);
    expect(backend.status().mismatch).toBeUndefined();
    expect(calls.some(call => call.method === 'getSignatureStatuses')).toBe(true);
    let waves = 0;
    while (!reference.done) {
      const pick = reference.wave % 3n, cell = reference.wave * 5n % 16n;
      const expected = play(reference, reference.wave, pick, cell);
      const pending = backend.play(pick, cell);
      expect(backend.state()).toEqual(expected.state);
      expect(backend.status().optimisticEvent).toEqual(expected.event);
      expect(backend.status().pending).toBe(true);
      await expect(backend.play(pick, cell)).rejects.toThrow('already pending');
      expect(await pending).toEqual(expected.event);
      expect(backend.state()).toEqual(expected.state);
      expect(backend.status()).toMatchObject({ pending: false, phase: 'Confirmed', optimisticEvent: undefined });
      expect(backend.status().mismatch).toBeUndefined();
      expect(backend.status().signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
      expect(backend.status().computeUnits).toBeGreaterThan(0n);
      reference = expected.state;
      waves++;
    }
    expect(waves).toBeGreaterThan(0);
    expect(calls.filter(call => call.method === 'sendTransaction')).toHaveLength(waves + 1);
    expect(calls.some(call => call.method === 'getAccountInfo' && (call.params[1] as { minContextSlot?: number }).minContextSlot === 100)).toBe(true);
    await backend.start();
    expect(backend.state()).toEqual(start(reference, 20000n * SECONDS_PER_DAY));
  });

  it('rolls back optimism after preflight failure and keeps signature + diagnostics', async () => {
    const { backend, failNextSend } = await rpcHarness();
    await backend.start();
    const before = backend.state();
    failNextSend();
    const pending = backend.play(0n, 1n);
    expect(backend.state().wave).toBe(1n);
    await expect(pending).rejects.toThrow('Transaction');
    expect(backend.state()).toEqual(before);
    expect(backend.status()).toMatchObject({ pending: false, phase: 'Failed · restart to retry' });
    expect(backend.status().signature).toBeTruthy();
    expect(backend.status().error).toContain('fixture');
  });

  it('keeps authoritative state and blocks play after a state mismatch', async () => {
    const { backend, corruptNextState } = await rpcHarness();
    await backend.start();
    const predicted = play(backend.state(), 0n, 0n, 1n);
    corruptNextState();
    await backend.play(0n, 1n);
    expect(backend.state().gold).not.toEqual(predicted.state.gold);
    expect(backend.status().mismatch).toContain('state.gold');
    expect(backend.status().pending).toBe(false);
    await expect(backend.play(0n, 1n)).rejects.toThrow('differ');
  });

  it('rejects confirmed transactions whose authenticated wave logs are absent', async () => {
    const { backend, omitNextLogs } = await rpcHarness();
    await backend.start();
    omitNextLogs();
    await expect(backend.play(0n, 1n)).rejects.toThrow('authenticated WaveEvent');
    expect(backend.state().wave).toBe(1n);
    expect(backend.status().mismatch).toContain('received 0');
  });

  it('rejects mismatched constants, addresses, and payloads before sending', async () => {
    const { manifest, calls, h } = await rpcHarness();
    await expect(readManifest({ ...manifest, constantsFingerprint: 'f'.repeat(64) })).rejects.toThrow('constants differ');
    await expect(readManifest({ ...manifest, addresses: { ...manifest.addresses, state: manifest.creator } })).rejects.toThrow('state differs');
    const account = h.svm.getAccount(h.deployment.addresses.prepare);
    if (!account.exists) throw new Error('Missing template fixture');
    const data = Uint8Array.from(account.data);
    data[data.length - 1] ^= 1;
    h.svm.setAccount({ ...account, data });
    await expect(ChainBackend.create(manifest, { player: h.payer })).rejects.toThrow('Wrong or unfinished prepare');
    expect(calls.some(call => call.method === 'sendTransaction')).toBe(false);
  });
});

describe('burner and RPC funding', () => {
  it('persists exact burner seed and survives denied or corrupt storage', async () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
    const first = await loadBurner(storage);
    expect((await loadBurner(storage)).player.address).toBe(first.player.address);
    saved.set(BURNER_KEY, 'bad JSON');
    const replaced = await loadBurner(storage);
    expect(replaced.player.address).not.toBe(first.player.address);
    expect(replaced.warning).toContain('new burner');
    const denied = await loadBurner({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(denied.warning).toContain('storage unavailable');
    expect((await loadBurner()).warning).toContain('storage unavailable');
  });

  it('airdrops low balances only on localhost and confirms the faucet signature', async () => {
    const player = await generateKeyPairSigner();
    let funded = false;
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      methods.push(request.method);
      let result: unknown;
      if (request.method === 'getBalance') result = { context: { slot: 1 }, value: funded ? 1_000_000_000 : 0 };
      else if (request.method === 'requestAirdrop') { funded = true; result = '1'.repeat(64); }
      else if (request.method === 'getSignatureStatuses') result = { context: { slot: 1 }, value: [{ confirmationStatus: 'confirmed', err: null, slot: 1, confirmations: 1, status: { Ok: null } }] };
      else throw new Error(`Unexpected method ${request.method}`);
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }));
    await new RpcConnection('http://127.0.0.1:8899').fund(player.address);
    expect(methods).toEqual(['getBalance', 'requestAirdrop', 'getSignatureStatuses', 'getBalance']);
    funded = false;
    methods.length = 0;
    await expect(new RpcConnection('https://example.invalid').fund(player.address)).rejects.toThrow('automatic airdrop');
    expect(methods).toEqual(['getBalance']);
  });
});

describe('localnet deployment', () => {
  it('skips finalized templates, chooses unused IDs for conflicts, then reuses the deployment', async () => {
    const { h } = await rpcHarness();
    const connection = new RpcConnection('http://127.0.0.1:8899');
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect((await deployTemplates(connection, h.payer)).transactions).toBe(0);
      const old = h.svm.getAccount(h.deployment.addresses.prepare);
      if (!old.exists) throw new Error('Missing fixture');
      const data = Uint8Array.from(old.data);
      data[data.length - 1] ^= 1;
      h.svm.setAccount({ ...old, data });
      const next = await deployTemplates(connection, h.payer);
      expect(next.deployment.ids.prepare).toBe(5);
      expect(next.transactions).toBe(23);
      expect(next.totalCU).toBeGreaterThan(0n);
      const again = await deployTemplates(connection, h.payer);
      expect(again.deployment.addresses).toEqual(next.deployment.addresses);
      expect(again.transactions).toBe(0);
    } finally { quiet.mockRestore(); }
  });

  it('resumes a partial upload and fails on RPC errors without consuming IDs', async () => {
    const { h } = await rpcHarness();
    const connection = new RpcConnection('http://127.0.0.1:8899');
    const future = await createDeployment(h.payer.address, 5);
    const plans = await buildUploadPlan(future);
    // Complete the first template, then interrupt the next after its first chunk.
    for (const item of plans[0].instructions) await connection.send([item.instruction], h.payer);
    for (const item of plans[1].instructions.slice(0, 2)) await connection.send([item.instruction], h.payer);
    // Make the old set unavailable, as after a tuning change.
    const old = h.svm.getAccount(h.deployment.addresses.prepare);
    if (!old.exists) throw new Error('Missing fixture');
    const data = Uint8Array.from(old.data);
    data[data.length - 1] ^= 1;
    h.svm.setAccount({ ...old, data });
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const resumed = await deployTemplates(connection, h.payer);
      expect(resumed.deployment.ids.prepare).toBe(5);
      expect(resumed.transactions).toBe(23 - plans[0].instructions.length - 2);
      let reads = 0;
      await expect(deployTemplates({
        account: async () => { reads++; throw new Error('RPC offline'); },
        fund: connection.fund.bind(connection), send: connection.send.bind(connection),
      }, h.payer)).rejects.toThrow('RPC offline');
      expect(reads).toBe(5);
    } finally { quiet.mockRestore(); }
  });
});
