import type { CompiledTemplate, SourceMapEntry } from './compiler.js';
/** First runtime error code; kinds follow `RUNTIME_ERROR_NAMES` in order. */
export declare const RUNTIME_ERROR_BASE = 6000;
/** First verifier error code; kinds follow `VERIFIER_ERROR_NAMES` in order. */
export declare const VERIFIER_ERROR_BASE = 6100;
/** Runtime failures raised by the program, in code order. Shared with Rust via `fixtures/`. */
export declare const RUNTIME_ERROR_NAMES: readonly ['InvalidInstructionData', 'InvalidTemplateAccount', 'InvalidTemplateProgram', 'TemplateNotUploading', 'TemplateNotFinalized', 'InvalidCreator', 'InvalidChunkOffset', 'HashMismatch', 'InvalidRunInputs', 'InvalidRuntimeAccount', 'InvalidAccountRange', 'InvalidRegister', 'TypeMismatch', 'ArithmeticOverflow', 'DivisionByZero', 'RequirementFailed', 'CpiDataTooLarge', 'InvalidPdaDerivation', 'MissingReturnData', 'ReturnDataMismatch', 'AccountConstraintFailed', 'CpiAccountLimitExceeded', 'LoopCountExceeded', 'InstructionOutOfRange', 'WritableAccountBytesRead', 'InvalidRegistryEntry', 'RegistryReentry'];
/** Verifier failures raised at create and finalize, in code order. */
export declare const VERIFIER_ERROR_NAMES: readonly ['Truncated', 'PayloadTooLarge', 'InvalidMagic', 'UnsupportedVersion', 'InvalidReservedBytes', 'SectionLengthMismatch', 'CountOverflow', 'TooManyAccounts', 'TooManyInputs', 'TooManyRegisters', 'TooManyInstructions', 'InvalidBatch', 'InvalidAccountConstraint', 'InvalidInput', 'InvalidInstruction', 'InvalidCpi', 'InvalidDataSegment', 'InvalidRegister', 'RegisterNotInitialized', 'TypeMismatch', 'InvalidBlobRange', 'ExcessiveCpiExpansion', 'InvalidFlags', 'InvalidCarry', 'ReadOutOfBounds', 'TooManyCpiAccounts', 'InvalidReturnData', 'InvalidMinIterations', 'TooManyAccountGroups', 'InvalidLoop', 'InvalidOutput', 'InvalidIntrospection', 'InvalidRegistry', 'InvalidAccountGroup'];
export type RuntimeErrorName = (typeof RUNTIME_ERROR_NAMES)[number];
export type VerifierErrorName = (typeof VERIFIER_ERROR_NAMES)[number];
export interface DecodedBallistaError {
    /** The raw custom error code. */
    code: number;
    /** The low 16 bits: the error kind. */
    kind: number;
    name: RuntimeErrorName | VerifierErrorName;
    /** The high 16 bits: program counter, account index, input index, count, or verifier context. */
    context: number;
    source: 'runtime' | 'verifier';
}
/**
 * Splits a Ballista custom error code into kind and context. The code can be a `bigint`, as Kit's
 * RPC returns a simulation's `Custom` code. Returns `undefined` for codes outside Ballista's
 * ranges, which belong to another program and pass through Ballista unchanged.
 *
 * A code inside the ranges can still be another program's: Anchor programs number their errors
 * from 6000 too. `decodeBallistaFailure` checks the logs for which program failed.
 */
export declare function decodeBallistaError(code: number | bigint): DecodedBallistaError | undefined;
/**
 * The program whose failure ended a transaction, named by its first `Program <address> failed:`
 * log line. The program that failed logs that line first, and every caller up the stack repeats
 * the error after it, so the first names the program the transaction's error code belongs to.
 *
 * Returns `undefined` when no line names one: the runtime refused the transaction before a program
 * ran, the program logs nothing (as a precompile does), or the logs were cut off at Solana's log
 * limit, which leaves a `Log truncated` line.
 */
export declare function failedProgram(logs: readonly string[]): string | undefined;
/**
 * Decodes `code` as Ballista's only when the logs show that Ballista is the program that failed.
 * Anchor programs number their errors from 6000 too, so a Jupiter route's 6001 would otherwise
 * read as Ballista's `InvalidTemplateAccount`.
 *
 * Returns `undefined` when another program failed, and when the logs name no failed program;
 * `failedProgram` tells the two apart. `programAddress` is Ballista's unless you pass another
 * deployment's.
 */
export declare function decodeBallistaFailure(code: number | bigint, logs: readonly string[], programAddress?: string): DecodedBallistaError | undefined;
export interface RunErrorExplanation {
    error: DecodedBallistaError;
    /** The authoring step that emitted the failing instruction, when the context is a program counter. */
    step?: SourceMapEntry;
    /** The runtime account that failed validation, when the context is an account index. */
    account?: {
        index: number;
        name: string;
        row?: number;
    };
    /** The input that failed to decode, when the context is an input index. */
    input?: string;
    message: string;
}
/** Where `explainRunError` checks which program failed. */
export interface ExplainRunErrorOptions {
    /** The failed transaction's logs. With them, a code is explained only if Ballista failed. */
    logs?: readonly string[];
    /** The Ballista deployment to expect in the logs. Defaults to `BALLISTA_PROGRAM_ADDRESS`. */
    programAddress?: string;
}
/**
 * Maps a failed run's custom error code back to the template that produced it: the step for VM
 * failures, the account for constraint failures, or the input for decoding failures.
 *
 * Pass the transaction's `logs` to explain the code only when Ballista is the program that
 * failed, as `decodeBallistaFailure` decodes it; without them, a called program's code in
 * Ballista's ranges is explained as Ballista's.
 */
export declare function explainRunError(code: number | bigint, compiled: CompiledTemplate, options?: ExplainRunErrorOptions): RunErrorExplanation | undefined;
//# sourceMappingURL=errors.d.ts.map