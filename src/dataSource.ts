import type { DataBundle } from "./types";

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
  if (SOURCE === "firestore") {
    try {
      return await loadFromFirestore();
    } catch {
      // Stabilitäts-Guardrail: Bei Firestore-Problemen auf lokale Daten zurückfallen.
      return loadFromJson();
    }
  }
  return loadFromJson();
}

async function loadFromJson(): Promise<DataBundle> {
  let res: Response;
  try {
    res = await fetch(`/data/data.json?ts=${Date.now()}`, { cache: "no-store" });
  } catch {
    throw new Error(`Datenquelle nicht erreichbar (data.json).`);
  }
  if (!res.ok) throw new Error(`data.json nicht gefunden – npm run import:local ausführen.`);
  try {
    return await res.json();
  } catch {
    throw new Error(`data.json ist ungültig formatiert.`);
  }
}

async function loadFromFirestore(): Promise<DataBundle> {
  const [{ getFirebase }, { collection, doc, getDoc, getDocs }] = await Promise.all([
    import("./firebase"),
    import("firebase/firestore"),
  ]);
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
