/**
 * ════════════════════════════════════════════════════════════════════════
 *  market_memory.js
 * ────────────────────────────────────────────────────────────────────────
 *  THE "ALWAYS WATCHING" LAYER.
 *
 *  A person can't stare at charts 24/7. This module is the part of the
 *  system that can: it wakes up on a timer, snapshots a handful of
 *  behavioral signals for each tracked coin (retail positioning, market
 *  sentiment, funding, open interest trend, market structure), and saves
 *  them to disk. Hours or days later, /api/deep-analysis calls
 *  getRecentContext(symbol) to ask "how has this coin actually been
 *  behaving lately?" and folds the answer into the AI's prompt — so the
 *  entry decision is informed by real recent history, not just the
 *  single instant the user happened to click "Analyze".
 *
 *  This is INTENTIONALLY separate from market_tools.js's live, per-request
 *  tools (those answer "what is true right now"); this module answers
 *  "what has been true over the last N days".
 *
 *  STORAGE
 *    data/market_memory/<SYMBOL>/<YYYY-MM-DD>.jsonl   (one line per snapshot)
 *  Old files are deleted automatically after `retentionDays` (Settings-
 *  controlled, default 30). At a snapshot every 15 min for ~10 coins, 30
 *  days is only a few MB total — see README section in this file's header
 *  for the actual math; a 200GB VPS is not a meaningfully constrained
 *  resource here.
 *
 *  CLOUD BACKUP (optional, off by default)
 *  If enabled in Settings, once a day the PREVIOUS day's completed files
 *  are also copied to a cloud remote via `rclone` (Mega, Google Drive,
 *  etc. — anything rclone supports). The local copy is kept too (this is
 *  a backup, not an offload — 200GB local storage doesn't need offloading).
 * ════════════════════════════════════════════════════════════════════════
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const WebSocket = require('ws');
const marketTools = require('./market_tools');

// ── Liquidation Cluster Collection ────────────────────────────────────
// Same pattern as experiments/liquidation_tracker.js, promoted to
// production: a persistent WebSocket connection to Binance's public
// liquidation stream, filtered to the tracked symbol list, written to
// data/liquidations/<SYMBOL>/<date>.jsonl. This answers a genuinely
// leading question price indicators can't: "where did a lot of forced
// closures already happen?" — those price levels often act as magnets
// (price gets drawn back to sweep resting liquidity near them) or as
// reaction zones (a cluster of shorts just got liquidated here, so a
// bounce lost its short-covering fuel).
const LIQ_DATA_ROOT = path.join(__dirname, 'data', 'liquidations');
let liqWs = null;
let liqReconnectTimer = null;
let liqTrackedSymbols = [];

function liqSymbolDir(symbol) { return path.join(LIQ_DATA_ROOT, symbol); }
function liqTodayFile(symbol) {
  const iso = new Date().toISOString().slice(0, 10);
  return path.join(liqSymbolDir(symbol), `${iso}.jsonl`);
}
function parseLiquidation(msg) {
  const o = msg.o;
  if (!o) return null;
  return {
    symbol: o.s, side: o.S, price: parseFloat(o.p), qty: parseFloat(o.q),
    usdValue: Math.round(parseFloat(o.p) * parseFloat(o.q) * 100) / 100,
    time: Math.floor(o.T / 1000), // seconds, matches candle time format used elsewhere
  };
}
function startLiquidationCollector(getSymbols) {
  stopLiquidationCollector();
  function connect() {
    liqWs = new WebSocket('wss://fstream.binance.com/ws/!forceOrder@arr');
    liqWs.on('open', () => console.log('[market_memory] liquidation collector connected'));
    liqWs.on('message', (raw) => {
      let payload;
      try { payload = JSON.parse(raw.toString()); } catch (_) { return; }
      const record = parseLiquidation(payload);
      if (!record) return;
      liqTrackedSymbols = typeof getSymbols === 'function' ? getSymbols() : getSymbols;
      if (!liqTrackedSymbols.includes(record.symbol)) return; // only store what we actually track — keeps disk usage bounded
      try {
        fs.mkdirSync(liqSymbolDir(record.symbol), { recursive: true });
        fs.appendFileSync(liqTodayFile(record.symbol), JSON.stringify(record) + '\n');
      } catch (_) { /* best-effort — a missed write doesn't crash the collector */ }
    });
    liqWs.on('close', () => { liqReconnectTimer = setTimeout(connect, 5000); });
    liqWs.on('error', (err) => console.error('[market_memory] liquidation ws error:', err.message));
  }
  connect();
}
function stopLiquidationCollector() {
  if (liqReconnectTimer) clearTimeout(liqReconnectTimer);
  if (liqWs) { try { liqWs.removeAllListeners('close'); liqWs.close(); } catch (_) {} }
  liqWs = null;
}

