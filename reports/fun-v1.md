# Siege v1 playtest, rules pass 5

## API additions for the UI and chain port

- `Action` adds `{ type: 'overclock', cell: bigint }`, opcode 5 in the existing command format. It costs **8g and one order**. Only tier-three Ballistas, Cauldrons and Palisades qualify. Weapons gain `floor(baseDamage/2)` before the existing damage caps; Palisades gain 12 HP. An installed part can overclock once before the fight. Selling removes the boost; a rebuilt tier-three replacement can overclock normally.
- `RunState.overclocked?: bigint` is a 16-cell mask; missing means zero. Creation and settlement produce zero. Selling clears the cell bit. State metadata bits **34..49** carry the mask; bits 50..63 remain reserved. State and event lengths remain **48 and 156 bytes**. Old zero-mask words remain valid; the chain port must implement the new opcode and mask.
- `EnemyGroup` adds optional `bossPattern: 'gatebreaker' | 'last-siege'` and `splashArmor: bigint`. `WaveForecast.boss` adds `pattern`, `biteEven`, `biteOdd`, `ballistaDivisorEven`, `ballistaDivisorOdd`, `leakMin`, `leakMax`. The group's existing `bite` is the base value and `leak` the maximum. Use the pattern for live bite behavior and current HP for leak damage.
- `TickFrame.mitigations?: { group: bigint; ballista: bigint; splash: bigint }[]` records damage removed from pooled nominal attacks. Shot and splash events retain nominal damage. Armor subtracts one from pooled splash once per group per tick. Last Siege halves pooled bolts once on even ticks. Bite events carry actual damage, including zero on Gatebreaker's odd ticks.
- `leakDamage(group)` returns total requested wall damage for the surviving group. A boss uses `4 + ceil(4*hp/maxHp)`, yielding 5..8 while alive and zero when dead. Both ordinary movement and the storm call it. At exactly quarter, half and three-quarter HP, leak is 5, 6 and 7; damage between those thresholds does not immediately save another wall.
- Active Quarries at D3/D4 add 1g per cell, independent of tier. `Summary.deepQuarry?: bigint` exposes that bonus **already included** in `summary.quarry`. Trample cancels the whole payout.
- `PlannerOptions.overclock?: boolean` supports ablation. The planner's cache includes the mask; legal-action enumeration, beam candidates and immediate repairs include overclock. Greedy now uses up to six myopic orders, replacing its three-order cap. Its objective still has no future forecast.

The exact contract is [rules-v1.md](../docs/rules-v1.md). Palisade working HP still fits six bits: overclocked tier three has 60 HP. Group packing, enemy order, ten ticks and four groups per lane are unchanged.

## Results

All numeric targets pass on 200 tuning seeds and 400 fresh seeds. Rules and bots were [frozen](../.tmp/play-v1/pass5/freeze.json) before seeds **80000–80399** ran; [source hashes still match](../.tmp/play-v1/pass5/freeze-check.json). No tuning followed that sample. These are deterministic sample rates, not a judge score. Gemini and Astra have not rescored this pass.

| Target | Required | Tuning, 0–199 | Fresh, 80000–80399 |
| --- | --- | ---: | ---: |
| Planner wins | 60–85% | 82.00% (164/200) | 83.50% (334/400) |
| Greedy wins | 15–40% | 25.50% (51/200) | 20.25% (81/400) |
| Random wins | Below 5% | 0.00% | 0.00% |
| Spendable gold spent | At least 80% | 85.88% | 86.23% |
| Wins with at most ten walls | At least 30% of wins | 35.37% (58/164) | 36.53% (122/334) |
| Affordable single-action leak fixes left | 0 | 0 | 0 |
| Empty opening threatens two lanes | Every seed | 100% | 100% |
| Tick/group passes per lane | At most 40 | 40 | 40 |

| Planner part share | Required | Tuning | Fresh |
| --- | --- | ---: | ---: |
| Ballista | 10–40% | 31.29% | 30.58% |
| Cauldron | 10–40% | 16.23% | 17.50% |
| Palisade | 10–40% | 13.90% | 15.11% |
| Forge | 10–40% | 12.16% | 11.23% |
| Watchtower | 10–40% | 12.00% | 12.35% |
| Quarry | 10–40% | 14.42% | 13.23% |

Part share counts occupied cell-turns across wins and losses; tiers do not multiply occupancy. Spendable gold includes the starting reserve, sale refunds and payouts before the terminal fight. It excludes terminal settlement. [Tuning metrics](../.tmp/play-v1/pass5/metrics-tuning.json), [fresh metrics](../.tmp/play-v1/pass5/metrics-fresh-80000.json), [target checker](../scripts/v1-check-results.ts).

