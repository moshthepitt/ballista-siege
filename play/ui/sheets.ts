import { $, button, escape } from './dom.js';
let returnFocus: HTMLElement | null = null;
let current = '';
export const openSheetName = () => current;
export function closeSheet(): void {
  $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; current = '';
  returnFocus?.focus({ preventScroll: true }); returnFocus = null;
}
export function openSheet(name: string, title: string, body: string, flyout = false): void {
  if (current === name) { closeSheet(); return; }
  if (!current) returnFocus = document.activeElement as HTMLElement;
  current = name;
  const node = $('#sheet');
  node.className = `sheet ${flyout ? 'flyout' : ''}`; node.setAttribute('aria-label', title);
  node.innerHTML = `<span class="sheet-grip" aria-hidden="true"></span><div class="sheet-heading"><h2 class="h2">${escape(title)}</h2>${button('close-sheet', '×', 'icon-btn')}</div><div class="sheet-body"><div class="sheet-content">${body}</div></div>`;
  node.hidden = false; $('#sheet-backdrop').hidden = false;
  node.focus({ preventScroll: true });
}
export function updateSheet(body: string): void { if (current) $('#sheet .sheet-content').innerHTML = body; }
export function bindSheets(): void {
  let touchY = 0;
  $('#sheet').addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
  $('#sheet').addEventListener('touchend', e => { if ($('#sheet .sheet-body').scrollTop === 0 && e.changedTouches[0].clientY - touchY > 80) closeSheet(); }, { passive: true });
  $('#sheet').addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const items = [...$('#sheet').querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, summary, a[href]')];
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
}
