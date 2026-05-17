// Firebase ගෙන්වා ගැනීම (CDN හරහා)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";


// ඔයාගේ Firebase Configuration එක
const firebaseConfig = {
    apiKey: "AIzaSyA49TYbX5omoN56bffDnlqZGGjjpKZtOvk",
    authDomain: "investysignals-890ba.firebaseapp.com",
    projectId: "investysignals-890ba",
    storageBucket: "investysignals-890ba.firebasestorage.app",
    messagingSenderId: "1045281522975",
    appId: "1:1045281522975:web:534501aab2ceeb887bdc2a",
    measurementId: "G-M1083J7SP6"
};

// Firebase සහ Auth සක්‍රීය කිරීම
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// -------------------------------------------------------------------
// 1. Register වීමේ ක්‍රියාවලිය (Sign Up)
// -------------------------------------------------------------------
const registerForm = document.getElementById('registerForm');

if(registerForm) {
    registerForm.addEventListener('submit', function(event) {
        event.preventDefault(); 

        const name = document.getElementById('regName').value;
        const email = document.getElementById('regEmail').value;
        const password = document.getElementById('regPassword').value;
        const confirmPassword = document.getElementById('regConfirmPassword').value;

        if(password !== confirmPassword) {
            alert('Passwords දෙක එකිනෙකට ගැලපෙන්නේ නැත!');
            return;
        }

        createUserWithEmailAndPassword(auth, email, password)
            .then((userCredential) => {
                alert(`සාර්ථකයි! ${name}, ඔබේ ගිණුම සෑදුවා. කරුණාකර ලොග් වන්න.`);
                window.location.href = 'login.html'; 
            })
            .catch((error) => {
                alert(`දෝෂයකි: ${error.message}`);
            });
    });
}

// -------------------------------------------------------------------
// 2. ලොග් වීමේ ක්‍රියාවලිය (Login)
// -------------------------------------------------------------------
const loginForm = document.getElementById('loginForm');

if(loginForm) {
    loginForm.addEventListener('submit', function(event) {
        event.preventDefault(); 

        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;

        // Firebase හරහා ගිණුමට ඇතුල් වීම
        signInWithEmailAndPassword(auth, email, password)
            .then((userCredential) => {
                alert('සාර්ථකව ලොග් වුණා!');
                window.location.href = 'dashboard.html'; // Dashboard එකට යැවීම
            })
            .catch((error) => {
                alert(`දෝෂයකි: Email හෝ Password වැරදියි!`);
            });
    });
}
// -------------------------------------------------------------------
// 3. ලොග් අවුට් වීමේ ක්‍රියාවලිය (Logout)
// -------------------------------------------------------------------
const logoutBtn = document.getElementById('logoutBtn');

if(logoutBtn) {
    logoutBtn.addEventListener('click', function(event) {
        event.preventDefault(); 

        // Firebase හරහා ගිණුමෙන් ඉවත් වීම
        signOut(auth).then(() => {
            alert('ඔබ සාර්ථකව ගිණුමෙන් ඉවත් වුණා!');
            window.location.href = 'index.html'; // මුල් පිටුවට (Landing Page) යැවීම
        }).catch((error) => {
            alert(`දෝෂයකි: ${error.message}`);
        });
    });
}
