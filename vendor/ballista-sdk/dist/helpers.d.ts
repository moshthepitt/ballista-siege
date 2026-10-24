import { type AccountReference, type Expression, type ReadType, type Step } from './schema.js';
/** `11111111111111111111111111111111` */
export declare const SYSTEM_PROGRAM_ADDRESS_BYTES: Uint8Array<ArrayBuffer>;
/** `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` */
export declare const TOKEN_PROGRAM_ADDRESS_BYTES: Uint8Array<ArrayBuffer>;
/** `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`, Token-2022. Its token accounts share the SPL Token layout's first 165 bytes. */
export declare const TOKEN_2022_PROGRAM_ADDRESS_BYTES: Uint8Array<ArrayBuffer>;
/** `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` */
export declare const ASSOCIATED_TOKEN_PROGRAM_ADDRESS_BYTES: Uint8Array<ArrayBuffer>;
/**
 * `Sysvar1nstructions1111111111111111111111111`. Declare an account pinned to this address to read
 * the transaction's instructions; every introspection expression names that account.
 */
export declare const INSTRUCTIONS_SYSVAR_ADDRESS_BYTES: Uint8Array<ArrayBuffer>;
/** `Ed25519SigVerify111111111111111111111111111`, the Ed25519 signature-verification precompile. */
export declare const ED25519_PROGRAM_ADDRESS_BYTES: Uint8Array<ArrayBuffer>;
/**
 * An address as the 32 bytes a template pins, or a `pubkey` input takes: a Kit `Address` or any
 * base58 string. Throws a `TypeError` for text that is not 32 bytes of base58.
 *
 * Kit's `getAddressEncoder().encode()` gives a `ReadonlyUint8Array`, which TypeScript refuses where
 * a template expects a `Uint8Array`.
 */
export declare function addressBytes(address: string): Uint8Array<ArrayBuffer>;
/**
 * An Anchor instruction discriminator: the first 8 bytes of `sha256("global:<name>")`, where `name`
 * is the handler's snake_case name in the program's `#[program]` module. A call to an Anchor
 * program starts its data with these bytes.
 */
export declare function anchorDiscriminator(name: string): Uint8Array<ArrayBuffer>;
export declare function assertPda(input: {
    account: AccountReference;
    program: AccountReference;
    seeds: Expression[];
    /**
     * The bump to derive with, such as `expression.input('bump')`. Supplying it derives the address
     * once instead of searching down from 255: about 1,900 compute units instead of about 4,850 for a
     * search three bumps deep. The assertion then proves only that the account derives from these
     * seeds and this bump, which need not be the canonical one. Leave it out, or write the canonical
     * bump into the template, when only the canonical address will do.
     */
    bump?: Expression;
    label?: string;
}): Step;
export declare function assertAta(input: {
    associatedTokenAccount: AccountReference;
    owner: AccountReference;
    mint: AccountReference;
    tokenProgram: AccountReference;
    associatedTokenProgram: AccountReference;
    bump?: Expression;
    label?: string;
}): Step;
export declare const assertAssociatedTokenAccount: typeof assertAta;
export declare function systemTransfer(input: {
    systemProgram: AccountReference;
    from: AccountReference;
    to: AccountReference;
    lamports: Expression;
    when?: Expression;
    label?: string;
}): Step;
export declare function tokenTransfer(input: {
    tokenProgram: AccountReference;
    source: AccountReference;
    destination: AccountReference;
    authority: AccountReference;
    amount: Expression;
    when?: Expression;
    label?: string;
}): Step;
export declare function createAssociatedTokenAccount(input: {
    associatedTokenProgram: AccountReference;
    payer: AccountReference;
    associatedTokenAccount: AccountReference;
    owner: AccountReference;
    mint: AccountReference;
    systemProgram: AccountReference;
    tokenProgram: AccountReference;
    when?: Expression;
    label?: string;
}): Step;
/** Uses ordinary ATA Create; Ballista's `isEmpty` guard provides the idempotent behavior. */
export declare function ensureAssociatedTokenAccount(input: {
    associatedTokenProgram: AccountReference;
    payer: AccountReference;
    associatedTokenAccount: AccountReference;
    owner: AccountReference;
    mint: AccountReference;
    systemProgram: AccountReference;
    tokenProgram: AccountReference;
    when?: Expression;
    label?: string;
}): Step;
export interface Ed25519Signature {
    /**
     * Requirements that bind the precompile's verified signature to `signer` and to a message of
     * `messageLength` bytes, and the bindings `field` reads through. Put them before any step that
     * uses `field`: without them `field` would read unverified bytes, so it does not compile.
     */
    steps: Step[];
    /** The value at `offset` in the signed message. The whole read must lie inside the message. */
    field(offset: number, type: ReadType): Expression;
}
/**
 * Binds an Ed25519 signature that the transaction's precompile instruction verified to this
 * template's inputs.
 *
 * The Ed25519 program verifies its signatures as part of the transaction, so a transaction whose
 * signature is invalid fails and nothing the template did survives. What the precompile does not
 * say is whose signature it checked, or over which bytes. The steps returned here require that
 * instruction `index` is the Ed25519 program, holds exactly one signature, takes the signature,
 * the key and the message from its own data, was signed by `signer`, and signed exactly
 * `messageLength` bytes. `field` then reads the signed message.
 *
 * The count, the three instruction indexes and the message size all sit in the instruction's
 * first 16 bytes, so one masked `u128` comparison checks them together: five separate
 * comparisons would take a dozen more of the template's 64 registers.
 *
 * `name` prefixes the step labels and the two variables the steps bind, `<name>Instruction` and
 * `<name>Message`, so one template can check more than one signature. Every step is labeled, so a
 * failed run names the step: with no instruction before the run, an `index` of the one before it
 * underflows at `<name>InstructionIndex`.
 */
