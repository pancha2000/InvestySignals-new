import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

import { initSiteChrome } from "./site.js";
import { requireAuth } from "./auth.js";
import { db } from "./firebase.js";
import { showToast } from "./ui.js";

initSiteChrome();

const els = {
  me: document.getElementById('adminMe'),
  userSearch: document.getElementById('userSearch'),
  userBody: document.getElementById('userBody'),
  usersCount: document.getElementById('usersCount'),
  bannedCount: document.getElementById('bannedCount'),
  settingsMaintenance: document.getElementById('settingsMaintenance'),
  settingsAnnouncement: document.getElementById('settingsAnnouncement'),
  settingsSave: document.getElementById('settingsSave')
};

let allUsers = [];

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderUsers() {
  if (!els.userBody) return;
  const q = String(els.userSearch?.value || '').trim().toLowerCase();

  const filtered = allUsers.filter(u => {
    if (!q) return true;
    return (
      String(u.email || '').toLowerCase().includes(q) ||
      String(u.displayName || '').toLowerCase().includes(q) ||
      String(u.plan || '').toLowerCase().includes(q)
    );
  });

  if (!filtered.length) {
    els.userBody.innerHTML = `<tr><td colspan="6" class="muted" style="padding:16px">No users found.</td></tr>`;
    return;
  }

  els.userBody.innerHTML = filtered.map(u => {
    const plan = u.plan || 'Free';
    const status = u.deleted ? 'Deleted' : (u.banned ? 'Banned' : 'Active');
    const statusClass = u.deleted ? 'bad' : (u.banned ? 'warn' : 'good');

    const banLabel = u.banned ? 'Unban' : 'Ban';
    const banClass = u.banned ? 'btn' : 'btn-danger';
    const delLabel = u.deleted ? 'Restore' : 'Delete';
    const delClass = u.deleted ? 'btn' : 'btn-danger';

    return `
      <tr>
        <td style="padding:12px 10px;border-top:1px solid rgba(255,255,255,0.06)">
          <div class="font-display" style="font-weight:700">${escapeHtml(u.displayName || '—')}</div>
          <div class="muted" style="font-size:0.86rem;margin-top:2px">${escapeHtml(u.email || '—')}</div>
        </td>
        <td style="padding:12px 10px;border-top:1px solid rgba(255,255,255,0.06)">
          <select class="select" data-plan="${escapeHtml(u.uid)}" style="min-height:38px;padding:8px 10px">
            ${['Free', 'Pro', 'Elite'].map(p => `<option value="${p}" ${p === plan ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </td>
        <td style="padding:12px 10px;border-top:1px solid rgba(255,255,255,0.06)">
          <span class="badge ${statusClass}">${escapeHtml(status)}</span>
        </td>
        <td style="padding:12px 10px;border-top:1px solid rgba(255,255,255,0.06)">
          <span class="badge ${u.role === 'admin' ? 'good' : ''}">${escapeHtml(u.role || 'user')}</span>
        </td>
        <td style="padding:12px 10px;border-top:1px solid rgba(255,255,255,0.06)">
          <button class="${banClass}" data-ban="${escapeHtml(u.uid)}" style="min-height:38px;padding:8px 12px">${banLabel}</button>
        </td>
        <td style="padding:12px 10px;border-top:1px solid rgba(255,255,255,0.06)">
          <button class="${delClass}" data-del="${escapeHtml(u.uid)}" style="min-height:38px;padding:8px 12px">${delLabel}</button>
        </td>
      </tr>
    `;
  }).join('');

  els.userBody.querySelectorAll('[data-plan]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const uid = sel.getAttribute('data-plan');
      const plan = sel.value;
      try {
        await updateDoc(doc(db, 'users', uid), { plan });
        allUsers = allUsers.map(u => (u.uid === uid ? { ...u, plan } : u));
        showToast({ title: 'Updated', body: 'Plan updated.' });
      } catch {
        showToast({ title: 'Error', body: 'Unable to update plan.' });
      }
    });
  });

  els.userBody.querySelectorAll('[data-ban]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.getAttribute('data-ban');
      const u = allUsers.find(x => x.uid === uid);
      const next = !u?.banned;
      try {
        await updateDoc(doc(db, 'users', uid), { banned: next });
        allUsers = allUsers.map(x => (x.uid === uid ? { ...x, banned: next } : x));
        refreshCounters();
        renderUsers();
        showToast({ title: 'Updated', body: next ? 'User banned.' : 'User unbanned.' });
      } catch {
        showToast({ title: 'Error', body: 'Unable to update user.' });
      }
    });
  });

  els.userBody.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.getAttribute('data-del');
      const u = allUsers.find(x => x.uid === uid);
      const next = !u?.deleted;
      try {
        await updateDoc(doc(db, 'users', uid), { deleted: next });
        allUsers = allUsers.map(x => (x.uid === uid ? { ...x, deleted: next } : x));
        refreshCounters();
        renderUsers();
        showToast({ title: 'Updated', body: next ? 'User deleted.' : 'User restored.' });
      } catch {
        showToast({ title: 'Error', body: 'Unable to update user.' });
      }
    });
  });
}

function refreshCounters() {
  const total = allUsers.length;
  const banned = allUsers.filter(u => u.banned && !u.deleted).length;
  if (els.usersCount) els.usersCount.textContent = String(total);
  if (els.bannedCount) els.bannedCount.textContent = String(banned);
}

async function loadUsers() {
  const q = query(collection(db, 'users'), orderBy('createdAt', 'desc'), limit(500));
  const snap = await getDocs(q);
  const users = [];
  snap.forEach(d => users.push(d.data()));
  allUsers = users.map(u => ({
    uid: u.uid,
    email: u.email,
    displayName: u.displayName,
    plan: u.plan,
    role: u.role,
    banned: Boolean(u.banned),
    deleted: Boolean(u.deleted)
  }));
  refreshCounters();
  renderUsers();
}

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'public'));
    const data = snap.exists() ? (snap.data() || {}) : {};
    if (els.settingsMaintenance) els.settingsMaintenance.checked = Boolean(data.maintenanceMode);
    if (els.settingsAnnouncement) els.settingsAnnouncement.value = String(data.announcement || '');
  } catch {
  }
}

async function saveSettings() {
  const maintenanceMode = Boolean(els.settingsMaintenance?.checked);
  const announcement = String(els.settingsAnnouncement?.value || '').trim();
  await setDoc(doc(db, 'settings', 'public'), { maintenanceMode, announcement }, { merge: true });
}

requireAuth().then(async ({ user, userDoc }) => {
  if (userDoc?.role !== 'admin') {
    window.location.href = 'dashboard.html';
    return;
  }

  if (els.me) els.me.textContent = user.email || 'Admin';
  await Promise.all([loadUsers(), loadSettings()]);
});

if (els.userSearch) {
  els.userSearch.addEventListener('input', () => renderUsers());
}

if (els.settingsSave) {
  els.settingsSave.addEventListener('click', async () => {
    try {
      els.settingsSave.disabled = true;
      await saveSettings();
      showToast({ title: 'Saved', body: 'Settings updated.' });
    } catch {
      showToast({ title: 'Error', body: 'Unable to save settings.' });
    } finally {
      els.settingsSave.disabled = false;
    }
  });
}
