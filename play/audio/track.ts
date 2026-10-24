import { hitSnapshot, ordinaryMovement, isStorm, STORM_CHARGE_MS, type ReplayStep, type ReplayPhase } from '../replay.js';
import { battleSounds, musicState } from './game.js';
import type { MusicPhase, PlayOptions, SoundKind } from './index.js';

export type TrackEvent = { at: number } & ({ type: 'sound'; kind: SoundKind; options: PlayOptions }
  | { type: 'music'; phase: MusicPhase; intensity: number; tickMs: number });
/** Milliseconds on the same presentation clock as playBattle, at 1×. */
export function battleTrack(timeline: readonly ReplayStep[], wave: bigint): { events: TrackEvent[]; duration: number } {
  const events: TrackEvent[] = [];
  let at = 0;
  for (const step of timeline) {
    if (!step.duration) continue;
    for (const phase of ['fire', 'hit', 'bite', 'move', 'impact'] as ReplayPhase[]) {
      if (!step.phases[phase]) continue;
      let groups = phase === 'fire' ? [...step.before] : phase === 'hit' || phase === 'bite' ? hitSnapshot(step) : ordinaryMovement(step);
      if (phase === 'impact') groups = groups.map(g => g.pos === 0n ? { ...g, status: 'leaked' } : g);
      events.push({ at, type: 'music', ...musicState('battle', wave, groups), tickMs: step.duration });
      for (const { kind, lane, intensity, delay } of battleSounds(step, phase)) events.push({ at: at + delay, type: 'sound', kind, options: { lane, intensity } });
      if (phase === 'impact') {
        const ids = new Set(step.frame.leaks.filter(l => isStorm(step, l.group)).map(l => l.group));
        const lanes = [...new Set(step.frame.leaks.filter(l => ids.has(l.group)).map(l => l.lane))];
        lanes.forEach((lane, index) => {
          groups = groups.map(g => ids.has(g.id) && g.lane === lane ? { ...g, status: 'active', pos: 0n } : g);
          events.push({ at: at + index * STORM_CHARGE_MS, type: 'music', ...musicState('battle', wave, groups), tickMs: step.duration });
          groups = groups.map(g => ids.has(g.id) && g.lane === lane ? { ...g, status: 'leaked' } : g);
          events.push({ at: at + (index + 1) * STORM_CHARGE_MS, type: 'music', ...musicState('battle', wave, groups), tickMs: step.duration });
        });
      }
      at += step.phases[phase];
    }
  }
  events.push({ at, type: 'music', phase: 'outro', intensity: 0, tickMs: 3000 }, { at, type: 'sound', kind: 'wave-won', options: {} }, { at, type: 'sound', kind: 'gold', options: {} });
  return { events: events.sort((a, b) => a.at - b.at), duration: at + 4000 };
}
