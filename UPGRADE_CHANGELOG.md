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

## 5l. Merged in your own addition: manual user registration

You added `POST /api/admin/users` (creates a Firebase Auth account + the
matching MongoDB user in one step — works even when public
self-registration is turned off, with automatic rollback of the Firebase
account if the MongoDB write fails). Your uploaded file was based on the
version before the "Invalid time value" fix (5k), so merging it in
directly would have silently reverted that fix — instead, your new route
was inserted into the latest version so both are present together.

**Bonus:** noticed `admin.html` already had a "+ Add User" button that
was never wired to anything (no `onclick` at all). Since your new
endpoint is exactly what that button was clearly meant to call, wired it
up with a small modal (email/password/display name/plan) so the feature
is actually usable end-to-end now, not just a backend route with no UI.

## 5k. 🚨 Critical production bug — "Invalid time value" crashing analysis

**Reported:** analyzing BANK/USDT (and any coin) threw "Invalid time
value" instead of returning a result.

**Root cause:** `_da_klines()` — the function that builds every candle
array (`m15c`, `h1c`, `h4c`, `d1c`) used throughout `/api/deep-analysis`
— never included a `.time` field on its returned candle objects. This
went unnoticed through five batches of ICT/SMC additions because most of
those functions (Judas Swing, Power of 3, EQH/EQL, Inducement, Breaker
Blocks) just do comparisons against `c.time` — with `c.time` undefined,
`undefined >= x` silently evaluates `false` and the functions quietly
returned empty/no-op results. No crash, so no obvious symptom. But
`vwapWithBands()` (added in 5h) does `new Date(c.time * 1000).toISOString()`
per candle to bucket by UTC day — `undefined * 1000 = NaN`, and calling
`.toISOString()` on the resulting Invalid Date throws exactly
`RangeError: Invalid time value`. That's what surfaced.

**Fix (two layers):**
1. **Root cause** — `_da_klines()` now includes `time: Math.floor(k[0]/1000)`
   on every candle, matching the convention already used in the chart
   routes and `market_memory.js`. This doesn't just stop the crash — it
   also makes Judas Swing, Power of 3, EQH/EQL, Inducement, and Breaker
   Blocks actually FUNCTIONAL inside the deep-analysis prompt for the
   first time (they were silently inert before this, a real but quiet
   bug of its own).
2. **Defensive guard** — `vwapWithBands()` now checks
   `candles.every(c => Number.isFinite(c.time))` up front and returns an
   empty/safe result instead of throwing if any future caller has the
   same gap. Verified both layers with an isolated test: old-shape
   candles (no `.time`) now degrade safely; new-shape candles (with
   `.time`) compute VWAP correctly.

Checked whether the raw candle arrays get serialized anywhere else that
adding a new field could bloat (e.g., into the AI prompt directly) —
confirmed they're never `JSON.stringify`'d wholesale, only specific
extracted numeric values are used, so this fix has no token-cost impact.

## 5j. The remaining batch — Volume Profile, VSA, Breaker Blocks, Inducement, Judas Swing, Power of 3, scan spread/spike/news checks

All 9 remaining roadmap items from this session, each tested with
synthetic data before shipping (three had real bugs caught in testing —
detailed below).

**Volume Profile / POC** (`candleReading.volumeProfile`) — buckets the
traded range into price bins, distributing each candle's volume
proportionally across the bins its high-low range spans. Returns the
Point of Control (highest-volume price level) and a 70%-of-volume Value
Area. Tested with concentrated-volume synthetic data — POC landed
correctly in the high-volume zone.

**VSA — Volume Spread Analysis** (`candleReading.volumeSpreadAnalysis`) —
reads volume + spread (high-low range) + close-position-within-bar to
flag climax bars (high volume + wide spread, closing off the extreme)
and no-demand/no-supply bars (low volume + narrow spread). Tested with
crafted selling-climax and no-demand scenarios — both correctly
identified.

