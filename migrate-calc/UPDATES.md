# migrate.fun — LP Recovery Calculator · Update Log

All UI/logic lives in `public/index.html`; the three `/api/*` routes are in `server.js`.
No build step, no database, no secrets.

---

## 2026-07-23

### Labeling / copy
- **Removed all "team treasury" language.** Every relaunch section (Meteora, Raydium,
  Uniswap, pumpswap, and the SOL→Uniswap cross-chain calc) now labels the residual as
  **"Leftover Tokens"** instead of implying funds route to a team treasury.
  - `renderLpPool()` in `public/index.html`: card label, the `leftoverUsd` sub-text, and the
    summary banner strings were rewritten.
- **Removed the redundant leftover summary banner.** The green `treasury-banner` line that
  restated the leftover total was deleted from all sections — the **Leftover Tokens** card
  already shows the same figure, so the banner was purely additive.
  - Removed the 4 `<div class="treasury-banner" id="…TreasuryBanner">` elements, the JS block
    in `renderLpPool()` that populated them, and the now-dead `banner:` id keys.
- **"Uniswap Pool" everywhere** — dropped the "V2" from every Uniswap section title/label
  (main EVM Uniswap platform button, its calc title, the JS default title, and the
  SOL→Uniswap cross-chain header). BNB still shows "PancakeSwap Pool".

### Chains
- **Robinhood added as a cross-chain relaunch option** in the SOL→Uniswap section, alongside
  ETH / Base / BNB. Robinhood's native token is **ETH**, so it uses the ETH symbol, the ETH
  price, and an "Your ETH Side" label. Server already supports `robinhood` in
  `/api/native-price` and `/api/lookup` (see the `CHAINS` map in `server.js`).

### Calculator behavior
- **Manual mode.** A **Live / Manual** toggle lets a user enter their own pool numbers
  (ticker, tokens in pool, native in pool, native symbol, total supply, token price) and run
  the exact same recovery engine. Supports shorthand market caps (e.g. `22m`, `1b`). Live-pool
  LP-pair list is hidden in manual mode.
- **pump.fun "Leftover SOL" fix.** "SOL needed" now uses the **full** pool SOL required to
  seed the relaunch pool — it **includes the ~85 SOL bonding-curve graduation liquidity**.
  Previously (in the old external calculator) leftover was overstated by ~85 SOL because that
  bonded amount was excluded. `leftover = netRecoveredSol − solNeeded` now nets correctly.
- **Tooltip copy** on the pumpswap launch-cost table:
  - *SOL needed* — "SOL to seed the new pool (includes the ~85 SOL bonding-curve liquidity)."
  - *Leftover SOL* — "recovered SOL minus SOL needed to relaunch token at target market cap
    (leftover funds are claimable by team after 90-day claim period ends)."
- **Clear-to-home.** Emptying the token/LP address in the search bar now resets state and
  returns to the empty/home view automatically.

### Housekeeping
- Added a bottom **disclaimer**: figures are estimates for illustrative purposes, may vary with
  market volatility/slippage/execution, and remain subject to protocol discretion — not
  financial advice.
- Math audit pass: no outstanding hard bugs found. Removed a dead `PUMP_GRAD_SOL = 85` constant
  and a stale comment; the platform fee is applied in `calcScenario` via the `PLATFORM_FEE`
  constant (exact percentage intentionally not surfaced in the UI).

---

## Notes for reviewers
- The platform fee is **deducted in the browser** (`calcScenario`, `public/index.html`) via the
  `PLATFORM_FEE` constant — net (post-fee) values are shown everywhere. Do not surface the exact
  percentage in UI.
- Recovery figures are an upper bound: `available = totalSupply − tokensInPool`, constant-product
  drain. Concentrated-liquidity pools can overstate reserves; the pump.fun formula assumes a 1B
  supply.
- RPC endpoints are all in the `CHAINS` object at the top of `server.js` — swap in your own there.
