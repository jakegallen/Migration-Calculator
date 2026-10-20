# migrate.fun — LP Recovery Calculator

Hand-off package for the migrate.fun dev team. This replaces the current calculator.
Vanilla stack, **no build step, no database, no secrets.**

> **What changed?** See `UPDATES.md` for a dated changelog of updates in this build.

---

## What it is

A calculator that, given a token contract address (or an LP pair address), pulls the token's
live DEX pools, lets the user pick one pool, and computes how much native liquidity (SOL / ETH /
BNB) a team could recover by draining it — plus relaunch-cost tables (pump.fun/pumpswap, Meteora,
Raydium, Uniswap) and a leftover-tokens breakdown.

Supported chains: **Solana, Ethereum, Base, BNB Chain (bsc), Robinhood.**

## Architecture (important)

```
Browser (public/index.html)  →  Node server (server.js)  →  DexScreener API + chain RPCs
```

The three `/api/*` routes **must stay server-side** — the browser cannot call DexScreener / RPCs
directly (CORS + the server aggregates multiple pools). Everything else (all the math, scenarios,
formatting) runs in the browser. There is **no database**.

### Files
- `server.js` — Express proxy + 30–60s in-memory cache. ~265 lines.
- `public/index.html` — the entire UI (HTML + CSS + JS inline). ~1250 lines. No framework, no bundler.
- `package.json` — one dependency (`express`).

## Run locally

```bash
npm install
node server.js         # listens on process.env.PORT || 3000
# open http://localhost:3000
```

## API (all server-side)

| Route | Purpose |
|---|---|
| `GET /api/lookup?ca=<addr>&chain=<solana\|ethereum\|base\|bsc\|robinhood>` | Token/LP → pools, reserves, prices, supply |
| `GET /api/sol-price` | SOL/USD (for EVM→Solana relaunch mode) |
| `GET /api/native-price?chain=<...>` | ETH/BNB per-chain USD price (cross-chain mode) |

`/api/lookup` returns `{ chain, token:{symbol,name,address,priceUsd,logo,marketCap},
pool:{ ...aggregate..., pools:[ per-pool {address,dex,quote,liquidityUsd,chainId,tokensInPool,
nativeInPool,priceUsd} ] } }`. The UI recomputes all recovery math from `pool.pools`.

## Config the dev team will likely touch

**RPC endpoints** — all in ONE place: the `CHAINS` object at the top of `server.js`. Each chain has
`{ native, wrapped, wtok, rpc }`. Swap the public RPCs for your own (you mentioned you'll use a
different RPC) by editing `rpc` there. Nothing else references an RPC URL.

**Add a chain** — add one entry to `CHAINS` (native symbol, wrapped-token aliases, wrapped-token
address, RPC) + a chain tab button in `public/index.html` (search `data-chain=`).

**External assets currently loaded from CDNs** (fine as-is, but you may want to self-host / re-theme):
- Google Fonts (Inter, JetBrains Mono) — `<link>` in `<head>`.
- DexScreener CDN for token/DEX/chain icons (`dd.dexscreener.com`).
- A few AMM logo favicons (pump.fun, meteora, uniswap, pancakeswap).
Review these against your CSP.

**Theme** — colors/typography are CSS variables in `:root` (top of the `<style>` block in
`public/index.html`). Re-map to migrate.fun's palette there.

## Integration options

- **Iframe embed** — serve `server.js` as-is behind your infra; drop it in an `<iframe>`. Zero code changes.
- **Port the UI** — move `public/index.html` into your app/design system, and re-implement the three
  `/api/*` routes in your own backend (they're small; logic is all in `server.js`). Keep them
  server-side.

## Notes
- No secrets, no auth, no DB — safe to host publicly.
- In-memory cache (TTL in `server.js`): lookups 30s, prices 60s, capped at 500 entries.
- Fee: the platform fee is applied in the browser's `calcScenario` (`public/index.html`) via the `PLATFORM_FEE` constant — do not surface the exact percentage in the UI.
- pump.fun bonding-curve constant: 85 SOL graduation liquidity is **included** in "SOL Needed".
