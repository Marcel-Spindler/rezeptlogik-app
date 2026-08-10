import type { DataBundle, EquipBibleEntry } from "./types";

const SOURCE = (import.meta.env.VITE_DATA_SOURCE ?? "firestore") as "local" | "firestore";

function logWarn(context: string, err?: unknown) {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  console.warn(`[dataSource] ${context}${msg ? ": " + msg : ""}`);
}

export let lastDataError: string | null = null;

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
  } catch (e) {
    logWarn("refresh-operational fehlgeschlagen (non-fatal)", e);
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
  } catch (e) {
    logWarn("refresh-ramp-up fehlgeschlagen (non-fatal)", e);
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
        (err) => {
          logWarn("Firestore-Listener Fehler (Polling bleibt aktiv)", err);
        }
      );
    } catch (e) {
      logWarn("Firestore-Verbindung fehlgeschlagen (non-fatal)", e);
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
      const bundle = await loadFromFirestore();
      lastDataError = null;
      return bundle;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastDataError = msg;
      logWarn("Firestore-Load fehlgeschlagen, Fallback auf data.json", e);
      return loadFromJson();
    }
  }
  return loadFromJson();
}

async function loadFromJson(): Promise<DataBundle> {
  let res: Response;
  try {
    res = await fetch(`/data/data.json?ts=${Date.now()}`, { cache: "no-store" });
  } catch (e) {
    throw new Error(`Datenquelle nicht erreichbar (data.json): ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) throw new Error(`data.json nicht gefunden (HTTP ${res.status}) – npm run import:local ausführen.`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`data.json ist ungültig formatiert: ${e instanceof Error ? e.message : e}`);
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
  const kplSnap = await getDocs(collection(ROOT, "kitchenPlanning")).catch(() => null);
  const ebSnap  = await getDocs(collection(ROOT, "equipmentBible")).catch(() => null);
  const pcSnap  = await getDocs(collection(ROOT, "planningCalendar")).catch(() => null);
  const wySnap  = await getDocs(collection(ROOT, "weeklyYield")).catch(() => null);
  const wgSnap  = await getDocs(collection(ROOT, "weightGoals")).catch(() => null);
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

  // Production plan: merge rows from all available week docs so WO views can see all upcoming work orders
  let productionPlan: DataBundle["productionPlan"] = undefined;
  if (pkgSnap && !pkgSnap.empty) {
    const sorted = pkgSnap.docs.sort((a, b) => b.id.localeCompare(a.id));
    const latest = sorted[0].data() as any;
    const mergedRows: any[] = [];
    const seen = new Set<string>();
    for (const docSnap of sorted) {
      const plan = docSnap.data() as any;
      const rows = Array.isArray(plan?.rows) ? plan.rows : [];
      for (const row of rows) {
        const key = [
          String(row?.kitchenDay ?? ""),
          String(row?.workOrder ?? ""),
          String(row?.recipeCode ?? ""),
          String(row?.subRecipe ?? ""),
        ].join("||");
        if (seen.has(key)) continue;
        seen.add(key);
        mergedRows.push(row);
      }
    }
    productionPlan = {
      ...latest,
      rows: mergedRows,
      generatedAt: latest?.generatedAt ?? meta.generatedAt ?? "",
    } as any;
  }

  const printOrders: DataBundle["printOrders"] = [];
  poSnap?.forEach(d => { const row = d.data() as any; if (row) printOrders!.push(row); });

  const kitchenPriority: DataBundle["kitchenPriority"] = [];
  kpSnap?.forEach(d => { const row = d.data() as any; if (row) kitchenPriority!.push(row); });
  kitchenPriority.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  // kitchenPlanning: ein Doc pro Woche (id = "2026-W33"), Feld "rows" — Rezepte
  // aller verfuegbaren Wochen zusammenfuehren (analog productionPlan oben).
  const kitchenPlanning: DataBundle["kitchenPlanning"] = [];
  kplSnap?.forEach(d => {
    const plan = d.data() as any;
    const rows = Array.isArray(plan?.rows) ? plan.rows : [];
    kitchenPlanning!.push(...rows);
  });

  // equipmentBible: single doc "current" holding a "rows" array (Kuechenbible import).
  // Defensive: drop any row that isn't a well-formed BRAISER/MIDDLE_KITCHEN/
  // VEGGIE_DEBOX entry with a finite, positive maxKg — a malformed row (e.g.
  // maxKg missing or stored as a non-numeric string) must never reach the
  // capacity calculation, where it could silently produce a 0/NaN/Infinity
  // batch count instead of falling back to the default capacity.
  let equipmentBible: DataBundle["equipmentBible"] = undefined;
  const ebCurrentDoc = ebSnap?.docs.find(d => d.id === "current");
  if (ebCurrentDoc) {
    const ebData = ebCurrentDoc.data() as any;
    const ebRowsRaw = Array.isArray(ebData?.rows) ? ebData.rows : [];
    const ebRows: EquipBibleEntry[] = ebRowsRaw.filter((r: any): r is EquipBibleEntry =>
      !!r &&
      (r.source === "BRAISER" || r.source === "MIDDLE_KITCHEN" || r.source === "VEGGIE_DEBOX") &&
      typeof r.itemName === "string" &&
      typeof r.category === "string" &&
      typeof r.maxKg === "number" && Number.isFinite(r.maxKg) && r.maxKg > 0
    );
    equipmentBible = ebRows.length ? ebRows : undefined;
  }

  let planningCalendar: DataBundle["planningCalendar"] = undefined;
  const pcCurrentDoc = pcSnap?.docs.find(d => d.id === "current");
  if (pcCurrentDoc) {
    const pcData = pcCurrentDoc.data() as any;
    planningCalendar = {
      deadlines: Array.isArray(pcData?.deadlines) ? pcData.deadlines : [],
      rules: Array.isArray(pcData?.rules) ? pcData.rules : [],
      updatedAt: pcData?.updatedAt ?? "",
    };
  }

  const weeklyYieldDoc = wySnap?.docs.find(d => d.id === "current")?.data() as any;
  const weeklyYield: DataBundle["weeklyYield"] = Array.isArray(weeklyYieldDoc?.rows) ? weeklyYieldDoc.rows : undefined;

  const weightGoalsDoc = wgSnap?.docs.find(d => d.id === "current")?.data() as any;
  const weightGoals: DataBundle["weightGoals"] = Array.isArray(weightGoalsDoc?.rows) ? weightGoalsDoc.rows : undefined;

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
    kitchenPlanning: kitchenPlanning.length ? kitchenPlanning : undefined,
    produktionsplanung: Object.keys(produktionsplanung).length ? produktionsplanung : undefined,
    maitreRampup: Object.keys(maitreRampup).length ? maitreRampup : undefined,
    equipmentBible,
    planningCalendar,
    weeklyYield,
    weightGoals,
  };
}
