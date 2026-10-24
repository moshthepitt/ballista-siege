import { describe, it, expect } from 'vitest';
import { address, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from '@solana/kit';
import { decodeRunEvent, parseProgramData, decodeTemplateAccount } from '@jac0xb/ballista';
import * as sdk from '../src/chain-v1/client.js';
import * as wire from '../src/chain-v1/wire.js';
import { RUN_LAYOUT, TEMPLATE_NAMES } from '../src/chain-v1/run-layout.js';
import { makeManifest, validateManifestForBuild } from '../scripts/manifest-v1.js';
import { currentRunLayout } from '../scripts/generate-run-layout.js';
import { TEMPLATE_NAMES as SDK_NAMES } from '../src/chain-v1/templates.js';
import { newRun, packState, playTurn, encodeEvent } from '../src/v1/sim.js';

const key = async (n: number) => createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(n));
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
describe('browser wire equals SDK', () => {
  it('generated layout matches the current compiler', async () => {
    expect(RUN_LAYOUT).toEqual(await currentRunLayout()); expect(TEMPLATE_NAMES).toEqual(SDK_NAMES);
  });
  it('rejects a stale compiler payload at build time without sending it to the browser', async () => {
    const d = await sdk.createDeployment((await key(9)).address);
    const plan = await sdk.buildLookupTablePlan(d, d.creator, 1n);
    const manifest = await makeManifest(d, plan.lookup, 'https://api.devnet.solana.com', '0'.repeat(64));
    await expect(validateManifestForBuild(manifest)).resolves.toBeUndefined();
    await expect(validateManifestForBuild({ ...manifest, templateHashes: { ...manifest.templateHashes, state: '0'.repeat(64) } })).rejects.toThrow('Stale state');
  });
  it('derives addresses and encodes starts, actions, all cursors, and signers byte for byte', async () => {
    for (const n of [1, 2, 17]) {
      const creator = await key(n), player = await key(n + 30), first = 11000 + n * 25;
      const d = await sdk.createDeployment(creator.address, first), w = await wire.createDeployment(creator.address, first);
      expect(w).toEqual({ creator: d.creator, ids: d.ids, addresses: d.addresses });
      expect(await wire.getEntryAddresses(w, player.address)).toEqual(await sdk.getEntryAddresses(d, player.address));
      for (const seed of [0n, 4n, 13n, (1n << 64n) - 1n]) for (const mode of ['practice', 'daily'] as const) {
        expect(await wire.buildStartInstructions(w, player, seed, mode)).toEqual(await sdk.buildStartInstructions(d, player, seed, mode));
      }
      for (const wave of [0n, 4n, 9n]) for (const actions of [[], [{ type: 'buy', slot: 0n, cell: 1n }, { type: 'reroll' }, { type: 'sell', cell: 1n }]] as const) {
        const word = wire.encodeActions(actions);
        for (const step of sdk.turnSteps(wave, word)) {
          expect(await wire.buildStepInstruction(w, player.address, step)).toEqual(await sdk.buildStepInstruction(d, player.address, step));
        }
        for (const cursor of [0n, 1n, 5n, 19n, 94n, 95n, 97n, 99n]) {
          expect(await wire.buildTurnTransactions(w, player, wave, actions, cursor)).toEqual(await sdk.buildTurnTransactions(d, player, wave, actions, cursor));
        }
      }
      await expect(wire.buildTurnTransactions(w, player, 0n, [], 500n)).rejects.toThrow('cursor');
    }
  }, 60000);
  it('decodes template headers and rejects malformed accounts', async () => {
    const d = await sdk.createDeployment((await key(4)).address);
    for (const name of TEMPLATE_NAMES) {
      const payload = d.compiled[name].bytes, b = new Uint8Array(80 + payload.length), v = new DataView(b.buffer);
      b.set([1, 2, 1, 255]); b.set(getAddressEncoder().encode(d.creator), 4); v.setUint16(36, d.ids[name], true);
      v.setUint32(40, payload.length, true); v.setUint32(44, payload.length, true); b.set(d.compiled[name].hash, 48); b.set(payload, 80);
      expect(wire.decodeTemplateAccount(b)).toEqual(decodeTemplateAccount(b));
      for (const index of [0, 1, 2, 38, 40, 44]) { const bad = b.slice(); bad[index] = 250; expect(() => wire.decodeTemplateAccount(bad)).toThrow(); expect(() => decodeTemplateAccount(bad)).toThrow(); }
    }
  });
  it('decodes registry state at each commit cursor', async () => {
    const d = await sdk.createDeployment((await key(6)).address), player = (await key(7)).address;
    for (const seed of [0n, 4n, 13n, 999999n]) {
      const state = newRun(seed, 'practice'), words = packState(state);
      const entry = (index: number, length: number) => { const data = new Uint8Array(length); data.set([66,82,69,71,1,index,0,0]); data.set(getAddressEncoder().encode(d.addresses.state),8); data.set(getAddressEncoder().encode(player),40); return { data, owner: wire.BALLISTA_ADDRESS, template: d.addresses.state, player }; };
      const run = entry(0,120), work = entry(1,264);
      words.forEach((x,i) => { new DataView(run.data.buffer).setBigUint64(72+i*8,x,true); new DataView(work.data.buffer).setBigUint64(152+i*8,x,true); });
      for (const cursor of [0n, 1n, 5n, 95n, 96n, 97n, 99n]) { new DataView(work.data.buffer).setBigUint64(72,cursor,true); expect(wire.decodeSessionState(run, work)).toEqual(sdk.decodeSessionState(run, work)); }
    }
  });
  it('parses attributed nested run and turn events, truncation, errors and unrelated emits', async () => {
    const d = await sdk.createDeployment((await key(8)).address);
    const event = (template: string) => { const b = new Uint8Array(47); b.set([66,69,86,49,1,0,2]); b.set(getAddressEncoder().encode(address(template)),15); return b; };
    for (const seed of [0n,4n,13n,999n]) {
      const turn = encodeEvent(playTurn(newRun(seed,'practice'), []).event);
      const logs = [`Program ${wire.BALLISTA_ADDRESS} invoke [1]`, `Program data: ${b64(event(d.addresses.state))}`, `Program ${wire.BALLISTA_ADDRESS} invoke [2]`, `Program data: ${b64(event(d.addresses.commit))}`, `Program ${wire.BALLISTA_ADDRESS} invoke [3]`, `Program data: ${b64(turn)} ${b64(event(d.addresses.event))}`, `Program ${wire.BALLISTA_ADDRESS} success`, `Program ${wire.BALLISTA_ADDRESS} success`, `Program ${wire.BALLISTA_ADDRESS} success`];
      expect(wire.parseProgramData(logs)).toEqual(parseProgramData(logs));
      expect(wire.parseTurnEvents({ logs, err:null },d)).toEqual(sdk.parseTurnEvents({logs,err:null},d));
      expect(wire.parseTurnEvents({ logs, err:'failed' },d)).toEqual([]);
      expect(wire.parseProgramData(logs.slice(0,6))).toEqual(parseProgramData(logs.slice(0,6)));
    }
    for (const name of TEMPLATE_NAMES) expect(wire.decodeRunEvent(event(d.addresses[name]))).toEqual(decodeRunEvent(event(d.addresses[name])));
    for (const logs of [['Program data: AA=='], [`Program ${wire.BALLISTA_ADDRESS} invoke [2]`], [`Program ${wire.BALLISTA_ADDRESS} invoke [1]`, 'Program data: !!!']]) { expect(() => wire.parseProgramData(logs)).toThrow(); expect(() => parseProgramData(logs)).toThrow(); }
  });
});
