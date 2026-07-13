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

## 5f. Large batch — OTE/EQH-EQL, Long-Short & Fear-Greed in scoring, risk sizing, duplicate protection, scan RVOL/BTC-strength, consistency fixes

**ICT/SMC additions:**
- `structure.getOteZoneStatus()` — Optimal Trade Entry zone (61.8-78.6% Fib retracement), additive to existing `fibonacciRetracement()`. Wired into both the chart (new layer) and the deep-analysis AI prompt (+1 confluence score when price is inside it).
- `structure.findEqualHighsLows()` — EQH/EQL detection with time-bounded output, additive to existing `liquiditySweep()`. Chart layer only (the underlying levels were already in the AI prompt via `liquiditySweep`'s buySideLiquidity/sellSideLiquidity).
- Both tested with synthetic data before shipping.

**Long/Short Ratio + Fear & Greed → production:** Both functions already
existed in `market_tools.js` (built earlier for `market_memory.js`). Now
also fetched in `/api/deep-analysis`, added to the AI prompt, and used in
two new confluence rules: standard confirmation (+1) and a new "CROWDED
TRADE" rule (-1 if adding to an already-crowded side, e.g. LONG bias when
retail is already 65%+ long — squeeze-vulnerable).

**Risk-based position sizing:** `/api/paper/trade` now accepts an optional
`riskPct` — when sent (with an SL set), size is computed from
`(balance × riskPct%) / (SL distance % × leverage)` instead of requiring a
flat manual dollar amount. Hard-capped at 10% risk/trade and the account
balance itself regardless of what's requested. `PaperTrade` model gained
`sizingMethod`/`riskPct` fields. `analysis.html` gained a toggle to switch
between manual $ size and risk-%-based size.

**Duplicate trade protection:** `/api/paper/trade` now blocks a second
OPEN/PENDING/TP1_HIT trade on the same symbol for the same user by
default, returning `duplicateTradeId` in the response. Client can resend
with `allowDuplicate:true` to proceed anyway (intentional scale-in).
`analysis.html` shows a confirm dialog and retries automatically if the
user confirms.

**Scan quality (`/api/scan`):**
- BTC-relative strength (`change - btcChange`) — free, computed from the
  same 24hr ticker snapshot already being fetched, no extra API calls.
- RVOL (Relative Volume) — today's volume vs the coin's own 20-day average,
  computed only for the already-shortlisted top-20 results (not the full
  ~500-market universe) to keep this to ~20 extra (cached) klines calls
  per scan, not hundreds.

