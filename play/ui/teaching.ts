import { C, PART as P } from '../../src/v1/constants.js';
import { glossary, incomingHelp, partLesson, receiptHelp, scoreHelp, shopHelp, openingShop, enemyLessons, heavyHelp, type EnemyLesson } from '../teaching.js';
import { partName, isWeapon, ruleCopy } from '../parts.js';
import { $, escape } from './dom.js';
import { partArt, enemyArt } from './icons.js';

export function rangePicture(part: bigint): string {
  const reached = isWeapon(part) ? Array.from({ length: Number((part === P.BALLISTA ? C.BALLISTA_RANGE : C.CAULDRON_RANGE) + 1n) }, (_, i) => i + 2).filter(d => d <= 5) : part === P.PALISADE ? [3] : part === P.FORGE || part === P.QUARRY ? [1, 2, 3] : [2];
  return `<figure class="range-picture"><figcaption>${isWeapon(part) ? 'Example: weapon at D2, firing toward entrance' : part === P.PALISADE ? 'Example: Palisade at D2 holds enemies at D3' : part === P.WATCHTOWER ? 'Row bonus reaches L1, L2, L3 and L4' : part === P.FORGE ? 'Touches across lanes and depths, never diagonally' : 'Example: Quarry at D2'}</figcaption><div class="range-strip" role="img" aria-label="${isWeapon(part) ? `${reached.map(d => d === 5 ? 'Entry' : `D${d}`).join(', ')} reached` : 'Part at D2'}">${[1, 2, 3, 4, 5].map(d => `<span class="${reached.includes(d) ? 'reached' : ''} ${d === 2 ? 'origin' : ''}">${d === 2 ? partArt(part, 24) : ''}<b>${d === 5 ? 'Entry' : `D${d}`}</b></span>`).join('')}</div>${part === P.FORGE ? '<div class="support-picture forge-picture" role="img" aria-label="Forge touches above, below, left and right"><span></span><b>+</b><span></span><b>+</b><b>F</b><b>+</b><span></span><b>+</b><span></span></div>' : part === P.WATCHTOWER ? '<div class="support-picture row-picture" role="img" aria-label="One Watchtower boosts weapons across all four lanes"><b>L1 +</b><b>L2 +</b><b>L3 +</b><b>L4 +</b></div>' : ''}</figure>`;
}
export function partDetail(part: bigint): string {
  const p = partLesson(part);
  return `<article class="part-detail"><div class="lesson-title">${partArt(part, 44)}<h3>${partName(part)}</h3></div><p class="part-job">${escape(p.job)}</p><table class="tier-table"><thead><tr><th>${p.unit}</th>${p.tiers.map((_, i) => `<th>Tier ${i + 1}</th>`).join('')}</tr></thead><tbody><tr><th>Base</th>${p.tiers.map(n => `<td>${n}</td>`).join('')}</tr></tbody></table><p>${escape(p.numbers)}</p><p>${escape(p.range)}</p>${rangePicture(part)}<div><b>Works with</b><p>${escape(p.works)}</p></div><div><b>${part === P.PALISADE ? 'Limit' : 'Weak against'}</b><p>${escape(p.weak)}</p></div>${p.example ? `<p class="lesson-example">${escape(p.example)}</p>` : ''}<p class="lesson-cost"><b>${p.costs.join(' / ')} gold</b><span>Buy / to tier 2 / to tier 3</span></p><p>Selling returns half the buy and upgrade costs, rounded down. Overclock gold is not refunded.</p>${isWeapon(part) ? `<p>${escape(glossary.Overclock)}</p>` : ''}<p>${escape(glossary.Trample)}</p></article>`;
}
export function enemyDetail(key: EnemyLesson): string {
  const lesson = enemyLessons[key];
  return `<article class="enemy-detail"><div class="lesson-title">${enemyArt(key === 'swarm' || key === 'brute' ? key : 'boss', key === 'gatebreaker' || key === 'last-siege' ? key : undefined, 40)}<h3>${lesson.name}</h3></div><p>${escape(lesson.copy)}</p><p>${escape(incomingHelp)}</p></article>`;
}
/** Hover help is a short card. The full article lives behind the card's ⓘ button. */
export function partSummary(part: bigint): string {
  const p = partLesson(part), [buy, second, third] = p.costs;
  return `<article class="part-summary"><div class="summary-head">${partArt(part, 24)}<b>${partName(part)}</b><span class="summary-price">${buy}g</span></div><p class="summary-job">${escape(p.job)}</p><p>${escape(ruleCopy(part))}</p><p class="summary-more">Upgrades ${second}g, then ${third}g. Full details: ⓘ</p></article>`;
}
export const helpCopy: Record<string, string> = { ...glossary, Shop: `${shopHelp} ${openingShop} ${glossary.Reroll}`, Gold: receiptHelp, Score: scoreHelp, Incoming: incomingHelp, Heavy: heavyHelp, Sound: 'Adjust music and effects volume. M toggles mute.' };
/** Screen readers get the help text as a description; sighted players get the hover card. No native title tooltips. */
export const helpAttributes = (key: string) => `data-help="${key}" aria-describedby="help-${key}"`;
export const helpDescriptions = () => `<div id="help-text" hidden>${Object.entries(helpCopy).map(([key, text]) => `<span id="help-${key}">${escape(text)}</span>`).join('')}</div>`;

