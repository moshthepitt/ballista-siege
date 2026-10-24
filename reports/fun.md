# Could be fun?

Yes, enough to justify a human playtest. On days 20000–20299, random play won 0%, one-wave greedy play won 18.33%, the two-ply heuristic won 33%, and full-run search won 96%. The expert–greedy gap was 77.67 percentage points. Every part had an expert pick share between 8.30% and 23.81%.

That is evidence for decisions worth learning. It does not establish that people enjoy making them. No human playtest happened in this phase, and this report makes no claim about on-chain parity; that belongs to the chain worker's checks.

The starting balance had no wins in a 30-day smoke run, even with beam search. Random's median death wave was 2; greedy and search reached 3. Raising walls alone gave longer runs but too little separation. Four starting Ballistas made support placements useful immediately. Stronger support, slower swarm growth, and cheaper Brutes then gave planning room to pay off.

## Reproduce

```sh
pnpm exec tsx scripts/funtest.ts
pnpm exec tsx scripts/funtest.ts --start 21000
pnpm exec tsx scripts/funtest.ts --width 256 --bots random,greedy,expert
pnpm exec vitest run test/rules.test.ts
pnpm exec tsc --noEmit
```

The default run covers 300 consecutive days, 20000–20299, with beam width 80 and 300 script mutations per day. JSON goes to stdout; progress goes to stderr. `--days`, `--start`, `--width`, and `--bots` control the sample. Smaller samples are useful for tuning, but the results below use 300 days each.

This sandbox denies the Unix socket opened by the `tsx` CLI (`listen EPERM`). Actual runs used `node --import tsx scripts/funtest.ts` with the same arguments. That loader runs the same TypeScript without the CLI socket. The default four-bot run took 10.64 seconds; the second block took 10.57 seconds. Both are below the requested three-minute budget. No Rust build ran.

## Results

Constants were frozen before testing the second block, days 21000–21299. All requested numerical targets passed in both blocks. This is a second sample from the same generator, not evidence about other wave formulas or player behavior.

| Metric | Requested | Days 20000–20299 | Days 21000–21299 |
| --- | ---: | ---: | ---: |
| Random win rate | ≤5% | 0/300, 0% | 0/300, 0% |
| Random median death wave | ≥3 | 7 | 7 |
| Greedy win rate | 15–40% | 55/300, 18.33% | 63/300, 21% |
| Heuristic win rate | Report | 99/300, 33% | 105/300, 35% |
| Expert win rate | ≥75% | 288/300, 96% | 289/300, 96.33% |
| Expert–greedy gap | ≥25 points | 77.67 | 75.33 |
| Expert failed to find a win | ≤5% unwinnable | 12/300, 4% upper bound | 11/300, 3.67% upper bound |

Every reported win replays through `src/rules/sim.ts`. A failed search does not prove that its day is impossible. Since 288 default-sample days have verified winning scripts, at most the other 12 could be unwinnable. That gives the 4% upper bound for this sample, not an estimate of the exact impossible fraction.

Default-sample failed days: 20014, 20064, 20098, 20114, 20138, 20144, 20187, 20210, 20218, 20250, 20265, 20272. The runner prints failed IDs for every sample.

Deaths below count the lethal wave, not the number survived. Wins are excluded.

| Bot | Wave 5 | Wave 6 | Wave 7 | Wave 8 | Wave 9 | Wave 10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Random | 2 | 52 | 119 | 111 | 16 | 0 |
| Greedy | 0 | 0 | 2 | 36 | 129 | 78 |
| Heuristic | 0 | 0 | 1 | 45 | 98 | 57 |
| Expert | 0 | 0 | 0 | 0 | 1 | 11 |

Default-sample final scores include wins and losses. Quantiles select the sorted observation at `floor((n - 1) * q)`.

| Bot | Min | p10 | Median | p90 | Max | Mean gold | Mean gold / score |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Random | 440 | 548 | 664 | 784 | 936 | 40.19 | 5.89% |
| Greedy | 728 | 856 | 984 | 1150 | 1306 | 125.92 | 12.52% |
| Heuristic | 848 | 996 | 1144 | 1278 | 1392 | 226.56 | 20.11% |
| Expert | 800 | 1098 | 1270 | 1380 | 1520 | 58.56 | 4.46% |

Gold percentages average each run's `gold / score`; they are not ratios of the means. Expert winners averaged 19.93 walls and 60.50 gold. Survival is the expert's first objective, then final score. The heuristic often earns a high score while dying, which explains its much larger gold share.

