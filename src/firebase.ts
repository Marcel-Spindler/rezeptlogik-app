// Firebase-Initialisierung (optional aktiv).
// VITE_DATA_SOURCE=local  → Daten aus public/data/data.json (Standard)
// VITE_DATA_SOURCE=firestore → live aus Firestore (nach push-firestore.ts)
import { initializeApp, type FirebaseApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";

let app: FirebaseApp | null = null;
let db: Firestore | null = null;

export function getFirebase() {
  if (app) return { app, db: db! };
  const cfg = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
  };
  if (!cfg.projectId) throw new Error("Firebase config fehlt (.env.local).");
  app = initializeApp(cfg as any);
  db = getFirestore(app);
  return { app, db };
}
