import type { Action, EnemyGroup } from '../../src/v1/sim.js';
import { isStorm, STORM_CHARGE_MS, firingOrder, BITE_CONTACT_MS, BITE_MS, KILL_STAGGER_MS, type ReplayPhase, type ReplayStep } from '../replay.js';
import { bountyDelay, trampleEffects } from '../battle-effects.js';
import { biteTotals, hitReadouts, type Phase } from '../ui/model.js';
import { play, setPhase, setIntensity, syncTick, type MusicPhase, type PlayOptions, type SoundKind } from './index.js';

export type SoundPort = (kind: SoundKind, options?: PlayOptions) => unknown;
export type BattleSound = { kind: SoundKind; lane: number; intensity: number; delay: number };
export { FIRE_DELAY_MS, KILL_STAGGER_MS } from '../replay.js';
export const BITE_CONTACT = BITE_CONTACT_MS / BITE_MS;
/** Damage bands retain bigint until the bounded audio control value. */
export const damageIntensity = (damage: bigint): number => damage <= 2n ? 0 : damage <= 5n ? 1 : damage <= 10n ? 2 : 3;

/** One cue per kind/lane/contact, shared by live playback and the offline renderer. */
export function battleSounds(step: ReplayStep, phase: ReplayPhase): BattleSound[] {
  const f = step.frame, out: BattleSound[] = [];
  const add = (kind: SoundKind, lane: bigint, amount = 1n, delay = 0) => {
    const intensity = damageIntensity(amount);
    const prior = out.find(e => e.kind === kind && e.lane === Number(lane) && e.delay === delay);
    if (prior) prior.intensity = Math.max(prior.intensity, intensity);
    else out.push({ kind, lane: Number(lane), intensity, delay });
  };
  if (phase === 'fire') {
    for (const shot of firingOrder(f)) add(shot.splash ? 'cauldron-fire' : 'ballista-fire', shot.from / 4n,
      f.shots.find(s => s.from === shot.from)?.damage ?? 1n, shot.at);
  }
  if (phase === 'hit') for (const hit of hitReadouts(step)) {
    const g = step.before.find(g => g.id === hit.group)!;
    const bolt = hit.bolt > hit.blockedBolt ? hit.bolt - hit.blockedBolt : 0n;
    if (hit.bolt) add('bolt-hit', g.lane, bolt < hit.applied ? bolt : hit.applied);
    if (hit.splash) add('splash', g.lane, hit.splash);
    if (hit.blockedBolt || hit.blockedSplash) add('armour-block', g.lane, hit.blockedBolt + hit.blockedSplash);
    for (let unit = 0; unit < Number(hit.kills); unit++) add(g.kind === 'boss' ? 'boss-killed' : 'unit-killed', g.lane, 1n, unit * KILL_STAGGER_MS);
    if (hit.bounty) add('gold', g.lane, hit.bounty, bountyDelay(step, g.id));
  }
  if (phase === 'bite') {
    for (const [cell, amount] of biteTotals(f)) if (amount) add('fence-bite', cell / 4n, amount, BITE_CONTACT_MS);
    for (const p of f.palisades) if (!p.hp && f.bites.some(b => b.cell === p.cell && b.damage)) add('fence-break', p.cell / 4n, 1n, BITE_CONTACT_MS);
  }
  if (phase === 'move') for (const t of trampleEffects(step)) add('trample', t.cell / 4n, 1n, t.at);
  if (phase === 'impact') {
    let walls = step.wallsBefore;
    const leak = (lane: bigint, damage: bigint, delay = 0) => {
      const lost = damage < walls ? damage : walls; walls -= lost;
      add('leak', lane, lost, delay);
    };
    const stormLanes = [...new Set(f.leaks.filter(l => isStorm(step, l.group)).map(l => l.lane))];
    for (const lane of new Set(f.leaks.filter(l => !isStorm(step, l.group)).map(l => l.lane))) {
      leak(lane, f.leaks.filter(l => l.lane === lane && !isStorm(step, l.group)).reduce((n, l) => n + l.damage, 0n));
    }
    stormLanes.forEach((lane, index) => {
      add('storm', lane, 1n, index * STORM_CHARGE_MS);
      leak(lane, f.leaks.filter(l => l.lane === lane && isStorm(step, l.group)).reduce((n, l) => n + l.damage, 0n), (index + 1) * STORM_CHARGE_MS);
    });
  }
  return out.sort((a, b) => a.delay - b.delay);
}

export function playBattleSounds(step: ReplayStep, phase: ReplayPhase, speed: number, later: (fn: () => void, ms: number) => unknown, emit: SoundPort = play): void {
  for (const { kind, lane, intensity, delay } of battleSounds(step, phase)) {
    const fire = () => emit(kind, { lane, intensity });
    if (delay) later(fire, delay / speed); else fire();
  }
}

export function actionSound(action: Action, emit: SoundPort = play): void {
  emit(action.type === 'buy' ? 'place' : action.type, 'cell' in action ? { lane: Number(action.cell / 4n) } : {});
}
export const pickSound = (emit: SoundPort = play): void => { emit('ui-click'); };
export function resultSound(phase: 'summary' | 'end', won: boolean, emit: SoundPort = play): void {
  emit(phase === 'summary' ? 'wave-won' : won ? 'run-won' : 'run-lost');
}

export function musicState(phase: Phase, wave: bigint, groups: readonly EnemyGroup[]) {
  const active = groups.filter(g => g.status === 'active' && g.count > 0n);
  const music: MusicPhase = phase === 'build' ? 'build' : phase !== 'battle' ? 'outro'
    : (wave === 5n || wave === 10n) && active.some(g => g.kind === 'boss') ? 'boss' : 'battle';
  return { phase: music, intensity: active.reduce((n, g) => Math.max(n, Math.max(0, Math.min(3, 4 - Number(g.pos)))), 0) };
}
export type MusicPort = { setPhase: typeof setPhase; setIntensity: typeof setIntensity; syncTick: typeof syncTick };
const musicPort: MusicPort = { setPhase, setIntensity, syncTick };
export function followMusic(phase: Phase, wave: bigint, groups: readonly EnemyGroup[], duration?: number, speed = 1, port = musicPort): void {
  const state = musicState(phase, wave, groups);
  if (duration && duration > 0) port.syncTick(duration / speed);
  port.setIntensity(state.intensity); port.setPhase(state.phase);
}

/** Settlement coins have no battle lane. */
export const settlementSound = (emit: SoundPort = play): void => { emit('gold'); };
