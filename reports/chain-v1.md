# Siege v1 chain port, pass 2

The port matches the [rules pass 5 contract](../docs/rules-v1.md) after **300 complete LiteSVM runs**, split equally between random and planner bots. Every resulting state and every event field matched across **2,016 turns**, with 129 wins. Those runs used 261 overclocks on 191 turns. Another 96 dense boards exercised 220 overclocks, including 19 boss-wave boards; thirteen stress fixtures covered six-order turns and boosted boards.

The protocol still takes **twelve transactions per turn**. The largest observed transaction consumed **792,811 CU** against a hard 1,350,000-CU meter. The largest complete stress turn consumed **8,754,279 CU**; the random/planner corpus averaged **5,987,585 CU** and peaked at **8,361,873 CU**. These are observed maxima, not an exhaustive bound.

## Rules and packing changes

Opcode 5 now spends 8g and an order to overclock a tier-three Ballista, Cauldron or Palisade. Weapons add `floor(baseDamage/2)` after support and tier multiplication, before the 63/31 damage caps. Palisades add 12 HP, reaching 60. Each installation can boost once; selling clears its bit and refunds only permanent investment. A replacement can boost within the same six-order turn.

Gatebreaker bites for 10 on even ticks and zero on odd ticks. Last Siege has 108 HP and halves pooled Ballista damage on even ticks, rounding down once after pooling. Brutes subtract one from pooled splash once per group per tick. Both movement and the tick-ten storm use the surviving Boss's `4 + ceil(4*hp/maxHp)` leak damage. Active Quarries at D3/D4 receive another 1g each, independent of tier; trample cancels the entire cell's income. Prices and growth import directly from `src/v1/constants.ts`, including the 2g Palisade and stronger late Brutes.

Public state remains six u64 words, 48 field bytes plus the 72-byte Ballista header. Metadata bits 34..49 carry the 16-cell overclock mask; bits 50..63 remain reserved. Settlement clears the mask. `client.ts` exports the shared `encodeActions` codec and accepts overclock actions through both turn builders. Its state/session decoders use the contract codec, including mask eligibility and reserved-bit checks. Events remain 156-byte SGV1 records, with before/after masks handled by the same codec.

The private build word now holds parts at 0..63, tiers at 64..95, gold at 96..111 and the mask at 112..127. Preparation keeps the mask in a separate loop-carried register while those high bits temporarily hold shop counters. Command validation moved into the shop helper, and the action helper returns board deltas, keeping both within 128 instructions. Entry sizes did not grow.

Internal groups still use twenty bits: position 3, count 3, front HP 8 and body HP 6. A single-unit Boss derives body HP from its front. `checkTuning()` now includes boosted Palisade HP, deep income, parity bites and the boss leak/divisor bounds. Reachable gold and score must fit the private sixteen-bit fields; arbitrary injected states with unbounded gold remain unsupported.

## Compute savings and batching options

The first exact pass-5 port rebuilt the same forecast during every lane tick. It peaked at 913,332 CU per tick and 9,958,665 CU per stress turn. The retained comparison is [unoptimized-worst.json](../.tmp/chain-v1/pass2/unoptimized-worst.json).

The retained templates cache each lane's eight kind bits during preparation. They temporarily occupy the unused first-tick damage byte; the first tally moves them into unused padding in the accumulated totals. Later ticks read those bits directly. This removes forty forecast invocations, plus their roll/stat calls, per turn.

A lane with neither queued nor active units also skips its combat helper. The skip clears old damage/kills/bounty before tallying, preserves Palisade HP and disabled bits, and still runs the cursor and owner writes. Ballista forbids reading return data after an `invoke when`, so this uses a zero-or-one top-level loop with an initialized result and an unguarded invoke inside it. Queued units count as work; spawning is never skipped.

These paired six-reroll wave-ten fixtures use the same seed and boards. Separate harness addresses can slightly change owner overhead in the first comparison. The cache-only and retained variants share the same final bytecode except for the skip guard.

