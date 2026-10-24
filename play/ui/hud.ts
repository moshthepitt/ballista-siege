import { compactSeed } from '../copy.js';
import { C, LIMITS as L } from '../../src/v1/constants.js';
import { forecast, type RunState } from '../../src/v1/sim.js';
import type { BackendStatus } from '../backend.js';
import { $, escape } from './dom.js';
import { art } from './icons.js';
import { soundButton } from './sound.js';
import { bossPattern } from '../mechanics.js';
import { helpAttributes } from './teaching.js';
import type { Phase } from './model.js';
export function chainLabel(status?: BackendStatus, ready = true, failure = ''): string {
  if (failure) return 'Chain unavailable';
  if (!ready) return 'Connecting…';
  if (!status) return 'Local sim';
  if (status.mismatch?.length) return 'Sim mismatch';
  if (status.error) return 'Retry needed';
  if (status.pending) return `${status.phase} ${status.completed}/12`;
  return status.phase;
}
export function renderHud(state: RunState, phase: Phase, practice: boolean, status?: BackendStatus, ready = true, failure = '', walls = state.walls, gold = state.gold, network = { label: 'Offline', reason: 'Open Fund to play on devnet.' }): void {
  const wave = phase === 'build' || phase === 'battle' ? state.wave + 1n : state.wave;
  const mode = practice ? 'UNRANKED · ' : 'Seed ';
  const warn = !!(status?.pending || status?.error || status?.mismatch || failure);
  const seedText = `${mode}${state.seed}`;
  const digits = String(state.seed), longSeed = digits.length > 8;
  const compactSeedText = `${mode}${compactSeed(state.seed)}`;
  $('#hud').innerHTML = `<div class="brand">${art('brand', 34)}<span>Ballista Siege</span></div><div class="hud-stats">
    <div class="hud-stat" ${helpAttributes('Wave')} tabindex="0" role="button"><span class="label">Wave</span><span class="phone-wave">⚑</span><span class="num tnum">${wave}</span><span class="of">/ ${L.WAVES}</span><span class="track" aria-hidden="true">${Array.from({ length: L.WAVES }, (_, i) => `<i class="pip ${i + 1 < Number(wave) ? 'done' : i + 1 === Number(wave) ? 'now' : ''} ${i === 4 || i === 9 ? 'boss-pip' : ''}"></i>`).join('')}</span></div>
    <div class="hud-stat walls-stat" ${helpAttributes('Wall')} tabindex="0" role="button">${art('wall', 26)}<span class="label">Walls</span><span class="num tnum" id="walls-number">${walls}</span><span class="of">/ ${C.START_WALLS}</span><span class="wallbar" aria-hidden="true">${Array.from({ length: Number(C.START_WALLS) }, (_, i) => `<i class="${i >= Number(walls) ? 'lost' : ''}"></i>`).join('')}</span></div>
    <div class="hud-stat gold-stat" ${helpAttributes('Gold')} tabindex="0" role="button">${art('coin', 28)}<span class="num tnum" id="gold-number">${gold}</span><span class="label">Gold</span></div></div>
    <div class="hud-chips"><button id="seed-toggle" class="chip" data-command="seed">${escape(seedText)}⌄</button><button id="chain-chip" class="chip ${warn ? 'warn' : ''}" data-command="fund" title="${escape(network.reason || 'Fund burner')}"><i class="dot"></i>${escape(network.label)}</button>${soundButton()}</div>
    <button class="status ${network.label.startsWith('Devnet') ? 'funded' : ''} ${longSeed ? 'long-seed' : ''} ${warn ? 'warn' : ''}" data-command="status" title="${escape(seedText)}" aria-label="${escape(seedText)}, ${escape(network.label)}. Open seed and devnet controls"><b>${escape(compactSeedText)}</b><span><i class="dot"></i>${escape(network.label)}</span></button>`;
}
export function renderBanner(phase: Phase, state: RunState, tick: bigint, actions: bigint, status?: BackendStatus, message = ''): void {
  const boss = forecast(state).waves[0]?.boss;
  const tag = phase === 'summary' ? `WAVE ${state.wave} DONE` : phase === 'end' ? state.won ? 'RUN WON' : 'RUN LOST' : phase.toUpperCase();
  const text = phase === 'build' ? `Wave ${state.wave + 1n}${state.wave === 0n ? ` · hold the wall for ${L.WAVES} waves` : state.wave === 4n || state.wave === 9n ? ' · boss wave' : ' · prepare'}` : phase === 'battle' ? `Tick ${tick} of ${L.TICKS}${tick === 9n ? ' · Storm next tick' : ''}` : message;
  $('#phase-banner').className = `banner ${status?.mismatch?.length ? 'mismatch' : ''} ${phase === 'build' && state.wave === 0n ? 'wave-one' : ''}`;
  $('#phase-banner').innerHTML = status?.mismatch?.length ? `<span class="phase-tag lost">Mismatch</span><p>Chain and replay disagree. Further fights blocked.</p><button class="btn btn-quiet" data-command="chain">Details</button>` : `<span ${phase === 'build' ? `${helpAttributes('Shop')} tabindex="0" role="button"` : ''} class="phase-tag ${phase === 'summary' ? 'done' : phase}">${tag}</span>${phase === 'build' && state.wave === 0n ? `<span class="goal-mobile">Hold the wall for ${L.WAVES} waves</span>` : ''}<h1>${escape(text)}</h1>${phase === 'build' ? `<button class="phone-orders" data-command="orders" ${helpAttributes('Action')}><span class="opips">${Array.from({ length: 6 }, (_, i) => `<i class="${i < Number(actions) ? 'used' : ''}"></i>`).join('')}</span>${actions} of ${L.ACTIONS} actions</button><button class="icon-btn phone-undo" data-command="undo" aria-label="Undo">↶</button><button class="btn btn-quiet phone-scout" data-command="scout">⚑ Scout${state.wave === 4n || state.wave === 9n ? '<i class="dot boss-dot"></i>' : ''}</button>` : ''}${phase === 'build' && boss ? `<span class="rule-pill boss-rule">♛ ${escape(bossPattern(boss))}</span>` : ''}${phase === 'battle' ? `<div class="ticks" ${helpAttributes('Tick')} aria-label="Combat ticks">${Array.from({ length: 10 }, (_, i) => `<i class="${i + 1 < Number(tick) ? 'done' : i + 1 === Number(tick) ? 'now' : ''} ${(state.wave === 4n || state.wave === 9n) && i % 2 ? 'even' : ''}" ${helpAttributes(i === 9 ? 'Storm' : 'Tick')} data-help-note="${i === 9 ? 'After tick 10, survivors storm the wall, even past Palisades' : `Tick ${i + 1}`}"${i === 9 ? ' data-storm-tick="true"' : ''}>${i === 9 ? 'Storm' : i + 1}</i>`).join('')}</div>` : ''}`;
}
