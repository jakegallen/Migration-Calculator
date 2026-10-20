# migrate.fun LP Recovery Calculator (`migrate-calc`)  -  Build Handoff & Checkpoint

_Given a token/LP address, pulls its live DEX pools and computes how much native liquidity
(SOL/ETH/BNB) a team could recover, plus relaunch-cost tables and a leftover-tokens breakdown._
_Live at `/pub/main/migrate-calc/`. Checkpoint: 2026-09-12 (see `UPDATES.md` for the changelog)._

> **2026-09-12 update (this checkpoint):**
> - **Pons added as a migration output** (Robinhood chain, native quote = ETH). Bonding-curve math verified on-chain against live curves: phantomQuote φ = 1.68 ETH, graduationThreshold = 4.2 ETH, 1B supply, 100bps curve fee, 0.0005 ETH launch fee (factory `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e`). Modeled with the same graduated-pool AMM math as pump: `ethNeeded = sqrt(kPool · mcEth / supply)`, where `kPool = grad · reservedTokens` and `reservedTokens = supply · φ/(φ+grad) ≈ 285.7M`. Split at graduation: **Pons 71.4% curve / 28.6% pool**, vs **pump 79.3% / 20.7%** (pump k = 85 SOL × 207M).
> - **% column flipped to "% Supply Purchased"** on both pump and Pons (was pool-share).
> - **Visual pass:** inline ETH/SOL/stablecoin logos everywhere a ticker used to be plain text (reusable `<symbol>` defs + `tok()`/`coinMark()`/`quoteBadge()` helpers). ETH is monochrome via `currentColor`; SOL keeps its brand gradient; USDC/USDT/PYUSD/DAI quote-token logos in the LP pair dropdown (never bare tickers); generic coin fallback for unknown quotes.
> - **Two-tone leftover cell** (white/red amount + green/muted USD accent, never all-green), large values abbreviated with exact-figure tooltip.
> - **% Supply Purchased** now has a slim supply bar; middle column de-emphasized so the eye lands on Needed → Leftover.
> - **Per-row GRAD chip retired** in favor of one note per table stating the graduation requirement (pump 85 SOL, Pons 4.2 ETH). Chip still shown on the custom-MC row where it's informative.
> - Live ETH price auto-fetched for the Pons table (`/api/native-price?chain=ethereum`), user edits win thereafter.
> - **Below-graduation guard (bug fix):** a custom target under the graduation threshold (pump < 85 SOL, Pons < 4.2 ETH) can't migrate — the curve must fully graduate first. Both custom-MC rows now detect `!row.graduated` and render "Migration not available" (amber, via `migNA()`) instead of a negative % Supply Purchased and a bogus leftover. Presets are all above graduation, so this only affects the custom-input row.

> Fresh-agent note: this app is fully self-contained in this directory  -  **no build step, no
> database, no secrets, no auth.** Sections 2 + 6 are all you need to run it. It's a hand-off
> package intended for the migrate.fun dev team to drop into their infra or port into their app.

---

## 1. What it is

A calculator that, given a token contract address (or LP pair address), pulls the token's live DEX
pools from DexScreener + chain RPCs, lets the user pick a pool, and computes:
- native liquidity (SOL/ETH/BNB) recoverable by draining that pool (constant-product upper bound),
- relaunch-cost tables (pump.fun/pumpswap, Meteora, Raydium, Uniswap, PancakeSwap, **Pons** on Robinhood),
- a **Leftover Tokens** breakdown (net recovered − cost to reseed at a target market cap).

Supported chains: **Solana, Ethereum, Base, BNB Chain (bsc), Robinhood.** A **Live / Manual**
toggle lets a user enter their own pool numbers and run the same engine (supports shorthand caps
like `22m`, `1b`).

---

## 2. Runtime & platform contract

