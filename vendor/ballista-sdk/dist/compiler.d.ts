import { type Template, type TemplateInput } from './schema.js';
export declare const TEMPLATE_PROGRAM_VERSION = 1;
export declare const MAX_TEMPLATE_PAYLOAD_LENGTH = 10240;
export declare const MAX_RUNTIME_ACCOUNTS = 120;
export declare const MAX_ROW_INPUTS = 8;
export declare const MAX_INPUT_VALUES = 256;
export declare const MAX_ACCOUNT_GROUPS = 8;
export declare const MAX_INPUT_BYTES = 1024;
export declare const MAX_REGISTERS = 64;
export declare const MAX_VM_INSTRUCTIONS = 128;
export declare const MAX_EXPANDED_CPIS = 64;
export declare const MAX_CPI_DATA_LENGTH = 4096;
export declare const MAX_CPI_ACCOUNTS = 64;
export declare const MAX_PDA_SEEDS = 15;
export declare const MAX_PDA_SEED_LENGTH = 32;
export declare const MAX_RETURN_DATA_LENGTH = 1024;
/**
 * Entries one template can open. Mirrors `MAX_REGISTRY_OPENS` in `common/src/template/wire.rs`;
 * `opcodes.test.ts` checks the two agree. `MAX_REGISTRIES` and `MAX_REGISTRY_SIZE`, the other two
 * registry limits, live in `schema.js`: the schema's own validators need them.
 */
export declare const MAX_REGISTRY_OPENS = 8;
/** An entry's header before its fields: magic, version, registry index, template and key. */
export declare const REGISTRY_ENTRY_HEADER_LENGTH = 72;
/** The CPIs an open makes at most: a transfer, an allocate and an assign for a pre-funded entry. */
export declare const REGISTRY_OPEN_CPIS = 3;
/** Program header flag: emit a `BEV1` data log after every successful run. */
export declare const PROGRAM_FLAG_EMIT_EVENT = 1;
/** The run event's tag family: the first three bytes of `BEV1`, kept by every version. No emit may start with them. */
export declare const RUN_EVENT_TAG_FAMILY: Uint8Array<ArrayBuffer>;
/** The shortest literal tag an emit may start with. */
export declare const MIN_EMIT_TAG_LENGTH = 4;
/** Instruction flag on read opcodes: the offset comes from register `b`. */
export declare const INSTRUCTION_FLAG_DYNAMIC_OFFSET = 1;
export declare const opcode: {
    readonly loadInput: 1;
    readonly constBool: 2;
    readonly constU64: 3;
    readonly constI64: 4;
    readonly constU128: 5;
    readonly constPubkey: 6;
    readonly constBytes: 7;
    readonly accountKey: 8;
    readonly accountOwner: 9;
    readonly accountLamports: 10;
    readonly accountDataLength: 11;
    readonly accountIsEmpty: 12;
    readonly readU64: 13;
    readonly readI64: 14;
    readonly readU128: 15;
    readonly readPubkey: 16;
    readonly clockSlot: 17;
    readonly clockTimestamp: 18;
    readonly add: 19;
    readonly subtract: 20;
    readonly multiply: 21;
    readonly divide: 22;
    readonly equal: 23;
    readonly notEqual: 24;
    readonly lessThan: 25;
    readonly lessThanOrEqual: 26;
    readonly greaterThan: 27;
    readonly greaterThanOrEqual: 28;
    readonly and: 29;
    readonly or: 30;
    readonly not: 31;
    readonly min: 32;
    readonly max: 33;
    readonly select: 34;
    readonly castU64: 35;
    readonly castI64: 36;
    readonly castU128: 37;
    readonly loopIndex: 38;
    readonly require: 40;
    readonly invoke: 41;
    readonly forEach: 42;
    readonly readU8: 43;
    readonly readU16: 44;
    readonly readU32: 45;
    readonly readBool: 46;
    readonly derivePda: 47;
    readonly returnData: 48;
    readonly move: 49;
    readonly createPda: 50;
    readonly mulDiv: 51;
    readonly mulDivCeil: 52;
    readonly remainder: 53;
    readonly shiftLeft: 54;
    readonly shiftRight: 55;
    readonly bitAnd: 56;
    readonly bitOr: 57;
    readonly bitXor: 58;
    readonly powerOfTen: 59;
    readonly readI32: 60;
    readonly repeat: 61;
    readonly emit: 62;
    readonly setReturnData: 63;
    readonly instructionCount: 64;
    readonly instructionIndex: 65;
    readonly instructionProgram: 66;
    readonly instructionAccountCount: 67;
    readonly instructionAccount: 68;
    readonly instructionAccountFlags: 69;
    readonly instructionDataLength: 70;
    readonly readInstructionData: 71;
    readonly readInstructionBytes: 72;
    readonly readAccountBytes: 73;
    readonly bytesLength: 74;
    readonly openRegistry: 75;
    readonly readRegistry: 76;
    readonly writeRegistry: 77;
    readonly groupLength: 78;
    readonly groupAny: 79;
    readonly groupCount: 80;
};
/** Maps one emitted VM instruction back to the authoring step that produced it. */
export interface SourceMapEntry {
    /** Instruction index, which is also the program counter reported in run errors. */
    pc: number;
    /** Step path such as `steps[2]` or `steps[1].steps[0]`. */
    path: string;
    label?: string;
}
export interface CompileStats {
    payloadBytes: number;
    fixedAccounts: number;
    batchStride: number;
    batchMaxIterations: number;
    batchMinIterations: number;
    inputs: number;
    /**
     * The registers the header declares. A template whose values fit in 64 takes one per value, in
     * order; one that does not is renumbered to reuse registers, and this counts them after reuse.
     */
    registers: number;
    instructions: number;
    cpis: number;
    maxExpandedCpis: number;
    maxCpiDataLength: number;
    emitEvent: boolean;
    rowInputs: number;
    accountGroups: number;
}
/**
 * Test-only options for `compileTemplateWithOptions`; not part of the supported API, and no
 * template needs them.
 * @internal
 */
