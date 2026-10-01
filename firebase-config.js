// ============================================================
// CONFIGURAÇÃO DO FIREBASE
// ============================================================
// Preenchido com os dados do projeto "orbita-metas".
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyDMxrJayy8gNPwD7KIMoAO21RxzFCI9bNs",
  authDomain: "orbita-metas.firebaseapp.com",
  projectId: "orbita-metas",
  storageBucket: "orbita-metas.firebasestorage.app",
  messagingSenderId: "654058689151",
  appId: "1:654058689151:web:229819d727bcacb29ca54a"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
