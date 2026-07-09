/**
 * ════════════════════════════════════════════════════════════════════════
 *  experiments/liquidation_tracker.js
 * ────────────────────────────────────────────────────────────────────────
 *  STANDALONE experiment module. Uses the `ws` package (already a project
 *  dependency in package.json) but does NOT touch server.js's WebSocketServer
 *  — this opens its OWN outbound client connection to Binance, completely
 *  separate from the app's client-facing WebSocket.
 *
 *  WHAT THIS DOES
 *  Connects to Binance Futures' public liquidation stream
 *  (wss://fstream.binance.com/ws/!forceOrder@arr) and appends every forced
 *  liquidation order to a local, DATE-ROTATED file:
 *      experiments/data/liquidations/YYYY-MM-DD.jsonl
 *
 *  WHY A LOCAL FILE, NOT A DB WRITE
 *  This is a test/experiment stage — writing to a flat file means zero risk
 *  to your production MongoDB collections (Signal, PaperTrade, etc.). Once
 *  you decide the data is useful, promoting it to a real Mongo collection
 *  is a small, separate step.
 *
 *  STORAGE NOTE
 *  Liquidation volume can add up over weeks. Pair this with
 *  experiments/storage_sync.js to push each COMPLETED day's file to your
 *  free cloud remote (Google Drive / Mega via rclone) and delete the local
 *  copy — see that file's header for setup. This script itself only ever
 *  writes to disk; it does not reach into your cloud storage.
 *
 *  HOW TO TEST STANDALONE (runs until Ctrl+C)
 *    node experiments/liquidation_tracker.js
 *    node experiments/liquidation_tracker.js BTCUSDT   ← filter one symbol
 * ════════════════════════════════════════════════════════════════════════
 */

'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const STREAM_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const DATA_DIR = path.join(__dirname, 'data', 'liquidations');
const RECONNECT_DELAY_MS = 5000;

function todayFileName() {
  const d = new Date();
  const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return path.join(DATA_DIR, `${iso}.jsonl`);
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Parse Binance's raw forceOrder payload into a compact, useful record. */
function parseLiquidation(msg) {
  const o = msg.o; // Binance nests the order fields under "o"
  if (!o) return null;
  return {
    symbol: o.s,
    side: o.S,              // 'BUY' liquidation = shorts being closed, 'SELL' = longs being closed
    price: parseFloat(o.p),
    qty: parseFloat(o.q),
    usdValue: round(parseFloat(o.p) * parseFloat(o.q)),
    orderStatus: o.X,
    tradeTime: new Date(o.T).toISOString(),
  };
}

function round(v) {
  return Math.round(v * 100) / 100;
}

function appendRecord(record) {
  ensureDataDir();
  fs.appendFileSync(todayFileName(), JSON.stringify(record) + '\n');
}

/**
 * startLiquidationTracker(symbolFilter)
 *   symbolFilter: optional, e.g. 'BTCUSDT' — if omitted, records ALL symbols
 *                 (higher volume, more storage — filter if you only care
 *                 about a handful of pinned coins).
 * Returns a handle with .stop() to close the connection cleanly.
 */
function startLiquidationTracker(symbolFilter = null, onRecord = null) {
  let ws;
  let stopped = false;

  function connect() {
    ws = new WebSocket(STREAM_URL);

    ws.on('open', () => {
      console.log(`[liquidation_tracker] connected${symbolFilter ? ` (filter: ${symbolFilter})` : ' (all symbols)'}`);
    });

    ws.on('message', (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }
      const record = parseLiquidation(payload);
      if (!record) return;
      if (symbolFilter && record.symbol !== symbolFilter) return;

      appendRecord(record);
      if (onRecord) onRecord(record);
    });

    ws.on('close', () => {
      if (!stopped) {
        console.log(`[liquidation_tracker] disconnected — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
        setTimeout(connect, RECONNECT_DELAY_MS);
      }
    });

    ws.on('error', (err) => {
      console.error('[liquidation_tracker] error:', err.message);
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (ws) ws.close();
    },
  };
}

module.exports = { startLiquidationTracker };

if (require.main === module) {
  const symbolFilter = process.argv[2] || null;
  console.log('[liquidation_tracker] starting standalone test — press Ctrl+C to stop');
  const handle = startLiquidationTracker(symbolFilter, (record) => {
    console.log(`[LIQUIDATION] ${record.symbol} ${record.side} $${record.usdValue} @ ${record.price}`);
  });

  process.on('SIGINT', () => {
    console.log('\n[liquidation_tracker] stopping...');
    handle.stop();
    process.exit(0);
  });
}
