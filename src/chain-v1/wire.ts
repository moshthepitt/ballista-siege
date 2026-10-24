// Ballista protocol framing follows the MIT-licensed SDK; see vendor/ballista-sdk/LICENSE.
import { AccountRole, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import { decodeEvent, encodeActions, unpackState, type Action, type Mode, type RunState, type TurnEvent } from '../v1/sim.js';
import { RUN_LAYOUT, TEMPLATE_NAMES, type TemplateName } from './run-layout.js';
export { TEMPLATE_NAMES, encodeActions };
export const BALLISTA_ADDRESS = address('BLSTAmUBA29tcRUvoq5DBYxRhGptrnWPtfQW65RszRWR');
export const SYSTEM_PROGRAM_ADDRESS = address('11111111111111111111111111111111');
export const ENTRY_BYTES = 120, WORK_BYTES = 264, COMPUTE_UNITS = 1350000;
export interface ChainDeployment {
    creator: Address;
    ids: Record<TemplateName, number>;
    addresses: Record<TemplateName, Address>;
}
export interface LookupTable { address: Address; addresses: Address[] }
export async function createDeployment(creator: Address, firstTemplateId = 11000): Promise<ChainDeployment> {
    if (!Number.isInteger(firstTemplateId) || firstTemplateId < 0 || firstTemplateId + TEMPLATE_NAMES.length > 65536) throw new RangeError('Invalid template IDs');
    const ids = Object.fromEntries(TEMPLATE_NAMES.map((n, i) => [n, firstTemplateId + i])) as ChainDeployment['ids'];
    const encode = getAddressEncoder();
    const addresses = Object.fromEntries(await Promise.all(TEMPLATE_NAMES.map(async n => [n, (await getProgramDerivedAddress({
        programAddress: BALLISTA_ADDRESS, seeds: [new TextEncoder().encode('template'), encode.encode(creator), Uint8Array.of(ids[n] & 255, ids[n] >>> 8)],
    }))[0]]))) as ChainDeployment['addresses'];
    return { creator, ids, addresses };
}
export async function getEntryAddresses(d: ChainDeployment, player: Address) {
    const encode = getAddressEncoder();
    const pairs = await Promise.all(RUN_LAYOUT.registries.map(async ({ name, index }) => [name, (await getProgramDerivedAddress({
        programAddress: BALLISTA_ADDRESS, seeds: [new TextEncoder().encode('registry'), encode.encode(d.addresses.state), Uint8Array.of(index), encode.encode(player)],
    }))[0]]));
    return Object.fromEntries(pairs) as { run: Address; work: Address };
}
export function computeBudgetInstruction(limit = COMPUTE_UNITS): Instruction {
    const bytes = new Uint8Array(5);
    bytes[0] = 2;
    new DataView(bytes.buffer).setUint32(1, limit, true);
    return { programAddress: address('ComputeBudget111111111111111111111111111111'), data: bytes };
}
export interface StepInput {
    op: bigint;
    cursor: bigint;
    next: bigint;
    target: bigint;
    expectedWave: bigint;
    actions: bigint;
    seed: bigint;
    mode: bigint;
}
export async function buildStepInstruction(d: ChainDeployment, player: Address | TransactionSigner, values: StepInput): Promise<Instruction> {
    const playerAddress = typeof player === 'string' ? player : player.address;
    const entries = await getEntryAddresses(d, playerAddress);
    const bindings: Record<string, Address> = { ...d.addresses, ...entries, player: playerAddress, systemProgram: SYSTEM_PROGRAM_ADDRESS, ballista: BALLISTA_ADDRESS };
    const data = new Uint8Array(1 + RUN_LAYOUT.inputs.length * 8), view = new DataView(data.buffer);
    data[0] = 5;
    RUN_LAYOUT.inputs.forEach((name, i) => {
        const value = values[name];
        if (typeof value !== 'bigint' || value < 0n || value > (1n << 64n) - 1n) throw new RangeError(`Invalid u64 input: ${name}`);
        view.setBigUint64(1 + i * 8, value, true);
    });
    if (Object.keys(values).some(name => !(RUN_LAYOUT.inputs as readonly string[]).includes(name))) throw new TypeError('Unknown inputs');
    return { programAddress: BALLISTA_ADDRESS, data, accounts: [
        { address: d.addresses.state, role: AccountRole.READONLY },
        ...RUN_LAYOUT.accounts.map(({ name, role }) => ({ address: bindings[name], role, ...(name === 'player' && typeof player !== 'string' ? { signer: player } : {}) })),
    ] };
}
const blank = (expectedWave = 0n): StepInput => ({ op: 0n, cursor: 0n, next: 0n, target: 0n, expectedWave, actions: 0n, seed: 0n, mode: 0n });
/** Start all three words atomically. Supply the current cursor when abandoning a pending run. */
export async function buildStartInstructions(d: ChainDeployment, player: Address | TransactionSigner, seed: bigint, mode: Mode = 'practice', cursor = 0n) {
    if (mode !== 'daily' && mode !== 'practice')
        throw new TypeError('Invalid mode');
    const base = { ...blank(), seed, mode: mode === 'daily' ? 1n : 0n };
    return [computeBudgetInstruction(), ...await Promise.all([
            { cursor, target: 0n, next: 1001n }, { cursor: 1001n, target: 1n, next: 1002n }, { cursor: 1002n, target: 2n, next: 0n },
        ].map(s => buildStepInstruction(d, player, { ...base, ...s })))];
}
export function turnSteps(expectedWave: bigint, actions: bigint): StepInput[] {
    const base = blank(expectedWave), out: StepInput[] = [{ ...base, op: 1n, cursor: 0n, next: 1n, target: 3n, actions }];
    for (let lane = 0n; lane < 4n; lane++)
        out.push({ ...base, op: 2n, cursor: lane + 1n, next: lane + 2n, target: lane + 7n });
    for (let tick = 0n; tick < 10n; tick++) {
        const p = 5n + tick * 9n;
        out.push({ ...base, op: 3n, cursor: p, next: p + 1n, target: 4n });
        for (let lane = 0n; lane < 4n; lane++)
            out.push({ ...base, op: 4n, cursor: p + 1n + lane * 2n, next: p + 2n + lane * 2n, target: 7n + lane }, { ...base, op: 5n, cursor: p + 2n + lane * 2n, next: p + 3n + lane * 2n, target: 5n });
    }
    out.push({ ...base, op: 6n, cursor: 95n, next: 96n, target: 6n });
    for (let i = 0n; i < 3n; i++)
        out.push({ ...base, op: 7n, cursor: 96n + i, next: 97n + i, target: i });
    out.push({ ...base, op: 8n, cursor: 99n, next: 0n, target: 6n });
    return out;
}
/** Ordered, resumable steps. Transaction packing uses the deployment's address lookup table. */
export async function buildTurnInstructions(d: ChainDeployment, player: Address | TransactionSigner, expectedWave: bigint, actions: readonly Action[] | bigint, cursor = 0n) {
    const word = typeof actions === 'bigint' ? actions : encodeActions(actions);
    const steps = turnSteps(expectedWave, word), start = steps.findIndex(s => s.cursor === cursor);
    if (start < 0)
        throw new RangeError('Invalid combat cursor');
    return Promise.all(steps.slice(start).map(s => buildStepInstruction(d, player, s)));
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
export interface Entry {
    data: Uint8Array;
    owner: Address;
    template: Address;
    player: Address;
}
function validateEntry(entry: Entry, size: number, index: number) {
    const enc = getAddressEncoder(), b = entry.data;
    if (entry.owner !== BALLISTA_ADDRESS || b.length !== size || !same(b.subarray(0, 8), Uint8Array.of(66, 82, 69, 71, 1, index, 0, 0)) || !same(b.subarray(8, 40), new Uint8Array(enc.encode(entry.template))) || !same(b.subarray(40, 72), new Uint8Array(enc.encode(entry.player))))
        throw new TypeError('Invalid Siege registry entry');
}
function words(bytes: Uint8Array, offset: number, count: number) { const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return Array.from({ length: count }, (_, i) => view.getBigUint64(offset + i * 8, true)); }
export function decodeRunState(entry: Entry): RunState { validateEntry(entry, ENTRY_BYTES, 0); return unpackState(words(entry.data, 72, 6)); }
export function decodeCombatCursor(entry: Entry): bigint { validateEntry(entry, WORK_BYTES, 1); const cursor = words(entry.data, 72, 1)[0]; if (cursor > 99n && cursor !== 1001n && cursor !== 1002n)
    throw new TypeError('Invalid combat cursor'); return cursor; }
/** During commit, expose the saved before snapshot until the event phase completes. */
export function decodeSessionState(run: Entry, work: Entry) {
    if (run.template !== work.template || run.player !== work.player)
        throw new TypeError('Mismatched Siege registry entries');
    const cursor = decodeCombatCursor(work);
    validateEntry(run, ENTRY_BYTES, 0);
    if (cursor >= 1001n)
        throw new TypeError('Run creation is incomplete');
    const state = cursor >= 96n && cursor <= 99n ? unpackState(words(work.data, 152, 6)) : decodeRunState(run);
    return { state, cursor, pending: cursor !== 0n };
}
export function parseTurnEvents(receipt: {
    logs: readonly string[];
    err: unknown;
}, d: ChainDeployment): TurnEvent[] {
    if (receipt.err !== null)
        return [];
    const records = parseProgramData(receipt.logs), templates = new Map<number, string>();
    for (const r of records)
        if (r.program === BALLISTA_ADDRESS)
            for (const b of r.fields) {
                const event = decodeRunEvent(b);
                if (event)
                    templates.set(r.invocation, event.templateAddress);
            }
    const parents = new Map<number, number | undefined>(), stack: number[] = [];
    let invocation = 0;
    for (const line of receipt.logs)
        if (/^Program \S+ invoke \[\d+\]$/.test(line)) {
            parents.set(invocation, stack.at(-1));
            stack.push(invocation++);
        }
        else if (/^Program \S+ (success|failed:.*)$/.test(line))
            stack.pop();
    const result: TurnEvent[] = [];
    for (const r of records) {
        const p = parents.get(r.invocation), gp = p === undefined ? undefined : parents.get(p);
        if (r.program !== BALLISTA_ADDRESS || templates.get(r.invocation) !== d.addresses.event || p === undefined || templates.get(p) !== d.addresses.commit || gp === undefined || templates.get(gp) !== d.addresses.state)
            continue;
        for (const b of r.fields)
            if (same(b.subarray(0, 4), Uint8Array.of(83, 71, 86, 49)))
                result.push(decodeEvent(b));
    }
    return result;
}
/** One prepare transaction, ten global-tick transactions, then one atomic commit/event transaction. */
export async function buildTurnTransactions(d: ChainDeployment, player: Address | TransactionSigner, expectedWave: bigint, actions: readonly Action[] | bigint, cursor = 0n) {
    const word = typeof actions === 'bigint' ? actions : encodeActions(actions), steps = turnSteps(expectedWave, word);
    const start = steps.findIndex(s => s.cursor === cursor);
    if (start < 0)
        throw new RangeError('Invalid combat cursor');
    const remaining = steps.slice(start);
    const groups: StepInput[][] = [];
    for (const s of remaining) {
        const group = s.cursor < 5n ? 0 : s.cursor >= 95n ? 11 : 1 + Number((s.cursor - 5n) / 9n);
        while (groups.length <= group)
            groups.push([]);
        groups[group].push(s);
    }
    return Promise.all(groups.filter(g => g.length).map(async (group) => [computeBudgetInstruction(), ...await Promise.all(group.map(s => buildStepInstruction(d, player, s)))]));
}
/** The run event's length: `BEV1`, version, rows, invokes reached, executed mask, template. */
export const RUN_EVENT_LENGTH = 47;
/** ASCII `BEV1`, the run event's first four bytes. */
const RUN_EVENT_MAGIC = [0x42, 0x45, 0x56, 0x31];
/**
 * Decodes Ballista's run event from one `Program data:` field: exactly 47 bytes that start with
 * `BEV1`. Returns `undefined` for any other bytes, such as a template's `emit`, whose tag cannot
 * start with `BEV`.
 *
 * It does not know which program logged the bytes, and any program can log these. Take the field
 * from a line `parseProgramData` attributes to Ballista.
 */
export function decodeRunEvent(data: Uint8Array) {
    if (data.length !== RUN_EVENT_LENGTH || !RUN_EVENT_MAGIC.every((byte, index) => data[index] === byte)) {
        return undefined;
    }
    return {
        version: data[4],
        iterations: data[5],
        expanded: data[6],
        executed: new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(7, true),
        templateAddress: getAddressDecoder().decode(data.subarray(15, RUN_EVENT_LENGTH)),
    };
}
const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const END = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success$|failed: )/;
const DATA = 'Program data: ';
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
export function parseProgramData(logs: readonly string[]) {
    const stack: { program: string; invocation: number }[] = [];
    const lines: { program: string; height: number; invocation: number; fields: Uint8Array[] }[] = [];
    let invocations = 0;
    for (const line of logs) {
        if (line.startsWith(DATA)) {
            const open = stack.at(-1);
            if (!open)
                throw new TypeError(`${JSON.stringify(line)} is outside every invocation`);
            const fields = line.slice(DATA.length).split(' ').map(decodeBase64);
            lines.push({ program: open.program, height: stack.length, invocation: open.invocation, fields });
            continue;
        }
        const invoke = INVOKE.exec(line);
        if (invoke) {
            if (Number(invoke[2]) !== stack.length + 1)
                throw new TypeError(`${JSON.stringify(line)} skips a level`);
            stack.push({ program: invoke[1], invocation: invocations });
            invocations += 1;
            continue;
        }
        const end = END.exec(line);
        if (end) {
            if (stack.at(-1)?.program !== end[1]) {
                throw new TypeError(`${JSON.stringify(line)} ends an invocation that is not the innermost open one`);
            }
            stack.pop();
        }
    }
    return lines;
}
function decodeBase64(field: string) {
    let binary;
    try {
        binary = atob(field);
    }
    catch {
        throw new TypeError(`${JSON.stringify(field)} is not base64`);
    }
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function decodeTemplateAccount(data: Uint8Array) {
    if (data.length < 80) throw new RangeError('Template account is truncated');
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data[0] !== 1 || data[1] !== 2 || (data[2] !== 0 && data[2] !== 1) || v.getUint16(38, true) !== 0) throw new TypeError('Invalid template account');
    const state = data[2], payloadLength = v.getUint32(40, true), writtenLength = v.getUint32(44, true);
    if (!payloadLength || payloadLength > 10240 || data.length !== 80 + payloadLength || writtenLength > payloadLength || (state === 1 && writtenLength !== payloadLength)) throw new RangeError('Invalid template payload length');
    return { version: 2, state, bump: data[3], creator: data.slice(4, 36), templateId: v.getUint16(36, true), payloadLength, writtenLength, payloadHash: data.slice(48, 80), payload: data.slice(80) };
}
