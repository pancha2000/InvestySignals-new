/**
 * ════════════════════════════════════════════════════════════════════════
 *  experiments/longshort_ratio.js
 * ────────────────────────────────────────────────────────────────────────
 *  STANDALONE experiment module — does NOT import from or modify
 *  server.js, ai_agent.js, or market_tools.js. Safe to test in isolation.
 *
 *  WHAT THIS DOES
 *  Fetches Binance Futures' "Global Long/Short Account Ratio" — the % of
 *  accounts holding long vs short positions on a symbol. This is a free,
 *  no-auth-key public endpoint.
 *
 *  WHY IT'S USEFUL (confluence confirmation, not a new rule engine)
 *  Extreme long/short skew + price weakening = classic squeeze setup.
 *  e.g. 80% of accounts long + price failing to make new highs = retail
 *  is trapped long → higher probability of a long-liquidation flush down.
 *  This is meant to CONFIRM your existing ICT/SMC confluence score, not
 *  replace it.
 *
 *  HOW TO TEST STANDALONE
 *    node experiments/longshort_ratio.js BTCUSDT
 * ════════════════════════════════════════════════════════════════════════
 */

'use strict';

const BASE_URL = 'https://fapi.binance.com/futures/data/globalLongShortAccountRatio';

/**
 * Bulletproof fetch with retry + timeout — same pattern as market_tools.js's
 * fetchJSON, kept local/duplicated on purpose so this file has ZERO
 * dependency on the production codebase.
 */
async function fetchJSON(url, { retries = 3, timeoutMs = 8000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.status === 429 || r.status === 418) {
        await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, attempt)));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt === retries - 1) break;
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  throw lastErr || new Error(`fetchJSON failed: ${url}`);
}

/**
 * getLongShortRatio(symbol, period)
 *   symbol: e.g. 'BTCUSDT'
 *   period: '5m'|'15m'|'30m'|'1h'|'2h'|'4h'|'6h'|'12h'|'1d' (default '1h')
 *
 * Returns: {
 *   symbol, timestamp,
 *   longAccount: 0.62,   // 62% of accounts are long
 *   shortAccount: 0.38,
 *   longShortRatio: 1.63,
 *   skewLabel: 'LONG_HEAVY' | 'SHORT_HEAVY' | 'BALANCED'
 * }
 */
async function getLongShortRatio(symbol = 'BTCUSDT', period = '1h') {
  const url = `${BASE_URL}?symbol=${symbol}&period=${period}&limit=1`;
  const data = await fetchJSON(url);
  if (!Array.isArray(data) || data.length === 0) {
    return { symbol, error: 'No data returned', raw: data };
  }
  const row = data[0];
  const longAccount = parseFloat(row.longAccount);
  const shortAccount = parseFloat(row.shortAccount);
  const longShortRatio = parseFloat(row.longShortRatio);

  let skewLabel = 'BALANCED';
  if (longAccount >= 0.65) skewLabel = 'LONG_HEAVY';
  else if (shortAccount >= 0.65) skewLabel = 'SHORT_HEAVY';

  return {
    symbol,
    timestamp: new Date(Number(row.timestamp)).toISOString(),
    longAccount,
    shortAccount,
    longShortRatio,
    skewLabel,
  };
}

module.exports = { getLongShortRatio };

// Allow direct standalone execution: `node experiments/longshort_ratio.js BTCUSDT`
if (require.main === module) {
  const symbol = process.argv[2] || 'BTCUSDT';
  getLongShortRatio(symbol)
    .then((res) => console.log(JSON.stringify(res, null, 2)))
    .catch((err) => console.error('FAILED:', err.message));
}