**Breaker Blocks** (`structure.findBreakerBlocks`) — an Order Block that
was later invalidated (price closed beyond it) flips role. Deliberately
separate from `findOrderBlocks()`, which filters OUT broken OBs — this
keeps only the ones that WERE broken. **Bug caught in testing:** the
first synthetic test used a down-candle for the bearish-OB candidate,
but the real ICT pattern requires an up-candle (last bullish candle
before a bearish impulse) — this was a test-construction error, not a
logic bug; fixed the test and re-verified against a correctly-built
scenario.

**Inducement** (`structure.findInducement`) — a minor liquidity pool
(fewer touches) forming before a larger one of the same type (EQH/EQL),
the classic "retail gets trapped on the small sweep" pattern. **Real bug
caught in testing:** the first version compared only time-ADJACENT pools
regardless of type, so a different-type pool sitting between two
same-type pools in time hid valid pairs. Fixed by grouping by type first,
then scanning all pairs within each group — re-tested and confirmed.

**Judas Swing** (`structure.findJudasSwing`) — a false breakout right at
London (07:00 UTC) or NY (13:00 UTC) session open that reverses back
through the open price within ~2 hours. Tested with a crafted
sweep-then-reverse scenario at a simulated London open.

**Power of 3 / AMD Model** (`structure.powerOf3Status`) — splits the
current UTC day into Accumulation (00:00-07:00), Manipulation
(07:00-10:00), Distribution (10:00+), and detects whether the
manipulation phase swept the accumulation range. Takes an injectable
`now` parameter (defaults to actual current time in production) — used
to test all three phase branches deterministically, including the
manipulation-sweep detection that real-clock-dependent testing couldn't
reach directly.

All six wired into: (1) the deep-analysis AI prompt as ICT/SMC context
with new confluence rules (Breaker Block confluence, VSA confirmation,
Power of 3 manipulation-phase caution, Judas Swing reversal bias); (2)
new chart layers (Breaker Blocks as bounded boxes, Volume Profile as
POC/Value-Area lines) and a new "🧩 ICT Extras" info panel (Power of 3,
Judas Swing, Inducement, VSA — informational rather than drawable zones).

**Scan quality (`/api/scan`):**
- Real bid-ask spread — `bookTicker` fetch per shortlisted coin (actual
  current spread, not the previous volume/trade-count proxy).
- Single-candle-spike filter — compares the largest single 1H candle's
  % move against the full 24H change; flags when one candle accounts for
  60%+ of the day's move (pump-and-dump risk vs a structured trend).
- News cross-check — top 5 by volume only (news APIs have tighter rate
  limits than Binance), flags `hasRecentNews` + top headline.
- `analysis.html` scan rows now show RVOL/spread/BTC-relative-strength
  inline, plus ⚡ SPIKE and 📰 NEWS badges.

This closes out all 24 items from the original roadmap.

## 5i. Liquidation Cluster → production, and Stop-Hunt-aware SL placement

**User-reported issue investigated:** "SL hits, then price goes back toward
my TP direction" — a real, well-known pattern (stop hunt / liquidity
sweep of retail stops). Root cause: the SL formula (1.5×ATR4H from entry)
is a common-enough convention that many traders/algos land on similar
price levels, which is exactly what a stop-hunt wick targets before
reversing into the real move. This isn't a bug in the wick-detection fix
(5a) — that fix made SL-touch detection MORE accurate, which is correct
and desirable; it just means genuine stop-hunt wicks now get registered
instead of occasionally missed.

**Fix — liquidity-aware SL:** `/api/deep-analysis` now computes the
nearest sell-side/buy-side liquidity pool (from the EQL/EQH data added in
5f) between entry and where the plain ATR formula would place the stop.
New prompt guidance (RULE 2) tells the AI to prefer placing the SL just
beyond that pool instead of the raw ATR distance, when one exists closer
in — giving a stop-hunt wick room to reverse from before it also
invalidates this trade.

