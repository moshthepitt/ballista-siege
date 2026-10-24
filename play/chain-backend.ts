import { createKeyPairSignerFromPrivateKeyBytes, type Address, type TransactionSigner } from '@solana/kit';
import {
  BALLISTA_ADDRESS, buildStartInstructions, buildTurnTransactions, decodeSessionState,
  getEntryAddresses, parseTurnEvents, type ChainDeployment,
} from '../src/chain-v1/wire.js';
import { TEMPLATE_NAMES } from '../src/chain-v1/run-layout.js';
import { newRun, playTurn, previewLanes, shop, validateState, encodeActions, type Action, type Mode, type RunState, type TurnEvent } from '../src/v1/sim.js';
import type { BackendStatus, GameBackend } from './backend.js';
import { RpcConnection, SettledTransactionError, errorMessage, type ChainConnection, type ChainReceipt, type Submission } from './chain-rpc.js';
import { checkTemplate, decodeLookup, json, readManifest, type DeploymentManifest } from './deployment.js';

export interface BurnerStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
import { PROGRAM_NOTICE } from './deployments/program.js';
import { BURNER_KEY, TURN_FEES, FIRST_RUN_RENT } from './network-state.js';
export { BURNER_KEY };
export function browserStorage(): BurnerStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
export async function loadBurner(storage?: BurnerStorage): Promise<{ player: TransactionSigner; seed: Uint8Array; warning?: string }> {
  let warning: string | undefined;
  try {
    const saved = storage?.getItem(BURNER_KEY);
    if (saved) {
      const bytes: unknown = JSON.parse(saved);
      if (!Array.isArray(bytes) || bytes.length !== 32 || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error('Invalid burner seed');
      return { player: await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(bytes)), seed: Uint8Array.from(bytes) };
    }
  } catch { warning = 'Saved burner unavailable. Using a new burner.'; }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const player = await createKeyPairSignerFromPrivateKeyBytes(seed);
  try {
    if (!storage) throw new Error('Storage unavailable');
    storage.setItem(BURNER_KEY, JSON.stringify(Array.from(seed)));
  } catch { warning = 'Storage unavailable. Keep this tab open until chain confirmation.'; }
  return { player, seed, warning };
}
export function differences(expected: unknown, actual: unknown, path = ''): string[] {
  if (expected === actual) return [];
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const left = expected as Record<string, unknown>, right = actual as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(k => differences(left[k], right[k], path ? `${path}.${k}` : k));
  }
  return [`${path}: sim ${json(expected)}, chain ${json(actual)}`];
}
interface Journal {
  kind: 'start' | 'turn';
  before: RunState;
  actions: Action[];
  index: number;
  submission?: Submission;
  receipt?: ChainReceipt;
}
const storeJson = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? { $bigint: String(x) } : x);
const readJson = (v: string): unknown => JSON.parse(v, (_, x) => x && typeof x === 'object' && Object.keys(x).length === 1 && typeof x.$bigint === 'string' ? BigInt(x.$bigint) : x);
const completedAt = (cursor: bigint) => cursor === 0n ? 0 : cursor < 5n ? 0 : cursor >= 95n ? 11 : 1 + Number((cursor - 5n) / 9n);

export class ChainBackend implements GameBackend {
  private current: RunState = newRun(0n, 'practice');
  private started = false;
  private journal?: Journal;
  private active?: Promise<void>;
  private details: BackendStatus = { pending: false, phase: 'Ready', completed: 0 };
  private readonly listeners = new Set<() => void>();
  private entries!: { run: Address; work: Address };
  private storageKey = '';
  readonly receipts: ChainReceipt[] = [];
  lastEvent?: TurnEvent;

  private constructor(
    readonly manifest: DeploymentManifest,
    readonly deployment: ChainDeployment,
    readonly player: TransactionSigner,
    private connection: ChainConnection,
    private readonly storage?: BurnerStorage,
    private readonly canSign: () => boolean = () => true,
  ) {}

