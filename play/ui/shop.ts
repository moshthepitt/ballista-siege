import { LIMITS as L, PART as P, C } from '../../src/v1/constants.js';
import { shop, type Action, type RunState } from '../../src/v1/sim.js';
import { openingShop } from '../teaching.js';
import { helpAttributes } from './teaching.js';
import { cardReason, rerollReason } from '../availability.js';
import { partName, ruleCopy } from '../parts.js';
import { $, escape, button, phone } from './dom.js';
import { art, partArt } from './icons.js';
import { actionRows } from './model.js';
const colors = ['', 'ballista', 'cauldron', 'palisade', 'forge', 'tower', 'quarry'];
export const offerEffect = (p: bigint) => p === P.BALLISTA ? `${C.BALLISTA_DAMAGE} dmg to the front group` : p === P.CAULDRON ? `${C.CAULDRON_DAMAGE} dmg to every unit` : p === P.PALISADE ? `Blocks entry · ${C.PALISADE_HP} HP` : p === P.FORGE ? `+${C.FORGE_BALLISTA} Ballista / +${C.FORGE_CAULDRON} Cauldron dmg` : p === P.WATCHTOWER ? `Row +${C.WATCH_DAMAGE} dmg/tier · Range +${C.WATCH_RANGE}` : `+${C.QUARRY_GOLD}g per tier`;
export const compactEffect = (p: bigint) => p === P.BALLISTA ? `Shoots lane · ${C.BALLISTA_DAMAGE} dmg` : p === P.CAULDRON ? `Lane splash · ${C.CAULDRON_DAMAGE}/unit` : p === P.PALISADE ? `Blocks entry · ${C.PALISADE_HP} HP` : p === P.FORGE ? `Bolt +${C.FORGE_BALLISTA} · Splash +${C.FORGE_CAULDRON}` : p === P.WATCHTOWER ? `Row +${C.WATCH_DAMAGE} · Range ±${C.WATCH_RANGE}` : `+${C.QUARRY_GOLD}g/tier each wave`;
export const description = (p: bigint) => p === P.BALLISTA ? `Reaches ${C.BALLISTA_RANGE} cells ahead. Own lane.` : p === P.CAULDRON ? `Every unit. Own cell + ${C.CAULDRON_RANGE} ahead.` : p === P.PALISADE ? `Blocks entry to its cell · ${C.PALISADE_HP} HP` : p === P.FORGE ? 'Adjacent weapons · per tier.' : p === P.WATCHTOWER ? 'Strongest tower only · range ahead/behind.' : `+${C.QUARRY_ADJACENT}g / adjacent Quarry. +${C.QUARRY_DEEP}g at D3-D4.`;
export const cardRule = (p: bigint) => p === P.BALLISTA ? `Own lane · ${C.BALLISTA_RANGE} cells ahead` : p === P.CAULDRON ? `Own cell + ${C.CAULDRON_RANGE} ahead` : p === P.PALISADE ? 'Blocks until broken' : p === P.FORGE ? 'Adjacent weapons' : p === P.WATCHTOWER ? 'Weapons in same row' : 'Adjacent + deep bonuses';
export const tutorialEffect = (p: bigint) => p === P.BALLISTA ? `${C.BALLISTA_DAMAGE} dmg` : p === P.CAULDRON ? `${C.CAULDRON_DAMAGE} dmg/unit` : p === P.PALISADE ? `${C.PALISADE_HP} HP` : p === P.FORGE ? `Bolt +${C.FORGE_BALLISTA} / Splash +${C.FORGE_CAULDRON}` : p === P.WATCHTOWER ? `Row +${C.WATCH_DAMAGE}, range +${C.WATCH_RANGE}` : `${C.QUARRY_GOLD}g/tier`;
export function pickedDetail(state: RunState, selected: number): string {
  const offer = shop(state)[selected];
  return `<b>${partName(offer.part)} · ${offer.price}g · 1 action</b><span class="picked-summary">Tap a glowing cell · Details ›</span><span class="picked-rule">${escape(ruleCopy(offer.part))}</span>${offer.part !== P.PALISADE ? '<span>Trampled if enemies step on it (off this wave)</span>' : ''}`;
}
export function renderShop(state: RunState, selected: number | null, inspected: boolean, blocked: boolean): void {
  $('#build-panel').classList.toggle('inspecting', inspected);
  const compact = inspected || phone();
  $('#shop').innerHTML = shop(state).map((offer, i) => {
    const poor = offer.price > state.gold, sold = !offer.available;
    const reason = cardReason(state, i);
    const briefReason = reason.startsWith('Bought.') ? 'Bought · next wave / reroll'
      : reason.startsWith('No actions') ? 'No actions · Fight or undo'
      : reason.startsWith('Every cell') ? 'Board full · sell first' : reason;
    return `<div class="offer" data-help-part="${offer.part}"><button class="card ${compact ? 'mini' : ''} ${selected === i ? 'sel' : ''} ${poor ? 'poor' : ''} ${sold ? 'sold' : ''} ${reason ? 'unavailable' : ''}" data-slot="${i + 1}" data-part="${offer.part}" aria-pressed="${selected === i}" aria-disabled="${!!reason || blocked}" aria-label="${partName(offer.part)}, ${offer.price} gold, ${escape(ruleCopy(offer.part))}. ${reason}">
      <span class="key">${i + 1}</span><span class="price">${art('coin', 14)}${offer.price}</span><span class="art">${partArt(offer.part)}</span>
      <span class="tok">${partArt(offer.part, 34)}<span class="cost">${offer.price}</span></span><span class="txt"><span class="name">${partArt(offer.part, 20)}${partName(offer.part)}</span><span class="stat" style="color:var(--p-${colors[Number(offer.part)]})">${escape(offerEffect(offer.part))}</span><span class="eff">${escape(compact ? compactEffect(offer.part) : description(offer.part))}</span>${compact ? '' : `<span class="compact-eff">${escape(compactEffect(offer.part))}</span>`}<span class="tutorial-eff">${escape(tutorialEffect(offer.part))}</span><span class="card-rule">${escape(cardRule(offer.part))}</span>${reason ? `<span class="card-status">${escape(briefReason)}</span>` : ''}</span></button><button class="part-info" data-command="part-info" data-value="${offer.part}" aria-label="${partName(offer.part)} details"><span aria-hidden="true">i</span></button></div>`;
  }).join('');
  $('#reroll-desktop').innerHTML = `<button class="btn btn-2" data-command="reroll" ${helpAttributes('Reroll')} ${blocked || state.actionsUsed >= 6n || state.gold < state.rerolls + 1n ? 'disabled' : ''} aria-label="Reroll${rerollReason(state) ? `: ${escape(rerollReason(state))}` : ''}">⟳ Reroll ${art('coin', 14)}${state.rerolls + 1n}${rerollReason(state) ? `<small class="disabled-reason">${escape(rerollReason(state))}</small>` : ''}</button>`;
  const hint = $('#hint'); hint.hidden = selected === null && !(state.wave === 0n && state.actionsUsed === 0n);
  if (selected === null && !hint.hidden) hint.innerHTML = `<span>${openingShop}</span>`;
  if (selected !== null) hint.innerHTML = `<span>Place ${partName(shop(state)[selected].part)} on a glowing cell</span><span class="kbd">Esc</span>`;
}
export function renderActions(start: RunState, actions: readonly Action[], canUndo: boolean): void {
  const rows = actionRows(start, actions);
  $('#orders').innerHTML = `<div class="sec-head"><span class="label">Actions</span><span class="opips" aria-hidden="true">${Array.from({ length: 6 }, (_, i) => `<i class="${i < actions.length ? 'used' : ''}"></i>`).join('')}</span><button class="order-count" id="queue-count" data-command="orders" ${helpAttributes('Action')}>${actions.length} of ${L.ACTIONS} actions</button><button class="btn btn-quiet undo" data-command="undo" aria-label="Undo" ${canUndo ? '' : 'disabled'}><span aria-hidden="true">↶</span><span>Undo</span></button></div><div class="order-list">${rows.more ? button('orders', `+${rows.more} more`, 'order more-orders') : ''}${rows.recent.map(r => `<div class="order"><span class="kbd">${r.number}</span>${r.part ? partArt(r.part, 22) : '<span aria-hidden="true">⟳</span>'}<span>${escape(r.text)}</span></div>`).join('')}</div>`;
}
