import { TUTORIAL_KEY, advanceTutorial, createTutorial, tutorialCallout, type TutorialContext, type TutorialState } from '../tutorial.js';
import { $, escape } from './dom.js';
import { openSheetName } from './sheets.js';
import type { RunState } from '../../src/v1/sim.js';
let model: TutorialState;
let enabled = true;
let target: HTMLElement | null = null;
function savedTutorial(): Pick<TutorialState, 'done' | 'seen'> | undefined {
  try { const saved = JSON.parse(localStorage.getItem(TUTORIAL_KEY) ?? 'null'); return saved && typeof saved === 'object' ? { done: saved.done === true, seen: Array.isArray(saved.seen) ? saved.seen : [] } : undefined; } catch { return undefined; }
}
export function startTutorial(state: RunState): void {
  enabled = new URLSearchParams(location.search).get('tutorial') !== '0';
  model = createTutorial(state, savedTutorial());
}
/** A reserved rail slot keeps the callout out of game geometry at every size. */
export function positionTutorial(): void {
  const layer = $('#tutorial-layer');
  if (layer.hidden || !target?.isConnected) return;
  let dock = document.querySelector<HTMLElement>('#tutorial-dock');
  if (!dock) { dock = document.createElement('div'); dock.id = 'tutorial-dock'; }
  const scout = $('.scout-column');
  const rail = innerWidth >= 1024 && scout.getBoundingClientRect().width >= 240 ? scout : $('.action-rail');
  if (dock.parentElement !== rail) rail.prepend(dock);
  if (layer.parentElement !== dock) dock.append(layer);
  const pointer = $('#tutorial-pointer');
  pointer.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
  // The target glows instead of getting a connector line: board text changes every tick, so any
  // line drawn at placement time can end up crossing a label a moment later.
  pointer.innerHTML = '';
  pointer.dataset.points = '[]';
}
export function renderTutorial(context: TutorialContext, event?: 'next' | 'skip'): void {
  if (!model) startTutorial(context.state);
  const layer = $('#tutorial-layer'), pointer = $('#tutorial-pointer');
  target?.classList.remove('tutorial-target');
  $('#game').classList.remove('tutorial-active');
  if (!enabled) { layer.hidden = true; pointer.setAttribute('hidden', ''); return; }
  model = advanceTutorial(model, context, event);
  try { localStorage.setItem(TUTORIAL_KEY, JSON.stringify({ done: model.done, seen: model.seen })); } catch { /* Storage is optional. */ }
  const view = tutorialCallout(model, context);
  target = view ? [...document.querySelectorAll<HTMLElement>(view.anchor)].find(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden') ?? null : null;
  if (!view || !target || openSheetName()) { layer.hidden = true; pointer.setAttribute('hidden', ''); return; }
  target.classList.add('tutorial-target');
  layer.dataset.step = view.id; layer.dataset.anchor = view.anchor;
  layer.innerHTML = `<div class="tutorial-callout" role="status"><span class="label">First siege</span><p>${escape(view.text)}</p></div><nav class="tutorial-controls" aria-label="Tutorial controls">${view.next ? '<button data-command="tutorial-next">Next</button>' : ''}<button data-command="tutorial-skip">Skip</button></nav>`;
  layer.hidden = false; $('#game').classList.add('tutorial-active'); pointer.removeAttribute('hidden');
  positionTutorial();
  if (layer.hidden) pointer.setAttribute('hidden', '');
}