/**
 * getLiquidationClusters(symbol, hours, currentPrice)
 * Reads recent liquidation events for a symbol and buckets them by price
 * (0.25% buckets) to find where a meaningful concentration of forced
 * closures already happened. Returns clusters sorted by total USD value,
 * each tagged as ABOVE or BELOW the current price (relevant for different
 * things: a cluster below = past long-liquidations = potential support-
 * turned-magnet; above = past short-liquidations = potential resistance).
 */
function getLiquidationClusters(symbol, hours = 24, currentPrice = null, minClusterUsd = 50000) {
  const dir = liqSymbolDir(symbol);
  if (!fs.existsSync(dir)) return { available: false, clusters: [] };
  const cutoff = Date.now() / 1000 - hours * 3600;
  const rows = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.jsonl')) continue;
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { const row = JSON.parse(line); if (row.time >= cutoff) rows.push(row); } catch (_) {}
    }
  }
  if (rows.length < 5) return { available: false, clusters: [], sampleCount: rows.length };

  const bucketPct = 0.0025; // 0.25% price buckets
  // BUG FIX (caught via test before shipping): bucket width must be a
  // FIXED reference value. The first version computed it per-row as
  // `price / (price * bucketPct)`, which always simplifies to the
  // constant `1/bucketPct` regardless of the actual price — every
  // liquidation regardless of price level was collapsing into the exact
  // same bucket. Using currentPrice (or the first row's price as a
  // fallback) as a single fixed reference for the whole pass fixes it.
  const refPrice = currentPrice || (rows[0] && rows[0].price) || 1;
  const bucketWidth = refPrice * bucketPct;
  const buckets = {};
  for (const r of rows) {
    const bucketKey = Math.round(r.price / bucketWidth);
    if (!buckets[bucketKey]) buckets[bucketKey] = { totalUsd: 0, count: 0, prices: [] };
    buckets[bucketKey].totalUsd += r.usdValue;
    buckets[bucketKey].count++;
    buckets[bucketKey].prices.push(r.price);
  }
  const clusters = Object.values(buckets)
    .filter(b => b.totalUsd >= minClusterUsd)
    .map(b => ({
      price: Math.round((b.prices.reduce((s, p) => s + p, 0) / b.prices.length) * 1e6) / 1e6,
      totalUsd: Math.round(b.totalUsd),
      eventCount: b.count,
      side: currentPrice ? (b.prices[0] < currentPrice ? 'BELOW' : 'ABOVE') : null,
    }))
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 8);

  return { available: true, clusters, sampleCount: rows.length, windowHours: hours };
}

const DATA_ROOT = path.join(__dirname, 'data', 'market_memory');

// ── Internal state (set by startCollector) ────────────────────────────
let collectorTimer = null;
let cloudSyncTimer = null;
let lastRunAt = null;
let lastRunResults = [];

function symbolDir(symbol) {
  return path.join(DATA_ROOT, symbol);
}
function todayFile(symbol) {
  const iso = new Date().toISOString().slice(0, 10);
  return path.join(symbolDir(symbol), `${iso}.jsonl`);
}

/** Take one snapshot for one symbol and append it to today's file. */
async function collectSnapshot(symbol) {
  try {
    const h1 = await marketTools.data.fetchKlinesCached(symbol, '1h', 50).catch(() => null);
    const h1Candles = Array.isArray(h1) ? h1.map(k => ({
      open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    })) : [];

    const [longShort, fearGreed, funding, oi] = await Promise.all([
      marketTools.data.getLongShortRatio(symbol),
      marketTools.data.getFearGreedIndex(),
      marketTools.data.getFundingRateContext(symbol),
      h1Candles.length ? marketTools.data.getOpenInterestContext(symbol, h1Candles) : null,
    ]);

    const price = h1Candles.length ? h1Candles[h1Candles.length - 1].close : null;

    const snapshot = {
      t: Date.now(),
      symbol,
      price,
      longShortSkew: longShort?.skewLabel || 'UNKNOWN',
      longAccountPct: longShort?.longAccount ?? null,
      fearGreed: fearGreed?.value ?? null,
      fearGreedLabel: fearGreed?.classification || 'UNKNOWN',
      fundingRate: funding?.fundingRate ?? null,
      fundingBias: funding?.fundingBias || 'NEUTRAL',
      oiTrend: oi?.trend || 'UNKNOWN',
      oiSignal: oi?.signal || 'NEUTRAL',
    };

    fs.mkdirSync(symbolDir(symbol), { recursive: true });
    fs.appendFileSync(todayFile(symbol), JSON.stringify(snapshot) + '\n');
    return { symbol, ok: true, snapshot };
  } catch (e) {
    return { symbol, ok: false, error: e.message };
  }
}

