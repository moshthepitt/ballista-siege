# Siege rules v1

`src/v1/sim.ts` implements this contract. `src/v1/constants.ts` owns the tuning numbers. V0 remains independent. A chain port must match state and events, including failed inputs, before it can resolve a Siege turn.

## Arithmetic and seed

Rule quantities are checked unsigned 64-bit integers. Division floors. Invalid inputs, overflow, underflow and zero denominators throw `RuleError`; they must fail the chain transaction. Saturating damage is written `a - min(a, damage)`. Neither subtraction branch may underflow. JavaScript numbers serve only as bounded array indexes, loop counters and the forecast horizon. Bot heuristics and statistical reports are outside the rules.

`newRun(seed, mode)` accepts a bigint in `[0, 2^64-1]`. Modes are `daily` and `practice`; both use identical rules. Daily seed is `floor(UTC unix seconds / 86400)`, exposed as `utcDay(seconds)`. The daily chain entry point must derive/check that day against Clock. Practice accepts every u64, including zero and the maximum. The pure API receives the seed explicitly and reads no clock.

All random choices come from this generator. It has no mutable cursor; shop calls, previews and forecasts consume nothing.

```
xorshift(x):
  x = x XOR ((x AND (2^51 - 1)) << 13)
  x = x XOR (x >> 7)
  x = x XOR ((x AND (2^47 - 1)) << 17)
  return x

roll(seed, w, salt, r = 0) =
  xorshift(xorshift(seed XOR 0x9E3779B97F4A7C15
    XOR (w * 40503 + salt + r * 104729)))
```

Mask before each left shift. Seed is XORed, not multiplied: full-width practice seeds cannot overflow a mixing product. Wave, salt and reroll products remain checked. Shop salt is 0; enemy salt is 987654. All information, including rerolls and future bosses, is public.

## Board and parts

Four lanes, numbered 0 through 3. Each has build depths 1 through 4. Depth 1 is nearest the wall; depth 4 is nearest spawn. Enemies spawn at 5 and leak at 0. Ahead means increasing depth. `cell = lane * 4 + depth - 1`. Edge adjacency means neighboring depth in the same lane or neighboring lane at the same depth; no diagonals or wrapping.

Each occupied cell has one part and tier 1, 2 or 3. Empty cells have tier zero. The run starts empty, with 14 gold, 20 walls, zero resolved waves and zero kills. There are ten waves. Walls never regenerate.

| Code | Part | Buy price | Effect |
| ---: | --- | ---: | --- |
| 0 | Empty | 0 | No part |
| 1 | Ballista | 5 | Targets one group; damage cleaves through its units; base damage 4; range `[depth, depth+2]` |
| 2 | Cauldron | 5 | Splash on every unit of every group in range; base damage 1; range `[depth, depth+2]` |
| 3 | Palisade | 2 | Blocks entry to its cell; 16 HP per tier |
| 4 | Forge | 4 | Each adjacent active Forge tier adds 2 Ballista damage or 1 Cauldron damage |
| 5 | Watchtower | 4 | Strongest active Watchtower tier in a depth row adds that much damage to every weapon in the row; also extends range by one depth ahead and behind |
| 6 | Quarry | 3 | An active Quarry earns `2 * tier + active adjacent Quarry count + (depth >= 3 ? 1 : 0)` after the wave |

Let `baseDamage = (base + forgeBonus + watchBonus) * weaponTier`. Weapon damage is `baseDamage + (overclocked ? floor(baseDamage / 2) : 0)`, capped at 63 per Ballista and 31 per Cauldron. Four Ballistas in a lane therefore sum to at most 252 damage against one group. Forge bonuses stack by summing adjacent tiers. Watchtowers use the maximum tier in a row, not their sum. Watch range extension is one at every tier and applies to both weapon types; it does not grow with tier. Range outside depths 1 through 5 hits nothing. There is no line-of-sight restriction.

Upgrading tier 1 to 2 costs the base price. Upgrading tier 2 to 3 costs `floor(3 * price / 2)`. Sell returns half the total price of buying and reaching the current tier, rounded down once. Thus a tier-3 weapon cost `5+5+7=17` and sells for 8. Paid amounts are derived, never stored. Selling cannot create profit.

Palisades, disabled parts and all HP reset for each wave. A broken Palisade stays on the board and blocks nothing until the next wave. Non-Palisade parts are disabled for the rest of the wave when a group moves onto their cell. Disabled weapons stop firing; disabled Forges and Watchtowers stop supporting; disabled Quarries earn nothing. This is trample, not a permanent sale or destruction. Support loss takes effect on the next tick.

