import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fight, newRun, withPart, type RunState, type TickFrame } from '../src/v1/sim.js';
import { firingOrder, makeTimeline, playTimeline, stormCharges, ordinaryMovement, presentStorm } from './replay.js';
import { biteEffects, blockEffects, unitRemovals, splashCoverage } from './battle-effects.js';
import { battleSounds } from './audio/game.js';

const recording = JSON.parse(readFileSync(new URL('./audio/fixtures/seed13.json', import.meta.url), 'utf8'), (_key, value) =>
  typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value) as { built: RunState; frames: TickFrame[] }[];
const wave = (n: number) => makeTimeline(recording[n - 1].built, recording[n - 1].frames);

describe('RD7 tick pacing', () => {
  it.each([1, 2])('starts each phase on its clock and compresses arrival to 350 ms at %i×', async speed => {
    const timeline = wave(5), arrival = timeline[0];
    expect(arrival.duration / speed).toBe(350 / speed);
    expect(arrival.phases).toEqual({ fire: 0, hit: 0, bite: 0, move: 300, impact: 50 });
    const step = wave(10).find(s => s.frame.shots.length && s.frame.splashes.length)!
    let clock = 0;
    const starts = { fire: 0, hit: 320, bite: 720, move: 1070, impact: 1370 };
    expect(step.phases).toEqual({ fire: 320, hit: 400, bite: 350, move: 300, impact: 140 });
    await playTimeline([step], () => speed, () => false, (_step, name, ms) => {
      expect(clock).toBe(starts[name] / speed); expect(ms).toBe(step.phases[name] / speed);
    }, async ms => { clock += ms; });
    expect(clock).toBe(step.duration / speed);
    expect(step.phases.move / speed).toBe(300 / speed);
  });
  it('launches every recorded source in VM order, 40 ms apart, with matching AU2 cues', () => {
    for (const step of [...wave(5), ...wave(10)]) {
      const shots = firingOrder(step.frame);
      expect(shots.map(s => s.from)).toEqual([...step.frame.shots, ...step.frame.splashes].map(s => s.from).sort((a, b) => Number(a - b)));
      shots.forEach((s, i) => expect(s.at).toBe(20 + i * 40));
      expect(battleSounds(step, 'fire').map(s => s.delay)).toEqual(shots.map(s => s.at));
      if (shots.length) expect(step.phases.fire - shots.at(-1)!.at).toBe(180);
    }
  });
});


describe('RD7 recorded contacts', () => {
  it('maps biting units to 200 ms contact after a 100 ms wind-up and zero Gatebreaker bites to a resting pose', () => {
    const steps = wave(5), effects = steps.flatMap(biteEffects);
    expect(effects.some(e => e.kind === 'rest')).toBe(true);
    expect(effects.some(e => e.kind === 'bite')).toBe(true);
    for (const step of steps) for (const e of biteEffects(step)) {
      expect(step.frame.bites).toContainEqual({ group: e.group, cell: e.cell, damage: e.damage });
      expect(e.windup).toBe(100); expect(e.contact).toBe(200);
      expect(e.kind).toBe(e.damage ? 'bite' : 'rest');
      if (e.kind === 'rest') expect(step.before.find(g => g.id === e.group)?.bossPattern).toBe('gatebreaker');
    }
  });
  it('pops armour −1 and even-tick boss ÷2 only on recorded mitigations', () => {
    let built = { ...newRun(13n, 'practice'), wave: 9n };
    for (let cell = 0n; cell < 16n; cell++) built = withPart(built, cell, 1n, 3n);
    const steps = [...wave(5), ...wave(10), ...makeTimeline(built, fight(built).frames)], effects = steps.flatMap(blockEffects);
    expect(effects.some(e => e.kind === 'armour')).toBe(true);
    expect(effects.some(e => e.kind === 'halved')).toBe(true);
    for (const step of steps) for (const e of blockEffects(step)) {
      const mitigation = step.frame.mitigations!.find(m => m.group === e.group)!;
      expect(mitigation).toBeDefined();
      if (e.kind === 'armour') { expect(mitigation.splash).toBe(1n); expect(e.text).toBe('Armour −1'); }
      else { expect(step.frame.tick % 2n).toBe(0n); expect(mitigation.ballista).toBeGreaterThan(0n); expect(e.text).toBe('÷2'); }
    }
    expect(blockEffects({ ...steps[4], frame: { ...steps[4].frame, mitigations: [] } })).toEqual([]);
  });
});


