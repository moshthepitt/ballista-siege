import { DEFAULT_RPC } from '../play/network-state.js';
import { makeManifest } from './manifest-v1.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTemplateAccount, TEMPLATE_STATE_FINALIZED, type DecodedTemplateAccount } from '@jac0xb/ballista';
import { buildKitResumeTemplateUploadPlan, type KitTemplateUploadPlan } from '@jac0xb/ballista/kit';
import { createKeyPairSignerFromBytes, generateKeyPairSigner, getAddressEncoder, type KeyPairSigner, type TransactionSigner } from '@solana/kit';
import { BALLISTA_ADDRESS, buildUploadPlan, buildLookupTablePlan, createDeployment, type ChainDeployment, type LookupTable } from '../src/chain-v1/client.js';
import { RpcConnection, errorMessage, pause, type ChainConnection } from '../play/chain-rpc.js';
import { decodeLookup, hex, json, validateRpcUrl, type AccountData } from '../play/deployment.js';
import { TEMPLATE_NAMES } from '../src/chain-v1/templates.js';

const root = new URL('../', import.meta.url);
const keyFile = new URL('.tmp/keys/creator.json', root);


async function readCreator(): Promise<KeyPairSigner> {
  try {
    const bytes: unknown = JSON.parse(await readFile(keyFile, 'utf8'));
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error(`Invalid 64-byte Solana keypair: ${fileURLToPath(keyFile)}`);
    }
    return await createKeyPairSignerFromBytes(Uint8Array.from(bytes));
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const signer = await generateKeyPairSigner(true);
  const secret = new Uint8Array(await crypto.subtle.exportKey('pkcs8', signer.keyPair.privateKey)).slice(-32);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', signer.keyPair.publicKey));
  await mkdir(new URL('.tmp/keys/', root), { recursive: true });
  try {
    await writeFile(keyFile, JSON.stringify([...secret, ...publicKey]), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return readCreator();
    throw error;
  }
  console.log(`[deploy:v1] Created creator keypair ${fileURLToPath(keyFile)}`);
  return signer;
}

class TemplateConflict extends Error {}

function reusable(account: AccountData | null, deployment: ChainDeployment, name: typeof TEMPLATE_NAMES[number]): DecodedTemplateAccount | null {
  if (!account || (account.owner === '11111111111111111111111111111111' && account.data.length === 0)) return null;
  if (account.owner !== BALLISTA_ADDRESS) throw new TemplateConflict(`${name} address has another owner`);
  let decoded: DecodedTemplateAccount;
  try { decoded = decodeTemplateAccount(account.data); }
  catch (error) { throw new TemplateConflict(`${name}: ${errorMessage(error)}`); }
  const compiled = deployment.compiled[name];
  if (decoded.templateId !== deployment.ids[name] || hex(decoded.creator) !== hex(Uint8Array.from(getAddressEncoder().encode(deployment.creator))) ||
      hex(decoded.payloadHash) !== hex(compiled.hash) ||
      decoded.payloadLength !== compiled.bytes.length ||
      hex(decoded.payload.subarray(0, decoded.writtenLength)) !== hex(compiled.bytes.subarray(0, decoded.writtenLength))) {
    throw new TemplateConflict(`${name} contains a different template`);
  }
  return decoded;
}

export async function deployTemplates(connection: ChainConnection, creator: TransactionSigner): Promise<{ deployment: ChainDeployment; transactions: number; totalCU: bigint }> {
  let chosen: { deployment: ChainDeployment; plans: KitTemplateUploadPlan[]; existing: (DecodedTemplateAccount | null)[] } | undefined;
  for (let firstId = 11000; firstId + TEMPLATE_NAMES.length <= 65536; firstId += TEMPLATE_NAMES.length) {
    const deployment = await createDeployment(creator.address, firstId);
    const checks = await Promise.allSettled(TEMPLATE_NAMES.map(async name => reusable(await (await connection.accounts([deployment.addresses[name]]))[0], deployment, name)));
    // RPC failures must stop deployment, rather than silently consume new IDs.
    const rejected = checks.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
    const failure = rejected.find(item => !(item.reason instanceof TemplateConflict));
    if (failure) throw failure.reason;
    if (rejected.length) {
      console.log(`[deploy:v1] IDs ${firstId}-${firstId + TEMPLATE_NAMES.length - 1} occupied: ${rejected.map(item => errorMessage(item.reason)).join('; ')}`);
      continue;
    }
    chosen = { deployment, plans: await buildUploadPlan(deployment), existing: checks.map(item => (item as PromiseFulfilledResult<DecodedTemplateAccount | null>).value) };
    break;
  }
  if (!chosen) throw new Error('No compatible or unused group of 25 template IDs remains for this creator.');
  const { deployment, plans, existing } = chosen;
  let transactions = 0;
  let totalCU = 0n;
  for (let index = 0; index < TEMPLATE_NAMES.length; index++) {
    const name = TEMPLATE_NAMES[index];
    const saved = existing[index];
    console.log(`[deploy:v1] ${name} id=${deployment.ids[name]} address=${deployment.addresses[name]} bytes=${deployment.compiled[name].bytes.length}`);
    if (saved?.state === TEMPLATE_STATE_FINALIZED) {
      console.log(`[deploy:v1] ${name} finalized; verified bytes, skipping`);
      continue;
    }
    const plan = saved ? await buildKitResumeTemplateUploadPlan({
      creator: creator.address, templateId: deployment.ids[name], compiled: deployment.compiled[name], account: saved,
      maxInstructionDataBytes: 900,
    }) : plans[index];
    if (saved) console.log(`[deploy:v1] Resuming ${name} at ${saved.writtenLength}/${saved.payloadLength} bytes`);
    for (const item of plan.instructions) {
      const label = `${name}/${item.kind}${item.offset === undefined ? '' : `@${item.offset}`}`;
      try {
        const receipt = await connection.send([item.instruction], creator, tx => console.log(`[deploy:v1] ${label} submitted ${tx.signature}`));
        console.log(`[deploy:v1] ${label} confirmed slot=${receipt.slot} CU=${receipt.computeUnits ?? 'unavailable'} signature=${receipt.signature}`);
        transactions++;
        totalCU += receipt.computeUnits ?? 0n;
      } catch (error) {
        throw new Error(`${label} failed. Rerun pnpm deploy:v1 to resume.\n${errorMessage(error)}`, { cause: error });
      }
    }
    const finalized = reusable(await (await connection.accounts([deployment.addresses[name]]))[0], deployment, name);
    if (finalized?.state !== TEMPLATE_STATE_FINALIZED) throw new Error(`${name} was not finalized after upload.`);
  }
  return { deployment, transactions, totalCU };
}

async function main(): Promise<void> {
  const rpcUrl = validateRpcUrl(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const connection = new RpcConnection(rpcUrl);
  const genesis = await connection.rpc.getGenesisHash().send({ abortSignal: AbortSignal.timeout(10_000) });
  const cluster = genesis === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' ? 'devnet' : ['localhost', '127.0.0.1', '[::1]'].includes(new URL(rpcUrl).hostname) ? 'localnet' : null;
  if (!cluster) throw new Error('Deploy supports devnet or localhost only.');
  const manifestFile = new URL(`play/deployments/${cluster}.json`, root);
  console.log(`[deploy:v1] RPC ${rpcUrl}`);
  const program = await connection.account(BALLISTA_ADDRESS);
  if (!program?.executable) throw new Error(`Ballista ${BALLISTA_ADDRESS} is not executable. Run pnpm localnet with vendor/ballista.so.`);
  const creator = await readCreator();
  console.log(`[deploy:v1] Creator ${creator.address}`);
  // Devnet has no automatic airdrop: the creator must already hold the ~0.26 SOL of template and lookup rent.
  await connection.fund(creator.address, cluster === 'devnet' ? 300_000_000n : 2_000_000_000n);
  const { deployment, transactions, totalCU } = await deployTemplates(connection, creator);
  const constantsHash = createHash('sha256').update(await readFile(new URL('src/v1/constants.ts', root))).digest('hex');
  const lookup = await deployLookup(connection, creator, deployment);
  const manifest = await makeManifest(deployment, lookup, cluster === 'devnet' ? DEFAULT_RPC : rpcUrl, constantsHash);
  await mkdir(new URL('play/deployments/', root), { recursive: true });
  const temporary = new URL(`play/deployments/${cluster}.${process.pid}.json.tmp`, root);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, manifestFile);
  console.log(`[deploy:v1] Wrote ${fileURLToPath(manifestFile)}`);
  console.log(`[deploy:v1] ${transactions} upload transactions; ${totalCU} CU; constants SHA-256 ${constantsHash}`);
}

/** Persist the derivation slot before create; account bytes decide which extensions remain. */
export async function deployLookup(connection: RpcConnection, creator: TransactionSigner, deployment: ChainDeployment): Promise<LookupTable> {
  const directory = new URL('.tmp/wire-v1/', root);
  await mkdir(directory, { recursive: true });
  const cache = new URL(`lookup-${creator.address}-${deployment.ids.roll}.json`, directory);
  const currentSlot = () => connection.rpc.getSlot({ commitment: 'finalized' }).send({ abortSignal: AbortSignal.timeout(10_000) });
  let recentSlot = await currentSlot();
  try {
    const saved = JSON.parse(await readFile(cache, 'utf8')) as { recentSlot: string };
    const candidate = BigInt(saved.recentSlot), plan = await buildLookupTablePlan(deployment, creator.address, candidate);
    if (await connection.account(plan.lookup.address) || (candidate <= recentSlot && recentSlot - candidate < 150n)) recentSlot = candidate;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const plan = await buildLookupTablePlan(deployment, creator.address, recentSlot);
  const temporary = new URL(`lookup-${process.pid}.json.tmp`, directory);
  await writeFile(temporary, JSON.stringify({ recentSlot: String(recentSlot), address: plan.lookup.address }));
  await rename(temporary, cache);
  console.log(`[deploy:v1] Lookup ${plan.lookup.address} derivation slot=${recentSlot}`);
  let account = await connection.account(plan.lookup.address);
  for (let i = 0; i < plan.instructions.length; i++) {
    const table = account ? decodeLookup(account) : null;
    if (table && (table.addresses.length > plan.lookup.addresses.length ||
      json(table.addresses) !== json(plan.lookup.addresses.slice(0, table.addresses.length)) ||
      (!table.frozen && table.authority !== creator.address))) throw new Error('Saved lookup table differs from this deployment.');
    const last = i === plan.instructions.length - 1;
    const expectedLength = Math.min(i * 20, plan.lookup.addresses.length);
    if (i === 0 && table || !last && i > 0 && table && table.addresses.length >= expectedLength || last && table?.frozen) {
      console.log(`[deploy:v1] lookup/${i === 0 ? 'create' : last ? 'freeze' : `extend-${i}`} verified; skipping`);
      continue;
    }
    if (table?.frozen) throw new Error('Lookup table froze before all addresses were added.');
    const label = i === 0 ? 'create' : last ? 'freeze' : `extend-${i}`;
    const receipt = await connection.send([plan.instructions[i]], creator, tx => console.log(`[deploy:v1] lookup/${label} submitted ${tx.signature}`));
    console.log(`[deploy:v1] lookup/${label} confirmed signature=${receipt.signature} CU=${receipt.computeUnits ?? 'unavailable'} slot=${receipt.slot}`);
    account = await connection.account(plan.lookup.address);
  }
  if (!account) throw new Error('Lookup table missing after deployment.');
  const table = decodeLookup(account);
  if (!table.frozen || json(table.addresses) !== json(plan.lookup.addresses)) throw new Error('Lookup table verification failed.');
  const deadline = Date.now() + 60_000;
  while (await currentSlot() <= table.extendedSlot) {
    if (Date.now() > deadline) throw new Error(`Lookup activation timed out after slot ${table.extendedSlot}. Rerun pnpm deploy:v1.`);
    await pause();
  }
  console.log('[deploy:v1] Lookup frozen and active');
  return plan.lookup;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(`[deploy:v1] FAILED: ${errorMessage(error)}`);
    console.error('[deploy:v1] Check validator terminal, RPC_URL, vendor/ballista.so, and creator keypair. Existing uploads are preserved.');
    process.exitCode = 1;
  });
}
