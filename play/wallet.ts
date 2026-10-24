import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, getTransactionEncoder, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address, type Instruction,
} from '@solana/kit';
import type { RpcConnection } from './chain-rpc.js';

export async function exportBurner(seed: Uint8Array): Promise<string> {
  if (seed.length !== 32) throw new Error('Burner seed must be 32 bytes.');
  const player = await createKeyPairSignerFromPrivateKeyBytes(seed);
  return JSON.stringify([...seed, ...getAddressEncoder().encode(player.address)]);
}
export async function restoreBurner(text: string): Promise<Uint8Array> {
  const bytes: unknown = JSON.parse(text);
  if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(x => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error('Paste a Solana CLI 64-byte JSON array.');
  const seed = Uint8Array.from(bytes.slice(0, 32));
  if (await exportBurner(seed) !== JSON.stringify(bytes)) throw new Error('Key public bytes do not match its secret.');
  return seed;
}
export function transferInstruction(from: Address, to: Address, amount = 20_000_000n): Instruction {
  if (amount < 0n || amount > (1n << 64n) - 1n) throw new RangeError('Invalid transfer amount.');
  const data = new Uint8Array(12), v = new DataView(data.buffer);
  v.setUint32(0, 2, true); v.setBigUint64(4, amount, true);
  return { programAddress: address('11111111111111111111111111111111'), data, accounts: [
    { address: from, role: AccountRole.WRITABLE_SIGNER }, { address: to, role: AccountRole.WRITABLE },
  ] };
}
export interface WalletAccount { address: string; chains: readonly string[]; features: readonly string[] }
export interface StandardWallet {
  name: string; chains: readonly string[]; accounts: readonly WalletAccount[];
  features: {
    'standard:connect'?: { connect(): Promise<{ accounts: readonly WalletAccount[] }> };
    'solana:signAndSendTransaction'?: { supportedTransactionVersions?: readonly ('legacy' | 0)[]; signAndSendTransaction(input: { account: WalletAccount; chain: 'solana:devnet'; transaction: Uint8Array; options: { preflightCommitment: 'confirmed' } }): Promise<readonly { signature: Uint8Array }[]> };
  };
}
export function discoverWallets(changed: () => void, target: Window = window): { wallets: Set<StandardWallet>; dispose(): void } {
  const wallets = new Set<StandardWallet>();
  const api = Object.freeze({ register: (...items: StandardWallet[]) => {
    for (const wallet of items) if (wallet.chains?.includes('solana:devnet') && wallet.features?.['solana:signAndSendTransaction'] && wallet.features?.['standard:connect']) wallets.add(wallet);
    changed(); return () => { for (const wallet of items) wallets.delete(wallet); changed(); };
  } });
  const register = (event: Event) => { const callback = (event as CustomEvent<(registration: typeof api) => void>).detail; if (typeof callback === 'function') callback(api); };
  target.addEventListener('wallet-standard:register-wallet', register);
  target.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  return { wallets, dispose: () => target.removeEventListener('wallet-standard:register-wallet', register) };
}
export async function sendFromWallet(wallet: StandardWallet, to: Address, connection: RpcConnection): Promise<void> {
  const connected = await wallet.features['standard:connect']!.connect();
  const account = connected.accounts.find(a => a.chains.includes('solana:devnet') && a.features.includes('solana:signAndSendTransaction'));
  if (!account) throw new Error('Wallet needs a devnet account that can send transactions.');
  const lifetime = (await connection.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send({ abortSignal: AbortSignal.timeout(10_000) })).value;
  const feature = wallet.features['solana:signAndSendTransaction']!;
  const supported = feature.supportedTransactionVersions;
  const version = supported && !supported.includes('legacy') ? 0 : 'legacy';
  if (supported && !supported.includes(version)) throw new Error('Wallet needs legacy or v0 transaction support.');
  const message = pipe(createTransactionMessage({ version }), tx => setTransactionMessageFeePayer(address(account.address), tx), tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx), tx => appendTransactionMessageInstructions([transferInstruction(address(account.address), to)], tx));
  const transaction = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
  await feature.signAndSendTransaction({ account, chain: 'solana:devnet', transaction, options: { preflightCommitment: 'confirmed' } });
}