describe('RD7 impact bodies and heat', () => {
  it('removes only recorded killed units, front first, 40 ms apart; boss holds for 100 ms and collapses for 600 ms', () => {
    const steps = [...wave(5), ...wave(10)]; let boss = false;
    for (const step of steps) for (const kill of step.frame.kills) {
      const deaths = unitRemovals(step, kill.group), prior = step.before.find(g => g.id === kill.group)!;
      expect(deaths.map(d => d.unit)).toEqual(Array.from({ length: Number(kill.count) }, (_, i) => i));
      expect(deaths.map(d => d.at)).toEqual(deaths.map((_, i) => prior.kind === 'boss' ? 100 : i * 40));
      if (prior.kind === 'boss') { expect(deaths[0].duration).toBe(600); boss = true; }
      expect(prior.count - step.frame.groups.find(g => g.id === kill.group)!.count).toBe(BigInt(deaths.length));
    }
    expect(boss).toBe(true);
    expect(unitRemovals(steps[0], steps[0].before[0].id)).toEqual([]);
  });
  it('covers the exact Cauldron range including entrance and Watchtower extension before trample', () => {
    for (const turn of recording) {
      let disabled = 0n;
      for (const step of makeTimeline(turn.built, turn.frames)) {
        for (const splash of splashCoverage(turn.built, step, disabled)) {
          expect(splash.targets).toEqual(step.frame.splashes.find(s => s.from === splash.from)!.targets.map(t => t.group));
          for (const id of splash.targets) {
            const target = step.before.find(g => g.id === id)!;
            expect(splash.cells).toContainEqual({ lane: target.lane, depth: target.pos });
          }
          const depth = splash.from % 4n + 1n;
          expect(splash.cells.some(c => c.depth === depth)).toBe(true);
        }
        disabled = step.frame.disabled;
      }
    }
    let built = { ...newRun(13n, 'practice'), wave: 9n };
    built = withPart(withPart(built, 2n, 2n, 1n), 6n, 5n, 1n);
    const step = makeTimeline(built, fight(built).frames).find(s => s.frame.splashes.length)!;
    expect(splashCoverage(built, step, 0n)[0].cells.map(c => c.depth)).toEqual([2n, 3n, 4n, 5n]);
    expect(splashCoverage(built, step, 1n << 6n)[0].cells.map(c => c.depth)).toEqual([3n, 4n, 5n]);
  });
});


describe('RD7 final assault', () => {
  it.each([5, 10])('starts each wave %i survivor after Move and ends at its own lane wall', waveNumber => {
    const turn = recording[waveNumber - 1], built = { ...turn.built, overclocked: 0n };
    const last = makeTimeline(built, fight(built).frames).at(-1)!;
    const charges = stormCharges(last), moved = ordinaryMovement(last);
    expect(charges.length).toBeGreaterThan(0);
    for (const charge of charges) {
      const survivor = moved.find(g => g.id === charge.group)!;
      expect(charge.from).toBe(survivor.pos); expect(charge.lane).toBe(survivor.lane);
      expect(charge.to).toBe(0n); expect(charge.from).toBeGreaterThan(0n);
      expect(last.frame.leaks.some(l => l.group === charge.group && l.lane === charge.lane)).toBe(true);
    }
  });
  it.each([1, 2])('takes 350 ms to dash and holds the last wall loss for 1000 ms at %i×', async speed => {
    const last = wave(5).at(-1)!; let clock = 0, contact = 0;
    await presentStorm(last, speed, (_lane, ms) => expect(ms).toBe(350 / speed), () => { contact = clock; }, async ms => { clock += ms; });
    expect(clock - contact).toBe(1000 / speed);
  });
});
