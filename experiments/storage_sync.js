/**
 * ════════════════════════════════════════════════════════════════════════
 *  experiments/storage_sync.js
 * ────────────────────────────────────────────────────────────────────────
 *  STANDALONE helper — wraps the `rclone` command-line tool so collected
 *  experiment data (liquidations, snapshots, etc.) can live on FREE cloud
 *  storage (Google Drive / Mega both give free tiers) instead of eating
 *  your VPS's disk. Data comes back down to the VPS only when you actually
 *  need it (e.g. running a backtest over 3 months of liquidation data).
 *
 *  WHY rclone INSTEAD OF WRITING A CUSTOM GOOGLE DRIVE / MEGA API CLIENT
 *  rclone already handles OAuth, chunked uploads, retries, and both
 *  providers (and ~70 others) with one consistent interface. Writing our
 *  own OAuth flow in Node would be a lot of fragile code for something a
 *  battle-tested CLI tool already solves. This file just shells out to it.
 *
 *  ── ONE-TIME SETUP ON YOUR VPS (do this once, manually) ──────────────
 *    1. Install rclone:        curl https://rclone.org/install.sh | sudo bash
 *    2. Configure a remote:    rclone config
 *         - choose "n" (new remote), name it e.g.  gdrive   or   mega
 *         - pick the "drive" (Google Drive) or "mega" storage type
 *         - follow the prompts (Google Drive needs a browser step once —
 *           rclone prints a URL/code you approve from your phone/PC)
 *    3. Test it manually:      rclone lsd gdrive:
 *         (should list your Drive's folders — if this works, the code
 *         below will work too)
 *
 *  Once that's done, set REMOTE_NAME below (or via env var) to match
 *  whatever name you gave it in step 2.
 *
 *  HOW TO TEST STANDALONE
 *    node experiments/storage_sync.js upload ./experiments/data/liquidations/2026-07-08.jsonl
 *    node experiments/storage_sync.js download 2026-07-08.jsonl ./restored/
 * ════════════════════════════════════════════════════════════════════════
 */

'use strict';

const { execFile } = require('child_process');
const path = require('path');

const REMOTE_NAME = process.env.RCLONE_REMOTE || 'gdrive'; // must match `rclone config` name
const REMOTE_FOLDER = process.env.RCLONE_FOLDER || 'InvestySignals-experiments';

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('rclone', args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`rclone ${args[0]} failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * uploadFile(localPath)
 * Copies one local file up to remote:REMOTE_FOLDER/. Safe to call on a
 * file that's still being appended to elsewhere — rclone copy reads the
 * file at call time; just don't call it mid-write from the SAME process.
 */
async function uploadFile(localPath) {
  const dest = `${REMOTE_NAME}:${REMOTE_FOLDER}`;
  await run(['copy', localPath, dest, '--progress=false']);
  return { uploaded: localPath, to: dest };
}

/**
 * deleteLocalAfterUpload(localPath)
 * Call this ONLY after uploadFile() resolves successfully, to reclaim
 * VPS disk space. Kept as an explicit separate step on purpose — never
 * auto-delete inside uploadFile() itself, so a failed upload can never
 * silently lose data.
 */
function deleteLocalAfterUpload(localPath) {
  const fs = require('fs');
  fs.unlinkSync(localPath);
  return { deleted: localPath };
}

/**
 * downloadFile(remoteFileName, localDir)
 * Pulls one file (e.g. a specific day's liquidations) back down from the
 * remote into localDir, e.g. right before running a backtest that needs
 * that day's data.
 */
async function downloadFile(remoteFileName, localDir) {
  const src = `${REMOTE_NAME}:${REMOTE_FOLDER}/${remoteFileName}`;
  const fs = require('fs');
  fs.mkdirSync(localDir, { recursive: true });
  await run(['copy', src, localDir, '--progress=false']);
  return { downloaded: remoteFileName, to: path.join(localDir, remoteFileName) };
}

/**
 * downloadRange(fromDate, toDate, localDir)
 * Pulls all liquidation files between two YYYY-MM-DD dates (inclusive)
 * back down — useful before a multi-week backtest run.
 */
async function downloadRange(fromDate, toDate, localDir) {
  const results = [];
  const cur = new Date(fromDate);
  const end = new Date(toDate);
  while (cur <= end) {
    const name = `${cur.toISOString().slice(0, 10)}.jsonl`;
    try {
      results.push(await downloadFile(name, localDir));
    } catch (e) {
      results.push({ skipped: name, reason: e.message });
    }
    cur.setDate(cur.getDate() + 1);
  }
  return results;
}

module.exports = { uploadFile, deleteLocalAfterUpload, downloadFile, downloadRange };

if (require.main === module) {
  const [, , cmd, a, b] = process.argv;
  (async () => {
    try {
      if (cmd === 'upload') {
        console.log(JSON.stringify(await uploadFile(a), null, 2));
      } else if (cmd === 'download') {
        console.log(JSON.stringify(await downloadFile(a, b || './restored'), null, 2));
      } else {
        console.log('Usage:\n  node storage_sync.js upload <localFile>\n  node storage_sync.js download <remoteFileName> <localDir>');
      }
    } catch (e) {
      console.error('FAILED:', e.message);
      process.exit(1);
    }
  })();
}