## Why these rules stayed

Gatebreaker bites **10 on even ticks, zero on odd ticks**. Last Siege has **108 HP**, halves pooled Ballista damage on even ticks, and takes full splash. These patterns are visible from the first forecast. Counterfactuals on the same 1,975 tuning boards change 13 boards when Gatebreaker reverts to flat five bites and 37 when Last Siege loses its shield. The Gatebreaker fork lowers damage on two boards and raises it on two, adding four requested walls in aggregate against flat bites. The shield adds 105 requested walls and removes 20 kills against the same unmodified boards. Those comparisons establish a different demand, not an independent fun rating. All three manual builds killed Gatebreaker; the mixed final build killed Last Siege on tick ten. [Paired mechanic forks](../.tmp/play-v1/pass5/mechanic-forks.json).

Boss chipping now earns wall credit. The flat-eight counterfactual requests **237 more walls** on tuning boards without changing kills or gold. Fresh runs save **427 walls** through the HP formula: 238 on Gatebreaker leaks and 189 on Last Siege leaks. Eighty of 81 surviving Last Sieges were damaged. A player no longer needs the kill to recover some value from boss investment.

Brutes have **one pooled splash armor**. The independent tests distinguish one Cauldron's zero effective damage from two Cauldrons' pooled `2-1=1`, and prove that shielding floors after pooling odd bolt contributions. Removing armor changes 26 tuning boards, adds seven kills and reduces requested damage by 21. Keeping it makes unsupported splash a poor tank answer. In manual play, switching from Cauldron to Ballista, adding a Forge, or preserving a trample-prone Forge each changed an armored lane's outcome.

Deep Quarry bonuses paid **1,705g over 1,065 tuning turns** and **3,219g over 2,053 fresh turns**. Removing only the bonus changes gold, never combat. The manual runs show its cost: seed 97011 spent 12g on a tier-three gun to kill a Brute before it could trample D3; seed 98017 held the lane but still lost the mine's payout; seed 135791357913579 later sold a paid-back mine for a blocker. A green lane badge does not guarantee mine income.

Overclock stayed because the complete-policy ablation falls from **82% wins to 66%** on the same 200 seeds. Fresh planner runs spend 5,392g on 674 overclocks, including 449 on wave ten. Removing boosts from otherwise identical built boards adds **2,961 requested walls** and removes **1,020 kills**. On 443 of 515 boosted turns it saves walls or adds kills; the other 72 do not meet that strict usefulness test. The bounded bot does not always spend optimally. [No-overclock policy](../.tmp/play-v1/pass5/no-overclock.json).

The final price is 8g. A weapon boost can cross a kill threshold; a blocker boost can buy another firing tick. Both expire, consume an order, and compete with permanent upgrades. Six-bit Palisade packing is why the HP option is +12, not the trial +16. Damage caps remain 63/31. The manual final turns spent **19/22g, 20/21g and 18/20g**; their end balances of 30/29/25g include payouts that could never fund another purchase.

## Tuning choices and build variety

The retained supporting changes are Palisade price **3g to 2g**, Brute base HP **10 to 9**, and late Brute growth **3 to 8 per escalation step**. Late normal Brutes now have **21/29/38 HP**, heavy-lane Brutes **27/41/56**, on waves 8/9/10. The cheaper blocker restores a useful firing-time purchase while the stronger late tanks consume that time. Base income stays 5g; Quarry price, tier income and adjacency stay 3g, 2g and 1g.

Several bundles were rejected. The initial 108-HP, 6g-overclock trial won 90.67% and put Palisades below 8%. Raising boss HP as far as 144 did not bring planner wins below 85%. The tested 6g base-income bundles stayed too easy for the planner; the 4g income/1g Quarry bundle pushed Quarry share below 10%. The final late-tank bundle passes every target. These were bundled experiments, so the results do not isolate each constant. [Candidate sources and measurements](../.tmp/play-v1/pass5/candidates/), [tuning summary](../.tmp/play-v1/pass5/tuning-summary.json).

Winning final boards use fixed bins: weapon tier share above 60% identifies Ballista or Cauldron leadership, otherwise mixed; the largest support tier total identifies Forge, Watchtower or Quarry (ties in that order); Palisade count is 0–1 or 2+. Tuning has **12 occupied bins**; fresh has **14**, with an entropy-equivalent count of **9.07**. The largest fresh bin has **76/334 wins (22.75%)**; the next has 75. Support families split **162 Forge / 125 Watchtower / 47 Quarry**. Weapon leadership is **216 Ballista / 115 mixed / 3 Cauldron**. Ballistas still lead most winning boards; this is evidence of part-mix variety, not fourteen separately balanced strategies. The full distributions and representative seeds are in the metric files.

