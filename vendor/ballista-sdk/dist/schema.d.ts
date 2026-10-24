import * as z from 'zod';
export declare const ValueTypeSchema: z.ZodEnum<{
    bool: "bool";
    bytes: "bytes";
    i64: "i64";
    pubkey: "pubkey";
    u128: "u128";
    u64: "u64";
}>;
export type ValueType = z.infer<typeof ValueTypeSchema>;
/** Widths a template can read from account data, return data, or instruction data. */
export declare const ReadTypeSchema: z.ZodEnum<{
    bool: "bool";
    i32: "i32";
    i64: "i64";
    pubkey: "pubkey";
    u128: "u128";
    u16: "u16";
    u32: "u32";
    u64: "u64";
    u8: "u8";
}>;
export type ReadType = z.infer<typeof ReadTypeSchema>;
/** Bytes each read type occupies. Frozen, because the SDK's bounds checks depend on these widths. */
export declare const readWidth: Readonly<Record<ReadType, number>>;
/** The types a registry field can hold: the five whose width holds every value of the type. */
export declare const RegistryFieldTypeSchema: z.ZodEnum<{
    bool: "bool";
    i64: "i64";
    pubkey: "pubkey";
    u128: "u128";
    u64: "u64";
}>;
export type RegistryFieldType = z.infer<typeof RegistryFieldTypeSchema>;
/**
 * The most field bytes one registry holds, after its header. Mirrors `MAX_REGISTRY_SIZE` in
 * `common/src/template/wire.rs`; `opcodes.test.ts` checks the two agree.
 */
export declare const MAX_REGISTRY_SIZE = 512;
/**
 * Registries a template can declare: an entry's registry index is below this. Mirrors
 * `MAX_REGISTRIES` in `common/src/template/wire.rs`; `opcodes.test.ts` checks the two agree.
 */
