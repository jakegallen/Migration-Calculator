const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Scenario math (25/50/75% + slider) lives entirely in the browser now — it recomputes
// per selected pool. The server only supplies raw pool reserves + prices.

const DX_HEADERS = { 'Accept': 'application/json', 'User-Agent': 'migrate-calc/1.0' };
// Resilient JSON GET. Retries transient failures (timeout / network / 429 / 5xx) with small backoff so a single
// upstream blip (DexScreener or GeckoTerminal occasionally time out ~6-7s) never surfaces as a false "no pools".
// `ctx` (optional) records whether a TRANSIENT failure exhausted retries, so the caller can answer 503-try-again
// instead of a definitive 404 when the provider was simply unreachable. A clean 4xx (other than 429) is treated as
// a real "not found" and is NOT retried.
async function fetchJson(url, ms = 7000, retries = 2, ctx = null) {
  let transient = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { headers: DX_HEADERS, signal: AbortSignal.timeout(ms) });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) transient = true;   // provider busy/erroring → worth retrying
      else return null;                                            // real 4xx (e.g. 404) → definitive, stop
    } catch { transient = true; }                                  // timeout / DNS / network reset → retry
    if (attempt < retries) await new Promise(res => setTimeout(res, 350 * (attempt + 1)));
  }
  if (transient && ctx) ctx.upstreamFail = true;
  return null;
}

// ── Tiny in-memory TTL cache (repeat lookups return instantly, fewer upstream calls) ──
const CACHE_MAX = 500;
const _cache = new Map(); // key -> { data, exp }
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (e.exp <= Date.now()) { _cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data, ttlMs) {
  if (_cache.size >= CACHE_MAX) { const oldest = _cache.keys().next().value; _cache.delete(oldest); }
  _cache.set(key, { data, exp: Date.now() + ttlMs });
}

const STABLES = ['USDC', 'USDT', 'DAI', 'BUSD', 'USD1', 'USDS', 'FDUSD', 'PYUSD', 'USDH', 'UXD', 'TUSD'];
const isStableSym = (s) => STABLES.some(x => (s || '').toUpperCase().includes(x));