export declare function ed25519Signature(input: {
    sysvar: AccountReference;
    /** The Ed25519 instruction's index in the transaction, as a `u64`. */
    index: Expression;
    /**
     * The public key the signature must be by, as a `pubkey`. It must be a key the transaction's
     * builder cannot choose, such as a pinned key or the key of an account that must sign. With an
     * input, or the key of an account nothing constrains, the builder can sign with a key of their
     * own and the check proves nothing. This helper refuses an input, but cannot see an account's
     * constraints: those are the caller's to get right.
     */
    signer: Expression;
    messageLength: number;
    name?: string;
}): Ed25519Signature;
/**
 * Steps that spend `amount` from a limit that refills over time, kept in the registry entry in
 * fixed account `registry` (declared with `account.registry`).
 *
 * The entry's `spent` field (a `u64`) is what has been spent and not yet refilled, and its
 * `lastSpend` field (an `i64`) the Unix time of the last spend. Each run takes `now` as the clock,
 * or `lastSpend` if the clock reads earlier, refills `spent` by `(now − lastSpend) ×
 * refillPerSecond`, never below zero, adds `amount`, requires the total to be at most `cap`, and
 * writes `spent` and `now` back.
 *
 * - The refill is computed in `u128`: the elapsed seconds are below 2^63 and the rate below 2^64,
 *   so no gap between runs can overflow it. A fresh entry's `lastSpend` of 0 refills fully.
 * - The clock can step back between slots. A run then refills nothing, rather than failing, and
 *   leaves `lastSpend` where it was: it never moves back, so no later run refills the same seconds
 *   twice.
 * - `cap`, `refillPerSecond` and `amount` are `u64` expressions. `cap` and `refillPerSecond` must
 *   be a template constant, written inline: a literal, such as `expression.u64(1_000_000)`, or
 *   arithmetic or logic over literals, such as `expression.multiply(expression.u64(1_000),
 *   expression.u64(1_000_000))`. A registry field is the one exception, so that an author can set a
 *   cap or rate later: the helper accepts it but cannot tell who wrote it. The entry's address is
 *   verified at run time, but its fields hold whatever this template's runs wrote, so the template
 *   must write that field only in an author-only branch (one that requires a pinned author
 *   signer). A field any caller's run can write gives the caller the cap. Everything else is
 *   refused: an input or row input, a variable (its origin cannot be traced), a read of the
 *   caller-built transaction, or of an account's data or fields (a caller can substitute any
 *   account not pinned by address). `cap` and `refillPerSecond` each appear once in the generated
 *   steps, so writing them inline costs nothing.
 * - The registry account's `key` (passed to `account.registry`) must not come from the caller
 *   either: a key taken from an input lets a caller open a fresh entry on every run and spend past
 *   the cap forever. Key the entry by a signer's address, such as
 *   `expression.accountKey('caller')`, for a per-signer limit, or leave `key` absent for the one
 *   zero-keyed, template-wide entry. This helper only ever sees `registry` as an account name and
 *   cannot see the account's declared key, so it cannot check this for you: it is the caller's to
 *   get right.
 *
 * `name` prefixes the variables the steps bind, `<name>Last`, `<name>Now`, `<name>Spent`,
 * `<name>Refill` and `<name>Total`, and names the requirement `within<Name>`. Without it, the
 * variables take the registry account's name, followed by the `spent` field's when that is not
 * `spent`, and the requirement is `withinRateLimit`. So limits kept in different entries, or in
 * different fields of one entry, fit in one template; give each a `name` to tell their failures
 * apart by label.
 */
export declare function rateLimit(input: {
    registry: string;
    cap: Expression;
    refillPerSecond: Expression;
    amount: Expression;
    /** The entry's `u64` field of what has been spent. Default `spent`. */
    spent?: string;
    /** The entry's `i64` field of when it was last spent. Default `lastSpend`. */
    lastSpend?: string;
    name?: string;
}): Step[];
//# sourceMappingURL=helpers.d.ts.map