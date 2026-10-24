import {
  replayFrames, waveForecast,
  type EnemyGroup, type LanePreview, type RunState, type TickFrame,
} from '../src/v1/sim.js';
import { LIMITS } from '../src/v1/constants.js';

export interface ReplayPhases { fire: number; hit: number; bite: number; move: number; impact: number }
export const KILL_NOTICE_MS = 280;
export const FIRE_DELAY_MS = 20;
export const SHOT_STAGGER_MS = 40;
export const PROJECTILE_MS = 180;
export const KILL_STAGGER_MS = 40;
export const BITE_WINDUP_MS = 100;
export const BITE_CONTACT_MS = 200;
export const BITE_MS = 350;
export const FENCE_BREAK_HOLD_MS = 100;
export const WALL_LOSS_READ_MS = 800;
/** Only recorded breaking bites receive a hold; contact keeps its original clock. */
export const fenceBreakHold = (frame: Pick<TickFrame, 'bites' | 'palisades'>) =>
  frame.palisades.some(p => p.hp === 0n && frame.bites.some(b => b.cell === p.cell && b.damage > 0n)) ? FENCE_BREAK_HOLD_MS : 0;

export const BOSS_IMPACT_HOLD_MS = 100;
export const BOSS_COLLAPSE_MS = 600;
export const BOSS_REWARD_MS = BOSS_IMPACT_HOLD_MS + BOSS_COLLAPSE_MS;
export const BOSS_REWARD_HOLD_MS = 600;
export const MOVE_MS = 300;
export const TRAMPLE_CONTACT_MS = 255;
export const TRAMPLE_MS = 180;
export const STORM_PULSE_MS = 500;
export const STORM_SHAKE_MS = 200;
export const STORM_CHARGE_MS = 350;
export const STORM_HOLD_MS = 1000;

export interface ReplayStep {
  /** Original frame, including quiet ticks. No events are synthesized. */
  frame: TickFrame;
  before: readonly EnemyGroup[];
  wallsBefore: bigint;
  duration: number;
  phases: ReplayPhases;
}

/** Source-cell order is the VM's Fire resolution order, across both weapon types. */
export function firingOrder(frame: Pick<TickFrame, 'shots' | 'splashes'>) {
  return [...frame.shots.map(shot => ({ from: shot.from, targets: [shot.group], splash: false })),
    ...frame.splashes.map(splash => ({ from: splash.from, targets: splash.targets.map(t => t.group), splash: true }))]
    .sort((a, b) => Number(a.from - b.from))
    .map((shot, index) => ({ ...shot, at: FIRE_DELAY_MS + index * SHOT_STAGGER_MS }));
}

