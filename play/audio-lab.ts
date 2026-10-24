import { getAudioEngine, getMusic, play, SOUND_KINDS, SOUND_LABELS, type MusicPhase } from './audio/index.js';

const engine = getAudioEngine();
const music = getMusic();
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const intensity = element<HTMLInputElement>('intensity');
const lane = element<HTMLSelectElement>('lane');
const mute = element<HTMLButtonElement>('mute');
const status = element<HTMLParagraphElement>('audio-status');
const musicStatus = element<HTMLParagraphElement>('music-status');
music.setIntensity(Number(intensity.value));

function updateMix(): void {
  const settings = engine.getSettings();
  for (const key of ['master', 'music', 'sfx'] as const) {
    element<HTMLInputElement>(key).value = String(Math.round(settings[key] * 100));
    element<HTMLOutputElement>(`${key}-value`).value = `${Math.round(settings[key] * 100)}%`;
  }
  mute.setAttribute('aria-pressed', String(engine.muted));
  mute.textContent = engine.forcedMute ? 'Muted by URL' : engine.muted ? 'Unmute (M)' : 'Mute (M)';
  mute.disabled = engine.forcedMute;
  status.textContent = engine.forcedMute ? 'Audio muted by ?mute=1. Remove it from the URL to listen.' : engine.muted ? 'Audio muted. Your mix is saved.' : engine.unlocked ? 'Audio ready. Your mix is saved.' : 'Click a sound or press a key to start audio.';
}
engine.subscribe(updateMix);
updateMix();

for (const key of ['master', 'music', 'sfx'] as const) {
  element<HTMLInputElement>(key).addEventListener('input', event => engine.setSettings({ [key]: Number((event.target as HTMLInputElement).value) / 100 }));
}
mute.addEventListener('click', () => engine.toggleMute());
window.addEventListener('keydown', event => {
  if (event.key.toLowerCase() !== 'm' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if ((event.target as HTMLElement).matches('input, select, textarea, [contenteditable=true]')) return;
  if (!engine.forcedMute) engine.toggleMute();
});

for (const kind of SOUND_KINDS) {
  const button = document.createElement('button');
  button.type = 'button'; button.dataset.sound = kind;
  button.dataset.category = SOUND_KINDS.indexOf(kind) < 12 ? 'combat' : kind.endsWith('won') || kind === 'run-lost' ? 'result' : 'build';
  button.textContent = SOUND_LABELS[kind];
  const name = document.createElement('small'); name.textContent = kind; button.append(name);
  button.addEventListener('click', event => {
    const options = { lane: lane.value === '' ? undefined : Number(lane.value), intensity: Number(intensity.value) };
    for (let i = 0; i < (event.shiftKey ? 5 : 1); i++) play(kind, options);
  });
  element('effects').append(button);
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-phase]')) {
  button.addEventListener('click', () => {
    const phase = button.dataset.phase as MusicPhase;
    music.setPhase(phase); music.start();
    for (const other of document.querySelectorAll('[data-phase]')) other.setAttribute('aria-pressed', String(other === button));
    musicStatus.textContent = `${button.textContent} selected. Outro returns to build after one bar.`;
  });
}
element('stop-music').addEventListener('click', () => {
  music.stop(); musicStatus.textContent = 'Music stopped.';
  for (const button of document.querySelectorAll('[data-phase]')) button.setAttribute('aria-pressed', 'false');
});
intensity.addEventListener('input', () => {
  music.setIntensity(Number(intensity.value));
  element<HTMLOutputElement>('intensity-value').value = intensity.value;
});
element<HTMLSelectElement>('speed').addEventListener('change', event => music.syncTick(3000 / Number((event.target as HTMLSelectElement).value)));
window.addEventListener('pagehide', () => music.stop());
