import { estimateResourceLimitsFactory, getTransactionMessageSize, type Address, type Instruction, type InstructionWithSigners, type TransactionSigner } from '@solana/kit';
import { type CompiledTemplate } from './compiler.js';
import { type DecodedTemplateAccount, type InstructionDescriptor, type RunInputValue, type TemplateUploadPlan, type UploadInstruction } from './instructions.js';
export declare const BALLISTA_ADDRESS: Address<"BLSTAmUBA29tcRUvoq5DBYxRhGptrnWPtfQW65RszRWR">;
export declare const SYSTEM_PROGRAM_ADDRESS: Address<"11111111111111111111111111111111">;
export interface KitAccountBinding {
    address: Address;
    /** Account group members only: pass the account as writable. */
    writable?: boolean;
    /**
     * The account's Kit signer, for an account the template declares `signer: true`. The
     * instruction carries it, so `signTransactionMessageWithSigners` signs with it as well as with
     * the fee payer. Its address must be `address`.
     */
    signer?: TransactionSigner;
}
export interface KitUploadInstruction {
    kind: UploadInstruction['kind'];
    instruction: Instruction;
    offset?: number;
}
export interface KitTemplateUploadPlan {
    mode: TemplateUploadPlan['mode'];
    templateAddress: Address;
    bump: number;
    instructions: readonly KitUploadInstruction[];
    payloadLength: number;
    payloadHash: Uint8Array;
}
type SizeableTransactionMessage = Parameters<typeof getTransactionMessageSize>[0];
type ResourceLimitEstimator = ReturnType<typeof estimateResourceLimitsFactory>;
type EstimableTransactionMessage = Parameters<ResourceLimitEstimator>[0];
export type ComputeUnitEstimateConfig = NonNullable<Parameters<ResourceLimitEstimator>[1]>;
export type ComputeUnitRpc = Parameters<typeof estimateResourceLimitsFactory>[0]['rpc'];
export declare const MAX_TRANSACTION_COMPUTE_UNITS = 1400000;
export declare const MAX_LOADED_ACCOUNTS_DATA_SIZE: number;
export declare const LOADED_ACCOUNTS_DATA_PAGE_SIZE: number;
export interface ComputeUnitMarginConfig {
    /** Safety margin in basis points. Defaults to the Solana-recommended 10%. */
    marginBps?: number;
    /** Cannot exceed the SVM transaction maximum of 1,400,000 CUs. */
    maxComputeUnitLimit?: number;
}
export interface ComputeUnitEstimate {
    simulatedComputeUnits: number;
    computeUnitLimit: number;
    marginComputeUnits: number;
    marginBps: number;
    capped: boolean;
    simulatedLoadedAccountsDataSize?: number;
    loadedAccountsDataSizeLimit?: number;
}
export interface ComputeUnitProvider {
    estimate<TTransactionMessage extends EstimableTransactionMessage>(transactionMessage: TTransactionMessage, config?: ComputeUnitEstimateConfig): Promise<ComputeUnitEstimate>;
    estimateAndSet<TTransactionMessage extends EstimableTransactionMessage>(transactionMessage: TTransactionMessage, config?: ComputeUnitEstimateConfig): Promise<{
        transactionMessage: TTransactionMessage;
        estimate: ComputeUnitEstimate;
    }>;
}
export declare function getComputeUnitLimitWithMargin(simulatedComputeUnits: number, config?: ComputeUnitMarginConfig): Omit<ComputeUnitEstimate, 'loadedAccountsDataSizeLimit'>;
/**
 * Simulates transaction messages with Solana Kit's resource estimator and applies a buffered CU
 * limit. Version-1 loaded-account data limits are preserved from the same simulation.
 */
export declare function createComputeUnitProvider(input: {
    rpc: ComputeUnitRpc;
} & ComputeUnitMarginConfig): ComputeUnitProvider;
/** Rounds a simulation result to the next 32 KiB cost-model page for v1 headroom. */
export declare function getLoadedAccountsDataSizeLimitWithHeadroom(simulatedBytes: number): number;
/** Reads the authoritative CU count returned in confirmed transaction metadata. */
export declare function getComputeUnitsConsumed(transaction: {
    meta?: {
        computeUnitsConsumed?: bigint | number | null;
    } | null;
} | null): number | undefined;
export declare function getTemplateAddress(creator: Address, templateId: number, programAddress?: Address): Promise<readonly [Address, number]>;
/**
 * A registry entry's address and bump: `["registry", template, [registryIndex], key]` under
 * Ballista, where the entry's open creates it. `registryIndex` is the registry's position among
 * those the template declares; `registryIndex(compiled, name)` finds it by name. `key` is the 32
 * bytes the template computes for the entry: an address such as the caller's for a per-caller
 * entry, or all zeros for one template-wide entry.
 */
export declare function findRegistryEntryAddress(template: Address, registryIndex: number, key: Address | Uint8Array, programAddress?: Address): Promise<readonly [Address, number]>;
/** The subset of a Kit RPC client `findFreeTemplateId` needs. */
export interface TemplateProbeRpc {
    getMultipleAccounts(addresses: Address[]): {
        send(): Promise<{
            value: readonly (unknown | null)[];
        }>;
    };
}
export interface FreeTemplateId {
    templateId: number;
    templateAddress: Address;
    bump: number;
}
/**
 * Finds the lowest template ID at or above `start` whose address holds no account. Anyone can
 * dust a predictable template address, and creation tolerates that, but an address that already
 * holds a finalized or uploading template cannot be reused, so callers probe before uploading.
 */
export declare function findFreeTemplateId(input: {
    rpc: TemplateProbeRpc;
    creator: Address;
    programAddress?: Address;
    start?: number;
    batchSize?: number;
}): Promise<FreeTemplateId>;
export declare function toKitInstruction(descriptor: InstructionDescriptor): Instruction;
export declare function buildKitRunInstruction(input: {
    compiled: CompiledTemplate;
    templateAddress: Address;
    programAddress?: Address;
    inputs?: Readonly<Record<string, RunInputValue>>;
    accounts: Readonly<Record<string, KitAccountBinding>>;
    batchRows?: readonly Readonly<Record<string, KitAccountBinding>>[];
    batchInputs?: readonly Readonly<Record<string, RunInputValue>>[];
    accountGroups?: Readonly<Record<string, readonly KitAccountBinding[]>>;
}): Instruction & InstructionWithSigners;
export declare function buildKitTemplateUploadPlan(input: {
    compiled: CompiledTemplate;
    creator: Address;
    templateId: number;
    programAddress?: Address;
    maxInstructionDataBytes?: number;
    transactionMessage?: SizeableTransactionMessage;
}): Promise<KitTemplateUploadPlan>;
export declare function buildKitResumeTemplateUploadPlan(input: {
    compiled: CompiledTemplate;
    account: DecodedTemplateAccount | Uint8Array;
    creator: Address;
    templateId: number;
    programAddress?: Address;
    maxInstructionDataBytes?: number;
    transactionMessage?: SizeableTransactionMessage;
}): Promise<KitTemplateUploadPlan>;
export declare function buildKitCancelTemplateInstruction(input: {
    creator: Address;
    templateId: number;
    programAddress?: Address;
}): Promise<Instruction>;
export declare function measureTransactionMessage(transactionMessage: SizeableTransactionMessage): {
    size: number;
    limit: number;
    fits: boolean;
};
export declare function measureInstructionInTransaction(transactionMessage: SizeableTransactionMessage, instruction: Instruction): {
    size: number;
    limit: number;
    fits: boolean;
};
export {};
//# sourceMappingURL=kit.d.ts.map