// Single source of truth per chain: native token, wrapped-token aliases, the wrapped-token
// address (native-price fallback), and the RPC endpoint (on-chain total supply).
const CHAINS = {
  solana:    { native: 'SOL', wrapped: ['SOL', 'WSOL'], rpc: 'https://api.mainnet-beta.solana.com' },
  ethereum:  { native: 'ETH', wrapped: ['ETH', 'WETH'], wtok: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', rpc: 'https://eth.llamarpc.com' },
  base:      { native: 'ETH', wrapped: ['ETH', 'WETH'], wtok: '0x4200000000000000000000000000000000000006', rpc: 'https://mainnet.base.org' },
  bsc:       { native: 'BNB', wrapped: ['BNB', 'WBNB'], wtok: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', rpc: 'https://bsc-dataseed.binance.org' },
  robinhood: { native: 'ETH', wrapped: ['ETH', 'WETH'], wtok: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', rpc: 'https://rpc.mainnet.chain.robinhood.com' },
};
const DEFAULT_WTOK = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const DEFAULT_RPC  = 'https://eth.llamarpc.com';

// GeckoTerminal is the authoritative liquidity source (DexScreener under-reports reserve_in_usd for many pools).
// Map our chain ids to GeckoTerminal network slugs. GT now indexes Robinhood (slug 'robinhood') — and DexScreener's
// API does NOT return Robinhood pairs even though its website shows them — so GT is the ONLY data source there.
const GT_NET = { solana: 'solana', ethereum: 'eth', base: 'base', bsc: 'bsc', robinhood: 'robinhood' };
// Build DexScreener-shaped pair objects from GeckoTerminal for a token OR pool address. Used as a fallback whenever
// DexScreener returns nothing (Robinhood always; any pool DS hasn't indexed yet). Returns [] on any failure.
async function gtPairsFor(chainId, ca, ctx = null) {
  const net = GT_NET[chainId];
  if (!net) return [];
  const addrOf = (gid) => String(gid || '').split('_').slice(1).join('_') || '';   // "robinhood_0x.." → "0x.."
  const mapOne = (it, incById) => {
    const a = it.attributes || {}, rel = it.relationships || {};
    const baseId = rel.base_token?.data?.id, quoteId = rel.quote_token?.data?.id, dexId = rel.dex?.data?.id;
    const bt = incById[baseId]?.attributes || {}, qt = incById[quoteId]?.attributes || {};
    const dx = incById[dexId]?.attributes || {};
    return {
      chainId, pairAddress: a.address || addrOf(it.id), dexId: dx.name || dexId || 'gt',
      baseToken:  { address: addrOf(baseId),  symbol: bt.symbol || '', name: bt.name || '' },
      quoteToken: { address: addrOf(quoteId), symbol: qt.symbol || '' },
      priceUsd: a.base_token_price_usd, priceNative: a.base_token_price_native_currency,
      liquidity: { usd: parseFloat(a.reserve_in_usd) || 0 },
      fdv: parseFloat(a.fdv_usd) || 0, marketCap: parseFloat(a.market_cap_usd || a.fdv_usd) || 0,
      info: { imageUrl: bt.image_url && bt.image_url !== 'missing.png' ? bt.image_url : '' },
    };
  };
  const parse = (d) => {
    const rows = Array.isArray(d?.data) ? d.data : (d?.data ? [d.data] : []);
    if (!rows.length) return [];
    const incById = {}; for (const it of (d.included || [])) incById[it.id] = it;
    return rows.map(it => mapOne(it, incById)).filter(p => p.pairAddress);
  };
  // GeckoTerminal is case-sensitive on some networks: EVM addresses must be lowercased, Solana base58 left as-is.
  const gca = /^0x[0-9a-fA-F]{40}$/.test(ca) ? ca.toLowerCase() : ca;
  // Try as a TOKEN first (lists every pool), then as a POOL address, then GT's fuzzy pool SEARCH as a last resort
  // (catches freshly-indexed pools the direct token/pool endpoints momentarily miss). Each call is retried by fetchJson.
  try {
    const t = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${encodeURIComponent(gca)}/pools?include=base_token,quote_token,dex`, 9000, 2, ctx);
    const tp = parse(t); if (tp.length) return tp;
  } catch (_) {}
  try {
    const p = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${encodeURIComponent(gca)}?include=base_token,quote_token,dex`, 9000, 2, ctx);
    const pp = parse(p); if (pp.length) return pp;
  } catch (_) {}
  try {
    // NOTE: ctx intentionally omitted — search is a best-effort last resort, so its own rate-limit/timeout must NOT
    // flip the whole request to "try again" (503). The primary token/pool endpoints above already feed ctx.
    const s = await fetchJson(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(ca)}&network=${net}&include=base_token,quote_token,dex`, 9000, 1, null);
    const sp = parse(s).filter(p => {   // keep only pools whose base OR quote is actually our token
      const a = (ca || '').toLowerCase();
      return (p.baseToken.address || '').toLowerCase() === a || (p.quoteToken.address || '').toLowerCase() === a;
    });
    if (sp.length) return sp;
  } catch (_) {}
  return [];
}
// Fetch GeckoTerminal pool data (reserve_in_usd + base-token price) for a batch of pool addresses, keyed by address.
// One call via the /pools/multi endpoint (cap 30). Returns {} on any failure so the caller falls back to DexScreener.
async function gtPoolMap(chainId, addrs) {
  const net = GT_NET[chainId];
  const uniq = [...new Set((addrs || []).filter(Boolean))].slice(0, 30);
  if (!net || !uniq.length) return {};
  try {
    const d = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/multi/${uniq.join(',')}`, 6000);
    const map = {};
    for (const it of (d?.data || [])) {
      const a = it.attributes || {};
      const addr = (a.address || (it.id || '').split('_').slice(1).join('_') || '').toString();
      if (!addr) continue;
      const rec = {
        reserveUsd: parseFloat(a.reserve_in_usd) || 0,
        priceUsd: parseFloat(a.base_token_price_usd) || 0,
        priceNative: parseFloat(a.base_token_price_native_currency) || 0,
      };
      map[addr] = rec; map[addr.toLowerCase()] = rec;   // key both raw (Solana base58) + lowercase (EVM checksum) so lookups match
    }
    return map;
  } catch (_) { return {}; }
}

app.get('/api/lookup', async (req, res) => {
  try {
    const { ca, chain = 'solana' } = req.query;
    if (!ca || ca.length < 10) return res.status(400).json({ error: 'Invalid address' });

    const chainId = CHAINS[chain] ? chain : 'ethereum';
    const isSolana = chainId === 'solana';
    const cfg = CHAINS[chainId];
    const caEnc = encodeURIComponent(ca);

    // Serve from cache if fresh (30s) — repeat lookups return instantly.
    const cacheKey = `lookup:${chainId}:${ca}`;
    const cachedResp = cacheGet(cacheKey);
    if (cachedResp) return res.json(cachedResp);

    // ctx records whether any upstream call hit a TRANSIENT failure (timeout / 5xx / 429) that exhausted its retries,
    // so an empty result from a provider OUTAGE answers 503-try-again instead of a misleading "no pools found".
    const ctx = { upstreamFail: false };

    // 1) Gather ALL pairs for the input. Works whether `ca` is a token address
    //    OR an LP pair address (resolve the pair to its base token, then list every pool).
    let allPairs = [];
    const [tok1, tok2] = await Promise.all([
      fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${caEnc}`, 7000, 2, ctx),
      fetchJson(`https://api.dexscreener.com/tokens/v1/${chainId}/${caEnc}`, 7000, 2, ctx),
    ]);
    if (tok1?.pairs) allPairs.push(...tok1.pairs);
    if (Array.isArray(tok2)) allPairs.push(...tok2);
    else if (tok2?.pairs) allPairs.push(...tok2.pairs);

    // If `ca` is actually an LP/pool address, resolve it to its base token then list all its pools.
    if (!allPairs.length) {
      const pl = await fetchJson(`https://api.dexscreener.com/latest/dex/pairs/${chainId}/${caEnc}`, 7000, 2, ctx);
      const p0 = pl?.pairs?.[0] || pl?.pair;
      const baseAddr = p0?.baseToken?.address;
      if (baseAddr) {
        const t = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(baseAddr)}`, 7000, 2, ctx);
        if (t?.pairs) allPairs.push(...t.pairs);
        else if (p0) allPairs.push(p0);
      }
    }

    // De-dupe by chain:pairAddress (used after every source merge).
    const dedupe = (list) => { const seen = new Set(); return list.filter(p => { const k = (p.chainId || '') + ':' + (p.pairAddress || ''); if (seen.has(k)) return false; seen.add(k); return true; }); };
    // Keep every pool on the SELECTED chain only, with real liquidity + price. (A token can share its address across
    // chains; mixing pools from different chains into one aggregate would be incorrect.)
    const filterPools = (list) => list
      .filter(p => p.chainId === chainId && (p.liquidity?.usd || 0) > 100 && parseFloat(p.priceUsd) > 0)
      .sort((a, b) => (b.liquidity.usd || 0) - (a.liquidity.usd || 0));

    // GeckoTerminal fallback: DexScreener's API returns nothing for Robinhood (and occasionally for freshly-created pools
    // on other chains) even when the pool clearly exists. GT indexes Robinhood, so pull the token/pool from there.
    let gtTried = false;
    if (!allPairs.length) {
      gtTried = true;
      const gtPairs = await gtPairsFor(chainId, ca, ctx);
      if (gtPairs.length) allPairs.push(...gtPairs);
    }
    allPairs = dedupe(allPairs);
    let pools = filterPools(allPairs);

    // Second-chance fallback: DexScreener returned SOMETHING but nothing survived the liquidity/price filter (stale or
    // dust pools). Pull GeckoTerminal (richer, more current reserves) and re-filter before giving up. This is what keeps
    // a valid pool from being hidden behind a single low-quality DexScreener row.
    if (!pools.length && !gtTried) {
      const gtPairs = await gtPairsFor(chainId, ca, ctx);
      if (gtPairs.length) { allPairs = dedupe(allPairs.concat(gtPairs)); pools = filterPools(allPairs); }
    }

    if (!pools.length) {
      // Honest messaging: a provider timeout/outage is NOT the same as "this token has no pools". If any upstream call
      // failed transiently, tell the user to retry (503) rather than falsely declaring no liquidity (404).
      if (ctx.upstreamFail) return res.status(503).json({ error: 'Price data sources are busy right now. Please try again in a moment.', retry: true });
      return res.status(404).json({ error: 'No liquidity pools found for this token or LP address.' });
    }

    // GeckoTerminal liquidity/price override (more accurate LP than DexScreener; falls back to DS per-field).
    const gtMap = await gtPoolMap(chainId, pools.map(p => p.pairAddress));
    const gtOf = (p) => gtMap[p.pairAddress] || gtMap[(p.pairAddress || '').toLowerCase()] || null;
    const pLiq   = (p) => { const g = gtOf(p); return (g && g.reserveUsd  > 0) ? g.reserveUsd  : (p.liquidity?.usd || 0); };
    const pPxUsd = (p) => { const g = gtOf(p); return (g && g.priceUsd    > 0) ? g.priceUsd    : (parseFloat(p.priceUsd)    || 0); };
    const pPxNat = (p) => { const g = gtOf(p); return (g && g.priceNative > 0) ? g.priceNative : (parseFloat(p.priceNative) || 0); };
    pools.sort((a, b) => pLiq(b) - pLiq(a));   // rank by the (GeckoTerminal-corrected) liquidity

    const top = pools[0];
    const tokenPriceUsd = pPxUsd(top);
    const tokenAddr = top.baseToken?.address || ca;

    // 2) Canonical native token + its USD price (everything is normalized to this)
    const canonicalSym = cfg.native;
    const NATIVE_SYMS = cfg.wrapped;
    let nativePriceUsd = 0;
    const nativePool = pools.find(p => NATIVE_SYMS.includes((p.quoteToken?.symbol || '').toUpperCase()) && pPxNat(p) > 0);
    if (nativePool) nativePriceUsd = pPxUsd(nativePool) / pPxNat(nativePool);
    if (!nativePriceUsd || nativePriceUsd <= 0) {
      // Fallback: look up the canonical native price directly
      if (isSolana) {
        const d = await fetchJson('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
        const sp = (d?.pairs || []).filter(p => p.chainId === 'solana' && isStableSym(p.quoteToken?.symbol)).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        nativePriceUsd = sp ? parseFloat(sp.priceUsd) : 0;
      } else {
        const WTOK = cfg.wtok || DEFAULT_WTOK;
        const d = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${WTOK}`);
        const sp = (d?.pairs || []).filter(p => p.chainId === chain && isStableSym(p.quoteToken?.symbol)).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        nativePriceUsd = sp ? parseFloat(sp.priceUsd) : 0;
      }
    }
    if (!nativePriceUsd || nativePriceUsd <= 0) return res.status(400).json({ error: `Could not determine ${canonicalSym} price for normalization.` });

    // 3) CUMULATIVE aggregation across every pool, normalized to the canonical native.
    //    On Solana migrate.fun sells through Jupiter (aggregator); on EVM through Uniswap's
    //    aggregator — so combined on-DEX liquidity is what's recoverable. We sum token
    //    reserves and sum the quote side in USD, then express the quote side in SOL/ETH.
    let tokensInPool = 0, quoteUsdTotal = 0, liquidityUsd = 0;
    const poolList = [];
    for (const p of pools) {
      const liq = pLiq(p);
      const pr = pPxUsd(p);
      if (pr <= 0) continue;
      const tokRes = liq / (2 * pr);
      tokensInPool += tokRes;
      quoteUsdTotal += liq / 2;
      liquidityUsd += liq;
      poolList.push({
        address: p.pairAddress, dex: p.dexId,
        quote: (p.quoteToken?.symbol || '').toUpperCase(),
        liquidityUsd: liq,
        chainId: p.chainId,
        // Per-pool metrics so the UI can calc recovery from a single selected pool
        tokensInPool: tokRes,
        nativeInPool: (liq / 2) / nativePriceUsd,
        priceUsd: pr,
      });
    }
    const nativeInPool = quoteUsdTotal / nativePriceUsd;

    // 4) Total supply — prefer on-chain RPC, fall back to FDV/marketCap
    let totalSupply = top.fdv && tokenPriceUsd > 0 ? top.fdv / tokenPriceUsd : 0;
    if (!totalSupply && top.marketCap && tokenPriceUsd > 0) totalSupply = top.marketCap / tokenPriceUsd;

    if (isSolana) {
      try {
        const rpcRes = await fetch(cfg.rpc, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [tokenAddr] }),
          signal: AbortSignal.timeout(3000)
        });
        const rpcData = await rpcRes.json();
        if (rpcData.result?.value?.uiAmount) totalSupply = rpcData.result.value.uiAmount;
      } catch (_) {}
    } else {
      try {
        const rpcUrl = cfg.rpc || DEFAULT_RPC;
        const ethCall = (data) => fetch(rpcUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: tokenAddr, data }, 'latest'] }),
          signal: AbortSignal.timeout(4000)
        }).then(r => r.json());
        const [supplyRes, decimalsRes] = await Promise.allSettled([ethCall('0x18160ddd'), ethCall('0x313ce567')]);
        if (supplyRes.status === 'fulfilled' && supplyRes.value.result && supplyRes.value.result !== '0x') {
          const raw = BigInt(supplyRes.value.result);
          let dec = 18;
          if (decimalsRes.status === 'fulfilled' && decimalsRes.value.result && decimalsRes.value.result !== '0x') dec = Number(BigInt(decimalsRes.value.result));
          const onChainSupply = Number(raw) / Math.pow(10, dec);
          if (onChainSupply > 0) totalSupply = onChainSupply;
        }
      } catch (_) {}
    }

    if (!totalSupply || totalSupply <= 0) return res.status(400).json({ error: 'Could not determine total token supply.' });

    const available = Math.max(0, totalSupply - tokensInPool);

    console.log(`Lookup ${chainId}/${ca}: ${poolList.length} pool(s), liq=$${Math.round(liquidityUsd)}, native=${canonicalSym}`);

    const payload = {
      chain: chainId,
      token: {
        symbol: top.baseToken?.symbol || '???',
        name: top.baseToken?.name || 'Unknown',
        address: tokenAddr,
        priceUsd: tokenPriceUsd,
        // Prefer DexScreener's rich token image; fall back to its token-icon CDN.
        logo: top.info?.imageUrl || `https://dd.dexscreener.com/ds-data/tokens/${chainId}/${tokenAddr}.png`,
        marketCap: top.marketCap || top.fdv || 0,
      },
      pool: {
        address: top.pairAddress,
        dex: top.dexId,
        tokensInPool, nativeInPool,
        nativeSymbol: canonicalSym,
        nativePrice: nativePriceUsd,
        solPriceUsd: isSolana ? nativePriceUsd : null,
        totalSupply, liquidityUsd, available,
        availablePct: totalSupply > 0 ? (available / totalSupply) * 100 : 0,
        poolCount: poolList.length,
        pools: poolList,
      },
    };
    cacheSet(cacheKey, payload, 30000); // 30s TTL
    res.json(payload);

  } catch (err) {
    console.error('Lookup error:', err.message);
    res.status(500).json({ error: 'Lookup failed: ' + err.message });
  }
});

