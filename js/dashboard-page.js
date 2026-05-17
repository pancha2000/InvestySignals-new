import { initSiteChrome } from "./site.js";
import { requireAuth } from "./auth.js";
import { showToast } from "./ui.js";

initSiteChrome();

const nameEl = document.getElementById('dashName');
const planEl = document.getElementById('dashPlan');

requireAuth()
  .then(({ user, userDoc }) => {
    if (nameEl) nameEl.textContent = user.displayName || (user.email ? user.email.split('@')[0] : 'User');
    if (planEl) planEl.textContent = userDoc?.plan || 'Free';
  })
  .catch(() => {
    showToast({ title: 'Error', body: 'Please sign in again.' });
  });
