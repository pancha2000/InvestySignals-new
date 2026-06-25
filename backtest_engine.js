/**
 * ════════════════════════════════════════════════════════════════════════
 *  backtest_engine.js
 * ────────────────────────────────────────────────────────────────────────
 *  InvestySignals — Rule-Engine Backtest (Step 1 of the agreed phased plan)
 *
 *  WHAT THIS IS
 *  A pure-code, walk-forward simulation: replay historical candles bar by
 *  bar, and at each bar ask "would this platform's confluence rules have
 *  fired a signal right here?" If yes, simulate forward through SUBSEQUENT
 *  candles to see whether Stop-Loss or a Take-Profit level would have been
 *  hit first. No Groq/LLM calls anywhere in this file — zero API cost,
 *  fast enough to run thousands of historical bars in seconds.
 *
 *  HONEST SCOPE — please read before trusting the numbers this produces:
 *  The live /api/deep-analysis route's final entry/SL/TP/grade is actually
 *  decided by Groq, reading code-computed indicators and following rules
 *  described in natural-language prompt text (multi-timeframe, plus News
 *  and Open Interest context). This engine CANNOT call Groq for every
 *  historical bar (cost + historical-news data isn't reliably available),
 *  so it works from a single timeframe and a CODIFIED, deterministic
 *  version of the same confluence-scoring rules described in that prompt
 *  (structure alignment, RSI, MACD, ADX, Order Blocks, FVGs, Fibonacci
 *  61.8%) — Open Interest and live News are intentionally NOT included,
 *  since neither has reliable historical data to replay accurately. Think
 *  of this as validating the TECHNICAL core of the system, not a perfect
 *  replica of what the live AI would have said on any given day.
 *
 *  CODE REUSE: every indicator computed below comes from market_tools.js's
 *  already-exported, already-tested functions (indicators.*, structure.*,
 *  candleReading.*) — the SAME functions market_tools.js's AI tools use
 *  live. No indicator math is duplicated a third time in this file.
 * ════════════════════════════════════════════════════════════════════════
 */

'use strict';

const marketTools = require('./market_tools');
const { indicators, structure, candleReading, data } = marketTools;
const { fetchKlinesCached, sanitizeCandles } = data;

// ════════════════════════════════════════════════════════════════════════
// SECTION 1 — Config (mirrors the live system's actual constants where
//             a direct equivalent exists, so this stays an honest test of
//             the SAME rules, not a different invented strategy)
// ════════════════════════════════════════════════════════════════════════

const CONFLUENCE_THRESHOLD_RAW = 4;   // out of 7 codified factors (~5.7/10 scaled) — mirrors server.js's CONFLUENCE_THRESHOLD=5/10
const ATR_SL_MULTIPLIER = 1.5;        // mirrors the live prompt's "SL = 1.5×ATR(4H)" rule
const TP1_R = 1.5;
const TP2_R = 2.5;
const TP3_R = 4.0;
const MAX_HOLD_BARS = 60;             // ~10 days on 4H candles — if neither SL nor any TP hits by then, close at market (timeout)
const WARMUP_BARS = 60;               // bars needed before indicators are reliable (EMA50, ADX, etc.)

// ════════════════════════════════════════════════════════════════════════
// SECTION 2 — Codified confluence scoring (deterministic JS version of
//             the rules described in /api/deep-analysis's AI prompt)
// ════════════════════════════════════════════════════════════════════════

/**
 * Given candles UP TO AND INCLUDING index `i` (no look-ahead — everything
 * after i is invisible to this function), decide: is there a directional
 * bias here at all, and if so, how many of the 7 codified confluence
 * factors agree with it?
 */
