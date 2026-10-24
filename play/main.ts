import { BuildPlans } from './plans.js';
import { planButtons, planCompare } from './ui/plans.js';
import { readLastTry, saveLastTry } from './retry.js';
import { plural, compactSeed } from './copy.js';
import { getAudioEngine } from './audio/index.js';
import { actionSound, pickSound, resultSound, followMusic } from './audio/game.js';
import { soundButton, soundControls, bindSoundControls } from './ui/sound.js';
import { C, LIMITS as L } from '../src/v1/constants.js';
import { applyAction, fight, forecast, partAt, shop, U64_MAX, type Action, type FightResult, type Mode, type RunState, type TickFrame } from '../src/v1/sim.js';
import { LocalBackend, type GameBackend } from './backend.js';
import type { ChainBackend } from './chain-backend.js';
const isChain = (backend: GameBackend): backend is ChainBackend => 'receipts' in backend;
import { selectBackend, loadNetwork, hasSavedBurner } from './select-backend.js';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
import { BuildQueue } from './queue.js';
import { makeTimeline, timelineState, wallLosses } from './replay.js';
import { renderTutorial, startTutorial } from './ui/tutorial.js';
import { guidePage, guideTabs, type GuideTab } from './ui/guide.js';
import { suggestedPlacement, wallExplanation } from './board-teaching.js';
import { glossary } from './teaching.js';
import { enemyLessons, type EnemyLesson } from './teaching.js';
import { bindTeaching, helpAttributes, helpCopy, hideTeaching, positionTeaching, partDetail, enemyDetail } from './ui/teaching.js';
import { cardReason, rerollReason } from './availability.js';
import { partName } from './parts.js';
import { partArt } from './ui/icons.js';
import { $, escape } from './ui/dom.js';
import { mount, makeBoard, toast, phone, button } from './ui/dom.js';
import { renderParts, renderFoes, renderIncoming, renderVerdicts, drawLeakPaths } from './ui/board.js';
import { renderHud, renderBanner, chainLabel } from './ui/hud.js';
import { renderShop, renderActions, pickedDetail } from './ui/shop.js';
import { renderInspector } from './ui/inspector.js';
import { scoutMarkup, fullGuide, keysMarkup, projectionMarkup } from './ui/scout.js';
import { renderRecapBuild, renderEnd, renderSettlement, saveBest, laneDetail, costliestIndex, reportMarkup, summaryMessage, firstDifference, type Recap, type Best } from './ui/screens.js';
import { openSheet, closeSheet, openSheetName, updateSheet, bindSheets } from './ui/sheets.js';
import { bindKeys } from './ui/keys.js';
import { playBattle, clearBattleEffects, animateSettlementGold, renderBattlePanel, type Playback } from './ui/battle.js';
import { planComparison } from './ui/compare.js';
import { enemyDetails } from './insights.js';
import { fightForecast, leakCause, actionRows, bossSavings, trampleWarnings, type Phase } from './ui/model.js';

const randomSeed = () => { const words = crypto.getRandomValues(new Uint32Array(2)); return BigInt(words[0]) << 32n | BigInt(words[1]); };
const params = new URLSearchParams(location.search);
function readSeed(): { seed: bigint; mode: Mode; warning?: string } {
  try {
    const raw = params.get('seed'); if (raw !== null && !/^\d+$/.test(raw)) throw new Error();
    const seed = raw === null ? randomSeed() : BigInt(raw); if (seed > U64_MAX) throw new Error();
    return { seed, mode: 'practice' };
  } catch { return { seed: randomSeed(), mode: 'practice', warning: 'Invalid seed. Loaded a new siege.' }; }
}
const initial = readSeed();
let backend: GameBackend = new LocalBackend(initial.seed, initial.mode);
let ready = true, failure = '', backendNotice = '';
let networkView: { label: string; reason: string; notice?: string } = { label: 'Offline', reason: 'Open Fund to play on devnet.' };
let lastNetworkNotice = '';
window.addEventListener('ballista:network', event => {
  networkView = (event as CustomEvent<typeof networkView>).detail;
  if (networkView.notice && isChain(backend)) continueOffline();
  else hud();
  if (networkView.notice && networkView.notice !== lastNetworkNotice) toast(networkView.notice);
  lastNetworkNotice = networkView.notice ?? '';
});
window.addEventListener('ballista:burner-restored', () => continueOffline());
window.addEventListener('ballista:recover', event => {
  const recovered = (event as CustomEvent<ChainBackend>).detail;
  if (backend === recovered) { void backend.retry?.().catch(error => toast(errorMessage(error))); return; }
  if (phase === 'battle') { toast('Finish this battle before resuming the devnet turn.'); return; }
  recaps = []; best = null; lastResult = null; completed = null; frame = null; inspected = null; selectedSlot = null; hover = null; clearBattleEffects(true);
  backend = recovered; plans = new BuildPlans(backend.state); queue = plans.current; phase = 'build'; bindBackend(); render(); openSheet('chain', 'Chain details', chainBody());
});
let plans = new BuildPlans(backend.state), queue = plans.current, phase: Phase = 'build';
let selectedSlot: number | null = null, inspected: bigint | null = null, hover: bigint | null = null;
let frame: TickFrame | null = null, playback: Playback | null = null, speed = 1;
let recaps: Recap[] = [], lastResult: FightResult | null = null, selectedRecap = 0;
let best: Best | null = null;
let lastTry = readLastTry(initial.seed);
let replanBeforeLoss: bigint | undefined, replanOriginal: Recap | undefined;
let completed: { backend: GameBackend; queue: BuildQueue; recaps: Recap[]; selected: number; best: Best; markup: string } | null = null;
let unsubscribe: (() => void) | undefined, receiptStart = 0;
// halted: nothing may change. blocked: also waiting for chain confirmation, so only planning is allowed.
const halted = () => !ready || !!failure || !!(backend.status?.().error || backend.status?.().mismatch?.length);
const blocked = () => halted() || !!backend.status?.().pending;
function continueOffline(): void {
  if (!isChain(backend)) return;
  const start = phase === 'battle' ? backend.state : queue.start;
  backend = new LocalBackend(start.seed, 'practice', start); bindBackend();
  if (phase === 'battle') { hud(); actionBar(); } else render();
}
const activeRecap = () => recaps.at(-1);
mount(); makeBoard(); bindSheets(); bindSoundControls(); bindTeaching(); startTutorial(queue.state);

