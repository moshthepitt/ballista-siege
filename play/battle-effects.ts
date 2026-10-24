import type { RunState } from '../src/v1/sim.js';
import { isWeapon, statsAt, supportingCells } from './parts.js';
import { BITE_CONTACT_MS, BITE_WINDUP_MS, fenceBreakHold, WALL_LOSS_READ_MS, BOSS_IMPACT_HOLD_MS, BOSS_COLLAPSE_MS, BOSS_REWARD_MS, KILL_NOTICE_MS, KILL_STAGGER_MS, trampleContactMs, TRAMPLE_MS, stormCharges, STORM_CHARGE_MS, STORM_PULSE_MS, STORM_SHAKE_MS, type ReplayStep } from './replay.js';

/** Contact cues require the simulator's Bite, including Gatebreaker's zero bite. */
export function biteEffects(step: ReplayStep) {
  return step.frame.bites.flatMap(bite => {
    const group = step.before.find(g => g.id === bite.group);
    if (!group || !bite.damage && group.bossPattern !== 'gatebreaker') return [];
    return [{ ...bite, kind: bite.damage ? 'bite' as const : 'rest' as const, windup: BITE_WINDUP_MS, contact: BITE_CONTACT_MS }];
  });
}

export function blockEffects(step: ReplayStep) {
  return (step.frame.mitigations ?? []).flatMap(m => {
    const group = step.before.find(g => g.id === m.group);
    const out: { group: bigint; text: string; kind: 'armour' | 'halved' }[] = [];
    if (group?.kind === 'brute' && m.splash) out.push({ group: m.group, text: 'Armour −1', kind: 'armour' });
    if (group?.bossPattern === 'last-siege' && step.frame.tick % 2n === 0n && m.ballista) out.push({ group: m.group, text: '÷2', kind: 'halved' });
    return out;
  });
}

/** Each disappearing body belongs to a recorded kill, in front-to-back order. */
export function unitRemovals(step: ReplayStep, id: bigint) {
  const group = step.before.find(g => g.id === id);
  const count = step.frame.kills.filter(k => k.group === id).reduce((n, k) => n + k.count, 0n);
  return Array.from({ length: Number(count) }, (_, unit) => ({ unit, at: group?.kind === 'boss' ? BOSS_IMPACT_HOLD_MS : unit * KILL_STAGGER_MS,
    duration: group?.kind === 'boss' ? BOSS_COLLAPSE_MS : KILL_NOTICE_MS }));
}

export function bountyDelay(step: ReplayStep, id: bigint): number {
  return step.before.find(g => g.id === id)?.kind === 'boss' && step.frame.kills.some(k => k.group === id) ? BOSS_REWARD_MS : 0;
}

export function trampleEffects(step: ReplayStep) {
  return step.frame.tramples.map(t => ({ ...t, at: trampleContactMs(step, t.group), duration: TRAMPLE_MS, disabledAt: trampleContactMs(step, t.group) + TRAMPLE_MS }));
}

export function stormEffects(step: ReplayStep) {
  const charges = stormCharges(step), lanes = [...new Set(charges.map(c => c.lane))];
  return charges.map(c => ({ ...c, contact: (lanes.indexOf(c.lane) + 1) * STORM_CHARGE_MS, pulse: STORM_PULSE_MS, shake: STORM_SHAKE_MS }));
}

/** Range uses the pre-Fire disabled mask, before this tick's support tramples. */
export function splashCoverage(built: RunState, step: ReplayStep, disabled: bigint) {
  return step.frame.splashes.map(splash => {
    const stats = statsAt(built, splash.from, disabled), lane = splash.from / 4n;
    return { from: splash.from, targets: splash.targets.map(t => t.group),
      cells: Array.from({ length: stats.high - stats.low + 1 }, (_, i) => ({ lane, depth: BigInt(stats.low + i) })) };
  });
}

export const TRAMPLE_PULSE_MS = 250;
/** Read support losses in recorded contact order, including prior disabled supports. */
export function supportTrampleEffects(built: RunState, step: ReplayStep, disabled: bigint) {
  return trampleEffects(step).map(event => {
    const beforeMask = disabled; disabled |= 1n << event.cell;
    const weapons = Array.from({ length: 16 }, (_, i) => BigInt(i)).flatMap(cell => {
      const before = statsAt(built, cell, beforeMask), after = statsAt(built, cell, disabled);
      return isWeapon(before.part) && !(disabled & (1n << cell)) && supportingCells(built, cell, beforeMask).includes(event.cell)
        ? [{ cell, oldDamage: before.value, newDamage: after.value, oldLow: before.low, newLow: after.low, oldHigh: before.high, newHigh: after.high }] : [];
    });
    return { ...event, pulse: TRAMPLE_PULSE_MS, tagEdge: 'top' as const, weapons };
  });
}

/** Durations apply only to the frame's recorded contacts. */
export function bigMomentHolds(step: ReplayStep) {
  return { fenceBreak: fenceBreakHold(step.frame), wallLoss: step.frame.leaks.length ? WALL_LOSS_READ_MS : 0 };
}