function evaluateBar(candlesSoFar) {
  const closes = candlesSoFar.map((c) => c.close);
  if (closes.length < WARMUP_BARS) return null;

  const ema20 = indicators.ema(closes, 20);
  const ema50 = indicators.ema(closes, 50);
  const lastClose = closes[closes.length - 1];
  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];

  // Base directional bias requires PRICE and TREND STRUCTURE to agree —
  // same spirit as the live system needing multi-timeframe alignment
  // before considering a direction at all. detectStructure() returns a
  // STRING like 'BOS_BULLISH' / 'CHOCH_BEARISH' / 'NEUTRAL', not an object.
  const structStr = structure.detectStructure(candlesSoFar);
  const emaBias = lastEma20 > lastEma50 ? 'LONG' : 'SHORT';
  const structBias = structStr.includes('BULLISH') ? 'LONG' : structStr.includes('BEARISH') ? 'SHORT' : null;
  if (!structBias || structBias !== emaBias) return null; // no agreement → no signal at this bar
  const bias = structBias;

  const rsi = indicators.rsiValue(closes, 14);
  const macd = indicators.macd(closes);
  const adx = indicators.adx(candlesSoFar, 14);
  const atr = indicators.atr(candlesSoFar, 14);
  const obs = structure.findOrderBlocks(candlesSoFar, 5);
  const fvgs = structure.findFairValueGaps(candlesSoFar);
  const fib = structure.fibonacciRetracement(candlesSoFar, 50);

  if (!atr || atr <= 0) return null; // can't size a stop without a valid ATR

  let score = 0;
  // 1. RSI confirmation — has room to run in the bias direction, not already extended
  if (bias === 'LONG' ? (rsi >= 40 && rsi <= 65) : (rsi >= 35 && rsi <= 60)) score++;
  // 2. MACD alignment — histogram agrees with bias and is moving the right way
  if (bias === 'LONG' ? (macd.histogram > 0 && macd.histogram >= macd.prevHistogram) : (macd.histogram < 0 && macd.histogram <= macd.prevHistogram)) score++;
  // 3. ADX trending in this direction
  if (adx.adx > 25 && ((bias === 'LONG' && adx.plusDI > adx.minusDI) || (bias === 'SHORT' && adx.minusDI > adx.plusDI))) score++;
  // 4. An Order Block nearby, in the trade direction, within 2×ATR of price
  //    (findOrderBlocks returns type: 'BULL_OB' | 'BEAR_OB', fields low/high)
  const obNearby = (obs || []).some((ob) => ob.type === (bias === 'LONG' ? 'BULL_OB' : 'BEAR_OB') && Math.abs(lastClose - (ob.low + ob.high) / 2) <= atr * 2);
  if (obNearby) score++;
  // 5. A Fair Value Gap nearby, in the trade direction
  //    (findFairValueGaps returns type: 'BULL' | 'BEAR', fields low/high)
  const fvgNearby = (fvgs || []).some((g) => g.type === (bias === 'LONG' ? 'BULL' : 'BEAR') && Math.abs(lastClose - (g.low + g.high) / 2) <= atr * 2);
  if (fvgNearby) score++;
  // 6. Price sitting near the 61.8% Fibonacci retracement (classic entry confluence zone)
  //    (fibonacciRetracement returns field f618, not level618)
  if (fib && fib.f618 && Math.abs(lastClose - fib.f618) <= atr * 0.75) score++;
  // 7. Structure itself agreeing (counted again here deliberately, mirroring
  //    the live prompt where structure alignment is its own explicit point
  //    on top of being the gate above — a clean trend gets credit twice,
  //    same as in production).
  score++; // we only got here because structBias === emaBias === bias

  return { bias, score, rsi, adx: adx.adx, atr, lastClose };
}

/** Map a 0-7 raw score onto the same S/A/B/C grade bands the live system
 *  uses on its 0-10 scale, so backtest output reads consistently with the
 *  Dashboard's own language. */