function updateUrl(): void {
  try { const url = new URL(location.href); url.searchParams.set('seed', String(queue.state.seed)); url.searchParams.delete('mode'); history.replaceState(null, '', url); } catch { /* Embeds may prohibit history writes. */ }
}
const tutorialContext = () => ({ state: queue.state, phase, selected: selectedSlot === null ? undefined : shop(queue.state)[selectedSlot].part, tick: frame?.tick, frame });
function hud(): void {
  const state = phase === 'battle' ? queue.state : phase === 'summary' ? lastResult!.state : queue.state;
  renderHud(state, phase, !!completed, backend.status?.(), ready, failure, phase === 'battle' ? frame?.walls : undefined, phase === 'battle' ? frame?.gold : undefined,
    // A funded burner does not move the current run on chain; say so until a devnet run starts.
    networkView.label.startsWith('Devnet') && !isChain(backend) ? { ...networkView, label: 'Play on devnet', reason: 'This run is offline. Open Fund and start a devnet run.' } : networkView);
  const musicGroups = phase === 'battle' ? frame?.groups ?? [] : [];
  followMusic(phase, queue.state.wave + (phase === 'battle' ? 1n : 0n), musicGroups);
  $('#game').dataset.phase = phase; $('#game').dataset.practice = String(!!completed);
  if (phase !== 'battle') { delete $('#game').dataset.combatPhase; delete $('#game').dataset.combatTick; delete $('#game').dataset.activeGroups; }
}
function actionBar(): void {
  const state = queue.state, status = backend.status?.(), waiting = status?.pending;
  let command = 'fight', label = `Fight wave ${state.wave + 1n}`, sub = '';
  const preview = phase === 'build' ? backend.preview(state) : [];
  if (phase === 'build') sub = fightForecast(preview, state.gold);
  if (phase === 'battle') { command = 'skip'; label = 'Skip to result'; sub = 'The outcome is already set'; }
  if (phase === 'summary') { command = 'continue-summary'; label = completed || lastResult!.state.done ? 'See result' : 'Next wave'; sub = lastResult!.state.done ? `${lastResult!.state.score} points` : `Wave ${lastResult!.state.wave + 1n} · ${lastResult!.state.gold}g to spend`; }
  if (phase === 'end') { command = 'retry'; label = `Retry seed ${compactSeed(state.seed)}`; sub = 'Same waves, same shop rolls'; }
  const disabled = command !== 'skip' && (command === 'continue-summary' ? halted() : blocked());
  if (disabled) sub = waiting ? `${status!.completed} of 12 transactions` : failure || status?.error || (status?.mismatch ? 'Chain and sim disagree. Open details.' : 'Connecting to chain…');
  const aux = phase === 'build' ? `<button class="btn btn-2 phone-aux" data-command="reroll" ${helpAttributes('Reroll')} aria-label="Reroll${rerollReason(state) ? `: ${escape(rerollReason(state))}` : ''}" ${halted() || state.actionsUsed >= 6n || state.gold < state.rerolls + 1n ? 'disabled' : ''}><span class="reroll-glyph" aria-hidden="true">⟳</span><span>Reroll ${state.rerolls + 1n}g</span>${rerollReason(state) ? `<small class="disabled-reason">${escape(rerollReason(state))}</small>` : ''}</button>` : phase === 'battle' ? `<button class="btn btn-2 phone-aux" data-command="speed" aria-label="Speed ${speed}×, tap to change">${speed}×<span class="label">speed</span></button>` : `<button class="btn btn-quiet phone-aux" data-command="${phase === 'summary' ? 'summary-detail' : 'copy'}">${phase === 'summary' ? 'Details' : 'Copy'}</button>`;
  $('#action-bar').innerHTML = `${phase === 'build' ? `<p class="storm-rule" ${helpAttributes('Storm')}>After tick ${L.TICKS}, survivors storm the wall, even past Palisades.</p><p class="income-rule" ${helpAttributes('Gold')}>Wave end: +${C.INCOME}g base · +${C.CLEAR_GOLD}g/clean lane · +1g/${C.SALVAGE_KILLS} kills</p>` : ''}${phase === 'battle' ? `<div class="speed-control sec-head"><span class="label">Speed</span><span class="seg">${[1, 2].map(n => `<button data-command="speed" data-value="${n}" aria-pressed="${speed === n}" class="${speed === n ? 'on' : ''}">${n}×</button>`).join('')}</span></div>` : ''}<div class="main-action">${aux}<button class="btn-go ${waiting && disabled ? 'waiting' : ''}" data-command="${command}" ${command === 'retry' ? `aria-label="Retry seed ${state.seed}"` : ''} ${disabled ? 'disabled' : ''}>${label}<small>${escape(sub)}</small></button></div>`;
}
function render(): void {
  // Keep the live board and action hooks when the report markup is replaced.
  const stage = $('.stage'), rail = $('.action-rail');
  stage.insertBefore($('.battlefield'), rail); rail.append($('#action-bar'));
  document.querySelectorAll('.phone-plan-compare').forEach(n => n.remove());
  hud();
  const state = queue.state, recap = activeRecap();
  $('#build-panel').hidden = phase !== 'build'; $('#battle-panel').hidden = phase !== 'battle'; $('#settlement').hidden = phase !== 'summary'; $('#end-screen').hidden = phase !== 'end';
  $('.projection-entry').hidden = phase !== 'build' || inspected !== null;
  $('#phase-banner').dataset.tick = String(frame?.tick ?? 0n);
  renderBanner(phase, phase === 'summary' ? lastResult!.state : state, frame?.tick ?? 0n, state.actionsUsed, backend.status?.(), recap ? summaryMessage(recap) : '');
  if (phase === 'build') {
    $('#game').classList.toggle('has-inspector', inspected !== null);
    renderShop(state, selectedSlot, inspected !== null, halted()); renderActions(queue.start, queue.actions, queue.canUndo && !halted());
    renderInspector(state, inspected, halted());
    $('#orders .sec-head').insertAdjacentHTML('beforeend', planButtons(plans, halted()));
    $('#orders').insertAdjacentHTML('beforeend', planCompare(plans));
    $('#phase-banner .phone-undo')?.insertAdjacentHTML('afterend', planButtons(plans, halted()));
    $('#build-panel').insertAdjacentHTML('afterbegin', `<div class="phone-plan-compare">${planCompare(plans)}</div>`);
    const offer = selectedSlot === null ? null : shop(state)[selectedSlot];
    let ghost: { cell: bigint; state: RunState } | null = null;
    if (offer && hover !== null && !partAt(state, hover)) try { ghost = { cell: hover, state: applyAction(state, { type: 'buy', slot: offer.slot, cell: hover }) }; } catch { /* Invalid tiles do not preview. */ }
    if (offer) {
      const picked = document.createElement('button'); picked.className = 'picked-card'; picked.dataset.command = 'card-detail'; picked.innerHTML = pickedDetail(state, selectedSlot!); $('#phase-banner').append(picked);
      const hint = $('#hint');
      hint.innerHTML = ghost ? `<span class="investment-line" data-help-note="No further purchases; forecast stops when walls fall">${escape(planComparison(state, ghost.state))}</span>` : `<span>Place ${partName(offer.part)} on a glowing cell</span><span class="kbd">Esc</span>`;
    }
    if (state.wave === 0n && state.actionsUsed === 0n) $('#phase-banner').insertAdjacentHTML('beforeend', `<span class="opening-hint" ${helpAttributes('Action')}>Pick part, tap tile. ${L.ACTIONS === 6 ? 'Six' : L.ACTIONS} actions.</span>`);
    const predicted = fight(ghost?.state ?? state), survivors = predicted.frames.at(-1)?.groups ?? [];
    renderFoes([]); renderIncoming(state); drawLeakPaths([]);
    renderParts(state, { phase, inspected: ghost?.cell ?? inspected, target: !!offer, ghost, warnings: trampleWarnings(predicted.frames), preview: backend.preview(state), candidate: ghost ? backend.preview(ghost.state) : undefined, causes: [0n, 1n, 2n, 3n].map(lane => leakCause(survivors, lane)) });
    $('#scout-rail').innerHTML = scoutMarkup(state, false, false, lastTry);
    if (innerWidth >= 1800 && innerHeight >= 950) { $('#orders .plan-compare').remove(); $('#scout-rail .rail-title').insertAdjacentHTML('afterend', planCompare(plans)); }
  } else {
    $('#game').classList.remove('has-inspector'); renderInspector(state, null, halted());
    if (phase === 'summary' && recap) {
      renderSettlement(recap, completed ? undefined : lastTry); renderParts(recap.built, { phase, frame: recap.result.frames.at(-1) }); renderFoes([]); renderIncoming(recap.built, [], true);
      renderVerdicts(recap.result.summary.lanes.map((l, i) => ({ lane: BigInt(i), leaks: l.damage, kills: l.kills, retreats: l.retreats, result: l.damage ? 'LEAKS' : 'HOLDS' })), undefined, true, recap.result.summary.lanes.map(l => `${l.kills} ${plural(l.kills, 'kill')}`), undefined, forecast(recap.built).waves[0]?.lanes);
      drawLeakPaths(wallLosses(recap.built, recap.timeline).map(l => l.lane));
      $('#scout-rail').innerHTML = scoutMarkup(lastResult!.state, false, true, lastTry);
    }
    if (phase === 'end') {
      renderRecapBuild(recaps[selectedRecap] ?? activeRecap(), state);
      renderEnd(state, recaps, selectedRecap, best ?? { score: state.score, wave: state.wave, won: state.won, current: true }, !!completed, blocked(), completed ? undefined : lastTry, completed?.recaps);
      $('.end-board-slot').append($('.battlefield'));
      $('.end-result').insertBefore($('#action-bar'), $('.end-secondary'));
    }
  }
  actionBar();
  renderTutorial(tutorialContext());
  positionTeaching();
}
function chooseSlot(slot: number): void {
  if (phase !== 'build' || halted()) return;
  const offer = shop(queue.state)[slot];
  const reason = cardReason(queue.state, slot);
  if (reason) { toast(reason); return; }
  pickSound(); hideTeaching();
  selectedSlot = selectedSlot === slot ? null : slot; inspected = null; hover = selectedSlot === null ? null : suggestedPlacement(queue.state, offer.part); closeSheet(); render();
}
function perform(action: Action): void {
  if (phase !== 'build' || halted()) return;
  const result = queue.attempt(action); if (!result.ok) { toast(result.reason); return; }
  actionSound(action);
  if (action.type === 'buy' || action.type === 'reroll') selectedSlot = null;
  if (action.type === 'sell') inspected = null;
  hover = null; render();
  renderTutorial({ ...tutorialContext(), action });
  if (action.type === 'buy') {
    const piece = $(`[data-cell="${action.cell}"] .part-layer`);
    piece.animate([{ opacity: .4 }, { opacity: 1 }], { duration: 160 });
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
      piece.querySelector('.plate > svg, .fence > svg')?.animate([{ transform: 'translateY(-8px)' }, { transform: 'translateY(2px)' }, { transform: 'translateY(0)' }], { duration: 160 });
  }
}
async function fightWave(): Promise<void> {
  if (phase !== 'build' || blocked()) return;
  const built = queue.state, start = queue.start, actions = queue.actions;
  selectedSlot = null; inspected = null; hover = null; closeSheet(); clearBattleEffects(true); frame = null;
  $('#game').dataset.combatPhase = 'Preparing'; $('#game').dataset.combatTick = '0'; $('#game').dataset.activeGroups = '0';
  phase = 'battle'; const handle: Playback = { skip: false, cancelled: false }; playback = handle;
  receiptStart = isChain(backend) ? backend.receipts.length : 0;
  render(); renderParts(built, { phase }); renderFoes([]); renderBattlePanel(built, null, [], speed);
  try {
    const result = await backend.playTurn(actions), timeline = makeTimeline(built, result.frames), recovered = timelineState(built, timeline);
    for (const key of ['gold', 'walls', 'score', 'parts', 'tiers', 'totalKills'] as const) if (recovered[key] !== result.state[key]) throw new Error(`Replay mismatch: ${key}`);
    await playBattle(built, timeline, handle, { speed: () => speed, hud: f => { const prior = frame?.walls ?? built.walls; frame = f; hud(); renderTutorial(tutorialContext()); if (f.walls !== prior) $('#walls-number').animate([{ color: '#FF5468', opacity: .5 }, { color: '#F5F0E6', opacity: 1 }], { duration: Math.max(200, 300 / speed) }); }, tick: (tick, combatPhase) => {
      $('#game').dataset.combatTick = String(tick); $('#game').dataset.combatPhase = combatPhase;
      renderTutorial({ ...tutorialContext(), tick });
      renderBanner('battle', built, tick, built.actionsUsed, backend.status?.());
    } });
    if (handle.cancelled) return;
    recaps.push({ start, built, result, timeline, beforeLoss: replanBeforeLoss, actions: [...actions], original: replanOriginal }); lastResult = result; frame = result.frames.at(-1) ?? null;
    plans = new BuildPlans(result.state); queue = plans.current; playback = null; phase = 'summary'; clearBattleEffects(); render(); resultSound('summary', result.state.won); animateSettlementGold();
  } catch (error) { if (!handle.cancelled) { playback = null; phase = 'build'; render(); toast(errorMessage(error)); } }
}
function continueSummary(): void {
  if (phase !== 'summary' || halted()) return;
  if (queue.state.done || completed) {
    phase = 'end'; selectedRecap = completed ? completed.recaps.findIndex(r => r.result.state.wave === activeRecap()?.result.state.wave) : costliestIndex(recaps);
    best = saveBest(queue.state, completed?.best);
    resultSound('end', queue.state.won);
  } else { phase = 'build'; frame = null; clearBattleEffects(true); }
  render();
}
async function startRun(seed: bigint, _mode: Mode, retry = false): Promise<void> {
  const mode = 'practice';
  if (blocked()) { toast('Finish or retry chain confirmation first.'); return; }
  if (playback) { playback.cancelled = true; playback.wake?.(); playback = null; }
  lastTry = retry ? saveLastTry(seed, completed?.recaps ?? recaps) ?? readLastTry(seed) : readLastTry(seed);
  closeSheet(); clearBattleEffects(true); completed = null; replanBeforeLoss = undefined; replanOriginal = undefined; recaps = []; best = null; lastResult = null; frame = null; selectedSlot = null; inspected = null; hover = null; phase = 'build';
  try {
    const selected = await selectBackend(seed, 'practice', params.get('backend')); backend = selected.backend; backendNotice = selected.notice ?? ''; bindBackend();
    if (isChain(backend)) { const starting = backend.start(seed, mode); plans = new BuildPlans(backend.state); queue = plans.current; render(); await starting; }
    else backend = new LocalBackend(seed, mode);
    plans = new BuildPlans(backend.state); queue = plans.current; startTutorial(queue.state); bindBackend(); updateUrl(); render(); if (backendNotice) toast(backendNotice);
  } catch (error) { toast(errorMessage(error)); render(); }
}
function replan(): void {
  const recap = completed ? (recaps.find(r => r.result.state.wave === completed!.recaps[selectedRecap]?.result.state.wave) ?? completed.recaps[selectedRecap]) : recaps[selectedRecap]; if (!recap || phase !== 'end' || blocked()) return;
  if (!completed) completed = { backend, queue, recaps: [...recaps], selected: Number(document.querySelector<HTMLElement>('.chart-column[aria-pressed="true"]')?.dataset.recapWave ?? selectedRecap), best: best!, markup: $('#end-screen').innerHTML };
  replanBeforeLoss = recap.built.walls - recap.result.state.walls; replanOriginal = recap;
  backend = new LocalBackend(recap.start.seed, 'practice', recap.start); plans = new BuildPlans(backend.state); queue = plans.current; bindBackend();
  recaps = []; lastResult = null; phase = 'build'; inspected = null; selectedSlot = null; frame = null; closeSheet(); clearBattleEffects(true); render();
}
function returnResult(): void {
  if (!completed) return;
  const saved = completed; completed = null; replanBeforeLoss = undefined; replanOriginal = undefined; backend = saved.backend; queue = saved.queue; recaps = saved.recaps; selectedRecap = saved.selected; best = saved.best;
  phase = 'end'; clearBattleEffects(true); bindBackend(); render();
  const hooks = [$('#board'), $('#action-bar')];
  $('#end-screen').innerHTML = saved.markup;
  // Restore the saved report without replacing the board's input listeners.
  for (const hook of hooks) {
    const snapshot = $(`#${hook.id}`);
    hook.replaceChildren(...snapshot.childNodes); snapshot.replaceWith(hook);
  }
}
async function replayExperiment(): Promise<void> {
  const revised = activeRecap(), original = revised?.original;
  if (!revised || !original || phase === 'battle') return;
  const savedQueue = queue, savedPhase = phase, savedFrame = frame;
  const handle: Playback = { skip: false, cancelled: false }; playback = handle;
  const first = firstDifference(original, revised);
  try {
    for (const [label, recap] of [['Original', original], ['Revised', revised]] as const) {
      if (handle.cancelled) return;
      handle.skip = false; clearBattleEffects(true); closeSheet();
      queue = new BuildQueue(recap.built); frame = first ? recap.timeline[first - 1].frame : null; phase = 'battle'; render();
      toast(`${label} plan · replay from tick ${first + 1}`);
      await playBattle(recap.built, recap.timeline.slice(first), handle, {
        speed: () => speed, hud: f => { frame = f; hud(); }, tick: (tick, name) => {
          $('#game').dataset.combatTick = String(tick); $('#game').dataset.combatPhase = name;
          renderBanner('battle', recap.built, tick, recap.built.actionsUsed, backend.status?.());
        },
      }, frame ?? undefined);
    }
  } finally {
    if (!handle.cancelled) { queue = savedQueue; phase = savedPhase; frame = savedFrame; playback = null; clearBattleEffects(); render(); }
  }
}
function purchaseSheet(): string {
  if (selectedSlot === null) return '';
  const state = queue.state, empty = Array.from({ length: 16 }, (_, i) => BigInt(i)).filter(cell => !partAt(state, cell));
  const cell = hover !== null && empty.includes(hover) ? hover : empty[0];
  let comparison = '';
  if (cell !== undefined) try { comparison = planComparison(state, applyAction(state, { type: 'buy', slot: BigInt(selectedSlot), cell })); } catch { /* Card details remain available without a legal action. */ }
  return partDetail(shop(state)[selectedSlot].part) + pickedDetail(state, selectedSlot) + (cell === undefined ? '' : `<label class="sub">Preview placement <select id="purchase-preview-cell" aria-label="Preview placement cell">${empty.map(i => `<option value="${i}" ${i === cell ? 'selected' : ''}>L${i / 4n + 1n} D${i % 4n + 1n}</option>`).join('')}</select></label><p id="purchase-comparison" class="investment-line">${escape(comparison)}</p><p class="sub">No further purchases in this forecast. Close, then tap a glowing cell to buy.</p>`);
}
function seedBody(): string {
  return `<form id="seed-form" class="sec"><label for="seed-input">Seed</label><input id="seed-input" name="seed" inputmode="numeric" pattern="[0-9]+" value="${queue.state.seed}" required><p class="sub">Choose any seed from 0 to ${U64_MAX}. Same seed, same waves and shop rolls.</p><button class="btn-go" type="submit">Start</button>${button('new-seed', 'New seed')}</form>`;
}
async function fundPanel(): Promise<void> {
  openSheet('fund', 'Fund · devnet', '<p class="sub">Loading devnet controls… Play continues offline.</p>');
  try { const network = await loadNetwork(); await network.openFund(); } catch { updateSheet('<p class="sub">Devnet controls unavailable. Play continues offline.</p>'); }
}
function chainBody(): string {
  const status = backend.status?.();
  const receipts = isChain(backend) ? backend.receipts.slice(receiptStart, receiptStart + 12) : [];
  const link = (sig: string) => isChain(backend) ? `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=custom&customUrl=${encodeURIComponent(backend.manifest.rpcUrl)}` : '#';
  return `<p class="sub">${escape(chainLabel(status, ready, failure))}${backendNotice ? ` · ${escape(backendNotice)}` : ''}</p>${status?.error || failure ? `<p role="alert">${escape(status?.error || failure)}</p>` : ''}${status?.warning ? `<p class="sub">${escape(status.warning)}</p>` : ''}${status?.mismatch?.length ? `<p role="alert">Chain result stands. Further fights blocked.</p><ul>${status.mismatch.map(m => `<li>${escape(m)}</li>`).join('')}</ul>` : ''}${status ? `<div class="transaction-list">${Array.from({ length: 12 }, (_, i) => {
    const receipt = receipts[i], pending = !receipt && status.pending && i === status.completed, sig = receipt?.signature ?? (pending ? status.signature : undefined);
    return `<div class="transaction"><span>${i + 1}</span>${sig ? `<a href="${escape(link(sig))}" target="_blank" rel="noopener">${escape(sig.slice(0, 7))}…${escape(sig.slice(-5))}</a>` : '<span>—</span>'}<span>${receipt ? `${receipt.computeUnits ?? '—'} CU · Confirmed` : pending ? 'Pending' : 'Waiting'}</span></div>`;
  }).join('')}</div>` : '<p class="sub">Practice runs entirely in this browser. No chain transactions.</p>'}${status?.error && backend.retry ? button('chain-retry', 'Retry', 'btn btn-2') : ''}${failure ? button('chain-reload', 'Retry connection', 'btn btn-2') : ''}`;
}
async function copyScore(): Promise<void> {
  const state = queue.state, text = `Ballista Siege · seed ${state.seed} · ${completed ? 'unranked replan' : state.won ? 'won' : 'lost'} · ${state.walls} walls · ${state.score.toLocaleString()}`;
  try { await navigator.clipboard.writeText(text); toast('Share text copied.'); }
  catch { openSheet('copy', 'Share text', `<textarea readonly aria-label="Share text">${escape(text)}</textarea>`); }
}
function command(name: string, value?: string): void {
  if (!['upgrade', 'sell', 'overclock', 'reroll', 'mute'].includes(name)) pickSound();
  switch (name) {
    case 'tutorial-next': renderTutorial(tutorialContext(), 'next'); break;
    case 'tutorial-skip': renderTutorial(tutorialContext(), 'skip'); break;
    case 'fight': void fightWave(); break;
    case 'skip': if (playback) { playback.skip = true; playback.wake?.(); } break;
    case 'continue-summary': continueSummary(); break;
    case 'speed': speed = value ? Number(value) : speed === 1 ? 2 : 1; if (playback?.tickMs) followMusic('battle', queue.state.wave + 1n, frame?.groups ?? [], playback.tickMs, speed); actionBar(); break;
    case 'plan-compare': openSheet('plan-compare', 'Compare plans', planCompare(plans)); break;
    case 'plan': if (phase === 'build' && !halted() && (value === 'A' || value === 'B')) { queue = plans.switch(value); selectedSlot = null; inspected = null; hover = null; closeSheet(); render(); } break;
    case 'undo': if (phase === 'build' && !halted()) { const r = queue.undo(); if (!r.ok) toast(r.reason); inspected = null; selectedSlot = null; render(); } break;
    case 'reroll': perform({ type: 'reroll' }); break;
    case 'upgrade': case 'sell': case 'overclock': if (inspected !== null) perform({ type: name, cell: inspected }); break;
    case 'escape': hideTeaching(); if (openSheetName()) { closeSheet(); hideTeaching(); renderTutorial(tutorialContext()); } else { inspected = null; selectedSlot = null; hover = null; render(); } break;
    case 'close-inspector': inspected = null; render(); break;
    case 'close-sheet': closeSheet(); hideTeaching(); renderTutorial(tutorialContext()); break;
    case 'scout': openSheet('scout', 'Scout', (phase === 'build' ? planCompare(plans) : '') + scoutMarkup(queue.state, true, phase === 'summary', lastTry), true); break;
    case 'part-info': hideTeaching(); if (value) openSheet('part-info', 'Part details', partDetail(BigInt(value))); break;
    case 'enemy-info': hideTeaching(); if (value && value in enemyLessons) openSheet('enemy-info', 'Enemy details', enemyDetail(value as EnemyLesson)); break;
    case 'guide': hideTeaching(); openSheet('guide', 'Guide', fullGuide(), true); break;
    case 'guide-tab': if (value && guideTabs.includes(value as GuideTab)) { updateSheet(guidePage(value as GuideTab)); $('#sheet .sheet-body').scrollTop = 0; } break;
    case 'keys': openSheet('keys', 'Keys', keysMarkup(), true); break;
    case 'projection': openSheet('projection', 'Next 3 waves', projectionMarkup(queue.state)); break;
    case 'card-detail': if (selectedSlot !== null) openSheet('card-detail', 'Picked part', purchaseSheet()); break;
    case 'orders': openSheet('orders', "This wave's actions", `<p class="sub">${escape(glossary.Action)}</p>` + (actionRows(queue.start, queue.actions).all.map(r => `<div class="order"><span class="kbd">${r.number}</span>${r.part ? partArt(r.part, 24) : '<span aria-hidden="true">⟳</span>'}<span>${escape(r.text)}</span></div>`).join('') || '<p class="sub">No actions yet. Pick a card, then a glowing tile.</p>')); break;
    case 'summary-detail': if (activeRecap()) { if (phone()) openSheet('summary-detail', 'Lane by lane', laneDetail(activeRecap()!)); else { const existing = document.querySelector('#lane-expanded'); if (existing) existing.remove(); else $('#settlement .settlement-content').insertAdjacentHTML('beforeend', `<div id="lane-expanded">${laneDetail(activeRecap()!)}</div>`); } } break;
    case 'lane-detail': if (phase === 'summary' && activeRecap()) openSheet('lane-detail', `Lane ${Number(value) + 1}`, laneDetail(activeRecap()!, BigInt(value!))); else openSheet('lane-detail', `Lane ${Number(value) + 1}`, `<p class="sub">${escape(wallExplanation(queue.state, BigInt(value!)))}</p><p class="sub">${escape(glossary.Leak)}</p><p class="sub">${escape(glossary.Storm)}</p>`); break;
    case 'full-report': if (phone()) openSheet('full-report', 'Full report · every wave', reportMarkup(recaps)); else { const panel = $('.end-causes'); panel.classList.add('full-report'); panel.innerHTML = button('close-report', 'Close full report') + reportMarkup(recaps); } break;
    case 'close-report': render(); break;
    case 'copy': void copyScore(); break;
    case 'retry': void startRun(queue.state.seed, queue.state.mode, true); break;
    case 'replan-wave': replan(); break;
    case 'replay-experiment': void replayExperiment(); break;
    case 'return-result': returnResult(); break;
    case 'start-devnet': {
      // Keep the current seed if its run has not started yet, so a shared seed can be played on chain.
      const state = queue.state, fresh = state.wave === 0n && state.actionsUsed === 0n && !completed, words = crypto.getRandomValues(new Uint32Array(2));
      void startRun(fresh ? state.seed : BigInt(words[0]) << 32n | BigInt(words[1]), 'practice'); break;
    }
    case 'new-seed': { const words = crypto.getRandomValues(new Uint32Array(2)); void startRun(BigInt(words[0]) << 32n | BigInt(words[1]), 'practice'); break; }
    case 'sound': openSheet('sound', 'Sound', soundControls()); break;
    case 'mute': getAudioEngine().toggleMute(); break;
    case 'seed': openSheet('seed', 'Choose your siege', seedBody()); break;
    case 'fund': void fundPanel(); break;
    case 'chain': openSheet('chain', 'Chain details', chainBody()); break;
    case 'status': openSheet('status', 'Run status', `<div class="sec"><div class="status-sound"><span>Sound</span>${soundButton()}</div>${button('seed', 'Choose seed')}${button('fund', 'Fund · devnet')}${button('chain', 'Chain details')}<p class="sub">${escape(chainLabel(backend.status?.(), ready, failure))}</p>${completed ? button('return-result', 'Return to completed result') : ''}</div>`); break;
    case 'chain-reload': location.reload(); break;
    case 'chain-retry': void loadNetwork().then(network => network.retry(backend)).catch(e => toast(errorMessage(e))); break;
  }
}
function bindBackend(): void {
  $('#game').dataset.run = isChain(backend) ? 'chain' : 'offline';
  unsubscribe?.(); unsubscribe = backend.subscribe?.(() => {
    hud(); actionBar();
    if (backend.status?.().mismatch?.length) renderBanner(phase, queue.state, frame?.tick ?? 0n, queue.state.actionsUsed, backend.status?.());
    if (phase === 'build') renderShop(queue.state, selectedSlot, inspected !== null, halted());
    if (backend.status?.().error && /fund|lamport|insufficient/i.test(backend.status?.().error ?? '') && openSheetName() !== 'fund') void fundPanel();
    if (openSheetName() === 'chain') updateSheet(chainBody());
  });
}
$('#game').addEventListener('keydown', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-help][role="button"]');
  if (target && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); target.click(); }
});
$('#game').addEventListener('click', event => {
  const target = event.target as HTMLElement;
  if (target.closest('#tutorial-layer')) { const control = target.closest<HTMLElement>('[data-command]'); if (control) command(control.dataset.command!); return; }
  const foe = target.closest<HTMLElement>('[data-enemy-inspect]');
  if (foe) { const groups = phase === 'battle' ? frame?.groups : forecast(queue.state).waves[0]?.lanes.flat(); const group = groups?.find(g => String(g.id) === foe.dataset.enemyInspect); if (group) { pickSound(); openSheet('enemy', `${group.kind === 'boss' ? group.bossPattern === 'gatebreaker' ? 'Gatebreaker' : 'Last Siege' : group.kind === 'swarm' ? 'Swarm' : 'Brute'}`, `${enemyDetail(group.kind === 'boss' ? group.bossPattern! : group.kind)}<p class="sub">${escape(enemyDetails(group))}</p>${group.kind === 'boss' ? `<p class="sub">${escape(bossSavings(group))}</p>` : ''}`); } return; }
  const info = target.closest<HTMLElement>('[data-command="part-info"], [data-command="enemy-info"]');
  if (info) { command(info.dataset.command!, info.dataset.value); renderTutorial(tutorialContext()); return; }
  const term = target.closest<HTMLElement>('[data-help]');
  if (term && !term.matches('[data-command], :disabled')) { pickSound(); hideTeaching(); const key = term.dataset.help!; openSheet('glossary', key, `<p class="help-note">${escape(term.dataset.helpNote ?? '')}</p><p class="sub">${escape(helpCopy[key])}</p>`); return; }
  hideTeaching();
  const card = target.closest<HTMLElement>('.card[data-slot]'); if (card) { chooseSlot(Number(card.dataset.slot) - 1); return; }
  const control = target.closest<HTMLElement>('[data-command]'); if (control) { command(control.dataset.command!, control.dataset.value ?? control.dataset.lane); renderTutorial(tutorialContext()); return; }
  const chart = target.closest<HTMLElement>('[data-recap-wave]'); if (chart && Number(chart.dataset.recapWave) >= 0) { pickSound(); selectedRecap = Number(chart.dataset.recapWave); replan(); return; }
  const cell = target.closest<HTMLElement>('[data-cell]');
  if (cell && phase === 'build' && !halted()) {
    const index = BigInt(cell.dataset.cell!);
    if (selectedSlot !== null && !partAt(queue.state, index)) perform({ type: 'buy', slot: BigInt(selectedSlot), cell: index });
    else if (partAt(queue.state, index)) { pickSound(); selectedSlot = null; inspected = inspected === index ? null : index; closeSheet(); render(); }
  }
});
for (const event of ['pointerover', 'focusin'] as const) $('#inspector').addEventListener(event, e => { const action = (e.target as HTMLElement).closest<HTMLElement>('[data-comparison]'); const line = document.querySelector<HTMLElement>('#action-comparison'); if (line && action?.dataset.comparison) line.textContent = action.dataset.comparison; });
$('#board').addEventListener('pointerover', event => {
  if (phase !== 'build' || selectedSlot === null || (event as PointerEvent).pointerType === 'touch') return;
  const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]'); if (cell && hover !== BigInt(cell.dataset.cell!)) { hover = BigInt(cell.dataset.cell!); render(); }
});
$('#board').addEventListener('pointerleave', () => { if (hover !== null) { hover = null; if (phase === 'build') render(); } });
$('#game').addEventListener('submit', event => {
  if (!(event.target instanceof HTMLFormElement) || event.target.id !== 'seed-form') return;
  event.preventDefault();
  try { const raw = $<HTMLInputElement>('#seed-input').value; if (!/^\d+$/.test(raw)) throw new Error('Seed must be a whole number.'); const seed = BigInt(raw); if (seed > U64_MAX) throw new Error('Seed exceeds u64.'); void startRun(seed, 'practice'); } catch (error) { toast(errorMessage(error)); }
});
$('#game').addEventListener('change', event => {
  const target = event.target as HTMLSelectElement;
  if (target.id === 'purchase-preview-cell' && selectedSlot !== null) { try { const next = applyAction(queue.state, { type: 'buy', slot: BigInt(selectedSlot), cell: BigInt(target.value) }); $('#purchase-comparison').textContent = planComparison(queue.state, next); hover = BigInt(target.value); render(); } catch (error) { toast(errorMessage(error)); } }
  if (target.id === 'inspect-preview') { const action = document.querySelector<HTMLElement>(`#inspector [data-command="${target.value}"]`); $('#action-comparison').textContent = action?.dataset.comparison ?? ''; }
});
let inspectorTouchY = 0;
$('#inspector').addEventListener('touchstart', e => { inspectorTouchY = e.touches[0].clientY; }, { passive: true });
$('#inspector').addEventListener('touchend', e => { if (e.changedTouches[0].clientY - inspectorTouchY > 60) command('close-inspector'); }, { passive: true });
bindKeys(command, chooseSlot, () => phase, () => !!openSheetName());
let resizeTimer: ReturnType<typeof setTimeout>;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (phase !== 'battle') render(); }, 80); });
render(); updateUrl();
if (initial.warning) toast(initial.warning);
bindBackend();
// Let the board paint before the returning player's optional chain chunk starts loading.
if (params.get('backend') !== 'local' && hasSavedBurner()) requestAnimationFrame(() => requestAnimationFrame(() => {
  void loadNetwork().then(network => network.initialize()).catch(() => {});
}));
