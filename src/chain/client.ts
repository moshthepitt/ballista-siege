import { decodeRunEvent, parseProgramData } from '@jac0xb/ballista';
import {
  BALLISTA_ADDRESS, SYSTEM_PROGRAM_ADDRESS, buildKitRunInstruction,
  buildKitTemplateUploadPlan, findRegistryEntryAddress, getTemplateAddress,
  type KitTemplateUploadPlan,
} from '@jac0xb/ballista/kit';
import { address, getAddressEncoder, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import type { LaneResult, RunState, WaveEvent } from '../rules/sim.js';
import { PACK, STATE_FIELDS, WAVE_TAG, compileTemplates, mask, type HelperAddresses, type TemplateName } from './templates.js';

export const TEMPLATE_NAMES = ['prepare', 'survey', 'fight', 'settle', 'state'] as const;
export const ENTRY_BYTES = 72 + 8 * 8 + 2;
export const WAVE_EVENT_BYTES = 4 + 8 * 8 + 2 + 16;
export const ACTION_COMPUTE_UNITS = 200_000;
export { BALLISTA_ADDRESS };

export interface ChainDeployment {
  creator: Address;
  ids: Record<TemplateName, number>;
  addresses: HelperAddresses & { state: Address };
  compiled: ReturnType<typeof compileTemplates>;
}

/** Address identity includes creator and IDs. Retuning requires unused IDs and a new upload. */
export async function createDeployment(creator: Address, firstTemplateId = 0): Promise<ChainDeployment> {
  const ids = Object.fromEntries(TEMPLATE_NAMES.map((name, i) => [name, firstTemplateId + i])) as ChainDeployment['ids'];
  const entries = await Promise.all(TEMPLATE_NAMES.map(async name => [name, (await getTemplateAddress(creator, ids[name]))[0]] as const));
  const addresses = Object.fromEntries(entries) as unknown as ChainDeployment['addresses'];
  return { creator, ids, addresses, compiled: compileTemplates(addresses) };
}

/** Upload pure helpers before their state owner. Each plan item fits a legacy transaction. */
export async function buildUploadPlan(deployment: ChainDeployment): Promise<KitTemplateUploadPlan[]> {
  return Promise.all(TEMPLATE_NAMES.map(name => buildKitTemplateUploadPlan({
    compiled: deployment.compiled[name], creator: deployment.creator, templateId: deployment.ids[name],
    maxInstructionDataBytes: 900,
  })));
}

export async function getEntryAddress(deployment: ChainDeployment, player: Address): Promise<Address> {
  return (await findRegistryEntryAddress(deployment.addresses.state, 0, player))[0];
}

function computeBudgetInstruction(): Instruction {
  const bytes = new Uint8Array(5);
  bytes[0] = 2; // ComputeBudgetInstruction::SetComputeUnitLimit
  new DataView(bytes.buffer).setUint32(1, ACTION_COMPUTE_UNITS, true);
  return { programAddress: address('ComputeBudget111111111111111111111111111111'), data: bytes };
}

async function buildActionInstructions(
  deployment: ChainDeployment, player: Address | TransactionSigner,
  values: { mode: bigint; expectedWave: bigint; pick: bigint; cell: bigint },
): Promise<Instruction[]> {
  const playerAddress = typeof player === 'string' ? player : player.address;
  const state = await getEntryAddress(deployment, playerAddress);
  const instruction = buildKitRunInstruction({
    compiled: deployment.compiled.state, templateAddress: deployment.addresses.state, inputs: values,
    accounts: {
      player: { address: playerAddress, ...(typeof player === 'string' ? {} : { signer: player }) },
      state: { address: state }, systemProgram: { address: SYSTEM_PROGRAM_ADDRESS },
      ballista: { address: BALLISTA_ADDRESS },
      ...Object.fromEntries(TEMPLATE_NAMES.filter(name => name !== 'state').map(name => [name, { address: deployment.addresses[name] }])),
    },
  });
  return [computeBudgetInstruction(), instruction];
}

export function buildStartInstructions(deployment: ChainDeployment, player: Address | TransactionSigner) {
  return buildActionInstructions(deployment, player, { mode: 0n, expectedWave: 0n, pick: 0n, cell: 0n });
}

export function buildPlayInstructions(
  deployment: ChainDeployment, player: Address | TransactionSigner,
  expectedWave: bigint, pick: bigint, cell: bigint,
) {
  return buildActionInstructions(deployment, player, { mode: 1n, expectedWave, pick, cell });
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Validate account type and player/template identity before decoding packed registry fields. */
export function decodeRunState(entry: {
  data: Uint8Array; owner: Address; template: Address; player: Address;
}): RunState {
  const { data: bytes } = entry;
  const encodeAddress = (key: Address) => Uint8Array.from(getAddressEncoder().encode(key));
  if (entry.owner !== BALLISTA_ADDRESS || bytes.length !== ENTRY_BYTES ||
      !equalBytes(bytes.subarray(0, 8), Uint8Array.of(66, 82, 69, 71, 1, 0, 0, 0)) ||
      !equalBytes(bytes.subarray(8, 40), encodeAddress(entry.template)) ||
      !equalBytes(bytes.subarray(40, 72), encodeAddress(entry.player))) {
    throw new TypeError('Invalid game registry entry');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Record<string, bigint | boolean> = {};
  let offset = 72;
  for (const [field, type] of Object.entries(STATE_FIELDS)) {
    if (type === 'bool') {
      if (bytes[offset] > 1) throw new TypeError('Invalid registry bool');
      result[field] = bytes[offset++] === 1;
    } else {
      result[field] = view.getBigUint64(offset, true);
      offset += 8;
    }
  }
  return result as unknown as RunState;
}

export function decodeWaveEvent(bytes: Uint8Array): WaveEvent {
  if (bytes.length !== WAVE_EVENT_BYTES || !equalBytes(bytes.subarray(0, 4), WAVE_TAG)) throw new TypeError('Invalid wave event');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 4;
  const read = () => { const value = view.getBigUint64(offset, true); offset += 8; return value; };
  const w = read(), pick = read(), cell = read(), part = read();
  const walls = read(), gold = read(), goldGain = read(), score = read();
  if (bytes[offset] > 1 || bytes[offset + 1] > 1) throw new TypeError('Invalid event bool');
  const done = bytes[offset++] === 1, won = bytes[offset++] === 1;
  let packed = view.getBigUint64(offset, true) | (view.getBigUint64(offset + 8, true) << 64n);
  const lanes: LaneResult[] = [];
  for (let lane = 0; lane < 4; lane++) {
    const take = (width: bigint) => { const value = packed & mask(width); packed >>= width; return value; };
    lanes.push({ swarm: take(PACK.swarm), brute: take(PACK.brute), sk: take(PACK.swarm), bk: take(PACK.brute), hit: take(PACK.hit) });
  }
  if (packed !== 0n) throw new TypeError('Invalid event padding');
  return { w, pick, cell, part, walls, gold, goldGain, score, done, won, lanes };
}

/** Trust only successful settlement logs nested directly under the expected state owner. */
export function parseWaveEvents(
  receipt: { logs: readonly string[]; err: unknown }, deployment: ChainDeployment,
): WaveEvent[] {
  if (receipt.err !== null) return [];
  const records = parseProgramData(receipt.logs);
  const templates = new Map<number, string>();
  for (const record of records) {
    if (record.program !== BALLISTA_ADDRESS) continue;
    for (const bytes of record.fields) {
      const event = decodeRunEvent(bytes);
      if (event) templates.set(record.invocation, event.templateAddress);
    }
  }
  const parents = new Map<number, number | undefined>();
  const stack: number[] = [];
  let invocation = 0;
  for (const line of receipt.logs) {
    if (/^Program \S+ invoke \[\d+\]$/.test(line)) {
      parents.set(invocation, stack.at(-1)); stack.push(invocation++);
    } else if (/^Program \S+ (success|failed:.*)$/.test(line)) stack.pop();
  }
  const result: WaveEvent[] = [];
  for (const record of records) {
    const parent = parents.get(record.invocation);
    if (record.program !== BALLISTA_ADDRESS || templates.get(record.invocation) !== deployment.addresses.settle ||
        parent === undefined || templates.get(parent) !== deployment.addresses.state) continue;
    for (const bytes of record.fields) {
      if (equalBytes(bytes.subarray(0, 4), WAVE_TAG)) result.push(decodeWaveEvent(bytes));
    }
  }
  return result;
}
