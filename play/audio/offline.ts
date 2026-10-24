import { AudioEngine } from './engine.js';
import { createSfx } from './sfx.js';
import { MusicSequencer, seededRandom } from './music.js';
import { battleTrack } from './track.js';
import { makeTimeline } from '../replay.js';
import type { RunState, TickFrame } from '../../src/v1/sim.js';

/** Browser-only entry, bundled by scripts/audio-render.ts; never shipped with the game. */
export async function renderBattleAudio(recording: string): Promise<{ channels: number[][]; sampleRate: number; events: number; duration: number }> {
  const { built, frames } = JSON.parse(recording, (_key, value) => typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value) as { built: RunState; frames: TickFrame[] };
  const track = battleTrack(makeTimeline(built, frames), built.wave + 1n);
  const sampleRate = 48000, quantum = 128 / sampleRate;
  const context = new OfflineAudioContext(2, Math.ceil(track.duration / 1000 * sampleRate), sampleRate);
  // Offline contexts remain suspended between render blocks. The engine's gesture
  // gate is already satisfied here; all nodes still belong to the real context.
  const port = new Proxy(context, {
    get(target, key) {
      if (key === 'state') return 'running';
      if (key === 'resume' || key === 'close') return async () => {};
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as AudioContext;
  const engine = new AudioEngine({ contextFactory: () => port, storage: null, gestures: null, search: '' });
  await engine.unlock();
  const sfx = createSfx(engine, seededRandom(13));
  let pump: (() => void) | null = null;
  const music = new MusicSequencer(engine, 13, { set: fn => { pump = fn; return 1; }, clear: () => { pump = null; } });
  let cursor = 0;
  const advance = () => {
    // Suspend times quantize to 128-sample blocks. Dispatch each contact once.
    while (cursor < track.events.length && track.events[cursor]!.at / 1000 <= context.currentTime + quantum) {
      const event = track.events[cursor++]!;
      if (event.type === 'sound') sfx(event.kind, event.options);
      else { music.syncTick(event.tickMs); music.setIntensity(event.intensity); music.setPhase(event.phase); }
    }
    pump?.();
  };
  advance();
  // Render while stopped at audio-clock checkpoints. Scheduling the entire
  // file up front would steal voices and disconnect graphs before they sound.
  const checkpoints = new Set<number>();
  for (let ms = 25; ms < track.duration; ms += 25) checkpoints.add(Math.floor(ms / 1000 / quantum));
  for (const e of track.events) if (e.at > 0) checkpoints.add(Math.floor(e.at / 1000 / quantum));
  const blocks = [...checkpoints].filter(n => n > 0).sort((a, b) => a - b);
  // Stay inside the block so float rounding cannot request the previous block.
  const suspendBlock = (block: number) => context.suspend((block + .25) * quantum);
  let suspended = suspendBlock(blocks[0]!);
  const rendered = context.startRendering();
  try {
    for (let i = 0; i < blocks.length; i++) {
      await suspended; advance();
      if (i + 1 < blocks.length) suspended = suspendBlock(blocks[i + 1]!);
      await context.resume();
    }
    const buffer = await rendered;
    return { channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => Array.from(buffer.getChannelData(c))), sampleRate, events: track.events.filter(e => e.type === 'sound').length, duration: buffer.duration };
  } finally { music.dispose(); await engine.dispose(); }
}
