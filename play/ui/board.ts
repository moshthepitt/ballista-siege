import { cellSlots, cellGroupLayout, enemyBodySize, type BodySpec, type GroupBox } from '../cell-groups.js';
import { damageNumberPosition, supportBadgePosition } from './layout.js';
import { boostedWeapons, supportLinks } from '../board-teaching.js';
import { helpAttributes } from './teaching.js';
import { C, PART as P } from '../../src/v1/constants.js';
import { forecast, neighbors, partAt, type EnemyGroup, type LanePreview, type RunState, type TickFrame } from '../../src/v1/sim.js';
import { enemyDetails, groupHp } from '../insights.js';
import { isWeapon, partName, supportingCells } from '../parts.js';
import { $, escape, phone } from './dom.js';
import { art, enemyArt, partArt } from './icons.js';
import { groupTrack, incomingSlots, tileReadout, bossSavings, verdictPreview, liveVerdict, heavyLane, incomingQuiet, chipText, type Phase } from './model.js';

interface HpFlash { text: string; until: number }
const foeFlashes = new Map<bigint, HpFlash>(), fenceFlashes = new Map<bigint, HpFlash>();
function applyFlash(node: HTMLElement | null, entry?: HpFlash): void {
  if (!node) return;
  if (!entry || entry.until <= Date.now()) {
    if (node.dataset.restore !== undefined) node.innerHTML = node.dataset.restore;
    node.classList.remove('hit'); delete node.dataset.restore; delete node.dataset.flashUntil; return;
  }
  if (node.dataset.flashUntil !== String(entry.until)) {
    node.dataset.restore = node.innerHTML; node.dataset.flashUntil = String(entry.until); node.textContent = entry.text; node.classList.add('hit');
  }
}
function applyHpFlashes(): void {
  document.querySelectorAll<HTMLElement>('#board [data-group]').forEach(n => {
    const entry = foeFlashes.get(BigInt(n.dataset.group!));
    let pop = n.querySelector<HTMLElement>('.foe-damage');
    if (!entry || entry.until <= Date.now()) { pop?.remove(); return; }
    if (!pop) { pop = document.createElement('span'); pop.className = 'foe-damage'; n.append(pop); }
    pop.textContent = entry.text;
    pop.dataset.help = 'Damage'; pop.dataset.helpNote = `${entry.text} HP lost`; pop.dataset.hitGroup = n.dataset.group!;
    if (n.closest('[data-spawn]')) {
      if (!n.querySelector('.foe')) { pop.remove(); return; }
    pop.style.visibility = 'hidden';
    const chip = n.querySelector<HTMLElement>('.foe')!, lane = n.closest<HTMLElement>('[data-cell], [data-spawn]')!;
    const size = pop.getBoundingClientRect();
    const obstacles = [...document.querySelectorAll<HTMLElement>('#board :is(.foe,.pill,.tier-tag,.tag,.fence-number,.verdict,.ticktag,.heavy-tag,.trample-label,.ruler,.lanehead,.foe-damage,.shield-pop,.contact-damage)')]
      .filter(el => el !== pop && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      .map(el => el.getBoundingClientRect());
    const spot = damageNumberPosition(chip.getBoundingClientRect(), lane.getBoundingClientRect(), size, obstacles, $('#board').getBoundingClientRect().top + 4);
    if (spot) {
      const actor = n.getBoundingClientRect();
      pop.style.left = `${spot.left + size.width / 2 - actor.left}px`; pop.style.top = `${spot.top - actor.top}px`; pop.style.bottom = 'auto'; pop.style.visibility = 'visible';
    }
      return;
    }
    const band = n.querySelector<HTMLElement>('.group-cue');
    if (band) {
      band.prepend(pop); pop.style.cssText = '';
      positionGroupCue(pop);
    }
  });
  document.querySelectorAll<HTMLElement>('#board [data-cell]').forEach(n => applyFlash(n.querySelector('.fence-number'), fenceFlashes.get(BigInt(n.dataset.cell!))));
}
/** Recorded readouts can use empty cell space without moving bodies. */
export function positionGroupCue(node: HTMLElement): void {
  const cell = node.closest<HTMLElement>('[data-cell]'), band = node.parentElement;
  if (!cell || !band) return;
  const obstacles = [...cell.querySelectorAll<HTMLElement>('.foe,.pill,.tier-tag,.tag,.fence-number,.trample-label,.foe-damage,.shield-pop,.contact-damage,.unit-body:not(.vacant)')]
    .filter(el => el !== node && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
    .map(el => {
      const r = el.getBoundingClientRect(), pad = el.classList.contains('unit-body') ? 4 : 0;
      return { left: r.left-pad, top: r.top-pad, right: r.right+pad, bottom: r.bottom+pad };
    });
  const bounds = cell.getBoundingClientRect(), size = node.getBoundingClientRect();
  const collision = obstacles.some(r => Math.min(size.right,r.right)-Math.max(size.left,r.left)>2 && Math.min(size.bottom,r.bottom)-Math.max(size.top,r.top)>2);
  if (collision || size.right > bounds.right || size.left < bounds.left) {
    const spot = damageNumberPosition({ ...size.toJSON(), top: bounds.bottom - 1 }, bounds, size, obstacles, bounds.top + 1);
    if (spot) {
      const origin = band.getBoundingClientRect();
      Object.assign(node.style, { position: 'absolute', left: `${spot.left-origin.left}px`, top: `${spot.top-origin.top}px`, bottom: 'auto', transform: 'none' });
    }
  }
}
function hpFlash(map: Map<bigint, HpFlash>, id: bigint, text: string, ms = 650): void {
  const entry = { text, until: Date.now() + ms }; map.set(id, entry); applyHpFlashes();
  setTimeout(() => { if (map.get(id) === entry) { map.delete(id); applyHpFlashes(); } }, ms);
}
export const flashFoeHp = (group: bigint, text: string, ms = 650) => hpFlash(foeFlashes, group, text, ms);
export const flashFenceHp = (cell: bigint, text: string, ms = 650) => hpFlash(fenceFlashes, cell, text, ms);
export function clearHpFlashes(): void { foeFlashes.clear(); fenceFlashes.clear(); applyHpFlashes(); }

export const cellNode = (cell: bigint) => $(`[data-cell="${cell}"]`);
/** Chips describe one unit's HP; bodies and chip share a single keyed actor. */
export function foeMarkup(g: EnemyGroup): string {
  if (!g.count) return '';
  const wounded = g.count > 1n && g.hp < g.bodyHp;
  return `<span class="foe ${g.kind === 'boss' ? 'boss' : ''}" data-enemy-inspect="${g.id}" data-help-enemy="${g.kind === 'boss' ? g.bossPattern : g.kind}" data-help-note="${escape(enemyDetails(g))}" aria-label="${escape(chipText(g))}. ${escape(enemyDetails(g))}"><span class="n">${g.count}</span><span class="times">×</span><span class="h">${art('heart', 9)}${g.count > 1n ? g.bodyHp : g.hp}</span>${wounded ? `<span class="front-hp" aria-hidden="true"><b style="width:${Number(g.hp * 100n / g.bodyHp)}%"></b></span>` : ''}</span>`;
}
export function formationMarkup(g: EnemyGroup, removed = 0): string {
  const count = Math.min(6, Number(g.count) + removed);
  return `<span class="formation ${g.kind}" data-units="${count}" data-pattern="${g.bossPattern ?? ''}" aria-hidden="true">${Array.from({ length: count }, (_, unit) => `<span class="unit-body ${g.kind}${g.kind === 'boss' ? ' siege-body' : ''}${unit < removed ? ' vacant' : ''}" data-unit="${unit}" data-front="${unit === removed}" data-pattern="${g.bossPattern ?? ''}">${unit < removed ? '' : g.kind === 'swarm' ? '<svg width="20" height="20" preserveAspectRatio="xMidYMid meet" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 3H18L10 18Z" fill="#FF5468" stroke="#0B0F17" stroke-width="2" stroke-linejoin="round"/></svg>' : enemyArt(g.kind, g.bossPattern, g.kind === 'boss' ? 48 : 26).replace('viewBox="0 0 48 48"', g.bossPattern === 'last-siege' ? 'viewBox="8 0 32 48"' : 'viewBox="0 0 48 48"').replace('viewBox=', 'preserveAspectRatio="xMidYMid meet" viewBox=')}</span>`).join('')}<span class="count-pips">${Array.from({ length: Math.min(6, Number(g.count)) }, (_, i) => `<i data-unit="${i + removed}"></i>`).join('')}</span></span>${g.kind === 'boss' ? `<span class="bossbar" data-enemy-inspect="${g.id}" data-help-enemy="${g.kind === 'boss' ? g.bossPattern : g.kind}" data-help-note="${escape(bossSavings(g))}"><b style="width:${Number(groupHp(g) * 100n / (g.maxHp || 1n))}%"></b><i style="left:25%"></i><i style="left:50%"></i><i style="left:75%"></i></span>` : ''}`;
}
export function renderIncoming(state: RunState, groups?: readonly EnemyGroup[], settled = false): void {
  const incoming = forecast(state).waves[0];
  for (let lane = 0; lane < 4; lane++) {
    const host = $(`[data-spawn="${lane}"]`);
    const all = settled ? [] : groups ? groups.filter(g => g.lane === BigInt(lane) && (g.status === 'queued' || g.status === 'active' && g.pos === 5n)) : incoming?.lanes[lane] ?? [];
    // The full forecast reserves the grid for the wave, including vacant slots.
    host.classList.toggle('incoming-grid', true);
    host.dataset.slots = String(incoming?.lanes[lane]?.length ?? 0);
    host.querySelector('.quiet')?.remove();
    host.querySelector('.heavy-tag')?.remove();
    const ids = new Set(all.map(g => String(g.id)));
    host.querySelectorAll<HTMLElement>('.spawn-row').forEach(row => {
      if (ids.has(row.dataset.entryId!)) { delete row.dataset.stale; return; }
      if (row.querySelector('.enemy-group')) row.dataset.stale = 'true'; else row.remove();
    });
    for (const { group: g } of incomingSlots(all)) {
      let row = host.querySelector<HTMLElement>(`[data-entry-id="${g.id}"]`);
      if (!row) { row = document.createElement('span'); row.className = 'spawn-row'; row.dataset.entryId = String(g.id); host.append(row); }
      const track = groupTrack(g);
      row.dataset.place = String(g.order);
      row.style.gridColumn = track.column; row.style.gridRow = track.row;
      // Active D5 actors are retained when the queue is refreshed.
      if (!row.querySelector('.enemy-group')) row.innerHTML = `<span class="ticktag" ${helpAttributes('Tick')} data-help-note="arrives on tick ${g.spawnTick}" aria-label="Arrives on tick ${g.spawnTick}"><span class="tick-glyph">◷</span><span class="tick-word">Tick </span>${g.spawnTick}</span><span class="spawn-chip-host">${g.status === 'queued' || !groups ? foeMarkup(g) + formationMarkup(g) : ''}</span>`;
    }
    if (!all.length && !host.querySelector('.enemy-group')) host.innerHTML = `<span class="quiet">${incomingQuiet(!!incoming?.lanes[lane]?.length, settled)}</span>`;
    if (!settled && heavyLane(state) === BigInt(lane)) host.insertAdjacentHTML('beforeend', `<span class="heavy-tag" ${helpAttributes('Heavy')} data-help-note="Extra Brutes in this lane this wave.">Heavy</span>`);
  }
  applyHpFlashes();
}
export function pieceMarkup(state: RunState, cell: bigint, frame?: TickFrame | null, selected = false, ghost = false): string {
  const r = tileReadout(state, cell, frame), s = r.stats;
  if (!s.part) return '';
  const charged = !!((state.overclocked ?? 0n) & (1n << cell));
  const pips = `<span class="pips"><b class="tier-tag" ${helpAttributes('Tier')}>T${s.tier}</b>${'<i></i>'.repeat(Number(s.tier))}${charged && !r.off ? '<span class="tag oc">OC</span>' : ''}</span>`;
  const compact = isWeapon(s.part) ? `${s.value}` : s.part === P.FORGE ? `+${C.FORGE_BALLISTA * s.tier}/+${C.FORGE_CAULDRON * s.tier}` : s.part === P.WATCHTOWER ? `+${C.WATCH_DAMAGE * s.tier}/±${C.WATCH_RANGE}` : `${s.income}g`;
  if (s.part === P.PALISADE) return `<span class="fence ${r.broken ? 'broken' : ''} ${ghost ? 'ghost' : ''} ${selected ? 'sel' : ''} ${charged ? 'oc' : ''}">${pips}${art(r.broken ? 'broken' : 'fence', 150)}<span class="fhp"><span class="bar"><b style="width:${Number(r.hp * 100n / s.hp)}%"></b></span><span class="fence-number" data-help-note="${r.hp}/${s.hp} HP"><span class="readout-full">${phone() ? `${r.hp} hp` : `${r.hp}/${s.hp}`}</span><span class="readout-compact">${r.hp}</span></span></span></span>`;
  return `<span class="piece ${r.off ? 'disabled-piece' : ''}"><span class="plate t${s.tier} ${selected ? 'sel' : ''} ${ghost ? 'ghost' : ''} ${r.off ? 'off' : ''} ${charged ? 'oc' : ''}">${pips}${partArt(s.part)}</span><span class="pill ${r.off ? 'off-tag' : ''}" data-help-note="${escape(r.pill)}"><span class="readout-full">${r.pill}</span><span class="readout-compact">${compact}</span></span></span>${r.off ? '<span class="trample-label" data-help-note="Trampled · off this wave"><span class="trample-full">Trampled · off this wave</span><span class="trample-brief">Off this wave</span><span class="trample-tiny">Off</span></span>' : ''}`;
}
export interface BoardOptions { phase: Phase; frame?: TickFrame | null; inspected?: bigint | null; target?: boolean; ghost?: { cell: bigint; state: RunState } | null; preview?: LanePreview[]; candidate?: LanePreview[]; causes?: string[]; warnings?: ReadonlyMap<bigint, bigint> }
export function renderParts(state: RunState, options: BoardOptions): void {
  const planned = options.ghost?.state ?? state;
  const boosts = options.ghost ? boostedWeapons(state, planned) : [];
  const rangeCell = options.ghost?.cell ?? options.inspected;
  const rangeStats = rangeCell == null ? null : tileReadout(planned, rangeCell, options.frame).stats;
  const warnings = options.phase === 'build' ? options.warnings ?? new Map<bigint, bigint>() : new Map<bigint, bigint>();
  const supporting = options.inspected == null ? [] : supportingCells(planned, options.inspected);
  for (let i = 0n; i < 16n; i++) {
    const node = cellNode(i), p = partAt(state, i), ghost = options.ghost?.cell === i;
    const readout = tileReadout(state, i, options.frame);
    node.classList.toggle('target', !!options.target && !p);
    node.classList.toggle('trampled', readout.off);
    node.classList.toggle('overclocked', !!((state.overclocked ?? 0n) & (1n << i)));
    node.setAttribute('aria-label', `Lane ${i / 4n + 1n}, depth ${i % 4n + 1n}, ${p ? `${partName(p)} tier ${readout.tier}${readout.off ? ', trampled' : ''}${readout.broken ? ', broken' : ''}` : 'empty'}`);
    let html = pieceMarkup(ghost ? options.ghost!.state : state, i, options.frame, options.inspected === i, ghost) + (warnings.has(i) ? `<span class="trample-warning" data-help="Trample" aria-describedby="help-Trample" data-help-note="Forecast: off from tick ${warnings.get(i)}. ${escape(partName(partAt(planned, i)))} will be trampled if you fight with this build."><span class="forecast-label">Forecast:</span><span class="forecast-long">off from tick ${warnings.get(i)}</span><span class="forecast-short">off ◷${warnings.get(i)}</span><span class="forecast-tiny">Forecast◷${warnings.get(i)}</span></span>` : '');
    const boost = boosts.find(b => b.cell === i);
    if (boost) html = html.replace(/<span class="pill[^"]*"[^>]*><span class="readout-full">[^<]*<\/span><span class="readout-compact">[^<]*<\/span><\/span>/, `<span class="pill boost-pill" data-help-note="+${boost.bonus} bonus, ${boost.damage} damage total"><b>+${boost.bonus}</b><span>${boost.damage}<span class="boost-unit"> dmg</span></span></span>`);
    const layer = node.querySelector<HTMLElement>('.part-layer')!;
    if (layer.innerHTML !== html) layer.innerHTML = html;
    const inspected = options.inspected;
    const s = rangeStats;
    const inrange = s && isWeapon(s.part) && i / 4n === rangeCell! / 4n && Number(i % 4n + 1n) >= s.low && Number(i % 4n + 1n) <= s.high;
    const support = rangeCell != null && (s?.part === P.WATCHTOWER ? i % 4n === rangeCell % 4n : s?.part === P.FORGE || s?.part === P.QUARRY ? neighbors(rangeCell).includes(i) : s?.part === P.PALISADE ? i / 4n === rangeCell / 4n && i % 4n === rangeCell % 4n + 1n : false);
    node.classList.toggle('inrange', !!inrange || !!support);
    node.classList.toggle('supporting', supporting.includes(i));
    node.classList.toggle('preview-boost', !!boost);
  }
  for (let lane = 0n; lane < 4n; lane++) $(`[data-spawn="${lane}"]`).classList.toggle('inrange', !!rangeStats && isWeapon(rangeStats.part) && rangeCell! / 4n === lane && rangeStats.high >= 5);
  if (options.preview) renderVerdicts(options.preview, options.candidate, false, options.causes, undefined, forecast(state).waves[0]?.lanes);
  layoutFoeCells();
  drawSupportLinks(planned, options.phase === 'build', options.ghost?.cell);
  applyHpFlashes();
}
export function renderVerdicts(preview: LanePreview[], candidate?: LanePreview[], cleared = false, causes: string[] = [], battleGroups?: readonly EnemyGroup[], spawned?: readonly EnemyGroup[][]): void {
  preview.forEach((p, lane) => {
    const node = $(`[data-wall="${lane}"]`), v = verdictPreview(p, candidate?.[lane]);
    const groups = battleGroups?.filter(g => g.lane === BigInt(lane));
    const live = groups ? liveVerdict(p.leaks, groups) : null;
    const empty = spawned && !spawned[lane]?.length;
    const text = empty ? 'No enemies' : live?.text ?? (v.kind === 'leak' ? cleared ? `Leaked −${p.leaks}` : v.text : cleared ? 'Cleared' : v.text);
    const kind = empty ? 'quiet' : live?.kind ?? (v.kind === 'leak' ? 'leak' : text === 'Cleared' ? 'clear' : 'hold');
    const why = v.was ? 'if you place it' : causes[lane];
    node.dataset.leaked = String(groups?.filter(g => g.status === 'leaked').length ?? 0);
    const losses = [...(node.querySelectorAll?.('.wall-loss') ?? [])];
    node.innerHTML = `<span class="verdict-row">${v.was ? `<span class="was">${v.was}</span><span class="preview-arrow" aria-hidden="true">›</span>` : ''}<span class="verdict ${kind} ${v.was ? 'preview' : ''}">${text}</span></span>${why ? `<span class="why">${escape(why)}</span>` : ''}${node.dataset.stormHit ? `<span class="storm-tag" ${helpAttributes('Storm')}>Storm</span>` : ''}`;
    if (losses.length) node.append(...losses);
  });
}
const chipRect = (actor: HTMLElement) => (actor.querySelector<HTMLElement>('.foe') ?? actor).getBoundingClientRect();
/** Keep the keyed actor through movement; each destination owns its slots. */
export function renderFoes(groups: readonly EnemyGroup[], frame?: TickFrame | null, before?: readonly EnemyGroup[], moveMs = 0, retainDead = false, priorRects?: Map<string, DOMRect>): void {
  const existing = new Map([...document.querySelectorAll<HTMLElement>('#board .enemy-group')].map(n => [n.dataset.group!, n]));
  const previousPos = new Map([...existing].map(([id, n]) => [id, n.dataset.pos]));
  const previous = priorRects ?? new Map([...existing].map(([id, n]) => [id, chipRect(n)]));
  const visible = groups.filter(g => g.status === 'active' && g.count > 0n || retainDead && g.status === 'dead' && existing.has(String(g.id)));
  const visibleIds = new Set(visible.map(g => String(g.id)));
  for (const [id, actor] of existing) if (!visibleIds.has(id)) actor.remove();
  for (const g of visible) {
    let host: HTMLElement;
    if (g.pos === 5n) {
      const row = document.querySelector<HTMLElement>(`[data-entry-id="${g.id}"] .spawn-chip-host`);
      if (!row) continue;
      host = row;
    } else host = cellNode(g.lane * 4n + (g.pos > 0n ? g.pos - 1n : 0n)).querySelector<HTMLElement>('.foes')!;
    let actor = existing.get(String(g.id));
    if (!actor) { actor = document.createElement('span'); actor.className = 'enemy-group'; actor.dataset.group = String(g.id); }
    actor.classList.toggle('boss-group', g.kind === 'boss');
    actor.classList.toggle('wide-chip', g.kind === 'brute' && (g.count > 1n ? g.bodyHp : g.hp) >= 10n);
    actor.classList.toggle('dying', g.status === 'dead');
    actor.classList.toggle('exiting', g.pos === 0n);
    actor.classList.toggle('blocked', !!frame?.palisades.some(p => p.cell === g.lane * 4n + g.pos - 2n && p.hp > 0n));
    actor.style.order = String(g.order); actor.style.zIndex = String(8 - Number(g.order)); actor.dataset.pos = String(g.pos); actor.dataset.count = String(g.count); actor.dataset.kind = g.kind;
    const track = groupTrack(g);
    actor.dataset.place = String(g.order);
    actor.style.gridColumn = track.column; actor.style.gridRow = track.row;
    actor.setAttribute('aria-label', enemyDetails(g)); actor.dataset.helpNote = enemyDetails(g);
    const prior = before?.find(p => p.id === g.id);
    const removed = prior?.pos === g.pos && prior.count > g.count ? Number(prior.count - g.count) : 0;
    const html = foeMarkup(g) + '<span class="group-cue"></span>' + (g.status === 'dead' ? '' : formationMarkup(g, removed));
    if (actor.dataset.markup !== html) { actor.innerHTML = html; actor.dataset.markup = html; }
    if (actor.parentElement !== host) { if (g.pos === 5n) host.innerHTML = ''; host.append(actor); }
  }
  document.querySelectorAll<HTMLElement>('.spawn-row[data-stale]').forEach(row => { if (!row.querySelector('.enemy-group')) row.remove(); });
  document.querySelectorAll<HTMLElement>('#board .foes').forEach(host => {
    const n = host.children.length; host.dataset.groups = String(n); host.classList.toggle('crowded', n > 2);
  });
  layoutFoeCells();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const g of visible) {
    const actor = document.querySelector<HTMLElement>(`#board .enemy-group[data-group="${g.id}"]`)!;
    if (!actor) continue;
    const rect = chipRect(actor), old = previous.get(String(g.id));
    // Queued chips already occupy their D5 slot; activation has no travel.
    if (moveMs && old && previousPos.get(String(g.id)) !== String(g.pos)) {
      const dx = old.left - rect.left, dy = old.top - rect.top;
      const endY = g.pos === 0n ? $(`[data-wall="${g.lane}"]`).getBoundingClientRect().top - rect.top : 0;
      actor.style.setProperty('--exit-y', `${endY}px`);
      const timing: KeyframeAnimationOptions = { duration: reduced ? Math.min(120, moveMs) : moveMs, easing: g.pos === 0n ? 'ease-in' : 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' };
      actor.animate(reduced ? [{ opacity: .4 }, { opacity: 1 }] : [
        { transform: `translate(${dx}px,${dy}px)` }, { transform: `translate(0,${endY}px)` },
      ], timing);
      // Bodies travel; landing labels retain their reserved bands during arrivals.
      if (!reduced && g.pos > 0n) actor.querySelector<HTMLElement>('.foe')?.animate([
        { transform: `translate(${-dx}px,${-dy}px)` }, { transform: 'translate(0,0)' },
      ], timing);
      if (g.pos === 0n) actor.style.transform = `translateY(${endY}px)`;
    }
  }
  applyHpFlashes();
}
export function drawLeakPaths(lanes: readonly bigint[]): void {
  const board = $('#board'), svg = $<HTMLElement>('.leak-paths'), bounds = board.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  svg.innerHTML = [...new Set(lanes.map(String))].map(lane => {
    const top = cellNode(BigInt(lane) * 4n + 3n).getBoundingClientRect(), wall = $(`[data-wall="${lane}"]`).getBoundingClientRect();
    const x = top.left - bounds.left + top.width * .2, y = top.top - bounds.top + 12, end = wall.top - bounds.top;
    return `<path d="M${x} ${y}V${end}" fill="none" stroke="#0B0F17" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 12"/><path d="M${x} ${y}V${end}" fill="none" stroke="#FF5468" stroke-width="4" stroke-linecap="round" stroke-dasharray="2 12"/><path d="m${x - 8} ${end - 4} 8 16 8-16Z" fill="#FF5468" stroke="#0B0F17" stroke-width="2"/>`;
  }).join('');
}

/** Thin links stay in board coordinates; labels sit between cells. */
export function drawSupportLinks(state: RunState, build: boolean, ghost?: bigint): void {
  const svg = document.querySelector<SVGElement>('#links');
  if (!svg) return;
  if (!build) { svg.innerHTML = ''; return; }
  const bounds = $('#board').getBoundingClientRect();
  const obstacles = [...document.querySelectorAll<HTMLElement>('#board :is(.trample-warning,.pill,.tier-tag,.tag,.fence-number,.ruler,.lanehead,.foe,.ticktag,.heavy-tag,.verdict,.why)')]
    .filter(n => n.getClientRects().length).map(n => n.getBoundingClientRect());
  svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  svg.innerHTML = supportLinks(state).map(link => {
    const a = cellNode(link.from).getBoundingClientRect(), b = cellNode(link.to).getBoundingClientRect();
    const sameRow = link.from % 4n === link.to % 4n;
    const x1 = a.left - bounds.left + a.width / 2, x2 = b.left - bounds.left + b.width / 2;
    const y1 = a.top - bounds.top + a.height * .35, y2 = b.top - bounds.top + b.height * .35;
    const anchorX = sameRow ? x2 + Math.sign(x1 - x2) * (b.width / 2 + 2) : x1;
    const anchorY = sameRow ? y1 : (Math.min(a.bottom, b.bottom) + Math.max(a.top, b.top)) / 2 - bounds.top;
    const spot = supportBadgePosition({ x: anchorX + bounds.left, y: anchorY + bounds.top }, bounds, obstacles);
    const x = spot.x - bounds.left, y = spot.y - bounds.top;
    obstacles.push({ left: spot.x - 13, right: spot.x + 13, top: spot.y - 9, bottom: spot.y + 9 } as DOMRect);
    return `<g class="tether ${link.kind} ${link.from === ghost || link.to === ghost ? 'proposed' : ''}"><desc>+${link.bonus} damage before overclock and caps</desc><path d="M${x1} ${y1}L${x2} ${y2}"/><rect x="${x - 13}" y="${y - 9}" width="26" height="18" rx="5"/><text x="${x}" y="${y + 4}">+${link.bonus}</text></g>`;
  }).join('');
}

function boxStyle(node: HTMLElement | null, box: GroupBox): void {
  if (node) Object.assign(node.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
}
/** Geometry is measured after parts render, and reused by every recorded cue. */
export function layoutFoeCells(): void {
  document.querySelectorAll<HTMLElement>('#board .cell').forEach(cell => {
    const host = cell.querySelector<HTMLElement>('.foes')!;
    const actors = [...host.querySelectorAll<HTMLElement>(':scope > .enemy-group')];
    const prior = new Map(actors.filter(a => a.dataset.slotCell === cell.dataset.cell).map(a => [BigInt(a.dataset.group!), Number(a.dataset.cellSlot)]));
    const assigned = cellSlots(actors.map(a => ({ id: BigInt(a.dataset.group!), order: BigInt(a.dataset.place!) })), prior);
    cell.classList.toggle('occupied-combat', actors.length > 0);
    const part = cell.querySelector<HTMLElement>('.piece, .fence');
    const tag = cell.querySelector<HTMLElement>('.trample-label');
    const hasTag = !!tag || cell.classList.contains('being-trampled');
    const dense = actors.length > 1 && (Math.max(...assigned.values()) > 1 || cell.clientWidth < 120 && cell.clientHeight < 100 && (!!part || hasTag));
    cell.classList.toggle('dense-cell', dense);
    cell.classList.toggle('compact-part', actors.length > 0 && !!part);
    const partHeight = part ? part.getBoundingClientRect().height + 2 : 0;
    const specs = new Map<bigint, BodySpec>(actors.map(a => [BigInt(a.dataset.group!), { kind: a.dataset.kind as BodySpec['kind'], count: Number(a.querySelector<HTMLElement>('.formation')?.dataset.units ?? a.dataset.count), size: enemyBodySize(a.dataset.kind as BodySpec['kind'], innerWidth, innerHeight) }]));
    const geometry = cellGroupLayout(cell.clientWidth, cell.clientHeight, assigned, partHeight, hasTag ? dense ? 14 : 16 : 0, new Set(actors.filter(a => a.classList.contains('boss-group')).map(a => BigInt(a.dataset.group!))), specs);
    host.dataset.groups = String(actors.length);
    for (const actor of actors) {
      const layout = geometry.get(BigInt(actor.dataset.group!))!;
      actor.classList.toggle('compact-group', !!layout.compact);
      actor.classList.toggle('tight-group', !!layout.tight);
      actor.dataset.cellSlot = String(layout.slot); actor.dataset.slotCell = cell.dataset.cell!;
      const chip = actor.querySelector<HTMLElement>('.foe');
      boxStyle(chip, layout.label);
      if (chip) { chip.style.width = 'max-content'; chip.style.maxWidth = `${layout.label.width}px`; }
      const formation = actor.querySelector<HTMLElement>('.formation');
      boxStyle(formation, layout.body);
      if (formation) {
        const size = specs.get(BigInt(actor.dataset.group!))!.size;
        formation.style.setProperty('--body-size', `${size}px`);
        actor.dataset.bodySize = String(size);
        const units = Number(formation.dataset.units), columns = layout.compact ? 1 : Math.max(1, Math.floor(layout.body.width / size));
        formation.style.gridTemplateColumns = `repeat(${columns},minmax(0,1fr))`;
        formation.style.gridTemplateRows = `repeat(${layout.compact ? 1 : Math.ceil(units / columns)},minmax(0,1fr))`;
      }
      boxStyle(actor.querySelector('.group-cue'), layout.cue);
      boxStyle(actor.querySelector('.bossbar'), layout.bar);
    }
  });
}
