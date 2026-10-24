import { describe, expect, it } from 'vitest';
import { C, LIMITS as L, PART as P } from '../src/v1/constants.js';
import { legalActions, planner } from '../src/v1/bots/index.js';
import { applyAction, newRun, withPart, waveForecast, fight, evaluateFight, replayFrames, leakDamage,
  packState, unpackState, encodeActions, decodeActions, encodeEvent, decodeEvent, playTurn, type RunState } from '../src/v1/sim.js';

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe('Siege boss identities and armor', () => {
  it('publishes exact boss parity and leak rules before the wave', () => {
    for (const wave of [5n, 10n]) {
      const f = waveForecast(13n, wave), boss = f.boss!;
      expect(boss.pattern).toBe(wave === 5n ? 'gatebreaker' : 'last-siege');
      expect([boss.biteOdd, boss.biteEven]).toEqual(wave === 5n ? [0n, 10n] : [5n, 5n]);
      expect([boss.ballistaDivisorOdd, boss.ballistaDivisorEven]).toEqual(wave === 5n ? [1n, 1n] : [1n, 2n]);
      expect([boss.leakMin, boss.leakMax]).toEqual([5n, 8n]);
      expect(f.lanes.flat().find(g => g.kind === 'boss')!.bossPattern).toBe(boss.pattern);
    }
  });

  it('Gatebreaker pauses bites on odd ticks and strikes for ten on even ticks', () => {
    let s = { ...newRun(13n, 'practice'), wave: 4n };
    const f = waveForecast(s.seed, 5n), boss = f.lanes.flat().find(g => g.kind === 'boss')!;
    for (let d = 0n; d < 4n; d++) s = withPart(s, boss.lane * 4n + d, P.PALISADE, 3n);
    const bites = fight(s).frames.flatMap(f => f.bites.filter(b => b.group === boss.id).map(b => ({ tick: f.tick, damage: b.damage })));
    expect(bites.some(b => b.tick % 2n === 0n)).toBe(true);
    expect(bites.some(b => b.tick % 2n === 1n)).toBe(true);
    for (const b of bites) expect(b.damage).toBe(b.tick % 2n === 0n ? 10n : 0n);
  });

  it('Last Siege halves pooled bolts once on even ticks and leaves splash full', () => {
    let observedEven = 0, observedOdd = 0, observedSplash = 0, observedPooledOdds = 0;
    for (let seed = 0n; seed < 16n; seed++) {
      let s: RunState = { ...newRun(seed, 'practice'), wave: 9n };
      const boss = waveForecast(seed, 10n).lanes.flat().find(g => g.kind === 'boss')!;
      for (let lane = 0n; lane < 4n; lane++) {
        s = withPart(s, lane * 4n, P.BALLISTA, 3n);
        s = withPart(s, lane * 4n + 1n, P.CAULDRON, 3n);
        s = withPart(s, lane * 4n + 2n, P.PALISADE, 3n);
      }
      if (seed % 2n === 0n) s = withPart(s, boss.lane * 4n + 1n, P.BALLISTA, 1n);
      s = withPart(s, 12n, P.WATCHTOWER, 3n); s = withPart(s, 13n, P.WATCHTOWER, 3n);
      let prior = boss;
      for (const frame of fight(s).frames) {
        const bolts = sum(frame.shots.filter(x => x.group === boss.id).map(x => x.damage));
        const splash = sum(frame.splashes.flatMap(x => x.targets.filter(t => t.group === boss.id).map(t => t.damage)));
        const after = frame.groups.find(g => g.id === boss.id)!;
        if (bolts > 0n) {
          const absorbed = frame.mitigations?.find(m => m.group === boss.id)?.ballista ?? 0n;
          expect(absorbed).toBe(frame.tick % 2n === 0n ? bolts - bolts / 2n : 0n);
          if (frame.tick % 2n === 0n) observedEven++; else observedOdd++;
          const hits = frame.shots.filter(x => x.group === boss.id);
          if (frame.tick % 2n === 0n && hits.filter(x => x.damage % 2n === 1n).length >= 2) {
            expect(bolts - absorbed).toBeGreaterThan(sum(hits.map(x => x.damage / 2n))); observedPooledOdds++;
          }
        }
        if (prior.status === 'active' && after.count > 0n) {
          const damage = (frame.tick % 2n === 0n ? bolts / 2n : bolts) + splash;
          expect(after.hp).toBe(prior.hp > damage ? prior.hp - damage : 0n);
          if (splash > 0n) observedSplash++;
        }
        prior = after;
      }
    }
    expect(observedEven).toBeGreaterThan(0); expect(observedOdd).toBeGreaterThan(0); expect(observedSplash).toBeGreaterThan(0);
    expect(observedPooledOdds).toBeGreaterThan(0);
  });

  it('boss leak rounds up at exact HP fractions and decreases with damage', () => {
    for (const wave of [5n, 10n]) {
      const boss = waveForecast(13n, wave).lanes.flat().find(g => g.kind === 'boss')!;
      let last = 0n;
      for (let hp = 1n; hp <= boss.maxHp; hp++) {
        const damage = leakDamage({ ...boss, hp });
        expect(damage).toBe(4n + (4n * hp + boss.maxHp - 1n) / boss.maxHp);
        expect(damage).toBeGreaterThanOrEqual(last); expect(damage).toBeGreaterThanOrEqual(5n); expect(damage).toBeLessThanOrEqual(8n);
        last = damage;
      }
      expect(leakDamage({ ...boss, hp: 0n, count: 0n, status: 'dead' })).toBe(0n);
    }
  });

  it('ordinary boss leaks and storm leaks both use remaining HP', () => {
    let normal = 0, storm = 0;
    for (let blocker = 0n; blocker <= 3n; blocker++) for (let seed = 0n; seed < 16n; seed++) {
      let s: RunState = { ...newRun(seed, 'practice'), wave: 9n };
      const boss = waveForecast(seed, 10n).lanes.flat().find(g => g.kind === 'boss')!;
      s = withPart(s, boss.lane * 4n, P.BALLISTA, 2n);
      if (blocker) s = withPart(s, boss.lane * 4n + 2n, P.PALISADE, blocker);
      for (const frame of fight(s).frames) for (const leak of frame.leaks.filter(l => l.group === boss.id)) {
        const g = frame.groups.find(g => g.id === boss.id)!;
        expect(leak.damage).toBe(4n + (4n * g.hp + g.maxHp - 1n) / g.maxHp);
        if (frame.tick === 10n) storm++; else normal++;
      }
    }
    expect(normal).toBeGreaterThan(0); expect(storm).toBeGreaterThan(0);
  });

  it('Brute armor subtracts one from pooled splash, while Swarm takes every point', () => {
    let s = { ...newRun(5n, 'practice'), wave: 5n };
    s = withPart(s, 0n, P.CAULDRON, 1n); s = withPart(s, 1n, P.CAULDRON, 1n);
    const f = waveForecast(s.seed, 6n), brute = f.lanes[0].find(g => g.kind === 'brute')!;
    expect(brute.splashArmor).toBe(1n); expect(f.lanes[0][0].splashArmor).toBe(0n);
    let checkedPool = false, checkedZero = false, prior = f.lanes[0];
    for (const frame of fight(s).frames) {
      const raw = sum(frame.splashes.flatMap(x => x.targets.filter(t => t.group === brute.id).map(t => t.damage)));
      const before = prior.find(g => g.id === brute.id)!, after = frame.groups.find(g => g.id === brute.id)!;
      if (raw > 0n) {
        expect(before.hp - after.hp).toBe(raw - 1n);
        expect(frame.mitigations!.find(m => m.group === brute.id)?.splash).toBe(1n);
        if (raw === 2n) checkedPool = true;
        if (raw === 1n) checkedZero = true;
      }
      prior = frame.groups.filter(g => g.lane === 0n);
    }
    expect(checkedPool).toBe(true); expect(checkedZero).toBe(true);
  });
});

