import { describe, expect, it } from 'vitest';
import { C, LIMITS as L, PART as P, PRICE } from '../src/v1/constants.js';
import { bots, legalActions } from '../src/v1/bots/index.js';
import { U64_MAX, RuleError, add, sub, mul, div, u64, newRun, utcDay, xorshift, roll,
  shop, forecast, waveForecast, applyAction, withPart, partAt, tierAt, upgradeCost, sellValue,
  fight, evaluateFight, previewLanes, playTurn, replayFrames, packState, unpackState,
  encodeActions, decodeActions, encodeEvent, decodeEvent, packGroup, unpackGroup, type Action, type RunState,
  leakDamage, type EnemyGroup, type TickFrame } from '../src/v1/sim.js';

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const clampSub = (a: bigint, b: bigint) => a > b ? a - b : 0n;
function expectUnitDamage(old: EnemyGroup, actual: EnemyGroup, frame: TickFrame): void {
  const nominalSingle = sum(frame.shots.filter(x => x.group === old.id).map(x => x.damage));
  const nominalSplash = sum(frame.splashes.flatMap(x => x.targets.filter(t => t.group === old.id).map(t => t.damage)));
  const single = old.bossPattern === 'last-siege' && frame.tick % 2n === 0n ? nominalSingle / 2n : nominalSingle;
  const splash = clampSub(nominalSplash, old.kind === 'brute' ? 1n : 0n);
  const mitigation = frame.mitigations?.find(m => m.group === old.id);
  expect(mitigation?.ballista ?? 0n).toBe(nominalSingle - single);
  expect(mitigation?.splash ?? 0n).toBe(nominalSplash - splash);
  // Independent per-unit oracle; production cleave uses constant-work arithmetic.
  let bolts = single;
  const units = Array.from({ length: Number(old.count) }, (_, i) => clampSub(i ? old.bodyHp : old.hp, splash))
    .map(hp => { const hit = hp < bolts ? hp : bolts; bolts -= hit; return hp - hit; }).filter(hp => hp > 0n);
  expect(actual.count).toBe(BigInt(units.length));
  expect(actual.hp).toBe(units[0] ?? 0n);
  expect(actual.bodyHp).toBe(clampSub(old.bodyHp, splash));
}

describe('Siege arithmetic and protocol', () => {
  it('checks operands as well as results, including full-width practice seeds', () => {
    for (const f of [() => u64(-1n), () => u64(U64_MAX + 1n), () => add(U64_MAX, 1n),
      () => sub(0n, 1n), () => mul(U64_MAX, 2n), () => div(1n, 0n), () => add(-1n, 1n),
      () => newRun(-1n, 'practice')]) expect(f).toThrow(RuleError);
    expect(div(7n, 2n)).toBe(3n);
    expect(utcDay(86400n * 20748n + 86399n)).toBe(20748n);
    for (const seed of [0n, 1n, U64_MAX]) {
      const s = newRun(seed, 'practice');
      expect(roll(seed, 10n, 1n, 6n)).toBeLessThanOrEqual(U64_MAX);
      expect(() => playTurn(s, [])).not.toThrow();
      expect(xorshift(seed)).toBeLessThanOrEqual(U64_MAX);
    }
    expect(() => fight({ ...newRun(1n, 'practice'), gold: U64_MAX })).toThrow(RuleError);
  });

  it('round-trips canonical state, actions and fixed-size chain event', () => {
    const actions: Action[] = [{ type: 'buy', slot: 3n, cell: 15n }, { type: 'upgrade', cell: 0n },
      { type: 'sell', cell: 9n }, { type: 'reroll' }, { type: 'buy', slot: 0n, cell: 0n }, { type: 'reroll' }];
    expect(decodeActions(encodeActions(actions))).toEqual(actions);
    for (const word of [7n, 1n | (4n << 3n) | (1n << 6n), 1n << 63n, 1n | (7n << 3n)]) {
      expect(() => decodeActions(word)).toThrow(RuleError);
    }
    const s = applyAction(newRun(U64_MAX, 'daily'), { type: 'buy', slot: 3n, cell: 15n });
    expect(unpackState(packState(s))).toEqual(s);
    const bad = packState(s); bad[3] |= 1n << 50n;
    expect(() => unpackState(bad)).toThrow(RuleError);
    const r = playTurn(newRun(20748n, 'daily'), []), event = encodeEvent(r.event);
    expect(event.length).toBe(156);
    expect(new TextDecoder().decode(event.slice(0, 4))).toBe('SGV1');
    expect(new DataView(event.buffer).getBigUint64(4, true)).toBe(20748n);
    expect(decodeEvent(event)).toEqual(r.event);
    const offset = new Uint8Array(event.length + 5); offset.set(event, 5);
    expect(decodeEvent(offset.subarray(5))).toEqual(r.event);
    expect(() => decodeEvent(event.subarray(1))).toThrow(RuleError);
  });

  it('rejects invalid board/control fields instead of truncating', () => {
    const s = newRun(0n, 'practice');
    for (const invalid of [{ ...s, parts: 7n }, { ...s, tiers: 1n }, { ...s, tiers: 1n << 32n },
      { ...s, wave: 11n }, { ...s, walls: C.START_WALLS + 1n }, { ...s, done: true },
      { ...s, rerolls: 1n }, { ...s, bought: 16n }]) expect(() => fight(invalid)).toThrow(RuleError);
    expect(() => withPart(s, 16n, P.BALLISTA, 1n)).toThrow(RuleError);
    expect(() => withPart(s, 0n, P.EMPTY, 1n)).toThrow(RuleError);
    expect(() => forecast(s, -1)).toThrow(RuleError);
  });
});

