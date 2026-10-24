import { decodeTemplateAccount } from '../src/chain-v1/wire.js';
import { address, getAddressDecoder, getAddressEncoder, type Address } from '@solana/kit';
import { BALLISTA_ADDRESS, createDeployment, type ChainDeployment, type LookupTable } from '../src/chain-v1/wire.js';
import { TEMPLATE_NAMES } from '../src/chain-v1/run-layout.js';
import { C, LIMITS, PART, PRICE, RNG } from '../src/v1/constants.js';

export interface DeploymentManifest {
  version: 1;
  rules: 'siege-v1';
  programId: string;
  rpcUrl: string;
  creator: string;
  ids: ChainDeployment['ids'];
  addresses: ChainDeployment['addresses'];
  lookup: LookupTable;
  constantsHash: string;
  constantsFingerprint: string;
  templateHashes: Record<keyof ChainDeployment['ids'], string>;
}

export const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
export function validateRpcUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('RPC must use https or http on localhost.');
  if (url.username || url.password || url.hash) throw new Error('RPC cannot contain credentials or a fragment.');
  return url.href;
}
export function isLocalRpc(value: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
}
export async function constantsFingerprint(): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json({ C, LIMITS, PART, PRICE, RNG })))));
}
export function lookupAddresses(d: ChainDeployment): Address[] {
  return [...TEMPLATE_NAMES.map(name => d.addresses[name]), BALLISTA_ADDRESS, address('11111111111111111111111111111111')];
}
/** Reject stale source/addresses before signing. Source hashes are provenance; values are checked here. */
export async function readManifest(value: unknown): Promise<{ manifest: DeploymentManifest; deployment: ChainDeployment }> {
  const input = value as Partial<DeploymentManifest> | null;
  if (!input || input.version !== 1 || input.rules !== 'siege-v1' || input.programId !== BALLISTA_ADDRESS ||
    typeof input.creator !== 'string' || typeof input.rpcUrl !== 'string' ||
    typeof input.constantsHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.constantsHash) ||
    !input.ids || !input.addresses || !input.templateHashes || !input.lookup || !Array.isArray(input.lookup.addresses)) {
    throw new Error('Invalid deployment-v1.json. Run pnpm deploy:v1.');
  }
  validateRpcUrl(input.rpcUrl);
  address(input.lookup.address);
  const first = input.ids[TEMPLATE_NAMES[0]];
  if (!Number.isInteger(first) || first < 0 || first + TEMPLATE_NAMES.length > 65536 ||
    TEMPLATE_NAMES.some((name, i) => input.ids![name] !== first + i)) throw new Error('Invalid v1 template IDs.');
  if (input.constantsFingerprint !== await constantsFingerprint()) throw new Error('Deployment constants differ. Run pnpm deploy:v1 and reload.');
  const deployment = await createDeployment(address(input.creator), first);
  for (const name of TEMPLATE_NAMES) {
    if (input.addresses[name] !== deployment.addresses[name] || !/^[0-9a-f]{64}$/.test(input.templateHashes[name])) {
      throw new Error(`Deployment ${name} differs. Run pnpm deploy:v1 and reload.`);
    }
  }
  if (json(input.lookup.addresses) !== json(lookupAddresses(deployment))) throw new Error('Deployment lookup addresses differ.');
  return { manifest: input as DeploymentManifest, deployment };
}

export interface AccountData { owner: Address; data: Uint8Array; executable: boolean }
export async function checkTemplate(account: AccountData | null, d: ChainDeployment, name: typeof TEMPLATE_NAMES[number], hashes: DeploymentManifest['templateHashes']): Promise<void> {
  if (!account || account.owner !== BALLISTA_ADDRESS) throw new Error(`Missing Ballista template ${name}; run pnpm deploy:v1.`);
  const saved = decodeTemplateAccount(account.data);
  if (saved.state !== 1 || saved.templateId !== d.ids[name] ||
    hex(saved.creator) !== hex(new Uint8Array(getAddressEncoder().encode(d.creator))) ||
    hex(saved.payloadHash) !== hashes[name] || hex(new Uint8Array(await crypto.subtle.digest('SHA-256', saved.payload))) !== hashes[name]) {
    throw new Error(`Deployed ${name} differs or is unfinished; run pnpm deploy:v1.`);
  }
}
export const LOOKUP_PROGRAM = address('AddressLookupTab1e1111111111111111111111111');
/** Native ALT metadata occupies 56 bytes; only a frozen, active table is accepted for play. */
export function decodeLookup(account: AccountData): { addresses: Address[]; frozen: boolean; extendedSlot: bigint; authority?: Address } {
  const b = account.data;
  if (account.owner !== LOOKUP_PROGRAM || b.length < 56 || (b.length - 56) % 32) throw new Error('Invalid lookup table account.');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength), decoder = getAddressDecoder();
  if (view.getUint32(0, true) !== 1 || view.getBigUint64(4, true) !== (1n << 64n) - 1n || b[21] > 1) throw new Error('Inactive lookup table.');
  return {
    frozen: b[21] === 0, extendedSlot: view.getBigUint64(12, true),
    authority: b[21] ? decoder.decode(b.subarray(22, 54)) : undefined,
    addresses: Array.from({ length: (b.length - 56) / 32 }, (_, i) => decoder.decode(b.subarray(56 + i * 32, 88 + i * 32))),
  };
}