/** Run one full collection pass across all tracked symbols (sequential — gentle on rate limits). */
async function runCollectionPass(getSymbols) {
  const symbols = (typeof getSymbols === 'function' ? getSymbols() : getSymbols) || [];
  const results = [];
  for (const symbol of symbols) {
    results.push(await collectSnapshot(symbol));
  }
  lastRunAt = Date.now();
  lastRunResults = results;
  return results;
}

/**
 * getRecentContext(symbol, days)
 * Reads the last `days` of saved snapshots for a symbol and reduces them
 * to a compact summary + a ready-to-paste prompt string, for use as an
 * EXTRA CONFLUENCE CONTEXT line in /api/deep-analysis — never a
 * standalone rule, always a confirmation signal alongside the existing
 * ICT/SMC engine.
 */
function getRecentContext(symbol, days = 7) {
  const dir = symbolDir(symbol);
  if (!fs.existsSync(dir)) return { available: false, promptLine: '', summary: null };

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.jsonl')) continue;
    const fullPath = path.join(dir, file);
    const lines = fs.readFileSync(fullPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.t >= cutoff) rows.push(row);
      } catch (_) { /* skip malformed line */ }
    }
  }

  if (rows.length < 3) return { available: false, promptLine: '', summary: null, sampleCount: rows.length };

  const longHeavyPct = round(100 * rows.filter(r => r.longShortSkew === 'LONG_HEAVY').length / rows.length);
  const shortHeavyPct = round(100 * rows.filter(r => r.longShortSkew === 'SHORT_HEAVY').length / rows.length);
  const avgFearGreed = round(avg(rows.map(r => r.fearGreed).filter(v => typeof v === 'number')));
  const oiRisingPct = round(100 * rows.filter(r => r.oiTrend === 'RISING').length / rows.length);
  const firstPrice = rows.find(r => typeof r.price === 'number')?.price;
  const lastPrice = [...rows].reverse().find(r => typeof r.price === 'number')?.price;
  const priceChangePct = (firstPrice && lastPrice) ? round(100 * (lastPrice - firstPrice) / firstPrice) : null;

  const summary = {
    sampleCount: rows.length,
    daysSpan: days,
    longHeavyPct, shortHeavyPct,
    avgFearGreed,
    oiRisingPct,
    priceChangePct,
  };

  const promptLine =
    `MARKET MEMORY (last ${days}d, ${rows.length} snapshots for ${symbol} — real observed behavior, not a rule, use as confirmation only):\n` +
    `- Retail positioning was LONG_HEAVY ${longHeavyPct}% of the time, SHORT_HEAVY ${shortHeavyPct}% of the time.\n` +
    `- Average Fear & Greed over this window: ${avgFearGreed ?? 'N/A'}.\n` +
    `- Open Interest was RISING ${oiRisingPct}% of the time (${oiRisingPct > 60 ? 'sustained new positioning building' : oiRisingPct < 30 ? 'positioning has been unwinding' : 'mixed'}).\n` +
    `- Net price change over the window: ${priceChangePct !== null ? priceChangePct + '%' : 'N/A'}.\n` +
    `If retail has been heavily one-sided (${Math.max(longHeavyPct, shortHeavyPct)}%+) while price moved the OPPOSITE way, treat this as a squeeze-risk confirmation and mention it in keyRisk.`;

  return { available: true, promptLine, summary };
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function round(v) { return v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 100) / 100; }

