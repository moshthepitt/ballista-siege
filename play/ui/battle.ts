import { forecast, leakDamage, type EnemyGroup, type RunState, type TickFrame } from '../../src/v1/sim.js';
import { statsAt } from '../parts.js';
import { plural } from '../copy.js';
import { hitSnapshot, ordinaryMovement, wallContactSnapshot, isStorm, hasStormSurvivors, playTimeline, presentStorm, stormCharges, firingOrder, PROJECTILE_MS, MOVE_MS, BITE_WINDUP_MS, BITE_CONTACT_MS, STORM_PULSE_MS, STORM_SHAKE_MS, type ReplayStep } from '../replay.js';
import { $, escape, toast } from './dom.js';
import { renderFoes, renderIncoming, renderParts, renderVerdicts, cellNode, layoutFoeCells, positionGroupCue, flashFoeHp, clearHpFlashes } from './board.js';
import { battleLanes, biteTotals, hitReadouts, hitDamageText, bossSavings, type Pop } from './model.js';
import { bossPattern } from '../mechanics.js';
import { biteEffects, blockEffects, unitRemovals, splashCoverage, bountyDelay, bigMomentHolds, supportTrampleEffects } from '../battle-effects.js';
import { art } from './icons.js';
import { positionTutorial } from './tutorial.js';
import { damageNumberPosition } from './layout.js';
import { followMusic, playBattleSounds, settlementSound } from '../audio/game.js';
export interface Playback { skip: boolean; cancelled: boolean; tickMs?: number; wake?: () => void }
export interface BattleCallbacks { speed: () => number; hud: (frame: TickFrame) => void; tick: (tick: bigint, phase: string) => void }
const timers = new Set<ReturnType<typeof setTimeout>>();
const later = (fn: () => void, ms: number) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
export function clearBattleEffects(resetTraces = false): void {
  timers.forEach(clearTimeout); timers.clear(); clearHpFlashes();
  document.querySelectorAll('.wall.hit').forEach(n => n.classList.remove('hit'));
  document.querySelectorAll<HTMLElement>('.wall.storm-hit').forEach(n => { n.classList.remove('storm-hit'); delete n.dataset.stormHit; });
  document.querySelectorAll('.storm-tag').forEach(n => n.remove());
  document.querySelectorAll('.being-trampled, .trample-contact').forEach(n => n.classList.remove('being-trampled', 'trample-contact'));
  const notice = document.querySelector<HTMLElement>('#notice');
  if (notice?.dataset.combat) { notice.hidden = true; delete notice.dataset.combat; }
  document.querySelectorAll('.popband, #travel-effects').forEach(n => { n.innerHTML = ''; });
  document.querySelectorAll('.splash-heat, .shield-pop, .contact-damage').forEach(n => n.remove());
  document.querySelectorAll('.cell-effects > :not(.battle-trace)').forEach(n => n.remove());
  if (resetTraces) {
    document.querySelectorAll('.wall-loss').forEach(n => n.remove());
    document.querySelectorAll('.battle-trace').forEach(n => n.remove());
    document.querySelectorAll('.wall.cracked').forEach(n => n.classList.remove('cracked'));
    $('#game').dataset.leakLanes = '[]';
  }
  document.querySelector('.leak-paths')!.innerHTML = '';
  document.querySelector('#storm-banner')?.remove();
  $('#phase-banner').classList.remove('final-assault');
}
export function renderPop(p: Pop, speed: number): void {
  const host = cellNode(p.cell).querySelector<HTMLElement>('.popband')!;
  host.querySelector(`[data-pop-slot="${p.slot}"]`)?.remove();
  const node = document.createElement('span'); node.className = `pop ${p.kind}`;
  node.dataset.popSlot = String(p.slot); node.dataset.popGroup = String(p.group ?? '');
  node.style.gridColumn = p.column ?? String(p.slot + 1); node.style.gridRow = '1';
  node.style.setProperty('--pop-ms', `${650 / speed}ms`);
  node.textContent = p.text; node.dataset.helpNote = p.title ?? '';
  node.addEventListener('animationend', () => node.remove(), { once: true });
  host.append(node); later(() => node.remove(), 650 / speed);
}
export interface LogLine { tick: bigint; text: string; value: string; kills?: bigint }
const foeName = (g: EnemyGroup) => g.kind === 'boss' ? g.bossPattern === 'gatebreaker' ? 'Gatebreaker' : 'Last Siege' : g.kind === 'swarm' ? 'Swarm' : 'Brute';
export function frameLog(step: ReplayStep, built?: RunState): LogLine[] {
  const f = step.frame, out: LogLine[] = [];
  for (const h of hitReadouts(step)) {
    const g = step.before.find(g => g.id === h.group)!;
    const source = h.bolt && h.splash ? 'Ballista + Cauldron' : h.splash ? 'Cauldron' : 'Ballista';
    out.push({ tick: f.tick, text: `L${g.lane + 1n} ${source} ${h.kills ? 'kills' : 'hits'} ${foeName(g)}${h.kills ? ` ×${h.kills}` : ''}`, value: h.applied ? `${h.splash && !h.bolt ? h.splash - h.blockedSplash : h.bolt - h.blockedBolt + (h.splash - h.blockedSplash) * g.count} dmg` : 'Blocked', kills: h.kills });
    if (h.blockedBolt) out.push({ tick: f.tick, text: `${foeName(g)} shield blocks ${h.blockedBolt} bolt damage`, value: '' });
    if (h.blockedSplash) out.push({ tick: f.tick, text: `Brute armour blocks ${h.blockedSplash} splash`, value: '' });
    if (h.bounty) out.push({ tick: f.tick, text: `${g.kind === 'boss' ? 'Boss' : 'Brute'} bounty`, value: `+${h.bounty}g` });
  }
  for (const bite of f.bites) {
    const g = step.before.find(g => g.id === bite.group)!;
    if (!bite.damage) {
      if (g.bossPattern === 'gatebreaker') out.push({ tick: f.tick, text: 'Gatebreaker rests (odd tick)', value: '' });
      continue;
    }
    const hp = f.palisades.find(p => p.cell === bite.cell)?.hp ?? 0n;
    out.push({ tick: f.tick, text: `L${g.lane + 1n} ${foeName(g)} bites the fence`, value: built ? `${hp}/${statsAt(built, bite.cell).hp}` : `${hp} HP left` });
  }
  for (const t of f.tramples) out.push({ tick: f.tick, text: `L${t.cell / 4n + 1n} D${t.cell % 4n + 1n} trampled`, value: 'Off' });
  for (const l of f.leaks) out.push({ tick: f.tick, text: `L${l.lane + 1n} survivors reach wall`, value: `−${l.damage} walls` });
  for (const g of f.groups) if (g.status === 'active' && step.before.find(p => p.id === g.id)?.status === 'queued')
    out.push({ tick: f.tick, text: `L${g.lane + 1n} ${foeName(g)} arrives`, value: '' });
  return out;
}
export function renderBattlePanel(built: RunState, frame: TickFrame | null, log: readonly LogLine[], speed: number, tick = frame?.tick ?? 1n): void {
  const groups = frame?.groups ?? [], kills = built.totalKills;
  const all = groups.reduce((n, g) => n + (g.status === 'dead' ? 0n : g.count), 0n);
  const boss = frame?.groups.find(g => g.kind === 'boss'), name = forecast(built).waves[0]?.boss;
  const bossGold = log.filter(l => l.text === 'Boss bounty').reduce((n, l) => n + BigInt(l.value.replace(/[^\d]/g, '') || 0), 0n);
  const rule = boss?.status === 'dead' ? `${name?.name} defeated${bossGold ? ` · +${bossGold}g` : ''}` : boss?.status === 'leaked' ? `${name?.name} breached · −${leakDamage(boss)} walls` : name ? `${bossPattern(name, tick)}${boss && boss.status !== 'queued' ? ` · ${name.name} ${boss.hp}/${boss.maxHp} HP · ${bossSavings(boss)}` : ''}` : '';
  const lanes = battleLanes(built, frame);
  renderVerdicts(lanes, undefined, false, lanes.map(l => `${l.kills} ${plural(l.kills, 'kill')}`), frame?.groups ?? forecast(built).waves[0]?.lanes.flat());
  $('#battle-panel').innerHTML = `<div class="rail-title"><h2>Battle</h2><span class="label">${speed}× speed</span></div>${rule ? `<div class="battle-rule rule-pill ${boss?.status === 'active' ? 'boss-live' : ''}"><span class="battle-rule-text">${escape(rule)}</span>${boss?.status === 'active' ? `<span class="boss-live-label">${escape(`${name?.name} ${boss.hp}/${boss.maxHp} HP · ${bossSavings(boss)}`)}</span>` : ''}</div>` : ''}<div class="battle-stats"><div><span class="label">Walls</span><b class="display">${frame?.walls ?? built.walls}</b></div><div><span class="label">Kills</span><b class="display">${lanes.reduce((n, l) => n + l.kills, 0n)}</b></div><div><span class="label">Bounty</span><b class="display">+${log.filter(l => l.text.includes('bounty')).reduce((n, l) => n + BigInt(l.value.replace(/[^\d]/g, '') || 0), 0n)}g</b></div></div><div class="battle-log-head sec-head"><span class="label">What just happened</span><span class="sub">newest first</span></div><div class="log" aria-live="off">${[...log].reverse().slice(0, 8).map(l => `<div class="log-row"><span class="t">T${l.tick}</span><span>${escape(l.text)}</span><span class="v">${escape(l.value)}</span></div>`).join('') || '<p class="sub">The siege is arriving.</p>'}</div><span class="sr-only" role="note" aria-label="${kills} prior kills; ${all} survivors"></span>`;
  $('#battle-panel').scrollTop = 0;
}
function effectAt(cell: bigint, cls: string, duration: number, content = ''): void {
  const el = document.createElement('span'); el.className = cls; el.innerHTML = content;
  cellNode(cell).querySelector('.cell-effects')!.append(el); later(() => el.remove(), duration);
}
function animateNode(node: Element | null, frames: Keyframe[], ms: number, easing = 'ease-out'): void {
  node?.animate(matchMedia('(prefers-reduced-motion: reduce)').matches ? [{ opacity: .5 }, { opacity: 1 }] : frames, { duration: Math.max(1, ms), easing });
}
const actorNode = (id: bigint) => document.querySelector<HTMLElement>(`#board .enemy-group[data-group="${id}"]`);
function coinToHud(cell: bigint, amount: bigint, ms: number, land: () => void, origin?: DOMRect): void {
  const start = origin ?? cellNode(cell).getBoundingClientRect(), end = $('#gold-number').getBoundingClientRect();
  const el = document.createElement('span'); el.className = 'flying-coin'; el.innerHTML = art('coin', 22); el.dataset.helpNote = `+${amount}g`;
  el.style.left = `${start.left + start.width / 2}px`; el.style.top = `${start.top + start.height / 2}px`; $('#travel-effects').append(el);
  animateNode(el, [{ transform: 'translate(0,0)', opacity: 1 }, { transform: `translate(${end.left - start.left - start.width / 2}px,${end.top - start.top - start.height / 2}px)`, opacity: 0 }], ms);
  later(() => { el.remove(); land(); animateNode($('#gold-number'), [{ transform: 'translateY(4px)', color: '#fff' }, { transform: 'translateY(0)', color: '#FFC145' }], 180); }, ms);
}
/** A projectile travels to the keyed victim's bodies at their firing position. */
function projectile(from: bigint, id: bigint, ms: number, splash = false): void {
  const target = actorNode(id)?.querySelector('.formation');
  if (!target) return;
  const origin = cellNode(from).querySelector('.plate')!.getBoundingClientRect(), end = target.getBoundingClientRect();
  const x = origin.left + origin.width / 2, y = origin.top + origin.height / 2;
  const dx = end.left + end.width / 2 - x, dy = end.top + end.height / 2 - y;
  const trail = document.createElement('span'); trail.className = 'projectile-trail';
  trail.innerHTML = `<svg width="100%" height="100%"><path d="M${x} ${y} ${splash ? `Q${x + dx * .5 + 28} ${y + dy * .5 - 60}` : 'L'} ${x + dx} ${y + dy}" fill="none" stroke="${splash ? '#FF8A4C' : '#5AA9FF'}" stroke-width="${splash ? 7 : 4}" stroke-linecap="round"/></svg>`;
  $('#travel-effects').append(trail);
  const trailMs = ms * (1 + 400 / PROJECTILE_MS);
  animateNode(trail, [{ opacity: .85 }, { opacity: .7, offset: ms / trailMs }, { opacity: 0 }], trailMs);
  later(() => trail.remove(), trailMs);
  const node = document.createElement('span'); node.className = splash ? 'splash-travel' : 'shot-travel';
  node.style.left = `${x}px`; node.style.top = `${y}px`; $('#travel-effects').append(node);
  animateNode(node, splash ? [
    { transform: 'translate(0,0) scale(.6)' }, { transform: `translate(${dx * .5 + 14}px,${dy * .5 - 30}px) scale(1.3)`, offset: .5 }, { transform: `translate(${dx}px,${dy}px) scale(1)` },
  ] : [{ transform: 'translate(0,0)' }, { transform: `translate(${dx}px,${dy}px)` }], ms);
  later(() => node.remove(), ms);
}
function deathBodies(group: EnemyGroup, step: ReplayStep, speed: number): void {
  const actor = actorNode(group.id), bodies = actor?.querySelectorAll<HTMLElement>('.unit-body') ?? [];
  for (const removal of unitRemovals(step, group.id)) {
    const body = bodies[removal.unit]; if (!body) continue;
    const pip = actor?.classList.contains('compact-group') && body.dataset.front !== 'true';
    const source = pip ? actor!.querySelector(`.count-pips i[data-unit="${removal.unit}"]`) : body;
    if (!source) continue;
    const r = source.getBoundingClientRect(), ghost = document.createElement('span');
    ghost.className = `death-body ${group.kind}${group.kind === 'boss' ? ' siege-body' : ''}${pip ? ' pip-death' : ''}`; ghost.innerHTML = pip ? '' : body.innerHTML;
    ghost.dataset.pattern = group.bossPattern ?? '';
    Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    $('#travel-effects').append(ghost);
    const delay = removal.at / speed, duration = removal.duration / speed;
    ghost.dataset.deathGroup = String(group.id); ghost.dataset.unit = String(removal.unit);
    animateNode(ghost, [{ filter: 'brightness(3)' }, { filter: 'brightness(1)' }], 160 / speed);
    ghost.animate([{ opacity: 1, transform: 'scale(1) rotate(0)' }, { opacity: .9, transform: 'scale(.8, .3) rotate(25deg)', offset: .6 }, { opacity: 0, transform: 'scale(.2) rotate(60deg)' }], { delay, duration, fill: 'forwards' });
    const burst = document.createElement('span'); burst.className = `death-burst ${group.kind}`;
    burst.innerHTML = '<i></i>'.repeat(8); Object.assign(burst.style, { left: `${r.left + r.width / 2}px`, top: `${r.top + r.height / 2}px` });
    burst.style.setProperty('--death-ms', `${duration}ms`); burst.style.setProperty('--death-delay', `${delay}ms`);
    $('#travel-effects').append(burst); later(() => { ghost.remove(); burst.remove(); }, delay + duration);
  }
}
function splashImpact(id: bigint, speed: number): void {
  const actor = actorNode(id); if (!actor) return;
  const r = (actor.querySelector('.formation') ?? actor).getBoundingClientRect();
  const ring = document.createElement('span'); ring.className = 'splash-impact';
  Object.assign(ring.style, { left: `${r.left + r.width / 2}px`, top: `${r.top + r.height / 2}px` });
  ring.style.setProperty('--ring-ms', `${600 / speed}ms`); $('#travel-effects').append(ring);
  later(() => ring.remove(), 600 / speed);
}
function incomingShieldPop(group: EnemyGroup, text: string, speed: number): void {
  const actor = actorNode(group.id);
  const formation = actor?.querySelector('.formation') ?? document.querySelector(`.death-body[data-death-group="${group.id}"]`);
  if (!formation) return;
  const cellNodeAtHit = group.pos === 5n ? $(`[data-spawn="${group.lane}"]`) : cellNode(group.lane * 4n + group.pos - 1n);
  // Brute stacks sharing a cell share one armour caption; each recorded body still reacts.
  if (text.startsWith('Armour') && cellNodeAtHit.querySelector('.shield-pop[data-kind="armour"]')) return;
  const host = actor ?? cellNodeAtHit.querySelector('.cell-effects') ?? cellNodeAtHit;
  const shield = document.createElement('span'); shield.className = 'shield-pop';
  shield.dataset.kind = text.startsWith('Armour') ? 'armour' : 'halved';
  shield.dataset.hitGroup = String(group.id);
  shield.innerHTML = `${text.startsWith('Armour') ? '' : '<svg width="9" height="11" viewBox="0 0 14 16" aria-hidden="true"><path d="M7 1 13 3v5c0 3-3 5-6 7C4 13 1 11 1 8V3Z" fill="#C9D3E3" stroke="#0B0F17" stroke-width="1.5"/></svg>'}<span>${text}</span>`;
  shield.style.visibility = 'hidden'; host.append(shield);
  const cell = cellNodeAtHit.getBoundingClientRect();
  const body = formation.getBoundingClientRect();
  const obstacles = [...document.querySelectorAll<HTMLElement>('#board :is(.foe,.pill,.tier-tag,.tag,.fence-number,.ticktag,.heavy-tag,.trample-label,.foe-damage,.shield-pop,.contact-damage)')]
    .filter(n => n !== shield && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').map(n => n.getBoundingClientRect());
  const place = () => {
    const size = shield.getBoundingClientRect();
    const bottomEdge = cell.bottom - (shield.classList.contains('tight') && !shield.classList.contains('stacked') ? 1 : 0);
    let spot = damageNumberPosition({ ...body.toJSON(), top: Math.min(body.bottom + size.height + 3, bottomEdge + 2) }, cell, size, obstacles, cell.top + 1);
    // Dense stacks can leave a gap between the ordinary damage-number rows.
    for (let bottom = bottomEdge; !spot && bottom >= cell.top + size.height + 1; bottom--)
      spot = damageNumberPosition({ ...body.toJSON(), top: bottom + 2 }, cell, size, obstacles, cell.top + 1);
    return spot;
  };
  let spot = place();
  if (!spot && shield.dataset.kind === 'armour') { shield.classList.add('tight'); spot = place(); }
  if (!spot && shield.dataset.kind === 'armour') {
    shield.classList.add('stacked');
    shield.innerHTML = '<span class="armour-word">Armour</span><span>−1</span>';
    spot = place();
  }
  if (spot) {
    const origin = host.getBoundingClientRect();
    shield.style.left = `${spot.left - origin.left}px`; shield.style.top = `${spot.top - origin.top}px`; shield.style.visibility = 'visible';
  } else shield.dataset.noSpace = JSON.stringify({ cell: cell.toJSON(), size: shield.getBoundingClientRect().toJSON(), obstacles });
  animateNode(shield, [{ opacity: 0, filter: 'brightness(2)' }, { opacity: 1, filter: 'brightness(1.3)', offset: .2 }, { opacity: 1, filter: 'brightness(1)' }], 160 / speed);
  later(() => shield.remove(), 500 / speed);
}
function shieldPop(group: EnemyGroup, text: string, speed: number): void {
  if (group.pos === 5n) { incomingShieldPop(group, text, speed); return; }
  const actor = actorNode(group.id);
  const formation = actor?.querySelector('.formation') ?? document.querySelector(`.death-body[data-death-group="${group.id}"]`);
  if (!formation) return;
  const cellNodeAtHit = group.pos === 5n ? $(`[data-spawn="${group.lane}"]`) : cellNode(group.lane * 4n + group.pos - 1n);
  const host = actor?.querySelector('.group-cue') ?? cellNodeAtHit.querySelector('.cell-effects') ?? cellNodeAtHit;
  const shield = document.createElement('span'); shield.className = 'shield-pop';
  shield.dataset.kind = text.startsWith('Armour') ? 'armour' : 'halved';
  shield.dataset.hitGroup = String(group.id);
  shield.dataset.helpNote = text;
  shield.innerHTML = `<span>${text.startsWith('Armour') ? '◈1' : '÷2'}</span>`;
  host.append(shield); positionGroupCue(shield);
  animateNode(shield, [{ opacity: 0, filter: 'brightness(2)' }, { opacity: 1, filter: 'brightness(1.3)', offset: .2 }, { opacity: 1, filter: 'brightness(1)' }], 160 / speed);
  later(() => shield.remove(), 500 / speed);
}
function biteContact(cell: bigint, amount: bigint, speed: number): void {
  const host = cellNode(cell), r = host.getBoundingClientRect();
  const fence = host.querySelector('.fence > svg')?.getBoundingClientRect(); if (!fence) return;
  const pop = document.createElement('span'); pop.className = 'contact-damage'; pop.textContent = `−${amount}`;
  const effects = host.querySelector<HTMLElement>('.cell-effects')!;
  pop.style.visibility = 'hidden'; effects.append(pop);
  const size = pop.getBoundingClientRect();
  const obstacles = [...document.querySelectorAll<HTMLElement>('#board :is(.foe,.pill,.tier-tag,.tag,.fence-number,.foe-damage,.shield-pop,.contact-damage)')]
    .filter(n => n !== pop && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').map(n => n.getBoundingClientRect());
  const spot = damageNumberPosition(fence, r, size, obstacles, r.top + 1)
    ?? damageNumberPosition({ ...fence.toJSON(), top: r.bottom + 1 }, r, size, obstacles, r.top + 1);
  if (spot) {
    const origin = effects.getBoundingClientRect();
    pop.style.transform = 'none'; pop.style.left = `${spot.left - origin.left}px`; pop.style.top = `${spot.top - origin.top}px`; pop.style.visibility = 'visible';
  }
  later(() => pop.remove(), 650 / speed);
  animateNode(host.querySelector('.fence > svg'), [
    { transform: 'translateX(0)' }, { transform: 'translateX(-3px) scale(1.04,.9)', offset: .2 }, { transform: 'translateX(3px)', offset: .5 }, { transform: 'translateX(-3px)', offset: .7 }, { transform: 'translateX(0)' },
  ], 150 / speed);
  effectAt(cell, 'bite-contact', 180 / speed);
}
let wallRoll = 0;
function countWalls(from: bigint, to: bigint, speed: number): void {
  const ticket = ++wallRoll;
  for (let step = 0; step <= 8; step++) later(() => {
    if (ticket === wallRoll) $('#walls-number').textContent = String(from - (from - to) * BigInt(step) / 8n);
  }, step * 20 / speed);
}
function fenceShatter(cell: bigint, speed: number): void {
  const trace = document.createElement('span'); trace.className = 'fence-shards battle-trace';
  trace.style.setProperty('--shatter-ms', `${180 / speed}ms`);
  trace.innerHTML = `<i>${art('fence', 100)}</i><i>${art('fence', 100)}</i>`;
  cellNode(cell).querySelector('.cell-effects')!.append(trace);
}
function wallNumber(lane: bigint, amount: bigint, ms: number, land: () => void): void {
  // Keep the loss at the damaged wall. Only the HUD counter rolls after contact.
  animateNode($(`[data-wall="${lane}"] .verdict`), [{ filter: 'brightness(2)', transform: 'scale(1.12)' }, { filter: 'brightness(1)', transform: 'scale(1)' }], ms);
  later(land, ms);
}
async function wait(ms: number, handle: Playback): Promise<void> {
  if (handle.skip || handle.cancelled) return;
  await new Promise<void>(resolve => { const t = setTimeout(() => { handle.wake = undefined; resolve(); }, ms); handle.wake = () => { clearTimeout(t); handle.wake = undefined; resolve(); }; });
}
export async function playBattle(built: RunState, timeline: ReplayStep[], handle: Playback, cb: BattleCallbacks, initial?: TickFrame): Promise<void> {
  const log: LogLine[] = [];
  let disabled = initial?.disabled ?? 0n, gold = initial?.gold ?? built.gold, walls = initial?.walls ?? built.walls;
  let shown: TickFrame | null = initial ?? null, stormDone = false, playingTick: bigint | undefined;
  if (initial) renderParts(built, { phase: 'battle', frame: initial });
  const refresh = (step: ReplayStep, groups: readonly EnemyGroup[]) => {
    shown = { ...step.frame, groups: [...groups], walls, gold, disabled };
    followMusic('battle', built.wave + 1n, groups);
    cb.hud(shown); renderBattlePanel(built, shown, log, cb.speed(), step.frame.tick);
  };
  const foes = (groups: readonly EnemyGroup[], step: ReplayStep, ms = 0, dead = false) => {
    const positions = new Map([...document.querySelectorAll<HTMLElement>('#board .enemy-group')].map(n => [n.dataset.group!, (n.querySelector<HTMLElement>('.foe') ?? n).getBoundingClientRect()]));
    renderIncoming(built, groups); renderFoes(groups, step.frame, step.before, ms, dead, positions);
    $('#game').dataset.activeGroups = String(groups.filter(g => g.status === 'active' && g.count > 0n).length);
  };
  const contactLanes = new Set<bigint>(initial?.groups.filter(g => g.status === 'leaked').map(g => g.lane));
  $('#game').dataset.leakLanes = JSON.stringify([...contactLanes].map(String));
  const recordContacts = (events: TickFrame['leaks']) => { events.forEach(e => contactLanes.add(e.lane)); $('#game').dataset.leakLanes = JSON.stringify([...contactLanes].map(String)); };
  const wallImpact = (step: ReplayStep, leaks: TickFrame['leaks'], groups: readonly EnemyGroup[], storm = false) => {
    recordContacts(leaks);
    for (const lane of new Set(leaks.map(l => l.lane))) {
      const damage = leaks.filter(l => l.lane === lane).reduce((n, l) => n + l.damage, 0n);
      const wall = $(`[data-wall="${lane}"]`); wall.classList.add('cracked');
      if (storm) {
        wall.classList.add('storm-hit'); wall.dataset.stormHit = 'true';
        wall.style.setProperty('--storm-ms', `${STORM_PULSE_MS / cb.speed()}ms`);
        later(() => { wall.classList.remove('storm-hit'); delete wall.dataset.stormHit; wall.querySelector('.storm-tag')?.remove(); }, STORM_PULSE_MS / cb.speed());
      }
      const loss = document.createElement('span'); loss.className = 'wall-loss'; loss.textContent = `−${damage}`;
      loss.dataset.helpNote = `${damage} walls lost`; wall.append(loss);
      setTimeout(() => loss.remove(), bigMomentHolds(step).wallLoss / cb.speed());
      wall.classList.remove('hit');
      if (!storm) {
        void wall.offsetWidth; wall.classList.add('hit');
        later(() => wall.classList.remove('hit'), 650 / cb.speed());
      }
      wallNumber(lane, damage, 360 / cb.speed(), () => {
        const previous = walls; walls = walls > damage ? walls - damage : 0n; refresh(step, shown?.groups ?? groups);
        countWalls(previous, walls, cb.speed());
        animateNode($('#walls-number'), [{ transform: 'translateX(-5px)', color: '#FF5468' }, { transform: 'translateX(5px)', color: '#FF5468' }, { transform: 'translateX(0)', color: '#F5F0E6' }], 260 / cb.speed());
      });
    }
    if (storm && leaks.length && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      animateNode($('#board'), [{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)', offset: .25 }, { transform: 'translateX(-4px)', offset: .5 }, { transform: 'translateX(4px)', offset: .75 }, { transform: 'translateX(0)' }], STORM_SHAKE_MS / cb.speed());
    refresh(step, groups);
  };
  const storm = async (step: ReplayStep, groups: EnemyGroup[]) => {
    const charges = stormCharges(step), ids = new Set(charges.map(c => c.group));
    cb.tick(step.frame.tick, 'Storm charge');
    const banner = $('#phase-banner'); banner.classList.add('final-assault');
    banner.insertAdjacentHTML('beforeend', '<span id="storm-banner" class="storm-banner">Final assault: survivors ignore Palisades</span>');
    await presentStorm(step, cb.speed(), (lane, ms) => {
      if (handle.cancelled) return;
      for (const id of ids) if (groups.find(g => g.id === id)?.lane === lane) actorNode(id)?.classList.add('charging');
      groups = groups.map(g => ids.has(g.id) && g.lane === lane ? { ...g, status: 'active', pos: 0n } : g);
      foes(groups, step, ms); refresh(step, groups);
    }, lane => {
      if (handle.cancelled) return;
      groups = groups.map(g => ids.has(g.id) && g.lane === lane ? { ...g, status: 'leaked' } : g);
      log.push(...frameLog(step, built).filter(l => l.text.startsWith(`L${lane + 1n} survivors`)));
      foes(groups, step); wallImpact(step, step.frame.leaks.filter(l => ids.has(l.group) && l.lane === lane), groups, true);
    }, ms => new Promise(resolve => setTimeout(resolve, ms)));
    if (handle.cancelled) return;
    stormDone = true;
    document.querySelector('#storm-banner')?.remove(); banner.classList.remove('final-assault');
  };
  await playTimeline(timeline, cb.speed, () => handle.cancelled || handle.skip, async (step, phase, ms) => {
    const f = step.frame, hits = hitReadouts(step), hitGroups = hitSnapshot(step);
    if (playingTick !== f.tick) { playingTick = f.tick; handle.tickMs = step.duration; followMusic('battle', built.wave + 1n, step.before, step.duration, cb.speed()); }
    playBattleSounds(step, phase, cb.speed(), (fn, ms) => later(() => { if (!handle.cancelled && (!handle.skip || phase === 'impact')) fn(); }, ms));
    const label = phase[0].toUpperCase() + phase.slice(1);
    cb.tick(f.tick, label);
    if (phase === 'fire') {
      document.querySelectorAll('.popband').forEach(n => { n.innerHTML = ''; });
      foes(step.before, step); refresh(step, step.before);
      document.querySelectorAll<HTMLElement>('.kill-scorch').forEach(n => { if (Number(n.dataset.untilTick) <= Number(f.tick)) n.remove(); });
      const speed = cb.speed(), travel = PROJECTILE_MS / speed;
      for (const shot of firingOrder(f)) later(() => {
        if (handle.skip || handle.cancelled) return;
        animateNode(cellNode(shot.from).querySelector('.plate > svg'), [
          { transform: 'scale(1)' }, { transform: 'translateY(4px) scale(1.15)', offset: .3 }, { transform: 'scale(1)' },
        ], 120 / speed);
        for (const id of shot.targets) projectile(shot.from, id, travel, shot.splash);
        log.push({ tick: f.tick, text: `L${shot.from / 4n + 1n} ${shot.splash ? 'Cauldron' : 'Ballista'} fires`, value: '' });
        renderBattlePanel(built, shown, log, cb.speed(), f.tick);
      }, shot.at / speed);
    }
    if (phase === 'hit') {
      // HP and count resolve together at impact. Independent bodies carry each death.
      const origins = new Map(hits.map(h => [h.group, actorNode(h.group)?.getBoundingClientRect()]));
      for (const hit of hits) {
        const g = step.before.find(g => g.id === hit.group)!;
        if (hit.kills) deathBodies(g, step, cb.speed());
        if (hit.splash) splashImpact(g.id, cb.speed());
        if (hit.kills && g.pos <= 4n) {
          const mark = document.createElement('span'); mark.className = 'kill-scorch battle-trace'; mark.dataset.untilTick = String(f.tick + 1n);
          const fade = Math.min(450, step.phases.hit + step.phases.bite + step.phases.move + step.phases.impact) / cb.speed();
          mark.style.setProperty('--scorch-ms', `${fade}ms`); later(() => mark.remove(), fade);
          cellNode(hit.cell).querySelector('.cell-effects')!.append(mark);
        }
      }
      foes(hitGroups, step, 0, true); refresh(step, hitGroups);
      for (const splash of splashCoverage(built, step, disabled)) for (const cell of splash.cells) {
        const host = cell.depth === 5n ? $(`[data-spawn="${cell.lane}"]`) : cellNode(cell.lane * 4n + cell.depth - 1n).querySelector('.cell-effects')!;
        const heat = document.createElement('span'); heat.className = 'splash-heat';
        host.append(heat); heat.style.setProperty('--heat-ms', `${300 / cb.speed()}ms`); later(() => heat.remove(), 300 / cb.speed());
      }
      // Body cues claim their cell first; damage can then use free space above the group.
      for (const block of blockEffects(step)) shieldPop(step.before.find(g => g.id === block.group)!, block.text, cb.speed());
      for (const hit of hits) {
        const g = step.before.find(g => g.id === hit.group)!;
        // Damage floats above its keyed group; count and HP never yield their place.
        if (hit.applied) flashFoeHp(g.id, hitDamageText(hit, g), Math.min(650, step.phases.hit + step.phases.bite) / cb.speed());
        animateNode(actorNode(g.id)?.querySelector('.formation') ?? null, [{ filter: 'brightness(3)', transform: 'translateY(-3px) scale(1.08)' }, { filter: 'brightness(1)', transform: 'translateY(0) scale(1)' }], 80 / cb.speed());
        if (hit.bounty) later(() => {
          coinToHud(hit.cell, hit.bounty, 260 / cb.speed(), () => { gold += hit.bounty; refresh(step, shown?.groups ?? hitGroups); }, origins.get(g.id));
          if (g.kind === 'boss') {
            toast(`${foeName(g)} down · +${hit.bounty}g`); $('#notice').dataset.combat = 'true';
            log.push(...frameLog(step, built).filter(l => l.text === 'Boss bounty'));
            renderBattlePanel(built, shown, log, cb.speed(), f.tick);
          }
        }, bountyDelay(step, g.id) / cb.speed());
        if (hit.kills && g.kind === 'boss') {
          animateNode($('#board'), [{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], 260 / cb.speed());
        }
      }
      const fireLines = frameLog(step, built).filter(l => !l.text.includes('bites') && !l.text.includes('rests') && !l.text.includes('trampled') && !l.text.includes('reach wall') && !l.text.includes('arrives'));
      log.push(...fireLines.filter(l => l.text !== 'Boss bounty'));
      // Panel kill counter derives from the displayed groups, not the final frame.
      renderBattlePanel(built, shown, log, cb.speed(), f.tick);
      positionTutorial();
    }
    if (phase === 'bite') {
      foes(hitGroups, step, 0, true); refresh(step, hitGroups);
      for (const bite of biteEffects(step)) {
        const formation = actorNode(bite.group)?.querySelector('.formation') ?? null;
        if (bite.kind === 'rest') animateNode(formation, [
          { opacity: .65, transform: 'translateY(2px) scale(.94)' }, { opacity: .4, transform: 'translateY(3px) scale(.92)', offset: .5 }, { opacity: .65, transform: 'translateY(2px) scale(.94)' },
        ], ms);
        else {
          const body = formation?.getBoundingClientRect(), fence = cellNode(bite.cell).querySelector('.fence > svg')?.getBoundingClientRect();
          const reach = body && fence ? Math.max(8, fence.top + fence.height * .25 - body.bottom) : 8;
          const hold = bigMomentHolds(step).fenceBreak, duration = step.phases.bite;
          animateNode(formation, [{ transform: 'translateY(0)' },
            { transform: 'translateY(-5px) scale(.96,1.03)', offset: BITE_WINDUP_MS / duration },
            { transform: `translateY(${reach}px) scale(1.06,.96)`, offset: BITE_CONTACT_MS / duration },
            { transform: `translateY(${reach}px) scale(1.06,.96)`, offset: (BITE_CONTACT_MS + hold) / duration },
            { transform: 'translateY(0)' }], ms, 'linear');
        }
      }
      later(() => {
        renderParts(built, { phase: 'battle', frame: { ...f, disabled } });
        for (const [cell, amount] of biteTotals(f)) if (amount) biteContact(cell, amount, cb.speed());
        for (const p of f.palisades) if (!p.hp && f.bites.some(b => b.cell === p.cell && b.damage)) fenceShatter(p.cell, cb.speed());
        log.push(...frameLog(step, built).filter(l => l.text.includes('bites') || l.text.includes('rests')));
        renderBattlePanel(built, shown, log, cb.speed(), f.tick);
      }, BITE_CONTACT_MS / cb.speed());
    }
    if (phase === 'move') {
      // Hit labels expire before another group can occupy their old cell.
      document.querySelectorAll('.popband').forEach(n => { n.innerHTML = ''; });
      document.querySelectorAll('.contact-damage, .shield-pop').forEach(n => n.remove());
      const moving = ordinaryMovement(step);
      foes(moving, step, Math.min(ms, MOVE_MS / cb.speed())); refresh(step, moving);
      $('#game').dataset.activeGroups = String(moving.filter(g => g.status === 'active' && g.count > 0n).length);
      // Reserve the cell's top edge for its recorded contact tag.
      for (const t of f.tramples) cellNode(t.cell).classList.add('being-trampled');
      layoutFoeCells();
      for (const t of supportTrampleEffects(built, step, disabled)) {
        later(() => {
          const contact = cellNode(t.cell);
          contact.classList.add('trample-contact');
          contact.style.setProperty('--trample-pulse-ms', `${t.pulse / cb.speed()}ms`);
          if (!contact.querySelector('.trample-label')) contact.querySelector('.part-layer')?.insertAdjacentHTML('beforeend', '<span class="trample-label contact-tag"><span class="trample-brief">Off this wave</span></span>');
          later(() => contact.classList.remove('trample-contact'), t.pulse / cb.speed());
          for (const weapon of t.weapons) {
            const target = cellNode(weapon.cell), pill = target.querySelector<HTMLElement>('.pill');
            animateNode(target.querySelector('.plate'), [{ filter: 'brightness(3)' }, { filter: 'brightness(1)' }], 500 / cb.speed());
            if (pill) {
              const previous = pill.innerHTML;
              pill.textContent = `${weapon.oldDamage} → ${weapon.newDamage}`; pill.classList.add('support-loss');
              later(() => { if (pill.isConnected) { pill.innerHTML = previous; pill.classList.remove('support-loss'); } }, 650 / cb.speed());
            }
          }
          effectAt(t.cell, 'dust-burst' , t.duration / cb.speed(), '<i></i><i></i><i></i><i></i><i></i>');
          effectAt(t.cell, 'dust-ring', t.duration / cb.speed());
          animateNode(cellNode(t.cell).querySelector('.plate > svg'), [{ transform: 'rotate(0) scale(1)' }, { transform: 'rotate(-14deg) scale(1.15,.35)', offset: .6 }, { transform: 'rotate(-9deg) scale(1,.5)' }], t.duration / cb.speed());
        }, t.at / cb.speed());
        later(() => {
          disabled |= 1n << t.cell;
          renderParts(built, { phase: 'battle', frame: { ...f, disabled } });
          cellNode(t.cell).classList.remove('being-trampled');
          for (const weapon of t.weapons) {
            const target = cellNode(weapon.cell), pill = target.querySelector<HTMLElement>('.pill');
            animateNode(target.querySelector('.plate'), [{ filter: 'brightness(3)' }, { filter: 'brightness(1)' }], 500 / cb.speed());
            if (pill) {
              const previous = pill.innerHTML;
              pill.textContent = `${weapon.oldDamage} → ${weapon.newDamage}`; pill.classList.add('support-loss');
              later(() => { if (pill.isConnected) { pill.innerHTML = previous; pill.classList.remove('support-loss'); } }, 650 / cb.speed());
            }
          }
          log.push(...frameLog(step, built).filter(l => l.text === `L${t.cell / 4n + 1n} D${t.cell % 4n + 1n} trampled`));
          refresh(step, shown?.groups ?? moving);
        }, t.disabledAt / cb.speed());
      }
      later(() => {
        log.push(...frameLog(step, built).filter(l => l.text.includes('arrives')));
        renderBattlePanel(built, shown, log, cb.speed(), f.tick);
      }, ms);
    }
    if (phase === 'impact') {
      const storms = f.leaks.filter(l => isStorm(step, l.group));
      const stormIds = new Set(storms.map(l => l.group));
      let groups = wallContactSnapshot(step);
      wallImpact(step, f.leaks.filter(l => !stormIds.has(l.group)), groups);
      foes(groups, step);
      if (storms.length) await storm(step, groups);
      disabled = f.disabled; renderParts(built, { phase: 'battle', frame: { ...f, disabled } });
      log.push(...frameLog(step, built).filter(l => l.text.includes('reach wall') && !storms.some(s => l.text.startsWith(`L${s.lane + 1n} `))));
      if (!storms.length) refresh(step, groups);
    }
  }, ms => wait(ms, handle));
  if (handle.cancelled) return;
  const last = timeline.at(-1); if (!last) return;
  if (handle.skip && !stormDone && hasStormSurvivors(last)) {
    // Skip cuts to the deadline, while keeping the wall charge and its verdict readable.
    clearBattleEffects();
    const storms = last.frame.leaks.filter(l => isStorm(last, l.group));
    const ids = new Set(storms.map(l => l.group));
    gold = last.frame.gold - last.frame.goldEvents.filter(e => e.reason !== 'bounty').reduce((n, e) => n + e.amount, 0n);
    walls = timeline.at(-2)?.frame.walls ?? built.walls; disabled = last.frame.disabled;
    let groups = wallContactSnapshot(last);
    recordContacts(timeline.slice(0, -1).flatMap(s => s.frame.leaks));
    foes(groups, last); wallImpact(last, last.frame.leaks.filter(l => !ids.has(l.group)), groups);
    handle.tickMs = last.duration; followMusic('battle', built.wave + 1n, groups, last.duration, cb.speed());
    playBattleSounds(last, 'impact', cb.speed(), (fn, ms) => later(() => { if (!handle.cancelled) fn(); }, ms));
    await storm(last, groups);
    if (handle.cancelled) return;
  }
  clearBattleEffects();
  if (handle.skip) log.splice(0, log.length, ...timeline.flatMap(step => frameLog(step, built)));
  renderParts(built, { phase: 'battle', frame: last.frame }); renderFoes(last.frame.groups, last.frame); renderIncoming(built, [], true);
  // Gold settlement is revealed by the receipt after playback. No empty tail waits.
  recordContacts(timeline.flatMap(s => s.frame.leaks));
  cb.hud({ ...last.frame, gold: handle.skip ? last.frame.gold : gold }); renderBattlePanel(built, last.frame, log, cb.speed());
}

/** Settlement is visible before its coin travels, so the source matches the receipt. */
export function animateSettlementGold(): void {
  settlementSound();
  document.querySelectorAll('.flying-coin').forEach(n => n.remove());
  const row = [...document.querySelectorAll<HTMLElement>('#settlement .receipt-section > .label, #settlement .settlement-inline')].find(n => n.getBoundingClientRect().height > 0);
  if (!row || !row.getBoundingClientRect().height || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const start = row.getBoundingClientRect(), end = $('#gold-number').getBoundingClientRect();
  const coin = document.createElement('span'); coin.className = 'flying-coin'; coin.innerHTML = art('coin', 22);
  const x = start.left + start.width / 2, y = start.top - 24;
  coin.style.left = `${x}px`; coin.style.top = `${y}px`; $('#travel-effects').append(coin);
  const flight = coin.animate([{ transform: 'translate(0,0)', opacity: 1 }, { transform: `translate(${end.left - x}px,${end.top - y}px)`, opacity: 0 }], { duration: 350, easing: 'ease-in', fill: 'forwards' });
  flight.onfinish = () => { coin.remove(); animateNode($('#gold-number'), [{ transform: 'translateY(5px)', opacity: .4 }, { transform: 'translateY(0)', opacity: 1 }], 180); };
  flight.oncancel = () => coin.remove();
  later(() => coin.remove(), 350);
}