describe('Siege build phase', () => {
  it('has deterministic distinct stock, a guaranteed weapon and paid deterministic rerolls', () => {
    for (let seed = 0n; seed < 200n; seed++) {
      const s = newRun(seed, 'daily'), offers = shop(s);
      expect(new Set(offers.map(o => o.part)).size).toBe(4);
      expect(offers[0].part === P.BALLISTA || offers[0].part === P.CAULDRON).toBe(true);
      expect(shop(newRun(seed, 'practice'))).toEqual(offers);
      const bought = applyAction(s, { type: 'buy', slot: 0n, cell: 0n });
      expect(() => applyAction(bought, { type: 'buy', slot: 0n, cell: 1n })).toThrow('offer sold');
      const rolled = applyAction(bought, { type: 'reroll' });
      expect(rolled.gold).toBe(bought.gold - 1n);
      expect(rolled.bought).toBe(0n);
      expect(shop(rolled)[0].part).not.toBe(offers[0].part);
      expect(shop(rolled)).toEqual(shop({ ...s, actionsUsed: 2n, rerolls: 1n, gold: rolled.gold }));
    }
  });
  it('prices upgrades/sales from type and tier; building is pure and atomic', () => {
    const original = newRun(2n, 'practice'), copy = structuredClone(original);
    let s = applyAction(original, { type: 'buy', slot: 0n, cell: 1n });
    const p = partAt(s, 1n);
    expect(original).toEqual(copy);
    expect(() => applyAction(s, { type: 'buy', slot: 1n, cell: 1n })).toThrow('cell occupied');
    s = applyAction(s, { type: 'upgrade', cell: 1n });
    expect(tierAt(s, 1n)).toBe(2n);
    expect(s.gold).toBe(C.START_GOLD - PRICE[Number(p)] * 2n);
    const refund = sellValue(p, 2n), sold = applyAction(s, { type: 'sell', cell: 1n });
    expect(sold.gold).toBe(s.gold + refund);
    expect(partAt(sold, 1n)).toBe(0n); expect(tierAt(sold, 1n)).toBe(0n);
    expect(sellValue(p, 3n)).toBe((PRICE[Number(p)] * 2n + upgradeCost(p, 2n)) / 2n);
    expect(() => applyAction(sold, { type: 'sell', cell: 1n })).toThrow(RuleError);
    expect(() => playTurn(original, [{ type: 'buy', slot: 0n, cell: 0n }, { type: 'buy', slot: 0n, cell: 1n }])).toThrow(RuleError);
    expect(original).toEqual(copy);
  });
  it('enforces six actions across separate calls, stock, money and finished runs', () => {
    let s = { ...newRun(1n, 'practice'), gold: 100n };
    for (let k = 0; k < 6; k++) s = applyAction(s, { type: 'reroll' });
    expect(s.gold).toBe(79n);
    expect(() => applyAction(s, { type: 'reroll' })).toThrow('too many actions');
    expect(() => playTurn(s, [])).toThrow('start of turn');
    expect(() => applyAction({ ...newRun(1n, 'practice'), gold: 0n }, { type: 'reroll' })).toThrow('not enough gold');
    const lost = { ...newRun(1n, 'practice'), walls: 0n, done: true };
    expect(() => fight(lost)).toThrow('run is over');
    expect(() => applyAction(lost, { type: 'reroll' })).toThrow('run is over');
  });
  it('clears every opening threat pattern for 10g and two purchases, without rerolling', () => {
    const patterns = new Set<string>();
    for (const seed of [0n, 1n, 3n, 5n, 16n, 64n, 65n, 66n, 68n, 81n,
      7757891665551268098n, 10600302505202404369n, U64_MAX]) {
      let s = newRun(seed, 'practice');
      const offers = shop(s), incoming = waveForecast(seed, 1n);
      patterns.add(incoming.lanes.map(gs => gs[0]?.count ?? 0n).join('/'));
      expect(offers.some(o => o.part === P.PALISADE)).toBe(true);
      incoming.lanes.flat().forEach((group, i) => {
        const offer = offers.find(o => o.part === (i ? P.CAULDRON : P.BALLISTA))!;
        s = applyAction(s, { type: 'buy', slot: offer.slot, cell: group.lane * 4n + 1n });
      });
      expect(s.gold).toBe(4n); expect(s.actionsUsed).toBe(2n);
      const result = fight(s);
      expect(result.summary.damage).toBe(0n);
      expect(result.summary.clear).toBe(2n * C.CLEAR_GOLD);
      expect(result.summary.lanes.filter(l => l.spawned > 0n).every(l => l.kills === l.spawned)).toBe(true);
    }
    expect(patterns.size).toBe(12);
  });
});

