# InvestySignals — Upgrade Changelog & Setup Guide

This upgrade adds a **24/7 "Market Memory" historical collector**, wires it
into your real analysis flow, fixes concrete bugs found in
`/api/deep-analysis`, and adds admin-panel controls for all of it. Your
existing ICT/SMC rule engine is untouched — this is additive.

## 1. What's NEW

### `market_memory.js` (new file)
Background service that wakes up every N minutes (default 15) and, for
each tracked symbol, snapshots: retail long/short positioning, Fear &
Greed Index, funding rate, Open Interest trend. Saved to
`data/market_memory/<SYMBOL>/<date>.jsonl`. Old files auto-delete after
the configured retention period (default 30 days).

`getRecentContext(symbol, days)` reads the last N days and produces a
plain-language summary that gets folded into the AI prompt in
`/api/deep-analysis` — e.g. "retail has been LONG_HEAVY 80% of the time
this week while price fell" — as an extra **confirmation** signal
alongside your existing ICT/SMC confluence scoring. It never overrides
the rule engine; it's additional context the AI is told to use only as
confirmation.

### `market_tools.js` (updated)
Added two new reusable data functions (same reliability pattern as the
rest of the file — retries, timeouts, caching):
- `data.getLongShortRatio(symbol)`
- `data.getFearGreedIndex()`

### `server.js` (updated) — bug fixes + new integration
1. **Groq JSON parse reliability** — the #1 cause of "analysis failed"
   errors. Previously, if the AI's JSON response was truncated or had
   stray text around it, the whole request failed immediately. Now: try
   parse → repair (extract outer `{...}`) → one retry with a stricter
   prompt reminder → only then error out.
2. **Open Interest / Funding Rate** — previously duplicated with raw
   `fetch()` calls (no retry, no shared rate-limiting with the rest of
   the app). Now routed through `market_tools.js`'s bulletproof versions.
3. **Memory leak prevention** — `klinesCache`, `priceCache`, `thesisState`
   never deleted expired entries (only ignored them on read), so they'd
   grow forever on a long-running VPS process. Added a 30-min sweep.
4. **Market Memory integration** — `/api/deep-analysis` now calls
   `marketMemory.getRecentContext()` and includes it in the AI prompt and
   in the JSON response (`marketMemory` field) for the frontend to show
   if you want to display it.
5. **New admin settings + routes** for all of the above (see below).
6. Collector auto-starts after Mongo connects (VPS only — see note below).

### `admin.html` (updated)
New "📡 Market Memory" settings panel: enable/disable, tracked symbols,
snapshot interval, retention days, cloud backup toggle + rclone remote
name, plus a live status box (running/not, last run, disk usage).

### `experiments/` (from earlier session, included here too)
Standalone test scripts (`longshort_ratio.js`, `fear_greed.js`,
`liquidation_tracker.js`, `test_runner.js`, `storage_sync.js`) — kept as
independent sandbox tools. Not required for the above; useful if you want
to manually explore liquidation data further.

## 2. IMPORTANT — Vercel vs VPS

The Market Memory collector uses `setInterval`, which only makes sense on
an **always-on process**. If `process.env.VERCEL` is set, the collector
will NOT start (serverless functions don't have a persistent process for
a timer to live in) — the admin panel will show a warning banner in that
case. On your VPS (always-on Node process), it works as intended.

## 3. Deploying

1. Review `server_js_changes.diff` style — actually just diff this whole
   folder against your current deployed copy before overwriting, in case
   you've made manual changes since the version you gave me.
2. Your `.env` and `serviceAccount.json` are included unchanged from what
   you gave me — double check they're still your current, correct values
   before deploying.
3. Restart your Node process after deploying (`pm2 restart all` or
   equivalent) so the new collector + routes take effect.
4. Open Admin Panel → Market Memory panel, confirm it shows "🟢 running".
   It needs a few collection cycles (a few hours) before
   `getRecentContext()` has enough data to contribute to analysis —
   until then it just contributes nothing (same as before this feature).

## 4. Cloud backup setup (Mega, via rclone) — OPTIONAL

You have 200GB on the VPS, so this is a **backup**, not a requirement —
skip it if you don't want the extra moving part.

```bash
# One-time, on your VPS:
curl https://rclone.org/install.sh | sudo bash
rclone config
#   → n (new remote)
#   → name it: mega
#   → choose storage type: mega
#   → enter your Mega email + password when prompted
#   → confirm, then test:
rclone lsd mega:
#   (should list your Mega folders — if this works, you're done)
```

