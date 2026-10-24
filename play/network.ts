import { address, getBase64Encoder, lamports } from '@solana/kit';
import bundledManifest from 'virtual:deployment';
import { ChainBackend, browserStorage, loadBurner } from './chain-backend.js';
import { LocalBackend, type GameBackend } from './backend.js';
import { RpcConnection, errorMessage } from './chain-rpc.js';
import { isLocalRpc } from './deployment.js';
import { validateEndpoint } from './rpc-policy.js';
import { checkProgram, PROGRAM_NOTICE } from './deployments/program.js';
import { BURNER_KEY, RPC_KEY, DEFAULT_RPC, DEVNET_GENESIS, TURN_FEES, offlineReason, runsLeft, stored } from './network-state.js';
import { discoverWallets, exportBurner, restoreBurner, sendFromWallet } from './wallet.js';
import { escape, toast } from './ui/dom.js';
import { openSheet, openSheetName, updateSheet } from './ui/sheets.js';

let burner: Awaited<ReturnType<typeof loadBurner>> | undefined;
let chain: ChainBackend | undefined, connection: RpcConnection;
let balance = 0n, hasEntries = false, program = false, templates = false, checking = false, rpcValid = false;
let reason = 'Checking devnet…', programLine = 'Not checked', message = '', busy = false, initialized: Promise<void> | undefined;
let rpcUrl = stored(RPC_KEY) ?? (import.meta.env.DEV && bundledManifest && isLocalRpc((bundledManifest as { rpcUrl: string }).rpcUrl) ? (bundledManifest as { rpcUrl: string }).rpcUrl : DEFAULT_RPC);
let unsubscribe: (() => void) | undefined;
let observedPending = false;
let walletDiscovery: ReturnType<typeof discoverWallets> | undefined;
const options = () => ({ abortSignal: AbortSignal.timeout(10_000) });
const sol = () => (Number(balance) / 1e9).toFixed(3);
function changed(): void {
  window.dispatchEvent(new CustomEvent('ballista:network', { detail: { label: !reason ? `Devnet · ${sol()} SOL` : 'Offline', reason, notice: programLine === PROGRAM_NOTICE ? PROGRAM_NOTICE : undefined } }));
  if (openSheetName() === 'fund') {
    const expanded = [...document.querySelectorAll('#sheet details')].map(d => d.hasAttribute('open'));
    updateSheet(panel());
    document.querySelectorAll('#sheet details').forEach((d, i) => { if (expanded[i]) d.setAttribute('open', ''); });
  }
}
export function initialize(): Promise<void> {
  return initialized ??= refresh().finally(() => { initialized = undefined; });
}
async function refresh(): Promise<void> {
  checking = true; reason = 'Checking devnet…'; changed();
  try {
    burner ??= await loadBurner(browserStorage());
    connection = new RpcConnection(rpcUrl, 60_000, () => program && templates);
    rpcValid = false;
    const hash = await connection.rpc.getGenesisHash().send(options());
    if (hash !== DEVNET_GENESIS && (import.meta.env.PROD || !isLocalRpc(rpcUrl))) throw new Error('RPC is not Solana devnet. Playing offline.');
    rpcValid = true;
    program = !import.meta.env.PROD && isLocalRpc(rpcUrl)
      ? !!(await connection.account(address('BLSTAmUBA29tcRUvoq5DBYxRhGptrnWPtfQW65RszRWR')))?.executable
      : await checkProgram(async (key, length) => {
        const { value } = await connection.rpc.getAccountInfo(address(key), { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length } }).send(options());
        return value ? { owner: value.owner, executable: value.executable, data: new Uint8Array(getBase64Encoder().encode(value.data[0])) } : null;
      });
    programLine = program ? 'Ballista matches the tested build.' : PROGRAM_NOTICE;
    templates = false;
    if (program && bundledManifest) {
      try {
        // A pending journal keeps its existing connection and signature recovery.
        if (!chain) {
          chain = await ChainBackend.create({ ...(bundledManifest as object), rpcUrl }, { player: burner.player, storage: browserStorage(), connection, canSign: () => program && templates });
          unsubscribe?.();
          unsubscribe = chain.subscribe(() => {
            const pending = !!chain?.status().pending;
            if (observedPending && !pending) {
              hasEntries = true;
              // One balance read after confirmation; no faucet polling or retries.
              void connection.rpc.getBalance(burner!.player.address, { commitment: 'confirmed' }).send(options()).then(result => {
                balance = result.value; reason = offlineReason({ loaded: true, program, templates, manifest: !!bundledManifest, balance, hasEntries }) ?? ''; changed();
              }).catch(() => { reason = 'RPC unavailable. Playing offline.'; changed(); });
            }
            observedPending = pending;
          });
        }
        templates = true; hasEntries = chain!.hasRun;
      } catch { reason = 'Templates unavailable. Playing offline.'; }
    }
    balance = (await connection.rpc.getBalance(burner.player.address, { commitment: 'confirmed' }).send(options())).value;
    reason = offlineReason({ loaded: true, program, templates, manifest: !!bundledManifest, balance, hasEntries }) ?? '';
  } catch (error) {
    program = false; programLine = PROGRAM_NOTICE;
    reason = error instanceof Error && error.message.includes('not Solana devnet') ? error.message : PROGRAM_NOTICE;
  } finally { checking = false; changed(); }
}
export async function selectRun(seed: bigint): Promise<{ backend: GameBackend; notice?: string }> {
  // No network wait on the play path. Refresh is explicit or happens after a confirmed turn.
  reason = offlineReason({ loaded: true, program, checking, templates, manifest: !!bundledManifest, balance, hasEntries }) ?? '';
  if (!reason && chain?.status().pending) reason = 'Resume the pending devnet turn in Fund. Playing offline.';
  if (!reason && chain?.status().mismatch?.length) reason = 'Chain and sim differ. Playing offline.';
  changed();
  if (reason || !chain) return { backend: new LocalBackend(seed, 'practice'), notice: reason };
  return { backend: chain };
}
export async function retry(backend: GameBackend): Promise<void> {
  if (initialized) await initialized;
  if (!program || !templates) throw new Error(PROGRAM_NOTICE);
  await backend.retry?.();
}
function panel(): string {
  const key = burner?.player.address ?? '';
  const disabled = busy || checking ? 'disabled' : '';
  return `<div class="fund-panel"><p class="sub fund-notice" role="status">${escape(reason || 'Funded for devnet. Start a new run to use it.')}</p>
    ${!bundledManifest ? '<p class="sub">This build is offline-only until its devnet templates are deployed.</p>' : ''}
    <section class="fund-section"><h3>Burner</h3><p class="sub">Devnet only. Whoever holds this key controls the burner.</p>
    <label for="burner-address">Address</label><input id="burner-address" readonly value="${escape(key)}" aria-label="Burner address">
    <div class="fund-row"><button class="btn btn-2" data-fund="copy" ${!key ? 'disabled' : ''}>Copy address</button><span class="fund-balance tnum">${sol()} SOL</span><button class="btn btn-quiet" data-fund="refresh" ${disabled}>Refresh</button></div>
    <p class="sub">About ${runsLeft(balance, hasEntries)} runs left. First run: ~0.0033 SOL rent for two entries, once per burner. Each turn: 12 transactions, ~0.00006 SOL. A full run after the first costs under 0.001 SOL.</p></section>
    <section class="fund-section"><h3>Add devnet SOL</h3><div class="fund-row"><button class="btn btn-2" data-fund="airdrop" ${disabled}>Request airdrop · 0.1 SOL</button><a class="btn btn-quiet" href="https://faucet.solana.com" target="_blank" rel="noopener" data-fund="faucet">Open Solana faucet ↗</a></div>
    <p class="sub">The public faucet is limited per IP. The faucet link copies your address first.</p>
    <div class="fund-row"><select id="fund-wallet" aria-label="Wallet">${[...(walletDiscovery?.wallets ?? [])].map((wallet, i) => `<option value="${i}">${escape(wallet.name)}</option>`).join('') || '<option>No devnet wallet found</option>'}</select><button class="btn btn-2" data-fund="wallet" ${disabled || (!walletDiscovery?.wallets.size ? 'disabled' : '')}>Send from wallet · 0.02 SOL</button></div></section>
    <details class="fund-section"><summary>Back up or restore burner key</summary><div class="fund-row"><button class="btn btn-2" data-fund="export" ${!key ? 'disabled' : ''}>Copy key</button><button class="btn btn-quiet" data-fund="download" ${!key ? 'disabled' : ''}>Download key</button></div><label for="restore-key">Solana CLI key · 64-byte JSON array</label><textarea id="restore-key" rows="3" spellcheck="false"></textarea><button class="btn btn-2" data-fund="restore" ${disabled}>Restore key</button></details>
    <details class="fund-section"><summary>RPC endpoint</summary><label for="rpc-endpoint">Devnet RPC</label><input id="rpc-endpoint" type="url" value="${escape(rpcUrl)}" spellcheck="false"><div class="fund-row"><button class="btn btn-2" data-fund="rpc-save" ${disabled}>Save</button><button class="btn btn-quiet" data-fund="rpc-reset" ${disabled}>Reset</button></div><p class="sub">HTTPS, or HTTP on localhost. Production accepts devnet only.</p></details>
    <p class="sub program-result">${escape(programLine)}</p>${burner?.warning ? `<p class="sub">${escape(burner.warning)}</p>` : ''}${chain?.status().pending && program && templates ? '<button class="btn btn-2" data-fund="recover">Resume pending devnet turn</button>' : ''}<p class="sub fund-message" role="status">${escape(message)}</p></div>`;
}
export async function openFund(): Promise<void> {
  if (openSheetName() === 'fund') updateSheet(panel()); else openSheet('fund', 'Fund · devnet', panel());
  walletDiscovery ??= discoverWallets(() => { if (openSheetName() === 'fund') updateSheet(panel()); });
  await initialize();
}
async function action(name: string): Promise<void> {
  if (!burner || busy || checking) return;
  const key = burner.player.address;
  if (['airdrop', 'wallet'].includes(name) && !rpcValid) { message = 'Choose a working devnet RPC before funding.'; changed(); return; }
  if (name === 'faucet' || name === 'copy') { await navigator.clipboard.writeText(key); message = 'Address copied.'; changed(); return; }
  const restoreText = document.querySelector<HTMLTextAreaElement>('#restore-key')?.value ?? '';
  const endpointText = document.querySelector<HTMLInputElement>('#rpc-endpoint')?.value ?? '';
  const walletIndex = Number(document.querySelector<HTMLSelectElement>('#fund-wallet')?.value ?? 0);
  busy = true; message = ''; changed();
  try {
    if (name === 'refresh') await initialize();
    if (name === 'airdrop') {
      try { await connection.rpc.requestAirdrop(key, lamports(100_000_000n), { commitment: 'confirmed' }).send(options()); message = 'Airdrop requested. Refresh after it confirms.'; }
      catch { message = 'Faucet busy. Open Solana faucet or send from wallet below.'; }
    }
    if (name === 'wallet') {
      const wallet = [...(walletDiscovery?.wallets ?? [])][walletIndex];
      if (!wallet) throw new Error('Install a Wallet Standard devnet wallet, then reopen Fund.');
      await sendFromWallet(wallet, key, connection); message = 'Transfer sent. Refresh after it confirms.';
    }
    if (name === 'export') { await navigator.clipboard.writeText(await exportBurner(burner.seed)); message = 'Burner key copied. Keep it private.'; }
    if (name === 'download') {
      const url = URL.createObjectURL(new Blob([await exportBurner(burner.seed)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `ballista-devnet-${key}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    if (name === 'restore') {
      if (chain?.status().pending) throw new Error('Resume the pending turn before restoring another burner.');
      const seed = await restoreBurner(restoreText);
      const storage = browserStorage(); if (!storage) throw new Error('Browser storage is unavailable. Key was not replaced.');
      storage.setItem(BURNER_KEY, JSON.stringify([...seed])); burner = undefined; chain = undefined;
      window.dispatchEvent(new Event('ballista:burner-restored'));
      await initialize(); message = 'Burner restored. Current run stays offline; new runs use this burner.';
    }
    if (name === 'rpc-save' || name === 'rpc-reset') {
      const next = await validateEndpoint(name === 'rpc-reset' ? DEFAULT_RPC : endpointText, url => new RpcConnection(url).rpc.getGenesisHash().send(options()), import.meta.env.PROD);
      chain?.useConnection(new RpcConnection(next, 60_000, () => program && templates), next);
      try { localStorage.setItem(RPC_KEY, next); } catch { message = 'RPC saved for this tab. Browser storage is unavailable.'; }
      rpcUrl = next; await initialize();
    }
    if (name === 'recover' && chain) {
      if (!program || !templates) throw new Error(PROGRAM_NOTICE);
      window.dispatchEvent(new CustomEvent('ballista:recover', { detail: chain }));
    }
  } catch (error) { message = errorMessage(error); }
  finally { busy = false; changed(); }
}
document.addEventListener('click', event => {
  const control = (event.target as HTMLElement).closest<HTMLElement>('[data-fund]');
  if (!control || control.hasAttribute('disabled')) return;
  if (control.dataset.fund === 'faucet') {
    event.preventDefault();
    const key = burner?.player.address;
    if (!key) { toast('Wait for the burner address, then open the faucet.'); return; }
    // Start copying while this page still has focus; preserve the click's popup activation.
    const copied = navigator.clipboard.writeText(key);
    const tab = window.open('about:blank', '_blank'); if (tab) tab.opener = null;
    void copied.then(() => { message = 'Address copied.'; changed(); if (tab) tab.location.href = 'https://faucet.solana.com'; }).catch(() => { tab?.close(); toast('Copy the burner address before opening the faucet.'); });
  } else void action(control.dataset.fund!);
});