## Shop and actions

The shop has four distinct parts, each with one stock. Slot zero is a weapon. Its type is `1 + ((roll(seed,nextWave,0,0) & 1) XOR (rerolls & 1))`. Thus rerolling always swaps the guaranteed weapon, and one reroll reaches either weapon type. Set `x = roll(seed,nextWave,0,rerolls)`. Make the ascending list `[1,2,3,4,5,6]` with the guaranteed weapon removed. Shuffle its five elements: for `k = 4,3,2,1`, set `x = xorshift(x)`, `j = x % (k+1)`, and swap entries k and j. Slots 1 through 3 are the first three shuffled entries. All shuffle denominators are fixed positive integers.

The initial wave-one shop (`wave = 0, rerolls = 0`) has an exception: slot one is the other weapon, slot two is Palisade, and slot three is the first Forge, Watchtower or Quarry in the shuffled deck. Buying both weapons and putting one at depth two in each threatened lane costs 10 of the starting 14 gold and clears the opening. This works for every seed: there are two active lanes with two or three 2-HP Swarm each, and each weapon gets two firing ticks before trample. The [opening audit](../scripts/v1-audit.ts) exercises all twelve threat patterns, including patterns requiring full-width seeds. Rerolling uses the ordinary shop rules.

Buying consumes the chosen slot until reroll or the next wave. Reroll number 1 costs 1 gold, number 2 costs 2, and so on. It increments `rerolls` and resets all four stock bits. Offers depend only on seed, next wave and reroll count. The first shop of each new wave has `rerolls = 0` and full stock.

`applyAction(state, action)` returns a new state and throws on an illegal action. It does not mutate input. Each action counts toward the six-action limit, including selling and rerolling.

| Action | Fields | Preconditions |
| --- | --- | --- |
| `buy` | `slot`, `cell` | Slot 0..3 in stock, cell 0..15 empty, enough gold |
| `upgrade` | `cell` | Occupied cell, tier below 3, enough gold |
| `sell` | `cell` | Occupied cell |
| `reroll` | none | Enough gold for next reroll |
| `overclock` | `cell` | Tier-three Ballista, Cauldron or Palisade, not already overclocked this wave, enough gold |

All action indexes are bigint. Actions fail after the run ends or after six actions in the current build phase. Sale refunds may fund later actions in the same transaction. There is no repair, move, replacement purchase or action during combat. UI undo restores an earlier local state; it is not an extra chain action.

Overclock costs 8 gold and one action. It gives weapons 50% more damage, flooring the bonus before the existing cap, or adds 12 Palisade HP (60 HP at tier three). It lasts for the upcoming wave only. Supports and Quarries cannot overclock. An installed part can overclock once before the fight. Selling clears its bit and removes the boost; a newly rebuilt tier-three replacement can overclock normally. Spent overclock gold never enters the sale refund.

`playTurn(startState, actions)` requires zero actions already used, validates at most six commands, applies them in order, then fights. Failure anywhere leaves the input unchanged; chain execution must be atomic. `fight(builtState)` supports local replay after individual `applyAction` calls. The UI should keep the start state plus action queue when submitting `playTurn`. Chain input must include expected wave; reject a stale expected wave before applying commands.

## Enemies and forecasts

A group is one enemy type with a count, front-unit HP and shared remaining-unit HP. Units share a position. Ballista damage carries through units of its selected group; splash reduces each unit's HP. A group can have a partially injured front unit and uniformly injured remaining units, which is why both HP fields are necessary.

| Kind | HP at wave w | Bite per unit | Leak per unit | Bounty per kill |
| --- | --- | ---: | ---: | ---: |
| Swarm | `2 + floor(w / 4)` | 1 | 1 | 0 |
| Brute | `9 + floor(w / 2) + 8*e + (heavy lane ? 6*e : 0)` | 3 | 3 | 1 |
| Gatebreaker | Wave 5: 54 | Even ticks: 10; odd ticks: 0 | `4 + ceil(4 * remainingHp / maxHp)` | 8 |
| Last Siege | Wave 10: 108 | 5 | `4 + ceil(4 * remainingHp / maxHp)` | 8 |

Here `e = max(0, w-7)`. Late Brute HP is 21/29/38 on waves 8/9/10, or 27/41/56 in the heavy lane. Both Brute groups in that lane receive the same HP. Brute splash armor is one per tick: subtract it once from pooled per-unit Cauldron damage, saturating at zero. Swarm HP follows its table formula. All enemies keep the same speed.

