// Firebase-Initialisierung und Firestore-Re-Exports.
// Alle Firestore-Funktionen werden hier zentral re-exportiert, damit kein
// anderes Modul `import("firebase/firestore")` dynamisch laden muss.
import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getFirestore,
  type Firestore,
  doc,
  collection,
  writeBatch,
  setDoc,
  updateDoc,
  deleteField,
  getDoc,
  getDocs,
  onSnapshot,
  addDoc,
  serverTimestamp,
} from "firebase/firestore";

export { doc, collection, writeBatch, setDoc, updateDoc, deleteField, getDoc, getDocs, onSnapshot, addDoc, serverTimestamp };

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
