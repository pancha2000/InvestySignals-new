import { initSiteChrome } from "./site.js";
import { register } from "./auth.js";
import { showToast } from "./ui.js";

initSiteChrome();

const form = document.getElementById('registerForm');
const btn = document.getElementById('regBtn');

if (form && btn) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = String(document.getElementById('regName')?.value || '').trim();
    const email = String(document.getElementById('regEmail')?.value || '').trim();
    const password = String(document.getElementById('regPassword')?.value || '');
    const password2 = String(document.getElementById('regConfirmPassword')?.value || '');

    if (!name) {
      showToast({ title: 'Missing name', body: 'Please enter your name.' });
      return;
    }
    if (!email) {
      showToast({ title: 'Missing email', body: 'Please enter your email.' });
      return;
    }
    if (password.length < 6) {
      showToast({ title: 'Weak password', body: 'Use at least 6 characters.' });
      return;
    }
    if (password !== password2) {
      showToast({ title: 'Password mismatch', body: 'Please confirm your password.' });
      return;
    }

    btn.disabled = true;
    try {
      await register({ name, email, password });
      window.location.href = 'dashboard.html';
    } catch (err) {
      btn.disabled = false;
      showToast({ title: 'Sign up failed', body: err?.message || 'Please try again.' });
    }
  });
}
