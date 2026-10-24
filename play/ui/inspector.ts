import { C, PART as P } from '../../src/v1/constants.js';
import { applyAction, partAt, previewLanes, sellValue, tierAt, upgradeCost, type Action, type RunState } from '../../src/v1/sim.js';
import { damageArithmetic, isWeapon, partName, quarryArithmetic, statsAt } from '../parts.js';
import { overclockOption } from '../mechanics.js';
import { helpAttributes } from './teaching.js';
import { inspectorReason } from '../availability.js';
import { $, escape, phone } from './dom.js';
import { partArt } from './icons.js';
import { planComparison } from './compare.js';
export function inspectorMarkup(state: RunState, cell: bigint, blocked = false): string {
  const p = partAt(state, cell), tier = tierAt(state, cell), s = statsAt(state, cell), oc = overclockOption(state, cell);
  const before = previewLanes(state).reduce((n, l) => n + l.leaks, 0n);
  const option = (type: 'upgrade' | 'sell' | 'overclock', title: string, cost: string) => {
    let reason = inspectorReason(state, cell, type), delta = '', compare = '';
    
    try { if (reason) throw new Error(reason); const next = applyAction(state, { type, cell } as Action); const after = previewLanes(next).reduce((n, l) => n + l.leaks, 0n); delta = `walls lost ${before} → ${after}`; compare = planComparison(state, next); }
    catch (error) { reason ||= error instanceof Error ? error.message : 'Unavailable'; }
    return `<button class="act ${reason || blocked ? 'off' : ''}" data-command="${type}" ${type === 'overclock' ? 'data-help="Overclock" aria-describedby="help-Overclock"' : ''} data-comparison="${escape(compare)}" ${reason || blocked ? 'disabled' : ''} aria-label="${escape(`${title}: ${reason || cost}${delta ? ` · ${delta}` : ''}`)}">${title}<span class="c">${escape(reason || cost)}</span>${delta ? `<small class="walls-delta">${delta}</small>` : ''}</button>`;
  };
  const row = (name: string, value: unknown, total = false) => `<div class="r ${total ? 'total' : ''}"><span>${name}</span><b>${value}</b></div>`;
  const math = isWeapon(p) ? row(`Base ${s.base} × tier ${tier}`, s.base * tier) + row('Adjacent Forge × tier', `+${s.forge * tier}`) + row('Strongest Watchtower × tier', `+${s.watch * tier}`) + row('Overclock · this wave', `+${s.overclock}`) + row(p === P.BALLISTA ? 'Each tick, front group' : 'Each tick, every unit', `${s.value} dmg`, true)
    : p === P.PALISADE ? row(`${C.PALISADE_HP} HP × tier ${tier}${oc.charged ? ` + ${C.OVERCLOCK_HP} Overclock` : ''}`, s.hp, true)
    : p === P.QUARRY ? row('Base + adjacent + deep', `${s.income}g/wave`, true)
    : p === P.FORGE ? row('Adjacent Ballista / Cauldron', `+${C.FORGE_BALLISTA * tier} / +${C.FORGE_CAULDRON * tier}`, true)
    : row('Row damage / range', `+${s.tier * C.WATCH_DAMAGE} / +${C.WATCH_RANGE}`, true);
  const actions = `<div class="actions-preview"><label class="label action-forecast">Compare walls left after <select id="inspect-preview" aria-label="Compare inspector action"><option value="upgrade">Upgrade</option><option value="overclock">Overclock</option><option value="sell">Sell</option></select></label><div class="actions3">${option('upgrade', 'Upgrade', tier < 3n ? `${upgradeCost(p, tier)}g` : 'Max tier')}${option('overclock', 'Overclock', oc.charged ? 'Charged' : tier === 3n && p <= P.PALISADE ? `${C.OVERCLOCK_COST}g · +${oc.gain}${oc.hp ? ' HP' : ' dmg'}` : p > P.PALISADE ? 'Combat parts only' : '8g at T3')}${option('sell', 'Sell', `+${sellValue(p, tier)}g`)}</div><p class="investment-line" id="action-comparison" data-help-note="Forecast assumes no further purchases; stops when walls fall"></p></div>`;
  return `<div class="inspector-heading"><span class="plate t${tier}">${partArt(p, 34)}</span><div><h2 class="h2">${partName(p)}</h2><span class="label" ${helpAttributes('Tier')}>Tier ${tier} · Lane ${cell / 4n + 1n} · Depth ${cell % 4n + 1n}</span></div><button class="icon-btn" data-command="close-inspector" aria-label="Close inspector"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></button></div>
    ${actions}<div class="math" data-help-note="${escape(isWeapon(p) ? damageArithmetic(s) : p === P.QUARRY ? quarryArithmetic(s) : '')}">${math}${isWeapon(p) ? `<p class="sub damage-formula">${escape(damageArithmetic(s)).replace(/ = (.*)$/, '<strong class="formula-result">= $1</strong>')}</p>` : ''}</div>
    <p class="sub inspector-rule">${escape(isWeapon(p) ? `Reaches D${s.low}–D${s.high}. ${p === P.BALLISTA ? 'Overkill carries within target group.' : `Brutes block ${C.BRUTE_SPLASH_ARMOR} pooled splash/unit.`}` : p === P.QUARRY ? quarryArithmetic(s) : p === P.PALISADE ? `Blocks entry to its cell · ${s.hp} HP. Heals next wave.` : 'Only active parts provide support.')}${p !== P.PALISADE ? ' Trampled if enemies step on it (off this wave).' : ''}${isWeapon(p) ? ' Purple cells supply this weapon.' : ''}${p <= P.PALISADE ? ' Overclock: 8g at T3 · +50% damage or +12 HP for one wave.' : ''}</p>
`;
}
export function renderInspector(state: RunState, cell: bigint | null, blocked: boolean): void {
  const node = $('#inspector');
  node.hidden = cell === null;
  if (cell === null) { delete node.dataset.inspectedCell; return; }
  node.dataset.inspectedCell = String(cell);
  node.innerHTML = `<div class="inspector-content">${inspectorMarkup(state, cell, blocked)}</div>`;
  const first = node.querySelector<HTMLElement>('[data-comparison]:not(:disabled)');
  const comparison = node.querySelector<HTMLElement>('#action-comparison');
  if (comparison) comparison.textContent = first?.dataset.comparison ?? '';
  const selector = node.querySelector<HTMLSelectElement>('#inspect-preview');
  if (selector && first) selector.value = first.dataset.command!;
  node.classList.toggle('phone-sheet', phone());
}
