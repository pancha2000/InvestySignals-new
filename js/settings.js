import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { db } from "./firebase.js";

export async function getPublicSettings() {
  const snap = await getDoc(doc(db, 'settings', 'public'));
  if (!snap.exists()) return { maintenanceMode: false, announcement: '' };
  const d = snap.data() || {};
  return {
    maintenanceMode: Boolean(d.maintenanceMode),
    announcement: typeof d.announcement === 'string' ? d.announcement : ''
  };
}