| Board | Rebuild forecasts, all lanes | Cached kinds, all lanes | Cached kinds, skip empty lanes | Skipped lane ticks |
| --- | ---: | ---: | ---: | ---: |
| Palisades | 9,958,336 | 8,743,437 | 8,754,077 | 0 |
| Ballistas | 9,958,665 | 8,743,766 | 7,446,101 | 10 |
| Cauldrons | 9,958,333 | 8,743,434 | 8,230,771 | 4 |
| Mixed support | 9,958,456 | 8,743,557 | 8,623,371 | 1 |
| Empty board | 9,958,543 | 8,743,644 | 8,230,973 | 4 |

Caching saves about 1.21M CU per turn on these boards. The guard costs 10,640 CU across a fully occupied turn; skipping ten lane ticks saves another 1,297,665 CU on the Ballista board. The empty-board fixture still has enemies, so it only becomes idle after they leak. [Cache-only measurements](../.tmp/chain-v1/pass2/cached-only-worst.json), [retained stress measurements](../.tmp/chain-v1/worst-measurements.json).

| Option | Measured cost or estimate | Decision |
| --- | --- | --- |
| Current twelve transactions | Up to 792,811 CU and 49 trace entries per tick; 1,214 bytes | Retained |
| Merge two dense ticks | About 1.59M CU, 97 trace entries, 2,096 signed bytes | Exceeds all three limits |
| Merge prepare/tick or tick/commit | 1,704 signed bytes | Exceeds 1,232 bytes |
| Pack owner routing into two u64 inputs, then batch idle ticks | Encoding estimate: 2,096 minus `18 × 48` = 1,232 bytes; two fully idle ticks about 539k CU and 57 trace entries | Possible follow-up; owner decoding and actual transactions need a new implementation and measurement |
| Resolve all ten ticks of one lane | 1,585,072 CU in the diagnostic lane driver; fails the hard 1.35M meter | Cannot replace a tick transaction |

The byte counts for the current wire format come from signed version-zero messages with the frozen lookup table. The compact-wire row is an estimate, not a compiled protocol or a promise of fewer transactions. Fully idle ticks currently cost 269,414 CU and 29 trace entries. Dense turns still need splitting after any wire compression. Removing ticks or changing combat would change the contract.

The full-lane diagnostic uses a 10M meter only to observe its cost. Its four-lane extrapolation is 6,340,288 CU before persistence, with duplicated board work included; it is not a production transaction. [Lane measurements](../.tmp/chain-v1/early-compute.json), [hard-meter failure](../.tmp/chain-v1/lane-budget-failure.log), [signed batching sizes](../.tmp/chain-v1/pass2/batching.json).

## Execution and trust

One finalized owner owns a 120-byte game entry and a 264-byte combat entry per player. A turn has 100 small owner invocations: five prepare steps, nine steps for each of ten global ticks, then five settlement/commit/event steps. The pinned gate checks cursor, successor, field and expected wave before any write. Helpers are pure and pin their callees. Combat inputs come from owner entries and the seed.

Each tick snapshots the active board before any lane fires. An earlier lane's trample affects support on the next tick, preserving simultaneous Fire. The same cursor protocol resumes failed continuations. Standard final transactions commit all three game words and emit atomically; during individual partial commit steps, `decodeSessionState` returns the saved before snapshot. Event authentication requires a successful receipt and the exact immutable `state → commit → event` path.

Daily seeds are checked against Clock's UTC day at creation and preparation. A prepared turn can finish after midnight. Practice supports every u64 seed, including zero and the maximum.

Finalized templates are immutable. Pass 2 defaults to IDs **11000..11024**, a fresh namespace relative to pass 1's default. Existing pass-1 owners and pending combat cannot adopt this bytecode. Deploy unused IDs and start fresh entries; no migration or live RPC deployment was performed.

