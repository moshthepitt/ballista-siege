import { decodeRunEvent, parseProgramData } from '@jac0xb/ballista';
import { BALLISTA_ADDRESS, SYSTEM_PROGRAM_ADDRESS, buildKitRunInstruction, buildKitTemplateUploadPlan, findRegistryEntryAddress, getTemplateAddress } from '@jac0xb/ballista/kit';
import { AccountRole, address, getAddressEncoder, getProgramDerivedAddress, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import { decodeEvent, encodeActions, unpackState, type Action, type Mode, type RunState, type TurnEvent } from '../v1/sim.js';
import { TEMPLATE_NAMES, compileTemplates, type Addresses, type TemplateName } from './templates.js';
// Share the contract codec: opcode 5 and metadata bits 34..49 stay canonical.
export { BALLISTA_ADDRESS, encodeActions };
export type { Action };
export const ENTRY_BYTES = 120, WORK_BYTES = 264, COMPUTE_UNITS = 1350000;
export interface ChainDeployment {
    creator: Address;
    ids: Record<TemplateName, number>;
    addresses: Addresses;
    compiled: ReturnType<typeof compileTemplates>;
}
export async function createDeployment(creator: Address, firstTemplateId = 11000): Promise<ChainDeployment> {
    const ids = Object.fromEntries(TEMPLATE_NAMES.map((n, i) => [n, firstTemplateId + i])) as ChainDeployment['ids'];
    const addresses = Object.fromEntries(await Promise.all(TEMPLATE_NAMES.map(async (n) => [n, (await getTemplateAddress(creator, ids[n]))[0]]))) as Addresses;
    return { creator, ids, addresses, compiled: compileTemplates(addresses) };
}
export function buildUploadPlan(d: ChainDeployment) {
    return Promise.all(TEMPLATE_NAMES.map(n => buildKitTemplateUploadPlan({ compiled: d.compiled[n], creator: d.creator, templateId: d.ids[n], maxInstructionDataBytes: 900 })));
}
export async function getEntryAddresses(d: ChainDeployment, player: Address) {
    const [run, work] = await Promise.all([0, 1].map(async (i) => (await findRegistryEntryAddress(d.addresses.state, i, player))[0]));
    return { run, work };
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
export async function buildStepInstruction(d: ChainDeployment, player: Address | TransactionSigner, values: StepInput) {
    const playerAddress = typeof player === 'string' ? player : player.address, entries = await getEntryAddresses(d, playerAddress);
    return buildKitRunInstruction({ compiled: d.compiled.state, templateAddress: d.addresses.state, inputs: { ...values }, accounts: {
            player: { address: playerAddress, ...(typeof player === 'string' ? {} : { signer: player }) }, run: { address: entries.run }, work: { address: entries.work }, systemProgram: { address: SYSTEM_PROGRAM_ADDRESS }, ballista: { address: BALLISTA_ADDRESS },
            ...Object.fromEntries(TEMPLATE_NAMES.filter(n => n !== 'state').map(n => [n, { address: d.addresses[n] }])),
        } });
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
const ALT = address('AddressLookupTab1e1111111111111111111111111');
export interface LookupTable {
    address: Address;
    addresses: Address[];
}
/** Native ALT create/extend/freeze instructions; send each separately, then wait one slot. */
export async function buildLookupTablePlan(d: ChainDeployment, authority: Address, recentSlot: bigint) {
    const encode = getAddressEncoder(), slot = new Uint8Array(8);
    new DataView(slot.buffer).setBigUint64(0, recentSlot, true);
    const [table, bump] = await getProgramDerivedAddress({ programAddress: ALT, seeds: [encode.encode(authority), slot] });
    const addresses = [...TEMPLATE_NAMES.map(n => d.addresses[n]), BALLISTA_ADDRESS, SYSTEM_PROGRAM_ADDRESS];
    const metas = [{ address: table, role: AccountRole.WRITABLE }, { address: authority, role: AccountRole.READONLY_SIGNER }, { address: authority, role: AccountRole.WRITABLE_SIGNER }, { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY }];
    const create = new Uint8Array(13);
    new DataView(create.buffer).setBigUint64(4, recentSlot, true);
    create[12] = bump;
    const instructions: Instruction[] = [{ programAddress: ALT, accounts: metas, data: create }];
    for (let i = 0; i < addresses.length; i += 20) {
        const batch = addresses.slice(i, i + 20), bytes = new Uint8Array(12 + 32 * batch.length), view = new DataView(bytes.buffer);
        view.setUint32(0, 2, true);
        view.setBigUint64(4, BigInt(batch.length), true);
        batch.forEach((key, j) => bytes.set(encode.encode(key), 12 + j * 32));
        instructions.push({ programAddress: ALT, accounts: metas, data: bytes });
    }
    const freeze = new Uint8Array(4);
    new DataView(freeze.buffer).setUint32(0, 1, true);
    instructions.push({ programAddress: ALT, accounts: metas.slice(0, 2), data: freeze });
    return { lookup: { address: table, addresses }, instructions };
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
