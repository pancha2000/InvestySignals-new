/**
 * ════════════════════════════════════════════════════════════════════════
 *  market_tools.js
 * ────────────────────────────────────────────────────────────────────────
 *  InvestySignals — Market Data & Indicator Engine for the AI Quant Agent.
 *
 *  WHAT THIS FILE IS
 *  This is a self-contained module. It does NOT touch, import from, or
 *  modify server.js in any way — your existing fast dashboard
 *  (/api/deep-analysis, /api/analysis, /api/scan, /api/trade-monitor) keeps
 *  running exactly as it does today, untouched. This file is a parallel,
 *  faithful migration of the SAME indicator math, repackaged so the new
 *  AI Agent (ai_agent.js) can call it as "tools".
 *
 *  "CODE CALCULATES, AI REASONS" — every function below returns plain
 *  computed numbers/labels. Nothing in this file decides BUY/SELL/HOLD —
 *  that judgment call belongs to the AI layer on top.
 *
 *  MIGRATION MAP (old name in server.js → new name here) — nothing was
 *  deleted, only reorganized and hardened:
 *    _da_ema          → indicators.ema
 *    _da_rsi          → indicators.rsiValue
 *    _da_rsiArray     → indicators.rsiSeries
 *    _da_macd         → indicators.macd
 *    _da_bb           → indicators.bollingerBands
 *    _da_atr          → indicators.atr
 *    _da_adx          → indicators.adx
 *    _da_structure    → structure.detectStructure        (BOS / CHoCH)
 *    _da_fvgs         → structure.findFairValueGaps
 *    _da_srLevels     → structure.findSupportResistanceLevels
 *    _da_orderBlock   → structure.findOrderBlock          (legacy single, kept for parity)
 *    _da_orderBlocks  → structure.findOrderBlocks         (multi, up to 5 — used by tools)
 *    _da_fibonacci    → structure.fibonacciRetracement
 *    _da_volRatio     → candleReading.volumeRatio
 *    _da_candlePattern→ candleReading.candlePattern
 *    _da_rsiDiv       → candleReading.rsiDivergence
 *    fetchKlinesCached→ data.fetchKlinesCached  (same cache/retry strategy, generalized)
 *    getLivePrice     → data.getLivePrice       (same futures→spot fallback)
 *    normalizePair    → data.normalizePair
 *    sanitizeCandles  → data.sanitizeCandles
 *    Open Interest fetch (inline)  → data.getOpenInterestContext
 *    Funding Rate fetch (inline)   → data.getFundingRateContext
 *    BTC trend calc (inline)       → data.getBtcTrendContext
 *    /api/scan filter logic        → tools.scanMarket (same thresholds, now cached)
 *    (brand new)                   → tools.getCryptoNews — multi-provider + free RSS fallback
 *
 *  Exposed AI-tool-ready functions (consumed by ai_agent.js):
 *    scanMarket(), getLivePriceSnapshot(symbol), getTechnicalIndicators(symbol, timeframe),
 *    getMarketStructure(symbol), getCryptoNews(symbol)
 * ════════════════════════════════════════════════════════════════════════
 */

'use strict';

const { XMLParser } = require('fast-xml-parser');

// ════════════════════════════════════════════════════════════════════════
// SECTION 1 — Generic infrastructure: sleep, rounding, TTL cache,
//             concurrency limiter, bulletproof fetch (retry + backoff).
//             This is the "Bulletproof Error Handling" layer requested:
//             every outbound HTTP call in this file passes through here.
// ════════════════════════════════════════════════════════════════════════

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Round a float to N decimals and return a Number (never a string). */
function round(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * f) / f;
}

/** Simple in-memory TTL cache. One instance per data type (klines, price, scan…). */
class TTLCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key, value) {
    this.store.set(key, { value, ts: Date.now() });
    return value;
  }
}

/** Tiny semaphore so we never blast Binance with unlimited parallel requests
 *  (this is what actually causes IP bans on a small VPS). */
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  acquire() {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve)).then(() => {
      this.active++;
    });
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// Cap concurrent outbound Binance calls (configurable via .env if your VPS is small).
const binanceLimiter = new Semaphore(parseInt(process.env.BINANCE_MAX_CONCURRENCY || '6', 10));

/**
 * Bulletproof JSON fetch: timeout + auto-retry with exponential backoff on
 * 429/418 (Binance rate-limit / soft-ban codes) + backoff on network errors.
 * Every Binance call in this file goes through this single chokepoint, so
 * rate-limiting and retry behaviour is consistent everywhere (scan, price,
 * klines, open interest, funding rate all benefit — most of these had ZERO
 * retry protection in the original inline code).
 */
async function fetchJSON(url, { retries = 3, timeoutMs = 8000 } = {}) {
  await binanceLimiter.acquire();
  try {
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (r.status === 429 || r.status === 418) {
          // Binance rate-limit / soft IP-ban response — back off hard and retry.
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        if (!r.ok) {
          lastErr = new Error(`HTTP ${r.status} for ${url}`);
          break; // non-rate-limit HTTP error — don't burn retries, let caller fall back
        }
        return await r.json();
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (attempt === retries - 1) break;
        await sleep(500 * (attempt + 1));
      }
    }
    throw lastErr || new Error(`fetchJSON failed: ${url}`);
  } finally {
    binanceLimiter.release();
  }
}