export declare const MAX_REGISTRIES = 8;
/** The bytes a registry's fields take, packed in declaration order with no padding. */
export declare function registrySize(fields: Record<string, RegistryFieldType>): number;
export declare const InputSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"bool">;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"u64">;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"i64">;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"u128">;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"pubkey">;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"bytes">;
    maxLength: z.ZodNumber;
}, z.core.$strict>], "type">;
export type InputDefinition = z.infer<typeof InputSchema>;
export declare const LiteralSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"bool">;
    value: z.ZodBoolean;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"u64">;
    value: z.ZodPipe<z.ZodUnion<readonly [z.ZodBigInt, z.ZodNumber]>, z.ZodTransform<bigint, number | bigint>>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"i64">;
    value: z.ZodPipe<z.ZodUnion<readonly [z.ZodBigInt, z.ZodNumber]>, z.ZodTransform<bigint, number | bigint>>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"u128">;
    value: z.ZodPipe<z.ZodUnion<readonly [z.ZodBigInt, z.ZodNumber]>, z.ZodTransform<bigint, number | bigint>>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"pubkey">;
    value: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodLiteral<"bytes">;
    value: z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>;
}, z.core.$strict>], "type">;
export type Literal = z.infer<typeof LiteralSchema>;
export type AccountReference = {
    kind: 'account';
    name: string;
} | {
    kind: 'iterationAccount';
    name: string;
};
export declare const AccountReferenceSchema: z.ZodType<AccountReference>;
export declare const AccountConstraintSchema: z.ZodObject<{
    signer: z.ZodDefault<z.ZodBoolean>;
    writable: z.ZodDefault<z.ZodBoolean>;
    executable: z.ZodDefault<z.ZodBoolean>;
    address: z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
    owner: z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
    minDataLength: z.ZodDefault<z.ZodNumber>;
    unsafeUnpinned: z.ZodDefault<z.ZodBoolean>;
    registry: z.ZodOptional<z.ZodObject<{
        name: z.ZodString;
        key: z.ZodOptional<z.ZodLazy<z.ZodType<Expression, unknown, z.core.$ZodTypeInternals<Expression, unknown>>>>;
        payer: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type AccountConstraint = z.infer<typeof AccountConstraintSchema>;
export type AccountConstraintInput = z.input<typeof AccountConstraintSchema>;
/**
 * What `groupAny` and `groupCount` test each member of an account group against. A member matches
 * when all of these hold:
 *
 * - its owner is one of `programs`, one or two program addresses (Token and Token-2022, say);
 * - its data holds at least `minDataLength` bytes, by default just enough for every `match`;
 * - for each `match` entry, its data at `offset` holds `equals`, encoded as invocation data
 *   encodes a value of its type: a `pubkey` as 32 bytes, a `u64` or `i64` as 8 little-endian
 *   bytes, a `u128` as 16, a `bool` as one byte;
 * - its address is none of `exceptKeys`.
 */
export interface GroupFilter {
    programs: Uint8Array[];
    minDataLength?: number;
    match: {
        offset: number;
        equals: Expression;
    }[];
    exceptKeys?: Expression[];
}
/** Match entries a group filter holds at most. Mirrors `MAX_GROUP_MATCHES` in `wire.rs`. */
export declare const MAX_GROUP_MATCHES = 4;
/** Except keys a group filter holds at most. Mirrors `MAX_GROUP_EXCEPTS` in `wire.rs`. */
export declare const MAX_GROUP_EXCEPTS = 4;
export type Expression = {
    kind: 'input';
    name: string;
}
/** A batch row input of the current iteration; valid inside `forEach` only. */
 | {
    kind: 'rowInput';
    name: string;
} | {
    kind: 'variable';
    name: string;
} | {
    kind: 'literal';
    value: Literal;
} | {
    kind: 'accountField';
    account: AccountReference;
    field: 'key' | 'owner' | 'lamports' | 'dataLength' | 'isEmpty';
} | {
    kind: 'accountData';
    account: AccountReference;
    /** A fixed byte offset, or a `u64` expression evaluated at run time. */
    offset: number | Expression;
    type: ReadType;
} | {
    /** A typed read of the return data set by the invoke immediately before this step. */
    kind: 'returnData';
    offset: number;
    type: ReadType;
} | {
    kind: 'clock';
    field: 'slot' | 'unixTimestamp';
} | {
    kind: 'loopIndex';
} | {
    kind: 'pda';
    program: AccountReference;
    seeds: Expression[];
    bump?: Expression;
} | {
    kind: 'binary';
    op: 'add' | 'subtract' | 'multiply' | 'divide' | 'min' | 'max' | 'equal' | 'notEqual' | 'lessThan' | 'lessThanOrEqual' | 'greaterThan' | 'greaterThanOrEqual' | 'and' | 'or' | 'remainder' | 'shiftLeft' | 'shiftRight' | 'bitAnd' | 'bitOr' | 'bitXor';
    left: Expression;
    right: Expression;
} | {
    /** `left × right ÷ divisor` with the product computed exactly. */
    kind: 'multiplyDivide';
    left: Expression;
    right: Expression;
    divisor: Expression;
    rounding: 'down' | 'up';
} | {
    kind: 'powerOfTen';
    exponent: Expression;
} | {
    kind: 'not';
    value: Expression;
} | {
    kind: 'select';
    condition: Expression;
    ifTrue: Expression;
    ifFalse: Expression;
} | {
    kind: 'cast';
    to: 'u64' | 'i64' | 'u128';
    value: Expression;
}
/** How many instructions the transaction holds, from the Instructions sysvar `sysvar` names. */
 | {
    kind: 'instructionCount';
    sysvar: AccountReference;
}
/** The index of the instruction running this template. */
 | {
    kind: 'currentInstructionIndex';
    sysvar: AccountReference;
} | {
    /** A field of the transaction's instruction at `index`. */
    kind: 'instruction';
    sysvar: AccountReference;
    index: Expression;
    field: 'program' | 'accountCount' | 'dataLength';
} | {
    /** Account `position` of instruction `index`: its key, or its flags (bit 0 signer, bit 1 writable). */
    kind: 'instructionAccount';
    sysvar: AccountReference;
    index: Expression;
    position: Expression;
    field: 'key' | 'flags';
} | {
    /** A typed read from instruction `index`'s data at a `u64` offset. */
    kind: 'instructionData';
    sysvar: AccountReference;
    index: Expression;
    offset: Expression;
    type: ReadType;
} | {
    /** Exactly `length` bytes of instruction `index`'s data from a `u64` offset. */
    kind: 'instructionDataBytes';
    sysvar: AccountReference;
    index: Expression;
    offset: Expression;
    length: number;
} | {
    /** Exactly `length` bytes of a read-only account's data from a `u64` offset. */
    kind: 'accountDataBytes';
    account: AccountReference;
    offset: Expression;
    length: number;
} | {
    kind: 'bytesLength';
    value: Expression;
}
/**
 * A field of the registry entry in fixed account `account`, which must be declared with
 * `account.registry`. Typed as the field.
 */
 | {
    kind: 'registry';
    account: string;
    field: string;
}
/** How many members the caller supplied in account group `group`, a `u64`. */
 | {
    kind: 'groupLength';
    group: string;
}
/** Whether any member of account group `group` matches `filter`, a `bool`. */
 | {
    kind: 'groupAny';
    group: string;
    filter: GroupFilter;
}
/** How many members of account group `group` match `filter`, a `u64`. */
 | {
    kind: 'groupCount';
    group: string;
    filter: GroupFilter;
};
export declare const ExpressionSchema: z.ZodType<Expression>;
export type DataPart = {
    kind: 'literal';
    bytes: Uint8Array;
} | {
    kind: 'encoded';
    encoding: 'u8' | 'u16' | 'u32' | 'u64' | 'i64' | 'u128' | 'pubkey' | 'bool' | 'bytes';
    value: Expression;
};
export declare const DataPartSchema: z.ZodType<DataPart>;
export declare const InvokeAccountSchema: z.ZodObject<{
    account: z.ZodType<AccountReference, unknown, z.core.$ZodTypeInternals<AccountReference, unknown>>;
    signer: z.ZodDefault<z.ZodBoolean>;
    writable: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export type Step = {
    kind: 'require';
    condition: Expression;
    label?: string;
} | {
    kind: 'let';
    name: string;
    value: Expression;
    label?: string;
} | {
    /** Reassigns a variable listed in the enclosing loop's `carry`. */
    kind: 'assign';
    name: string;
    value: Expression;
    label?: string;
} | {
    kind: 'invoke';
    program: AccountReference;
    accounts: z.infer<typeof InvokeAccountSchema>[];
    data: DataPart[];
    when?: Expression;
    /** A declared account group whose members follow `accounts` in the CPI. */
    accountGroup?: string;
    /** The program this step is written for; compilation fails if the account pins another. */
    programAddress?: Uint8Array;
    label?: string;
} | {
    /**
     * Logs the encoded parts as one `Program data:` field. The first part must be a literal tag
     * of at least `MIN_EMIT_TAG_LENGTH` (4) bytes that does not start with `RUN_EVENT_TAG_FAMILY`
     * ("BEV"), so the log cannot pass for Ballista's run event.
     */
    kind: 'emit';
    parts: DataPart[];
    label?: string;
} | {
    /**
     * Sets the encoded parts as the run's return data. Once per template, outside every loop, and
     * after the last invoke, because invoking a program clears return data.
     */
    kind: 'setReturnData';
    parts: DataPart[];
    label?: string;
} | {
    /**
     * Writes `value` into a field of the registry entry in fixed account `account`. The write
     * lands at once; a run that fails later rolls it back with the transaction.
     */
    kind: 'setRegistry';
    account: string;
    field: string;
    value: Expression;
    label?: string;
} | {
    kind: 'forEach';
    steps: Step[];
    /** Variables defined before the loop whose values flow across iterations and out of it. */
    carry?: string[];
    label?: string;
} | {
    /**
     * Runs `steps` `count` times. `count` is a u64 evaluated once, before the first pass; a run
     * whose count is above `max` fails with `LoopCountExceeded`.
     */
    kind: 'repeat';
    count: Expression;
    /** The most passes the loop may make, 1 to 255. The worst-case CPI count assumes all of them. */
    max: number;
    steps: Step[];
    /** Variables defined before the loop whose values flow across passes and out of it. */
    carry?: string[];
    label?: string;
};
export declare const StepSchema: z.ZodType<Step>;
export declare const TemplateSchema: z.ZodObject<{
    version: z.ZodDefault<z.ZodLiteral<1>>;
    inputs: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"bool">;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"u64">;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"i64">;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"u128">;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"pubkey">;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodLiteral<"bytes">;
        maxLength: z.ZodNumber;
    }, z.core.$strict>], "type">>>;
    registries: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodEnum<{
        bool: "bool";
        i64: "i64";
        pubkey: "pubkey";
        u128: "u128";
        u64: "u64";
    }>>>>;
    accounts: z.ZodRecord<z.ZodString, z.ZodObject<{
        signer: z.ZodDefault<z.ZodBoolean>;
        writable: z.ZodDefault<z.ZodBoolean>;
        executable: z.ZodDefault<z.ZodBoolean>;
        address: z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
        owner: z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
        minDataLength: z.ZodDefault<z.ZodNumber>;
        unsafeUnpinned: z.ZodDefault<z.ZodBoolean>;
        registry: z.ZodOptional<z.ZodObject<{
            name: z.ZodString;
            key: z.ZodOptional<z.ZodLazy<z.ZodType<Expression, unknown, z.core.$ZodTypeInternals<Expression, unknown>>>>;
            payer: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    batch: z.ZodOptional<z.ZodObject<{
        maxIterations: z.ZodNumber;
        minIterations: z.ZodDefault<z.ZodNumber>;
        row: z.ZodRecord<z.ZodString, z.ZodObject<{
            signer: z.ZodDefault<z.ZodBoolean>;
            writable: z.ZodDefault<z.ZodBoolean>;
            executable: z.ZodDefault<z.ZodBoolean>;
            address: z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
            owner: z.ZodOptional<z.ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>>;
            minDataLength: z.ZodDefault<z.ZodNumber>;
            unsafeUnpinned: z.ZodDefault<z.ZodBoolean>;
            registry: z.ZodOptional<z.ZodObject<{
                name: z.ZodString;
                key: z.ZodOptional<z.ZodLazy<z.ZodType<Expression, unknown, z.core.$ZodTypeInternals<Expression, unknown>>>>;
                payer: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        rowInputs: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodDiscriminatedUnion<[z.ZodObject<{
            type: z.ZodLiteral<"bool">;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"u64">;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"i64">;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"u128">;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"pubkey">;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodLiteral<"bytes">;
            maxLength: z.ZodNumber;
        }, z.core.$strict>], "type">>>;
    }, z.core.$strict>>;
    emitEvent: z.ZodDefault<z.ZodBoolean>;
    accountGroups: z.ZodDefault<z.ZodArray<z.ZodString>>;
    steps: z.ZodArray<z.ZodType<Step, unknown, z.core.$ZodTypeInternals<Step, unknown>>>;
}, z.core.$strict>;
export type Template = z.infer<typeof TemplateSchema>;
export type TemplateInput = z.input<typeof TemplateSchema>;
export declare function defineTemplate(input: TemplateInput): Template;
export declare const account: {
    fixed: (name: string) => AccountReference;
    iteration: (name: string) => AccountReference;
    /**
     * An account holding the entry of `registry` for `options.key`, a `pubkey` (the template-wide
     * zero key when absent). `options.payer`, a fixed account declared signer and writable, pays
     * the entry's rent the first time. A declaration for `accounts`, not a reference.
     */
    registry: (registry: string, options: {
        key?: Expression;
        payer: string;
    }) => AccountConstraintInput;
    /** The System program, pinned: a template with registry accounts declares it. */
    systemProgram: () => AccountConstraintInput;
};
export declare const expression: {
    input: (name: string) => Expression;
    rowInput: (name: string) => Expression;
    variable: (name: string) => Expression;
    snapshot: (name: string) => Expression;
    bool: (value: boolean) => Expression;
    u64: (value: bigint | number) => Expression;
    i64: (value: bigint | number) => Expression;
    u128: (value: bigint | number) => Expression;
    pubkey: (value: Uint8Array) => Expression;
    bytes: (value: Uint8Array) => Expression;
    accountField: (accountReference: AccountReference, field: Extract<Expression, {
        kind: 'accountField';
    }>['field']) => Expression;
    accountData: (accountReference: AccountReference, offset: number | Expression, type: ReadType) => Expression;
    returnData: (type: ReadType, offset?: number) => Expression;
    clockSlot: () => Expression;
    clockUnixTimestamp: () => Expression;
    loopIndex: () => Expression;
    pda: (program: AccountReference, seeds: Expression[], bump?: Expression) => Expression;
    add: (left: Expression, right: Expression) => Expression;
    subtract: (left: Expression, right: Expression) => Expression;
    multiply: (left: Expression, right: Expression) => Expression;
    divide: (left: Expression, right: Expression) => Expression;
    min: (left: Expression, right: Expression) => Expression;
    max: (left: Expression, right: Expression) => Expression;
    remainder: (left: Expression, right: Expression) => Expression;
    shiftLeft: (left: Expression, right: Expression) => Expression;
    shiftRight: (left: Expression, right: Expression) => Expression;
    bitAnd: (left: Expression, right: Expression) => Expression;
    bitOr: (left: Expression, right: Expression) => Expression;
    bitXor: (left: Expression, right: Expression) => Expression;
    multiplyDivide: (left: Expression, right: Expression, divisor: Expression, rounding?: 'down' | 'up') => Expression;
    powerOfTen: (exponent: Expression) => Expression;
    equal: (left: Expression, right: Expression) => Expression;
    notEqual: (left: Expression, right: Expression) => Expression;
    lessThan: (left: Expression, right: Expression) => Expression;
    lessThanOrEqual: (left: Expression, right: Expression) => Expression;
    greaterThan: (left: Expression, right: Expression) => Expression;
    greaterThanOrEqual: (left: Expression, right: Expression) => Expression;
    and: (left: Expression, right: Expression) => Expression;
    or: (left: Expression, right: Expression) => Expression;
    not: (value: Expression) => Expression;
    select: (condition: Expression, ifTrue: Expression, ifFalse: Expression) => Expression;
    cast: (to: 'u64' | 'i64' | 'u128', value: Expression) => Expression;
    instructionCount: (sysvar: AccountReference) => Expression;
    currentInstructionIndex: (sysvar: AccountReference) => Expression;
    instructionProgram: (sysvar: AccountReference, index: number | Expression) => Expression;
    instructionAccountCount: (sysvar: AccountReference, index: number | Expression) => Expression;
    instructionDataLength: (sysvar: AccountReference, index: number | Expression) => Expression;
    instructionAccount: (sysvar: AccountReference, index: number | Expression, position: number | Expression) => Expression;
    /** Bit 0 is set when the account signs the instruction, bit 1 when it is writable. */
    instructionAccountFlags: (sysvar: AccountReference, index: number | Expression, position: number | Expression) => Expression;
    instructionAccountIsSigner: (sysvar: AccountReference, index: number | Expression, position: number | Expression) => Expression;
    instructionAccountIsWritable: (sysvar: AccountReference, index: number | Expression, position: number | Expression) => Expression;
    instructionData: (sysvar: AccountReference, index: number | Expression, offset: number | Expression, type: ReadType) => Expression;
    instructionDataBytes: (sysvar: AccountReference, index: number | Expression, offset: number | Expression, length: number) => Expression;
    accountDataBytes: (accountReference: AccountReference, offset: number | Expression, length: number) => Expression;
    bytesLength: (value: Expression) => Expression;
    /** A field of the registry entry in fixed account `account`, typed as the field. */
    registry: (accountName: string, field: string) => Expression;
    /** Shorthand for `accountField(account.fixed(name), 'key')`. */
    accountKey: (name: string) => Expression;
    /** How many members the caller supplied in account group `group`, a `u64`. */
    groupLength: (group: string) => Expression;
    /** Whether any member of account group `group` matches `filter`, a `bool`. See `GroupFilter`. */
    groupAny: (group: string, filter: GroupFilter) => Expression;
    /** How many members of account group `group` match `filter`, a `u64`. See `GroupFilter`. */
    groupCount: (group: string, filter: GroupFilter) => Expression;
};
export declare const data: {
    literal: (bytes: Uint8Array) => DataPart;
    encode: (encoding: Extract<DataPart, {
        kind: 'encoded';
    }>['encoding'], value: Expression) => DataPart;
};
export declare const step: {
    require: (condition: Expression, label?: string) => Step;
    let: (name: string, value: Expression, label?: string) => Step;
    snapshot: (name: string, value: Expression, label?: string) => Step;
    assign: (name: string, value: Expression, label?: string) => Step;
    invoke: (input: Omit<Extract<Step, {
        kind: 'invoke';
    }>, 'kind'>) => Step;
    /**
     * Logs the parts, encoded as invocation data is, as one `Program data:` field. The first part
     * must be a literal tag of at least 4 bytes that does not start with "BEV", the run event's.
     */
    emit: (parts: DataPart[], label?: string) => Step;
    /** Sets the parts, encoded as invocation data is, as the run's return data. */
    setReturnData: (parts: DataPart[], label?: string) => Step;
    /** Writes `value` into a field of the registry entry in fixed account `account`. */
    setRegistry: (accountName: string, field: string, value: Expression, label?: string) => Step;
    forEach: (steps: Step[], options?: {
        carry?: string[];
        label?: string;
    }) => Step;
    /** Runs `steps` `count` times, at most `options.max`; `count` is a u64 read once, before the first pass. */
    repeat: (count: Expression, steps: Step[], options: {
        max: number;
        carry?: string[];
        label?: string;
    }) => Step;
};
//# sourceMappingURL=schema.d.ts.map