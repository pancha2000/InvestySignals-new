import { watchAuth, logout } from "./auth.js";
import { initNav, setActiveNav, showToast } from "./ui.js";
import { getPublicSettings } from "./settings.js";

function setElVisible(el, visible) {
  if (!el) return;
  el.style.display = visible ? '' : 'none';
}

async function applySettings() {
  const bar = document.querySelector('[data-announcement]');
  if (!bar) return;
  try {
    const s = await getPublicSettings();
    if (s.maintenanceMode) {
      bar.innerHTML = `<div class="container"><div class="chip"><strong>Maintenance</strong><span class="muted">The site is currently in maintenance mode.</span></div></div>`;
      bar.style.display = '';
      return;
    }
    if (s.announcement) {
      bar.innerHTML = `<div class="container"><div class="chip"><strong>Update</strong><span class="muted">${escapeHtml(s.announcement)}</span></div></div>`;
      bar.style.display = '';
      return;
    }
    bar.style.display = 'none';
  } catch {
    bar.style.display = 'none';
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

export function initSiteChrome() {
  initNav();
  setActiveNav();
  applySettings();

  const authEls = document.querySelectorAll('[data-auth-only]');
  const guestEls = document.querySelectorAll('[data-guest-only]');
  const adminEls = document.querySelectorAll('[data-admin-only]');
  const nameEls = document.querySelectorAll('[data-user-name]');

  const logoutBtns = document.querySelectorAll('[data-logout]');
  logoutBtns.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        await logout();
        window.location.href = 'index.html';
      } catch {
        showToast({ title: 'Error', body: 'Logout failed.' });
      }
    });
  });

  watchAuth(({ user, userDoc }) => {
    const isAuthed = Boolean(user);
    const isAdmin = Boolean(userDoc?.role === 'admin');

    authEls.forEach(el => setElVisible(el, isAuthed));
    guestEls.forEach(el => setElVisible(el, !isAuthed));
    adminEls.forEach(el => setElVisible(el, isAuthed && isAdmin));

    const name = user?.displayName || (user?.email ? user.email.split('@')[0] : '');
    nameEls.forEach(el => { el.textContent = name; });
  });
}
