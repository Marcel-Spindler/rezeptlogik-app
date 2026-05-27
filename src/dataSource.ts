import type { DataBundle } from "./types";

const SOURCE = (import.meta.env.VITE_DATA_SOURCE ?? "firestore") as "local" | "firestore";

export async function refreshOperationalData(): Promise<void> {
  if (SOURCE !== "firestore") return;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 25000);
  try {
    await fetch("/api/refresh-operational", {
      method: "POST",
      signal: controller.signal,
      cache: "no-store"
    });
  } catch {
    // Non-fatal — letzten Firestore-Stand nutzen.
  } finally {
    window.clearTimeout(timeout);
  }
}

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

export function subscribeRampUpHashChanges(onChanged: () => void): () => void {
  if (SOURCE !== "firestore") return () => {};

  let disposed = false;
  let initialized = false;
  let lastHash = "";
  let unsubscribe: (() => void) | null = null;

  (async () => {
    try {
      const [{ getFirebase }, { doc, onSnapshot }] = await Promise.all([
        import("./firebase"),
        import("firebase/firestore"),
      ]);
      if (disposed) return;

      const { db } = getFirebase();
      unsubscribe = onSnapshot(
        doc(db, "apps", "rezeptlogik"),
        (snapshot) => {
          const data = snapshot.data() as { rampUpHash?: string } | undefined;
          const nextHash = String(data?.rampUpHash ?? "");
          if (!initialized) {
            initialized = true;
            lastHash = nextHash;
            return;
          }
          if (nextHash && nextHash !== lastHash) {
            lastHash = nextHash;
            onChanged();
          }
        },
        () => {
          // Bei Listener-Fehlern bleibt Polling als Fallback aktiv.
        }
      );
    } catch {
      // Firestore optional: bei Fehlern still zurückfallen.
    }
  })();

  return () => {
    disposed = true;
    if (unsubscribe) unsubscribe();
  };
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
  const pkgSnap = await getDocs(collection(ROOT, "productionPlan")).catch(() => null);
  const poSnap  = await getDocs(collection(ROOT, "printOrders")).catch(() => null);
  const kpSnap  = await getDocs(collection(ROOT, "kitchenPriority")).catch(() => null);
  const pplSnap = await getDocs(collection(ROOT, "produktionsplanung")).catch(() => null);
  const mrSnap  = await getDocs(collection(ROOT, "maitreRampup")).catch(() => null);
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

  // Production plan: docs sorted by week, take the latest
  let productionPlan: DataBundle["productionPlan"] = undefined;
  if (pkgSnap && !pkgSnap.empty) {
    const sorted = pkgSnap.docs.sort((a, b) => b.id.localeCompare(a.id));
    productionPlan = sorted[0].data() as any;
  }

  const printOrders: DataBundle["printOrders"] = [];
  poSnap?.forEach(d => { const row = d.data() as any; if (row) printOrders!.push(row); });

  const kitchenPriority: DataBundle["kitchenPriority"] = [];
  kpSnap?.forEach(d => { const row = d.data() as any; if (row) kitchenPriority!.push(row); });
  kitchenPriority.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  const produktionsplanung: NonNullable<DataBundle["produktionsplanung"]> = {};
  pplSnap?.forEach(d => {
    const row = d.data() as any;
    if (row && row.market) {
      produktionsplanung[row.market] = row;
    }
  });

  const maitreRampup: NonNullable<DataBundle["maitreRampup"]> = {};
  mrSnap?.forEach(d => {
    const row = d.data() as any;
    if (row && row.recipeCode) {
      const key = `${row.market}__${row.week}__${row.recipeCode}`;
      maitreRampup[key] = row;
    }
  });

  return {
    generatedAt: meta.generatedAt ?? "",
    weeks: meta.weeks ?? [],
    weekRecipes: wrSnap.docs.map(d => d.data() as any),
    recipes,
    structures,
    cookSchedules,
    processSpecs,
    shelfLifeBySku,
    productionPlan,
    printOrders: printOrders.length ? printOrders : undefined,
    kitchenPriority: kitchenPriority.length ? kitchenPriority : undefined,
    produktionsplanung: Object.keys(produktionsplanung).length ? produktionsplanung : undefined,
    maitreRampup: Object.keys(maitreRampup).length ? maitreRampup : undefined,
  };
}
