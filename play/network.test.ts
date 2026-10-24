import { describe, it, expect } from 'vitest';
import { address, getAddressEncoder } from '@solana/kit';
import { offlineReason, runsLeft, FIRST_RUN_RENT, RUN_FEES, DEVNET_GENESIS } from './network-state.js';
import { validateEndpoint } from './rpc-policy.js';
import { validateRpcUrl } from './deployment.js';
import { checkProgram, TESTED_PROGRAM } from './deployments/program.js';
import { exportBurner, restoreBurner, transferInstruction, discoverWallets, sendFromWallet, type StandardWallet } from './wallet.js';

it('selects chain only with loaded code, checked program, templates, deployment and enough funds', () => {
  const ready = { loaded: true, manifest: true, program: true, templates: true, balance: FIRST_RUN_RENT + RUN_FEES, hasEntries: false };
  expect(offlineReason(ready)).toBeUndefined();
  expect(offlineReason({ ...ready, checking: true })).toBe('Checking devnet. Playing offline.');
  for (const flag of ['loaded', 'manifest', 'program', 'templates'] as const) expect(offlineReason({ ...ready, [flag]: false })).toBeTruthy();
  expect(offlineReason({ ...ready, balance: ready.balance - 1n })).toContain('Fund');
  expect(offlineReason({ ...ready, hasEntries: true, balance: RUN_FEES })).toBeUndefined();
  expect(offlineReason({ ...ready, hasEntries: true, balance: RUN_FEES - 1n })).toContain('Fund');
  expect(runsLeft(0n, false)).toBe(0); expect(runsLeft(FIRST_RUN_RENT + 2n * RUN_FEES, false)).toBe(2);
  expect(runsLeft(3n * RUN_FEES, true)).toBe(3);
});
it('validates RPC schemes and genesis before saving, including localhost production', async () => {
  for (const url of ['https://api.devnet.solana.com', 'https://rpc.example/path?key=abc', 'http://localhost:8899', 'http://127.0.0.1:8899']) expect(validateRpcUrl(url)).toBeTruthy();
  for (const url of ['http://rpc.example', 'http://localhost.evil', 'ftp://localhost', 'javascript:alert(1)', 'https://user:password@rpc.example']) expect(() => validateRpcUrl(url)).toThrow();
  const devnet = async () => DEVNET_GENESIS, other = async () => 'other';
  expect(await validateEndpoint('https://rpc.example', devnet)).toBe('https://rpc.example/');
  await expect(validateEndpoint('https://rpc.example', other)).rejects.toThrow('not Solana devnet');
  await expect(validateEndpoint('http://localhost:8899', other, true)).rejects.toThrow('not Solana devnet');
  expect(await validateEndpoint('http://localhost:8899', other, false)).toContain('localhost');
  await expect(validateEndpoint('https://rpc.example', async () => { throw new Error('RPC failed'); })).rejects.toThrow('RPC failed');
});
describe('tested program fingerprint', () => {
  const p = TESTED_PROGRAM;
  const fixtures = () => {
    const program = new Uint8Array(36), data = new Uint8Array(45), encode = getAddressEncoder();
    new DataView(program.buffer).setUint32(0,2,true); program.set(encode.encode(address(p.programdata)),4);
    const v = new DataView(data.buffer); v.setUint32(0,3,true); v.setBigUint64(4,p.slot,true); data[12]=1; data.set(encode.encode(address(p.authority)),13);
    const read = async (key: string) => key === p.address ? { data:program, owner:address(p.loader), executable:true } : { data, owner:address(p.loader), executable:false };
    return { program, data, read };
  };
  it('passes only current loader, programdata, deploy slot and authority, reading 81 bytes', async () => {
    const f=fixtures(), calls: [string,number][]=[];
    expect(await checkProgram(async (key,length) => { calls.push([key,length]); return f.read(key); })).toBe(true);
    expect(calls).toEqual([[p.address,36],[p.programdata,45]]);
    for (const index of [0,4,12,13]) { const f=fixtures(); f.data[index] ^= 1; expect(await checkProgram(f.read)).toBe(false); }
  });
  it('fails closed for an upgraded slot, wrong programdata, missing account or RPC failure', async () => {
    const f=fixtures(); new DataView(f.data.buffer).setBigUint64(4,p.slot+1n,true); expect(await checkProgram(f.read)).toBe(false);
    const g=fixtures(); g.program[4]^=1; expect(await checkProgram(g.read)).toBe(false);
    expect(await checkProgram(async () => null)).toBe(false);
    expect(await checkProgram(async () => { throw new Error('RPC failed'); })).toBe(false);
  });
});
it('exports and restores CLI keypairs, validates all bytes and public key', async () => {
  for (const n of [0,1,127,255]) { const seed=new Uint8Array(32).fill(n), text=await exportBurner(seed); expect(JSON.parse(text)).toHaveLength(64); expect(await restoreBurner(text)).toEqual(seed); }
  for (const text of ['[]','null',JSON.stringify(new Array(64).fill(256)),JSON.stringify(new Array(64).fill(1))]) await expect(restoreBurner(text)).rejects.toThrow();
});
it('encodes native System transfer index 2 and 0.02 SOL, payer and writable burner', () => {
  const from=address('11111111111111111111111111111111'), to=address(TESTED_PROGRAM.address), ix=transferInstruction(from,to);
  expect(Array.from(ix.data!)).toEqual([2,0,0,0,0,45,49,1,0,0,0,0]);
  expect(ix.accounts).toEqual([{address:from,role:3},{address:to,role:1}]);
  expect(() => transferInstruction(from,to,-1n)).toThrow();
});
it('discovers only devnet wallets and handles both registration orders and unregister', () => {
  const target = new EventTarget() as Window;
  const wallet = { name:'Fixture',chains:['solana:devnet'],accounts:[],features:{'standard:connect':{connect:async()=>({accounts:[]})},'solana:signAndSendTransaction':{signAndSendTransaction:async()=>[]}} } satisfies StandardWallet;
  target.addEventListener('wallet-standard:app-ready', event => (event as CustomEvent).detail.register(wallet));
  const discovery=discoverWallets(()=>{},target); expect(discovery.wallets.has(wallet)).toBe(true);
  let unregister:()=>void=()=>{};
  target.dispatchEvent(new CustomEvent('wallet-standard:register-wallet',{detail:({register}: { register: (...wallets:StandardWallet[]) => ()=>void })=>{unregister=register({...wallet,name:'Late'}, {...wallet,name:'Mainnet',chains:['solana:mainnet']});}}));
  expect([...discovery.wallets].map(w=>w.name)).toEqual(['Fixture','Late']); unregister(); expect(discovery.wallets.size).toBe(1); discovery.dispose();
});

it('funds through legacy and v0 wallets without asking the burner to sign', async () => {
  const payer = { address: TESTED_PROGRAM.authority, chains: ['solana:devnet'], features: ['solana:signAndSendTransaction'] };
  for (const supportedTransactionVersions of [['legacy'], [0]] as const) {
    let captured: Uint8Array | undefined;
    const wallet: StandardWallet = { name: 'Funding fixture', accounts: [payer], chains: payer.chains, features: {
      'standard:connect': { connect: async () => ({ accounts: [payer] }) },
      'solana:signAndSendTransaction': { supportedTransactionVersions, signAndSendTransaction: async input => { captured = input.transaction; expect(input.account).toBe(payer); expect(input.chain).toBe('solana:devnet'); return [{ signature: new Uint8Array(64) }]; } },
    } };
    const connection = { rpc: { getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100n } }) }) } };
    await sendFromWallet(wallet, address(TESTED_PROGRAM.programdata), connection as unknown as import('./chain-rpc.js').RpcConnection);
    expect(captured![65]).toBe(supportedTransactionVersions[0] === 0 ? 128 : 1);
    expect(Buffer.from(captured!).includes(Buffer.from([2,0,0,0,0,45,49,1,0,0,0,0]))).toBe(true);
  }
});
