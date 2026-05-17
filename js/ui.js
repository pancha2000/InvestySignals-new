export function initNav() {
  const nav = document.querySelector('[data-nav]');
  if (!nav) return;

  const drawer = document.querySelector('[data-mobile-drawer]');
  const toggle = document.querySelector('[data-mobile-toggle]');

  window.addEventListener('scroll', () => {
    nav.classList.toggle('scrolled', window.scrollY > 24);
  });

  if (toggle && drawer) {
    toggle.addEventListener('click', () => {
      drawer.classList.toggle('open');
      toggle.setAttribute('aria-expanded', drawer.classList.contains('open') ? 'true' : 'false');
    });

    drawer.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => drawer.classList.remove('open'));
    });
  }
}

export function setActiveNav() {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('[data-nav-link]').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === path);
  });
}

export function showToast({ title, body }) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerHTML = `<div><div class="t-title">${escapeHtml(title || 'Notice')}</div><div class="t-body">${escapeHtml(body || '')}</div></div>`;
  el.classList.add('show');
  window.clearTimeout(window.__toastTimer);
  window.__toastTimer = window.setTimeout(() => el.classList.remove('show'), 3500);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
