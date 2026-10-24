import { describe, expect, it } from 'vitest';
import { C, LIMITS as L, PART as P } from '../src/v1/constants.js';
import { applyAction, fight, leakDamage, newRun, waveForecast, withPart } from '../src/v1/sim.js';
import { bossLeakThresholds, bossPattern, mechanicRecap, overclockOption } from './mechanics.js';
import { BuildQueue } from './queue.js';
import { InvestmentCache } from './insights.js';
import { statsAt } from './parts.js';

describe('pass 6 decisions and feedback', () => {
  it('shows global tick parity and exact boss leak thresholds', () => {
    const gate = waveForecast(4n, 5n), last = waveForecast(4n, BigInt(L.WAVES));
    expect(bossPattern(gate.boss!, 6n)).toBe(`Even tick: boss bites ${gate.boss!.biteEven}`);
    expect(bossPattern(gate.boss!, 7n)).toBe('Odd tick: boss rests');
    expect(bossPattern(last.boss!, 6n)).toContain(`÷${last.boss!.ballistaDivisorEven}`);
    expect(bossPattern(last.boss!, 7n)).toContain('Full bolts');
    const boss = gate.lanes.flat().find(g => g.kind === 'boss')!;
    for (let i = 1n; i < C.BOSS_LEAK_HP; i++) {
      const g = { ...boss, hp: i, maxHp: C.BOSS_LEAK_HP };
      const damage = leakDamage(g);
      expect(bossLeakThresholds(boss)).toContain(`${i * 100n / C.BOSS_LEAK_HP}% HP: −${damage} ${damage === 1n ? 'wall' : 'walls'}`);
    }
  });

  it('queues and undoes a capped boost and keeps investment previews distinct', () => {
    let built = { ...newRun(4n, 'practice'), gold: 100n };
    built = withPart(built, 5n, P.BALLISTA, BigInt(L.TIERS));
    for (const cell of [1n, 4n, 6n, 9n]) built = withPart(built, cell, P.FORGE, BigInt(L.TIERS));
    const option = overclockOption(built, 5n);
    const queue = new BuildQueue(built), before = queue.state;
    expect(option.reason).toBe('');
    expect(queue.attempt({ type: 'overclock', cell: 5n }).ok).toBe(true);
    expect(statsAt(queue.state, 5n).value - statsAt(before, 5n).value).toBe(option.gain);
    expect(statsAt(queue.state, 5n).value).toBe(C.BALLISTA_CAP);
    expect(queue.state.gold).toBe(before.gold - C.OVERCLOCK_COST);
    expect(overclockOption(queue.state, 5n).reason).toContain('Already charged');
    const cache = new InvestmentCache();
    expect(cache.project(queue.state)[0]).toEqual(fight(queue.state));
    expect(cache.project(queue.state)).not.toBe(cache.project(before));
    queue.undo();
    expect(queue.state).toEqual(before);
  });

  it('explains unsupported, low-tier, unaffordable, and exhausted overclocks', () => {
    const start = { ...newRun(4n, 'practice'), gold: C.OVERCLOCK_COST - 1n };
    expect(overclockOption(withPart(start, 0n, P.QUARRY, 3n), 0n).reason).toContain('Requires');
    expect(overclockOption(withPart(start, 0n, P.BALLISTA, 2n), 0n).reason).toContain('Requires');
    const palisade = withPart(start, 0n, P.PALISADE, BigInt(L.TIERS));
    expect(overclockOption(palisade, 0n)).toMatchObject({ gain: C.OVERCLOCK_HP, hp: true });
    expect(overclockOption(palisade, 0n).reason).toContain('Not enough gold');
    expect(overclockOption({ ...palisade, actionsUsed: BigInt(L.ACTIONS) }, 0n).reason).toContain(`Max ${L.ACTIONS}`);
  });

  it('accounts for mitigation, current boss HP, temporary spend and deep income from resolved events', () => {
    let built = { ...newRun(20748n, 'practice'), wave: 9n, gold: 100n };
    for (let lane = 0n; lane < BigInt(L.LANES); lane++) {
      built = withPart(built, lane * 4n, P.BALLISTA, 3n);
      built = withPart(built, lane * 4n + 1n, P.CAULDRON, 3n);
      built = withPart(built, lane * 4n + 2n, P.PALISADE, 3n);
      built = withPart(built, lane * 4n + 3n, P.QUARRY, 1n);
    }
    built = withPart(built, 12n, P.WATCHTOWER, 2n);
    built = applyAction(built, { type: 'overclock', cell: 0n });
    const result = fight(built), lines = mechanicRecap(built, result).join('\n');
    const mitigations = result.frames.flatMap(f => f.mitigations ?? []);
    const bolts = mitigations.reduce((s, m) => s + m.ballista, 0n);
    const splash = mitigations.reduce((s, m) => s + m.splash, 0n);
    expect(bolts).toBeGreaterThan(0n); expect(splash).toBeGreaterThan(0n);
    expect(lines).toContain(`Shield blocked ${bolts}`);
    expect(lines).toContain(`Armor blocked ${splash}`);
    expect(lines).toContain(`${C.OVERCLOCK_COST}g spent`);
    expect(lines).toContain(`Quarry +${result.summary.quarry}g, includes +${result.summary.deepQuarry}g`);
    const boss = result.frames.at(-1)!.groups.find(g => g.kind === 'boss')!;
    expect(lines).toContain(`−${leakDamage(boss)} walls`);
  });

  it('includes deep gold only once and remembers a charge sold before the battle', () => {
    let start = { ...newRun(20748n, 'practice'), gold: 100n };
    start = withPart(start, 1n, P.BALLISTA, 3n);
    start = withPart(start, 2n, P.QUARRY, 1n);
    start = withPart(start, 3n, P.QUARRY, 1n);
    const result = fight(start);
    expect(result.frames.some(f => f.tramples.some(t => t.cell === 3n))).toBe(true);
    expect(result.frames.some(f => f.tramples.some(t => t.cell === 2n))).toBe(false);
    expect(result.summary.deepQuarry).toBe(C.QUARRY_DEEP);
    expect(result.summary.quarry).toBe(C.QUARRY_GOLD + C.QUARRY_DEEP);
    expect(mechanicRecap(start, result).join()).toContain(`includes +${C.QUARRY_DEEP}g deep bonus`);
    const actions = [{ type: 'overclock' as const, cell: 1n }, { type: 'sell' as const, cell: 1n }];
    const built = actions.reduce(applyAction, start);
    expect(built.overclocked).toBe(0n);
    expect(mechanicRecap(built, fight(built), actions).join()).toContain(`0 charged · ${C.OVERCLOCK_COST}g spent`);
  });
});
