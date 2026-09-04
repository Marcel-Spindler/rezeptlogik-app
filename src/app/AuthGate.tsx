import { useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signInAnonymously } from "firebase/auth";
import { getFirebaseAuth } from "../core/firebase";

type AuthState = "loading" | "ready" | "error";

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    // JSON-/SQLite-Entwicklung funktioniert absichtlich ohne Firebase-Konfig.
    // Ein produktiver Firestore-Build besitzt immer eine Projekt-ID und muss
    // deshalb die anonyme Identitaet abwarten.
    if (!import.meta.env.VITE_FIREBASE_PROJECT_ID) {
      setState("ready");
      return;
    }
    const auth = getFirebaseAuth();
    let disposed = false;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        if (!disposed) setState("ready");
        return;
      }
      void signInAnonymously(auth).catch((reason: unknown) => {
        if (disposed) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setState("error");
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  if (state === "ready") return <>{children}</>;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="card w-full max-w-md p-6 text-center">
        {state === "loading" ? (
          <div className="text-sm text-slate-500">Geschützte Verbindung wird hergestellt …</div>
        ) : (
          <>
            <h1 className="text-base font-bold text-slate-900">Verbindung nicht möglich</h1>
            <p className="mt-2 text-sm text-slate-600">
              Firebase Anonymous Authentication muss für dieses Projekt aktiviert sein.
            </p>
            <p className="mt-2 break-words font-mono text-[11px] text-slate-400">{error}</p>
          </>
        )}
      </div>
    </main>
  );
}