/** Same idea as fetchJSON but returns raw text (used for RSS feeds). */
async function fetchText(url, { timeoutMs = 8000 } = {}) {
  await binanceLimiter.acquire();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'InvestySignals/2.0 (+news-reader)' } });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.text();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  } finally {
    binanceLimiter.release();
  }
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 2 — Binance data access layer
//             (fetchKlinesCached / getLivePrice / normalizePair / sanitizeCandles
//              are 1:1 faithful migrations of the existing server.js logic —
//              same cache windows, same futures→spot fallback, same outlier filter)
// ════════════════════════════════════════════════════════════════════════

const klinesCache = new TTLCache(5 * 60 * 1000); // unchanged: 5 min (tuned in original — DO NOT shorten)
const priceCache = new TTLCache(10 * 1000); // unchanged: 10 sec
const oiCache = new TTLCache(60 * 1000); // new: open interest barely moves tick-to-tick
const fundingCache = new TTLCache(60 * 1000); // new: funding rate updates every 8h on Binance anyway
const scanCache = new TTLCache(30 * 1000); // new: full-market scan is the heaviest call — cache it
const newsCache = new TTLCache(10 * 60 * 1000); // new: headlines don't need second-by-second freshness
const btcTrendCache = new TTLCache(60 * 1000); // new: avoid refetching BTC context on every tool call

/** Normalize a trading pair — always ensure a USDT suffix. xlm → XLMUSDT */
function normalizePair(pair) {
  if (!pair) return '';
  const p = pair.toString().toUpperCase().replace(/[^A-Z0-9]/g, '').trim();
  if (!p) return '';
  return p.endsWith('USDT') ? p : p + 'USDT';
}

/** Outlier sanitization — drop candles whose close is >30% off the median
 *  (protects every downstream indicator from a single bad/spiked print). */
function sanitizeCandles(klines) {
  if (!klines || klines.length < 10) return klines;
  const closes = klines.map((k) => parseFloat(k[4])).sort((a, b) => a - b);
  const median = closes[Math.floor(closes.length / 2)];
  if (median <= 0) return klines;
  return klines.filter((k) => Math.abs(parseFloat(k[4]) - median) / median < 0.3);
}

/**
 * Fetch klines with caching + futures→spot fallback + retry/backoff.
 * Identical strategy to the existing server.js implementation, generalized
 * through the shared fetchJSON chokepoint above.
 */
