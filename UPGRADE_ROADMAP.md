# InvestySignals — Upgrade Roadmap (Master List)

Everything discussed so far, organized by category. ✅ = already built and
deployed. ⏳ = discussed, not built yet. Priority is my honest opinion,
not a rule — adjust to what matters most to you.

---

## ✅ Already Done

**Reliability/bug fixes:** Groq JSON parse retry, OI/Funding via market_tools,
memory leak cleanup, wick-aware TP/SL, stale-entry fix, infinite-pending fix,
strict break-even fix.

**Market Memory:** 24/7 collector, wired into deep-analysis, admin settings,
cloud backup via rclone.

**View Chart page:** candlestick + volume, lazy history, timeframe switcher,
S/R (role-labeled), FVG, Order Blocks (+ filled-box plugin), Fibonacci
Ret/Ext, ICT Premium/Discount, Liquidity Sweep, BOS/CHoCH, RSI Divergence,
layer "found" counts, Market Context panel, Multi-Timeframe panel, AI
Report panel.

**This session's batch:**
- ✅ #1 OTE Zone (ICT Optimal Trade Entry, 61.8-78.6% Fib) — chart layer + confluence score bonus
- ✅ #2 Equal Highs/Equal Lows (EQH/EQL) — chart layer, time-bounded
- ✅ #6 Long/Short Ratio → production (confluence scoring + prompt context)
- ✅ #7 Fear & Greed → production (confluence scoring + prompt context)
- ✅ #13 RVOL (Relative Volume vs coin's own 20-day average) — `/api/scan`
- ✅ #14 BTC-relative strength — `/api/scan`
- ✅ #19 Risk-based position sizing — `/api/paper/trade` + analysis.html toggle
- ✅ #20 Duplicate trade protection — `/api/paper/trade`, confirm-to-override
- ✅ #22 Groq temperature → 0 (deterministic output)
- ✅ #24 Confluence threshold → admin-configurable (Platform Settings)
- ✅ #23 Thesis Status prominence — verified already first in the render order (no change needed)

---

## 🎯 ICT/SMC Family — same theory, deeper coverage

| # | Item | Status | Priority |
|---|---|---|---|
| 1 | Optimal Trade Entry (OTE) zone | ✅ Done | — |
| 2 | Equal Highs/Equal Lows (EQH/EQL) | ✅ Done | — |
| 3 | Breaker Blocks | ✅ Done | — |
| 4 | Inducement detection | ✅ Done | — |
| 5 | Judas Swing | ✅ Done | — |
| 6 | Power of 3 (AMD Model) | ✅ Done | — |

---

## 📊 Leading / Anticipatory Market Data

| # | Item | Status | Priority |
|---|---|---|---|
| 7 | VWAP + Deviation Bands | ✅ Done | — |
| 8 | Liquidation Cluster → production | ✅ Done | — |
| 9 | Volume Profile / POC | ✅ Done | — |
| 10 | VSA (Volume Spread Analysis) | ✅ Done | — |
| 11 | Long/Short Ratio → production | ✅ Done | — |
| 12 | Fear & Greed → production | ✅ Done | — |

---

## 🎯 Scan Quality

| # | Item | Status | Priority |
|---|---|---|---|
| 13 | Relative Volume (RVOL) | ✅ Done | — |
| 14 | BTC-relative strength | ✅ Done | — |
| 15 | Real bid-ask spread check | ✅ Done | — |
| 16 | Single-candle-spike filter | ✅ Done | — |
| 17 | Already-in-position badge | ✅ Done | — |
| 18 | News cross-check on scan results | ✅ Done | — |

---

## ⚖️ Risk Management

| # | Item | Status | Priority |
|---|---|---|---|
| 19 | Risk-based position sizing | ✅ Done | — |
| 20 | Duplicate trade protection | ✅ Done | — |
| 21 | Signal outcome tracking / feedback loop | ✅ Done — see 🚨 critical bug note in changelog | — |

---

## 🔧 Consistency / Reliability

| # | Item | Status |
|---|---|---|
| 22 | Groq temperature → 0 | ✅ Done |
| 23 | Thesis Status prominence | ✅ Verified already correct |
| 24 | Confluence threshold → admin-configurable | ✅ Done |

---

## ❌ Discussed and NOT Recommended (for the record, with why)

- **Order Flow Trading** — needs orderbook depth streaming, high complexity/cost, minimal edge for a retail-level system
- **Wyckoff Theory** — weeks/months time horizon, mismatched with your M15-entry day-trading design
- **Vector DB / semantic search** — your data is structured/numeric, not text-heavy; no real benefit
- **AI self-derived rules ("let the AI invent its own strategy")** — unvalidatable, overfitting risk, loses explainability
- **"Reverse-engineer pro traders"** — no reliable data source exists for this
- **Classic chart pattern recognition (Triangle/H&S/Flag)** — subjective, hard to code reliably; ICT/SMC's OB/FVG/S/R already captures the same underlying structure more reliably

---

## What's left, in my priority order

1. **Signal outcome tracking (#21)** — the single most valuable remaining item; turns the whole system from "I believe ICT/SMC works" into a provable number
2. **VWAP + Liquidation Cluster (#7, #8)** — both genuinely "leading" data, both fit the existing ICT/SMC philosophy
3. **Already-in-position badge (#17)** — cheap, the data already exists
4. **Breaker Blocks + Inducement (#3, #4)** — natural ICT/SMC extensions of code you already have
5. Everything else — lower urgency, take as you have appetite for it

This was a large batch — tell me which of the remaining items to pick up next, or say "continue" and I'll keep going down this same priority list.