| Expert picks | Default block | Second block |
| --- | ---: | ---: |
| Ballista | 18.74% | 18.06% |
| Cauldron | 19.61% | 19.20% |
| Forge | 16.34% | 15.33% |
| Watchtower | 13.20% | 13.19% |
| Quarry | 8.30% | 8.68% |
| Palisade | 23.81% | 25.54% |

Shares count every placement, including replacements and failed runs. The four starting Ballistas do not count as picks. There were 249 Quarry picks in the default block; 39 accepted fewer immediate walls than another legal action. Quarry greed therefore costs actual defense on some expert paths. Among expert winning final boards, 25.69% had adjacent Quarries. Winning-run gold averaged 60.50 points, worth 6.05 walls under the score formula. Gold is a secondary score resource here, with enough weight to change placements.

## What makes decisions matter

For 600 expert-path states spread over 60 sampled days and all ten waves, the runner evaluated all 48 pick/cell actions, including duplicate offers. An outcome here means the immediate `(walls, gold)` settlement. Different grids with the same settlement count once, so this measure omits later combo value.

The mean was 8.56 distinct settlements per state, median 8. Best versus worst immediate score differed by 95.41 points on average, median 90. The mean wall gap was 8.92. The second block gave 8.76 distinct settlements, a 91.04-point gap, and an 8.52-wall gap across 599 sampled states. These are local choice costs, not estimates of eventual win probability.

Among the 288 default expert winning boards, 94.79% had a Forge adjacent to a Ballista or Cauldron, and 97.22% had a Ballista in a watched row. The second block gave 93.77% and 95.85%; Quarry clusters appeared on 26.99% of its winning boards. Expert replacements were 12.80% of default placements. A full row of starting Ballistas makes replacing one with a Watchtower a concrete sacrifice: one lane loses its base weapon while the other three gain damage.

AoE thresholds are sharp. One Cauldron clears wave 1–3 swarm; after the HP step, it needs another Cauldron or Forge help. Brutes arrive at wave 4 and require single-target support or shields. Watchtowers create row plans, Forges reward edge sharing, and Palisades can cover damage while a weapon combo is unfinished. Quarry income accumulates each wave, so an early Quarry competes with preparing those defenses.

## Final constants

Only values in the existing `C` object changed. Keys, formulas, offer-table shape, `docs/rules.md`, and sim logic were left untouched.

| Constant | Before | Final | Reason |
| --- | --- | --- | --- |
| `WAVES` | 10 | 10 | Keep a ten-choice daily run. |
| `WALLS_START` | 20 | 40 | Allow early setup and mistakes; random still dies at median wave 7. |
| `STARTING_GRID` | 0 | `0x0001_0001_0001_0001` | One Ballista per lane, all row 0; immediate support targets and a Watchtower replacement choice. |
| `BALLISTA_DMG` | 4 | 8 | Make a base weapon useful against early enemies. |
| `FORGE_ST` | 3 | 8 | Let adjacency cross Brute kill thresholds. |
| `WATCH_BONUS` | 2 | 10 | Make row support worth a placement and sometimes a starting weapon. |
| `CAULDRON_DMG` | 1 | 1 | Keep the early swarm-clear threshold; upgrades must handle later HP. |
| `FORGE_AOE` | 1 | 2 | Let one adjacent Forge carry a Cauldron through wave 10 swarm HP. |
| `PALISADE_SHIELD` | 2 | 4 | Make shielding a competitive placement; observed pick share stays below 40%. |
| `QUARRY_GOLD` | 1 | 8 | Make accumulated income compete with walls in final score. |
| `QUARRY_ADJ` | 1 | 4 | Give Quarry placement a spatial payoff. |
| `SWARM_HP_BASE` | 1 | 1 | Keep HP arithmetic readable. |
| `SWARM_HP_STEP` | 3 | 4 | Put the first upgrade deadline at wave 4, after three setup choices. |
| `SWARM_LEAK` | 1 | 1 | Keep each leaked swarm equal to one wall. |
| `BRUTE_HP_BASE` | 8 | 4 | Avoid absorbing all single-target damage before supported builds exist. |
| `BRUTE_HP_PER_WAVE` | 2 | 1 | Late Brutes remain killable by supported Ballistas. |
| `BRUTE_LEAK` | 3 | 3 | Preserve the cost of leaving Brutes alive. |
| `BRUTE_FROM_WAVE` | 3 | 4 | Allow three placements before the first Brutes. |
| `HEAVY_BRUTE_FROM_WAVE` | 5 | 7 | Delay the extra heavy-lane Brute until support can form. |
| `BRUTE_DIV` | 3 | 4 | Reduce Brute count growth alongside their later arrival. |
| `SWARM_BASE` | 0 | 0 | Keep early pressure tied to the wave roll. |
| `SWARM_NUM` | 1 | 1 | Keep a small integer growth numerator. |
| `SWARM_DEN` | 1 | 3 | Reduce base swarm growth; four lanes need time to develop. |
| `SWARM_SPREAD` | 2 | 2 | Keep daily lane variation. |
| `HEAVY_NUM` | 1 | 1 | Keep a small integer heavy-lane numerator. |
| `HEAVY_DEN` | 1 | 3 | Reduce the extra heavy-lane swarm growth with base growth. |
| `OFFER_TABLE` | `0x6655443322111654` | unchanged | Retain the supplied part distribution and repeated offers. |

