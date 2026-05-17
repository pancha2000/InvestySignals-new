import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA49TYbX5omoN56bffDnlqZGGjjpKZtOvk",
  authDomain: "investysignals-890ba.firebaseapp.com",
  projectId: "investysignals-890ba",
  storageBucket: "investysignals-890ba.firebasestorage.app",
  messagingSenderId: "1045281522975",
  appId: "1:1045281522975:web:534501aab2ceeb887bdc2a",
  measurementId: "G-M1083J7SP6"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
