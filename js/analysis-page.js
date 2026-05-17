import { initSiteChrome } from "./site.js";
import { requireAuth } from "./auth.js";
import { showToast } from "./ui.js";

initSiteChrome();

requireAuth().catch(() => {
  showToast({ title: 'Sign in required', body: 'Please log in to access Analysis.' });
});

const btn = document.getElementById('analysisRun');
if (btn) {
  btn.addEventListener('click', () => {
    showToast({ title: 'Coming soon', body: 'Analysis tools are being rebuilt. This page intentionally has no legacy analysis code.' });
  });
}
