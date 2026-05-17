import { collection, getDocs, limit, orderBy, query } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

import { initSiteChrome } from "./site.js";
import { db } from "./firebase.js";

initSiteChrome();

const list = document.getElementById('signalsList');

async function loadSignals() {
  if (!list) return;
  list.innerHTML = `<div class="hint">Loading signals…</div>`;
  try {
    const q = query(collection(db, 'signals'), orderBy('createdAt', 'desc'), limit(20));
    const snap = await getDocs(q);
    if (snap.empty) {
      list.innerHTML = `<div class="hint">No signals published yet.</div>`;
      return;
    }
    const items = [];
    snap.forEach(d => items.push(d.data()));
    list.innerHTML = items.map(s => {
      const pair = escapeHtml(s.pair || '—');
      const side = escapeHtml(String(s.side || '').toUpperCase() || '—');
      const entry = escapeHtml(s.entry || '—');
      const tp = escapeHtml(s.tp || '—');
      const sl = escapeHtml(s.sl || '—');
      const badgeClass = side === 'LONG' ? 'good' : side === 'SHORT' ? 'bad' : 'warn';
      return `
        <div class="card">
          <div class="card-inner" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div>
              <div class="font-display" style="font-weight:700;font-size:1.05rem;letter-spacing:-0.02em">${pair}</div>
              <div class="muted" style="margin-top:4px;font-size:0.92rem">Entry: ${entry} · TP: ${tp} · SL: ${sl}</div>
            </div>
            <span class="badge ${badgeClass}">${side}</span>
          </div>
        </div>
      `;
    }).join('');
  } catch {
    list.innerHTML = `<div class="hint">Unable to load signals.</div>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

loadSignals();