const HELP = '[data-help-part], [data-help-enemy], [data-help]';
/** A pointer must rest this long on one target before help opens, so sweeping the mouse shows nothing. */
export const HELP_INTENT_MS = 450;
/** After leaving the target, this long to reach the open card. Moving toward it restarts the clock. */
export const HELP_GRACE_MS = 300;
const REST_RADIUS = 10;
/** A hand-moved pointer never jumps this far between two frames. A jump is a warp (scripted input, pen re-entry), not a trip to the card. */
const WARP = 200;
let anchor: HTMLElement | null = null, anchorKey = '', openedBy: 'pointer' | 'focus' = 'pointer';
let candidateKey = '', restX = 0, restY = 0, lastX = NaN, lastY = NaN, suppressedKey = '', tabbing = false, approach = Infinity;
let intentTimer: ReturnType<typeof setTimeout> | undefined, graceTimer: ReturnType<typeof setTimeout> | undefined;
const popover = () => document.querySelector<HTMLElement>('#teaching-popover');
const keyOf = (el: HTMLElement) => el.dataset.helpPart ? `part:${el.dataset.helpPart}` : el.dataset.helpEnemy ? `enemy:${el.dataset.helpEnemy}` : `help:${el.dataset.help}`;
/** The picked card has no hover help: the player is placing it, not reading it. */
function helpTarget(node: EventTarget | null): HTMLElement | null {
  const el = node instanceof Element ? node.closest<HTMLElement>(HELP) : null;
  return !el || el.closest('#teaching-popover') || el.dataset.helpPart && el.querySelector('.card[aria-pressed="true"]') ? null : el;
}
const cancelIntent = () => { clearTimeout(intentTimer); intentTimer = undefined; candidateKey = ''; };
const cancelGrace = () => { clearTimeout(graceTimer); graceTimer = undefined; approach = Infinity; };
/** Grace expiry closes the card but keeps a pending rest on another target. */
function closePopover(): void {
  const pop = popover(); if (pop) pop.hidden = true;
  anchor = null; anchorKey = ''; cancelGrace();
}
export function hideTeaching(): void { closePopover(); cancelIntent(); }
function helpMarkup(el: HTMLElement): string {
  const part = el.dataset.helpPart, enemy = el.dataset.helpEnemy as EnemyLesson | undefined, key = el.dataset.help;
  const note = el.dataset.helpNote ? `<p class="help-note">${escape(el.dataset.helpNote)}</p>` : '';
  if (part) return partSummary(BigInt(part));
  if (enemy && enemy in enemyLessons) return note + enemyDetail(enemy);
  return `<b>${escape(key ?? '')}</b>${note}<p>${escape(helpCopy[key!] ?? '')}</p>`;
}
function showTeaching(el: HTMLElement, by: 'pointer' | 'focus'): void {
  const pop = popover(); if (!pop) return;
  cancelIntent(); cancelGrace();
  const key = keyOf(el);
  if (!pop.hidden && anchorKey === key) { anchor = el; openedBy = by; return; }
  anchor = el; anchorKey = key; openedBy = by;
  pop.innerHTML = helpMarkup(el); pop.scrollTop = 0;
  pop.hidden = false; positionTeaching();
}
/** Renders replace the anchor node. Follow the same help key, or close if it is gone. */
export function positionTeaching(): void {
  const pop = popover();
  if (!pop || pop.hidden) return;
  if (!anchor?.isConnected || !anchor.getClientRects().length) {
    anchor = [...document.querySelectorAll<HTMLElement>(HELP)].find(el => keyOf(el) === anchorKey && el.getClientRects().length && helpTarget(el)) ?? null;
    if (!anchor) { closePopover(); return; }
  }
  const own = anchor.getBoundingClientRect(), rail = anchor.closest('.action-rail');
  // Shop and rail help goes beside the whole rail, so it never covers the other cards.
  const a = rail ? rail.getBoundingClientRect() : own, p = pop.getBoundingClientRect(), gap = 10;
  const clampX = (x: number) => Math.max(gap, Math.min(x, innerWidth - p.width - gap));
  let x: number, y = Math.max(gap, Math.min(own.top, innerHeight - p.height - gap));
  if (a.left - gap - p.width >= gap) x = a.left - gap - p.width;
  else if (a.right + gap + p.width <= innerWidth - gap) x = a.right + gap;
  else {
    x = clampX(own.left);
    if (own.bottom + gap + p.height <= innerHeight - gap) y = own.bottom + gap;
    else if (own.top - gap - p.height >= gap) y = own.top - gap - p.height;
  }
  pop.style.left = `${x}px`; pop.style.top = `${y}px`;
}
const distance = (x: number, y: number, r: DOMRect) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
export function bindTeaching(): void {
  const pop = $('#teaching-popover');
  const startIntent = (el: HTMLElement, key: string, x: number, y: number) => {
    clearTimeout(intentTimer); candidateKey = key; restX = x; restY = y;
    intentTimer = setTimeout(() => { intentTimer = undefined; candidateKey = ''; if (el.isConnected) showTeaching(el, 'pointer'); }, HELP_INTENT_MS);
  };
  document.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    const warped = !(Math.hypot(e.clientX - lastX, e.clientY - lastY) <= WARP);
    lastX = e.clientX; lastY = e.clientY;
    if (warped && !pop.hidden && openedBy === 'pointer') closePopover();
    const open = !pop.hidden;
    if (open && pop.contains(e.target as Node)) { cancelIntent(); cancelGrace(); return; }
    const el = helpTarget(e.target), key = el ? keyOf(el) : '';
    if (suppressedKey && key !== suppressedKey) suppressedKey = '';
    if (open && key === anchorKey) { anchor = el; cancelIntent(); cancelGrace(); return; }
    if (open && openedBy === 'focus') closePopover();
    else if (open) {
      // Grace: the card stays while the pointer heads toward it, and closes once it stops or turns away.
      const d = distance(e.clientX, e.clientY, pop.getBoundingClientRect());
      if (!graceTimer || d < approach - .5) { clearTimeout(graceTimer); graceTimer = setTimeout(closePopover, HELP_GRACE_MS); }
      approach = d;
    }
    if (!el || key === suppressedKey) { cancelIntent(); return; }
    if (key !== candidateKey || Math.hypot(e.clientX - restX, e.clientY - restY) > REST_RADIUS) startIntent(el, key, e.clientX, e.clientY);
  });
  document.documentElement.addEventListener('pointerleave', () => {
    cancelIntent(); lastX = lastY = NaN;
    if (!pop.hidden && openedBy === 'pointer' && !graceTimer) graceTimer = setTimeout(closePopover, HELP_GRACE_MS);
  });
  // Any press outside the card closes it and mutes help on the pressed target until the pointer moves to another one.
  document.addEventListener('pointerdown', e => {
    tabbing = false;
    if (pop.contains(e.target as Node)) return;
    const el = helpTarget(e.target);
    suppressedKey = el ? keyOf(el) : '';
    hideTeaching();
  }, true);
  document.addEventListener('keydown', e => {
    tabbing = e.key === 'Tab';
    if (e.key === 'Escape' && !pop.hidden) hideTeaching();
  }, true);
  // Keyboard players get help on Tab focus. Focus that a click or a closing sheet moves does not open it.
  $('#game').addEventListener('focusin', e => {
    const el = helpTarget(e.target);
    if (el && tabbing && !matchMedia('(hover: none)').matches) showTeaching(el, 'focus');
  });
  $('#game').addEventListener('focusout', e => {
    if (openedBy === 'focus' && !pop.hidden && !anchor?.contains(e.relatedTarget as Node | null)) hideTeaching();
  });
  window.addEventListener('resize', positionTeaching);
}