## Three manual runs

These were agent-selected CLI runs using the game's exact previews, without a bot or action-search policy. All thirty turns, frames, action words and compact events were replayed under the frozen rules. The logs judge decisions, not animation. [Turn-by-turn decisions and feelings](../.tmp/play-v1/pass5/manual.md), [saved runs](../.tmp/play-v1/pass5/manual/), [replay verification and final comparisons](../.tmp/play-v1/pass5/manual-summary.json).

| Seed | Build and impression | Final result |
| --- | --- | --- |
| 97011 | Deep mine funded a Ballista/Forge engine. Selling an upgraded Cauldron for the Gatebreaker rebuild felt costly but legible. Last Siege demanded two temporary boosts after permanent upgrades were exhausted. | 17 walls; boss killed tick 9; final damage 10 to 0 |
| 98017 | Row support plus Forge/Cauldron splash. A second support row and one overclock crossed the 56-HP one-shot threshold, preserved the other Watchtower, and let splash finish the boss on the deadline. | 18 walls; boss killed tick 10; final damage 22 to 0 |
| 135791357913579 | Early cross-lane Forge trampling cost walls. Mine payouts helped recovery, then the mine became blocker space. Killing Last Siege still left two Brutes; on retry I would protect that Forge earlier. | 6 walls; boss killed tick 9; final damage 17 to 6 |

Keeping every final permanent purchase but removing the overclocks changes those fights to **9, 10 and 11** requested damage. The temporary spend has measurable value in each run.

## Audit and verification

[Opening and combat audit](../.tmp/play-v1/pass5/audit.json): **8,258 seed checks**, including full-width seeds, cover all twelve opening patterns. Two guaranteed weapons at D2 still clear each opening for 10g in two orders. All **512 weaponless boss blocker layouts** leak; blocking alone cannot beat the deadline. Another **600 dense boards** exercise 897 overclocks and **22,208 active-group comparisons** against an independent per-unit HP oracle. That oracle also checks parity bites, ordinary/storm boss leaks, group codecs, state packing and exact event replay. The production kernel adds no per-unit loop.

On fresh planner boards, removing Palisades worsens damage or kills on 1,523 turns; weaponless tank lanes hold in **0/9,260** cases. The repair audit leaves no affordable single buy, upgrade or overclock that reduces a leak. Longer combinations can still escape the beam: fresh runs include 26 leaking zero-order turns with at least 5g. This pass does not claim to eliminate every dead turn.

**92 non-chain tests pass**, as do root and play TypeScript checks. Chain tests are excluded: chain-v1 implements the earlier contract and must be updated after this handoff. Codeintel still crashes with `this.failAll is not a function`; text references, compiler checks, frozen source hashes and executable audits provide the checks here. [Tests](../.tmp/play-v1/pass5/tests-final.txt), [root compiler](../.tmp/play-v1/pass5/typecheck-final.txt), [play compiler](../.tmp/play-v1/pass5/typecheck-play.txt).

The current full-v1 port uses twelve transactions, with about 469k observed CU headroom per tick transaction before these changes. This pass keeps **10 × 4 = 40** tick/group passes per lane and constant-work group math; max enemy HP is 108 and max Palisade HP is 60. It does **not** establish new instruction/register/CU measurements. The port must carry the overclock mask, implement the opcode and formulas, recheck helper limits and prove state/event equivalence. Finalized template IDs and registry entries must change.

Reproduce from the frozen source:

```sh
SEEDS=200 STATES=.tmp/play-v1/pass5/states-tuning.json OUT=.tmp/play-v1/pass5/metrics-tuning.json node --import tsx scripts/v1-funtest.ts
SEEDS=400 OFFSET=80000 OUT=.tmp/play-v1/pass5/metrics-fresh-80000.json node --import tsx scripts/v1-funtest.ts
SEEDS=200 BOTS=noOverclock OUT=.tmp/play-v1/pass5/no-overclock.json node --import tsx scripts/v1-funtest.ts
node --import tsx scripts/v1-check-results.ts .tmp/play-v1/pass5/metrics-tuning.json .tmp/play-v1/pass5/metrics-fresh-80000.json
OUT=.tmp/play-v1/pass5/audit.json node --import tsx scripts/v1-audit.ts
node --import tsx .tmp/play-v1/pass5/mechanic-forks.ts
node --import tsx .tmp/play-v1/pass5/manual-summary.ts
pnpm exec vitest run --exclude '**/chain*.test.ts'
pnpm exec tsc --noEmit
pnpm exec tsc --noEmit -p play/tsconfig.json
```
