import { helpAttributes, helpDescriptions } from './teaching.js';
import { CHIP_KEY } from './model.js';
import { art } from './icons.js';
export const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing UI element: ${selector}`);
  return node;
};
export const escape = (value: unknown): string => String(value).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const button = (command: string, text: string, cls = 'btn btn-quiet') => `<button type="button" class="${cls}" data-command="${command}">${text}</button>`;
export const phone = () => matchMedia('(width < 1024px)').matches;
export function mount(): void {
  $('#game').className = 'app';
  $('#game').innerHTML = `<header class="hud" id="hud"></header>
    <div class="stage">
      <div class="scout-column"><aside class="rail scout-rail" id="scout-rail" aria-label="Scout"></aside>
      <nav class="strip" aria-label="Scout tools">${['Scout', 'Guide', 'Keys'].map((n, i) => button(n.toLowerCase(), `<span aria-hidden="true">${['⚑', '▤', '⌨'][i]}</span>${n}`, 'strip-btn') + (i === 0 ? `<p class="chip-key chip-key-strip">${CHIP_KEY}</p>` : '')).join('')}</nav>
      </div><section class="battlefield" aria-label="Siege battlefield"><div class="banner" id="phase-banner"></div><div class="board" id="board" aria-label="Four lanes; incoming at top, walls at bottom"></div></section>
      <aside class="rail action-rail" aria-label="Build and battle controls">
        <div id="build-panel"><div id="orders"></div><div class="shop-heading sec-head"><h2 class="h2" ${helpAttributes('Shop')} tabindex="0" role="button">Supply line</h2><span id="reroll-desktop"></span></div><div id="shop" class="shop"></div><div id="hint" class="hint" hidden></div></div>
        <section id="inspector" class="inspector" aria-label="Part inspector" hidden></section>
        <section id="battle-panel" hidden></section>
        <section id="settlement" hidden aria-hidden="true" aria-label="Wave settlement"></section>
        <button class="disclose projection-entry" data-command="projection">› If you buy nothing more: next 3 waves</button>
        <div id="action-bar"></div>
      </aside>
    </div>
    <section id="end-screen" hidden aria-label="Run report"></section>
    <div id="notice" class="notice" role="status" hidden></div>
    <div id="sheet-backdrop" hidden data-command="close-sheet"></div>
    <section id="sheet" class="sheet" role="dialog" aria-modal="true" aria-label="Details" tabindex="-1" hidden></section>
    <svg id="tutorial-pointer" class="tutorial-pointer" aria-hidden="true" hidden></svg><section id="tutorial-layer" class="tutorial-layer" aria-label="First siege tutorial" hidden></section><section id="teaching-popover" class="teaching-popover" role="tooltip" hidden></section>${helpDescriptions()}<div id="travel-effects" aria-hidden="true"></div>`;
}
export function makeBoard(): void {
  let html = '<span class="ruler"></span>' + [1, 2, 3, 4].map(i => `<span class="lanehead" ${helpAttributes('Lane')} tabindex="0" role="button"><span class="wide">LANE ${i}</span><span class="narrow">L${i}</span></span>`).join('');
  html += `<span class="ruler v" ${helpAttributes('Incoming')} data-help-note="${CHIP_KEY}" tabindex="0" role="button">Incoming</span>` + [0, 1, 2, 3].map(i => `<div class="spawn" data-spawn="${i}" ${helpAttributes('Incoming')}></div>`).join('');
  for (let depth = 4; depth >= 1; depth--) {
    html += `<span class="ruler" ${helpAttributes('Depth')} tabindex="0" role="button">D${depth}</span>`;
    for (let lane = 0; lane < 4; lane++) html += `<button type="button" class="cell ${depth % 2 ? 'alt' : ''}" data-cell="${lane * 4 + depth - 1}" data-loc="L${lane + 1}D${depth}" aria-label="Lane ${lane + 1}, depth ${depth}, empty"><span class="popband"></span><span class="foes"></span><span class="part-layer"></span><span class="cell-effects" aria-hidden="true"></span></button>`;
  }
  html += `<span class="ruler v" ${helpAttributes('Wall')} tabindex="0" role="button">Wall</span>` + [0, 1, 2, 3].map(i => `<button class="wall" data-wall="${i}" data-command="lane-detail" data-lane="${i}" aria-label="Lane ${i + 1} forecast"></button>`).join('');
  html += '<svg id="links" class="support-links" aria-hidden="true"></svg><svg class="leak-paths" aria-hidden="true"></svg>';
  $('#board').innerHTML = html;
}
export function toast(message: string): void {
  const node = $('#notice'); delete node.dataset.combat; node.textContent = message; node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}
let toastTimer: ReturnType<typeof setTimeout>;
export const closeIcon = () => art('brand', 20);
