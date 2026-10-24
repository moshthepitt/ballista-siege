import { validateRpcUrl, isLocalRpc } from './deployment.js';
import { DEVNET_GENESIS } from './network-state.js';
export async function validateEndpoint(value: string, genesis: (url: string) => Promise<string>, production = true): Promise<string> {
  const url = validateRpcUrl(value.trim());
  const hash = await genesis(url);
  if (hash !== DEVNET_GENESIS && (production || !isLocalRpc(url))) throw new Error('This RPC is not Solana devnet.');
  return url;
}