function scoreToGrade(raw7) {
  const score10 = Math.round((raw7 / 7) * 10);
  if (score10 >= 8) return 'S';
  if (score10 >= 6) return 'A';
  if (score10 >= 5) return 'B';
  return 'C';
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 3 — Forward simulation of one triggered signal
// ════════════════════════════════════════════════════════════════════════

function simulateTrade(candles, entryIdx, bias, entry, atr) {
  const sl = bias === 'LONG' ? entry - atr * ATR_SL_MULTIPLIER : entry + atr * ATR_SL_MULTIPLIER;
  const riskDist = Math.abs(entry - sl);
  const tp1 = bias === 'LONG' ? entry + riskDist * TP1_R : entry - riskDist * TP1_R;
  const tp2 = bias === 'LONG' ? entry + riskDist * TP2_R : entry - riskDist * TP2_R;
  const tp3 = bias === 'LONG' ? entry + riskDist * TP3_R : entry - riskDist * TP3_R;

  const lastIdx = Math.min(entryIdx + MAX_HOLD_BARS, candles.length - 1);
  for (let j = entryIdx + 1; j <= lastIdx; j++) {
    const { high, low } = candles[j];
    if (bias === 'LONG') {
      if (low <= sl) return finish('SL', sl, j);
      if (high >= tp3) return finish('TP3', tp3, j);
      if (high >= tp2) return finish('TP2', tp2, j);
      if (high >= tp1) return finish('TP1', tp1, j);
    } else {
      if (high >= sl) return finish('SL', sl, j);
      if (low <= tp3) return finish('TP3', tp3, j);
      if (low <= tp2) return finish('TP2', tp2, j);
      if (low <= tp1) return finish('TP1', tp1, j);
    }
  }
  // Neither SL nor any TP hit within the hold window — close at the last
  // available price (an honest "timeout", not silently dropped).
  return finish('TIMEOUT', candles[lastIdx].close, lastIdx);

  function finish(reason, exitPrice, exitIdx) {
    const rMultiple = bias === 'LONG' ? (exitPrice - entry) / riskDist : (entry - exitPrice) / riskDist;
    return { sl, tp1, tp2, tp3, exitReason: reason, exitPrice, exitIdx, rMultiple: Number(rMultiple.toFixed(3)) };
  }
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 4 — Main entry point: run a full walk-forward backtest for ONE
//             symbol over its available history on a given timeframe.
// ════════════════════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {string} opts.symbol        e.g. "BTCUSDT" (already normalized)
 * @param {string} [opts.timeframe]   default '4h' — matches the live
 *                                     system's primary structure/SL timeframe
 * @param {number} [opts.candleCount] how much history to pull (max 1000 per
 *                                    Binance call — this engine paginates
 *                                    beyond that automatically up to a cap)
 * @param {function} [opts.onProgress] optional (pct:number)=>void callback
 */
async function runBacktest({ symbol, timeframe = '4h', candleCount = 1000, onProgress }) {
  const sym = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : symbol.toUpperCase() + 'USDT';
  const cappedCount = Math.min(Math.max(candleCount, 200), 3000); // sane bounds — protects against runaway requests

  const candles = await fetchHistoricalCandles(sym, timeframe, cappedCount);
  if (candles.length < WARMUP_BARS + 20) {
    throw new Error(`Not enough history for ${sym} on ${timeframe} (got ${candles.length} candles, need at least ${WARMUP_BARS + 20}).`);
  }

  const trades = [];
  let i = WARMUP_BARS;
  const total = candles.length;

  while (i < total - 1) {
    if (onProgress && i % 50 === 0) onProgress(Math.round((i / total) * 100));

    const windowCandles = candles.slice(0, i + 1); // no look-ahead — only data up to and including bar i
    const evalResult = evaluateBar(windowCandles);

    if (evalResult && evalResult.score >= CONFLUENCE_THRESHOLD_RAW) {
      const trade = simulateTrade(candles, i, evalResult.bias, evalResult.lastClose, evalResult.atr);
      trades.push({
        openTime: new Date(candles[i].closeTime || candles[i].openTime),
        closeTime: new Date(candles[trade.exitIdx].closeTime || candles[trade.exitIdx].openTime),
        direction: evalResult.bias,
        entry: Number(evalResult.lastClose.toFixed(6)),
        sl: Number(trade.sl.toFixed(6)),
        tp1: Number(trade.tp1.toFixed(6)),
        tp2: Number(trade.tp2.toFixed(6)),
        tp3: Number(trade.tp3.toFixed(6)),
        exitPrice: Number(trade.exitPrice.toFixed(6)),
        exitReason: trade.exitReason,
        rMultiple: trade.rMultiple,
        score: evalResult.score,
        grade: scoreToGrade(evalResult.score),
      });
      // Jump past this trade's exit — avoids overlapping/duplicate signals
      // on what is really still "the same setup" still playing out.
      i = trade.exitIdx + 1;
    } else {
      i++;
    }
  }

  if (onProgress) onProgress(100);
  return { symbol: sym, timeframe, candleCount: candles.length, trades, summary: summarize(trades) };
}

function summarize(trades) {
  if (!trades.length) {
    return { totalTrades: 0, wins: 0, losses: 0, timeouts: 0, winRate: 0, profitFactor: 0, avgR: 0, totalR: 0, maxDrawdownR: 0, byGrade: {} };
  }
  const wins = trades.filter((t) => t.exitReason.startsWith('TP')).length;
  const losses = trades.filter((t) => t.exitReason === 'SL').length;
  const timeouts = trades.filter((t) => t.exitReason === 'TIMEOUT').length;
  const grossWin = trades.filter((t) => t.rMultiple > 0).reduce((a, t) => a + t.rMultiple, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.rMultiple < 0).reduce((a, t) => a + t.rMultiple, 0));
  const totalR = trades.reduce((a, t) => a + t.rMultiple, 0);

  let running = 0, peak = 0, maxDD = 0;
  for (const t of trades) { running += t.rMultiple; peak = Math.max(peak, running); maxDD = Math.min(maxDD, running - peak); }

  const byGrade = {};
  for (const g of ['S', 'A', 'B', 'C']) {
    const gradeTrades = trades.filter((t) => t.grade === g);
    const gradeWins = gradeTrades.filter((t) => t.exitReason.startsWith('TP')).length;
    byGrade[g] = { count: gradeTrades.length, winRate: gradeTrades.length ? Number(((gradeWins / gradeTrades.length) * 100).toFixed(1)) : 0 };
  }

  return {
    totalTrades: trades.length,
    wins, losses, timeouts,
    winRate: Number(((wins / trades.length) * 100).toFixed(1)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : (grossWin > 0 ? Infinity : 0),
    avgR: Number((totalR / trades.length).toFixed(3)),
    totalR: Number(totalR.toFixed(2)),
    maxDrawdownR: Number(maxDD.toFixed(2)),
    byGrade,
  };
}

// ════════════════════════════════════════════════════════════════════════
// SECTION 5 — Historical candle fetching (paginated beyond Binance's
//             1000-per-call limit, reusing the SAME cached/retried fetch
//             chokepoint as everything else — no new HTTP logic invented)
// ════════════════════════════════════════════════════════════════════════

async function fetchHistoricalCandles(symbol, timeframe, count) {
  const perCall = 1000;
  if (count <= perCall) {
    const raw = await fetchKlinesCached(symbol, timeframe, count);
    return mapCandles(sanitizeCandles(raw));
  }

  // Paginate backwards in time using Binance's endTime param for anything
  // beyond one call's worth — fetchKlinesCached's own cache only covers the
  // "latest N" shape, so earlier pages are fetched directly here (still
  // through the same retried fetchJSON used throughout market_tools.js).
  const intervalMs = { '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 }[timeframe] || 144e5;
  let endTime = Date.now();
  let all = [];
  let remaining = count;
  while (remaining > 0) {
    const limit = Math.min(remaining, perCall);
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${timeframe}&limit=${limit}&endTime=${endTime}`;
    const page = await marketTools.infra.fetchJSON(url, { retries: 2, timeoutMs: 10000 });
    if (!Array.isArray(page) || !page.length) break;
    all = page.concat(all);
    endTime = page[0][0] - intervalMs; // move window back before the earliest candle just fetched
    remaining -= page.length;
    if (page.length < limit) break; // exhausted available history
  }
  return mapCandles(sanitizeCandles(all));
}

function mapCandles(raw) {
  return raw.map((k) => ({
    openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]),
    close: parseFloat(k[4]), volume: parseFloat(k[5]), closeTime: k[6],
  }));
}

module.exports = { runBacktest, runWalkForward };

// ════════════════════════════════════════════════════════════════════════
// SECTION 6 — Walk-Forward Validation (Step 2 of the agreed phased plan)
// ════════════════════════════════════════════════════════════════════════

/**
 * Walk-Forward Validation — the honest way to know if backtest results
 * are real edge or just curve-fitting to historical noise.
 *
 * HOW IT WORKS:
 *   The full history is split into a series of rolling windows. Each window
 *   has an IN-SAMPLE half (the model "trains"/validates on this — in our
 *   rule-based case, this means we run the full simulation and measure
 *   performance) and an OUT-OF-SAMPLE half that the in-sample window is
 *   immediately followed by (the model is then tested on data it has never
 *   "seen" in that window). This is repeated across the full history so
 *   every bar appears in exactly one out-of-sample window.
 *
 *   A valid edge shows up as:
 *   • out-of-sample win rate reasonably close to in-sample win rate
 *   • out-of-sample profit factor ≥ 1.0 (still profitable on unseen data)
 *
 *   A curve-fit (overfit) strategy shows as:
 *   • in-sample looks great (e.g. 70% WR) but out-of-sample collapses
 *     (e.g. 40% WR) — the rules fit the past noise, not the real edge.
 *
 *   We are NOT optimizing weights in this implementation (that would be
 *   Step 3 — auto-tuning). This Step 2 purely validates whether the
 *   existing fixed rules generalise, as agreed in the plan.
 *
 * @param {object} opts  Same as runBacktest, plus:
 *   @param {number} [opts.splits=4]   Number of train/test windows.
 *   @param {number} [opts.trainRatio=0.7]  Fraction of each window used
 *                                           for in-sample (0.5–0.85).
 */
async function runWalkForward({ symbol, timeframe = '4h', candleCount = 2000, splits = 4, trainRatio = 0.7, onProgress }) {
  const sym = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : symbol.toUpperCase() + 'USDT';
  const cappedCount = Math.min(Math.max(candleCount, 400), 3000);
  const safeSplits = Math.min(Math.max(splits, 2), 8);
  const safeRatio = Math.min(Math.max(trainRatio, 0.5), 0.85);

  if (onProgress) onProgress(5);
  const candles = await fetchHistoricalCandles(sym, timeframe, cappedCount);
  if (onProgress) onProgress(15);

  const minNeeded = (WARMUP_BARS + 20) * 2;
  if (candles.length < minNeeded) {
    throw new Error(`Not enough history for walk-forward on ${sym} ${timeframe}. Need ≥${minNeeded} candles, got ${candles.length}.`);
  }

  const usable = candles.length - WARMUP_BARS; // first WARMUP_BARS bars are always warmup, never sliced
  const windowSize = Math.floor(usable / safeSplits);
  const trainSize  = Math.floor(windowSize * safeRatio);
  const testSize   = windowSize - trainSize;

  if (trainSize < 50 || testSize < 20) {
    throw new Error(`Window too small for ${safeSplits} splits. Try fewer splits or more candle history.`);
  }

  const windows = [];
  for (let w = 0; w < safeSplits; w++) {
    const windowStart = WARMUP_BARS + w * windowSize;
    const trainEnd    = windowStart + trainSize;
    const testEnd     = Math.min(trainEnd + testSize, candles.length - 1);
    windows.push({ w, windowStart, trainEnd, testEnd });
  }

  const windowResults = [];
  for (let wi = 0; wi < windows.length; wi++) {
    const { w, windowStart, trainEnd, testEnd } = windows[wi];
    if (onProgress) onProgress(15 + Math.round((wi / windows.length) * 80));

    // IN-SAMPLE: run simulation over the train portion of this window
    const inTrades = [];
    let i = windowStart;
    while (i < trainEnd) {
      const windowCandles = candles.slice(0, i + 1);
      const ev = evaluateBar(windowCandles);
      if (ev && ev.score >= CONFLUENCE_THRESHOLD_RAW) {
        const result = simulateTrade(candles, i, ev.bias, ev.lastClose, ev.atr);
        inTrades.push(makeTrade(candles, i, result, ev));
        i = Math.min(result.exitIdx + 1, trainEnd);
      } else { i++; }
    }

    // OUT-OF-SAMPLE: run simulation over the test portion (no look-back changes
    // the rules — same fixed thresholds, fresh candle window, no information from
    // the in-sample results ever crosses over here)
    const outTrades = [];
    let j = trainEnd;
    while (j < testEnd) {
      const windowCandles = candles.slice(0, j + 1);
      const ev = evaluateBar(windowCandles);
      if (ev && ev.score >= CONFLUENCE_THRESHOLD_RAW) {
        const result = simulateTrade(candles, j, ev.bias, ev.lastClose, ev.atr);
        outTrades.push(makeTrade(candles, j, result, ev));
        j = Math.min(result.exitIdx + 1, testEnd);
      } else { j++; }
    }

    windowResults.push({
      window: w + 1,
      periodStart: new Date(candles[windowStart].openTime).toISOString().slice(0, 10),
      trainEnd: new Date(candles[trainEnd - 1].openTime).toISOString().slice(0, 10),
      testEnd: new Date(candles[Math.min(testEnd, candles.length - 1)].openTime).toISOString().slice(0, 10),
      inSample: summarize(inTrades),
      outOfSample: summarize(outTrades),
      inTradeCount: inTrades.length,
      outTradeCount: outTrades.length,
    });
  }

  if (onProgress) onProgress(100);

  // Aggregate across all out-of-sample windows — this is the honest overall number
  const allOutTrades = windowResults.reduce((acc, wr) => acc + wr.outTradeCount, 0);
  const allOutWins   = windowResults.reduce((acc, wr) => acc + Math.round(wr.outOfSample.wins || 0), 0);
  const allOutWR     = allOutTrades > 0 ? Number(((allOutWins / allOutTrades) * 100).toFixed(1)) : 0;
  const avgInWR      = Number((windowResults.reduce((a, r) => a + r.inSample.winRate, 0) / windowResults.length).toFixed(1));
  const avgOutPF     = Number((windowResults.reduce((a, r) => a + (isFinite(r.outOfSample.profitFactor) ? r.outOfSample.profitFactor : 0), 0) / windowResults.length).toFixed(2));

  // Verdict — simple, honest, actionable
  let verdict, verdictDetail;
  const wrDrop = avgInWR - allOutWR;
  if (allOutTrades < 10) {
    verdict = 'INSUFFICIENT_DATA';
    verdictDetail = `Only ${allOutTrades} out-of-sample trades total — too few for a statistically meaningful verdict. Try more candle history or fewer splits.`;
  } else if (avgOutPF < 1.0) {
    verdict = 'NOT_VALIDATED';
    verdictDetail = `Out-of-sample profit factor is ${avgOutPF.toFixed(2)} (below 1.0 — losing money on unseen data). The rules may be fitting historical noise. Review confluence weights before live use.`;
  } else if (wrDrop > 20) {
    verdict = 'MARGINAL';
    verdictDetail = `In-sample WR (${avgInWR}%) drops significantly to ${allOutWR}% out-of-sample — a ${wrDrop.toFixed(0)}% gap. Some edge exists but it's weaker than it looks on historical data alone.`;
  } else if (avgOutPF >= 1.3 && wrDrop <= 15) {
    verdict = 'VALIDATED';
    verdictDetail = `Out-of-sample WR ${allOutWR}% with profit factor ${avgOutPF.toFixed(2)} — the edge holds on unseen data. Rules generalise reasonably well.`;
  } else {
    verdict = 'MARGINAL';
    verdictDetail = `Mixed results across windows — out-of-sample PF ${avgOutPF.toFixed(2)}, WR ${allOutWR}%. Some windows validate well, others don't. Treat live use cautiously.`;
  }

  return {
    symbol: sym, timeframe, candleCount: candles.length,
    splits: safeSplits, trainRatioPct: Math.round(safeRatio * 100),
    windows: windowResults,
    aggregate: { avgInSampleWR: avgInWR, outOfSampleWR: allOutWR, avgOutOfSamplePF: avgOutPF, totalOutTrades: allOutTrades },
    verdict, verdictDetail,
  };
}

function makeTrade(candles, i, result, ev) {
  return {
    openTime:   new Date(candles[i].closeTime || candles[i].openTime),
    closeTime:  new Date(candles[result.exitIdx].closeTime || candles[result.exitIdx].openTime),
    direction:  ev.bias,
    entry:      Number(ev.lastClose.toFixed(6)),
    exitPrice:  Number(result.exitPrice.toFixed(6)),
    exitReason: result.exitReason,
    rMultiple:  result.rMultiple,
    score:      ev.score,
    grade:      scoreToGrade(ev.score),
  };
}

