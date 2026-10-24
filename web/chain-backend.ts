import { decodeTemplateAccount, TEMPLATE_STATE_FINALIZED } from '@jac0xb/ballista';
import { createKeyPairSignerFromPrivateKeyBytes, type Address, type KeyPairSigner, type TransactionSigner } from '@solana/kit';
import {
  BALLISTA_ADDRESS, TEMPLATE_NAMES, buildPlayInstructions, buildStartInstructions,
  decodeRunState, getEntryAddress, parseWaveEvents, type ChainDeployment,
} from '../src/chain/client.js';
import { SECONDS_PER_DAY } from '../src/rules/constants.js';
import { emptyState, play, start, type RunState, type WaveEvent } from '../src/rules/sim.js';
import type { BackendStatus, GameBackend } from './backend.js';
import { RpcConnection, errorMessage, type ChainConnection, type ChainReceipt } from './chain-rpc.js';
import { hex, json, readManifest, type DeploymentManifest } from './deployment.js';

export interface BurnerStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const BURNER_KEY = 'ballista-defence.local-burner.v1';

export async function loadBurner(storage?: BurnerStorage): Promise<{ player: KeyPairSigner; warning?: string }> {
  let warning: string | undefined;
  try {
    const saved = storage?.getItem(BURNER_KEY);
    if (saved) {
      const bytes: unknown = JSON.parse(saved);
      if (!Array.isArray(bytes) || bytes.length !== 32 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('Invalid burner key');
      return { player: await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(bytes)) };
    }
  } catch {
    warning = 'Saved burner unavailable. Using a new burner.';
  }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const player = await createKeyPairSignerFromPrivateKeyBytes(seed);
  try {
    if (!storage) throw new Error('Storage unavailable');
    storage.setItem(BURNER_KEY, JSON.stringify(Array.from(seed)));
  } catch {
    warning = 'Browser storage unavailable. Burner lasts only until this page closes.';
  }
  return { player, warning };
}

/** Compare every state/event field; bigint values stay exact. */
export function differences(expected: unknown, actual: unknown, path = ''): string[] {
  if (expected === actual) return [];
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const left = expected as Record<string, unknown>, right = actual as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => differences(left[key], right[key], path ? `${path}.${key}` : key));
  }
  return [`${path}: predicted ${json(expected)}, chain ${json(actual)}`];
}

export class ChainBackend implements GameBackend {
  private current = emptyState();
  private predicted: RunState | null = null;
  private started = false;
  private details: BackendStatus = { pending: false, phase: 'Ready' };
  private readonly listeners = new Set<() => void>();
  private entry!: Address;

  private constructor(
    readonly manifest: DeploymentManifest,
    readonly deployment: ChainDeployment,
    readonly player: TransactionSigner,
    private readonly connection: ChainConnection,
  ) {}

  static async create(input: unknown, options: { player?: TransactionSigner; storage?: BurnerStorage; connection?: ChainConnection } = {}): Promise<ChainBackend> {
    const { manifest, deployment } = await readManifest(input);
    const burner: { player: TransactionSigner; warning?: string } = options.player ? { player: options.player } : await loadBurner(options.storage);
    const backend = new ChainBackend(manifest, deployment, burner.player, options.connection ?? new RpcConnection(manifest.rpcUrl));
    backend.details.warning = burner.warning;
    backend.entry = await getEntryAddress(deployment, burner.player.address);
    await backend.checkTemplates();
    const saved = await backend.fetchState();
    if (saved) {
      backend.current = saved;
      backend.started = true;
    }
    return backend;
  }