export function makeTimeline(built: RunState, frames: TickFrame[]): ReplayStep[] {
  // Validate frame order and all persistent event totals before showing combat.
  replayFrames(built, frames);
  let before: readonly EnemyGroup[] = waveForecast(built.seed, built.wave + 1n).lanes.flat();
  let wallsBefore = built.walls, holdBudget = 300;
  return frames.map(frame => {
    const moving = frame.groups.some(g => {
      const prior = before.find(p => p.id === g.id);
      return !prior || prior.pos !== g.pos || prior.status !== g.status;
    });
    const events = frame.shots.length + frame.splashes.length + frame.bites.length
      + frame.tramples.length + frame.leaks.length + frame.kills.length
      + frame.retreats.length + frame.goldEvents.length;
    const arrival = frame.groups.some(g => g.status === 'active' && before.find(p => p.id === g.id)?.status === 'queued');
    const emptyTail = before.every(g => g.status !== 'active' && g.status !== 'queued');
    const cleared = frame.groups.every(g => g.status !== 'active' && g.status !== 'queued');
    const lastHit = cleared && frame.kills.length > 0 && !frame.leaks.length && !frame.retreats.length;
    const volley = firingOrder(frame);
    let phases: ReplayPhases;
    if (emptyTail) phases = { fire: 0, hit: 0, bite: 0, move: 0, impact: 0 };
    else if (!moving && !events) phases = { fire: 15, hit: 10, bite: 10, move: 10, impact: 10 };
    else if (frame.tick === 1n && !events) phases = { fire: 0, hit: 0, bite: 0, move: 300, impact: 50 };
    else phases = {
      fire: volley.length ? volley.at(-1)!.at + PROJECTILE_MS : 0,
      hit: frame.shots.length || frame.splashes.length ? Math.max(160, ...frame.kills.map(k =>
        before.find(g => g.id === k.group)?.kind === 'boss' ? BOSS_REWARD_MS + BOSS_REWARD_HOLD_MS : KILL_NOTICE_MS + (Number(k.count) - 1) * KILL_STAGGER_MS)) : 0,
      bite: lastHit || !frame.bites.length ? 0 : BITE_MS + fenceBreakHold(frame),
      move: lastHit ? 0 : frame.tramples.length ? TRAMPLE_CONTACT_MS + TRAMPLE_MS : MOVE_MS,
      impact: lastHit ? 0 : frame.tick === 10n && frame.leaks.some(l => (before.find(g => g.id === l.group)?.pos ?? 0n) > 1n)
        ? new Set(frame.leaks.filter(l => (before.find(g => g.id === l.group)?.pos ?? 0n) > 1n).map(l => l.lane)).size * STORM_CHARGE_MS + STORM_HOLD_MS
        : frame.leaks.length ? 620 : arrival ? 140 : 80,
    };
    const hold = Math.min(fenceBreakHold(frame), holdBudget);
    if (phases.bite > BITE_MS) phases.bite = BITE_MS + hold;
    holdBudget -= hold;
    const step = { frame, before, wallsBefore, phases, duration: Object.values(phases).reduce((sum, ms) => sum + ms, 0) };
    before = frame.groups; wallsBefore = frame.walls;
    return step;
  });
}

/** At the deadline, a leak from beyond D1 is a storm rather than a normal step to D0. */
export function isStorm(step: Pick<ReplayStep, 'frame' | 'before'>, id: bigint): boolean {
  return step.frame.tick === BigInt(LIMITS.TICKS)
    && step.frame.leaks.some(leak => leak.group === id)
    && (step.before.find(g => g.id === id)?.pos ?? 0n) > 1n;
}

/** A storm trample is the last ordinary step, before the accelerated wall charge. */
export function trampleContactMs(step: ReplayStep, id: bigint): number {
  return step.frame.tramples.some(t => t.group === id) ? TRAMPLE_CONTACT_MS : 0;
}

export interface WallLoss {
  wave: bigint; lane: bigint; group: bigint; name: string; count: bigint;
  storm: boolean; hp: bigint; maxHp: bigint; damage: bigint; wallsLost: bigint;
}

/** A display-only record of the survivors from the backend's resolved frames. */
export function wallLosses(built: RunState, timeline: readonly ReplayStep[]): WallLoss[] {
  const boss = waveForecast(built.seed, built.wave + 1n).boss;
  let walls = built.walls;
  return timeline.flatMap(step => step.frame.leaks.flatMap(leak => {
    const group = step.frame.groups.find(g => g.id === leak.group);
    if (!group) return [];
    const wallsLost = leak.damage < walls ? leak.damage : walls;
    walls -= wallsLost;
    return [{ wave: built.wave + 1n, lane: leak.lane, group: group.id,
      name: group.kind === 'boss' ? boss?.name ?? 'Boss' : group.kind === 'swarm' ? 'Swarm' : 'Brute',
      count: group.count, storm: isStorm(step, group.id),
      hp: group.count ? group.hp + (group.count - 1n) * group.bodyHp : 0n,
      maxHp: group.count * group.maxHp, damage: leak.damage, wallsLost }];
  }));
}

export const timelineState = (built: RunState, timeline: readonly ReplayStep[]): RunState =>
  replayFrames(built, timeline.map(step => step.frame));

/** Fire resolves before movement; dead groups keep their actual firing position. */
export function hitSnapshot(step: ReplayStep): EnemyGroup[] {
  return step.before.map(prior => {
    const next = step.frame.groups.find(g => g.id === prior.id);
    if (!next || prior.status !== 'active') return { ...prior };
    return { ...prior, count: next.count, hp: next.hp, bodyHp: next.bodyHp,
      status: next.status === 'dead' ? 'dead' : 'active' };
  });
}

