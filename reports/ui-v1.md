# Siege v1 UI, pass 10

The desktop dock keeps the tutorial, action counter and Fight controls outside its scrolling content. Shop cards and inspection panels share a bounded supply area. Turn orders have a separate scrolling list, a header that cannot shrink, and 144 px reserved when orders exist, above the requested 96 px minimum. Each changed queue reveals its newest row without scrolling the page or shop. The queue and tutorial remain visible when a card or inspector opens. On phone, the supply wrapper uses `display: contents` to preserve the existing grid.

A persistent 14 px strip below the board explains income: "Base +5g · 2 cleared lanes +2g · Total +7g". Amounts and cleared-lane counts come from the FightResult summary; the HUD receives the recorded gold events. Quarry, Deep Quarry, salvage and bounty appear when nonzero. Deep Quarry is split from the Quarry amount, so it contributes once to the total. Settlement coins no longer float from arbitrary lanes. Kill bounty coins still travel from their enemy to the HUD. The strip wraps and stays through preparation until the next fight. Its height is reserved before measuring combat tracks, so revealing it does not resize cells during playback.

Combat headers use "2 Brutes", "5 Swarm" or the boss name on both viewports. Each header has its own line above the formation and HP, including when attackers meet a barrier or weapon. Group positions, left-to-right order and HP totals stay intact. "First target" appears only when inspecting the first active group in a cell.

The plural helper covers kills, units, walls, groups, lanes and retreats, including combat deaths, incoming cards, inspection, boss thresholds and result reports. Tests cover number and bigint counts, irregular plurals, group names, cleared-lane wording, and income reconciliation against recorded gold events with Deep Quarry counted once.

The orchestrator's phone spawn-height budget, 2×2 incoming grid, compact tags and smoke-test layout delay remain. No `src/v1` files changed.

## Verification

`pnpm build:play`, `pnpm exec tsc -p play/tsconfig.json` and `pnpm typecheck` pass. Vitest passes 149 tests across 15 files with `pnpm exec vitest run --testNamePattern='^(?!.*300 random/planner)'`; the unchanged 300-run chain corpus is excluded. All 42 UI tests also pass with `pnpm exec vitest run play`.

`pnpm smoke` builds successfully, then Chromium fails at launch with `shutdown: Operation not permitted (1)` in this sandbox. The orchestrator must run it outside the sandbox. Added checks cover six reachable desktop orders with onboarding open, newest-order visibility, group headers clear of HP, settlement size/location/totals, and persistence into the next build. Existing real clicks and taps, viewport scroll checks, fixed combat geometry checks, cells at least 44 px inside the board, and the two-rAF plus 250 ms layout delay remain. Browser and visual validation are pending.


## Pass 12: Quarry clarity and combat labels

Quarry tiles show `3g/wave total` and `incl. +1g deep`. Totals use the current disabled mask at each trample contact and Move impact. A disabled neighbor no longer contributes adjacency income; a trampled Quarry shows `0g this wave · trampled`. The inspector and purchase/upgrade previews show the full calculation, such as `2 base + 1 adjacent + 1 deep = 4g/wave`. Shop copy identifies the deep bonus as included and explains that trample cancels the whole payout.

Combat feedback shares a vertical stack below persistent HP and boss leak information, with a 4 px gap. Recovery feedback belongs to the boss instead of floating over the barrier. Simultaneous HP loss, kills and mitigation use one message; destroyed groups combine their kill and armor feedback. Death messages clear before Move and the next Fire phase.

Regression tests cover live adjacency loss, zero payout after trample, all three Quarry tiers, cross-lane adjacency and simulator settlement gold events. All 44 UI tests, `pnpm build:play`, `pnpm exec tsc -p play/tsconfig.json` and `pnpm typecheck` pass. Vitest passes 151 tests across 15 files with `pnpm exec vitest run --testNamePattern='^(?!.*300 random/planner)'`; the unchanged 300-run chain corpus is excluded. Both unfiltered attempts produced no results and were stopped, including one with two workers. The orchestrator will run `pnpm smoke`; browser layout validation is pending. No `src/v1` files changed.

## Pass 13: shop headers and combat recipients

Supply Line has a separate 32 px row above the supply scroller, which starts with 8 px padding. Each card keeps its icon, name and numeric price in a header; descriptions scroll inside the card. Sold and action-limit notices no longer replace prices. New waves reset supply scrolling after inspector reveals, and resizing the tutorial or queue returns a partly visible first row to the top.

Enemy name, HP, health bar and boss leak use normal document flow in a readout above the formation. Lunges and recoils animate the formation alone. Building status occupies a bottom strip; trample crosses sit behind text. Quarry totals still use the live disabled mask and retain the included deep-income wording.