Then in Admin Panel → Market Memory:
- Turn on "☁️ Cloud backup"
- Remote name: `mega`
- Save

From then on, once a day, the collector copies all
`data/market_memory/` files to `mega:InvestySignals-market-memory`. Your
local copy on the VPS is kept too — this is a backup, not a move.

## 5a. Paper-Trading Engine Fixes (verified against another AI's bug report)

A second AI's review flagged 4 issues in the paper-trade close/monitor loop.
I checked each claim against the actual code before touching anything —
all 4 were real, verified bugs. Fixed:

**Bug #1 — "Wick Miss"** (TP/SL loop only checked ticker price): `runTPSLCheck`
polled a single last-trade price every 30s — a spike through a TP/SL level
that reversed between polls was invisible. Fixed with `getRecentHighLowRange()`
— a fresh, never-cached 1m-candle high/low fetch — used for all TP1/TP2/SL/
limit-fill checks now.

**Bug #2 — "Stale Entry"** (5-min kline cache used for the entry timeframe):
`fetchKlinesCached` gained a `skipCacheRead` option; M15 (entry timeframe)
now always fetches fresh. H1/H4/D1 stay cached on purpose — caching them
avoids hammering Binance on every analysis request (a blanket "remove all
caching" would reintroduce the rate-limit risk fixed earlier).

**Bug #3 — "Infinite Pending"** (LIMIT orders never expired): LIMIT paper
trades now get an `expiresAt` (default 4h, admin-configurable — Admin Panel
→ Platform Settings → "Limit Order Expiry"); `runTPSLCheck` auto-cancels +
refunds expired ones.

**Bug #4 — "Strict Break-Even"** (SL moved to exact entry price on TP1): SL
now moves to entry ± a buffer — preferring the real 1H ATR captured at
trade-open time (`entryAtr`), falling back to a live 1m-range proxy.

**Known remaining limitation (disclosed, not hidden):** if one 1m-candle
wick is wide enough to touch both a TP and the SL in the same 3-candle
window, the code checks TP before SL (optimistic order) — true tick-by-tick
ordering isn't knowable from 1m candles alone.

## 5b. View Chart Feature (TradingView-style candlestick chart, self-hosted)

New `chart.html` page — a candlestick chart **inside your own site** (not
an embed of tradingview.com — we have no way to inject into that site;
this uses TradingView's open-source **Lightweight Charts** library, self-
hosted, drawing our own candles + our own overlay data).

**How to reach it:** "📊 View Chart" button next to the "Open Paper Trade"
button in `analysis.html`.

**What it does:**
- Full candlestick + volume chart, timeframe switcher (1m/5m/15m/1H/4H/1D)
- Lazy-loads older history as you scroll left (stops automatically once
  it hits the coin's Binance listing date — Binance has no data before that)
- Toggleable overlay layers, each independently switchable: Support/
  Resistance, Fair Value Gaps, Order Blocks, Fibonacci Retracement,
  Fibonacci Extension, ICT Premium/Discount zone, Liquidity Sweep markers
  — plus a live Kill Zone status badge
- All overlay data comes from the **same `market_tools.js` functions the
  AI analysis itself uses** — the chart shows exactly what the AI saw,
  not a separately-maintained approximation

**New backend routes** (`server.js`, public/no-auth, same as `/api/scan`
— deliberately do NOT call Groq, so flipping timeframes/layers stays fast
and free):
- `GET /api/chart/candles?symbol=&interval=&limit=&endTime=` — paginated
  klines (historical closed candles are cached forever since they never
  change; the live/latest page is cached 15s)
- `GET /api/chart/overlays?symbol=&interval=` — computed ICT/SMC/Fibonacci
  data for the current view

**Known simplification (disclosed):** Lightweight Charts has no native
filled-rectangle primitive without a canvas plugin. FVG/Order Block
"zones" are drawn as a dashed top+bottom price-line pair rather than a
shaded box. Visually clear, but not a true filled rectangle — a canvas
overlay plugin could add that later if wanted.

## 5. What was NOT changed

- Your ICT/SMC rule engine (Kill Zones, Premium/Discount, Liquidity
  Sweep, Fib Extensions) — untouched, still the core of every analysis.
- Confluence threshold logic, thesis tracking, early warnings — untouched.
- `/api/analysis` (a separate, simpler legacy endpoint not used by
  analysis.html) — left as-is, low priority, flagged for a future pass
  if you want it cleaned up too.
- `ai_agent.js` (the chat-based AI agent with its 5 tools) — untouched in
  this pass; syntax-checked only. A deeper review of that file and
  `backtest_engine.js` can be a separate next step if you want it.
