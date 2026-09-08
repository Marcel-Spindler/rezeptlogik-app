// Editierbares Overlay über den read-only F_VE-Production-Plan-Mirror
// (ProductionPlanSheetTable). Das GSheet bleibt Basiswert/Quelle der Wahrheit
// — Edits schreiben NICHT ins Sheet zurück, sondern landen als Overrides in
// Firestore und werden beim Rendern darübergelegt. Absichtlich: das vermeidet
// Schreibrisiko auf Marcels handgepflegtes Sheet UND legt die Grundlage für
// die spätere KI-Verknüpfung (jede editierte Zelle ist ein eigener,
// versionierter Datenpunkt statt eines rohen Sheet-Werts) — Pilot-Set vorerst
// nur Buffer/Allergene/Tages-Matrix, siehe ProductionPlanSheetTable.
// Pfad: apps/rezeptlogik/productionPlanOverrides/{hfWeek} (z.B. "2026-W37"),
// ein Dokument pro Woche mit rows[code] = Override-Patch für diese Meal-Zeile.
import { useEffect, useState } from "react";
import { deleteField, doc, getFirebase, onSnapshot, setDoc, updateDoc } from "../../core/firebase";
import { PRODUCTION_PLAN_DAYS, type ProductionPlanData, type ProductionPlanDay, type ProductionPlanDayCell, type ProductionPlanRow, type ProductionPlanShift } from "../gsheet-monitor/gsheetTypes";

const COLLECTION_PATH = "apps/rezeptlogik/productionPlanOverrides";

export type ReadyDayKey = "thu" | "fri" | "sat";
const READY_DAY_KEYS: readonly ReadyDayKey[] = ["thu", "fri", "sat"];

export interface ProductionPlanRowOverride {
  totalWithBuffer?: number | null;
  allergens?: string;
  byDay?: Partial<Record<ProductionPlanDay, ProductionPlanDayCell>>;
  // Nur Zweischicht-Wochen: einzelne Früh-/Spät-Zellen (Mo-Fr). Die pro Tag
  // zusammengefasste `byDay`-Sicht (und damit Ready/Min Needs) wird beim Rendern
  // aus den effektiven Schicht-Zellen neu berechnet.
  byShift?: Partial<Record<ProductionPlanDay, Partial<Record<ProductionPlanShift, ProductionPlanDayCell>>>>;
  readyByDay?: Partial<Record<ReadyDayKey, number | null>>;
  minNeedsByDay?: Partial<Record<ReadyDayKey, number | null>>;
}

const EMPTY_CELL: ProductionPlanDayCell = { kind: "empty" };

// Früh- + Spät-Zelle eines Tages zusammenfassen — identische Regel wie im Parser
// (mergeDayCells): Portionen summieren, sonst Stationslabels zusammenführen.
function mergeShiftCells(early: ProductionPlanDayCell, late: ProductionPlanDayCell): ProductionPlanDayCell {
  const cells = [early, late];
  if (cells.some(c => c.kind === "portions")) {
    return { kind: "portions", portions: cells.reduce((s, c) => s + (c.kind === "portions" ? c.portions : 0), 0) };
  }
  const labels = [...new Set(cells.filter((c): c is Extract<ProductionPlanDayCell, { kind: "station" }> => c.kind === "station").map(c => c.label))];
  return labels.length ? { kind: "station", label: labels.join(" / ") } : { kind: "empty" };
}

export type ProductionPlanOverrideRows = Record<string /* row.code */, ProductionPlanRowOverride>;

// Im GSheet ist "Ready" = SUM() über einen Tagesbereich der Tages-Matrix, aber
// der Bereich ist pro Zeile von Hand gewählt (mal Di-Sa, mal enger) -- keine
// einheitliche Formel, siehe Recherche 2026-08-24. Standardregel hier: Summe
// aller Portionen-Zellen der ganzen Woche (trifft die meisten Zeilen im Sheet)
// -- weicht sie für eine Zeile ab, kann Ready/Min Needs genauso überschrieben
// werden wie jede andere Pilot-Zelle (siehe ProductionPlanSheetTable).
function sumPortionsInByDay(byDay: Record<ProductionPlanDay, ProductionPlanDayCell>): number {
  return PRODUCTION_PLAN_DAYS.reduce((sum, day) => {
    const cell = byDay[day];
    return cell.kind === "portions" ? sum + cell.portions : sum;
  }, 0);
}

// Min Needs(Tag) = Ready(Tag) - (NORD + BENL*0.25 + DE*0.45) -- 1:1 aus der
// Sheet-Formel (AI6 etc., nur für "Thursday" im Sheet belegt, aber row-lokal
// und Tag-unabhängig, siehe Recherche 2026-08-24).
function computeMinNeeds(ready: number, row: ProductionPlanRow): number {
  return ready - (row.nordics + row.benl * 0.25 + row.de * 0.45);
}