For `y = roll(seed,w,987654)`, `heavy = (y >> 40) & 3`, `bossLane = (y >> 48) & 3`. Each lane l uses `b = (y >> (8*l)) & 255`, `n = 2 + floor(w/4) + b % 2`. Build its queue in this order:

1. On wave 1, only lane zero and lane `1 + heavy % 3` get n Swarm. On later waves every lane gets n Swarm.
2. On wave 3 onward, add Brute if l is heavy or w is at least 6. Count is 2 when l is heavy and w is at least 7, otherwise 1.
3. On wave 7 onward, add another Swarm group with `n + (l == heavy ? 1 : 0)` units.
4. On wave 9 onward, add one Brute.
5. On waves 5 and 10, add one Boss to bossLane. If that lane already has four groups, replace its last group with the Boss.

At most four groups per lane. Group order k spawns at the end of tick k+1. Stable ID is `lane * 4 + k`. Gatebreaker (wave 5) bites for 10 on even ticks and zero on odd ticks. Last Siege (wave 10) takes `floor(pooledBallistaDamage / 2)` on even ticks and full pooled Ballista damage on odd ticks; splash stays full. Parity uses the global one-based combat tick, not time since spawn.

Every surviving boss leaks `4 + floor((4 * hp + maxHp - 1) / maxHp)` walls, from 5 through 8. Death leaks zero. At exactly one-quarter, one-half and three-quarters HP, leak is 5, 6 and 7 respectively. Partial damage below a threshold still advances toward the next saving. Ordinary wall arrival and the tick-ten storm use the same formula. `leakDamage(group)` returns the current requested wall damage.

`forecast(state, waves=3)` returns the upcoming wave plus subsequent waves up to the requested count and wave ten, each with per-lane groups. It also returns all unresolved boss waves, even outside that horizon. Horizon is an integer 0..10. Forecasts include queued HP, count, base bite, maximum leak, bounty, spawn tick and boss lane/name. Groups add optional `bossPattern` and `splashArmor`. Boss metadata adds `pattern`, `biteEven`, `biteOdd`, `ballistaDivisorEven`, `ballistaDivisorOdd`, `leakMin` and `leakMax`. An ended run may still inspect its unresolved forecast.

## Ten ticks: Fire, Bite, Move

All ten ticks resolve, even after a lane empties or walls reach zero. There is no immediate mid-tick termination. Gold and score settle after the final tick, including on a losing wave.

**Fire.** Use active parts, support, enemy positions and Palisade HP at tick start. Every Ballista chooses the active group closest to the wall in its own range. Position ties go to lower group order. Every Cauldron splashes every active group in its own range. Record nominal damage, then resolve all weapons together. Pool all Ballista damage aimed at a group; it starts at the front and carries through that group's remaining units. Surplus never changes target groups, and tower iteration order never redirects a shot.

For a group with count c, front HP f, body HP h, summed nominal Ballista damage d0 and summed nominal per-unit splash a0, first compute:

```
d = Last Siege AND even tick ? floor(d0 / 2) : d0
a = a0 - min(a0, Brute ? 1 : 0)
```

Shield and armor apply once per group per tick, after pooling, before the HP calculation:

```
front = f - min(f, a)
body  = h - min(h, a)
spill = d - min(d, front)
denominator = max(body, 1)
boltKills = d >= front ? 1 + floor(spill / denominator) : 0
count = body == 0 ? 0 : c - min(c, boltKills)
hp = count == 0 ? 0 : d < front ? front - min(front, d)
                                  : body - (spill % denominator)
bodyHp = body
```

This is constant work per group, with no per-unit loop. Apply splash to every unit before carrying the pooled bolts through their remaining HP. The positive denominator and saturating subtraction keep all branches safe when ported to eager VM expressions. Exact multiples leave the next front at full body HP; damage beyond the group is discarded. Body HP may remain positive in a dead group with zero count; it is irrelevant. Count zero means dead. Kills are `c - count`; award their bounty immediately. Front HP is always at most body HP while alive.

**Bite.** Every surviving active unit at depth p bites a standing Palisade at p-1 in its lane. Use Gatebreaker's parity bite instead of its base bite, then aggregate `count * bite` from every such group against each Palisade and reduce its HP by the aggregate, saturating at zero. A unit killed during Fire cannot bite. Queued units cannot bite. There is no front-unit-only bite discount.

