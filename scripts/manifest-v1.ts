import { type ChainDeployment, type LookupTable, BALLISTA_ADDRESS } from '../src/chain-v1/client.js';
import { TEMPLATE_NAMES } from '../src/chain-v1/templates.js';
import { hex, validateRpcUrl, constantsFingerprint, type DeploymentManifest } from '../play/deployment.js';
export async function makeManifest(d: ChainDeployment, lookup: LookupTable, rpcUrl: string, constantsHash: string): Promise<DeploymentManifest> {
  return {
    version: 1, rules: 'siege-v1', programId: BALLISTA_ADDRESS, rpcUrl: validateRpcUrl(rpcUrl),
    creator: d.creator, ids: d.ids, addresses: d.addresses, lookup, constantsHash,
    constantsFingerprint: await constantsFingerprint(),
    templateHashes: Object.fromEntries(TEMPLATE_NAMES.map(name => [name, hex(d.compiled[name].hash)])) as DeploymentManifest['templateHashes'],
  };
}

/** Build-time compilation preserves stale-manifest detection without shipping a compiler. */
export async function validateManifestForBuild(input: unknown): Promise<void> {
  const { readManifest } = await import('../play/deployment.js');
  const { createDeployment } = await import('../src/chain-v1/client.js');
  const { address } = await import('@solana/kit');
  const { manifest } = await readManifest(input);
  const expected = await createDeployment(address(manifest.creator), manifest.ids[TEMPLATE_NAMES[0]]);
  for (const name of TEMPLATE_NAMES) {
    if (manifest.templateHashes[name] !== hex(expected.compiled[name].hash)) throw new Error(`Stale ${name} deployment. Run pnpm deploy:v1 before building.`);
  }
}