describe('Siege forward economy and overclock', () => {
  it('pays deep Quarry bonus once per surviving cell, independent of tier, with adjacency', () => {
    for (const depth of [0n, 1n, 2n, 3n]) for (const tier of [1n, 2n, 3n]) {
      // Lane one is quiet on this opening. No protection is needed there.
      let s = newRun(0n, 'practice');
      const lane = waveForecast(0n, 1n).lanes.findIndex(gs => gs.length === 0), cell = BigInt(lane) * 4n + depth;
      s = withPart(s, cell, P.QUARRY, tier);
      expect(fight(s).summary.quarry).toBe(2n * tier + (depth >= 2n ? 1n : 0n));
      if (depth === 2n) {
        s = withPart(s, cell + 1n, P.QUARRY, 1n);
        expect(fight(s).summary.quarry).toBe(2n * tier + 2n + 2n + 2n);
      }
    }
    const trampled = fight(withPart(newRun(0n, 'practice'), 3n, P.QUARRY, 3n));
    expect(trampled.summary.quarry).toBe(0n);
  });

  it('overclocks only tier-three combat parts once, charges one order, and rejects bad input atomically', () => {
    const start = { ...newRun(0n, 'practice'), gold: 100n };
    for (const part of [P.BALLISTA, P.CAULDRON, P.PALISADE, P.FORGE, P.WATCHTOWER, P.QUARRY]) for (const tier of [1n, 2n, 3n]) {
      const s = withPart(start, 15n, part, tier), old = structuredClone(s);
      const action = { type: 'overclock' as const, cell: 15n };
      if (part <= P.PALISADE && tier === 3n) {
        const hot = applyAction(s, action);
        expect(hot.gold).toBe(100n - C.OVERCLOCK_COST); expect(hot.actionsUsed).toBe(1n); expect(hot.overclocked).toBe(1n << 15n);
        expect(() => applyAction(hot, action)).toThrow('already overclocked');
        expect(() => applyAction({ ...s, gold: C.OVERCLOCK_COST - 1n }, action)).toThrow('not enough gold');
        expect(legalActions(s)).toContainEqual(action);
        const sold = applyAction(hot, { type: 'sell', cell: 15n }); expect(sold.overclocked).toBe(0n);
      } else expect(() => applyAction(s, action)).toThrow('tier-three');
      expect(s).toEqual(old);
    }
    expect(() => applyAction(start, { type: 'overclock', cell: 16n })).toThrow('index');
    expect(() => fight({ ...start, overclocked: 1n << 16n })).toThrow();
    expect(() => fight({ ...start, overclocked: 1n })).toThrow('invalid overclock');
  });

  it('adds half damage before the existing caps, clears the mask on settlement, and replays', () => {
    for (const part of [P.BALLISTA, P.CAULDRON]) {
      const s = withPart({ ...newRun(0n, 'practice'), gold: 100n }, 1n, part, 3n);
      const hot = applyAction(s, { type: 'overclock', cell: 1n }), r = fight(hot);
      const damage = part === P.BALLISTA ? r.frames.flatMap(f => f.shots).map(x => x.damage)
        : r.frames.flatMap(f => f.splashes).flatMap(x => x.targets).map(x => x.damage);
      expect(damage[0]).toBe(part === P.BALLISTA ? 18n : 4n);
      expect(r.state.overclocked).toBe(0n); expect(evaluateFight(hot).summary).toEqual(r.summary);
      expect(replayFrames(hot, r.frames)).toEqual(r.state);
    }
    const s = withPart({ ...newRun(0n, 'practice'), gold: 100n }, 2n, P.PALISADE, 3n);
    const r = fight(applyAction(s, { type: 'overclock', cell: 2n }));
    expect(r.frames[0].palisades[0].hp).toBe(48n + C.OVERCLOCK_HP);
    expect(r.frames[0].palisades[0].hp).toBeLessThan(1n << BigInt(L.PALISADE_HP_BITS));
    expect(fight(r.state).frames[0].palisades[0].hp).toBe(48n);
  });

  it('round-trips overclock state and commands without growing events or accepting slot bits', () => {
    const s = withPart({ ...newRun(1n, 'practice'), gold: 100n }, 15n, P.BALLISTA, 3n);
    const action = { type: 'overclock' as const, cell: 15n }, hot = applyAction(s, action);
    expect(unpackState(packState(hot))).toEqual(hot);
    expect(decodeActions(encodeActions([action]))).toEqual([action]);
    expect(() => decodeActions(1n | ((5n | (1n << 7n)) << 3n))).toThrow('noncanonical');
    expect(packState(hot)[3] >> 34n).toBe(1n << 15n);
    const r = playTurn(s, [action]); expect(encodeEvent(r.event).length).toBe(156);
    expect(decodeEvent(encodeEvent(r.event))).toEqual(r.event);
    const { overclocked: _, ...legacy } = s;
    expect(packState(legacy)).toEqual(packState(s));
    expect(fight(legacy).state).toEqual(fight(s).state);
  });

  it('removes a sold boost and permits a fresh replacement without stacking or refunding the boost', () => {
    const s = withPart({ ...newRun(1n, 'practice'), gold: 100n }, 0n, P.BALLISTA, 3n);
    const actions = [{ type: 'overclock', cell: 0n }, { type: 'sell', cell: 0n },
      { type: 'buy', slot: 0n, cell: 0n }, { type: 'upgrade', cell: 0n },
      { type: 'upgrade', cell: 0n }, { type: 'overclock', cell: 0n }] as const;
    const sold = actions.slice(0, 2).reduce(applyAction, s);
    expect(sold.overclocked).toBe(0n); expect(sold.gold).toBe(100n - C.OVERCLOCK_COST + 8n);
    const rebuilt = actions.reduce(applyAction, s);
    expect(rebuilt.overclocked).toBe(1n); expect(rebuilt.actionsUsed).toBe(6n);
    expect(rebuilt.gold).toBe(100n + 8n - 17n - 2n * C.OVERCLOCK_COST);
    expect(() => applyAction(rebuilt, { type: 'overclock', cell: 0n })).toThrow('too many actions');
    expect(replayFrames(rebuilt, fight(rebuilt).frames)).toEqual(fight(rebuilt).state);
  });

  it('respects the overclock exclusion throughout search and repair', () => {
    let s: RunState = { ...newRun(20748n, 'practice'), wave: 9n, walls: 3n, gold: 64n };
    for (let lane = 0n; lane < 4n; lane++) {
      s = withPart(s, lane * 4n, P.FORGE, 3n); s = withPart(s, lane * 4n + 1n, P.BALLISTA, 3n);
      s = withPart(s, lane * 4n + 2n, P.PALISADE, 1n);
    }
    expect(planner(s, { overclock: false }).every(a => a.type !== 'overclock')).toBe(true);
    const actions = planner(s); expect(actions.some(a => a.type === 'overclock')).toBe(true);
    expect(fight(actions.reduce(applyAction, s)).summary.damage).toBe(0n);
  });
});
