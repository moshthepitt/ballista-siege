# Chain engine

All actions execute through the supplied Ballista program in LiteSVM. The chain state and complete wave events match the bigint reference after 200 complete random runs (1,467 resolved waves), plus 256 injected full-board fixtures. No custom program, Rust build, rule change, or sim edit was needed. This is differential test evidence, not an exhaustive proof over every possible input.

## Ownership and execution

Five templates share the work. `state` owns the only persistent registry, keyed by the player signer. Its `mode` input selects start (0) or play (1). Two count loops, each bounded to one pass, make the actions exclusive. A start resets the run and retains the best record. A play checks the expected wave, active flag, pick, and cell before calling four helpers:

1. `prepare` computes both seeded rolls and replaces the chosen nibble.
2. `survey` computes lane damage, shields, and Quarry income.
3. `fight` generates enemies and resolves AoE, Brutes, Swarm, and shields.
4. `settle` computes walls, gold, score, and terminal flags, then emits the wave event.

The owner commits the returned state and updates the best record. Each action is one Ballista instruction in one transaction, preceded by a 200,000-CU budget instruction. Helpers run as four CPIs at stack depth 2. The owner's worst-case CPI accounting is 7: four calls plus three reserved for opening its entry. Each helper makes zero CPIs.

The state owner pins Ballista's executable address and every helper's finalized template address. Helpers have no registry, receive computed values from the owner, and cannot write player state. Calling them directly changes no state. No cross-template registry reads, raw-header validation, counter handshake, or client-supplied combat results are needed. Ballista validates the owner's entry against its template, registry, and signer-derived key when it opens the entry.

This split keeps each stage below 128 instructions. The SDK permits only one typed return-data read immediately after an invoke, so each helper returns one packed u128. Packing widths come from conservative bounds derived from `C`; an oversized tuning change fails compilation rather than truncating values. All game arithmetic remains checked u64. U128 holds transport fields. Forge and Quarry adjacency use exact nibble equality and masked shifts across the whole grid, then one 16-cell survey loop. Combat uses one four-lane loop. There are no nested loops within a template; the owner has two loops, survey and fight one each.

## Budgets and costs

Measured with the final tuning in `src/rules/constants.ts`: 40 starting walls, four row-0 Ballistas, ten waves. Constants file SHA-256: `4facfe049c01a41d1f85439dba4cee8ac86316e009589e8987c75bf39e29dda7`.

| Template | VM instructions | Registers | Payload bytes | Rent, lamports |
| --- | ---: | ---: | ---: | ---: |
| prepare | 77 | 22 | 1,284 | 7,579,360 |
| survey | 119 | 29 | 1,956 | 10,993,120 |
| fight | 106 | 37 | 1,804 | 10,220,960 |
| settle | 66 | 64 | 1,252 | 7,416,800 |
| state | 99 | 25 | 2,172 | 12,090,400 |

Template rent totals 48,300,640 lamports (0.04830064 SOL), shared by all players. One player's entry is 138 bytes: a 72-byte Ballista header and 66 bytes of fields. Its rent is 1,351,280 lamports (0.00135128 SOL). These are the supplied LiteSVM rent settings, 5,080 lamports per byte including the 128-byte account overhead. Finalized template and registry rent stays locked.

| Action | Samples | Average CU | Maximum CU | Transaction bytes | Accounts |
| --- | ---: | ---: | ---: | ---: | ---: |
| start | 200 | 4,733 | 6,455 | 475 | 10 |
| play | 1,467 | 115,055 | 115,065 | 475 | 10 |

The first start creates the entry; subsequent starts reuse it. PDA search depth varies with deployment and player addresses, so first-start CU can vary slightly between benchmark runs. The 200,000-CU limit includes room for this variation. The transaction sizes above use legacy messages, one signer, and the compute-budget instruction; no lookup table is needed. A separate fee payer or extra instructions increases size and account count.

Uploading the five templates takes 23 legacy transactions with the 900-byte instruction-data cap. The largest measured upload transaction is 1,104 bytes and uses four accounts. Upload CU varies with address-derived PDA searches; the observed maximum in the recorded run was 28,647. At the local default one-signature fee, upload transaction fees add 115,000 lamports. No network transaction was submitted.

## State and event formats

`src/chain/client.ts` supplies address derivation, compilation, upload plans, start/play instructions, registry decoding, and wave-event parsing. It uses browser APIs and Solana Kit; LiteSVM and Node imports live in the scripts and tests.