Emblem:build `app` artifact: Node/Express `server.js` binds `process.env.PORT`; static SPA under
`public/`. Same golden rules as the other Emblem apps: **browser calls relative paths only**
(`fetch('api/...')`), and **all external calls are server-side** (the browser cannot hit DexScreener
/ RPCs directly  -  CORS, plus the server aggregates multiple pools). **No database, no env secrets**  - 
the only env var is `PORT`. Safe to host publicly as-is.

```
Browser (public/index.html)  →  Node server (server.js)  →  DexScreener API + chain RPCs
```

Static edits are live on reload; `server.js` edits need a process/artifact restart.

---

## 3. Architecture & files

| File | Role |
|---|---|
| `server.js` | Express proxy + 30 - 60s in-memory cache (lookups 30s, prices 60s, cap 500). ~265 lines. The `CHAINS` object at the top holds every RPC endpoint + native/wrapped token config  -  the ONE place to swap RPCs or add a chain. |
| `public/index.html` | The entire UI  -  HTML + CSS + JS inline. ~1,250 lines. No framework, no bundler. All recovery math, scenarios, and formatting run in the browser. Theme = CSS variables in `:root`. |
| `package.json` | One dependency: `express`. |
| `README.md` / `UPDATES.md` | Dev-team hand-off notes + dated changelog. |

---

## 4. API (all server-side)

| Route | Purpose |
|---|---|
| `GET /api/lookup?ca=<addr>&chain=<solana\|ethereum\|base\|bsc\|robinhood>` | Token/LP → pools, reserves, prices, supply |
| `GET /api/sol-price` | SOL/USD (for EVM→Solana relaunch mode) |
| `GET /api/native-price?chain=<...>` | ETH/BNB per-chain USD price (cross-chain mode) |

`/api/lookup` returns `{ chain, token:{symbol,name,address,priceUsd,logo,marketCap},
pool:{ ...aggregate..., pools:[ per-pool {address,dex,quote,liquidityUsd,chainId,tokensInPool,
nativeInPool,priceUsd} ] } }`. The UI recomputes all recovery math client-side from `pool.pools`.

---

## 5. Config the next team will touch

- **RPC endpoints**  -  all in the `CHAINS` object at the top of `server.js` (`{native, wrapped, wtok,
  rpc}` per chain). Swap the public RPCs for your own there; nothing else references an RPC URL.
- **Add a chain**  -  one `CHAINS` entry + a `data-chain=` tab button in `public/index.html`.
- **Theme**  -  CSS variables in `:root` (top of the `<style>` block in `public/index.html`).
- **External CDNs** (review against your CSP): Google Fonts, DexScreener icon CDN
  (`dd.dexscreener.com`), a few AMM logo favicons.

---

## 6. How to run it

**Standalone / GitHub clone:**
```bash
npm install
PORT=3000 node server.js      # → http://localhost:3000/
```
No keys, no DB  -  it just works. **Integration options:** (a) iframe-embed `server.js` as-is (zero
code changes), or (b) port `public/index.html` into your design system and re-implement the three
small `/api/*` routes in your own backend (keep them server-side).

---

## 7. Notes & gotchas

- **Platform fee** is deducted in the browser (`calcScenario` in `public/index.html`) via the
  `PLATFORM_FEE` constant  -  net (post-fee) values are shown everywhere. **Do not surface the exact
  percentage in the UI.**
- Recovery figures are an **upper bound**: `available = totalSupply − tokensInPool`, constant-product
  drain. Concentrated-liquidity pools can overstate reserves; the pump.fun formula assumes 1B supply.
- **pump.fun** "SOL needed" **includes** the ~85 SOL bonding-curve graduation liquidity (a prior
  external calculator overstated leftover by ~85 SOL by excluding it).
- Bottom disclaimer: figures are illustrative estimates, subject to volatility/slippage/protocol
  discretion  -  not financial advice.

_This doc + `README.md` + `UPDATES.md` + the source in this zip are the complete, self-sufficient
hand-off. A dev with this directory can run, re-theme, re-RPC, and redeploy with no other context._
