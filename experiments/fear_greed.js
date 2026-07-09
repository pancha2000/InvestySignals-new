/**
 * ════════════════════════════════════════════════════════════════════════
 *  experiments/fear_greed.js
 * ────────────────────────────────────────────────────────────────────────
 *  STANDALONE experiment module — no dependency on production files.
 *
 *  WHAT THIS DOES
 *  Fetches the Crypto Fear & Greed Index from alternative.me (free,
 *  no-auth-key public API). Values 0-100:
 *    0-24   Extreme Fear
 *    25-44  Fear
 *    45-55  Neutral
 *    56-75  Greed
 *    76-100 Extreme Greed
 *
 *  WHY IT'S USEFUL (confluence confirmation)
 *  Extreme Fear + your existing ICT/SMC bullish setup (e.g. liquidity
 *  sweep + discount zone) = classic "be greedy when others are fearful"
 *  confirmation. Extreme Greed + bearish setup = same idea, reversed.
 *  This is a confirmation layer for the EXISTING confluence score —
 *  it does not invent a new rule engine.
 *
 *  HOW TO TEST STANDALONE
 *    node experiments/fear_greed.js
 * ════════════════════════════════════════════════════════════════════════
 */

'use strict';

const URL = 'https://api.alternative.me/fng/?limit=1';

async function fetchJSON(url, { retries = 3, timeoutMs = 8000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
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
 * getFearGreedIndex()
 * Returns: {
 *   value: 27,
 *   classification: 'Fear',
 *   timestamp,
 *   confluenceHint: 'BULLISH_BIAS' | 'BEARISH_BIAS' | 'NEUTRAL'
 * }
 */
async function getFearGreedIndex() {
  const data = await fetchJSON(URL);
  const row = data && data.data && data.data[0];
  if (!row) return { error: 'No data returned', raw: data };

  const value = parseInt(row.value, 10);
  const classification = row.value_classification;

  // Contrarian hint — extreme fear leans bullish confirmation, extreme
  // greed leans bearish confirmation. NEUTRAL in the middle band.
  let confluenceHint = 'NEUTRAL';
  if (value <= 24) confluenceHint = 'BULLISH_BIAS';
  else if (value >= 76) confluenceHint = 'BEARISH_BIAS';

  return {
    value,
    classification,
    timestamp: new Date(Number(row.timestamp) * 1000).toISOString(),
    confluenceHint,
  };
}

module.exports = { getFearGreedIndex };

if (require.main === module) {
  getFearGreedIndex()
    .then((res) => console.log(JSON.stringify(res, null, 2)))
    .catch((err) => console.error('FAILED:', err.message));
}
