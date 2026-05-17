import { initSiteChrome } from "./site.js";
import { requireAuth, updateMyProfile } from "./auth.js";
import { showToast } from "./ui.js";

initSiteChrome();

const nameInp = document.getElementById('profileName');
const emailEl = document.getElementById('profileEmail');
const planEl = document.getElementById('profilePlan');
const saveBtn = document.getElementById('profileSave');

requireAuth().then(({ user, userDoc }) => {
  if (nameInp) nameInp.value = user.displayName || '';
  if (emailEl) emailEl.textContent = user.email || '';
  if (planEl) planEl.textContent = userDoc?.plan || 'Free';
});

if (saveBtn) {
  saveBtn.addEventListener('click', async () => {
    try {
      const displayName = String(nameInp?.value || '').trim();
      if (!displayName) {
        showToast({ title: 'Missing name', body: 'Please enter a display name.' });
        return;
      }
      saveBtn.disabled = true;
      await updateMyProfile({ displayName });
      showToast({ title: 'Saved', body: 'Profile updated.' });
    } catch (err) {
      showToast({ title: 'Error', body: err?.message || 'Update failed.' });
    } finally {
      saveBtn.disabled = false;
    }
  });
}