export interface CompileOptions {
    /**
     * `'always'` renumbers registers for reuse even when every value fits in 64 registers, one each,
     * so a differential test can run the renumbered program against the one-register-per-value
     * program. `'never'` keeps one register per value past 64, which no verifier accepts, so a test
     * can compare a renumbered program with the numbering it came from. Unset, reuse happens only
     * past 64, as always.
     */
    registerReuse?: 'always' | 'never';
}
export interface CompiledTemplate {
    template: Template;
    bytes: Uint8Array;
    hash: Uint8Array;
    inputOrder: readonly string[];
    /** Row inputs in declaration order; each run row supplies these. */
    rowInputOrder: readonly string[];
    fixedAccountOrder: readonly string[];
    batchAccountOrder: readonly string[];
    /** Account groups in declaration order; the run data prefix and metas follow it. */
    accountGroupOrder: readonly string[];
    /** Registries in declaration order: a registry's index, part of its entries' addresses, is its position here. */
    registryOrder: readonly string[];
    stats: CompileStats;
    sourceMap: readonly SourceMapEntry[];
}
export declare function compileTemplate(input: TemplateInput | Template): CompiledTemplate;
/**
 * `compileTemplate` with test-only options. Not part of the supported API: a separate function, so
 * `compileTemplate` keeps one parameter and `templates.map(compileTemplate)` type-checks.
 * @internal
 */
export declare function compileTemplateWithOptions(input: TemplateInput | Template, options: CompileOptions): CompiledTemplate;
/**
 * The index of the registry named `name` in a compiled template, for `findRegistryEntryAddress`:
 * its position among the registries the template declares.
 */
export declare function registryIndex(compiled: CompiledTemplate, name: string): number;
//# sourceMappingURL=compiler.d.ts.map