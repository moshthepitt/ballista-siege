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
// The public devnet endpoint answers bursts with HTTP 429. A 429 means the node did not take the request,
// so sending it again is safe, including a signed transaction (same bytes, same signature).
const RATE_LIMIT_WAITS = [1_000, 2_000, 4_000, 8_000, 15_000];
export function isRateLimited(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 4) return false;
  const e = error as { context?: { statusCode?: unknown }; cause?: unknown };
  return e.context?.statusCode === 429 || isRateLimited(e.cause, depth + 1);
}
export async function call<T>(request: { send(options: { abortSignal: AbortSignal }): Promise<T> }, waits = RATE_LIMIT_WAITS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await request.send(options()); }
    catch (error) { if (!isRateLimited(error) || attempt >= waits.length) throw error; await pause(waits[attempt]); }
  }
}

export class RpcConnection implements ChainConnection {
  readonly rpc: Rpc<SolanaRpcApi & RequestAirdropApi>;
  readonly url: string;
  constructor(url: string, private readonly timeoutMs = 60_000, private readonly canSign: () => boolean = () => true) {
    this.url = validateRpcUrl(url);
    this.rpc = createSolanaRpc(this.url) as Rpc<SolanaRpcApi & RequestAirdropApi>;
  }
  async accounts(keys: Address[], minContextSlot?: bigint): Promise<(AccountData | null)[]> {
    const { value } = await call(this.rpc.getMultipleAccounts(keys, {
      encoding: 'base64', commitment: 'confirmed', ...(minContextSlot === undefined ? {} : { minContextSlot }),
    }));
    return value.map(a => a ? { owner: a.owner, executable: a.executable, data: new Uint8Array(getBase64Encoder().encode(a.data[0])) } : null);
  }
  async account(key: Address): Promise<AccountData | null> { return (await this.accounts([key]))[0]; }
  async fund(player: Address, minimum = 10_000_000n): Promise<void> {
    const balance = async () => (await call(this.rpc.getBalance(player, { commitment: 'confirmed' }))).value;
    if (await balance() >= minimum) return;
    if (!isLocalRpc(this.url)) throw new Error(`Fund burner ${player} at ${this.url}; automatic airdrops require localhost.`);
    const sig = await call(this.rpc.requestAirdrop(player, lamports(minimum > 1_000_000_000n ? minimum : 1_000_000_000n), { commitment: 'confirmed' }));
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const { value } = await call(this.rpc.getSignatureStatuses([sig]));
      if (value[0]?.err) throw new Error(`Airdrop ${sig}: ${json(value[0].err)}`);
      if (['confirmed', 'finalized'].includes(value[0]?.confirmationStatus ?? '') && await balance() >= minimum) return;
      await pause();
    }
    throw new Error(`Airdrop timed out: ${sig}. Check validator faucet at ${this.url}.`);
  }
  async send(instructions: readonly Instruction[], signer: TransactionSigner, submitted: (tx: Submission) => void, lookup?: LookupTable): Promise<ChainReceipt> {
    const { value: lifetime } = await call(this.rpc.getLatestBlockhash({ commitment: 'confirmed' }));
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
      const wire = getBase64EncodedWireTransaction(transaction);
      await call(this.rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' }));
      // Devnet drops some transactions. Sending the same signed bytes again cannot double-apply: one signature lands once.
      return await this.confirm(tx, () => this.rpc.sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n }).send(options()));
    } catch (error) {
      if (error instanceof SettledTransactionError) throw error;
      throw new Error(`Transaction ${tx.signature}: ${errorMessage(error)}`, { cause: error });
    }
  }
  async confirm(tx: Submission, resend?: () => Promise<unknown>): Promise<ChainReceipt> {
    const sig = signature(tx.signature), deadline = Date.now() + this.timeoutMs;
    const status = async () => (await call(this.rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }))).value[0];
    let polls = 0;
    while (Date.now() < deadline) {
      // One status read per poll keeps a turn under public RPC limits; the receipt is read once confirmed.
      const current = await status();
      if (current && current.confirmationStatus !== 'processed') {
        const receipt = await call(this.rpc.getTransaction(sig, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }));
        if (receipt?.meta) {
          if (receipt.meta.err !== null) throw new SettledTransactionError(`Transaction ${sig} failed: ${json(receipt.meta.err)}\n${receipt.meta.logMessages?.join('\n') ?? ''}`);
          return { signature: sig, slot: receipt.slot, logs: receipt.meta.logMessages ?? [], err: null, computeUnits: receipt.meta.computeUnitsConsumed };
        }
      }
      if (current?.err) throw new SettledTransactionError(`Transaction ${sig} failed: ${json(current.err)}`);
      if (!current && resend && polls % 5 === 4) await resend().catch(() => undefined);
      if (!current && ++polls % 5 === 0) {
        // Wait for finalized expiry, then check status again. A slow response never authorizes a replacement.
        const expired = await call(this.rpc.getBlockHeight({ commitment: 'finalized' })) > tx.lastValidBlockHeight;
        if (expired && !await status()) throw new SettledTransactionError(`Transaction ${sig} expired without landing. Retry reads the cursor before signing again.`);
      }
      await pause();
    }
    throw new Error(`Confirmation timed out: ${sig}. Retry checks this signature; no replacement has been sent.`);
  }
}
