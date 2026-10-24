import {
  appendTransactionMessageInstructions, compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc, createTransactionMessage, getBase64Encoder, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, getTransactionEncoder, lamports, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, signature,
  type Address, type Instruction, type RequestAirdropApi, type Rpc, type SolanaRpcApi, type TransactionSigner,
} from '@solana/kit';
import { PROGRAM_NOTICE } from './deployments/program.js';
import type { LookupTable } from '../src/chain-v1/wire.js';
import { isLocalRpc, json, validateRpcUrl, type AccountData } from './deployment.js';

export interface ChainReceipt {
  signature: string; slot: bigint; logs: readonly string[]; err: unknown; computeUnits?: bigint;
}
/** Saved before submission. Retry resolves this signature before building another transaction. */
export interface Submission { signature: string; lastValidBlockHeight: bigint }
export interface ChainConnection {
  accounts(keys: Address[], minContextSlot?: bigint): Promise<(AccountData | null)[]>;
  fund(player: Address, minimum?: bigint): Promise<void>;
  send(instructions: readonly Instruction[], signer: TransactionSigner, submitted: (tx: Submission) => void, lookup?: LookupTable): Promise<ChainReceipt>;
  confirm(tx: Submission): Promise<ChainReceipt>;
}
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return 'context' in error ? `${error.message}\n${json(error.context)}` : error.message;
}
export class SettledTransactionError extends Error {}
export const pause = (ms = 400) => new Promise<void>(resolve => setTimeout(resolve, ms));
const options = () => ({ abortSignal: AbortSignal.timeout(10_000) });

export class RpcConnection implements ChainConnection {
  readonly rpc: Rpc<SolanaRpcApi & RequestAirdropApi>;
  readonly url: string;
  constructor(url: string, private readonly timeoutMs = 60_000, private readonly canSign: () => boolean = () => true) {
    this.url = validateRpcUrl(url);
    this.rpc = createSolanaRpc(this.url) as Rpc<SolanaRpcApi & RequestAirdropApi>;
  }
  async accounts(keys: Address[], minContextSlot?: bigint): Promise<(AccountData | null)[]> {
    const { value } = await this.rpc.getMultipleAccounts(keys, {
      encoding: 'base64', commitment: 'confirmed', ...(minContextSlot === undefined ? {} : { minContextSlot }),
    }).send(options());
    return value.map(a => a ? { owner: a.owner, executable: a.executable, data: new Uint8Array(getBase64Encoder().encode(a.data[0])) } : null);
  }
  async account(key: Address): Promise<AccountData | null> { return (await this.accounts([key]))[0]; }
  async fund(player: Address, minimum = 10_000_000n): Promise<void> {
    const balance = async () => (await this.rpc.getBalance(player, { commitment: 'confirmed' }).send(options())).value;
    if (await balance() >= minimum) return;
    if (!isLocalRpc(this.url)) throw new Error(`Fund burner ${player} at ${this.url}; automatic airdrops require localhost.`);
    const sig = await this.rpc.requestAirdrop(player, lamports(minimum > 1_000_000_000n ? minimum : 1_000_000_000n), { commitment: 'confirmed' }).send(options());
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const { value } = await this.rpc.getSignatureStatuses([sig]).send(options());
      if (value[0]?.err) throw new Error(`Airdrop ${sig}: ${json(value[0].err)}`);
      if (['confirmed', 'finalized'].includes(value[0]?.confirmationStatus ?? '') && await balance() >= minimum) return;
      await pause();
    }
    throw new Error(`Airdrop timed out: ${sig}. Check validator faucet at ${this.url}.`);
  }
  async send(instructions: readonly Instruction[], signer: TransactionSigner, submitted: (tx: Submission) => void, lookup?: LookupTable): Promise<ChainReceipt> {
    const { value: lifetime } = await this.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(options());
    let message = pipe(createTransactionMessage({ version: 0 }),
      tx => setTransactionMessageFeePayerSigner(signer, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
      tx => appendTransactionMessageInstructions(instructions, tx));
    if (lookup) message = compressTransactionMessageUsingAddressLookupTables(message, { [lookup.address]: lookup.addresses }) as typeof message;
    if (!this.canSign()) throw new Error(PROGRAM_NOTICE);
    const transaction = await signTransactionMessageWithSigners(message);
    const bytes = getTransactionEncoder().encode(transaction).length;
    if (bytes > 1232) throw new Error(`Transaction has ${bytes} bytes (limit 1232). Check frozen lookup table.`);
    const tx: Submission = { signature: getSignatureFromTransaction(transaction), lastValidBlockHeight: lifetime.lastValidBlockHeight };
    submitted(tx);
    try {
      await this.rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), {
        encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 0n,
      }).send(options());
      return await this.confirm(tx);
    } catch (error) {
      if (error instanceof SettledTransactionError) throw error;
      throw new Error(`Transaction ${tx.signature}: ${errorMessage(error)}`, { cause: error });
    }
  }
  async confirm(tx: Submission): Promise<ChainReceipt> {
    const sig = signature(tx.signature), deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const receipt = await this.rpc.getTransaction(sig, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }).send(options());
      if (receipt?.meta) {
        if (receipt.meta.err !== null) throw new SettledTransactionError(`Transaction ${sig} failed: ${json(receipt.meta.err)}\n${receipt.meta.logMessages?.join('\n') ?? ''}`);
        return { signature: sig, slot: receipt.slot, logs: receipt.meta.logMessages ?? [], err: null, computeUnits: receipt.meta.computeUnitsConsumed };
      }
      // Wait for finalized expiry, then check status again. A slow response never authorizes a replacement.
      const expired = await this.rpc.getBlockHeight({ commitment: 'finalized' }).send(options()) > tx.lastValidBlockHeight;
      const { value } = await this.rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send(options());
      if (value[0]?.err) throw new SettledTransactionError(`Transaction ${sig} failed: ${json(value[0].err)}`);
      if (expired && !value[0]) throw new SettledTransactionError(`Transaction ${sig} expired without landing. Retry reads the cursor before signing again.`);
      await pause();
    }
    throw new Error(`Confirmation timed out: ${sig}. Retry checks this signature; no replacement has been sent.`);
  }
}