  state(): RunState { return { ...(this.predicted ?? this.current) }; }
  status(): BackendStatus {
    return { ...this.details, optimisticEvent: this.details.optimisticEvent ? structuredClone(this.details.optimisticEvent) : undefined };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private update(change: Partial<BackendStatus>): void { Object.assign(this.details, change); this.listeners.forEach(listener => listener()); }

  private async checkTemplates(): Promise<void> {
    const program = await this.connection.account(BALLISTA_ADDRESS);
    if (!program?.executable) throw new Error(`Ballista program missing at ${this.manifest.rpcUrl}. Start pnpm localnet, then pnpm deploy:local.`);
    for (const name of TEMPLATE_NAMES) {
      const account = await this.connection.account(this.deployment.addresses[name]);
      if (!account || account.owner !== BALLISTA_ADDRESS) throw new Error(`Missing ${name} template. Run pnpm deploy:local after resetting validator.`);
      const template = decodeTemplateAccount(account.data);
      if (template.state !== TEMPLATE_STATE_FINALIZED || hex(template.payloadHash) !== this.manifest.templateHashes[name] ||
          hex(template.payload) !== hex(this.deployment.compiled[name].bytes)) {
        throw new Error(`Wrong or unfinished ${name} template. Run pnpm deploy:local.`);
      }
    }
  }

  private async fetchState(slot?: bigint): Promise<RunState | null> {
    const account = await this.connection.account(this.entry, slot);
    return account ? decodeRunState({ ...account, template: this.deployment.addresses.state, player: this.player.address }) : null;
  }

  private begin(predicted: RunState, event?: WaveEvent): void {
    if (this.details.pending) throw new Error('A transaction is already pending.');
    this.predicted = predicted;
    this.update({ pending: true, phase: 'Predicted · awaiting chain', optimisticEvent: event, error: undefined, signature: undefined, computeUnits: undefined });
  }

  private async submit(instructions: Parameters<ChainConnection['send']>[0]): Promise<ChainReceipt> {
    this.update({ phase: 'Funding burner' });
    await this.connection.fund(this.player.address);
    this.update({ phase: 'Signing' });
    const receipt = await this.connection.send(instructions, this.player, signature => this.update({ signature, phase: 'Confirming' }));
    this.update({ signature: receipt.signature, computeUnits: receipt.computeUnits, phase: 'Reading confirmed state' });
    if (receipt.err !== null) throw new Error(`Execution failed: ${json(receipt.err)}`);
    const state = await this.fetchState(receipt.slot);
    if (!state) throw new Error('Confirmed transaction has no game entry.');
    this.current = state;
    this.started = true;
    return receipt;
  }

  private mismatch(lines: string[]): void {
    if (lines.length) this.update({ mismatch: `CHAIN / SIM MISMATCH: ${lines.join('; ')}` });
  }

  private async recover(error: unknown): Promise<never> {
    // A send/receipt failure can happen after execution. Re-read before accepting another action.
    try {
      const state = await this.fetchState();
      if (state) { this.current = state; this.started = true; }
      else { this.current = emptyState(); this.started = false; }
    } catch {
      this.started = false;
    }
    this.update({ error: errorMessage(error), phase: 'Failed · restart to retry' });
    throw error;
  }

  private finish(): void {
    this.predicted = null;
    this.update({ pending: false, optimisticEvent: undefined });
  }

  async start(): Promise<void> {
    this.begin(start(this.current, BigInt(Math.floor(Date.now() / 1000))));
    try {
      const before = { ...this.current };
      await this.submit(await buildStartInstructions(this.deployment, this.player));
      // The validator's clock chooses the day, including at UTC midnight.
      this.mismatch(differences(start(before, this.current.day * SECONDS_PER_DAY), this.current, 'state'));
      this.update({ phase: 'Confirmed' });
    } catch (error) { await this.recover(error); }
    finally { this.finish(); }
  }

  async play(pick: bigint, cell: bigint): Promise<WaveEvent> {
    if (!this.started) throw new Error('Start a run before placing a part.');
    if (this.details.mismatch) throw new Error('Chain and simulator differ. Redeploy matching templates and reload.');
    if (this.details.pending) throw new Error('A transaction is already pending.');
    const expected = play(this.current, this.current.wave, pick, cell);
    const wave = this.current.wave;
    this.begin(expected.state, expected.event);
    try {
      const receipt = await this.submit(await buildPlayInstructions(this.deployment, this.player, wave, pick, cell));
      const events = parseWaveEvents({ logs: receipt.logs, err: receipt.err }, this.deployment);
      const stateDifferences = differences(expected.state, this.current, 'state');
      if (events.length !== 1) {
        this.mismatch([...stateDifferences, `expected 1 authenticated wave event, received ${events.length}`]);
        throw new Error('Confirmed transaction did not contain exactly one authenticated WaveEvent.');
      }
      this.mismatch([...stateDifferences, ...differences(expected.event, events[0], 'event')]);
      this.update({ phase: 'Confirmed' });
      return events[0];
    } catch (error) { return await this.recover(error); }
    finally { this.finish(); }
  }
}
