import { type CompiledTemplate, type CompileStats } from './compiler.js';
export declare const BALLISTA_PROGRAM_ADDRESS = "BLSTAmUBA29tcRUvoq5DBYxRhGptrnWPtfQW65RszRWR";
export declare const TEMPLATE_ACCOUNT_VERSION = 2;
export declare const TEMPLATE_ACCOUNT_HEADER_LENGTH = 80;
export declare const TEMPLATE_STATE_UPLOADING = 0;
export declare const TEMPLATE_STATE_FINALIZED = 1;
export declare const INSTRUCTION_CREATE_TEMPLATE = 0;
export declare const INSTRUCTION_BEGIN_TEMPLATE = 1;
export declare const INSTRUCTION_WRITE_TEMPLATE_CHUNK = 2;
export declare const INSTRUCTION_FINALIZE_TEMPLATE = 3;
export declare const INSTRUCTION_CANCEL_TEMPLATE = 4;
export declare const INSTRUCTION_RUN = 5;
export interface UploadInstruction {
    kind: 'create' | 'begin' | 'write' | 'finalize';
    data: Uint8Array;
    offset?: number;
}
export interface TemplateUploadPlan {
    mode: 'oneShot' | 'chunked';
    instructions: readonly UploadInstruction[];
    payloadLength: number;
    payloadHash: Uint8Array;
}
export interface DecodedTemplateAccount {
    version: 2;
    state: 0 | 1;
    bump: number;
    creator: Uint8Array;
    templateId: number;
    payloadLength: number;
    writtenLength: number;
    payloadHash: Uint8Array;
    payload: Uint8Array;
}
export interface AccountBinding {
    address: Uint8Array;
    /** Account group members only: pass the account as writable. Declared accounts take their flags from the schema. */
    writable?: boolean;
}
/** Row values and group sizes that accompany the fixed input values of a run. */
export interface RunInputOptions {
    /** One record per batch row, each holding every row input. Required when the template declares row inputs. */
    rows?: readonly Readonly<Record<string, RunInputValue>>[];
    /** One length per declared account group, in declaration order. */
    groupLengths?: readonly number[];
}
export interface InstructionAccountDescriptor {
    address: Uint8Array;
    signer: boolean;
    writable: boolean;
}
export interface InstructionDescriptor {
    programAddress: Uint8Array;
    accounts: readonly InstructionAccountDescriptor[];
    data: Uint8Array;
}
export type RunInputValue = boolean | bigint | number | Uint8Array;
export declare function encodeCreateTemplate(compiled: CompiledTemplate, templateId: number): Uint8Array;
export declare function encodeBeginTemplate(compiled: CompiledTemplate, templateId: number): Uint8Array;
export declare function encodeWriteTemplateChunk(offset: number, bytes: Uint8Array): Uint8Array;
export declare function encodeFinalizeTemplate(): Uint8Array;
export declare function encodeCancelTemplate(): Uint8Array;
export declare function planTemplateUpload(compiled: CompiledTemplate, templateId: number, options?: {
    maxInstructionDataBytes?: number;
}): TemplateUploadPlan;
export declare function resumeTemplateUpload(compiled: CompiledTemplate, account: DecodedTemplateAccount | Uint8Array, options?: {
    maxInstructionDataBytes?: number;
}): TemplateUploadPlan;
export declare function encodeRunInputs(compiled: CompiledTemplate, values: Readonly<Record<string, RunInputValue>>, options?: RunInputOptions): Uint8Array;
export declare function encodeRun(compiled: CompiledTemplate, values: Readonly<Record<string, RunInputValue>>, options?: RunInputOptions): Uint8Array;
export declare function buildRunInstruction(input: {
    compiled: CompiledTemplate;
    programAddress: Uint8Array;
    templateAddress: Uint8Array;
    inputs?: Readonly<Record<string, RunInputValue>>;
    accounts: Readonly<Record<string, AccountBinding>>;
    batchRows?: readonly Readonly<Record<string, AccountBinding>>[];
    /** One record per batch row with the row's input values; required when the template declares row inputs. */
    batchInputs?: readonly Readonly<Record<string, RunInputValue>>[];
    /** Members of each declared account group, appended after the batch rows in declaration order. */
    accountGroups?: Readonly<Record<string, readonly AccountBinding[]>>;
}): InstructionDescriptor;
export declare function decodeTemplateAccount(data: Uint8Array): DecodedTemplateAccount;
export declare function inspectTemplate(bytes: Uint8Array): CompileStats;
//# sourceMappingURL=instructions.d.ts.map