describe('Siege battle and playback', () => {
  it('forecasts bounded groups and both named boss spikes from wave one', () => {
    const s = newRun(20748n, 'daily'), f = forecast(s, 3);
    expect(f.waves.map(w => w.wave)).toEqual([1n, 2n, 3n]);
    expect(f.bosses.map(w => w.wave)).toEqual([5n, 10n]);
    for (let seed = 0n; seed < 200n; seed++) {
      expect(previewLanes(newRun(seed, 'practice')).filter(l => l.result === 'LEAKS').length).toBeGreaterThanOrEqual(2);
      for (let w = 1n; w <= 10n; w++) for (const lane of waveForecast(seed, w).lanes) {
        expect(lane.length).toBeLessThanOrEqual(L.GROUPS_PER_LANE);
        for (const g of lane) {
          expect(g.maxHp).toBeLessThan(1n << BigInt(L.HP_BITS));
          expect(g.count).toBeLessThan(1n << BigInt(L.COUNT_BITS));
          expect(unpackGroup(packGroup(g), g)).toEqual(g);
        }
      }
    }
  });

  it('tramples supports, restores parts and Palisades, and storms without bounty at timeout', () => {
    let s = withPart(newRun(0n, 'practice'), 3n, P.QUARRY, 3n);
    const trampled = fight(s);
    expect(trampled.frames.some(f => f.tramples.some(t => t.cell === 3n))).toBe(true);
    expect(trampled.summary.quarry).toBe(0n);
    expect(partAt(trampled.state, 3n)).toBe(P.QUARRY);
    s = withPart(newRun(0n, 'practice'), 2n, P.PALISADE, 3n);
    const held = fight(s);
    expect(held.summary.retreats).toBe(0n);
    expect(held.summary.bounty).toBe(0n);
    expect(held.summary.lanes[0].damage).toBe(held.summary.lanes[0].spawned * C.SWARM_LEAK);
    expect(held.frames.at(-1)!.leaks.some(l => l.lane === 0n)).toBe(true);
    expect(held.summary.clear).toBe(0n);
    const again = fight(held.state);
    expect(again.frames[0].palisades.find(p => p.cell === 2n)?.hp).toBe(C.PALISADE_HP * 3n);
    expect(held.frames[0].groups.filter(g => g.status === 'active').every(g => g.pos === 5n)).toBe(true);
    expect(held.frames[0].shots).toEqual([]);
  });

  it('applies simultaneous targeting, all-unit bites, and break-then-move', () => {
    let s = newRun(20749n, 'practice');
    s = withPart(s, 0n, P.BALLISTA, 1n); s = withPart(s, 1n, P.BALLISTA, 1n);
    s = withPart(s, 4n, P.WATCHTOWER, 1n);
    const r = fight(s), f = r.frames.find(f => f.shots.filter(x => x.group === 0n).length === 2)!;
    const shots = f.shots.filter(x => x.group === 0n);
    expect(shots.length).toBe(2);
    expect(f.kills.find(k => k.group === 0n)?.count).toBe(waveForecast(s.seed, 1n).lanes[0][0].count);
    const blocker = fight(withPart(newRun(20749n, 'practice'), 2n, P.PALISADE, 1n));
    const biteDamage = waveForecast(20749n, 1n).lanes[0][0].count * C.SWARM_BITE;
    expect(blocker.frames.some(f => f.bites.some(b => b.damage === biteDamage))).toBe(true);
    const broken = blocker.frames.find(f => f.bites.length && f.palisades[0].hp === 0n)!;
    expect(broken.groups.find(g => g.id === 0n)?.pos).toBe(3n);
  });

  it('cleaves four rats with a 57-damage Ballista before they can trample it', () => {
    let s: RunState = { ...newRun(0n, 'practice'), wave: 8n };
    s = withPart(s, 5n, P.BALLISTA, 3n);
    s = withPart(s, 4n, P.FORGE, 3n); s = withPart(s, 6n, P.FORGE, 3n);
    s = withPart(s, 1n, P.WATCHTOWER, 3n);
    const initial = waveForecast(s.seed, 9n).lanes[1][0];
    expect(initial.count).toBe(4n);
    const result = fight(s), first = result.frames.find(f => f.shots.some(x => x.from === 5n))!;
    expect(first.shots.find(x => x.from === 5n)?.damage).toBe(57n);
    expect(first.kills.find(k => k.group === initial.id)?.count).toBe(4n);
    expect(first.groups.find(g => g.id === initial.id)?.status).toBe('dead');
    expect(result.frames.flatMap(f => f.tramples).some(t => t.group === initial.id && t.cell === 5n)).toBe(false);
  });

  it('never holds a tank lane without weapons, even with four fully upgraded blockers', () => {
    for (let seed = 0n; seed < 32n; seed++) for (let wave = 3n; wave <= 10n; wave++) {
      let s: RunState = { ...newRun(seed, 'practice'), wave: wave - 1n };
      for (let cell = 0n; cell < 16n; cell++) s = withPart(s, cell, P.PALISADE, 3n);
      const result = fight(s);
      waveForecast(seed, wave).lanes.forEach((groups, lane) => {
        expect(result.summary.lanes[lane].damage).toBe(sum(groups.map(g => g.count * g.leak)));
      });
      expect(result.summary.kills).toBe(0n); expect(result.summary.clear).toBe(0n);
      expect(result.summary.retreats).toBe(0n);
      expect(replayFrames(s, result.frames)).toEqual(result.state);
    }
  });

  it('replays frames to exactly the final state; each group conserves units, damage and movement', () => {
    for (let seed = 0n; seed < 24n; seed++) {
      let s = newRun(seed, 'practice');
      while (!s.done) {
        for (const action of bots.random(s)) s = applyAction(s, action);
        const before = structuredClone(s), r = fight(s);
        expect(s).toEqual(before);
        expect(evaluateFight(s).state).toEqual(r.state);
        expect(evaluateFight(s).summary).toEqual(r.summary);
        expect(replayFrames(s, r.frames)).toEqual(r.state);
        expect(fight(s)).toEqual(r);
        expect(r.frames.length).toBe(L.TICKS);
        let prior = waveForecast(s.seed, s.wave + 1n).lanes.flat(), disabled = 0n;
        for (const f of r.frames) {
          for (const g of f.groups) {
            expect(unpackGroup(packGroup(g), g)).toEqual(g);
            const old = prior.find(p => p.id === g.id)!;
            const kills = sum(f.kills.filter(k => k.group === g.id).map(k => k.count));
            expect(g.count).toBe(old.count - kills);
            if (old.status === 'active') {
              expectUnitDamage(old, g, f);
              if (g.count > 0n) expect(g.pos === old.pos || g.pos === old.pos - 1n
                || (f.tick === BigInt(L.TICKS) && g.status === 'leaked' && g.pos === 0n)).toBe(true);
            }
            for (const bite of f.bites.filter(b => b.group === g.id)) expect(bite.damage).toBe(g.count *
              (g.bossPattern === 'gatebreaker' ? f.tick % 2n === 0n ? 10n : 0n : g.bite));
            if (g.status === 'retreated') expect(f.tick).toBe(BigInt(L.TICKS));
          }
          for (const t of f.tramples) disabled |= 1n << t.cell;
          expect(f.disabled).toBe(disabled);
          prior = f.groups;
        }
        for (const l of r.summary.lanes) expect(l.spawned).toBe(l.kills + l.leaks + l.retreats);
        expect(r.state.totalKills).toBe(s.totalKills + r.summary.kills);
        expect(r.state.actionsUsed).toBe(0n); expect(r.state.bought).toBe(0n); expect(r.state.rerolls).toBe(0n);
        s = r.state;
      }
    }
  });

  it('wins only after wave ten and scores survival, walls and kills without rewarding banked gold', () => {
    let s = newRun(100n, 'practice');
    for (let lane = 0n; lane < 4n; lane++) {
      s = withPart(s, lane * 4n, P.BALLISTA, 3n);
      s = withPart(s, lane * 4n + 1n, P.FORGE, 3n);
      s = withPart(s, lane * 4n + 2n, P.BALLISTA, 3n);
      s = withPart(s, lane * 4n + 3n, P.PALISADE, 3n);
    }
    for (let w = 1n; w <= 10n; w++) {
      s = fight(s).state;
      expect(s.walls).toBeGreaterThan(0n);
      expect(s.done).toBe(w === 10n); expect(s.won).toBe(w === 10n);
      expect(s.score).toBe(w * C.SCORE_WAVE + s.walls * C.SCORE_WALL + s.totalKills * C.SCORE_KILL);
    }
  });

  it('gives identical score and combat for different unspent gold balances', () => {
    const s = newRun(10000n, 'practice');
    const low = fight(s), high = fight({ ...s, gold: 1000n });
    expect(high.state.score).toBe(low.state.score);
    expect(high.summary).toEqual(low.summary);
    expect(high.state.gold - low.state.gold).toBe(1000n - s.gold);
    expect(replayFrames({ ...s, gold: 1000n }, high.frames)).toEqual(high.state);
  });

  it('keeps combat work and all enemy fields inside the measured chain bounds', () => {
    expect(L.TICKS * L.GROUPS_PER_LANE).toBeLessThanOrEqual(40);
    expect(C.PALISADE_HP * BigInt(L.TIERS)).toBeLessThanOrEqual(255n);
    expect(C.BALLISTA_RANGE + BigInt(L.DEPTHS) + C.WATCH_RANGE).toBeLessThanOrEqual(7n);
    expect(C.CAULDRON_RANGE + BigInt(L.DEPTHS) + C.WATCH_RANGE).toBeLessThanOrEqual(7n);
    for (let seed = 10000n; seed < 10032n; seed++) for (let wave = 1n; wave <= 10n; wave++) {
      const f = waveForecast(seed, wave);
      for (const lane of f.lanes) {
        expect(lane.length).toBeLessThanOrEqual(4);
        if (wave >= 8n) {
          const heavy = lane.some(g => g.kind === 'brute' && g.count === 2n);
          const expected = (heavy ? [27n, 41n, 56n] : [21n, 29n, 38n])[Number(wave - 8n)];
          for (const g of lane.filter(g => g.kind === 'brute')) expect(g.hp).toBe(expected);
        }
        for (const g of lane) {
          expect(g.hp).toBeLessThanOrEqual(255n);
          expect(g.bite).toBeLessThanOrEqual(15n);
          expect(g.leak).toBeLessThanOrEqual(15n);
        }
      }
      if (f.boss) expect(f.boss.hp).toBe(f.lanes.flat().find(g => g.kind === 'boss')!.maxHp);
    }
  });

  it('caps supported weapon damage even on extreme legal layouts', () => {
    for (const weapon of [P.BALLISTA, P.CAULDRON]) {
      let s = { ...newRun(10000n, 'practice'), wave: 9n };
      for (let cell = 0n; cell < 16n; cell++) s = withPart(s, cell, P.FORGE, 3n);
      s = withPart(s, 5n, weapon, 3n);
      const frames = fight(s).frames;
      const damage = frames.flatMap(f => weapon === P.BALLISTA ? f.shots.map(x => x.damage) : f.splashes.flatMap(x => x.targets.map(t => t.damage)));
      expect(damage.length).toBeGreaterThan(0);
      expect(damage.every(d => d <= (weapon === P.BALLISTA ? 63n : 31n))).toBe(true);
      const uncapped = (weapon === P.BALLISTA ? C.BALLISTA_DAMAGE + C.FORGE_BALLISTA * 12n
        : C.CAULDRON_DAMAGE + C.FORGE_CAULDRON * 12n) * 3n;
      expect(damage[0]).toBe(uncapped < (weapon === P.BALLISTA ? 63n : 31n) ? uncapped : (weapon === P.BALLISTA ? 63n : 31n));
    }
  });

  it('bot action sets are legal and deterministic', () => {
    for (const bot of Object.values(bots)) {
      const s = newRun(42n, 'practice'), actions = bot(s);
      expect(bot(s)).toEqual(actions);
      expect(actions.length).toBeLessThanOrEqual(L.ACTIONS);
      expect(() => playTurn(s, actions)).not.toThrow();
    }
    expect(legalActions({ ...newRun(0n, 'practice'), walls: 0n, done: true })).toEqual([]);
  });

  it('spends a rich final reserve on overclocks that save two losing lanes', () => {
    let s: RunState = { ...newRun(20748n, 'practice'), wave: 9n, walls: 3n, gold: 64n };
    for (let lane = 0n; lane < 4n; lane++) {
      s = withPart(s, lane * 4n, P.FORGE, 3n);
      s = withPart(s, lane * 4n + 1n, P.BALLISTA, 3n);
      s = withPart(s, lane * 4n + 2n, P.PALISADE, 1n);
    }
    expect(fight(s).summary.damage).toBe(16n);
    const actions = bots.planner(s);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some(a => a.type === 'overclock')).toBe(true);
    for (const action of actions) s = applyAction(s, action);
    const saved = fight(s);
    expect(saved.summary.damage).toBe(0n);
    expect(saved.state.won).toBe(true);
    expect(saved.state.walls).toBe(3n);
  });

  it('buys the visible cheap Palisade and upgrades it instead of fighting with 46g and leaks', () => {
    let s: RunState = { ...newRun(20748n, 'practice'), wave: 9n, walls: 10n, gold: 46n };
    for (let lane = 0n; lane < 4n; lane++) {
      s = withPart(s, lane * 4n, P.FORGE, 3n);
      s = withPart(s, lane * 4n + 1n, P.BALLISTA, 3n);
      if (lane < 3n) s = withPart(s, lane * 4n + 2n, P.PALISADE, 2n);
    }
    const offer = shop(s).find(o => o.part === P.PALISADE)!;
    expect(offer.price).toBe(2n);
    expect(fight(s).summary.damage).toBe(17n);
    expect(fight(applyAction(s, { type: 'buy', slot: offer.slot, cell: 14n })).summary.damage).toBe(14n);
    const actions = bots.planner(s, { overclock: false });
    for (const action of actions) s = applyAction(s, action);
    expect(actions.some(a => a.type === 'buy' && a.slot === offer.slot)).toBe(true);
    expect(fight(s).summary.damage).toBe(5n);
    expect(s.gold).toBeLessThan(46n);
  });

  it('clears the reviewed seed-4 board with a replacement and an overclock', () => {
    const start: RunState = { ...newRun(4n, 'practice'), wave: 9n, walls: 18n, gold: 22n,
      parts: 157912001753973780n, tiers: 658315806n };
    expect(shop(start).some(o => o.available && o.part === P.BALLISTA && o.price === 5n)).toBe(true);
    expect(fight(start).summary.lanes[3].damage).toBe(7n);
    const actions = bots.planner(start);
    expect(actions).toEqual(bots.planner(start));
    expect(actions.length).toBeLessThanOrEqual(L.ACTIONS);
    expect(actions.some(a => a.type === 'sell')).toBe(true);
    const built = actions.reduce(applyAction, start), resolved = fight(built);
    expect(resolved.summary.damage).toBe(0n);
    expect(resolved.state.walls).toBe(18n);
    expect(built.gold).toBeLessThan(22n);
    expect(start.gold).toBe(22n);
  });

  it('keeps planner exclusions and upgrade ablations on final replacement paths', () => {
    const start: RunState = { ...newRun(4n, 'practice'), wave: 9n, walls: 18n, gold: 22n,
      parts: 157912001753973780n, tiers: 658315806n };
    let state = start;
    for (const action of bots.planner(start, { excludeParts: [P.FORGE], upgrades: false })) {
      expect(action.type).not.toBe('upgrade');
      if (action.type === 'buy') expect(shop(state)[Number(action.slot)].part).not.toBe(P.FORGE);
      state = applyAction(state, action);
    }
    const constrained = { ...start, actionsUsed: 5n };
    const actions = bots.planner(constrained);
    expect(actions.length).toBeLessThanOrEqual(1);
    expect(() => actions.reduce(applyAction, constrained)).not.toThrow();
  });

  it('does not spend terminal gold on upgrades that save neither walls nor kills', () => {
    const start: RunState = { ...newRun(4n, 'practice'), wave: 9n, walls: 18n, gold: 7n,
      parts: 157912001753973780n, tiers: 658315806n };
    const idle = fight(start), partial = fight(applyAction(start, { type: 'upgrade', cell: 14n }));
    expect(partial.summary.damage).toBe(idle.summary.damage);
    expect(partial.summary.kills).toBe(idle.summary.kills);
    const actions = bots.planner(start), resolved = fight(actions.reduce(applyAction, start));
    expect(!actions.length || resolved.summary.damage < idle.summary.damage || resolved.summary.kills > idle.summary.kills).toBe(true);
  });

  it('conserves units and HP on varied late-wave boards, not only reachable random openings', () => {
    for (let seed = 0n; seed < 160n; seed++) {
      let s: RunState = { ...newRun(seed, 'practice'), wave: seed % 10n }, r = xorshift(seed + 107n);
      for (let cell = 0n; cell < 16n; cell++) {
        r = xorshift(r); const part = r % 7n, tier = part ? 1n + (r >> 9n) % 3n : 0n;
        s = withPart(s, cell, part, tier);
      }
      const f = fight(s);
      expect(replayFrames(s, f.frames)).toEqual(f.state);
      for (const lane of f.summary.lanes) expect(lane.kills + lane.leaks + lane.retreats).toBe(lane.spawned);
      let prior = waveForecast(s.seed, s.wave + 1n).lanes.flat();
      for (const frame of f.frames) { for (const g of frame.groups) {
        const old = prior.find(p => p.id === g.id)!;
        if (old.status === 'active') expectUnitDamage(old, g, frame);
        expect(unpackGroup(packGroup(g), g)).toEqual(g);
        expect(g.hp).toBeLessThanOrEqual(g.bodyHp);
        expect(g.bodyHp).toBeLessThanOrEqual(g.maxHp);
        if (g.status === 'active' || g.status === 'retreated') {
          const ahead = frame.groups.filter(a => a.lane === g.lane && a.order < g.order
            && (a.status === 'active' || a.status === 'retreated'));
          for (const a of ahead) expect(a.pos).toBeLessThanOrEqual(g.pos);
        }
      } prior = frame.groups; }
      expect(unpackState(packState(f.state))).toEqual(f.state);
    }
  });
});