The registry fields follow `RunState` order: six u64 fields (`day`, `wave`, `walls`, `gold`, `grid`, `score`), two bool bytes (`done`, `won`), then `bestDay` and `bestScore` as u64. The decoder verifies Ballista ownership, exact length, header magic/version/index/reserved bytes, template address, player key, and boolean encoding.

One `BDW1` emit carries all fields required by the rules. Its 86 bytes contain the tag, eight little-endian u64 values (`w`, `pick`, `cell`, `part`, `walls`, `gold`, `goldGain`, `score`), `done` and `won` bytes, then a u128 of lane results. Each lane contributes `swarm`, `brute`, `sk`, `bk`, and `hit`, with widths exported as `PACK`. The client expands these into the exact `WaveEvent` shape. Ballista also emits its own `BEV1` records identifying the state and settlement templates.

The parser requires a successful transaction receipt and a settlement event whose invocation is directly inside the expected state-owner invocation. It checks both template identities through their `BEV1` records. A public helper's standalone emit, a substituted program/template, a failed transaction's retained logs, or logs truncated before the owner's completion record cannot authenticate a wave.

## Verification and use

```sh
pnpm exec tsc --noEmit
pnpm exec vitest run test/chain.test.ts
pnpm exec vitest run test/chain.test.ts test/rules.test.ts web/backend.test.ts
node --import tsx scripts/chain-bench.ts
```

The benchmark prints the imported constants, template statistics and rent, action CU, signed transaction sizes, and account counts. `pnpm exec tsx scripts/chain-bench.ts` also works where Unix sockets are allowed. Here the tsx CLI fails with `listen EPERM`; the Node loader avoids that CLI socket.

TypeScript checking and all 42 scoped project tests pass, including eleven chain tests. Besides the complete-run corpus, the chain suite compares 256 seeded full boards, 108 direct surveys, 16 combat boundary fixtures, and same-day/new-day best-record cases against the sim. Injected boards exercise interactions that a randomly played run may never reach; they are additional fixtures, not counted as complete random runs. Rejections cover stale waves, terminal runs, out-of-range picks/cells, another player's entry, substituted helper addresses, and negative clocks. Restart, UTC midnight rollover, registry identity checks, unauthenticated helper events, truncated logs, and failed-transaction logs are covered too.

To integrate a wallet, call `createDeployment(creatorAddress, firstUnusedTemplateId)`, send each instruction from `buildUploadPlan(deployment)` in order, and retain that deployment. `buildStartInstructions(deployment, playerSigner)` and `buildPlayInstructions(deployment, playerSigner, expectedWave, pick, cell)` return the two instructions for an action. Fetch the PDA from `getEntryAddress`, decode it with `decodeRunState`, and parse confirmed logs with `parseWaveEvents({ logs, err }, deployment)`. A wallet address can replace the signer argument when signing elsewhere.

The tested program is the supplied `vendor/ballista.so`, SHA-256 `e0d5cb4480a4258f82cee8407058e09aa2b3d0dbabced3e1bbfefd331e9af230`. The SDK default program ID is verified as `BLSTAmUBA29tcRUvoq5DBYxRhGptrnWPtfQW65RszRWR`.

## Ambiguities and remaining work

The rules allow play before start: a new zero entry has `done = false` and wave 0. The engine follows the sim, so this resolves a day-0 wave and usually ends immediately. Requiring initialization would need an explicit rule and state-field change. The web client currently asks the player to start first.

`expectedWave` protects against a stale wave, but does not identify a run. An old queued wave-0 move can land after a restart that also has wave 0. A run nonce would change the action contract; none was added here.

`bestDay` and `bestScore` track the most recently completed day's best, not an archive or an all-time record. A run keeps the day captured at start across UTC midnight. Both behaviors follow the formulas as written.

The rules prescribe event fields but no byte encoding. This implementation packs lanes, with widths tied to the compiled tuning. Archive the matching source/packing metadata for every deployment before supporting historical event decoding. Retuning requires unused template IDs and new registry entries; migrating old best records is outside these rules. Width checks and compiler limits reject unsupported tuning rather than changing behavior.

Unfiltered `pnpm exec vitest run` also discovers tests in the downloaded `.tmp/src/ballista` clone. Two upstream Node test files fail Vitest discovery with "No test suite found"; 326 tests otherwise passed in that broad run. Exclude `.tmp/**` in the project's Vitest configuration or scope the test command as above. That configuration change is outside this worker's allowed paths.

No edit outside the chain worker's paths was made. The web wallet adapter still needs to implement `GameBackend` using these helpers; `web/backend.ts` currently uses the local sim. Live RPC upload and wallet confirmation were not tested. The checked-in executable, rather than a newly rebuilt Rust artifact, supplied the program under test.
