import {
  appendTransactionMessageInstructions, createSolanaRpc, createTransactionMessage,
  getBase64Encoder, getBase64EncodedWireTransaction, getSignatureFromTransaction,
  lamports, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Address, type Instruction, type RequestAirdropApi, type Rpc, type Signature, type SolanaRpcApi, type TransactionSigner,
} from '@solana/kit';
import { isLocalRpc, json, validateRpcUrl } from './deployment.js';

export interface ChainAccount { owner: Address; data: Uint8Array; executable: boolean }
export interface ChainReceipt {
  signature: string;
  slot: bigint;
  logs: readonly string[];
  err: unknown;
  computeUnits?: bigint;
  blockTime: bigint | null;
}
export interface ChainConnection {
  account(key: Address, minContextSlot?: bigint): Promise<ChainAccount | null>;
  fund(player: Address, minimum?: bigint): Promise<void>;
  send(instructions: readonly Instruction[], signer: TransactionSigner, submitted?: (signature: string) => void): Promise<ChainReceipt>;
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const context = 'context' in error ? json(error.context) : '';
  return context ? `${error.message}\n${context}` : error.message;
}

const pause = () => new Promise(resolve => setTimeout(resolve, 400));
const requestOptions = () => ({ abortSignal: AbortSignal.timeout(10_000) });

/** HTTP polling works in browsers and Node without a websocket subscription. */
export class RpcConnection implements ChainConnection {
  readonly rpc: Rpc<SolanaRpcApi & RequestAirdropApi>;
  readonly url: string;

  constructor(url: string, private readonly timeoutMs = 60_000) {
    this.url = validateRpcUrl(url);
    // Local validators expose requestAirdrop; calls are gated by isLocalRpc below.
    this.rpc = createSolanaRpc(this.url) as Rpc<SolanaRpcApi & RequestAirdropApi>;
  }

  async account(key: Address, minContextSlot?: bigint): Promise<ChainAccount | null> {
    const { value } = await this.rpc.getAccountInfo(key, {
      encoding: 'base64', commitment: 'confirmed', ...(minContextSlot === undefined ? {} : { minContextSlot }),
    }).send(requestOptions());
    return value ? { owner: value.owner, data: Uint8Array.from(getBase64Encoder().encode(value.data[0])), executable: value.executable } : null;
  }

  async fund(player: Address, minimum = 10_000_000n): Promise<void> {
    const balance = async () => (await this.rpc.getBalance(player, { commitment: 'confirmed' }).send(requestOptions())).value;
    if (await balance() >= minimum) return;
    if (!isLocalRpc(this.url)) throw new Error(`Fund burner ${player} at ${this.url}; automatic airdrop is only enabled for localhost.`);
    const signature = await this.rpc.requestAirdrop(player, lamports(minimum > 1_000_000_000n ? minimum : 1_000_000_000n), { commitment: 'confirmed' }).send(requestOptions());
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const { value } = await this.rpc.getSignatureStatuses([signature]).send(requestOptions());
      if (value[0]?.err) throw new Error(`Airdrop ${signature}: ${json(value[0].err)}`);
      if (value[0] && ['confirmed', 'finalized'].includes(value[0].confirmationStatus ?? '') && await balance() >= minimum) return;
      await pause();
    }
    throw new Error(`Airdrop confirmation timed out: ${signature}. Check validator faucet at ${this.url}.`);
  }

  async send(instructions: readonly Instruction[], signer: TransactionSigner, submitted?: (signature: string) => void): Promise<ChainReceipt> {
    const { value: lifetime } = await this.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(requestOptions());
    const message = pipe(
      createTransactionMessage({ version: 'legacy' }),
      tx => setTransactionMessageFeePayerSigner(signer, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
      tx => appendTransactionMessageInstructions(instructions, tx),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(transaction);
    submitted?.(signature);
    try {
      await this.rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), {
        encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3n,
      }).send(requestOptions());
      return await this.confirm(signature, lifetime.lastValidBlockHeight);
    } catch (error) {
      throw new Error(`Transaction ${signature}: ${errorMessage(error)}`, { cause: error });
    }
  }

  private async confirm(signature: Signature, lastValidBlockHeight: bigint): Promise<ChainReceipt> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const receipt = await this.rpc.getTransaction(signature, {
        commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0,
      }).send(requestOptions());
      if (receipt?.meta) {
        if (receipt.meta.err !== null) throw new Error(`${json(receipt.meta.err)}\n${receipt.meta.logMessages?.join('\n') ?? ''}`);
        return {
          signature, slot: receipt.slot, logs: receipt.meta.logMessages ?? [], err: receipt.meta.err,
          computeUnits: receipt.meta.computeUnitsConsumed, blockTime: receipt.blockTime,
        };
      }
      const { value } = await this.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send(requestOptions());
      if (value[0]?.err) throw new Error(`Execution failed: ${json(value[0].err)}`);
      if (!value[0] && await this.rpc.getBlockHeight({ commitment: 'confirmed' }).send(requestOptions()) > lastValidBlockHeight) {
        throw new Error('Blockhash expired before confirmation.');
      }
      await pause();
    }
    throw new Error('Confirmation timed out. Check the signature before retrying; the transaction may have landed.');
  }
}