export function mergeRowOverride(row: ProductionPlanRow, override: ProductionPlanRowOverride | undefined): ProductionPlanRow {
  if (!override) return row;

  // 1. Effektive Schicht-Aufteilung (nur dual): Overrides über row.byShift legen.
  let byShift = row.byShift;
  const shiftEditedDays = override.byShift
    ? (Object.keys(override.byShift) as ProductionPlanDay[])
    : [];
  if (shiftEditedDays.length) {
    byShift = { ...(row.byShift ?? {}) };
    for (const day of shiftEditedDays) {
      const base = row.byShift?.[day] ?? { early: EMPTY_CELL, late: EMPTY_CELL };
      byShift[day] = { ...base, ...override.byShift![day] };
    }
  }

  // 2. byDay: erst die Schicht-Edits als Tages-Merge einrechnen, dann direkte byDay-Overrides.
  let byDay = row.byDay;
  if (shiftEditedDays.length && byShift) {
    byDay = { ...byDay };
    for (const day of shiftEditedDays) {
      const s = byShift[day];
      if (s) byDay[day] = mergeShiftCells(s.early, s.late);
    }
  }
  if (override.byDay) byDay = { ...byDay, ...override.byDay };

  const dayEdited = !!override.byDay || shiftEditedDays.length > 0;
  const autoReady = dayEdited ? sumPortionsInByDay(byDay) : null;

  const readyByDay = { ...row.readyByDay };
  const minNeedsByDay = { ...row.minNeedsByDay };
  for (const key of READY_DAY_KEYS) {
    const explicitReady = override.readyByDay?.[key];
    const effectiveReady = explicitReady ?? (dayEdited ? autoReady : row.readyByDay[key]);
    readyByDay[key] = effectiveReady ?? null;

    const explicitMinNeeds = override.minNeedsByDay?.[key];
    if (explicitMinNeeds != null) {
      minNeedsByDay[key] = explicitMinNeeds;
    } else if (explicitReady != null || dayEdited) {
      minNeedsByDay[key] = effectiveReady == null ? null : computeMinNeeds(effectiveReady, row);
    } else {
      minNeedsByDay[key] = row.minNeedsByDay[key];
    }
  }

  return {
    ...row,
    totalWithBuffer: override.totalWithBuffer ?? row.totalWithBuffer,
    allergens: override.allergens ?? row.allergens,
    byShift,
    byDay,
    readyByDay,
    minNeedsByDay,
  };
}

export function applyProductionPlanOverrides(data: ProductionPlanData, overrides: ProductionPlanOverrideRows): ProductionPlanData {
  if (Object.keys(overrides).length === 0) return data;
  return { ...data, rows: data.rows.map((r) => mergeRowOverride(r, overrides[r.code])) };
}

export function subscribeProductionPlanOverrides(week: string, onData: (rows: ProductionPlanOverrideRows) => void): () => void {
  if (!week) { onData({}); return () => {}; }
  try {
    const { db } = getFirebase();
    return onSnapshot(
      doc(db, COLLECTION_PATH, week),
      (snap) => onData(snap.exists() ? ((snap.data().rows as ProductionPlanOverrideRows) ?? {}) : {}),
      () => onData({}),
    );
  } catch (error) {
    console.error("[productionPlanOverrides] Subscribe failed:", error);
    onData({});
    return () => {};
  }
}

export async function saveProductionPlanCellOverride(week: string, code: string, patch: ProductionPlanRowOverride): Promise<void> {
  if (!week || !code) return;
  try {
    const { db } = getFirebase();
    const ref = doc(db, COLLECTION_PATH, week);
    await setDoc(ref, { week, updatedAt: Date.now(), rows: { [code]: patch } }, { merge: true });
  } catch (error) {
    console.error("[productionPlanOverrides] Save failed for", code, error);
  }
}

// fieldPath z.B. "totalWithBuffer", "allergens", "byDay.Monday",
// "byShift.Monday.early" — muss exakt den Feldpfad aus ProductionPlanRowOverride
// treffen, siehe deleteField()-Doku.
export async function clearProductionPlanCellOverride(week: string, code: string, fieldPath: string): Promise<void> {
  if (!week || !code) return;
  try {
    const { db } = getFirebase();
    const ref = doc(db, COLLECTION_PATH, week);
    await updateDoc(ref, { [`rows.${code}.${fieldPath}`]: deleteField(), updatedAt: Date.now() });
  } catch (error) {
    console.error("[productionPlanOverrides] Clear failed for", code, fieldPath, error);
  }
}

export interface ProductionPlanOverridesState {
  overrides: ProductionPlanOverrideRows;
  saveCell: (code: string, patch: ProductionPlanRowOverride) => Promise<void>;
  clearCell: (code: string, fieldPath: string) => Promise<void>;
}

export function useProductionPlanOverrides(week: string): ProductionPlanOverridesState {
  const [overrides, setOverrides] = useState<ProductionPlanOverrideRows>({});

  useEffect(() => {
    setOverrides({});
    return subscribeProductionPlanOverrides(week, setOverrides);
  }, [week]);

  return {
    overrides,
    saveCell: (code, patch) => saveProductionPlanCellOverride(week, code, patch),
    clearCell: (code, fieldPath) => clearProductionPlanCellOverride(week, code, fieldPath),
  };
}