**Liquidation Cluster → production (#8):** `market_memory.js` gained a
second, separate collector (`startLiquidationCollector`) — continuous
WebSocket to Binance's public liquidation stream, filtered to tracked
symbols, opt-in via a new admin toggle (different resource profile than
the periodic REST snapshots, kept independently switchable).
`getLiquidationClusters(symbol, hours, currentPrice)` buckets recent
events by price (0.25% buckets) and returns the largest clusters by
total USD value. **Caught a real bug via testing before shipping:** the
first bucketing formula computed bucket width per-row as
`price / (price × pct)`, which always simplifies to the same constant
regardless of price — every liquidation was collapsing into one bucket
no matter its actual price level. Fixed by using a single fixed
reference price for the whole batch; re-tested with synthetic multi-
cluster data to confirm separate clusters are now correctly distinguished.
Wired into the deep-analysis prompt (clusters as plausible TP targets /
SL caution) and a new chart layer (price lines, thickness scaled by
cluster size). New admin toggle: Market Memory panel → "💥 Liquidation
Cluster tracking".

## 5h. VWAP + Bands, Already-In-Position badge

**VWAP + Deviation Bands (#7):** `indicators.vwapWithBands(candles)` —
session-reset daily (UTC midnight), volume-weighted typical price with
±1/±2 standard-deviation bands. Tested with 2-day synthetic data to
confirm the session reset actually resets (not a running average that
drifts across days). Wired into: (1) the deep-analysis AI prompt on the
1H timeframe, with two new confluence rules — a confirmation bonus when
price is on the expected side of VWAP, and an "EXTENSION" caution when
price is beyond the 2nd deviation band; (2) a new chart layer drawing the
full VWAP line + 1st deviation band as real time-series (not a static
level — VWAP moves every candle).

**Already-In-Position badge (#17):** New `verifyTokenOptional` middleware
— tries to verify a Bearer token if one is sent, but NEVER blocks the
request either way, unlike the strict `verifyToken`. Applied to
`/api/scan` (which stays public/unauthenticated by default). When a valid
user token IS present, cross-references the shortlisted scan results
against that user's own active `PaperTrade`s (one cheap indexed query,
not an extra API call) and flags matches with `alreadyInPosition: true`.
`analysis.html` now sends its auth token with the scan request and shows
a "📌 IN POSITION" badge next to any coin the user already has an open
trade on — directly surfaces the double-entry/revenge-trade risk
discussed earlier, using data that already existed.

## 5g. Signal Outcome Tracking — AND a critical bug caught in the process

**🚨 Critical bug found while building this:** `models/PaperTrade.js` was
never actually `require()`'d anywhere — `server.js` defines its own
inline schema (`paperTradeSchema2`) and uses THAT as the real, live
PaperTrade model. Every field I'd added to `models/PaperTrade.js` across
several earlier changes (`entryAtr`, `expiresAt`, `sizingMethod`,
`riskPct`) was being silently dropped by Mongoose on every save — no
error, just quietly never persisted. **Practical impact:** the
Break-Even ATR buffer fix (5c) always fell back to its live-1m-range
proxy instead of the intended stored ATR (not broken, just not using the
preferred value); the Infinite-Pending fix (5a) was unaffected — it
independently computes age from `openedAt` + live settings and never
actually relied on the missing `expiresAt` field. Risk-based sizing (5f)
computed correctly at creation time (not affected) but wasn't recording
its own metadata for audit.

**Fix:** added all the missing fields directly to `paperTradeSchema2` in
`server.js` (the schema actually in use), and added a large warning
comment to the top of `models/PaperTrade.js` explaining it's not live,
so this doesn't happen again. Did not attempt to unify the two files —
`models/PaperTrade.js` is missing several fields the live schema depends
on (`currentSl`, `trailOffset` especially, used by the trailing-stop
logic), so migrating to it is a separate, carefully-tested project of
its own, not something to do as a side effect of this fix.

**Signal Outcome Tracking (the actual feature):** `PaperTrade` now
records `confluenceScore` and `grade` at trade-open time (sent from
analysis.html, sourced from the AI's own analysis result — no extra
computation). New endpoint `GET /api/admin/signal-performance?days=N`
aggregates all `CLOSED` trades with a recorded score into win-rate/P&L
buckets, both by exact confluenceScore (0-10) and by grade (S/A/B/C).
New Admin Panel section "📈 Signal Performance" renders this as two
tables. Only counts trades that closed AFTER this feature was deployed
(older trades have no recorded score and are correctly excluded, not
miscounted) — the panel says so explicitly when there's no data yet.

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
