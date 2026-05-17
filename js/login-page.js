import { initSiteChrome } from "./site.js";
import { login } from "./auth.js";
import { showToast } from "./ui.js";

initSiteChrome();

const form = document.getElementById('loginForm');
const btn = document.getElementById('loginBtn');

if (form && btn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = String(document.getElementById('loginEmail')?.value || '').trim();
    const password = String(document.getElementById('loginPassword')?.value || '');

    if (!email || !password) {
      showToast({ title: 'Missing details', body: 'Please enter your email and password.' });
      return;
    }

    btn.disabled = true;
    try {
      await login({ email, password });
      window.location.href = 'dashboard.html';
    } catch (err) {
      btn.disabled = false;
      showToast({ title: 'Login failed', body: err?.message || 'Please try again.' });
    }
  });
}
