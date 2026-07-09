# Experiments — isolated testing, zero risk to production

This folder is **completely separate** from your live app. Nothing here is
imported by `server.js`, `ai_agent.js`, `market_tools.js`, or
`backtest_engine.js`. You can delete this whole folder any time with no
effect on the running site.

## Files

| File | What it does |
|---|---|
| `longshort_ratio.js` | Fetches Binance's long/short account ratio for a symbol |
| `fear_greed.js` | Fetches the Crypto Fear & Greed Index |
| `liquidation_tracker.js` | Listens to Binance's live liquidation stream, saves to local `.jsonl` files (date-rotated) |
| `storage_sync.js` | Pushes/pulls those `.jsonl` files to free cloud storage (Google Drive / Mega) via `rclone`, so your VPS disk doesn't fill up |
| `test_runner.js` | Runs all three data checks together and prints results |

## Quick test (on your VPS or locally, needs internet + the `ws` package already in package.json)

```bash
node experiments/test_runner.js
node experiments/test_runner.js BTC,ETH,SOL 15
```

This prints long/short skew, fear & greed value, and listens for
liquidations for N seconds — nothing is written to Mongo, nothing touches
the live site.

## Storage setup (only needed once you start letting the liquidation
tracker run for real, for days/weeks)

1. `curl https://rclone.org/install.sh | sudo bash`
2. `rclone config` → new remote → name it `gdrive` (or `mega`) → follow the
   Google Drive / Mega OAuth prompts
3. Test: `rclone lsd gdrive:` should list your Drive folders
4. Then:
   ```bash
   node experiments/storage_sync.js upload ./experiments/data/liquidations/2026-07-08.jsonl
   ```
5. To pull data back down before a backtest:
   ```js
   const { downloadRange } = require('./experiments/storage_sync');
   await downloadRange('2026-07-01', '2026-07-08', './experiments/restored');
   ```

Recommended pattern once you trust it: a daily cron job that, right after
midnight UTC (once yesterday's `.jsonl` file is complete), calls
`uploadFile()` then `deleteLocalAfterUpload()` — so the VPS only ever
holds ~1 day of raw liquidation data at a time.

## When to actually merge this into the real app

Only merge into `market_tools.js` / `backtest_engine.js` / Mongo once **all**
of these are true:

- [ ] Ran `test_runner.js` for a few days — no repeated API failures
- [ ] Long/short + fear&greed values look sane compared to what you see on
      other sites (sanity check by eye)
- [ ] Built a duplicate `backtest_v2.js` that adds these as extra
      confluence factors, and it shows a **meaningfully** better out-of-sample
      win rate / profit factor than the existing `backtest_engine.js` —
      not just a few % (that's noise territory, per your own engine's
      `NOT_VALIDATED` logic)

If any of those isn't true yet, keep it here in `experiments/` and keep
testing. The existing ICT/SMC rule engine stays exactly as-is and keeps
running in production the whole time either way.
