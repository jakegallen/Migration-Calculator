# Migration Calculator

A migrate.fun LP recovery and relaunch calculator.

![License](https://img.shields.io/badge/license-MIT-green)
![Built on](https://img.shields.io/badge/built%20on-Emblem%20Vault-5b8cff)
![Node.js](https://img.shields.io/badge/Node.js-informational)

## Related repositories

Part of the Emblem ecosystem:

- [Emblem-Tools](https://github.com/jakegallen/Emblem-Tools) - shared Emblem Vault SDK modules
- [EmblemScan](https://github.com/jakegallen/EmblemScan) - on-chain Emblem Vault analytics
- [EmblemWrap](https://github.com/jakegallen/EmblemWrap) - cross-chain asset wrapping service
- [Migration-Calculator](https://github.com/jakegallen/Migration-Calculator) - migrate.fun LP recovery calculator
- [OneShot](https://github.com/jakegallen/OneShot) - on-chain vault raffle marketplace
- [Vault-Robbers](https://github.com/jakegallen/Vault-Robbers) - Robinhood Chain heist game ecosystem

---

## Migration Calculator

A migrate.fun LP recovery and launch calculator. Given a token or LP address it pulls live DEX pools and computes recoverable native liquidity (SOL / ETH / BNB), relaunch-cost tables, and a leftover-token breakdown. Supports Solana, Ethereum, Base, BNB, and Robinhood.

## What it is

A Node/Express server plus a single-file front end. No database and no build step. The server proxies DEX data (DexScreener, GeckoTerminal) so no external calls or keys ever hit the browser.

## Architecture

```
migrate-calc/
  server.js      Express server (DEX pool lookups, recovery math, API proxies)
  public/        single-file front end + assets
  package.json   deps
  HANDOFF.md     engineering handoff
  UPDATES.md     change log
```

The browser talks only to this server. The server calls external DEX APIs server-side.

## Setup

```bash
cd migrate-calc
npm install
```

## Run

```bash
node server.js
```

The server listens on the `PORT` environment variable. Production injects `PORT`; set it yourself for a local run (for example `PORT=3000 node server.js`).

## Environment

See `migrate-calc/.env.example`. The app runs with no secrets for its core calculator; the listed vars only wire it to the Dashboard API when hosted. Secret VALUES are injected by the host / dashboard at runtime and are never committed.

## How to update

```bash
git clone https://github.com/jakegallen/Migration-Calculator.git
cd Migration-Calculator
# edit files
git add -A
git commit -m "your change"
git push https://x-access-token:<token>@github.com/jakegallen/Migration-Calculator.git main
```

Use a fine-grained token with Contents: Read and Write. Scrubbed source archive and proof of work. Production hosting stays on Emblem.

## Handoff

`migrate-calc/HANDOFF.md` is the detailed engineering handoff (pool resolution, the GeckoTerminal fallback for Robinhood tokens, recovery formulas).
