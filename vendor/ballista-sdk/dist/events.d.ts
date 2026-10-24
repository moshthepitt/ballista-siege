/** The run event's length: `BEV1`, version, rows, invokes reached, executed mask, template. */
export declare const RUN_EVENT_LENGTH = 47;
/** Ballista's run event, which a template with `emitEvent: true` logs after each successful run. */
export interface RunEvent {
    /** The template's bytecode version, `1`. */
    version: number;
    /** The batch rows the run was given, up to 255. A `repeat` loop's passes are not counted. */
    iterations: number;
    /** The invokes the run reached, counting each loop pass. */
    expanded: number;
    /** Bit `n` is set if reached invoke `n` ran, and clear if its `when` skipped it. */
    executed: bigint;
    /** The template account that ran, base58-encoded. */
    templateAddress: string;
}
/**
 * Decodes Ballista's run event from one `Program data:` field: exactly 47 bytes that start with
 * `BEV1`. Returns `undefined` for any other bytes, such as a template's `emit`, whose tag cannot
 * start with `BEV`.
 *
 * It does not know which program logged the bytes, and any program can log these. Take the field
 * from a line `parseProgramData` attributes to Ballista.
 */
export declare function decodeRunEvent(data: Uint8Array): RunEvent | undefined;
/** One `Program data:` log line and the program that logged it. */
export interface ProgramData {
    /** The program that logged the line: the innermost invocation open around it. */
    program: string;
    /** That invocation's stack height: 1 for a transaction's own instruction, 2 for a program it calls. */
    height: number;
    /** The invocation's number, counting the transaction's invocations from 0 in log order. */
    invocation: number;
    /** The line's fields, base64-decoded. `sol_log_data` logs each slice as one field; Ballista logs one. */
    fields: Uint8Array[];
}
/**
 * Every `Program data:` line in a transaction's logs, with the program that logged it. A line does
 * not name its program, so this follows the `invoke`, `success` and `failed` lines around it.
 * Lines with the same `invocation` came from the same call: a template's `emit` lines and the run
 * event that names the template, say.
 *
 * Throws a `TypeError` if the logs do not nest: a data line outside every invocation, a height
 * that skips a level, or an invocation that ends out of order. Logs cut off at Solana's log limit
 * still parse, up to the `Log truncated` line.
 */
export declare function parseProgramData(logs: readonly string[]): ProgramData[];
//# sourceMappingURL=events.d.ts.map