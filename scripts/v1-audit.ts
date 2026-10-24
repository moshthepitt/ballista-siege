import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { C, LIMITS, PART } from '../src/v1/constants.js';
import { U64_MAX, applyAction, fight, evaluateFight, newRun, replayFrames, shop, waveForecast, withPart, xorshift,
  packGroup, unpackGroup, packState, unpackState, type RunState } from '../src/v1/sim.js';

// Every u64 seed selects one of twelve opening threat patterns: lane zero plus
// one of three other lanes, with either two or three rats in each active lane.
// The two weapons are guaranteed independently of the shuffled support offer.
assert.equal(C.OPENING_LANES, 2n);
assert.equal(C.SWARM_BASE, 2n);
assert.equal(C.SWARM_SPREAD, 2n);
const patterns = new Map<string, bigint>();
let checkedSeeds = 0;
let sample = 0x123456789abcdefn;
for (const seed of [...Array.from({ length: 4096 }, (_, i) => BigInt(i)),
  ...Array.from({ length: 4096 }, () => sample = xorshift(sample)), U64_MAX, U64_MAX - 1n,
  ...Array.from({ length: 64 }, (_, i) => 1n << BigInt(i))]) {
  const state = newRun(seed, 'practice'), offers = shop(state), incoming = waveForecast(seed, 1n);
  assert(offers.some(o => o.part === PART.PALISADE));
  assert(offers.some(o => o.part === PART.BALLISTA));
  assert(offers.some(o => o.part === PART.CAULDRON));
  const active = incoming.lanes.flat();
  assert.equal(active.length, 2);
  const key = incoming.lanes.map(gs => gs[0]?.count ?? 0n).join('/');
  checkedSeeds++;
  if (patterns.has(key)) continue;
  patterns.set(key, seed);
  let built = state;
  active.forEach((group, i) => {
    const part = i === 0 ? PART.BALLISTA : PART.CAULDRON;
    const offer = offers.find(o => o.part === part)!;
    built = applyAction(built, { type: 'buy', slot: offer.slot, cell: group.lane * 4n + 1n });
  });
  const resolved = fight(built);
  assert.equal(built.gold, C.START_GOLD - 10n);
  assert.equal(built.actionsUsed, 2n);
  assert.equal(resolved.summary.damage, 0n);
  assert.equal(resolved.summary.kills, active.reduce((n, g) => n + g.count, 0n));
  assert.equal(fight(state).summary.lanes.filter(l => l.damage > 0n).length, 2);
  assert.deepEqual(replayFrames(built, resolved.frames), resolved.state);
}
assert.equal(patterns.size, 12, 'all possible opening threat patterns exercised');