## Template limits

Loops lists the maximum count of each top-level loop. CPI counts are direct sites / statically expanded calls, including registry-open reservations for the owner.

| Template | Instructions | Registers | Loops | CPIs, direct / expanded | Payload bytes |
| --- | ---: | ---: | --- | ---: | ---: |
| roll | 35 | 34 | 0 | 0 / 0 | 608 |
| shop | 122 | 24 | 1 × 4 | 2 / 2 | 2,190 |
| action | 128 | 30 | 0 | 0 / 0 | 2,176 |
| actions | 120 | 34 | 1 × 6 | 2 / 12 | 2,318 |
| enemyStats | 100 | 27 | 0 | 0 / 0 | 1,644 |
| forecast | 107 | 32 | 1 × 4 | 2 / 2 | 1,994 |
| queue | 69 | 28 | 1 × 4 | 1 / 1 | 1,445 |
| board | 31 | 27 | 1 × 16 | 0 / 0 | 548 |
| survey | 126 | 31 | 1 × 4 | 0 / 0 | 2,080 |
| fire | 128 | 41 | 1 × 4 | 0 / 0 | 2,152 |
| bite | 58 | 53 | 1 × 4; 1 × 4 | 0 / 0 | 992 |
| move | 120 | 40 | 1 × 4 | 0 / 0 | 2,008 |
| lane | 119 | 45 | 1 × 4 | 4 / 4 | 2,568 |
| quarry | 60 | 56 | 1 × 16 | 1 / 1 | 1,147 |
| income | 42 | 40 | 0 | 1 / 1 | 939 |
| aggregate | 109 | 24 | 0 | 0 / 0 | 1,860 |
| event | 126 | 27 | 0 | 0 / 0 | 2,264 |
| finish | 115 | 28 | 0 | 2 / 2 | 2,208 |
| prepare | 127 | 34 | 1 × 1; 1 × 1; 1 × 1 | 2 / 2 | 2,638 |
| boardPhase | 62 | 56 | 0 | 1 / 1 | 1,219 |
| lanePhase | 101 | 32 | 1 × 1 | 1 / 1 | 2,173 |
| tally | 45 | 44 | 0 | 0 / 0 | 848 |
| commit | 61 | 55 | 1 × 1 | 1 / 1 | 1,223 |
| gate | 105 | 31 | 0 | 0 / 0 | 1,796 |
| state | 126 | 22 | 1 × 1; 1 × 1; 1 × 1; 1 × 1; 1 × 1; 1 × 1 | 7 / 13 | 3,523 |

All 25 templates compiled and finalized through `vendor/ballista.so` with the normal SDK limits. Action and Fire use all 128 instructions. Preparation and settlement reach stack depth five, so invoke the owner directly. No Rust build was run.

## Transactions and rent

Measurements use one player/fee-payer signer and the deployment's native, frozen address lookup table. The table was created, extended, frozen and activated in LiteSVM. The corpus table below excludes dense fixtures and helper probes.

| Transaction | Samples | Average CU | Highest CU | Bytes | Accounts | Maximum trace / depth |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Start | 300 | 89,286 | 93,377 | 626 | 31 | 12 / 2 |
| Prepare | 2,016 | 461,681 | 599,041 | 822 | 31 | 57 / 5 |
| Global tick | 20,160 | 529,807 | 792,811 | 1214 | 31 | 49 / 4 |
| Settle, commit and event | 2,016 | 227,838 | 227,840 | 822 | 31 | 21 / 5 |

Thirteen stress fixtures include six rerolls, six overclocks where eligible, and preboosted boards. Their highest complete turn was 8,754,279 CU. Summing the separate observed prepare/tick/finish maxima gives 8,754,991 CU; that sum is also an estimate, not a bound. A tick transaction has eighteen spare bytes. Extra signatures or accounts require a fresh size check.

