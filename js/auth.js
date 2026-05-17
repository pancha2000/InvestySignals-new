import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

import { auth, db } from "./firebase.js";

export function requireAuth({ redirectTo = 'login.html' } = {}) {
  return new Promise(resolve => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = redirectTo;
        return;
      }

      const userDoc = await getUserDoc(user.uid);
      if (userDoc?.banned || userDoc?.deleted) {
        await signOut(auth);
        window.location.href = redirectTo;
        return;
      }

      resolve({ user, userDoc });
    });
  });
}

export function watchAuth(cb) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) return cb({ user: null, userDoc: null });
    const userDoc = await getUserDoc(user.uid);
    cb({ user, userDoc });
  });
}

export async function login({ email, password }) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  try {
    await touchUser(cred.user);
  } catch {
  }
  const userDoc = await getUserDoc(cred.user.uid);
  if (userDoc?.banned || userDoc?.deleted) {
    await signOut(auth);
    throw new Error('Access denied.');
  }
  return cred.user;
}

export async function register({ name, email, password }) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (name) await updateProfile(cred.user, { displayName: name });
  try {
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid,
      email: cred.user.email || email,
      displayName: name || '',
      plan: 'Free',
      role: 'user',
      banned: false,
      deleted: false,
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    await signOut(auth);
    throw new Error('Account created, but user storage is not available. Enable Firestore and update security rules, then try again.');
  }
  return cred.user;
}

export async function logout() {
  await signOut(auth);
}

export async function getUserDoc(uid) {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

export async function touchUser(user) {
  const ref = doc(db, 'users', user.uid);
  await setDoc(ref, {
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || '',
    lastLoginAt: serverTimestamp()
  }, { merge: true });
}

export async function updateMyProfile({ displayName }) {
  if (!auth.currentUser) throw new Error('Not signed in.');
  await updateProfile(auth.currentUser, { displayName });
  await updateDoc(doc(db, 'users', auth.currentUser.uid), { displayName });
}