async function fetchKlinesCached(symbol, interval, limit = 200) {
  const key = `${symbol}_${interval}_${limit}`;
  const cached = klinesCache.get(key);
  if (cached) return cached;

  const urls = [
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  ];

  let lastErr = null;
  for (const url of urls) {
    try {
      const data = await fetchJSON(url, { retries: 3, timeoutMs: 8000 });
      if (Array.isArray(data) && data.length >= 5) {
        return klinesCache.set(key, data);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(lastErr ? `fetchKlines failed: ${symbol} ${interval} — ${lastErr.message}` : `fetchKlines failed: ${symbol} ${interval} — not found on futures or spot`);
}

/** Convert raw Binance kline arrays into clean {open,high,low,close,volume} candles. */
async function getCandles(symbol, tf) {
  const limit = TF_LIMITS[tf] || 200;
  const raw = await fetchKlinesCached(symbol, tf, limit);
  return sanitizeCandles(raw).map((k) => ({
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

/** Live price with caching + futures→spot fallback + retry/backoff. */
async function getLivePrice(symbol) {
  const cached = priceCache.get(symbol);
  if (cached !== undefined) return cached;
  try {
    let price = null;
    try {
      const fd = await fetchJSON(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`, { retries: 2, timeoutMs: 6000 });
      price = parseFloat(fd.price) || null;
    } catch (_) { /* fall through to spot */ }
    if (!price) {
      const sd = await fetchJSON(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { retries: 2, timeoutMs: 6000 });
      price = parseFloat(sd.price) || null;
    }
    if (price) priceCache.set(symbol, price);
    return price;
  } catch (e) {
    return null;
  }
}

// Standard timeframe lookback windows — unchanged from the deep-analysis engine,
// kept identical on purpose so the 5-minute klines cache is shared/reused across
// get_technical_indicators AND get_market_structure calls for the same symbol.
const TF_LIMITS = { '15m': 200, '1h': 300, '4h': 200, '1d': 250 };

// ════════════════════════════════════════════════════════════════════════
// SECTION 3 — INDICATOR MATH LIBRARY (faithful migration, formulas untouched)
// ════════════════════════════════════════════════════════════════════════

const indicators = {
  /** Exponential Moving Average. Returns the full EMA series. */
  ema(arr, n) {
    if (arr.length < n) return arr.length ? [arr[arr.length - 1]] : [];
    const k = 2 / (n + 1);
    let v = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    const out = [v];
    for (let i = n; i < arr.length; i++) {
      v = arr[i] * k + v * (1 - k);
      out.push(v);
    }
    return out;
  },

  /** Latest RSI value (Wilder smoothing), 0-100. */
  rsiValue(closes, period = 14) {
    if (closes.length < period + 2) return 50;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; d >= 0 ? (g += d) : (l -= d); }
    let ag = g / period, al = l / period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
      al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    if (al === 0) return 100;
    if (ag === 0) return 0;
    return round(100 - 100 / (1 + ag / al), 2);
  },

  /** Full RSI series (needed for divergence detection). */
  rsiSeries(closes, period = 14) {
    if (closes.length < period + 1) return [];
    const out = [];
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; d >= 0 ? (g += d) : (l -= d); }
    let ag = g / period, al = l / period;
    out.push(ag === 0 && al === 0 ? 50 : round(100 - 100 / (1 + (al === 0 ? Infinity : ag / al)), 2));
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
      al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
      out.push(ag === 0 && al === 0 ? 50 : round(100 - 100 / (1 + (al === 0 ? Infinity : ag / al)), 2));
    }
    return out;
  },

  /** MACD(12,26,9) — returns macd line, signal line, histogram + previous histogram. */
  macd(closes) {
    const e12 = indicators.ema(closes, 12), e26 = indicators.ema(closes, 26);
    const ml = e12.slice(e12.length - e26.length).map((v, i) => v - e26[i]);
    const s9 = indicators.ema(ml, 9);
    const h = ml[ml.length - 1] - s9[s9.length - 1];
    const ph = ml[ml.length - 2] - s9[s9.length - 2];
    return { macd: round(ml[ml.length - 1], 6), signal: round(s9[s9.length - 1], 6), histogram: round(h, 6), prevHistogram: round(ph, 6) };
  },

  /** Bollinger Bands (20, 2 std-dev). */
  bollingerBands(closes, n = 20) {
    const s = closes.slice(-n);
    const m = s.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(s.reduce((a, c) => a + Math.pow(c - m, 2), 0) / n);
    return { upper: round(m + 2 * std, 4), middle: round(m, 4), lower: round(m - 2 * std, 4) };
  },

  /** Average True Range (Wilder smoothing), default period 14. */
  atr(candles, n = 14) {
    if (candles.length < n + 1) return 0;
    const trs = candles.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)));
    let atrVal = trs.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < trs.length; i++) atrVal = (atrVal * (n - 1) + trs[i]) / n;
    return round(atrVal, 6);
  },

  /**
   * ADX (Average Directional Index) — full Wilder implementation.
   * adx>25 = trending | adx<20 = ranging | adx>50 = very strong trend.
   * +DI > -DI = bullish momentum | -DI > +DI = bearish momentum.
   */
  adx(candles, period = 14) {
    if (candles.length < period * 2 + 1) return { adx: 0, plusDI: 0, minusDI: 0, trend: 'RANGING', strength: 'WEAK' };

    const trArr = [], plusDM = [], minusDM = [];
    for (let i = 1; i < candles.length; i++) {
      const curr = candles[i], prev = candles[i - 1];
      const highDiff = curr.high - prev.high;
      const lowDiff = prev.low - curr.low;
      const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
      trArr.push(tr);
      plusDM.push(highDiff > 0 && highDiff > lowDiff ? highDiff : 0);
      minusDM.push(lowDiff > 0 && lowDiff > highDiff ? lowDiff : 0);
    }

    function wilderSmooth(arr, p) {
      let sum = arr.slice(0, p).reduce((a, b) => a + b, 0);
      const out = [sum];
      for (let i = p; i < arr.length; i++) {
        sum = sum - sum / p + arr[i];
        out.push(sum);
      }
      return out;
    }

    const smoothTR = wilderSmooth(trArr, period);
    const smoothPDM = wilderSmooth(plusDM, period);
    const smoothMDM = wilderSmooth(minusDM, period);

    const dxArr = [];
    for (let i = 0; i < smoothTR.length; i++) {
      if (smoothTR[i] === 0) { dxArr.push(0); continue; }
      const pdi = (100 * smoothPDM[i]) / smoothTR[i];
      const mdi = (100 * smoothMDM[i]) / smoothTR[i];
      dxArr.push((Math.abs(pdi - mdi) / (pdi + mdi || 1)) * 100);
    }

    const adxArr = wilderSmooth(dxArr, period);
    const adxVal = round(adxArr[adxArr.length - 1] / period, 2);
    const lastTR = smoothTR[smoothTR.length - 1];
    const plusDIv = lastTR ? round((100 * smoothPDM[smoothPDM.length - 1]) / lastTR, 2) : 0;
    const minDIv = lastTR ? round((100 * smoothMDM[smoothMDM.length - 1]) / lastTR, 2) : 0;

    const trend = adxVal > 25 ? (plusDIv > minDIv ? 'TRENDING_BULL' : 'TRENDING_BEAR') : 'RANGING';
    const strength = adxVal > 50 ? 'VERY_STRONG' : adxVal > 35 ? 'STRONG' : adxVal > 25 ? 'MODERATE' : adxVal > 15 ? 'WEAK' : 'NO_TREND';

    return { adx: adxVal, plusDI: plusDIv, minusDI: minDIv, trend, strength };
  },
};

// ════════════════════════════════════════════════════════════════════════
// SECTION 4 — MARKET STRUCTURE LIBRARY (BOS/CHoCH, FVG, S/R, Order Blocks, Fibonacci)
// ════════════════════════════════════════════════════════════════════════

const structure = {
  /** Break of Structure / Change of Character detector. */
  detectStructure(candles) {
    if (candles.length < 20) return 'NEUTRAL';
    const recent = candles.slice(-20);
    const mid = Math.floor(recent.length / 2);
    const prev = recent.slice(0, mid), curr = recent.slice(mid);
    const phH = Math.max(...prev.map((c) => c.high)), plL = Math.min(...prev.map((c) => c.low));
    const cH = Math.max(...curr.map((c) => c.high)), cL = Math.min(...curr.map((c) => c.low));
    const lastClose = candles[candles.length - 1].close;
    if (lastClose > phH && cH > phH) return 'BOS_BULLISH';
    if (lastClose < plL && cL < plL) return 'BOS_BEARISH';
    if (cH > phH) return 'CHOCH_BULLISH';
    if (cL < plL) return 'CHOCH_BEARISH';
    return 'NEUTRAL';
  },

  /** Fair Value Gaps — unmitigated 3-candle imbalances, most recent 5. */
  findFairValueGaps(candles) {
    const result = [];
    for (let i = 2; i < candles.length; i++) {
      const prev = candles[i - 2], curr = candles[i];
      if (curr.low > prev.high) {
        const mitigated = candles.slice(i + 1).some((c) => c.low < curr.low);
        if (!mitigated) result.push({ type: 'BULL', low: round(prev.high, 6), high: round(curr.low, 6), idx: i });
      } else if (curr.high < prev.low) {
        const mitigated = candles.slice(i + 1).some((c) => c.high > curr.high);
        if (!mitigated) result.push({ type: 'BEAR', low: round(curr.high, 6), high: round(prev.low, 6), idx: i });
      }
    }
    return result.slice(-5);
  },

  /** Pivot-based Support/Resistance — 3 nearest below + 3 nearest above price. */
  findSupportResistanceLevels(candles, n = 5) {
    const pivots = [];
    const lastClose = candles[candles.length - 1].close;
    for (let i = n; i < candles.length - n; i++) {
      const w = candles.slice(i - n, i + n + 1);
      if (candles[i].high === Math.max(...w.map((c) => c.high))) pivots.push(candles[i].high);
      if (candles[i].low === Math.min(...w.map((c) => c.low))) pivots.push(candles[i].low);
    }
    const unique = [...new Set(pivots.map((p) => round(p, 4)))].sort((a, b) => a - b);
    const below = unique.filter((p) => p <= lastClose).slice(-3);
    const above = unique.filter((p) => p > lastClose).slice(0, 3);
    return [...below, ...above].sort((a, b) => a - b);
  },

  /** Legacy single-nearest Order Block detector — preserved for parity with
   *  the original codebase. Superseded by findOrderBlocks() (below) for AI
   *  tool output, which adds an impulse-strength filter and returns up to 5. */
  findOrderBlock(candles) {
    for (let i = candles.length - 3; i >= 0; i--) {
      const c = candles[i], nx = candles[i + 1];
      if (nx.close > c.high && nx.close - nx.open > 0) {
        const mitigated = candles.slice(i + 2).some((cand) => cand.close < c.low);
        if (!mitigated) return { type: 'BULL_OB', low: round(c.low, 6), high: round(c.high, 6) };
      }
      if (nx.close < c.low && nx.open - nx.close > 0) {
        const mitigated = candles.slice(i + 2).some((cand) => cand.close > c.high);
        if (!mitigated) return { type: 'BEAR_OB', low: round(c.low, 6), high: round(c.high, 6) };
      }
    }
    return null;
  },

  /** Multiple unmitigated Order Blocks (up to maxCount), most recent first.
   *  Requires the breakout candle's body to exceed 0.5× the 30-candle average
   *  body size, filtering out weak/noise-driven "order blocks". */
  findOrderBlocks(candles, maxCount = 5) {
    const lastClose = candles[candles.length - 1].close;
    const obs = [];
    const avgBody = candles.slice(-30).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / Math.min(30, candles.length || 1);
    const minImpulse = avgBody * 0.5;

    for (let i = candles.length - 4; i >= 1; i--) {
      if (obs.length >= maxCount) break;
      const ob = candles[i];
      const next = candles[i + 1];
      const impulseBody = Math.abs(next.close - next.open);
      if (impulseBody < minImpulse) continue;

      if (ob.close < ob.open && next.close > next.open && next.close > ob.high) {
        if (lastClose > ob.low) {
          const mitigated = candles.slice(i + 2).some((c) => c.close < ob.low);
          if (!mitigated) obs.push({ type: 'BULL_OB', low: round(ob.low, 4), high: round(ob.high, 4), bodyLow: round(Math.min(ob.open, ob.close), 4), bodyHigh: round(Math.max(ob.open, ob.close), 4), idx: i });
        }
      }
      if (ob.close > ob.open && next.close < next.open && next.close < ob.low) {
        if (lastClose < ob.high) {
          const mitigated = candles.slice(i + 2).some((c) => c.close > ob.high);
          if (!mitigated) obs.push({ type: 'BEAR_OB', low: round(ob.low, 4), high: round(ob.high, 4), bodyLow: round(Math.min(ob.open, ob.close), 4), bodyHigh: round(Math.max(ob.open, ob.close), 4), idx: i });
        }
      }
    }
    return obs;
  },

  /** Fibonacci retracement from the most recent swing high/low. */
  fibonacciRetracement(candles, lookback = 50) {
    const recent = candles.slice(-lookback);
    const swingHigh = Math.max(...recent.map((c) => c.high));
    const swingLow = Math.min(...recent.map((c) => c.low));
    const range = swingHigh - swingLow;
    if (range === 0) return null;
    const lastClose = candles[candles.length - 1].close;
    const mid = swingLow + range * 0.5;
    const direction = lastClose > mid ? 'BULLISH_RETRACE' : 'BEARISH_RETRACE';
    const fmt = (v) => round(v, 4);
    return {
      direction,
      swingHigh: fmt(swingHigh),
      swingLow: fmt(swingLow),
      f236: fmt(direction === 'BULLISH_RETRACE' ? swingHigh - range * 0.236 : swingLow + range * 0.236),
      f382: fmt(direction === 'BULLISH_RETRACE' ? swingHigh - range * 0.382 : swingLow + range * 0.382),
      f500: fmt(direction === 'BULLISH_RETRACE' ? swingHigh - range * 0.5 : swingLow + range * 0.5),
      f618: fmt(direction === 'BULLISH_RETRACE' ? swingHigh - range * 0.618 : swingLow + range * 0.618),
      f786: fmt(direction === 'BULLISH_RETRACE' ? swingHigh - range * 0.786 : swingLow + range * 0.786),
    };
  },
};

// ════════════════════════════════════════════════════════════════════════
// SECTION 5 — CANDLE READING (volume spikes, candle anatomy, RSI divergence)
// ════════════════════════════════════════════════════════════════════════

const candleReading = {
  /** Volume spike ratio vs the trailing 20-candle average. */
  volumeRatio(candles, n = 20) {
    if (candles.length < n + 1) return { ratio: 1, spike: false };
    const vols = candles.map((c) => c.volume);
    const avg = vols.slice(-n - 1, -1).reduce((a, b) => a + b, 0) / n;
    if (avg === 0) return { ratio: 1, spike: false };
    const last = vols[vols.length - 1];
    const ratio = round(last / avg, 2);
    return { ratio, spike: ratio > 2 };
  },

  /** Single-candle anatomy classification. */
  candlePattern(c) {
    const body = Math.abs(c.close - c.open), range = c.high - c.low;
    if (range === 0) return 'DOJI';
    if (body / range < 0.1) return 'DOJI';
    const upper = c.high - Math.max(c.open, c.close), lower = Math.min(c.open, c.close) - c.low;
    if (c.close > c.open) {
      if (lower > body * 2) return 'PIN_BAR_BULL';
      return 'BULL_CANDLE';
    } else {
      if (upper > body * 2) return 'PIN_BAR_BEAR';
      return 'BEAR_CANDLE';
    }
  },

  /** Price/RSI divergence detector over the trailing window. */
  rsiDivergence(candles, rsiArr) {
    if (candles.length < 10 || rsiArr.length < 10) return 'NONE';
    const n = Math.min(candles.length, rsiArr.length, 20);
    const pHigh = candles.slice(-n).map((c) => c.high);
    const pLow = candles.slice(-n).map((c) => c.low);
    const pR = rsiArr.slice(-n);
    const half = Math.floor(n / 2);
    const prevPriceHigh = Math.max(...pHigh.slice(0, half));
    const prevPriceLow = Math.min(...pLow.slice(0, half));
    const currPriceHigh = Math.max(...pHigh.slice(half));
    const currPriceLow = Math.min(...pLow.slice(half));
    const prevRsiHigh = Math.max(...pR.slice(0, half));
    const prevRsiLow = Math.min(...pR.slice(0, half));
    const currRsiHigh = Math.max(...pR.slice(half));
    const currRsiLow = Math.min(...pR.slice(half));
    if (currPriceHigh > prevPriceHigh && currRsiHigh < prevRsiHigh) return 'BEARISH_DIV';
    if (currPriceLow < prevPriceLow && currRsiLow > prevRsiLow) return 'BULLISH_DIV';
    return 'NONE';
  },
};

// ════════════════════════════════════════════════════════════════════════
// SECTION 6 — Macro context: BTC trend, Funding Rate, Open Interest
//             (faithful migration of the inline logic in /api/deep-analysis,
//              now cached so repeated tool calls don't re-hit Binance)
// ════════════════════════════════════════════════════════════════════════

async function getBtcTrendContext() {
  const cached = btcTrendCache.get('BTC');
  if (cached) return cached;
  try {
    const candles = await getCandles('BTCUSDT', '4h');
    const closes = candles.map((c) => c.close);
    const e20 = indicators.ema(closes, 20);
    const price = closes[closes.length - 1];
    const ema20Last = e20[e20.length - 1];
    const gapPct = (Math.abs(price - ema20Last) / ema20Last) * 100;
    const strengthPrefix = gapPct > 1.5 ? 'STRONG_' : '';
    const trend = price > ema20Last ? strengthPrefix + 'BULL' : strengthPrefix + 'BEAR';
    return btcTrendCache.set('BTC', { trend, price: round(price, 4), ema20: round(ema20Last, 4), gapPct: round(gapPct, 2) });
  } catch (e) {
    return { trend: 'UNKNOWN', price: null, ema20: null, gapPct: null, error: e.message };
  }
}

async function getFundingRateContext(symbol) {
  const cached = fundingCache.get(symbol);
  if (cached) return cached;
  try {
    const data = await fetchJSON(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`, { retries: 2, timeoutMs: 6000 });
    if (Array.isArray(data) && data.length) {
      const fundingRate = round(parseFloat(data[0].fundingRate) * 100, 4);
      const fundingBias = fundingRate > 0.01 ? 'LONGS_PAYING' : fundingRate < -0.01 ? 'SHORTS_PAYING' : 'NEUTRAL';
      return fundingCache.set(symbol, { fundingRate, fundingBias });
    }
  } catch (_) { /* perp may not exist for this symbol — degrade gracefully */ }
  return { fundingRate: null, fundingBias: 'NEUTRAL' };
}

async function getOpenInterestContext(symbol, h1Candles) {
  const cached = oiCache.get(symbol);
  if (cached) return cached;
  try {
    const [oiNow, oiHist] = await Promise.all([
      fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, { retries: 2, timeoutMs: 6000 }),
      fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=6`, { retries: 2, timeoutMs: 6000 }),
    ]);
    if (oiNow && oiNow.openInterest) {
      const oiCurrent = parseFloat(oiNow.openInterest);
      const oiTrend = Array.isArray(oiHist) && oiHist.length >= 2
        ? (parseFloat(oiHist[oiHist.length - 1].sumOpenInterest) > parseFloat(oiHist[0].sumOpenInterest) ? 'RISING' : 'FALLING')
        : 'UNKNOWN';
      const lastClose = h1Candles[h1Candles.length - 1].close;
      const prevClose = h1Candles[h1Candles.length - 7] ? h1Candles[h1Candles.length - 7].close : lastClose;
      const priceDir = lastClose > prevClose ? 'UP' : 'DOWN';
      const oiSignal =
        oiTrend === 'RISING' && priceDir === 'UP' ? 'BULLISH_CONTINUATION' :
        oiTrend === 'RISING' && priceDir === 'DOWN' ? 'BEARISH_CONTINUATION' :
        oiTrend === 'FALLING' && priceDir === 'UP' ? 'SHORT_SQUEEZE' :
        oiTrend === 'FALLING' && priceDir === 'DOWN' ? 'LONG_LIQUIDATION' :
        'NEUTRAL';
      return oiCache.set(symbol, { current: oiCurrent, trend: oiTrend, signal: oiSignal, priceDir });
    }
  } catch (_) { /* not all symbols have a futures market — degrade gracefully */ }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 7 — CRYPTO NEWS (brand new — multi-provider with free fallback)
// ════════════════════════════════════════════════════════════════════════
//  Provider chain, cheapest/most-available first when no key is configured:
//   1. CryptoCompare News API   — if CRYPTOCOMPARE_API_KEY is set (free key
//      available at cryptocompare.com — best structured per-coin tagging)
//   2. CryptoPanic               — if CRYPTOPANIC_API_KEY is set (CryptoPanic
//      retired its free tier in April 2026, so this is a paid-key option)
//   3. Free RSS fallback         — CoinDesk + Cointelegraph + Decrypt, no key
//      required at all, so the tool always works out of the box.
// ════════════════════════════════════════════════════════════════════════

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

const RSS_FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
];

// Common aliases so "BTC" also matches headlines that say "Bitcoin", etc.
const COIN_ALIASES = {
  BTC: ['Bitcoin'], ETH: ['Ethereum', 'Ether'], SOL: ['Solana'], XRP: ['Ripple'],
  BNB: ['Binance Coin', 'BNB'], ADA: ['Cardano'], DOGE: ['Dogecoin'], AVAX: ['Avalanche'],
  DOT: ['Polkadot'], LINK: ['Chainlink'], MATIC: ['Polygon'], POL: ['Polygon'], LTC: ['Litecoin'],
  TRX: ['Tron'], SHIB: ['Shiba Inu'], UNI: ['Uniswap'], ATOM: ['Cosmos'], XLM: ['Stellar'],
  NEAR: ['Near Protocol'], APT: ['Aptos'], ARB: ['Arbitrum'], OP: ['Optimism'], SUI: ['Sui'],
  INJ: ['Injective'], FIL: ['Filecoin'], ICP: ['Internet Computer'], ETC: ['Ethereum Classic'],
  BCH: ['Bitcoin Cash'], RENDER: ['Render'], TIA: ['Celestia'], SEI: ['Sei'], PEPE: ['Pepe'],
  WIF: ['dogwifhat'], BONK: ['Bonk'], ORDI: ['Ordinals'], RUNE: ['THORChain'], AAVE: ['Aave'],
  MKR: ['Maker', 'MakerDAO'], SAND: ['The Sandbox'], MANA: ['Decentraland'], AXS: ['Axie Infinity'],
  GALA: ['Gala'], ALGO: ['Algorand'], VET: ['VeChain'], HBAR: ['Hedera'], QNT: ['Quant'],
  IMX: ['Immutable'], GRT: ['The Graph'], FET: ['Fetch.ai'], TON: ['Toncoin', 'The Open Network'],
  KAS: ['Kaspa'], JUP: ['Jupiter'], PYTH: ['Pyth'], STRK: ['Starknet'], ENA: ['Ethena'],
  ONDO: ['Ondo'], ENS: ['Ethereum Name Service'],
};
function aliasesFor(coin) {
  const extra = COIN_ALIASES[coin] || [];
  return [coin, ...extra];
}

async function fetchRSSFeed(feedUrl, label) {
  try {
    const xmlText = await fetchText(feedUrl, { timeoutMs: 7000 });
    const parsed = xmlParser.parse(xmlText);
    const rawItems = (parsed && parsed.rss && parsed.rss.channel && parsed.rss.channel.item) || (parsed && parsed.feed && parsed.feed.entry) || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    return items
      .slice(0, 40)
      .map((it) => {
        const title = (it.title && it.title['#text']) || it.title || '';
        const link = (it.link && it.link['@_href']) || it.link || it.guid || '';
        const pub = it.pubDate || it.published || it.updated || null;
        return {
          title: title.toString().trim(),
          url: link.toString().trim(),
          source: label,
          publishedAt: pub ? new Date(pub).toISOString() : null,
        };
      })
      .filter((a) => a.title);
  } catch (e) {
    return []; // a single dead feed should never break the whole tool
  }
}

async function fetchCryptoCompareNews(apiKey) {
  const url = `https://min-api.cryptocompare.com/data/v2/news/?lang=EN&api_key=${apiKey}`;
  const data = await fetchJSON(url, { retries: 2, timeoutMs: 7000 });
  if (!data || !Array.isArray(data.Data)) return [];
  return data.Data.slice(0, 20).map((a) => ({
    title: a.title,
    url: a.url,
    source: (a.source_info && a.source_info.name) || a.source || 'CryptoCompare',
    publishedAt: a.published_on ? new Date(a.published_on * 1000).toISOString() : null,
    summary: (a.body || '').slice(0, 220),
  }));
}

async function fetchCryptoPanicNews(apiToken, currency) {
  const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${apiToken}${currency ? `&currencies=${currency}` : ''}&public=true`;
  const data = await fetchJSON(url, { retries: 2, timeoutMs: 7000 });
  if (!data || !Array.isArray(data.results)) return [];
  return data.results.slice(0, 20).map((p) => ({
    title: p.title,
    url: p.url,
    source: (p.source && p.source.title) || 'CryptoPanic',
    publishedAt: p.published_at || null,
    votes: p.votes || null,
  }));
}

/**
 * get_crypto_news — composed, tool-ready. symbol is OPTIONAL: omit it for
 * general market-wide headlines (handy for the Global AI Chat).
 */
async function getCryptoNews(symbolRaw) {
  const coin = symbolRaw ? symbolRaw.toString().toUpperCase().replace(/USDT$/, '').replace(/[^A-Z0-9]/g, '').trim() : '';
  const cacheKey = coin || '__GENERAL__';
  const cached = newsCache.get(cacheKey);
  if (cached) return cached;

  let articles = [];
  let provider = 'none';

  // 1) CryptoCompare (optional free key)
  if (process.env.CRYPTOCOMPARE_API_KEY) {
    try {
      let all = await fetchCryptoCompareNews(process.env.CRYPTOCOMPARE_API_KEY);
      if (coin) {
        const names = aliasesFor(coin).map((s) => s.toLowerCase());
        const filtered = all.filter((a) => names.some((n) => (a.title || '').toLowerCase().includes(n)));
        all = filtered.length ? filtered : all;
      }
      if (all.length) { articles = all; provider = 'cryptocompare'; }
    } catch (_) { /* fall through */ }
  }

  // 2) CryptoPanic (optional paid key)
  if (!articles.length && process.env.CRYPTOPANIC_API_KEY) {
    try {
      const all = await fetchCryptoPanicNews(process.env.CRYPTOPANIC_API_KEY, coin);
      if (all.length) { articles = all; provider = 'cryptopanic'; }
    } catch (_) { /* fall through */ }
  }

  // 3) Free RSS fallback — always available, zero configuration required
  if (!articles.length) {
    const feeds = await Promise.all(RSS_FEEDS.map((f) => fetchRSSFeed(f.url, f.name)));
    let merged = feeds.flat();
    const seen = new Set();
    merged = merged.filter((a) => { if (seen.has(a.title)) return false; seen.add(a.title); return true; });
    merged.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

    if (coin) {
      const names = aliasesFor(coin).map((s) => s.toLowerCase());
      const filtered = merged.filter((a) => names.some((n) => a.title.toLowerCase().includes(n)));
      provider = filtered.length ? 'rss-filtered' : 'rss-general';
      articles = filtered.length ? filtered : merged;
    } else {
      provider = 'rss-general';
      articles = merged;
    }
  }

  const result = {
    success: true,
    coin: coin || null,
    provider,
    articleCount: Math.min(articles.length, 8),
    articles: articles.slice(0, 8),
    fetchedAt: new Date().toISOString(),
    note: provider === 'rss-general' && coin
      ? `No ${coin}-specific headlines in the latest pull — showing general crypto market headlines instead.`
      : (provider === 'none' ? 'No news sources were reachable right now.' : undefined),
  };
  return newsCache.set(cacheKey, result);
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 8 — COMPOSED, TOOL-READY FUNCTIONS
//             These 5 are what ai_agent.js wraps as DynamicStructuredTools.
// ════════════════════════════════════════════════════════════════════════

const STABLECOINS = new Set(['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'BUSDUSDT', 'EURUSDT', 'DAIUSDT', 'USDPUSDT', 'AEURUSDT']);

/** scan_market() — top volatile/high-volume active coins. Same thresholds as
 *  the existing /api/scan route (≥$15M 24h volume, ≥100k trades, ±3% move),
 *  now cached for 30s and retried on failure. */
async function scanMarket() {
  const cached = scanCache.get('top');
  if (cached) return cached;

  const data = await fetchJSON('https://api.binance.com/api/v3/ticker/24hr', { retries: 2, timeoutMs: 10000 });
  const filtered = data
    .filter((c) => c.symbol.endsWith('USDT') && !STABLECOINS.has(c.symbol))
    .filter((c) => parseFloat(c.quoteVolume) >= 15_000_000 && parseInt(c.count, 10) >= 100_000)
    .filter((c) => { const ch = parseFloat(c.priceChangePercent); return ch >= 3 || ch <= -3; })
    .map((c) => ({
      symbol: c.symbol,
      change: round(parseFloat(c.priceChangePercent), 2),
      volume: round(parseFloat(c.quoteVolume), 0),
      price: parseFloat(c.lastPrice),
      trades: parseInt(c.count, 10),
    }));

  const byVolume = [...filtered].sort((a, b) => b.volume - a.volume).slice(0, 20);
  const topGainers = [...filtered].sort((a, b) => b.change - a.change).slice(0, 5);
  const topLosers = [...filtered].sort((a, b) => a.change - b.change).slice(0, 5);

  const result = {
    success: true,
    count: byVolume.length,
    generatedAt: new Date().toISOString(),
    coins: byVolume,
    topGainers,
    topLosers,
  };
  return scanCache.set('top', result);
}

/** get_live_price(symbol) */
async function getLivePriceSnapshot(symbolRaw) {
  const symbol = normalizePair(symbolRaw);
  if (!symbol) throw new Error('A valid coin symbol is required, e.g. "BTC" or "BTCUSDT".');
  const price = await getLivePrice(symbol);
  if (price == null) throw new Error(`Could not fetch a live price for ${symbol}. It may not be listed on Binance.`);
  return { success: true, symbol, price, fetchedAt: new Date().toISOString() };
}

function computeIndicatorBundle(candles) {
  const closes = candles.map((c) => c.close);
  const rsiArr = indicators.rsiSeries(closes);
  const last = candles[candles.length - 1];
  const e20 = indicators.ema(closes, 20), e50 = indicators.ema(closes, 50), e200 = indicators.ema(closes, 200);
  return {
    rsi: indicators.rsiValue(closes),
    rsiDivergence: candleReading.rsiDivergence(candles.slice(-20), rsiArr.slice(-20)),
    macd: indicators.macd(closes),
    ema: { ema20: round(e20[e20.length - 1], 6), ema50: round(e50[e50.length - 1], 6), ema200: round(e200[e200.length - 1], 6) },
    bollingerBands: indicators.bollingerBands(closes),
    atr: indicators.atr(candles),
    adx: indicators.adx(candles),
    structure: structure.detectStructure(candles),
    candlePattern: candleReading.candlePattern(last),
    volume: candleReading.volumeRatio(candles),
    lastClose: round(last.close, 6),
  };
}

/** get_technical_indicators(symbol, timeframe) — timeframe defaults to
 *  'multi' which returns the full 15m/1h/4h/1d confluence bundle in ONE
 *  call (cheapest for the agent); pass a specific timeframe for a lighter,
 *  faster single-timeframe answer. */
async function getTechnicalIndicators(symbolRaw, timeframe) {
  const symbol = normalizePair(symbolRaw);
  if (!symbol) throw new Error('A valid coin symbol is required, e.g. "BTC" or "SOLUSDT".');
  const tf = (timeframe || 'multi').toString().toLowerCase();
  const VALID = ['15m', '1h', '4h', '1d', 'multi'];
  if (!VALID.includes(tf)) throw new Error(`Invalid timeframe "${timeframe}". Use one of: 15m, 1h, 4h, 1d, multi.`);

  if (tf === 'multi') {
    const [c15, c1h, c4h, c1d] = await Promise.all([
      getCandles(symbol, '15m'), getCandles(symbol, '1h'), getCandles(symbol, '4h'), getCandles(symbol, '1d'),
    ]);
    return {
      success: true,
      symbol,
      timeframe: 'multi',
      timeframes: {
        '15m': computeIndicatorBundle(c15),
        '1h': computeIndicatorBundle(c1h),
        '4h': computeIndicatorBundle(c4h),
        '1d': computeIndicatorBundle(c1d),
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  const candles = await getCandles(symbol, tf);
  return { success: true, symbol, timeframe: tf, data: computeIndicatorBundle(candles), fetchedAt: new Date().toISOString() };
}

/** get_market_structure(symbol) — S/R, Order Blocks, FVGs, Fibonacci,
 *  Open Interest, Funding Rate and the BTC macro trend, all in one call. */
async function getMarketStructure(symbolRaw) {
  const symbol = normalizePair(symbolRaw);
  if (!symbol) throw new Error('A valid coin symbol is required, e.g. "BTC" or "ETHUSDT".');

  const [c15, c1h, c4h, c1d, btcTrend] = await Promise.all([
    getCandles(symbol, '15m'), getCandles(symbol, '1h'), getCandles(symbol, '4h'), getCandles(symbol, '1d'), getBtcTrendContext(),
  ]);
  const [fundingRate, openInterest] = await Promise.all([
    getFundingRateContext(symbol),
    getOpenInterestContext(symbol, c1h),
  ]);

  return {
    success: true,
    symbol,
    btcTrend,
    fundingRate,
    openInterest,
    supportResistance: { h4: structure.findSupportResistanceLevels(c4h), d1: structure.findSupportResistanceLevels(c1d) },
    orderBlocks: { h4: structure.findOrderBlocks(c4h, 5), d1: structure.findOrderBlocks(c1d, 5), h1: structure.findOrderBlocks(c1h, 3) },
    fairValueGaps: { h4: structure.findFairValueGaps(c4h), h1: structure.findFairValueGaps(c1h), m15: structure.findFairValueGaps(c15) },
    fibonacci: { h4: structure.fibonacciRetracement(c4h), d1: structure.fibonacciRetracement(c1d) },
    fetchedAt: new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════════════════

module.exports = {
  // ── The 5 AI-tool-ready functions (what ai_agent.js wraps) ──
  scanMarket,
  getLivePriceSnapshot,
  getTechnicalIndicators,
  getMarketStructure,
  getCryptoNews,

  // ── Lower-level building blocks (exported for completeness, reuse,
  //    unit testing, or a future opt-in refactor of server.js) ──
  indicators,
  structure,
  candleReading,
  data: {
    fetchKlinesCached,
    getCandles,
    getLivePrice,
    normalizePair,
    sanitizeCandles,
    getBtcTrendContext,
    getFundingRateContext,
    getOpenInterestContext,
  },
  infra: { TTLCache, Semaphore, fetchJSON, fetchText, round },
};
