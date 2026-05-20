import { initializeApp, getApp, getApps } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyBtKuKBOGMpoifG9MpYMIh6YPA23ulatpU",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "francabulaire.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "francabulaire",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "francabulaire.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "863534379439",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:863534379439:web:213e5d9439e71eb681ff5a"
};

// Check if Firebase is properly configured
export const isFirebaseConfigured = !!firebaseConfig.apiKey;

let app;
if (isFirebaseConfigured) {
  app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
}

export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
export const googleProvider = new GoogleAuthProvider();
