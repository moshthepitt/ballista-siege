# Siege v1 localnet wiring

## Run

Use Node 22 with the project's pnpm dependencies. From the project root, start the validator in terminal 1:

```sh
pnpm localnet
```

The command resets `.tmp/ledger` and loads `vendor/ballista.so` at `BLSTAmUBA29tcRUvoq5DBYxRhGptrnWPtfQW65RszRWR`. Wait for the validator to become ready. In terminal 2:

```sh
pnpm deploy:v1 && pnpm e2e:v1 && pnpm dev
```

Open the URL printed by Vite. Use `?backend=chain` to require chain play or `?backend=local` to play the sim. With no backend parameter, the browser tries `play/public/deployment-v1.json` and its RPC, then shows a small notice if it falls back to local play. `pnpm smoke` forces the local backend.

The deployer uses `RPC_URL` if set, otherwise `http://127.0.0.1:8899`. It saves that URL in `play/public/deployment-v1.json`. The e2e runner accepts its own `RPC_URL` override. A browser on another computer needs an RPC URL reachable from that computer; the default loopback URL points to the browser's computer.

The deployer keeps its 64-byte creator keypair in `.tmp/keys/creator.json`. It verifies existing templates before skipping them, resumes matching partial uploads, and moves to a fresh block of 25 IDs when the old block belongs to different bytes. It creates, extends, freezes, and waits for activation of the lookup table. A matching rerun skips finalized templates and the completed table. The manifest records the creator, 25 IDs and addresses, lookup table, RPC URL, source constants hash, imported constants fingerprint, and template hashes. Keep the manifest with the matching source if you want to inspect an old run.

## Play and recovery

The browser stores a burner seed in localStorage. On localnet it requests an airdrop when that burner runs low. Storage errors show a warning. A fresh browser store gets a fresh burner and registry entries.

Fight returns the sim result immediately, so the battle replay can start while chain work continues. The backend sends one prepare transaction, ten global ticks, then one commit and event transaction in order. The status chip shows `On-chain 7/12`, the latest signature, and CU after receipt metadata arrives. The next fight waits for confirmation. On failure, Retry checks the saved signature and registry cursor before sending remaining work. Keep the same browser storage until a pending turn finishes.

After commit, the backend decodes the registry state and checks the event's Ballista invocation path. It compares both with the sim. A mismatch shows a red banner and blocks further fights. Explicit `?backend=chain` reports missing deployment or RPC errors instead of switching to local play.

## Verification and latency

The e2e runner creates a fresh burner and plays seed 4 through all ten waves with planner actions, including overclock, reroll, and sell. It compares the optimistic result, confirmed state, and authenticated event every turn. Each transaction prints its signature and CU; each turn prints wall time. A mismatch or RPC failure exits nonzero. The fixture checks action coverage before sending.

Local checks: `pnpm test` passed 152 tests across 15 files. `pnpm typecheck`, `pnpm exec tsc --noEmit -p play/tsconfig.json`, and `pnpm build:play` passed too. The planner fixture reached ten waves and covered buy, upgrade, overclock, sell, and reroll. Two focused LiteSVM tests then passed: one expires a transaction before landing; the other times out after landing. Both finish from the cursor with matching state and authenticated event, and the landed transaction is submitted only once. The full e2e runner also passed against in-memory Ballista: ten turns, 121 transactions including start, with every state and event matching. Those fixture signatures do not prove live RPC behavior. `pnpm smoke` built the UI, then Chromium stopped with `sandbox_host_linux.cc:41 ... Operation not permitted`; the orchestrator must run desktop and phone smoke outside this sandbox. Live validator deployment and e2e transactions also remain for the orchestrator.

Twelve sequential confirmations make a turn slower than local play even though its replay starts at once. RPC requests time out after 10 seconds; a confirmation waits up to 60 seconds. A timeout can happen after submission, so Retry checks the saved signature before it sends again. If the validator was reset, redeploy before opening chain play; reset removes templates, lookup table, and player entries.