Template rent totals 252,785,880 lamports. The game entry locks 1,259,840 and the combat entry 1,991,360, totaling 3,251,200 per player. The 920-byte lookup table locks 5,323,840. Uploading the 25 templates takes 107 transactions, with a largest upload of 1,162 bytes; four native lookup-table transactions bring deployment to 111 transactions. These are LiteSVM rent settings and signed transaction measurements.

The harness enforces a hard 1.35M compute ceiling, 64 trace entries and five stack frames, matching the client's compute request. LiteSVM budget overrides replace transaction meter requests, so both limits are set explicitly. Enlarged log capture allows trace counting; the compact final event also passes authentication with the normal 10KB log cap.

## Verification and reproduction

The 300-run corpus compares every resulting state and every complete event after every turn, including daily and full-width practice seeds. Dense boards add cross-lane support loss, caps, late Brute growth, boss shields, trample and storms. Focused probes distinguish pooled armor from per-shot armor, pooled odd bolts from per-shot halving, and movement/storm boss leaks at quarter-HP boundaries. Build tests cover all three boosts, exact mask staging, 60-HP Palisades, sell/rebuild, insufficient gold, repeats, ineligible parts and noncanonical opcode-5 words. Failed prefixes leave both entries unchanged.

The remaining tests cover stale waves, cursor/field tampering, continuation replay and recovery, partial commits, terminal runs, daily/Clock checks, mixed-seed creation, helper substitution, another player's entries, malformed headers and failed/truncated/standalone events. **137 tests pass** across the chain suite and the other thirteen project test files. Root and play TypeScript checks pass, and the browser client bundles without Node builtins. Codeintel still crashes with `this.failAll is not a function`; reference searches and compiler checks supplied navigation and diagnostics.

```sh
node node_modules/vitest/vitest.mjs run test/chain-v1.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run --maxWorkers=2 --exclude 'test/chain-v1.test.ts'
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit -p play/tsconfig.json
node --import tsx scripts/chain-v1-browser-check.ts
node --import tsx scripts/chain-v1-worst.ts
CHAIN_V1_SKIP_EMPTY=0 CHAIN_V1_WORST_OUT=.tmp/chain-v1/pass2/cached-only-worst.json node --import tsx scripts/chain-v1-worst.ts
node --import tsx scripts/chain-v1-spike.ts
```

For the standalone 300-run benchmark, run `node --import tsx scripts/chain-v1-bench.ts`. Both that command and the long Vitest suite write [measurements.json](../.tmp/chain-v1/measurements.json). Final test logs are [corpus-tests.log](../.tmp/chain-v1/pass2/corpus-tests.log), [other-tests.log](../.tmp/chain-v1/pass2/other-tests.log), [typecheck.log](../.tmp/chain-v1/pass2/typecheck.log) and [typecheck-play.log](../.tmp/chain-v1/pass2/typecheck-play.log).

Measured constants SHA-256: `e352409aa4d0729a46ccb2c971b1fe7066d55a17d03a0f1e5076f3b532882930`. Simulator SHA-256: `6cd1cfa61714306a7df1ac21947c7d21849a9734e7a6bb215ed9b180984299e6`. Program SHA-256: `e0d5cb4480a4258f82cee8407058e09aa2b3d0dbabced3e1bbfefd331e9af230`. The measurement artifact also records bot and chain source hashes. SDK 1.0.0, LiteSVM 1.6.1. Game seeds use deterministic xorshift from `0x7e57c0de`; generated payer/template addresses can slightly change rent-creation compute.

Twelve transactions remain a product cost. A failed action transaction changes neither entry; confirmed preparation and earlier combat remain staged until resumed or replaced by a new run. The expected-wave/cursor pair has no run nonce, so clear old queued transactions when restarting at the same wave. Historical migration, leaderboards and best-day storage remain outside this six-word contract. Archive deployed addresses and matching source/constants for replay.