/** Delete snapshot files older than retentionDays, for every tracked symbol currently on disk. */
function cleanupOldData(retentionDays = 30) {
  if (!fs.existsSync(DATA_ROOT)) return { deleted: 0 };
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const symbol of fs.readdirSync(DATA_ROOT)) {
    const dir = symbolDir(symbol);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      const dateStr = file.replace('.jsonl', '');
      const fileDate = new Date(dateStr).getTime();
      if (Number.isFinite(fileDate) && fileDate < cutoff) {
        fs.unlinkSync(path.join(dir, file));
        deleted++;
      }
    }
  }
  return { deleted };
}

/** Best-effort rclone sync of the whole data root to a configured remote. Never throws. */
function syncToCloud(remoteName, remoteFolder = 'InvestySignals-market-memory') {
  return new Promise((resolve) => {
    if (!remoteName) return resolve({ ok: false, error: 'No remote configured' });
    execFile('rclone', ['copy', DATA_ROOT, `${remoteName}:${remoteFolder}`, '--progress=false'],
      { maxBuffer: 1024 * 1024 * 20 },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: stderr || err.message });
        resolve({ ok: true });
      });
  });
}

/**
 * startCollector(getSymbols, options)
 *   getSymbols: function returning current symbol list (so admin panel
 *               changes take effect on the next tick without a restart)
 *   options: { intervalMs, retentionDays, cloudSync: { enabled, remote } }
 */
function startCollector(getSymbols, options = {}) {
  const intervalMs = options.intervalMs || 15 * 60 * 1000; // 15 min default
  const retentionDays = options.retentionDays ?? 30;

  stopCollector(); // idempotent — clear any previous timers first

  runCollectionPass(getSymbols).catch(() => {}); // fire once immediately on start
  collectorTimer = setInterval(() => {
    runCollectionPass(getSymbols).catch(() => {});
  }, intervalMs);
  collectorTimer.unref();

  // Daily retention cleanup + optional cloud sync, offset so it doesn't
  // collide with the snapshot tick above.
  cloudSyncTimer = setInterval(() => {
    cleanupOldData(retentionDays);
    if (options.cloudSync && options.cloudSync.enabled) {
      syncToCloud(options.cloudSync.remote).catch(() => {});
    }
  }, 24 * 60 * 60 * 1000);
  cloudSyncTimer.unref();

  // NEW: liquidation collector — separate opt-in (continuous WebSocket,
  // different resource profile than the periodic REST snapshots above),
  // gated by its own settings flag.
  if (options.liquidationTracking && options.liquidationTracking.enabled) {
    startLiquidationCollector(getSymbols);
  } else {
    stopLiquidationCollector();
  }

  console.log(`[market_memory] collector started — every ${Math.round(intervalMs / 60000)}min, retention ${retentionDays}d, liquidations ${options.liquidationTracking?.enabled ? 'ON' : 'OFF'}`);
}

function stopCollector() {
  if (collectorTimer) clearInterval(collectorTimer);
  if (cloudSyncTimer) clearInterval(cloudSyncTimer);
  collectorTimer = null;
  cloudSyncTimer = null;
  stopLiquidationCollector();
}

function getStatus() {
  let diskUsageBytes = 0;
  let fileCount = 0;
  if (fs.existsSync(DATA_ROOT)) {
    for (const symbol of fs.readdirSync(DATA_ROOT)) {
      const dir = symbolDir(symbol);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        diskUsageBytes += fs.statSync(path.join(dir, file)).size;
        fileCount++;
      }
    }
  }
  let liqDiskUsageBytes = 0, liqFileCount = 0;
  if (fs.existsSync(LIQ_DATA_ROOT)) {
    for (const symbol of fs.readdirSync(LIQ_DATA_ROOT)) {
      const dir = liqSymbolDir(symbol);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        liqDiskUsageBytes += fs.statSync(path.join(dir, file)).size;
        liqFileCount++;
      }
    }
  }
  return {
    running: !!collectorTimer,
    lastRunAt,
    lastRunResults,
    diskUsageBytes,
    diskUsageMB: round(diskUsageBytes / (1024 * 1024)),
    fileCount,
    liquidationTracking: {
      running: !!liqWs,
      diskUsageMB: round(liqDiskUsageBytes / (1024 * 1024)),
      fileCount: liqFileCount,
    },
  };
}

module.exports = {
  collectSnapshot,
  runCollectionPass,
  getRecentContext,
  cleanupOldData,
  syncToCloud,
  startCollector,
  stopCollector,
  getStatus,
  getLiquidationClusters, // NEW
};