// Exhaust all 4^4 blocker layouts (empty or tier 1/2/3 at every depth) in the
// reviewed seed's boss lane. Supports cannot hurt enemies, so zero weapons must
// lose every surviving unit to an ordinary leak or the tick-ten storm.
let blockerCases = 0, bossStorms = 0;
for (const wave of [5n, 10n]) {
  const incoming = waveForecast(13n, wave), lane = incoming.boss!.lane;
  const expected = incoming.lanes[Number(lane)].reduce((n, g) => n + g.count * g.leak, 0n);
  for (let layout = 0; layout < 256; layout++) {
    let built = { ...newRun(13n, 'practice'), wave: wave - 1n };
    for (let depth = 0; depth < 4; depth++) {
      const tier = BigInt((layout >> (depth * 2)) & 3);
      if (tier) built = withPart(built, lane * 4n + BigInt(depth), PART.PALISADE, tier);
    }
    const resolved = fight(built);
    assert.equal(resolved.summary.lanes[Number(lane)].damage, expected);
    assert.equal(resolved.summary.kills, 0n);
    assert.equal(resolved.summary.clear, 0n);
    assert.equal(resolved.summary.retreats, 0n);
    assert.deepEqual(replayFrames(built, resolved.frames), resolved.state);
    if (resolved.frames.at(-1)!.leaks.some(e => incoming.lanes[Number(lane)]
      .some(g => g.id === e.group && g.kind === 'boss'))) bossStorms++;
    blockerCases++;
  }
}
assert.equal(LIMITS.TICKS * LIMITS.GROUPS_PER_LANE, 40);
assert(C.PALISADE_HP * 3n + C.OVERCLOCK_HP < 1n << BigInt(LIMITS.PALISADE_HP_BITS));
// Dense injected boards reach later mechanics that random opening bots seldom see.
// The independent HP oracle expands units; production remains constant work/group.
let denseBoards = 0, oracleGroups = 0, parityBites = 0, shieldedTicks = 0, chippedBossLeaks = 0, deepBonus = 0, overclocks = 0;
const minus = (a: bigint, b: bigint) => a > b ? a - b : 0n;
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
for (let sample = 0; sample < 600; sample++) {
  let rng = xorshift(BigInt(sample) + 0xabc123n);
  let s: RunState = { ...newRun(sample % 2 ? U64_MAX - BigInt(sample) : rng, 'practice'), wave: BigInt(sample % 10), gold: 500n };
  for (let cell = 0n; cell < 16n; cell++) {
    rng = xorshift(rng); const p = rng % 7n, tier = p ? 1n + (rng >> 9n) % 3n : 0n;
    s = withPart(s, cell, p, tier);
    if (p > 0n && p <= PART.PALISADE && tier === 3n && sample % 3 && s.actionsUsed < 6n) {
      s = applyAction(s, { type: 'overclock', cell }); overclocks++;
    }
  }
  const r = fight(s);
  assert.deepEqual(evaluateFight(s).summary, r.summary); assert.deepEqual(replayFrames(s, r.frames), r.state);
  assert.deepEqual(unpackState(packState(s)), s); assert.deepEqual(unpackState(packState(r.state)), r.state);
  assert.equal(r.state.overclocked, 0n); deepBonus += Number(r.summary.deepQuarry);
  let before = waveForecast(s.seed, s.wave + 1n).lanes.flat();
  for (const frame of r.frames) {
    for (const g of frame.groups) {
      assert.deepEqual(unpackGroup(packGroup(g), g), g);
      const old = before.find(p => p.id === g.id)!;
      if (old.status !== 'active') continue;
      let bolts = sum(frame.shots.filter(x => x.group === g.id).map(x => x.damage));
      const raw = sum(frame.splashes.flatMap(x => x.targets.filter(t => t.group === g.id).map(t => t.damage)));
      if (g.bossPattern === 'last-siege' && frame.tick % 2n === 0n) { if (bolts) shieldedTicks++; bolts /= 2n; }
      const splash = minus(raw, g.kind === 'brute' ? C.BRUTE_SPLASH_ARMOR : 0n);
      const units = Array.from({ length: Number(old.count) }, (_, i) => minus(i ? old.bodyHp : old.hp, splash))
        .map(hp => { const d = hp < bolts ? hp : bolts; bolts -= d; return hp - d; }).filter(hp => hp > 0n);
      assert.equal(g.count, BigInt(units.length)); assert.equal(g.hp, units[0] ?? 0n); assert.equal(g.bodyHp, minus(old.bodyHp, splash)); oracleGroups++;
      for (const b of frame.bites.filter(b => b.group === g.id)) {
        const bite = g.bossPattern === 'gatebreaker' ? frame.tick % 2n === 0n ? 10n : 0n : g.bite;
        assert.equal(b.damage, g.count * bite); if (g.bossPattern === 'gatebreaker') parityBites++;
      }
      for (const leak of frame.leaks.filter(l => l.group === g.id)) {
        const perUnit = g.kind === 'boss' ? C.BOSS_LEAK_BASE + (C.BOSS_LEAK_HP * g.hp + g.maxHp - 1n) / g.maxHp : g.leak;
        assert.equal(leak.damage, g.count * perUnit);
        if (g.kind === 'boss' && g.hp < g.maxHp) chippedBossLeaks++;
      }
    }
    before = frame.groups;
  }
  for (const lane of r.summary.lanes) assert.equal(lane.kills + lane.leaks, lane.spawned);
  denseBoards++;
}
assert(parityBites > 0 && shieldedTicks > 0 && chippedBossLeaks > 0 && deepBonus > 0 && overclocks > 0);
const report = { checkedSeeds, openingPatterns: patterns.size, openingCost: 10, openingActions: 2,
  openingRepresentatives: Object.fromEntries([...patterns].map(([key, seed]) => [key, String(seed)])),
  blockerCases, bossStorms, weaponlessHolds: 0, passesPerLane: 40,
  denseBoards, oracleGroups, parityBites, shieldedTicks, chippedBossLeaks, deepBonus, overclocks };
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
