import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeTemplateAccount, TEMPLATE_STATE_FINALIZED, type DecodedTemplateAccount } from '@jac0xb/ballista';
import { buildKitResumeTemplateUploadPlan, type KitTemplateUploadPlan } from '@jac0xb/ballista/kit';
import { createKeyPairSignerFromBytes, generateKeyPairSigner, getAddressEncoder, type KeyPairSigner, type TransactionSigner } from '@solana/kit';
import { BALLISTA_ADDRESS, TEMPLATE_NAMES, buildUploadPlan, createDeployment, type ChainDeployment } from '../src/chain/client.js';
import { RpcConnection, errorMessage, type ChainAccount, type ChainConnection } from '../web/chain-rpc.js';
import { hex, makeManifest, validateRpcUrl } from '../web/deployment.js';

const root = new URL('../', import.meta.url);
const keyFile = new URL('.tmp/keys/creator.json', root);
const manifestFile = new URL('web/public/deployment.json', root);

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
  console.log(`[deploy] Created creator keypair ${fileURLToPath(keyFile)}`);
  return signer;
}

class TemplateConflict extends Error {}

function reusable(account: ChainAccount | null, deployment: ChainDeployment, name: typeof TEMPLATE_NAMES[number]): DecodedTemplateAccount | null {
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
  for (let firstId = 0; firstId <= 65531; firstId += TEMPLATE_NAMES.length) {
    const deployment = await createDeployment(creator.address, firstId);
    const checks = await Promise.allSettled(TEMPLATE_NAMES.map(async name => reusable(await connection.account(deployment.addresses[name]), deployment, name)));
    // RPC failures must stop deployment, rather than silently consume new IDs.
    const rejected = checks.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
    const failure = rejected.find(item => !(item.reason instanceof TemplateConflict));
    if (failure) throw failure.reason;
    if (rejected.length) {
      console.log(`[deploy] IDs ${firstId}-${firstId + 4} occupied: ${rejected.map(item => errorMessage(item.reason)).join('; ')}`);
      continue;
    }
    chosen = { deployment, plans: await buildUploadPlan(deployment), existing: checks.map(item => (item as PromiseFulfilledResult<DecodedTemplateAccount | null>).value) };
    break;
  }
  if (!chosen) throw new Error('No compatible or unused group of five template IDs remains for this creator.');
  const { deployment, plans, existing } = chosen;
  let transactions = 0;
  let totalCU = 0n;
  for (let index = 0; index < TEMPLATE_NAMES.length; index++) {
    const name = TEMPLATE_NAMES[index];
    const saved = existing[index];
    console.log(`[deploy] ${name} id=${deployment.ids[name]} address=${deployment.addresses[name]} bytes=${deployment.compiled[name].bytes.length}`);
    if (saved?.state === TEMPLATE_STATE_FINALIZED) {
      console.log(`[deploy] ${name} finalized; verified bytes, skipping`);
      continue;
    }
    const plan = saved ? await buildKitResumeTemplateUploadPlan({
      creator: creator.address, templateId: deployment.ids[name], compiled: deployment.compiled[name], account: saved,
      maxInstructionDataBytes: 900,
    }) : plans[index];
    if (saved) console.log(`[deploy] Resuming ${name} at ${saved.writtenLength}/${saved.payloadLength} bytes`);
    for (const item of plan.instructions) {
      const label = `${name}/${item.kind}${item.offset === undefined ? '' : `@${item.offset}`}`;
      try {
        const receipt = await connection.send([item.instruction], creator, signature => console.log(`[deploy] ${label} submitted ${signature}`));
        console.log(`[deploy] ${label} confirmed slot=${receipt.slot} CU=${receipt.computeUnits ?? 'unavailable'} signature=${receipt.signature}`);
        transactions++;
        totalCU += receipt.computeUnits ?? 0n;
      } catch (error) {
        throw new Error(`${label} failed. Rerun pnpm deploy:local to resume.\n${errorMessage(error)}`, { cause: error });
      }
    }
    const finalized = reusable(await connection.account(deployment.addresses[name]), deployment, name);
    if (finalized?.state !== TEMPLATE_STATE_FINALIZED) throw new Error(`${name} was not finalized after upload.`);
  }
  return { deployment, transactions, totalCU };
}

async function main(): Promise<void> {
  const rpcUrl = validateRpcUrl(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const connection = new RpcConnection(rpcUrl);
  console.log(`[deploy] RPC ${rpcUrl}`);
  const program = await connection.account(BALLISTA_ADDRESS);
  if (!program?.executable) throw new Error(`Ballista ${BALLISTA_ADDRESS} is not executable. Run pnpm localnet with vendor/ballista.so.`);
  const creator = await readCreator();
  console.log(`[deploy] Creator ${creator.address}`);
  await connection.fund(creator.address, 200_000_000n);
  const { deployment, transactions, totalCU } = await deployTemplates(connection, creator);
  const constantsHash = createHash('sha256').update(await readFile(new URL('src/rules/constants.ts', root))).digest('hex');
  const manifest = await makeManifest(deployment, rpcUrl, constantsHash);
  await mkdir(new URL('web/public/', root), { recursive: true });
  const temporary = new URL(`web/public/deployment.${process.pid}.json.tmp`, root);
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, manifestFile);
  console.log(`[deploy] Wrote ${fileURLToPath(manifestFile)}`);
  console.log(`[deploy] ${transactions} upload transactions; ${totalCU} CU; constants SHA-256 ${constantsHash}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(`[deploy] FAILED: ${errorMessage(error)}`);
    console.error('[deploy] Check validator terminal, RPC_URL, vendor/ballista.so, and creator keypair. Existing uploads are preserved.');
    process.exitCode = 1;
  });
}
