import { describe, expect, it } from 'vitest';
import { LIMITS, PART } from '../src/v1/constants.js';
import { fight, newRun, replayFrames, withPart, type RunState } from '../src/v1/sim.js';
import { hitSnapshot, movementSnapshot, isStorm, trampleContactMs, KILL_NOTICE_MS, fatalWallLoss, wallLosses, laneOutcome, makeTimeline, timelineState } from './replay.js';

function defended(seed: bigint): RunState {
  let state = { ...newRun(seed, 'practice'), gold: 50n };
  for (let lane = 0n; lane < 4n; lane++) {
    state = withPart(state, lane * 4n + 1n, PART.BALLISTA, 2n);
    state = withPart(state, lane * 4n + 2n, PART.CAULDRON, 2n);
    state = withPart(state, lane * 4n + 3n, PART.PALISADE, 3n);
  }
  return state;
}

describe('exact replay timeline', () => {
  it('maps every original frame 1:1 and reconstructs the final state over a complete run', () => {
    let state = defended(20748n);
    let waves = 0;
    while (!state.done) {
      const result = fight(state), timeline = makeTimeline(state, result.frames);
      expect(timeline).toHaveLength(LIMITS.TICKS);
      timeline.forEach((step, i) => {
        expect(step.frame).toBe(result.frames[i]);
        expect(step.frame.tick).toBe(BigInt(i + 1));
        if (i) expect(step.before).toBe(result.frames[i - 1].groups);
      });
      expect(timelineState(state, timeline)).toEqual(result.state);
      expect(replayFrames(state, result.frames)).toEqual(result.state);
      expect(timeline.at(-1)!.frame.gold).toBe(result.state.gold);
      expect(timeline.at(-1)!.frame.walls).toBe(result.state.walls);
      state = result.state; waves++;
    }
    expect(state.done).toBe(true);
    expect(BigInt(waves)).toBe(state.wave);
    expect(waves).toBeLessThanOrEqual(LIMITS.WAVES);
  });

  it('compresses quiet time without dropping settlement or spawn frames', () => {
    const state = newRun(100n, 'practice'), result = fight(state);
    const timeline = makeTimeline(state, result.frames);
    expect(timeline[0].phases.move).toBeGreaterThanOrEqual(150);
    expect(timeline[0].phases.impact).toBe(50);
    expect(timeline[0].frame.shots).toHaveLength(0);
    expect(timeline.some(step => step.duration < 250)).toBe(true);
    const lastEnemy = timeline.map(step => step.before.some(g => g.status === 'active' || g.status === 'queued')).lastIndexOf(true);
    expect(timeline.slice(lastEnemy + 1).reduce((sum, step) => sum + step.duration, 0)).toBeLessThanOrEqual(640);
    expect(timeline.at(-1)!.frame.goldEvents.length).toBeGreaterThan(0);
    expect(timelineState(state, timeline)).toEqual(result.state);
  });

  it('uses pre-move positions for hits and never reveals a queued spawn during Fire', () => {
    const state = defended(234n), result = fight(state);
    const timeline = makeTimeline(state, result.frames);
    expect(hitSnapshot(timeline[0]).every(g => g.status === 'queued' && g.pos === 0n)).toBe(true);
    let kills = 0;
    for (const step of timeline) {
      for (const shot of step.frame.shots) expect(step.before.some(g => g.id === shot.group && g.status === 'active')).toBe(true);
      const hit = hitSnapshot(step);
      hit.forEach(g => expect(g.pos).toBe(step.before.find(prior => prior.id === g.id)!.pos));
      for (const killed of step.frame.kills) {
        kills++;
        const before = step.before.find(g => g.id === killed.group)!;
        expect(before.status).toBe('active');
        expect(hit.find(g => g.id === killed.group)!.pos).toBe(before.pos);
      }
    }
    expect(kills).toBeGreaterThan(0);
  });

  it('retains the last kill trace before settlement, including the rest of that tick', () => {
    const state = defended(100n), timeline = makeTimeline(state, fight(state).frames);
    const finalKill = timeline.findIndex(step => step.frame.kills.length > 0
      && step.frame.groups.every(g => g.status !== 'active' && g.status !== 'queued'));
    expect(finalKill).toBeGreaterThanOrEqual(0);
    const phases = timeline[finalKill].phases;
    const afterHit = phases.hit + phases.bite + phases.move + phases.impact
      + timeline.slice(finalKill + 1).reduce((sum, step) => sum + step.duration, 0);
    expect(afterHit).toBeLessThanOrEqual(640);
    expect(timelineState(state, timeline)).toEqual(fight(state).state);
  });

  it('replays leaks, support trample, broken blockers, and boss retreat without inventing events', () => {
    for (const seed of [0n, 77n, (1n << 64n) - 1n]) {
      let state = withPart(newRun(seed, 'practice'), 3n, PART.FORGE, 1n);
      state = withPart(state, 7n, PART.PALISADE, 1n);
      const first = fight(state);
      expect(first.frames.some(frame => frame.tramples.length)).toBe(true);
      expect(timelineState(state, makeTimeline(state, first.frames))).toEqual(first.state);
      // A valid wave-four state exercises the named wave-five boss snapshot.
      state = { ...defended(seed), wave: 4n };
      const boss = fight(state);
      expect(boss.frames[0].groups.some(g => g.kind === 'boss')).toBe(true);
      expect(timelineState(state, makeTimeline(state, boss.frames))).toEqual(boss.state);
    }
  });

  it('keeps one-shot arrivals alive before Fire, then dies at the same position', () => {
    const state = withPart(newRun(20748n, 'practice'), 3n, PART.BALLISTA, 3n);
    const timeline = makeTimeline(state, fight(state).frames);
    const kill = timeline.find(step => step.frame.kills.length > 0)!;
    expect(kill).toBeDefined();
    const id = kill.frame.kills[0].group;
    const arrival = timeline[Number(kill.frame.tick) - 2].frame.groups.find(g => g.id === id)!;
    expect(arrival.status).toBe('active');
    expect(arrival.count).toBeGreaterThan(0n);
    expect(kill.phases.fire).toBeGreaterThanOrEqual(120);
    const hit = hitSnapshot(kill).find(g => g.id === id)!;
    expect(hit.pos).toBe(arrival.pos);
    expect(hit.count).toBeLessThan(arrival.count);
  });

  it('shows deadline survivors charging from their prior cell and records their remaining HP', () => {
    let state = { ...newRun(20748n, 'practice'), wave: 9n };
    for (let cell = 0n; cell < 16n; cell++) state = withPart(state, cell, PART.PALISADE, 3n);
    const result = fight(state), timeline = makeTimeline(state, result.frames);
    const final = timeline.at(-1)!;
    const storms = final.frame.leaks.filter(leak => isStorm(final, leak.group));
    expect(storms.length).toBeGreaterThan(0);
    expect(final.phases.move).toBe(300);
    expect(final.phases.impact).toBeGreaterThanOrEqual(250);
    for (const leak of storms) {
      expect(hitSnapshot(final).find(g => g.id === leak.group)!.pos).toBeGreaterThan(1n);
      const charge = movementSnapshot(final).find(g => g.id === leak.group)!;
      expect(charge.status).toBe('active');
      expect(charge.pos).toBe(0n);
      expect(final.frame.groups.find(g => g.id === leak.group)!.status).toBe('leaked');
    }
    const losses = wallLosses(state, timeline);
    expect(losses.reduce((n, loss) => n + loss.damage, 0n)).toBe(result.summary.damage);
    expect(losses.reduce((n, loss) => n + loss.wallsLost, 0n)).toBe(state.walls - result.state.walls);
    expect(losses.some(loss => loss.storm && loss.name === 'Last Siege')).toBe(true);
    for (const loss of losses) {
      const resolved = timeline.flatMap(s => s.frame.groups).find(g => g.id === loss.group && g.status === 'leaked')!;
      expect(loss.hp).toBe(resolved.hp + (resolved.count - 1n) * resolved.bodyHp);
      expect(loss.maxHp).toBe(resolved.count * resolved.maxHp);
      expect(loss.wave).toBe(10n);
    }
  });

  it('reserves droplet travel, splash rings, bites and wall charges for recorded events', () => {
    const built = { ...defended(13n), wave: 4n };
    const timeline = makeTimeline(built, fight(built).frames);
    const splash = timeline.find(step => step.frame.splashes.length)!;
    expect(splash).toBeDefined();
    expect(splash.phases.fire).toBeGreaterThanOrEqual(200);
    expect(splash.phases.hit).toBeGreaterThanOrEqual(160);
    const bite = timeline.find(step => step.frame.bites.some(event => event.damage > 0n))!;
    expect(bite).toBeDefined();
    expect(bite.phases.bite).toBe(350);
    for (const step of timeline.filter(step => step.frame.leaks.length)) expect(step.phases.move).toBe(300);
  });

  it('keeps leaking groups on screen until impact without reviving prior exits', () => {
    const state = newRun(20748n, 'practice');
    const timeline = makeTimeline(state, fight(state).frames);
    for (const step of timeline) {
      const movement = movementSnapshot(step);
      for (const leak of step.frame.leaks) {
        const group = movement.find(g => g.id === leak.group)!;
        expect(group.status).toBe('active');
        expect(group.pos).toBe(0n);
        expect(step.frame.groups.find(g => g.id === leak.group)!.status).toBe('leaked');
      }
      for (const prior of step.before.filter(g => g.status === 'leaked')) {
        expect(movement.find(g => g.id === prior.id)!.status).toBe('leaked');
      }
    }
  });

  it('labels kills, harmless stalls, and wall damage separately', () => {
    expect(laneOutcome({ leaks: 0n, retreats: 0n })).toBe('holds');
    expect(laneOutcome({ leaks: 0n, retreats: 3n })).toBe('stalls');
    expect(laneOutcome({ leaks: 2n, retreats: 3n })).toBe('leaks');
  });

  it('rejects incomplete, out-of-order, and financially inconsistent replays', () => {
    const state = defended(20748n), result = fight(state);
    expect(() => makeTimeline(state, result.frames.slice(1))).toThrow('incomplete replay');
    const reordered = [...result.frames]; [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    expect(() => makeTimeline(state, reordered)).toThrow('out of order replay');
    const corrupt = result.frames.map((frame, i) => i ? frame : { ...frame, gold: frame.gold + 1n });
    expect(() => makeTimeline(state, corrupt)).toThrow('replay mismatch');
  });
});

describe('review regression: storm warning and closest miss', () => {
  it('leaves a full death beat before the next group can move into the firing slot', () => {
    const built = defended(13n), timeline = makeTimeline(built, fight(built).frames);
    const deaths = timeline.filter(step => step.frame.kills.some(kill => step.frame.groups.find(g => g.id === kill.group)?.status === 'dead'));
    expect(deaths.length).toBeGreaterThan(0);
    for (const step of deaths) {
      expect(step.phases.hit).toBeGreaterThanOrEqual(KILL_NOTICE_MS);
      for (const kill of step.frame.kills) {
        expect(hitSnapshot(step).find(g => g.id === kill.group)?.pos).toBe(step.before.find(g => g.id === kill.group)?.pos);
      }
    }
  });

  it('shows same-tick support contact before a storm reaches the wall', () => {
    let built = { ...newRun(13n, 'practice'), wave: 4n };
    for (const [cell, part, tier] of [
      [0n, PART.FORGE, 2n], [1n, PART.BALLISTA, 2n], [4n, PART.CAULDRON, 1n],
      [5n, PART.PALISADE, 1n], [8n, PART.FORGE, 1n], [9n, PART.BALLISTA, 2n],
      [10n, PART.PALISADE, 1n], [12n, PART.CAULDRON, 1n], [13n, PART.PALISADE, 1n],
    ]) built = withPart(built, cell, part, tier);
    const timeline = makeTimeline(built, fight(built).frames);
    const final = timeline.at(-1)!;
    const contact = final.frame.tramples.find(event => isStorm(final, event.group));
    expect(contact).toBeDefined();
    expect(trampleContactMs(final, contact!.group)).toBeGreaterThan(0);
    expect(trampleContactMs(final, contact!.group)).toBeLessThan(final.phases.move);
    for (const step of timeline.slice(0, -1)) for (const trample of step.frame.tramples)
      expect(trampleContactMs(step, trample.group)).toBe(255);
  });

  it('selects the fatal survivor even when later leaks deal damage against zero walls', () => {
    const built = { ...newRun(12n, 'practice'), wave: 8n, walls: 1n };
    const losses = wallLosses(built, makeTimeline(built, fight(built).frames));
    const fatal = fatalWallLoss(losses)!;
    expect(fatal.wave).toBe(9n);
    expect(fatal.wallsLost).toBe(1n);
    expect(losses.indexOf(fatal)).toBe(0);
    expect(losses.slice(1).length).toBeGreaterThan(0);
    expect(losses.slice(1).every(loss => loss.wallsLost === 0n)).toBe(true);
  });

  it('does not warn about a storm after a clean killing volley or its empty tail', async () => {
    const { hasStormSurvivors } = await import('./replay.js');
    const built = defended(4n), timeline = makeTimeline(built, fight(built).frames);
    expect(timeline.at(-1)!.frame.groups.every(g => g.status === 'dead')).toBe(true);
    expect(timeline.filter(s => s.frame.tick >= 9n).every(s => !hasStormSurvivors(s))).toBe(true);
    let storm = { ...newRun(4n, 'practice'), wave: 9n };
    for (let cell = 0n; cell < 16n; cell++) storm = withPart(storm, cell, PART.PALISADE, 3n);
    const last = makeTimeline(storm, fight(storm).frames).at(-1)!;
    expect(hasStormSurvivors(last)).toBe(true);
    // A natural D1 leak on tick 10 is still a normal wall step.
    const natural = { ...last, before: last.before.map(g => ({ ...g, pos: 1n })) };
    expect(hasStormSurvivors(natural)).toBe(false);
  });

  it('ranks damaged leakers by remaining HP fraction before raw HP', async () => {
    const { closestWallLoss } = await import('./replay.js');
    const base = { wave: 10n, lane: 0n, group: 0n, name: 'Boss', count: 1n, storm: true, damage: 8n, wallsLost: 8n };
    const untouched = { ...base, hp: 4n, maxHp: 4n };
    const boss = { ...base, hp: 56n, maxHp: 144n };
    const smaller = { ...base, hp: 3n, maxHp: 6n };
    expect(closestWallLoss([untouched, smaller, boss])).toBe(boss);
    expect(closestWallLoss([{ ...boss, wallsLost: 0n }, untouched])).toBe(untouched);
    expect(closestWallLoss([])).toBeUndefined();
  });
});
