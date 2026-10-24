import { branchWallCurve } from '../experiment.js';
import { lastTryDelta, type LastTry } from '../retry.js';
import { C } from '../../src/v1/constants.js';
import { applyAction, type Action, type FightResult, type RunState } from '../../src/v1/sim.js';
import { laneCauses } from '../insights.js';
import { plural, settlementRows, settlementText } from '../copy.js';
import { wallLosses, type ReplayStep } from '../replay.js';
import { $, escape, button, phone } from './dom.js';
import { lossReport, costliestCause } from './loss-report.js';
import { helpAttributes } from './teaching.js';
import { payout, scoreRows, actionRows } from './model.js';
import { clearBattleEffects } from './battle.js';
import { drawLeakPaths, renderParts, renderFoes, renderIncoming } from './board.js';
export interface Recap { start: RunState; built: RunState; result: FightResult; timeline: ReplayStep[]; beforeLoss?: bigint; actions?: readonly Action[]; original?: Recap }
export interface Best { score: bigint; wave: bigint; won: boolean; current: boolean }
export function renderRecapBuild(recap: Recap | undefined, fallback: RunState): void {
  const built = recap?.built ?? fallback;
  clearBattleEffects(true); drawLeakPaths([]);
  renderParts(built, { phase: 'end' }); renderFoes([]); renderIncoming(built, [], true);
  $('.battlefield').dataset.endLabel = `Wave ${recap?.result.state.wave ?? fallback.wave} build`;
}
export function saveBest(state: RunState, completedBest?: Best): Best {
  if (completedBest) return { ...completedBest };
  let best: Best = { score: state.score, wave: state.wave, won: state.won, current: true };
  try {
    const key = `ballista:siege:v1:${state.mode}:${state.seed}`, raw = localStorage.getItem(key);
    if (raw) {
      const saved = JSON.parse(raw) as { score: string; wave: string; won?: boolean };
      if (/^\d+$/.test(saved.score) && /^\d+$/.test(saved.wave) && BigInt(saved.score) > state.score)
        best = { score: BigInt(saved.score), wave: BigInt(saved.wave), won: saved.won ?? BigInt(saved.wave) === 10n, current: false };
    }
    localStorage.setItem(key, JSON.stringify({ score: String(best.score), wave: String(best.wave), won: best.won }));
  } catch { /* Finished report remains usable without browser storage. */ }
  return best;
}
export function summaryMessage(recap: Recap): string {
  const lost = recap.built.walls - recap.result.state.walls;
  return lost ? `${lost} ${plural(lost, 'wall')} lost · ${recap.result.summary.kills} ${plural(recap.result.summary.kills, 'kill')}` : 'Every lane held';
}
export function laneDetail(recap: Recap, lane?: bigint): string {
  return recap.result.summary.lanes.flatMap((l, i) => lane !== undefined && lane !== BigInt(i) ? [] : [`<section class="sec"><h3 class="h2">Lane ${i + 1}</h3><p class="sub">${l.kills} ${plural(l.kills, 'kill')} · ${laneDamage(recap, BigInt(i))} HP damage dealt · ${l.damage} wall damage requested</p>${laneCauses(recap.built, recap.timeline, BigInt(i)).map(c => `<div class="log-row"><span class="t">T${c.tick}</span><span>${escape(c.text)}</span><span class="v">${c.phase}</span></div>`).join('')}</section>`]).join('');
}
function laneDamage(recap: Recap, lane: bigint): bigint {
  let damage = 0n;
  for (const step of recap.timeline) for (const before of step.before.filter(g => g.lane === lane && g.status === 'active')) {
    const after = step.frame.groups.find(g => g.id === before.id);
    const hp = (g: typeof before) => g.count ? g.hp + (g.count - 1n) * g.bodyHp : 0n;
    if (after) damage += hp(before) - hp(after);
  }
  return damage;
}
export function renderSettlement(recap: Recap, lastTry?: LastTry): void {
  const node = $('#settlement'), s = recap.result.summary;
  const losses = wallLosses(recap.built, recap.timeline);
  const laneLosses = s.lanes.map((l, i) => ({ lane: i, damage: l.damage, loss: losses.find(v => v.lane === BigInt(i)) })).filter(l => l.damage);
  node.hidden = false; node.setAttribute('aria-hidden', 'false');
  node.dataset.total = String(payout(s));
  const rows = settlementRows(s);
  node.innerHTML = `<div class="settlement-body"><div class="settlement-content">${replanComparison(recap)}<div class="rail-title"><h2>Wave ${s.wave} settled</h2><span class="label">Tick 10 of 10</span></div>${lastTryDelta(lastTry, s.wave, recap.result.state.walls) ? `<p class="last-try-delta">${recap.result.state.walls} walls left · ${lastTryDelta(lastTry, s.wave, recap.result.state.walls)}</p>` : ''}<div class="loss-list">${laneLosses.slice(0, 2).map(l => `<div class="loss"><span class="lane">L${l.lane + 1}</span><p class="sub">${escape(l.loss ? `${l.loss.name} ${l.loss.storm ? 'stormed' : 'reached'} the wall` : 'Survivors reached the wall')}</p><span class="amt">−${l.damage}</span></div>`).join('') || '<div class="loss held"><span class="lane">✓</span><p class="sub">All four lanes held</p><span class="amt">0 lost</span></div>'}</div><div class="sec receipt-section"><span class="label">Gold earned</span><div class="receipt" ${helpAttributes('Gold')}>${rows.map(([label, amount]) => `<div class="r"><span>${label}</span><b>+${amount}</b></div>`).join('')}<div class="r total"><span>Total</span><b>+${payout(s)}g</b></div></div></div><p class="settlement-inline" ${helpAttributes('Gold')}>${escape(settlementText(s))}</p></div></div><button class="disclose" data-command="summary-detail">› Lane by lane detail</button>`;
}
export function costliestIndex(recaps: readonly Recap[]): number {
  return recaps.reduce((best, r, i) => r.built.walls - r.result.state.walls > recaps[best].built.walls - recaps[best].result.state.walls ? i : best, 0);
}
export function reportMarkup(recaps: readonly Recap[]): string {
  return recaps.map(r => `<section class="sec"><h3 class="h2">Wave ${r.result.state.wave} · ${r.built.walls - r.result.state.walls} walls lost</h3>${lossReport(r.built, r.timeline).map(c => `<div class="log-row"><span class="t">T${c.tick}</span><span>${escape(c.text)}</span><span class="v">${c.phase}</span></div>`).join('') || '<p class="sub">No walls lost.</p>'}</section>`).join('') || '<p class="sub">Restored chain run. This browser has no earlier wave frames.</p>';
}
export function renderEnd(state: RunState, recaps: readonly Recap[], selected: number, best: Best, practice: boolean, blocked: boolean, lastTry?: LastTry, originals?: readonly Recap[]): void {
  const branch = originals ? recaps.find(r => r.original) : undefined;
  const branchResult = branch?.result.state;
  if (originals) recaps = originals.map(r => r.result.state.wave === branchResult?.wave ? branch! : r);
  const phoneView = phone();
  const recap = recaps[selected], costliest = (originals ?? recaps)[costliestIndex(originals ?? recaps)], lost = costliest ? costliest.built.walls - costliest.result.state.walls : 0n;
  const branchCurve = branchResult ? branchWallCurve((originals ?? []).map(r => r.result.state), branchResult) : [];
  const points = (rows: readonly { wave: bigint; walls: bigint }[]) => rows.map(r => `${Number(r.wave) * 10 - 5},${100 - Number(r.walls) * 5}`).join(' ');
  const causes = recap ? lossReport(recap.built, recap.timeline) : [];
  const node = $('#end-screen'); node.hidden = false;
  node.innerHTML = `<div class="end-report rail"><div class="sec-head"><h2 class="h2">Walls left after each wave</h2><span class="sub">Started with ${C.START_WALLS}</span>${phoneView ? button('full-report', 'Full report ›', 'btn btn-quiet phone-report') : ''}</div>
    <div class="wall-chart" aria-label="Walls remaining after each wave">${originals ? `<svg class="branch-curve original-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Original wall curve"><polyline points="${points(originals.map(r => r.result.state))}"/></svg><svg class="branch-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Replanned wall curve"><polyline points="${points(branchCurve)}"/></svg>` : ''}${lastTry ? `<svg class="last-try-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Last try wall curve"><polyline points="${lastTry.walls.map((walls, i) => `${i * 10 + 5},${100 - walls * 5}`).join(' ')}"/></svg>` : ''}${Array.from({ length: 10 }, (_, i) => {
      const r = (originals ?? recaps).find(r => r.result.state.wave === BigInt(i + 1));
      return `<button class="chart-column ${(originals ?? recaps).indexOf(r!) === selected ? 'selected' : ''}" data-recap-wave="${(originals ?? recaps).indexOf(r!)}" aria-pressed="${(originals ?? recaps).indexOf(r!) === selected}" ${!r ? 'disabled' : ''} aria-label="Replan wave ${i + 1}, ${r?.result.state.walls ?? 'unplayed'} walls"><span>${r?.result.state.walls ?? '—'}</span><i style="--walls:${r ? Number(r.result.state.walls) : 0}" class="${r && r.built.walls > r.result.state.walls ? 'lost-walls' : ''} ${r && r === costliest && r.built.walls > r.result.state.walls ? 'costliest' : ''} ${r?.result.state.won ? 'won' : ''}"></i><small>${i + 1}</small></button>`;
    }).join('')}</div>${originals ? `<p class="sub branch-key">Bars + grey line: original · Gold: replan W${branchResult?.wave}; later waves: no more purchases</p>` : ''}<p class="sub">Tap any wave to replan its starting build.</p>${lastTry ? '<p class="sub last-try-key">Faint line: last try</p>' : ''}<p class="sub costliest-note">${costliest ? `<b>Costliest: wave ${costliest.result.state.wave}, −${lost}.</b> ${escape(costliestCause(costliest.built, costliest.timeline))}` : 'Wave history unavailable for restored run.'}</p>
    <div class="end-analysis"><div class="end-causes"><div class="sec-head"><span class="label">Wave ${recap?.result.state.wave ?? state.wave} · Wall losses by tick</span></div><div class="log">${causes.map(c => `<div class="log-row"><span class="t">T${c.tick}</span><span>${escape(c.text)}</span><span class="v">${c.phase}</span></div>`).join('') || '<p class="sub">All lanes held.</p>'}</div></div><div class="end-board-slot"></div></div><div class="end-report-actions">${phoneView ? '' : button('full-report', '› Full report, every wave')}${button('copy', '▢ Copy share text')}</div></div>
    <div class="end-result rail"><div class="end-result-content"><div class="sec"><div class="phase-tag ${state.won ? 'done' : 'lost'}">${practice ? 'UNRANKED REPLAN' : state.won ? 'RUN WON' : 'RUN LOST'}</div><h1 class="display">${practice ? `Wave ${state.wave} replanned` : state.won ? 'The wall held' : `The wall fell on wave ${state.wave}`}</h1><p class="sub">${practice ? `${state.walls} walls remain. One wave, unranked.` : state.won ? `Survived all ${state.wave} waves, ${state.walls} ${plural(state.walls, 'wall')} to spare.` : `${state.totalKills} enemies killed. Same seed, another plan.`}</p></div>${recap ? replanComparison(recap) : ''}<div class="score-card" ${helpAttributes('Score')}><div class="score-total"><span class="label">Score</span><strong class="display tnum">${state.score}</strong></div><div class="receipt" ${helpAttributes('Score')}>${scoreRows(state).map(row => `<div class="r"><span>${row.label} <small>${row.count} × ${row.weight}</small></span><b>${row.points} pts</b></div>`).join('')}<div class="r total"><span>Best on seed ${state.seed}</span><b>${best.score}${best.current && !practice ? ' · this run' : best.won ? ' · won' : ''}</b></div></div></div></div><div class="end-secondary">${practice ? button('return-result', 'Return to result', 'btn btn-2') : button('replan-wave', `Replan wave ${recap?.result.state.wave ?? state.wave} · beat −${recap ? recap.built.walls - recap.result.state.walls : 0n}`, 'btn btn-2')}${button('new-seed', 'New seed')}${button('copy', '▢', 'btn btn-quiet phone-copy')}</div></div>`;
  node.querySelectorAll<HTMLButtonElement>('[data-command="replan-wave"]').forEach(b => { b.disabled = blocked || !recap; });
}

