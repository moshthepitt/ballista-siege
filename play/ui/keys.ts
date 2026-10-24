export function bindKeys(command: (name: string, value?: string) => void, card: (slot: number) => void, phase: () => string, sheetOpen: () => boolean): void {
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); command('escape'); return; }
    if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea') || event.repeat || event.altKey || event.metaKey || event.ctrlKey || sheetOpen()) return;
    const key = event.key.toLowerCase();
    if (event.target instanceof HTMLElement && event.target.closest('.tutorial-controls')) return;
    if (/^[1-4]$/.test(key) && phase() === 'build') { event.preventDefault(); card(Number(key) - 1); return; }
    const commands: Record<string, string> = { u: 'upgrade', s: 'sell', o: 'overclock', r: 'reroll', z: 'undo' };
    if (commands[key] && phase() === 'build') { event.preventDefault(); command(commands[key]); return; }
    if (key === ' ' || key === 'enter') {
      // Native focused controls keep Enter; Space during battle always skips.
      if (key === 'enter' && event.target instanceof HTMLButtonElement) return;
      event.preventDefault(); command(phase() === 'battle' ? 'skip' : phase() === 'summary' ? 'continue-summary' : phase() === 'end' ? 'retry' : 'fight');
    }
  });
}
