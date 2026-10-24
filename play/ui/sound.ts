import { getAudioEngine } from '../audio/index.js';

export function soundIcon(muted: boolean): string {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4 5 9H2v6h3l6 5Z"/>${muted ? '<path d="m16 9 6 6m0-6-6 6"/>' : '<path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'}</svg>`;
}
export function soundButton(): string {
  const muted = getAudioEngine().muted;
  return `<button class="icon-btn sound-button" data-command="sound" aria-label="Sound ${muted ? 'off' : 'on'}" aria-haspopup="dialog" data-help="Sound" aria-describedby="help-Sound">${soundIcon(muted)}</button>`;
}
export function soundControls(): string {
  const engine = getAudioEngine(), settings = engine.getSettings();
  return `<div class="sound-controls">${(['music', 'sfx'] as const).map(key => `<label class="sound-slider"><span>${key === 'music' ? 'Music' : 'Effects'}<output data-audio-output="${key}">${Math.round(settings[key] * 100)}%</output></span><input type="range" min="0" max="100" step="1" value="${Math.round(settings[key] * 100)}" data-audio-volume="${key}" aria-label="${key === 'music' ? 'Music' : 'Effects'} volume"></label>`).join('')}<button class="btn btn-quiet sound-mute" data-command="mute" aria-pressed="${engine.muted}">${engine.muted ? 'Unmute' : 'Mute'}<span class="kbd">M</span></button></div>`;
}
export function bindSoundControls(): void {
  const engine = getAudioEngine();
  engine.subscribe(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command="sound"]')) {
      const label = `Sound ${engine.muted ? 'off' : 'on'}`;
      if (button.getAttribute('aria-label') !== label) { button.setAttribute('aria-label', label); button.innerHTML = soundIcon(engine.muted); }
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command="mute"]')) {
      button.setAttribute('aria-pressed', String(engine.muted)); button.innerHTML = `${engine.muted ? 'Unmute' : 'Mute'}<span class="kbd">M</span>`;
    }
  });
  document.addEventListener('input', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const key = input.dataset.audioVolume;
    if (key !== 'music' && key !== 'sfx') return;
    engine.setSettings({ [key]: Number(input.value) / 100 });
    const output = document.querySelector(`[data-audio-output="${key}"]`);
    if (output) output.textContent = `${input.value}%`;
  });
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() !== 'm' || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target instanceof HTMLElement && event.target.closest('textarea, select, input:not([type="range"])')) return;
    event.preventDefault(); engine.toggleMute();
  });
}