export function replanComparison(recap: Recap): string {
  if (recap.beforeLoss === undefined) return '';
  const now = recap.built.walls - recap.result.state.walls;
  const original = recap.original;
  if (!original) return `<p class="replan-comparison ${now < recap.beforeLoss ? 'better' : now > recap.beforeLoss ? 'worse' : 'same'}">Before −${recap.beforeLoss} → now −${now}</p>`;
  const old = planMetrics(original), revised = planMetrics(recap);
  const orders = (r: Recap) => actionRows(r.start, r.actions ?? []).all.map(o => `<li>${escape(o.text)}</li>`).join('') || '<li>No actions</li>';
  return `<section class="replan-comparison ${now < old.loss ? 'better' : now > old.loss ? 'worse' : 'same'}"><b>Wave ${recap.result.state.wave} experiment</b><table><thead><tr><th></th><th>Original</th><th>Revised</th></tr></thead><tbody><tr><th>Walls lost</th><td>−${old.loss}</td><td>−${revised.loss}</td></tr><tr><th>Gold spent</th><td>${old.spent}g</td><td>${revised.spent}g</td></tr><tr><th>Actions used</th><td>${old.actions}/6</td><td>${revised.actions}/6</td></tr></tbody></table><details><summary>Compare plans</summary><div class="plan-columns"><div><b>Original</b><ol>${orders(original)}</ol></div><div><b>Revised</b><ol>${orders(recap)}</ol></div></div></details><button class="btn btn-2" data-command="replay-experiment">Replay from first difference</button></section>`;
}
export function planMetrics(recap: Recap) {
  let state = recap.start, spent = 0n;
  for (const action of recap.actions ?? []) {
    const next = applyAction(state, action);
    if (next.gold < state.gold) spent += state.gold - next.gold;
    state = next;
  }
  return { loss: recap.built.walls - recap.result.state.walls, spent, actions: recap.built.actionsUsed };
}
/** Compare combat consequences, excluding gold grants and score that cannot change an attack. */
export function firstDifference(original: Recap, revised: Recap): number {
  const combat = (s: ReplayStep) => JSON.stringify([s.frame.groups, s.frame.shots, s.frame.splashes, s.frame.bites, s.frame.palisades, s.frame.tramples, s.frame.leaks], (_, v: unknown) => typeof v === 'bigint' ? String(v) : v);
  const index = revised.timeline.findIndex((s, i) => !original.timeline[i] || combat(s) !== combat(original.timeline[i]));
  return index < 0 ? 0 : index;
}