/** Keep exits visible through the slide; commit their status at wall impact. */
export function movementSnapshot(step: ReplayStep): EnemyGroup[] {
  return step.frame.groups.map(group => ({ ...group,
    status: group.status === 'leaked' && step.frame.leaks.some(e => e.group === group.id)
      || group.status === 'retreated' && step.frame.retreats.some(e => e.group === group.id)
      ? 'active' : group.status,
  }));
}

export function ordinaryMovement(step: ReplayStep): EnemyGroup[] {
  return movementSnapshot(step).map(g => {
    if (!isStorm(step, g.id)) return g;
    const prior = step.before.find(p => p.id === g.id)!;
    const blocked = step.frame.palisades.some(p => p.cell === g.lane * 4n + prior.pos - 2n && p.hp > 0n);
    return { ...g, pos: blocked ? prior.pos : prior.pos - 1n };
  });
}

/** Start after ordinary Move, including a broken fence or recorded trample step. */
export function stormCharges(step: ReplayStep) {
  const moved = ordinaryMovement(step);
  return step.frame.leaks.filter(leak => isStorm(step, leak.group)).map(leak => ({
    group: leak.group, lane: leak.lane, from: moved.find(g => g.id === leak.group)!.pos, to: 0n,
  }));
}

/** Queued groups also use position zero. Only an active arrival has hit the wall. */
export function wallContactSnapshot(step: ReplayStep): EnemyGroup[] {
  return ordinaryMovement(step).map(g => g.status === 'active' && g.pos === 0n ? { ...g, status: 'leaked' } : g);
}

export const laneOutcome = (preview: Pick<LanePreview, 'leaks' | 'retreats'>) =>
  preview.leaks > 0n ? 'leaks' : preview.retreats > 0n ? 'stalls' : 'holds';

/** Damaged leakers rank before untouched ones; fractions compare exactly using bigint. */
export function closestWallLoss(losses: readonly WallLoss[]): WallLoss | undefined {
  return losses.filter(loss => loss.wallsLost > 0n).reduce<WallLoss | undefined>((best, loss) => {
    if (!best) return loss;
    const damaged = loss.hp < loss.maxHp, bestDamaged = best.hp < best.maxHp;
    if (damaged !== bestDamaged) return damaged ? loss : best;
    const ratio = loss.hp * best.maxHp - best.hp * loss.maxHp;
    return ratio < 0n || (ratio === 0n && loss.hp < best.hp) ? loss : best;
  }, undefined);
}

export const hasStormSurvivors = (step: ReplayStep): boolean =>
  step.frame.leaks.some(leak => isStorm(step, leak.group));

/** Last survivor that actually consumed walls, in backend resolution order. */
export const fatalWallLoss = (losses: readonly WallLoss[]): WallLoss | undefined =>
  losses.filter(loss => loss.wallsLost > 0n).at(-1);

export type ReplayPhase = keyof ReplayPhases;
/** Presentation clock: quiet tail frames still settle, but never consume playback time. */
export async function playTimeline(
  timeline: readonly ReplayStep[], speed: () => number, stopped: () => boolean,
  phase: (step: ReplayStep, phase: ReplayPhase, ms: number) => void | Promise<void>,
  pause: (ms: number) => Promise<void>,
): Promise<void> {
  for (const step of timeline) {
    if (!step.duration) continue;
    for (const name of ['fire', 'hit', 'bite', 'move', 'impact'] as const) {
      if (stopped()) return;
      const ms = step.phases[name] / speed();
      if (!ms) continue;
      const presentation = phase(step, name, ms);
      await Promise.all([pause(ms), presentation]);
    }
  }
}

/** Await every lane's contact and the final readable verdict before settlement. */
export async function presentStorm(
  step: ReplayStep, speed: number,
  charge: (lane: bigint, ms: number) => void, impact: (lane: bigint) => void,
  pause: (ms: number) => Promise<void>,
): Promise<void> {
  const lanes = [...new Set(step.frame.leaks.filter(l => isStorm(step, l.group)).map(l => l.lane))];
  for (const lane of lanes) {
    charge(lane, STORM_CHARGE_MS / speed);
    await pause(STORM_CHARGE_MS / speed);
    impact(lane);
  }
  await pause(STORM_HOLD_MS / speed);
}
