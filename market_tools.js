'use strict';
// ============================================================
//  market_tools.js — LangChain Tool Definitions v2.1
//  InvestySignals AI Agent
//
//  Tools:
//  [1] get_live_price          — Real-time Binance price + 24h stats
//  [2] get_technical_indicators — RSI, MACD, EMA, BB, ATR, ADX,
//                                 Volume Spike, Candle Pattern,
//                                 Prev Day H/L  ← RESTORED
//  [3] get_order_blocks        — OBs, FVGs, Fibonacci, S/R
//  [4] get_market_structure    — BOS/CHoCH multi-TF + BTC context
//                                + Early Warning System  ← RESTORED
//  [5] get_funding_and_oi      — Funding, OI, L/S ratio,
//                                OI History Trend  ← RESTORED
// ============================================================

const { DynamicStructuredTool } = require('@langchain/core/tools');
const { z }                      = require('zod');
const NodeCache                  = require('node-cache');

// ── Cache layers ──────────────────────────────────────────────
const priceCache  = new NodeCache({ stdTTL: 15  });
const klinesCache = new NodeCache({ stdTTL: 180 });
const fundCache   = new NodeCache({ stdTTL: 60  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
//  BINANCE API HELPERS
// ============================================================

/** fetch() with exponential-backoff retry + 8s timeout */
async function fetchWithRetry(url, retries = 3, baseDelayMs = 600) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(tid);
      if (res.status === 429) {
        const after = parseInt(res.headers.get('Retry-After') || '1', 10) * 1000;
        await sleep(Math.max(after, baseDelayMs * 2 ** attempt));
        continue;
      }
      if (res.status === 400) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`Binance 400: ${body.msg || 'bad request'}`);
      }
      if (!res.ok) throw new Error(`Binance ${res.status}: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      clearTimeout(tid);
      lastErr = err.name === 'AbortError' ? new Error('Binance timeout (>8s)') : err;
      if (attempt < retries - 1) await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** Fetch klines — Futures first, Spot fallback. Cached 3min */
async function fetchKlines(symbol, interval, limit = 200) {
  const key    = `${symbol}:${interval}:${limit}`;
  const cached = klinesCache.get(key);
  if (cached) return cached;

  const endpoints = [
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  ];

  for (const url of endpoints) {
    try {
      const raw = await fetchWithRetry(url);
      if (!Array.isArray(raw) || raw.length < 10) continue;
      const candles = raw.map((k) => ({
        openTime: k[0],
        open:    parseFloat(k[1]),
        high:    parseFloat(k[2]),
        low:     parseFloat(k[3]),
        close:   parseFloat(k[4]),
        volume:  parseFloat(k[5]),
      })).filter((c) => c.close > 0 && !isNaN(c.close));
      klinesCache.set(key, candles);
      return candles;
    } catch (e) {
      if (url === endpoints[endpoints.length - 1]) throw e;
    }
  }
  throw new Error(`No kline data for ${symbol} ${interval}`);
}

/** USDT-suffix normalizer */
function normalizeSymbol(raw) {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.endsWith('USDT') ? s : s + 'USDT';
}

// ============================================================
//  INDICATOR MATH
// ============================================================

/** Wilder's RSI — single value */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 2) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (ag === 0 && al === 0) return 50;
  if (al === 0) return 100;
  return parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));
}

/** RSI as array (for divergence) */
function calcRSIArray(closes, period = 14) {
  const out = [];
  if (closes.length < period + 2) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  let ag = g / period, al = l / period;
  const push = () => {
    if (ag === 0 && al === 0) return out.push(50);
    if (al === 0) return out.push(100);
    out.push(parseFloat((100 - 100 / (1 + ag / al)).toFixed(2)));
  };
  push();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    push();
  }
  return out;
}

/** EMA array */
function calcEMAArray(values, period) {
  if (values.length < period) return [];
  const k   = 2 / (period + 1);
  let   ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [ema];
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

/** EMA — current single value */
function calcEMA(values, period) {
  const arr = calcEMAArray(values, period);
  return arr.length ? parseFloat(arr[arr.length - 1].toFixed(4)) : null;
}

/** MACD 12/26/9 */
function calcMACD(closes) {
  const e12 = calcEMAArray(closes, 12);
  const e26 = calcEMAArray(closes, 26);
  if (!e12.length || !e26.length) return null;
  const len  = Math.min(e12.length, e26.length);
  const ml   = Array.from({ length: len }, (_, i) => e12[e12.length - len + i] - e26[e26.length - len + i]);
  const sig9 = calcEMAArray(ml, 9);
  if (!sig9.length) return null;
  const hist  = ml[ml.length - 1] - sig9[sig9.length - 1];
  const pHist = ml.length > 1 && sig9.length > 1 ? ml[ml.length - 2] - sig9[sig9.length - 2] : 0;
  return {
    macd:          parseFloat(ml[ml.length - 1].toFixed(6)),
    signal:        parseFloat(sig9[sig9.length - 1].toFixed(6)),
    histogram:     parseFloat(hist.toFixed(6)),
    prevHistogram: parseFloat(pHist.toFixed(6)),
    trend: hist > 0
      ? (hist > pHist ? 'BULLISH_INCREASING' : 'BULLISH_DECREASING')
      : (hist < pHist ? 'BEARISH_INCREASING' : 'BEARISH_DECREASING'),
  };
}

/** Bollinger Bands 20/2 with %B and squeeze */
function calcBB(closes, period = 20) {
  const sl   = closes.slice(-period);
  if (sl.length < period) return null;
  const mean = sl.reduce((a, b) => a + b, 0) / period;
  const std  = Math.sqrt(sl.reduce((a, c) => a + (c - mean) ** 2, 0) / period);
  const bw   = parseFloat(((4 * std) / mean * 100).toFixed(2));
  const price = closes[closes.length - 1];
  const pctB = parseFloat(((price - (mean - 2 * std)) / (4 * std) * 100).toFixed(1));
  return {
    upper:     parseFloat((mean + 2 * std).toFixed(4)),
    middle:    parseFloat(mean.toFixed(4)),
    lower:     parseFloat((mean - 2 * std).toFixed(4)),
    bandwidth: bw,
    pctB,
    squeeze:   bw < 3 ? 'TIGHT' : bw < 6 ? 'NORMAL' : 'EXPANDING',
  };
}

/** ATR (Wilder's) */
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = candles.slice(1).map((c, i) =>
    Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close))
  );
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return parseFloat(atr.toFixed(6));
}

/** Full Wilder ADX with +DI / -DI */
function calcADX(candles, period = 14) {
  const empty = { adx: 0, plusDI: 0, minusDI: 0, trend: 'RANGING', strength: 'WEAK' };
  if (candles.length < period * 2 + 1) return empty;
  const trArr = [], pDM = [], mDM = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const hd = c.high - p.high, ld = p.low - c.low;
    trArr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    pDM.push(hd > 0 && hd > ld ? hd : 0);
    mDM.push(ld > 0 && ld > hd ? ld : 0);
  }
  function ws(arr, p) {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const o = [s];
    for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; o.push(s); }
    return o;
  }
  const sTR = ws(trArr, period), sPDM = ws(pDM, period), sMDM = ws(mDM, period);
  const dx  = sTR.map((tr, i) => {
    if (!tr) return 0;
    const pd = 100 * sPDM[i] / tr, md = 100 * sMDM[i] / tr;
    return Math.abs(pd - md) / ((pd + md) || 1) * 100;
  });
  const adxArr = ws(dx, period);
  const adxVal = parseFloat((adxArr[adxArr.length - 1] / period).toFixed(2));
  const lTR    = sTR[sTR.length - 1];
  const pdi    = lTR ? parseFloat((100 * sPDM[sPDM.length - 1] / lTR).toFixed(2)) : 0;
  const mdi    = lTR ? parseFloat((100 * sMDM[sMDM.length - 1] / lTR).toFixed(2)) : 0;
  return {
    adx:      adxVal,
    plusDI:   pdi,
    minusDI:  mdi,
    trend:    adxVal > 25 ? (pdi > mdi ? 'TRENDING_BULL' : 'TRENDING_BEAR') : 'RANGING',
    strength: adxVal > 50 ? 'VERY_STRONG' : adxVal > 35 ? 'STRONG' : adxVal > 25 ? 'MODERATE' : 'WEAK',
  };
}

/** ── RESTORED: Volume ratio vs 20-bar average ── */
function calcVolRatio(candles, n = 20) {
  if (candles.length < n + 1) return { ratio: 1, spike: false };
  const avg  = candles.slice(-n - 1, -1).reduce((a, c) => a + c.volume, 0) / n;
  if (avg === 0) return { ratio: 1, spike: false };
  const last  = candles[candles.length - 1].volume;
  const ratio = parseFloat((last / avg).toFixed(2));
  return { ratio, spike: ratio > 2 };
}

/** ── RESTORED: Candle pattern detection ── */
function calcCandlePattern(c) {
  const body  = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0) return 'DOJI';
  if (body / range < 0.1) return 'DOJI';
  const upper = c.high  - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  if (c.close > c.open) {
    if (lower > body * 2) return 'PIN_BAR_BULL';
    return 'BULL_CANDLE';
  } else {
    if (upper > body * 2) return 'PIN_BAR_BEAR';
    return 'BEAR_CANDLE';
  }
}

/** RSI divergence */
function calcDivergence(candles, rsiArr) {
  if (candles.length < 12 || rsiArr.length < 12) return 'NONE';
  const n    = Math.min(candles.length, rsiArr.length, 20);
  const half = Math.floor(n / 2);
  const phH  = Math.max(...candles.slice(-n, -half).map((c) => c.high));
  const plL  = Math.min(...candles.slice(-n, -half).map((c) => c.low));
  const chH  = Math.max(...candles.slice(-half).map((c) => c.high));
  const clL  = Math.min(...candles.slice(-half).map((c) => c.low));
  const prH  = Math.max(...rsiArr.slice(-n, -half));
  const prL  = Math.min(...rsiArr.slice(-n, -half));
  const crH  = Math.max(...rsiArr.slice(-half));
  const crL  = Math.min(...rsiArr.slice(-half));
  if (chH > phH && crH < prH) return 'BEARISH_DIV';
  if (clL < plL && crL > prL) return 'BULLISH_DIV';
  return 'NONE';
}

/** Pivot S/R levels */
function calcSRLevels(candles, n = 5) {
  const price  = candles[candles.length - 1].close;
  const pivots = [];
  for (let i = n; i < candles.length - n; i++) {
    const w = candles.slice(i - n, i + n + 1);
    if (candles[i].high === Math.max(...w.map((c) => c.high))) pivots.push(candles[i].high);
    if (candles[i].low  === Math.min(...w.map((c) => c.low)))  pivots.push(candles[i].low);
  }
  const unique = [...new Set(pivots.map((p) => parseFloat(p.toFixed(4))))].sort((a, b) => a - b);
  return [
    ...unique.filter((p) => p <= price).slice(-4),
    ...unique.filter((p) => p > price).slice(0, 4),
  ].sort((a, b) => a - b);
}

/** Fibonacci retracement */
function calcFibonacci(candles, lookback = 60) {
  const rc   = candles.slice(-lookback);
  const swH  = Math.max(...rc.map((c) => c.high));
  const swL  = Math.min(...rc.map((c) => c.low));
  const rng  = swH - swL;
  if (rng === 0) return null;
  const last = candles[candles.length - 1].close;
  const bull = last > swL + rng * 0.5;
  const lev  = (r) => bull ? swH - rng * r : swL + rng * r;
  const fmt  = (v) => parseFloat(v.toFixed(4));
  return {
    direction: bull ? 'BULLISH_RETRACE' : 'BEARISH_RETRACE',
    swingHigh: fmt(swH), swingLow: fmt(swL),
    f236: fmt(lev(0.236)), f382: fmt(lev(0.382)),
    f500: fmt(lev(0.500)), f618: fmt(lev(0.618)),
    f786: fmt(lev(0.786)),
  };
}

/** Unmitigated Fair Value Gaps */
function calcFVGs(candles) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const p = candles[i - 2], c = candles[i];
    if (c.low > p.high) {
      if (!candles.slice(i + 1).some((x) => x.low < c.low))
        fvgs.push({ type: 'BULL', low: parseFloat(p.high.toFixed(4)), high: parseFloat(c.low.toFixed(4)) });
    } else if (c.high < p.low) {
      if (!candles.slice(i + 1).some((x) => x.high > c.high))
        fvgs.push({ type: 'BEAR', low: parseFloat(c.high.toFixed(4)), high: parseFloat(p.low.toFixed(4)) });
    }
  }
  return fvgs.slice(-5);
}

/** BOS/CHoCH detection */
function detectStructure(candles) {
  if (candles.length < 20) return 'INSUFFICIENT_DATA';
  const rc   = candles.slice(-20);
  const half = Math.floor(rc.length / 2);
  const prev = rc.slice(0, half), curr = rc.slice(half);
  const phH  = Math.max(...prev.map((c) => c.high));
  const plL  = Math.min(...prev.map((c) => c.low));
  const chH  = Math.max(...curr.map((c) => c.high));
  const clL  = Math.min(...curr.map((c) => c.low));
  const last = candles[candles.length - 1].close;
  if (last > phH && chH > phH) return 'BOS_BULLISH';
  if (last < plL && clL < plL) return 'BOS_BEARISH';
  if (chH > phH) return 'CHOCH_BULLISH';
  if (clL < plL) return 'CHOCH_BEARISH';
  return 'NEUTRAL';
}

/** Institutional Order Blocks */
function findOrderBlocks(candles, maxCount = 6) {
  const last    = candles[candles.length - 1].close;
  const avgBody = candles.slice(-30).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 30;
  const minImp  = avgBody * 0.5;
  const obs     = [];
  const fmt     = (v) => parseFloat(v.toFixed(4));

  for (let i = candles.length - 4; i >= 1; i--) {
    if (obs.length >= maxCount) break;
    const ob = candles[i], nx = candles[i + 1];
    if (Math.abs(nx.close - nx.open) < minImp) continue;

    if (ob.close < ob.open && nx.close > nx.open && nx.close > ob.high && last > ob.low) {
      if (!candles.slice(i + 2).some((c) => c.close < ob.low))
        obs.push({ type: 'BULL_OB', low: fmt(ob.low), high: fmt(ob.high),
          bodyLow: fmt(Math.min(ob.open, ob.close)), bodyHigh: fmt(Math.max(ob.open, ob.close)),
          distancePct: parseFloat(((last - ob.high) / ob.high * 100).toFixed(2)) });
    }
    if (ob.close > ob.open && nx.close < nx.open && nx.close < ob.low && last < ob.high) {
      if (!candles.slice(i + 2).some((c) => c.close > ob.high))
        obs.push({ type: 'BEAR_OB', low: fmt(ob.low), high: fmt(ob.high),
          bodyLow: fmt(Math.min(ob.open, ob.close)), bodyHigh: fmt(Math.max(ob.open, ob.close)),
          distancePct: parseFloat(((ob.low - last) / last * 100).toFixed(2)) });
    }
  }
  return obs;
}

// ============================================================
//  TOOL 1 — get_live_price
// ============================================================
const getLivePriceTool = new DynamicStructuredTool({
  name: 'get_live_price',
  description: 'Fetches real-time price from Binance (Futures→Spot fallback). ALWAYS call this FIRST. Returns price, 24h change, volume.',
  schema: z.object({
    symbol: z.string().describe('Trading pair UPPERCASE — e.g. BTCUSDT, ETHUSDT'),
  }),
  func: async ({ symbol }) => {
    const sym    = normalizeSymbol(symbol);
    const cached = priceCache.get(sym);
    if (cached) return JSON.stringify({ ...cached, cached: true });

    try {
      let price = null, source = '';
      try {
        const d = await fetchWithRetry(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`);
        price  = parseFloat(d.price); source = 'binance_futures';
      } catch {
        const d = await fetchWithRetry(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
        price  = parseFloat(d.price); source = 'binance_spot';
      }
      if (!price || isNaN(price)) throw new Error(`Invalid price for ${sym}`);

      let change24h = null, volume24h = null;
      try {
        const s  = await fetchWithRetry(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`);
        change24h = parseFloat(s.priceChangePercent);
        volume24h = parseFloat(s.quoteVolume);
      } catch { /* non-critical */ }

      const result = { symbol: sym, price,
        change24h: change24h != null ? `${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%` : 'N/A',
        volume24hUSDT: volume24h ? parseFloat(volume24h.toFixed(0)) : null,
        source, timestamp: new Date().toISOString() };
      priceCache.set(sym, result);
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ error: `Price fetch failed for ${sym}: ${err.message}` });
    }
  },
});

// ============================================================
//  TOOL 2 — get_technical_indicators  (RESTORED: volRatio, candlePattern, prevDayHL)
// ============================================================
const getTechnicalIndicatorsTool = new DynamicStructuredTool({
  name: 'get_technical_indicators',
  description:
    'Calculates RSI, MACD, EMA (20/50/200), Bollinger Bands, ATR, ADX, ' +
    'Volume Spike, Candle Pattern, and Previous Day High/Low. ' +
    'Call for each timeframe: 15m, 1h, 4h, 1d.',
  schema: z.object({
    symbol:    z.string().describe('Trading pair — e.g. BTCUSDT'),
    timeframe: z.enum(['1m','5m','15m','30m','1h','2h','4h','6h','12h','1d','1w'])
      .describe('Timeframe. Use 1d macro, 4h structure, 1h momentum, 15m entry.'),
  }),
  func: async ({ symbol, timeframe }) => {
    const sym = normalizeSymbol(symbol);
    try {
      const candles = await fetchKlines(sym, timeframe, 250);
      const closes  = candles.map((c) => c.close);
      if (closes.length < 35) throw new Error(`Only ${closes.length} candles — need ≥35`);

      const rsiArr  = calcRSIArray(closes);
      const rsi     = rsiArr[rsiArr.length - 1] ?? 50;
      const macd    = calcMACD(closes);
      const bb      = calcBB(closes);
      const ema20   = calcEMA(closes, 20);
      const ema50   = calcEMA(closes, 50);
      const ema200  = calcEMA(closes, 200);
      const atr     = calcATR(candles);
      const adx     = calcADX(candles);
      const div     = calcDivergence(candles, rsiArr);
      const sr      = calcSRLevels(candles);
      const fvgs    = calcFVGs(candles);
      const price   = closes[closes.length - 1];

      // ── RESTORED: Volume Spike ────────────────────────────
      const volRatio = calcVolRatio(candles);

      // ── RESTORED: Candle Pattern ──────────────────────────
      const lastCandle    = candles[candles.length - 1];
      const candlePattern = calcCandlePattern(lastCandle);

      // ── RESTORED: Previous Day High/Low ──────────────────
      let prevDayHL = null;
      if (['1h', '4h', '1d'].includes(timeframe)) {
        try {
          const d1c = await fetchKlines(sym, '1d', 3);
          if (d1c.length >= 2) {
            const pd = d1c[d1c.length - 2];
            prevDayHL = {
              high: parseFloat(pd.high.toFixed(4)),
              low:  parseFloat(pd.low.toFixed(4)),
            };
          }
        } catch { /* non-critical */ }
      }

      const emaStack =
        ema200 && ema50 && ema20
          ? price > ema20 && ema20 > ema50 && ema50 > ema200 ? 'FULL_BULL_STACK'
          : price < ema20 && ema20 < ema50 && ema50 < ema200 ? 'FULL_BEAR_STACK'
          : price > ema200 ? 'ABOVE_200_MIXED' : 'BELOW_200_MIXED'
          : 'INSUFFICIENT_HISTORY';

      const rsiZone =
        rsi >= 70 ? 'OVERBOUGHT' :
        rsi <= 30 ? 'OVERSOLD'   :
        rsi >= 55 ? 'BULLISH'    :
        rsi <= 45 ? 'BEARISH'    : 'NEUTRAL';

      return JSON.stringify({
        symbol: sym, timeframe,
        price:  parseFloat(price.toFixed(4)),
        rsi, rsiZone, rsiDivergence: div,
        macd,
        ema: { ema20, ema50, ema200, stack: emaStack },
        bollingerBands: bb,
        atr: parseFloat(atr.toFixed(4)),
        adx,
        fvgs: fvgs.slice(-3),
        srLevels: sr,
        // RESTORED features
        volumeRatio:    volRatio,
        candlePattern,
        prevDayHL,
        lastCandle: {
          open:   parseFloat(lastCandle.open.toFixed(4)),
          high:   parseFloat(lastCandle.high.toFixed(4)),
          low:    parseFloat(lastCandle.low.toFixed(4)),
          close:  parseFloat(lastCandle.close.toFixed(4)),
          volume: parseFloat(lastCandle.volume.toFixed(2)),
        },
        sampleSize: closes.length,
      });
    } catch (err) {
      return JSON.stringify({ error: `Indicator error (${sym} ${timeframe}): ${err.message}` });
    }
  },
});

// ============================================================
//  TOOL 3 — get_order_blocks
// ============================================================
const getOrderBlocksTool = new DynamicStructuredTool({
  name: 'get_order_blocks',
  description:
    'Identifies institutional Order Blocks (supply/demand zones), Fair Value Gaps, ' +
    'Fibonacci retracement levels, and S/R clusters. Use 4h and 1d timeframes.',
  schema: z.object({
    symbol:    z.string().describe('Trading pair — e.g. BTCUSDT'),
    timeframe: z.enum(['1h','2h','4h','6h','12h','1d','1w'])
      .describe('Timeframe. 4h and 1d are most reliable.'),
  }),
  func: async ({ symbol, timeframe }) => {
    const sym = normalizeSymbol(symbol);
    try {
      const candles  = await fetchKlines(sym, timeframe, 200);
      const price    = candles[candles.length - 1].close;
      const obs      = findOrderBlocks(candles, 6);
      const fvgs     = calcFVGs(candles);
      const fib      = calcFibonacci(candles, 60);
      const sr       = calcSRLevels(candles, 5);
      const atr      = calcATR(candles);

      const label = (ob) => ({ ...ob,
        position: price >= ob.low && price <= ob.high ? 'PRICE_INSIDE_OB'
          : price > ob.high ? 'OB_BELOW_PRICE' : 'OB_ABOVE_PRICE' });

      const bullOBs = obs.filter((o) => o.type === 'BULL_OB').map(label);
      const bearOBs = obs.filter((o) => o.type === 'BEAR_OB').map(label);
      const nearestBull = bullOBs.filter((o) => o.position === 'OB_BELOW_PRICE').sort((a, b) => b.high - a.high)[0] || null;
      const nearestBear = bearOBs.filter((o) => o.position === 'OB_ABOVE_PRICE').sort((a, b) => a.low - b.low)[0] || null;

      return JSON.stringify({
        symbol: sym, timeframe,
        currentPrice: parseFloat(price.toFixed(4)),
        atr: parseFloat(atr.toFixed(4)),
        bullishOrderBlocks: bullOBs,
        bearishOrderBlocks: bearOBs,
        nearestBullOB: nearestBull,
        nearestBearOB: nearestBear,
        fairValueGaps: fvgs,
        fibonacci: fib,
        supportResistance: sr,
        summary: `${bullOBs.length} bull OBs | ${bearOBs.length} bear OBs | ${fvgs.length} FVGs on ${timeframe}`,
      });
    } catch (err) {
      return JSON.stringify({ error: `OB detection failed (${sym} ${timeframe}): ${err.message}` });
    }
  },
});

// ============================================================
//  TOOL 4 — get_market_structure
//  RESTORED: BTC Correlation + Early Warning System
// ============================================================
const getMarketStructureTool = new DynamicStructuredTool({
  name: 'get_market_structure',
  description:
    'Analyzes market structure: BOS/CHoCH on 15m/1h/4h/1d. ' +
    'Also returns BTC 4H trend correlation and Early Warning System ' +
    '(M15 vs H4 conflicts — precursor signals before HTF confirms). ' +
    'Critical for trade direction.',
  schema: z.object({
    symbol: z.string().describe('Trading pair — e.g. BTCUSDT'),
  }),
  func: async ({ symbol }) => {
    const sym = normalizeSymbol(symbol);
    try {
      // Fetch all TFs + BTC 4H in parallel
      const [m15c, h1c, h4c, d1c, btcH4] = await Promise.all([
        fetchKlines(sym,       '15m', 100),
        fetchKlines(sym,       '1h',  150),
        fetchKlines(sym,       '4h',  150),
        fetchKlines(sym,       '1d',  100),
        fetchKlines('BTCUSDT', '4h',   50),
      ]);

      const price = d1c[d1c.length - 1].close;

      const structs = {
        '15m': detectStructure(m15c),
        '1h':  detectStructure(h1c),
        '4h':  detectStructure(h4c),
        '1d':  detectStructure(d1c),
      };
      const adx4h = calcADX(h4c);
      const adx1d = calcADX(d1c);

      // Bias count
      const vals  = Object.values(structs);
      const nBull = vals.filter((v) => v.includes('BULLISH')).length;
      const nBear = vals.filter((v) => v.includes('BEARISH')).length;
      const overallBias =
        nBull >= 3 ? 'STRONG_BULLISH' :
        nBull === 2 ? 'BULLISH' :
        nBear >= 3 ? 'STRONG_BEARISH' :
        nBear === 2 ? 'BEARISH' : 'NEUTRAL';

      // HTF/LTF conflict
      const htfBull  = structs['4h'].includes('BULLISH') || structs['1d'].includes('BULLISH');
      const htfBear  = structs['4h'].includes('BEARISH') || structs['1d'].includes('BEARISH');
      const ltfBull  = structs['1h'].includes('BULLISH') || structs['15m'].includes('BULLISH');
      const ltfBear  = structs['1h'].includes('BEARISH') || structs['15m'].includes('BEARISH');
      const conflict = (htfBull && ltfBear) || (htfBear && ltfBull);

      // Premium/Discount zone
      const h4Fib = calcFibonacci(h4c, 60);
      const zone  = h4Fib
        ? price < h4Fib.f500 ? 'DISCOUNT (below 50% fib — long bias)' : 'PREMIUM (above 50% fib — short bias)'
        : 'UNKNOWN';

      // ── RESTORED: BTC Correlation ─────────────────────────────
      const btcCloses  = btcH4.map((c) => c.close);
      const btcPrice   = btcCloses[btcCloses.length - 1];
      const btcEma20   = calcEMA(btcCloses, 20);
      const btcGapPct  = Math.abs(btcPrice - btcEma20) / btcEma20 * 100;
      const btcStrength = btcGapPct > 1.5 ? 'STRONG_' : '';
      const btcTrend   = btcPrice > btcEma20 ? btcStrength + 'BULL' : btcStrength + 'BEAR';

      // ── RESTORED: Early Warning System ───────────────────────
      const m15closes = m15c.map((c) => c.close);
      const h1closes  = h1c.map((c) => c.close);

      const m15RSI     = calcRSI(m15closes);
      const h4RSI      = calcRSI(h4c.map((c) => c.close));
      const m15rsiArr  = calcRSIArray(m15closes);
      const h1rsiArr   = calcRSIArray(h1closes);
      const m15Div     = calcDivergence(m15c, m15rsiArr);
      const h1Div      = calcDivergence(h1c, h1rsiArr);
      const m15MACD    = calcMACD(m15closes);
      const m15Vol     = calcVolRatio(m15c);
      const h4StructV  = structs['4h'];
      const h1StructV  = structs['1h'];
      const m15StructV = structs['15m'];

      const earlyWarnings = [];

      if (m15RSI > 70 && h4RSI < 70 && h4StructV === 'BOS_BULLISH')
        earlyWarnings.push(`M15 RSI overbought (${m15RSI}) while 4H still bullish — possible short-term top`);
      if (m15RSI < 30 && h4RSI > 30 && h4StructV === 'BOS_BEARISH')
        earlyWarnings.push(`M15 RSI oversold (${m15RSI}) while 4H still bearish — possible short-term bounce`);
      if (m15Div === 'BEARISH_DIV' && h1StructV === 'BOS_BULLISH')
        earlyWarnings.push('M15 bearish RSI divergence vs H1 bullish structure — watch for H1 CHoCH');
      if (m15Div === 'BULLISH_DIV' && h1StructV === 'BOS_BEARISH')
        earlyWarnings.push('M15 bullish RSI divergence vs H1 bearish structure — possible H1 reversal');
      if (m15MACD && m15MACD.histogram < 0 && m15MACD.prevHistogram > 0 && h4StructV === 'BOS_BULLISH')
        earlyWarnings.push('M15 MACD just crossed bearish — early warning, 4H still bullish');
      if (m15MACD && m15MACD.histogram > 0 && m15MACD.prevHistogram < 0 && h4StructV === 'BOS_BEARISH')
        earlyWarnings.push('M15 MACD crossed bullish — possible reversal, 4H still bearish');
      if (m15Vol.spike && m15StructV === 'BOS_BEARISH' && h4StructV === 'BOS_BULLISH')
        earlyWarnings.push(`Volume spike (${m15Vol.ratio}×) on M15 bearish move vs 4H bullish — possible distribution`);

      return JSON.stringify({
        symbol: sym,
        currentPrice: parseFloat(price.toFixed(4)),
        structures: structs,
        overallBias,
        priceZone: zone,
        timeframeAlignment: conflict ? 'CONFLICT_DETECTED' : 'ALIGNED',
        htfBias: htfBull ? 'BULLISH' : htfBear ? 'BEARISH' : 'NEUTRAL',
        ltfBias: ltfBull ? 'BULLISH' : ltfBear ? 'BEARISH' : 'NEUTRAL',
        adx: { '4h': adx4h, '1d': adx1d },
        marketCondition: adx4h.adx > 25 ? `TRENDING (ADX ${adx4h.adx})` : `RANGING (ADX ${adx4h.adx})`,
        // RESTORED
        btcTrend,
        btcPrice,
        btcEma20,
        earlyWarnings,
        earlyWarningsCount: earlyWarnings.length,
        interpretation:
          `${overallBias} bias. BTC: ${btcTrend}. ` +
          (conflict ? `⚠️ CONFLICT: HTF ${htfBull ? 'bullish' : 'bearish'} vs LTF ${ltfBull ? 'bullish' : 'bearish'}. Wait for alignment.` : 'TFs aligned.') +
          (earlyWarnings.length ? ` EARLY WARNINGS: ${earlyWarnings.join(' | ')}` : ''),
      });
    } catch (err) {
      return JSON.stringify({ error: `Structure analysis failed for ${sym}: ${err.message}` });
    }
  },
});

// ============================================================
//  TOOL 5 — get_funding_and_oi
//  RESTORED: OI History trend (RISING/FALLING + full signal interpretation)
// ============================================================
const getFundingAndOITool = new DynamicStructuredTool({
  name: 'get_funding_and_oi',
  description:
    'Fetches Binance Futures funding rate, open interest, OI history trend (6-bar), ' +
    'and long/short ratio. Detects squeeze risk and OI signal ' +
    '(BULLISH_CONTINUATION / SHORT_SQUEEZE / LONG_LIQUIDATION / BEARISH_CONTINUATION).',
  schema: z.object({
    symbol: z.string().describe('Futures pair — e.g. BTCUSDT'),
  }),
  func: async ({ symbol }) => {
    const sym    = normalizeSymbol(symbol);
    const cached = fundCache.get(sym);
    if (cached) return JSON.stringify({ ...cached, cached: true });

    try {
      const [fundR, oiR, oiHistR, lsR, priceR] = await Promise.allSettled([
        fetchWithRetry(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`),
        fetchWithRetry(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`),
        // ── RESTORED: OI History (6 bars = 6h of hourly OI snapshots) ──
        fetchWithRetry(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=6`),
        fetchWithRetry(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=2`),
        fetchWithRetry(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`),
      ]);

      // — Funding Rate —
      let fundRate = null, fundBias = 'NEUTRAL';
      if (fundR.status === 'fulfilled') {
        fundRate = parseFloat(fundR.value.lastFundingRate) * 100;
        fundBias =
          fundRate >  0.08 ? 'EXTREME_LONG_CROWDING' :
          fundRate >  0.03 ? 'LONG_HEAVY' :
          fundRate < -0.08 ? 'EXTREME_SHORT_CROWDING' :
          fundRate < -0.03 ? 'SHORT_HEAVY' : 'NEUTRAL';
      }

      // — Open Interest current —
      let oi = null;
      if (oiR.status === 'fulfilled') oi = parseFloat(oiR.value.openInterest);

      // ── RESTORED: OI History trend ───────────────────────
      let oiTrend = 'UNKNOWN', oiHistSignal = 'NEUTRAL';
      if (oiHistR.status === 'fulfilled' && Array.isArray(oiHistR.value) && oiHistR.value.length >= 2) {
        const hist = oiHistR.value;
        const oiOldest = parseFloat(hist[0].sumOpenInterest);
        const oiLatest = parseFloat(hist[hist.length - 1].sumOpenInterest);
        oiTrend = oiLatest > oiOldest ? 'RISING' : 'FALLING';

        // Get price direction from last 6h
        let priceDir = 'FLAT';
        try {
          const p6h = await fetchKlines(sym, '1h', 7);
          if (p6h.length >= 7) {
            const pOld = p6h[p6h.length - 7].close;
            const pNew = p6h[p6h.length - 1].close;
            priceDir = pNew > pOld * 1.001 ? 'UP' : pNew < pOld * 0.999 ? 'DOWN' : 'FLAT';
          }
        } catch { /* non-critical */ }

        // ── RESTORED: Classic OI signal interpretation ────
        oiHistSignal =
          oiTrend === 'RISING'  && priceDir === 'UP'   ? 'BULLISH_CONTINUATION' :
          oiTrend === 'RISING'  && priceDir === 'DOWN'  ? 'BEARISH_CONTINUATION' :
          oiTrend === 'FALLING' && priceDir === 'UP'    ? 'SHORT_SQUEEZE' :
          oiTrend === 'FALLING' && priceDir === 'DOWN'  ? 'LONG_LIQUIDATION' : 'NEUTRAL';
      }

      // — Long/Short Ratio —
      let lsRatio = null, lsBias = 'UNKNOWN';
      if (lsR.status === 'fulfilled' && Array.isArray(lsR.value) && lsR.value.length) {
        lsRatio = parseFloat(lsR.value[lsR.value.length - 1].longShortRatio);
        lsBias  = lsRatio > 1.4 ? 'LONGS_DOMINANT' : lsRatio < 0.7 ? 'SHORTS_DOMINANT' : 'BALANCED';
      }

      // — Overall signal —
      let signal = 'NEUTRAL';
      if (fundRate !== null) {
        if      (fundRate >  0.05 && lsRatio && lsRatio > 1.3) signal = 'LONG_SQUEEZE_RISK 🔴';
        else if (fundRate < -0.05 && lsRatio && lsRatio < 0.7) signal = 'SHORT_SQUEEZE_RISK 🟢';
        else if (fundRate >  0.03) signal = 'SLIGHTLY_LONG_HEAVY';
        else if (fundRate < -0.03) signal = 'SLIGHTLY_SHORT_HEAVY';
      }
      if (oiHistSignal === 'SHORT_SQUEEZE') signal = 'SHORT_SQUEEZE_RISK 🟢';
      if (oiHistSignal === 'LONG_LIQUIDATION' && signal !== 'LONG_SQUEEZE_RISK 🔴') signal = 'LONG_LIQUIDATION_RISK 🔴';

      const result = {
        symbol: sym,
        fundingRate:          fundRate != null ? parseFloat(fundRate.toFixed(4)) : null,
        fundingBias:          fundBias,
        fundingInterpretation: fundRate != null
          ? `${fundRate.toFixed(4)}%/8h — ` + (
              fundRate > 0.05 ? 'DANGER: Extreme longs. Long squeeze risk HIGH.'
            : fundRate > 0.03 ? 'Longs in control — mild squeeze risk.'
            : fundRate < -0.05 ? 'DANGER: Extreme shorts. Short squeeze risk HIGH.'
            : fundRate < -0.03 ? 'Shorts in control — rally risk elevated.'
            : 'Balanced funding.')
          : 'N/A (not a Binance Futures pair)',
        openInterest:    oi,
        // RESTORED
        oiTrend,
        oiHistSignal,
        oiInterpretation: {
          BULLISH_CONTINUATION: 'OI rising + price up → new longs entering → bullish momentum',
          BEARISH_CONTINUATION: 'OI rising + price down → new shorts entering → bearish momentum',
          SHORT_SQUEEZE:        'OI falling + price up → shorts covering → could accelerate upward',
          LONG_LIQUIDATION:     'OI falling + price down → longs exiting → could accelerate downward',
          NEUTRAL: 'No clear OI directional signal',
          UNKNOWN: 'Insufficient OI history',
        }[oiHistSignal],
        longShortRatio: lsRatio,
        longShortBias:  lsBias,
        signal,
        contractSpecific: fundRate !== null,
        timestamp: new Date().toISOString(),
      };

      fundCache.set(sym, result);
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({
        symbol: sym,
        note: 'Funding/OI not available — symbol may not trade on Binance Futures',
        signal: 'DATA_UNAVAILABLE',
        error: err.message,
      });
    }
  },
});

// ============================================================
//  EXPORTS
// ============================================================
const getAllTools = () => [
  getLivePriceTool,
  getTechnicalIndicatorsTool,
  getOrderBlocksTool,
  getMarketStructureTool,
  getFundingAndOITool,
];

module.exports = {
  getAllTools,
  getLivePriceTool,
  getTechnicalIndicatorsTool,
  getOrderBlocksTool,
  getMarketStructureTool,
  getFundingAndOITool,
  // Exported math utilities (used by server.js deep-analysis route)
  fetchKlines, normalizeSymbol,
  calcRSI, calcRSIArray, calcMACD, calcEMA, calcEMAArray, calcBB, calcATR, calcADX,
  calcVolRatio, calcCandlePattern, calcDivergence,
  detectStructure, findOrderBlocks, calcFibonacci, calcSRLevels, calcFVGs,
};