  static async create(input: unknown, options: { player?: TransactionSigner; storage?: BurnerStorage; connection?: ChainConnection; canSign?: () => boolean } = {}): Promise<ChainBackend> {
    const { manifest, deployment } = await readManifest(input);
    const burner = options.player ? { player: options.player } : await loadBurner(options.storage);
    const backend = new ChainBackend(manifest, deployment, burner.player, options.connection ?? new RpcConnection(manifest.rpcUrl), options.storage, options.canSign);
    backend.details.warning = 'warning' in burner ? burner.warning : undefined;
    backend.entries = await getEntryAddresses(deployment, burner.player.address);
    backend.storageKey = `ballista-siege.v1.pending.${deployment.addresses.state}.${burner.player.address}`;
    const keys = [BALLISTA_ADDRESS, ...TEMPLATE_NAMES.map(n => deployment.addresses[n]), manifest.lookup.address];
    const accounts = await backend.connection.accounts(keys);
    if (!accounts[0]?.executable) throw new Error(`Ballista is unavailable at ${manifest.rpcUrl}. Run pnpm localnet.`);
    await Promise.all(TEMPLATE_NAMES.map((name, i) => checkTemplate(accounts[i + 1], deployment, name, manifest.templateHashes)));
    const tableAccount = accounts.at(-1);
    if (!tableAccount) throw new Error('Missing lookup table. Run pnpm deploy:v1.');
    const table = decodeLookup(tableAccount);
    if (!table.frozen || json(table.addresses) !== json(manifest.lookup.addresses)) throw new Error('Lookup table differs or is not frozen.');
    let saved: string | null = null;
    try { saved = options.storage?.getItem(backend.storageKey) ?? null; }
    catch { backend.details.warning = 'Storage unavailable. Keep this tab open until chain confirmation.'; }
    if (saved && saved !== 'null') {
      const j = readJson(saved) as Journal;
      if (!j || !['start', 'turn'].includes(j.kind) || !Array.isArray(j.actions) || !Number.isInteger(j.index) || j.index < 0 || j.index > 12) throw new Error('Invalid saved chain operation. Preserve browser storage for recovery.');
      validateState(j.before); encodeActions(j.actions);
      backend.journal = j;
      backend.current = j.kind === 'turn' ? playTurn(j.before, j.actions).state : j.before;
      backend.details = { ...backend.details, pending: true, phase: j.kind === 'start' ? 'Starting run' : 'On-chain', completed: Math.max(0, j.index - Number(!!j.submission)), signature: j.submission?.signature ?? j.receipt?.signature, error: 'Interrupted chain operation. Retry to check its signature and resume.' };
    } else {
      const session = await backend.fetchSession();
      if (session) {
        backend.current = session.state; backend.started = true;
        if (session.pending) backend.details = { ...backend.details, pending: true, phase: 'Recovery needed', error: 'Unfinished turn has no saved actions. Recover the original browser session.', completed: completedAt(session.cursor) };
      }
    }
    return backend;
  }
  useConnection(connection: ChainConnection, rpcUrl: string): void {
    if (this.active) throw new Error('Wait for the active transaction before changing RPC.');
    this.connection = connection; this.manifest.rpcUrl = rpcUrl;
  }
  get state(): RunState { return { ...this.current }; }
  get hasRun(): boolean { return this.started || !!this.journal; }
  status(): BackendStatus { return { ...this.details }; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  shop(state = this.current) { return shop(state); }
  preview(state = this.current) { return previewLanes(state); }
  private changed(): void { for (const listener of this.listeners) listener(); }
  private save(): void {
    try { this.storage?.setItem(this.storageKey, storeJson(this.journal ?? null)); }
    catch { this.details.warning = 'Storage unavailable. Keep this tab open until chain confirmation.'; }
  }
  private async fetchSession(minSlot?: bigint) {
    const [run, work] = await this.connection.accounts([this.entries.run, this.entries.work], minSlot);
    if (!run && !work) return null;
    if (!run || !work) throw new Error('Incomplete Siege registry entries.');
    const identity = { template: this.deployment.addresses.state, player: this.player.address };
    return decodeSessionState({ ...run, ...identity }, { ...work, ...identity });
  }
  async start(seed: bigint, mode: Mode): Promise<void> {
    if (this.active || this.details.pending || this.details.mismatch) throw new Error('Finish or retry the pending chain operation before starting another run.');
    const state = newRun(seed, mode);
    this.journal = { kind: 'start', before: state, actions: [], index: 0 };
    this.current = state;
    this.details = { warning: this.details.warning, pending: true, phase: 'Starting run', completed: 0 };
    this.save(); this.changed();
    await this.launch();
  }
  async playTurn(actions: readonly Action[]) {
    if (!this.started || this.active || this.details.pending || this.details.error || this.details.mismatch) throw new Error('Wait for chain confirmation or retry the pending turn.');
    const before = this.state, orders = actions.map(a => ({ ...a })), result = playTurn(before, orders);
    this.journal = { kind: 'turn', before, actions: orders, index: 0 };
    this.current = result.state;
    this.lastEvent = undefined;
    this.details = { warning: this.details.warning, pending: true, phase: 'On-chain', completed: 0 };
    this.save(); this.changed();
    void this.launch();
    return result;
  }
  /** Wait without starting work; useful to the Node runner and tests. */
  async waitForConfirmation(): Promise<void> {
    await this.active;
    if (this.details.error || this.details.mismatch || this.details.pending) throw new Error(this.details.error ?? this.details.mismatch?.join('\n') ?? 'Chain operation still pending.');
  }
  async retry(): Promise<void> {
    if (!this.journal || this.details.mismatch) return;
    await this.launch();
  }
  private launch(): Promise<void> {
    if (this.active) return this.active;
    this.details.error = undefined; this.changed();
    // Web Locks serialize tabs sharing this burner. The storage check rejects a stale tab.
    const run = async () => {
      if (this.storage) {
        let saved: string | null | undefined;
        try { saved = this.storage.getItem(this.storageKey); } catch { /* Already warned by save. */ }
        if (saved && saved !== storeJson(this.journal ?? null)) throw new Error('Another tab changed this chain session. Reload before continuing.');
      }
      await this.execute();
    };
    const locks = globalThis.navigator?.locks;
    this.active = Promise.resolve().then(async () => { if (locks) await locks.request(this.storageKey, run); else await run(); }).catch(error => {
      if (error instanceof SettledTransactionError && this.journal) { this.journal.submission = undefined; this.save(); }
      this.details.error = errorMessage(error); this.changed();
    }).finally(() => { this.active = undefined; });
    return this.active;
  }
  private accept(receipt: ChainReceipt): void {
    const j = this.journal!;
    j.receipt = receipt; j.submission = undefined;
    this.receipts.push(receipt);
    this.details.signature = receipt.signature; this.details.computeUnits = receipt.computeUnits;
    this.details.completed = j.index;
    this.save(); this.changed();
  }
  private async send(instructions: Parameters<ChainConnection['send']>[0], index: number): Promise<void> {
    if (!this.canSign()) throw new Error(PROGRAM_NOTICE);
    const j = this.journal!, previousIndex = j.index;
    j.index = index;
    try {
      const receipt = await this.connection.send(instructions, this.player, tx => {
        j.submission = tx; this.details.signature = tx.signature; this.save(); this.changed();
      }, this.manifest.lookup);
      this.accept(receipt);
    } catch (error) {
      // No signature was created: keep memory equal to the persisted journal for retry.
      if (!j.submission) j.index = previousIndex;
      throw error;
    }
  }
  private async execute(): Promise<void> {
    const j = this.journal!;
    if (j.submission) this.accept(await this.connection.confirm(j.submission));
    const session = await this.fetchSession(j.receipt?.slot);
    if (j.kind === 'start') {
      if (!j.receipt) {
        if (session?.pending) throw new Error('Cannot replace an unfinished combat session.');
        await this.connection.fund(this.player.address, (session ? 0n : FIRST_RUN_RENT) + TURN_FEES);
        await this.send(await buildStartInstructions(this.deployment, this.player, j.before.seed, j.before.mode, session?.cursor ?? 0n), 0);
      }
      const after = await this.fetchSession(j.receipt!.slot);
      if (!after || after.pending) throw new Error('Run creation did not complete.');
      const mismatch = differences(j.before, after.state, 'state');
      this.finish(after.state, mismatch); this.started = true;
      return;
    }
    if (!session) throw new Error('Run entries disappeared. Was the validator reset?');
    const expected = playTurn(j.before, j.actions);
    if (session.state.wave === j.before.wave) {
      const mismatch = differences(j.before, session.state, 'before');
      if (mismatch.length) { this.finish(session.state, mismatch); return; }
      this.details.completed = completedAt(session.cursor); this.changed();
      await this.connection.fund(this.player.address, TURN_FEES);
      const groups = await buildTurnTransactions(this.deployment, this.player, j.before.wave, j.actions, session.cursor);
      const offset = 12 - groups.length;
      for (const [i, instructions] of groups.entries()) await this.send(instructions, offset + i + 1);
    } else if (session.pending || session.state.wave !== expected.state.wave || j.index !== 12 || !j.receipt) {
      throw new Error('Chain wave changed outside this session. Reload and inspect the saved signature.');
    }
    const after = await this.fetchSession(j.receipt!.slot);
    if (!after || after.pending) throw new Error('Turn commit did not complete. Retry reads the cursor.');
    const events = parseTurnEvents(j.receipt!, this.deployment);
    const mismatch = [...differences(expected.state, after.state, 'state'), ...differences([expected.event], events, 'events')];
    this.lastEvent = events.length === 1 ? events[0] : undefined;
    this.finish(after.state, mismatch);
  }
  private finish(state: RunState, mismatch: string[]): void {
    this.current = state;
    this.started = true;
    this.details = { ...this.details, pending: false, phase: mismatch.length ? 'Chain mismatch' : 'Confirmed', error: undefined, mismatch: mismatch.length ? mismatch : undefined };
    this.journal = undefined; this.save(); this.changed();
  }
}