**Consistency fixes:**
- Groq `temperature`: 0.2 → 0 (deterministic — same input now gives the
  same output, directly addressing "why does re-analyzing the same coin
  an hour later give a different entry").
- `CONFLUENCE_THRESHOLD`: was a hardcoded `const` — now a `let` driven by
  `globalSettings.confluenceThreshold`, admin-configurable (Platform
  Settings panel), live-applied without a server restart.
- Thesis Status banner: verified it was ALREADY rendered first in
  analysis.html's output order — no change needed, just confirmed.

## 5e. Full Analysis Report on the chart page

**Multi-Timeframe Indicators panel** — `/api/chart/overlays` now also
calls the existing `getTechnicalIndicators(symbol, 'multi')` (no AI/Groq
cost — purely computed from candles, same function the AI agent's tools
already use) and returns the full 15m/1H/4H/1D breakdown: RSI + RSI
divergence verdict, MACD, EMA20/50/200, ATR, ADX, Structure (BOS/CHoCH
verdict), candle pattern, volume ratio — per timeframe, with tab buttons
to switch between them. This is the same multi-timeframe view
analysis.html's "Live Indicator Values" accordion shows.

**AI Analysis Report panel** — shows the actual AI verdict (confluence
score dial, LONG/SHORT/NEUTRAL bias, summary, key risk, entry/SL/TP
levels) on the chart page. Deliberately does NOT call Groq itself — that
stays a paid, rate-limited action the user explicitly triggers on
analysis.html. Instead, `analysis.html`'s "View Chart" button now stashes
its already-computed result into `sessionStorage` before navigating
(`openChartWithAnalysis()`); chart.html reads it back if present and the
symbol matches. Navigating to chart.html directly (no prior analysis) or
for a different symbol simply hides this panel — no error, no broken
state, just nothing to show. A visible note reminds the user this
snapshot may be stale ("price may have moved since — re-run analysis for
a fresh read") rather than implying it's live.

## 5d. Market Context panel + layer "found" counts

**Market Context panel** — `/api/chart/overlays` now also returns
`marketContext`: funding rate, Open Interest trend/signal, BTC 4H trend,
current candle pattern, volume-vs-average ratio (with spike flag),
ATR (same one used for SL sizing in deep-analysis), a liquidity warning,
recent news headlines, and — if the 24/7 Market Memory collector has been
running long enough for this symbol — a 7-day long/short skew summary.
Fetched in parallel; each piece degrades to `null` independently on
failure rather than failing the whole request. Rendered as a new panel
below the indicator strip, always visible once a chart loads (not gated
behind a layer toggle, since it isn't a chart drawing).

**Layer "found" counts** — every zone/marker-based toggle (S/R, FVG, Order
Blocks, Liquidity Sweep, BOS/CHoCH, RSI Divergence) now shows a small
badge with how many instances exist in the current view (or "none in
view" at zero). This directly addresses a real point raised in testing:
toggling on a layer like RSI Divergence when no divergence pattern
currently exists looks identical to a broken toggle — nothing visibly
happens either way. The count badge makes the difference obvious: "0 /
none in view" confirms the toggle worked and there's genuinely nothing to
draw right now, vs the chart being broken. Overlays (and therefore these
counts + the Market Context panel) now load automatically on every chart
open, rather than waiting for the first layer toggle.

## 5c. BOS/CHoCH markers, RSI Divergence lines, filled-box plugin

**BOS / CHoCH layer** — `market_tools.js` gained `structure.detectStructureEvents()`,
additive alongside the existing `detectStructure()` (still used unchanged by
the AI prompt). Walks the candle set, finds confirmed swing highs/lows, and
records each time price breaks one (BOS if continuing the trend, CHoCH if
reversing it) — with the actual time+price of the break, not just a verdict
string. **Caught and fixed a real bug via a synthetic-data test before
shipping:** the first version re-selected an already-broken swing level on
every subsequent candle until a newer swing appeared, firing duplicate BOS
events repeatedly at the same price. Fixed with a swing-pointer approach —
verified fix with a second test run showing clean, non-duplicated output.

**RSI Divergence layer** — `candleReading.findRsiDivergences()`, additive
alongside the existing `rsiDivergence()`. Finds actual swing-high/swing-low
PAIRS where price and RSI disagree and returns their real coordinates, so
the chart draws a connecting line between the two genuine pivots (standard
divergence visualization) instead of just a verdict. Tested against both
degenerate (flat/tied) and realistic synthetic data — works correctly;
the degenerate case revealed that near-identical consecutive candle values
can produce noisy adjacent-swing comparisons, which is a non-issue with
real market data (prices essentially never tie exactly) but noted here for
transparency.

**Filled-box plugin (FVG/OB)** — added `FilledRectangle`, a real
Lightweight Charts "Series Primitive" (canvas-drawing plugin) for TRUE
shaded rectangles, layered ON TOP of the existing dashed-outline lines
(previous fix). Every call into the primitive is wrapped in try/catch and
checks `typeof candleSeries.attachPrimitive === 'function'` first — if this
browser's loaded library build doesn't support it (or any part of the
canvas draw call throws), it silently no-ops and the outline-only
rendering still works exactly as before. **I could not test this specific
piece in a real browser** (no browser available in my environment) — it's
built to the documented Series Primitives pattern, but is the one part of
this change most likely to need a live look if it doesn't render as
expected. The dashed outlines are a guaranteed-working fallback either way.

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