// Quick SOL price lookup (for cross-chain EVM→Solana mode)
app.get('/api/sol-price', async (req, res) => {
  try {
    const cached = cacheGet('sol-price');
    if (cached) return res.json(cached);
    const d = await fetchJson('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', 4000);
    const pair = (d?.pairs || [])
      .filter(p => p.chainId === 'solana' && ['USDC','USDT'].some(s => (p.quoteToken?.symbol||'').includes(s)))
      .sort((a, b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0))[0];
    if (!pair) return res.status(404).json({ error: 'SOL price not found' });
    const out = { solPriceUsd: parseFloat(pair.priceUsd) || 0 };
    cacheSet('sol-price', out, 60000); // 60s TTL
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Native token price lookup for cross-chain calcs (?chain=ethereum|base|bsc)
app.get('/api/native-price', async (req, res) => {
  const chain = (req.query.chain || 'ethereum').toLowerCase();
  const cfg = CHAINS[chain];
  const TOKEN = cfg && cfg.wtok;
  if (!TOKEN) return res.status(400).json({ error: 'Unknown chain' });
  try {
    const cached = cacheGet(`native:${chain}`);
    if (cached) return res.json(cached);
    const d = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN}`, 4000);
    const pair = (d?.pairs || [])
      .filter(p => p.chainId === chain && ['USDC','USDT','DAI','BUSD'].some(s => (p.quoteToken?.symbol||'').includes(s)))
      .sort((a, b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0))[0];
    if (!pair) return res.status(404).json({ error: 'Price not found' });
    const out = { priceUsd: parseFloat(pair.priceUsd) || 0, symbol: cfg.native };
    cacheSet(`native:${chain}`, out, 60000); // 60s TTL
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Prod liveness watcher (interim auto-recovery) ──────────────────────────────
// Re-establishes the proven in-process self-heal (previously in rvlt-loot, now unpublished) so the money-handling apps are
// not one silent crash from downtime. Hosted here because migrate-calc is the smallest always-on Node app, so it tends to
// SURVIVE the same host-wide OOM cull that takes down a bigger app it guards. Every 3 min it GETs each target's public URL;
// a live process answers (<500, even a gated 401), only a 5xx/timeout = DOWN. After 2 consecutive misses (~6 min) it POSTs
// a restart via the Dashboard API (artifact Bearer token), 15-min cooldown PER app so it can never restart-storm. NO agent
// spawn, negligible memory - the approved alternative to the removed agent heartbeat. Disable with PROD_WATCH=off.
(function prodWatch(){
  const API = process.env.DASHBOARD_BASE || ('http://localhost:' + (process.env.DASHBOARD_PORT || 4000));
  const TOKEN = process.env.DASHBOARD_TOKEN || '';
  const GROUP = process.env.ARTIFACT_GROUP || 'main';
  if (process.env.PROD_WATCH === 'off' || !TOKEN) { console.log('[prodwatch] disabled (no DASHBOARD_TOKEN or PROD_WATCH=off)'); return; }
  const WATCH = ['vault-mint', 'oneshot'];   // money-handling prod apps to keep alive
  const st = new Map();   // name -> { miss, lastHeal }
  const timer = setInterval(() => {
    WATCH.forEach(async (name) => {
      const s = st.get(name) || { miss: 0, lastHeal: 0 }; st.set(name, s);
      let up = false;
      try { const r = await fetch(API + '/pub/' + GROUP + '/' + name + '/', { signal: AbortSignal.timeout(8000) }); up = r.status < 500; } catch (e) { up = false; }
      if (up) { s.miss = 0; return; }
      if (++s.miss < 2) return;
      s.miss = 0;
      if (Date.now() - s.lastHeal < 900000) return;   // 15-min per-app cooldown, never restart-storm
      s.lastHeal = Date.now();
      try { const rr = await fetch(API + '/api/artifacts/' + GROUP + '/' + name + '/restart', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN } }); console.log('[prodwatch] ' + name + ' down -> restart requested (' + rr.status + ')'); }
      catch (e2) { console.error('[prodwatch] ' + name + ' restart failed: ' + e2.message); }
    });
  }, 180000);
  if (timer.unref) timer.unref();
  console.log('[prodwatch] on - guarding ' + WATCH.join(', '));
})();

app.listen(PORT, () => console.log(`migrate-calc on port ${PORT}`));
