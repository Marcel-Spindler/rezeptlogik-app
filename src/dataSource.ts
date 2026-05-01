import type { DataBundle } from "./types";
import { getFirebase } from "./firebase";
import { collection, doc, getDoc, getDocs } from "firebase/firestore";

const SOURCE = (import.meta.env.VITE_DATA_SOURCE ?? "local") as "local" | "firestore";

export async function refreshRampUpDataOnStart(): Promise<void> {
  if (SOURCE !== "firestore") return;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    await fetch("/api/refresh-ramp-up", {
      method: "POST",
      signal: controller.signal,
      cache: "no-store"
    });
  } catch {
    // Bei Netzwerk-/Function-Fehlern mit den letzten Firestore-Daten weiterlaufen.
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function loadData(): Promise<DataBundle> {
  if (SOURCE === "firestore") return loadFromFirestore();
  return loadFromJson();
}

async function loadFromJson(): Promise<DataBundle> {
  const res = await fetch(`/data/data.json?ts=${Date.now()}`);
  if (!res.ok) throw new Error(`data.json nicht gefunden – npm run import:local ausführen.`);
  return res.json();
}

async function loadFromFirestore(): Promise<DataBundle> {
  const { db } = getFirebase();
  // Geteiltes Projekt: alle App-Daten unter apps/rezeptlogik/<collection>
  const ROOT = doc(db, "apps", "rezeptlogik");
  const meta = (await getDoc(ROOT)).data() ?? {};
  const wrSnap  = await getDocs(collection(ROOT, "weekRecipes"));
  const recSnap = await getDocs(collection(ROOT, "recipes"));
  const stSnap  = await getDocs(collection(ROOT, "structures")).catch(() => null);
  const csSnap  = await getDocs(collection(ROOT, "cookSchedules"));
  const psSnap  = await getDocs(collection(ROOT, "processSpecs")).catch(() => null);
  const slSnap  = await getDocs(collection(ROOT, "shelfLifeBySku")).catch(() => null);
  const recipes: DataBundle["recipes"] = {};
  recSnap.forEach(d => { recipes[d.id] = d.data() as any; });
  const structures: NonNullable<DataBundle["structures"]> = {};
  stSnap?.forEach(d => { structures[d.id] = d.data() as any; });
  const cookSchedules: DataBundle["cookSchedules"] = {};
  csSnap.forEach(d => { const c = d.data() as any; cookSchedules[c.cookMethod] = c; });
  const processSpecs: DataBundle["processSpecs"] = {};
  psSnap?.forEach(d => { processSpecs![d.id] = d.data() as any; });
  const shelfLifeBySku: NonNullable<DataBundle["shelfLifeBySku"]> = {};
  slSnap?.forEach(d => {
    const row = d.data() as any;
    if (row?.skuCode) shelfLifeBySku[row.skuCode] = row;
  });
  return {
    generatedAt: meta.generatedAt ?? "",
    weeks: meta.weeks ?? [],
    weekRecipes: wrSnap.docs.map(d => d.data() as any),
    recipes,
    structures,
    cookSchedules,
    processSpecs,
    shelfLifeBySku
  };
}
