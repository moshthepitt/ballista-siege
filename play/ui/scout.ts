import { lastTryChallenge, type LastTry } from '../retry.js';
import { enemyLessons, glossary, scoutEnemyCopy } from '../teaching.js';
import { helpAttributes } from './teaching.js';
import { guidePage } from './guide.js';
import { C } from '../../src/v1/constants.js';
import { fight, forecast, type RunState, type WaveForecast } from '../../src/v1/sim.js';
import { InvestmentCache } from '../insights.js';
import { bossPattern } from '../mechanics.js';
import { escape } from './dom.js';
import { enemyArt } from './icons.js';
import { bossSavings } from './model.js';
import { incomingTick } from './model.js';
import { CHIP_KEY } from './model.js';
const projections = new InvestmentCache();
function forecastRow(wave: WaveForecast, tick?: bigint): string {
  return `<div class="fc"><span class="w">${tick === undefined ? `W${wave.wave}` : incomingTick(tick)}</span>${wave.lanes.map(lane => `<span class="ln">${lane.filter(g => tick === undefined || g.spawnTick === tick).map(g => `<span class="mini" data-help-enemy="${g.kind === 'boss' ? g.bossPattern : g.kind}" data-help-note="${g.count} ${g.kind} · ${g.bodyHp} HP each · arrives on tick ${g.spawnTick}">${enemyArt(g.kind, g.bossPattern, 14)}<span>${g.count}×</span><span>♥${g.bodyHp}</span></span>`).join('') || '—'}</span>`).join('')}</div>`;
}
export const keysMarkup = () => '<div class="keys sub">' + [['1–4', 'pick'], ['U', 'upgrade'], ['S', 'sell'], ['O', 'overclock'], ['R', 'reroll'], ['Z', 'undo'], ['Space', 'fight / skip'], ['M', 'mute'], ['Esc', 'close']].map(([key, action]) => `<span><span class="kbd">${key}</span> ${action}</span>`).join('') + '</div>';
export function guideMarkup(state?: RunState): string {
  return `<div class="sec"><span class="label">Field guide</span><button class="guide-rule" data-help="Trample">${escape(glossary.Trample)}</button>${Object.entries(enemyLessons).map(([key, lesson]) => `<button class="guide" data-help-enemy="${key}" data-command="enemy-info" data-value="${key}"><span class="gi">${enemyArt(key === 'swarm' || key === 'brute' ? key : 'boss', key === 'gatebreaker' || key === 'last-siege' ? key : undefined, 28)}</span><span><b>${lesson.name}</b><span class="enemy-summary">${escape(state ? scoutEnemyCopy(state, key as keyof typeof enemyLessons) : lesson.copy)}</span></span></button>`).join('')}</div>`;
}
export const fullGuide = () => guidePage();
export function scoutMarkup(state: RunState, entryTicks = false, summary = false, lastTry?: LastTry): string {
  const f = forecast(state), current = f.waves[0], bossWave = state.done ? undefined : f.bosses[0], b = bossWave?.boss;
  const builtBoss = b ? fight({ ...state, wave: bossWave.wave - 1n, overclocked: bossWave.wave === state.wave + 1n ? state.overclocked : 0n }).frames.at(-1)?.groups.find(g => g.kind === 'boss') : undefined;
  const fullBoss = bossWave?.lanes.flat().find(g => g.kind === 'boss');
  const fullHealthLine = fullBoss && builtBoss?.hp !== fullBoss.hp ? `<span class="sub">At full health: ${escape(bossSavings(fullBoss))}</span>` : '';
  const laterBoss = !!b && state.wave < 3n && bossWave.wave > state.wave + 1n;
  const currentThreats = current ? `<div class="sec current-threats"><span class="label">${entryTicks ? 'This wave, by entry tick' : 'This wave · L1 to L4'}</span>${entryTicks ? [...new Set(current.lanes.flat().map(g => String(g.spawnTick)))].map(t => forecastRow(current, BigInt(t))).join('') : forecastRow(current)}</div>` : '';
  const bossCard = b ? `<div class="bossbox"><div class="boss-heading">${enemyArt('boss', b.pattern, 48)}<div><span class="label">Boss · ${bossWave.wave === state.wave + 1n ? 'this wave' : `wave ${bossWave.wave}`}</span><h3 class="display">${b.name}</h3></div><b class="boss-hp">${builtBoss?.hp ?? b.hp}<small>${bossWave.wave > state.wave + 1n ? `Wave ${bossWave.wave} forecast: this board, no more purchases` : 'HP left after your build'}</small></b></div><p class="sub">${escape(bossPattern(b))}. Enters lane ${b.lane + 1n} on tick ${fullBoss?.spawnTick}.</p><div class="boss-rewards"><span class="boss-build">With this build: ${escape(builtBoss ? bossSavings(builtBoss) : 'forecast unavailable')}</span>${fullHealthLine}<span>Kill +${C.BOSS_BOUNTY}g</span></div></div>` : '<p class="sub">Kill every survivor before the tick 10 storm. Fences buy time; they do not stop the storm.</p>';
  return `<div class="rail-title"><h2>Scout</h2><button class="btn btn-quiet guide-open" data-command="guide">Guide</button><span class="label">This wave + next 2</span></div><p class="chip-key">${CHIP_KEY}</p>${lastTry ? `<p class="last-try-challenge">${escape(lastTryChallenge(lastTry))}</p>` : ''}${laterBoss ? `${currentThreats}<details class="future-boss"><summary>Boss wave ${bossWave!.wave}: ${b!.name}</summary>${bossCard}</details>` : bossCard}<p class="sub">After tick 10, survivors storm the wall, even past Palisades.</p>${!laterBoss && entryTicks ? currentThreats : ''}<div class="sec"><span class="label">${summary ? `Next wave: W${current?.wave ?? 10n} + following two` : 'Next two waves · L1 to L4'}</span>${f.waves.slice(summary ? 0 : 1).map(w => forecastRow(w)).join('') || '<p class="sub">Final wave.</p>'}</div><div class="divider"></div>${guideMarkup(state)}${entryTicks ? '<button class="disclose" data-command="projection">› If you buy nothing more: next 3 waves</button>' : ''}<div class="scout-keys">${keysMarkup()}</div>`;
}
export function projectionMarkup(state: RunState): string {
  return '<p class="sub">If you buy nothing more. Each row starts from the preceding result.</p>' + projections.project(state).map(r => `<div class="projection-row"><b>W${r.summary.wave}</b>${r.summary.lanes.map(l => `<span class="verdict ${l.damage ? 'leak' : 'hold'}">${l.damage ? `−${l.damage}` : 'Holds'}</span>`).join('')}<span>${r.state.walls} walls</span></div>`).join('');
}
