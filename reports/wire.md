# Browser and localnet wiring

The browser can submit start and play transactions to Ballista through `ChainBackend`. It signs with Solana Kit, waits for confirmed transaction metadata, reads the player's registry entry at or after the receipt slot, and decodes the authenticated wave event from `meta.logMessages`. The sim supplies immediate predictions and comparisons. Confirmed registry data determines the reconciled state.

## Run

Use Node 22 and the installed pnpm dependencies. Terminal 1, from the project root:

```sh
pnpm localnet
```

This starts `solana-test-validator --reset --quiet` with `.tmp/ledger` and loads `vendor/ballista.so` at `BLSTAmUBA29tcRUvoq5DBYxRhGptrnWPtfQW65RszRWR`. Each start resets the ledger. Wait for the validator to report readiness.

Terminal 2, from the same directory:

```sh
pnpm deploy:local && pnpm e2e && pnpm dev
```

Open the URL Vite prints, usually `http://localhost:5173/?backend=chain`. Loading the game starts a run. Restart and Play again submit another start transaction and retain the registry's daily best.

`RPC_URL` overrides the deployer's default `http://127.0.0.1:8899`. The deployer saves that URL in the manifest, so the browser and E2E script use it too. E2E also accepts its own `RPC_URL` override. Automatic airdrops are restricted to localhost, `127.0.0.1`, and `::1`; another endpoint requires a funded signer.

The deployer creates `.tmp/keys/creator.json` if absent, using a 64-byte Solana keypair file with mode 0600. It keeps that creator across validator resets. It scans groups of five template IDs, verifies finalized payloads before skipping them, resumes matching partial uploads, and chooses another group when existing bytes differ. RPC failures stop the scan. A successful upload atomically writes `web/public/deployment.json` with the program, creator, IDs, addresses, RPC URL, constants source SHA-256, a hash of imported constant values, and template hashes. Rerunning deployment on the same ledger and source sends zero upload transactions.

## Browser behavior

`?backend=chain` requires the manifest and reachable, finalized templates. `?backend=local` explicitly selects the sim. Without a backend parameter, a fetched manifest selects chain; a failed manifest fetch selects local with a visible notice. Invalid manifests or RPC failures after loading a manifest show an error and links to retry chain or choose local. They do not silently switch a loaded chain session to local.

The browser persists a 32-byte burner seed under `ballista-defence.local-burner.v1` in localStorage. Denied or corrupt storage falls back to a new burner and shows a notice. Low localnet balances receive an airdrop before signing. The browser checks the manifest's constant values and compiled template hashes, then checks the deployed finalized payloads before starting.

Placements immediately show predicted board, walls, gold, and lane results. Gameplay controls stay disabled while the action is pending. The small status line shows the signature during confirmation and CU when the confirmed metadata provides it. The backend compares every state field and every wave-event field against the sim. A difference leaves the confirmed state visible, shows a red warning, and blocks further placements. Failed submissions remove the prediction, try to reread chain state, and expose the error and signature.

The E2E script creates a fresh burner, starts with the validator's UTC day, and plays until the run ends. Its greedy player ranks all 48 placements by resulting walls, then income. Every wave compares both decoded state and the complete event with the sim. Each action prints its signature and CU; the final line prints wave count, transaction count, total reported CU, win status, and score. Any failure or mismatch exits nonzero. A completed run may lose before wave 10.

## Verification

These checks passed in this sandbox:

```sh
pnpm exec tsc --noEmit
pnpm exec tsc --noEmit -p web/tsconfig.json
pnpm exec vitest run
pnpm exec vite build web
```

The suite passed 51 tests across four files, including nine wire tests. Wire tests replace HTTP responses with an in-memory RPC fixture and execute the actual signed transaction bytes against the supplied Ballista executable in LiteSVM. They cover a complete run, delayed receipt availability, optimistic state, concurrent-action rejection, preflight rollback, persistent signatures and CU, missing authenticated logs, state mismatches, stale manifests, changed deployed payloads, burner persistence and storage failure, and local-only airdrops.

Deployment tests verified 23 transactions for a fresh group of five templates, zero on reuse, and completion of an interrupted upload without recreating finalized templates. An injected RPC failure stops after probing the current five IDs. CLI failure checks also exited 1 with explicit messages for an invalid RPC URL and a missing deployment manifest.

No validator or Vite server was started here; this sandbox cannot listen on ports. Live localnet deployment, the headless E2E command against that validator, and browser interaction still need the two-terminal run above. LiteSVM with mocked HTTP responses does not verify live RPC availability or browser behavior. Vite's build passes with two dependency comment-annotation warnings from Zod.

## Files

| Path | Change |
| --- | --- |
| `scripts/localnet-deploy.ts` | Creator key, upload/resume, ID selection, manifest output |
| `scripts/e2e-local.ts` | Fresh-burner run and per-wave chain/sim comparison |
| `web/chain-rpc.ts` | Kit signing, HTTP submission, confirmation, account reads, funding |
| `web/deployment.ts` | Manifest creation, constants fingerprint, deployment validation |
| `web/chain-backend.ts` | Burner storage, predictions, entry/event decoding, reconciliation |
| `web/chain-backend.test.ts` | Nine wire and deployment tests |
| `web/backend.ts` | Optional status/subscription hooks on GameBackend |
| `web/main.ts` | Backend selection, pending controls, status, predicted results, mismatch display |
| `web/style.css` | Notices, transaction status, readable errors, red mismatch warning |
| `package.json` | Only the three requested script entries |
| `reports/wire.md` | Run steps and verification limits |

## Remaining limits

There is no injected-wallet adapter. Burners use browser WebCrypto Ed25519 and store their seed in localStorage; serve the browser on localhost or HTTPS. If the browser runs on a different machine, the manifest's loopback RPC URL addresses that browser's machine.

Requests time out after 10 seconds; transaction confirmation polls every 400 ms for up to 60 seconds. A timeout can happen after a transaction lands. The client shows its signature and rereads state, but never resubmits automatically. Check the signature before retrying an uncertain action. The action contract has only `expectedWave`, so an old queued wave-0 action can still land after a restart; a run nonce would require a change outside this worker's allowed paths.

Retuning immutable templates selects new IDs and therefore new player entries. Old best records stay in the old deployment. No rules, sim logic, chain helpers, dependencies, or files outside the assigned paths were changed by this worker. No Rust build was run.

## Live verification (2026-10-22)

Run against `solana-test-validator` 4.0.0 with `vendor/ballista.so`:

- `pnpm deploy:local` uploaded and finalized all five templates in 23 transactions (125,837 CU).
- `pnpm e2e` played a fresh burner through 9 waves until its walls fell. All 9 waves matched the sim. Each play used about 115,055 CU and start used 6,777 CU.
- A headless Chromium session against `pnpm dev` loaded the chain backend, played 3 waves, and confirmed each transaction. It showed no mismatch warning and no console errors.

The validator writes its own log inside `.tmp/ledger` even with `--quiet`. After about 90 minutes the ledger held 3.3 GB, mostly RocksDB. Stop the validator and delete `.tmp/ledger` when you're done.