**Move.** After Bite, each active group whose next cell has no standing Palisade moves one depth toward zero. A Palisade broken this tick permits movement this tick. All groups have the same speed, so queue order is preserved: they may share a cell but never overtake. Targeting checks position, then arrival order. Moving to zero leaks the group's remaining count times its leak value (HP-scaled for bosses), saturates wall loss, and removes the group. Moving onto an enabled non-Palisade part tramples it immediately. A cell produces one trample event per wave, even if several groups enter together. Spawn this tick's queued group at depth 5 after movement. Spawned groups first fire/become targets on the following tick.

At the end of tick 10, every remaining active group storms the wall for its remaining `count * leak` (HP-scaled for bosses). Mark it leaked at position zero, apply saturating wall loss and emit an ordinary leak event in the last frame. This final assault bypasses standing Palisades, adds no movement or trample events, and awards no kills or bounty. Blocking buys firing time; every unit a gun fails to kill still damages the wall. Kills plus leaks equal spawned units in every lane. The existing retreat types and codec value remain for API compatibility; these rules produce zero retreats.

## Economy, finish and score

After the last Move and storm, collect active Quarry income, 5 base gold, 1 per nonempty lane whose kills equal its spawned units, and `floor(total units killed this wave / 16)` salvage gold. The clean-lane bonus requires killing everything; leaks and retreats cannot earn it. Empty lanes earn nothing. Quarry adjacency counts active Quarries, independently of their tiers. An active Quarry at D3 or D4 adds 1 gold, independent of tier. Trample cancels its entire payout, including adjacency and depth bonus. `summary.deepQuarry` is the depth bonus already included in `summary.quarry`, not a second grant. Bounties have already been collected during Fire. No other action or event grants gold.

Set `wave = oldWave + 1`, reset action count, stock, rerolls and the overclock mask to zero. `done = walls == 0 OR wave == 10`. `won = walls > 0 AND wave == 10`. Total kills persist across waves; damage, disabled bits, Palisade HP and all groups do not.

```
survived = walls > 0 ? wave : wave-1
score = 100*survived + 10*walls + 2*totalKills
```

A death on wave ten gets nine survival awards. Gold has no score value, including final-wave income. Spend it when a purchase saves walls or earns kills; keeping a reserve can still fund later turns. A new run resets everything, including score. Best-day storage and leaderboard publication belong to the later chain/UI layer; they are absent from this run state.

## Frames and client contract

Exported types live in `sim.ts`. Every `fight` result contains `state`, ten `TickFrame`s and `summary`. Frames are snapshots after that tick's Move, spawn and possible storm/settlement; event arrays describe what happened during the tick. Queued, dead and leaked groups remain in the snapshot with their stable IDs. Leaked counts retain remaining units; they are not active targets.

Frames add an optional `mitigations` array of `{ group, ballista, splash }`: amounts removed from that group's pooled nominal attacks before HP resolution. Shot and splash event damage remains nominal. Subtract the mitigation to recover applied damage. Bite events contain actual parity-adjusted damage, including zero for a blocked Gatebreaker on odd ticks.

Frames contain all groups with position, count, front HP, body HP and status; every Ballista shot's source cell, target group and nominal damage; every Cauldron splash with affected group/count and damage per unit; bites; all Palisade HP; trample events and disabled mask; kills and bounties; leaks with wall damage; an empty retreat list; gold grants with source and reason; current walls and gold. The last frame includes storm leaks, Quarry, base, clean-lane and salvage grants. Replay never invents shots or death positions. Tick one contains spawn and no firing.

`summary.lanes` gives spawned units, kills, leaked units, uncapped requested wall damage, and zero retreats per lane. Damage totals can exceed walls remaining. `previewLanes` returns `HOLDS` if requested damage is zero, otherwise `LEAKS` with n requested wall damage; it also exposes kills and retreats. A nonempty lane only holds when all its units die. No API field was added for stalls because harmless timeout stalls no longer occur. `evaluateFight` shares the same combat kernel and omits frame allocation for search/preview. `replayFrames` reconstructs persistent state from gold, leak and kill events without running combat.

## Packing and event

All words encode little-endian. `packState`/`unpackState` implement this 48-byte field layout. One Ballista registry entry adds its 72-byte header, for 120 account bytes. Helpers do not own persistent state.

| Field offset | Word | Bits |
| ---: | --- | --- |
| 0 | seed | u64 |
| 8 | parts | Sixteen 4-bit codes, cell i at bits `4i..4i+3` |
| 16 | tiers | Sixteen 2-bit tiers at `2i..2i+1`; high 32 bits zero |
| 24 | metadata | Defined below; high 14 bits zero |
| 32 | gold | u64 |
| 40 | score | u64 |

