import { address } from '@solana/kit';
import { BALLISTA_ADDRESS, TEMPLATE_NAMES, createDeployment, type ChainDeployment } from '../src/chain/client.js';
import { C, CELLS, LANES, RNG, ROWS, SECONDS_PER_DAY } from '../src/rules/constants.js';

export interface DeploymentManifest {
  version: 1;
  programId: string;
  rpcUrl: string;
  creator: string;
  ids: ChainDeployment['ids'];
  addresses: Record<keyof ChainDeployment['addresses'], string>;
  /** SHA-256 of src/rules/constants.ts, for source provenance. */
  constantsHash: string;
  /** SHA-256 of imported constant values, checked in both browser and Node. */
  constantsFingerprint: string;
  templateHashes: Record<keyof ChainDeployment['ids'], string>;
}

export const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
export const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);

export function validateRpcUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RPC_URL must use http or https.');
  return url.href;
}

export function isLocalRpc(value: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
}

export async function constantsFingerprint(): Promise<string> {
  const bytes = new TextEncoder().encode(json({ C, RNG, CELLS, LANES, ROWS, SECONDS_PER_DAY }));
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function makeManifest(deployment: ChainDeployment, rpcUrl: string, constantsHash: string): Promise<DeploymentManifest> {
  return {
    version: 1, programId: BALLISTA_ADDRESS, rpcUrl: validateRpcUrl(rpcUrl),
    creator: deployment.creator, ids: deployment.ids, addresses: deployment.addresses,
    constantsHash, constantsFingerprint: await constantsFingerprint(),
    templateHashes: Object.fromEntries(TEMPLATE_NAMES.map(name => [name, hex(deployment.compiled[name].hash)])) as DeploymentManifest['templateHashes'],
  };
}

/** Recompile locally and reject stale manifests before signing anything. */
export async function readManifest(value: unknown): Promise<{ manifest: DeploymentManifest; deployment: ChainDeployment }> {
  if (!value || typeof value !== 'object') throw new Error('Invalid deployment.json. Run pnpm deploy:local.');
  const input = value as Partial<DeploymentManifest>;
  if (input.version !== 1 || input.programId !== BALLISTA_ADDRESS ||
      typeof input.creator !== 'string' || typeof input.rpcUrl !== 'string' ||
      typeof input.constantsHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.constantsHash) ||
      !input.ids || !input.addresses || !input.templateHashes) {
    throw new Error('Invalid deployment.json schema. Run pnpm deploy:local.');
  }
  validateRpcUrl(input.rpcUrl);
  const first = input.ids.prepare;
  if (!Number.isInteger(first) || first < 0 || first > 65531 ||
      TEMPLATE_NAMES.some((name, index) => input.ids![name] !== first + index)) {
    throw new Error('Invalid template IDs in deployment.json.');
  }
  if (input.constantsFingerprint !== await constantsFingerprint()) {
    throw new Error('Deployment constants differ from this client. Run pnpm deploy:local and reload.');
  }
  const deployment = await createDeployment(address(input.creator), first);
  for (const name of TEMPLATE_NAMES) {
    if (input.addresses[name] !== deployment.addresses[name] ||
        input.templateHashes[name] !== hex(deployment.compiled[name].hash)) {
      throw new Error(`Deployment ${name} differs from this client. Run pnpm deploy:local and reload.`);
    }
  }
  return { manifest: input as DeploymentManifest, deployment };
}