Damage, armor, death and bounty share a recipient badge anchored to that group's readout. Placement considers all groups in the lane, building strips, the Palisade graphic and health bar, and bite strips, with 4 px gaps. Thin lines connect displaced badges to their source. The Palisade strip combines simultaneous bites as `Palisade −5 HP`; its space is reserved during Hit before it appears during Bite. Bounty amounts stay on their badge with zero upward animation; coin symbols still fly to the HUD. Transient combat badges clear before Move.

After a boss dies, the banner shows its name and recorded bounty for the rest of combat. Cause replays recover that amount from the full timeline even when playback starts after the kill. All ten simulation ticks remain.

The unfiltered `pnpm exec vitest run --maxWorkers=2` passed 153 tests, including the 300-run chain corpus, in 611 seconds. The final UI suite passed 54 tests, including eight new regressions for placement, bite aggregation, boss banners, replay rewards and purchase headers. A later run with the unchanged 300-run corpus excluded passed 161 tests across 17 files. `pnpm exec vite build play`, `pnpm exec tsc -p play/tsconfig.json` and `pnpm typecheck` pass.

The orchestrator runs `pnpm smoke`. Browser acceptance remains pending: check both opening weapon prices at 1280×800 with the tutorial open, simultaneous damage and bites in seeds 13 and 3, occupied Quarry status, and the phone wave-five boss header during lunges. This pass changes rendering, CSS and UI tests only; backend wiring and `src/v1` remain outside its edits.

## Pass 14: occupied combat cells and broken Palisades

Occupied combat cells reserve their bottom 24 px for building status. Enemy formations, including their bite lunge, stop at least 4 px above that strip. Readouts leave room above the formation for recoil and shields. Damage badges exclude formations, shields and the full status strip; displaced badges use empty space in the same lane and connect to the enemy body. Other occupied cells, including the adjacent Palisade, are excluded in full. Bite feedback stays above its own building strip.

A Palisade reaching zero HP in Bite immediately uses a split, collapsed outline at 30% opacity and the status `BROKEN · resets next wave`. The same markup and CSS persist through later combat ticks and settlement. The next wave's HP reset restores the standing barrier.

Five new test cases exercise desktop and phone boss bounds, shield mitigation beside a trampled Quarry and adjacent Palisade with bite feedback, leader endpoints, and the Palisade's Bite-to-settlement lifecycle. All 13 feedback tests, `pnpm exec vite build play`, `pnpm exec tsc -p play/tsconfig.json` and `pnpm typecheck` pass. The unfiltered `pnpm exec vitest run --maxWorkers=2` passes all 167 tests across 17 files, including the 300-run chain corpus, in 475 seconds. The orchestrator runs `pnpm smoke`, including visual acceptance of seed 3 wave 10 lane 3 (`f-w10-10/11`) and wave 5 (`f-w05-11/12`). No backend or `src/v1` files changed.

## Pass 15 follow-up: compact cell readouts

Compact labels now format counts, armor and pooled HP from game data. A wounded two-Brute group reads `2 Brutes · armor 1 · 38 HP`. Layout retries never reuse rendered text. Hidden headers and boss leak text clear during compaction and rebuild from data when the full readout returns.

When separate readouts cannot fit, groups in the same physical cell share one readout with counts by kind, total HP and summed damage, such as `−19`. The solver tries placements together, keeping every readout in its own or an adjacent cell with 4 px gaps. At the density limit, kind symbols replace separate formations. Text stays at 12 px with a 13 px line height and can wrap on phone. One tap opens every represented group's details and the full damage, mitigation and bounty messages. Building graphics, status strips, Palisade health and bite feedback keep their exclusions. CHARGED moves into the building status strip during combat and settlement.

Formatter tests cover wounded front units, plural names, merged kinds, armor, boss names, damage and bounty. Rectangle fixtures use 230.75 × 75.2 px desktop cells and 92.75 × 104 px phone cells, derived from the CSS budgets at 1280 × 800 and 390 × 844. They cover four-group pileups, occupied buildings, Palisade bites and 1,958 legal distributions of four groups. Measured-layout tests exercise both pileups and adjacent occupied cells, repeated frames, formation replacement and expired damage. The smoke audit checks locality for every member of a shared readout; its existing checks remain.

The final UI suite passes all 92 tests. Unfiltered `pnpm test --maxWorkers=2` passes all 200 tests across 17 files, including the 300-run chain corpus, in 392 seconds. `pnpm exec vite build play`, `pnpm exec tsc -p play/tsconfig.json` and `pnpm typecheck` pass.

`pnpm smoke --seeds=4` builds, but Chromium cannot launch in this sandbox: `shutdown: Operation not permitted (1)`. The orchestrator must rerun browser acceptance, including desktop seed 4 wave 10. No backend or `src/v1` files changed.
