# Ballista Siege

A small tower defense game whose rules run on Solana as [Ballista](https://github.com/Jac0xb/ballista) templates. There is no custom program: each turn is a batch of transactions that run the game templates, and the board you see is read back from their registry entries.

Play it at https://moshthepitt.github.io/ballista-siege/. The game starts offline at once, with the same rules running in the browser. To play on devnet, open Fund, add a little devnet SOL to the burner key the page creates, and start a new run.

## Develop

```sh
pnpm install
pnpm dev        # UI at play/, offline rules
pnpm test       # rules, chain port (LiteSVM) and UI logic
pnpm smoke      # full runs through a real browser
pnpm weight     # first-visit page weight
```

`docs/rules-v1.md` holds the rules. `src/v1` is the reference simulator, `src/chain-v1` the Ballista templates and client, `play/` the game UI. `reports/` records how each part was built and tested.

Deploy the templates with `RPC_URL=https://api.devnet.solana.com pnpm deploy:v1` (creator key at `.tmp/keys/creator.json`). It writes `play/deployments/devnet.json`, which the next build ships.
