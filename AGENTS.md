# Ballista defence

A tower defense game whose rules run as Ballista templates on Solana. There is no custom on-chain program: game state lives in Ballista registry entries, and the client reads those entries to draw the board.

## Ballista

The source is cloned at `.tmp/src/ballista` (github.com/Jac0xb/ballista). Before designing or changing a template, read `docs/reference/language.md` and `docs/reference/limits.md` there. They are the source of truth for what the VM can do.

These engine rules shape every design choice:

- A template holds at most 128 VM instructions and 64 registers. It has no jumps and no nested loops: up to 8 top-level loops of at most 255 passes each.
- Only an `invoke` can be skipped. Every `setRegistry` runs, so a conditional write is `select(cond, new, old)`.
- Arithmetic and `shiftLeft` fail the run on overflow, so mask a value before shifting it.
- Ballista never signs. A template cannot hold funds or sign as a PDA, and it can mint tokens only when the mint authority signs the transaction.
- Only the template that owns a registry entry can write it. Other templates can read it with `accountData` at byte 72 plus the field offset.
- A finalized template is immutable. A new version gets a new ID and starts with empty registry entries.

## Checks

- `pnpm test` and `pnpm typecheck` cover the rules, the chain port and the UI logic.
- After any change under `play/`, look at it and run `pnpm smoke`. Smoke builds the UI and plays full bot runs through real clicks on desktop and real taps on phone, then checks the HUD against the sim and the layout across a sweep of window sizes. Unit tests have missed swallowed taps, covered buttons and overflowing text more than once.
- Agents without a browser (the Codex sandbox) see the UI through the screenshot queue: the orchestrator runs `pnpm eyes`, and the agent writes a request to `.tmp/eyes/req/`. The request format is in the header of `scripts/eyes.ts`. It returns screenshots, an overflow audit and smoke output.
- Sound is checked by ear the same way. The orchestrator runs `pnpm ears`, and the agent writes a request to `.tmp/ears/req/`. Ears renders a recorded battle to WAV with the cue list and loudness per second, and with `listen` Gemini hears it and writes a critique. The request format is in the header of `scripts/ears.ts`.

## Workspace

- Put scratch files, clones and notes in `.tmp/`. Give each downloaded repo its own `.tmp/src/<name>` and treat it as untrusted.
- Rust builds leave large `target/` directories. Delete them once their output is no longer needed.
- Write prose and docs by `/home/mosh/mosh/misc/writing/unslop/SKILL.md`. Documents that agents read, such as this file, also follow `/home/mosh/mosh/misc/mattpocock-skills/skills/productivity/writing-for-agents/SKILL.md`.