Metadata bit fields: mode at 0 (practice 0, daily 1); resolved wave at 1..4 (4 bits); walls at 5..9 (5); rerolls at 10..12 (3); consumed stock at 13..16 (4); actions used at 17..19 (3); done at 20; won at 21; total kills at 22..33 (12); current-wave overclocked cell mask at 34..49 (16). `RunState.overclocked` is optional for source compatibility; absence means zero. Canonical created, unpacked and settled states include it. Old words with zero in those bits remain valid. Reject masks outside 16 cells, bits on anything except tier-three combat parts, nonzero masks in ended runs, reserved bits, codes above 6, mismatched empty/tier fields, waves above 10, walls above starting walls, action/reroll counts above 6, rerolls above action count, inconsistent terminal flags or kills above 4095. All ordinary rule operations are still checked u64, even where packed fields are narrower. Changing limits beyond these widths requires a new layout/version.

Ephemeral groups use one 32-bit slot each, two slots per u64, four slots per lane. With current knobs: position bits 0..2 (3); count 3..6 (4); front HP 7..14 (8); body HP 15..22 (8); kind 23..24 (2: Swarm 0, Brute 1, Boss 2); status 25..27 (3: queued 0, active 1, dead 2, leaked 3, retreated 4); bits 28..31 zero. Group ID, max HP, bite, bounty, leak and spawn tick derive from forecast and slot, so need no packed fields. `packGroup` and `unpackGroup` implement the slot. HP, count and position widths live in `LIMITS`. Sixteen slots take 64 working bytes. Palisade HP needs 6 bits per cell at current tuning, including the 60-HP overclocked maximum (12 extra bytes); disabled mask needs 16 bits (2 bytes). These are combat workspace, not cross-wave registry fields.

`encodeActions` uses one u64: action count in bits 0..2, then six 9-bit commands beginning at bit 3. Within a command: opcode bits 0..2 (`buy=1, upgrade=2, sell=3, reroll=4, overclock=5`); cell bits 3..6; slot bits 7..8. Unused cell/slot fields and unused commands must be zero. Bits 57..63 are reserved zero. Reject noncanonical words. No-op is a zero count, not opcode zero. This leaves expected wave plus packed actions as two turn inputs, with mode/seed supplied only at run creation.

`TurnEvent` is `SGV1`, seed, expected wave, packed action word, six before-state words, six after-state words, and four lane summary words. `encodeEvent` produces 156 bytes, below the 1,024-byte emit limit; `decodeEvent` reads that format and rejects reserved bits, malformed fields or inconsistent seed/wave snapshots. In each lane word: spawned at 0..7, kills 8..15, leaked units 16..23, damage 24..39, retreats 40..47; high 16 bits zero. The before snapshot is the turn start, before purchases. Full tick frames are reconstructed locally from that snapshot and commands, then checked against the after snapshot and lane summaries. Chain emits one compact event, never the full frame stream. Clients must check transaction success and the immutable owning template ID before accepting that event.

## Porting limits

Limits are 6 actions, 10 ticks, 4 lanes, 4 cells and 4 groups per lane. The measured [chain budget](../.tmp/design/chain-budget.md) requires `ticks * groups per lane <= 40`; this tuning uses all 40 passes per lane. Flatten or unroll fixed-size inner scans when porting: the TypeScript's nested array loops are reference code, not VM loop bytecode. Freeze the tick-start disabled mask across every lane's Fire; an earlier lane's new trample cannot affect another lane until the next tick. Mask shifts, safe positive denominators and `select(condition,new,old)` registry writes are required. A conditional expression cannot hide an unsafe branch in Ballista. Only the owner may write its registry; pin helper template IDs and consume return data immediately.

The [existing full-v1 port](../reports/chain-v1.md) resolves a turn in twelve transactions. Its measured largest transaction used 880,773 CU against a 1,350,000-CU request, leaving about 469k before these changes. That measurement does not cover pass 5. This pass retains forty tick/group passes per lane, eight-bit enemy HP, six-bit Palisade HP, the damage caps and constant work per group. Parity, armor and boss leak scaling add fixed arithmetic; overclock also needs a build opcode and a 16-bit mask carried through the turn workspace. Deep income adds fixed settlement arithmetic. The updated port must remeasure instructions, registers and exact transaction CU, then prove simulator/event agreement. Existing chain-v1 equivalence tests describe the earlier rules until that port lands. Finalized templates require new IDs and fresh entries for these rules.