No formula change is needed to reach the stated targets on these samples.

## Bots and verification

`src/bots/index.ts` exposes four deterministic policies. Random chooses uniformly among three picks and sixteen cells. Greedy maximizes walls immediately after the wave, then gold; exact ties prefer an empty cell, then stable action order. The heuristic searches two placements and evaluates walls, future income, and upcoming damage on an unchanged board. It can see upcoming deterministic waves.

Expert searches all ten waves with future offers and enemies visible. It seeds from beam search and a greedy script, improves individual decisions by coordinate search, tries 300 seeded mutations of two or three decisions, then improves individual decisions again. It prioritizes winning over a higher-scoring loss, then maximizes the rules' final score. Same-grid beam pruning and local script search are approximations, so failure lists contain search misses as well as any impossible days.

Width 256 found 289/300 wins in 23.52 seconds on the default block, with 6.04% mean gold share and 36.33% Quarry clusters among winners. It missed one day solved at width 80 and solved others that width 80 missed. More search is useful, but this algorithm does not guarantee monotonic win rate as width changes. Width 80 stays the default because it already meets the targets and runs quickly.

`src/bots/kernel.ts` uses bounded exact-integer number arithmetic for search and bigint for daily randomness. It accepts at most 100 waves and scalar tuning values at most 10000; its intermediate integer products then remain below JavaScript's exact-integer limit. Board packing uses two unsigned 32-bit words. Every selected action replays through the checked-u64 reference, with grid, walls, and gold compared at each step. The search evaluator is not another rules authority.

The rules suite passed 23 tests. It covers hand-counted edge adjacency, Forge damage, Watchtower row scope and non-stacking, Quarry edges counted at both ends, lane-local Palisades, AoE kills, Brute-first ST, zero effective Brute HP, shielding, wall flooring, input rejection, restarts, scoring, daily best records, offer-table lookup, RNG masking, and overflow rejection. It also compares 200 random full boards and all 48 next actions per board against the bigint sim, 9600 transitions total. `pnpm exec tsc --noEmit` passed.

## Risks and next experiments

Bot skill is not human skill. The useful next test is to watch several people play one day, retry it, and explain their placement choices. Track whether the wave-4 Cauldron deadline and the Watchtower replacement payoff are visible before a loss. A compact preview of the next wave's four hits would help test that without adding new rules.

The baseline depends on four starting Ballistas sharing a row. That makes Watchtower placement easy to discover but may make many days feel alike. Test alternate starting layouts as separate balance candidates, with fresh day blocks; do not randomize the opening without rechecking the win targets.

Support is nearly universal in expert wins, while Quarry clusters appear on roughly one quarter. That could become a repeated opening recipe. Compare first-three-placement patterns and replayability with people before adding more parts. A score-only expert that deliberately optimizes high-scoring losses would also reveal whether the current survival bonus should change; changing that formula would require a rules-contract change first.

The samples contain one seeded random run per day. More seeds and days spread across the generator's range would give a better estimate of accidental wins. Exact unwinnability remains unresolved for the printed failure IDs. Deeper search or a bounded solver could settle those IDs before calling the daily generator reliable.

Chain and client workers must compile and display the final imported constants, especially the nonempty starting grid. Existing finalized templates cannot receive changed constants in place; deployment needs matching newly built templates. No changes outside this worker's allowed paths were made.
