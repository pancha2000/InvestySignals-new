/**
 * ════════════════════════════════════════════════════════════════════════
 *  experiments/test_runner.js
 * ────────────────────────────────────────────────────────────────────────
 *  One command to sanity-check every experiment module together.
 *  Touches ZERO production files (server.js, ai_agent.js, market_tools.js,
 *  backtest_engine.js, or any Mongo collection). Pure read-only checks.
 *
 *  RUN
 *    node experiments/test_runner.js
 *    node experiments/test_runner.js BTC,ETH,SOL       ← custom symbol list
 *    node experiments/test_runner.js BTC,ETH 15         ← + 15s liquidation listen
 * ════════════════════════════════════════════════════════════════════════
 */

'use strict';

const { getLongShortRatio } = require('./longshort_ratio');
const { getFearGreedIndex } = require('./fear_greed');
const { startLiquidationTracker } = require('./liquidation_tracker');

const symbols = (process.argv[2] || 'BTC,ETH').split(',').map((s) => `${s.trim().toUpperCase()}USDT`);
const liquidationListenSeconds = parseInt(process.argv[3] || '10', 10);

function section(title) {
  console.log('\n' + '─'.repeat(60));
  console.log(title);
  console.log('─'.repeat(60));
}

async function testLongShort() {
  section('1) Long/Short Account Ratio (Binance Futures)');
  for (const symbol of symbols) {
    try {
      const res = await getLongShortRatio(symbol);
      console.log(`  ${symbol}:`, res.error ? `ERROR — ${res.error}` : `${res.skewLabel}  (long ${(res.longAccount * 100).toFixed(1)}% / short ${(res.shortAccount * 100).toFixed(1)}%)`);
    } catch (e) {
      console.log(`  ${symbol}: FAILED — ${e.message}`);
    }
  }
}

async function testFearGreed() {
  section('2) Fear & Greed Index (alternative.me)');
  try {
    const res = await getFearGreedIndex();
    console.log(res.error ? `  ERROR — ${res.error}` : `  ${res.value}/100 — ${res.classification}  (confluence hint: ${res.confluenceHint})`);
  } catch (e) {
    console.log(`  FAILED — ${e.message}`);
  }
}

function testLiquidations() {
  return new Promise((resolve) => {
    section(`3) Liquidation Stream (listening ${liquidationListenSeconds}s, all symbols)`);
    let count = 0;
    const handle = startLiquidationTracker(null, (record) => {
      count++;
      if (count <= 5) {
        console.log(`  [${count}] ${record.symbol} ${record.side} $${record.usdValue}`);
      }
    });
    setTimeout(() => {
      handle.stop();
      console.log(`  → captured ${count} liquidation events in ${liquidationListenSeconds}s (saved to experiments/data/liquidations/)`);
      resolve();
    }, liquidationListenSeconds * 1000);
  });
}

(async () => {
  console.log(`Testing symbols: ${symbols.join(', ')}`);
  await testLongShort();
  await testFearGreed();
  await testLiquidations();
  section('Done — no production files or DB collections were touched.');
})();
