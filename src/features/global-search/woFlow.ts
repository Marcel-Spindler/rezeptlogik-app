// Übergeordnete Suche — reiner Flow-/Verlaufs-Builder einer Work Order (kein React).
//
// Baut aus allem, was OHNE zusätzlichen Fetch verfügbar ist (Produktionsplan im
// DataBundle + WO-Abgleich-Zeile + Redzone-Live-Status), ein Stufen-Modell:
//   angelegt → Staging → Küche → Blast → Plating → Sleeving → fertig
// Jede Stufe bekommt einen Status (done / active / pending / blocked). Die
// Herleitung ist bewusst eine dokumentierte HEURISTIK aus Freitext-Statusfeldern
// und kg-Signalen — kein WMS-Fakt. Fehlt der Produktionsplan, bleibt trotzdem
// eine sinnvolle Ansicht aus den Rezept-Stammdaten (Submeals, Allergene) übrig.
//
// Der wirklich lückenlose historische Verlauf (Snapshot-Kette) käme später aus
// apps/rezeptlogik/woReconciliationLog — hier v1 bewusst weggelassen.
import type { DataBundle, WorkOrderEntry } from "../../core/types";
import type { WoReconciliationRow } from "../wo-reconciliation/woReconcileTypes";
import { computeWoChiller } from "../blast-chiller/blastChillerLogic";
import { weekPrefixFromWoNumber } from "../wms-overview/wmsWeeks";
import type { WoFlow, WoFlowStage, WoFlowSubmeal, WoStageStatus } from "./searchTypes";

const DONE_RE = /fertig|done|complete|abgeschl|bereit|erledigt|closed|gepackt|freigegeben|✓/i;
const ACTIVE_RE = /lauf|progress|wip|gang|kocht|aktiv|running|started|begonnen|offen/i;
const BLOCK_RE = /block|stop|\bhold\b|fehlt|missing|wartet|warten|pausiert|problem|gesperrt/i;

function test(re: RegExp, s?: string): boolean {
  return !!s && re.test(s);
}

function splitMethods(raw?: string): string[] {
  return String(raw ?? "")
    .split(/[/,>»·|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function fmtKg(n: number): string {
  if (!n) return "0";
  return n >= 100 ? `${Math.round(n)} kg` : `${n.toFixed(1)} kg`;
}

function fmtInt(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "–" : new Intl.NumberFormat("de-DE").format(Math.round(n));
}

function fmtDeltaKg(plannedKg: number | null, actualKg: number | null): string {
  if (plannedKg == null || actualKg == null) return "–";
  const delta = actualKg - plannedKg;
  return `${delta >= 0 ? "+" : ""}${fmtKg(delta)}`;
}

function deriveDoneStatus(sleevingStatus: WoStageStatus, reconComplete: boolean, anyPost: boolean): WoStageStatus {
  if (sleevingStatus === "done" && (reconComplete || anyPost)) return "done";
  if (sleevingStatus === "active") return "active";
  return "pending";
}

function resolveWeekLabel(data: DataBundle, weekNum: number | null): string | null {
  if (weekNum == null) return null;
  const pad = `W${String(weekNum).padStart(2, "0")}`;
  return (data.weeks ?? []).find((w) => w.endsWith(`-${pad}`)) ?? `2026-${pad}`;
}

export interface BuildWoFlowParams {
  woNumber: string;
  /** Alle Produktionsplan-Zeilen (wird intern auf die WO gefiltert). */
  planRows: WorkOrderEntry[];
  recon?: WoReconciliationRow;
  data: DataBundle;
  redzone?: { platingNow: boolean; platingDone: boolean };
}

export function buildWoFlow({ woNumber, planRows, recon, data, redzone }: BuildWoFlowParams): WoFlow {
  const rows = planRows.filter((r) => String(r.workOrder ?? "").trim() === woNumber);
  const recipeCode = rows[0]?.recipeCode || recon?.recipeCode || "";
  const recipeName = rows[0]?.recipeName || recon?.recipeName || "";
  const weekNum = weekPrefixFromWoNumber(woNumber) ?? recon?.weekNum ?? null;

  const stagingKg = rows.reduce((s, r) => s + (r.stagingKg || 0), 0);
  const kitchenKg = rows.reduce((s, r) => s + (r.kitchenKg || 0), 0);
  const postKg = rows.reduce((s, r) => s + (r.postKg || 0), 0);
  const targetPortions =
    Math.max(0, ...rows.map((r) => r.targetPortions ?? r.plannedMeals ?? 0)) ||
    recon?.appPortions ||
    recon?.ketPortions ||
    null;
  const cookedPortions = Math.max(0, ...rows.map((r) => r.woCookedPortions ?? 0)) || null;
  const kitchenDay = rows.map((r) => r.kitchenDay).find(Boolean) ?? null;
  const eta = rows.map((r) => r.unlockedEta).find(Boolean) ?? null;
  const run = rows.map((r) => r.run).find((v) => v != null) ?? null;
  const logisticTarget = Math.max(0, ...rows.map((r) => r.logisticTarget ?? 0)) || null;

  const stagingStatus = rows.map((r) => r.stagingStatus).find(Boolean);
  const kitchenStatus = rows.map((r) => r.kitchenStatus).find(Boolean);
  const plannedKg = recon?.appKg ?? recon?.ketKg ?? null;

  const cookMethods = [...new Set(rows.flatMap((r) => splitMethods(r.cookMethods)))];

  // ── Submeals ────────────────────────────────────────────────────────────
  const submealRows: Partial<WorkOrderEntry>[] = rows.length
    ? rows
    : Object.values(data.recipes?.[recipeCode]?.markets ?? {})
        .flatMap((md) => md?.subRecipes ?? [])
        .map((sub) => ({ subRecipe: sub.name, cookMethods: sub.category, stagingKg: 0, kitchenKg: 0, postKg: 0, yieldPct: 0 }));
  const seenSub = new Set<string>();
  const submeals: WoFlowSubmeal[] = [];
  for (const r of submealRows) {
    const name = String(r.subRecipe ?? "").trim();
    if (!name || seenSub.has(name)) continue;
    seenSub.add(name);
    const chiller = recipeCode ? computeWoChiller(data, recipeCode, name) : null;
    submeals.push({
      name,
      cookMethods: splitMethods(r.cookMethods),
      stagingKg: r.stagingKg || 0,
      kitchenKg: r.kitchenKg || 0,
      postKg: r.postKg || 0,
      yieldPct: r.yieldPct ? r.yieldPct : null,
      chillerKey: chiller?.key ?? null,
      chillerLabel: chiller?.cfg.label ?? null,
      allergen: chiller && chiller.allergen && chiller.allergen.toUpperCase() !== "KEINE" ? chiller.allergen : null,
      allergenUnknown: chiller?.unknown ?? true,
    });
  }
  const allergens = [...new Set(submeals.map((s) => s.allergen).filter((a): a is string => !!a).flatMap((a) => a.split(/[,;]/).map((x) => x.trim())))].filter(Boolean);

  const comments = [...new Set(rows.flatMap((r) => [r.stagingComment, r.workOrderComment]).map((c) => String(c ?? "").trim()).filter(Boolean))];

  // ── Stufen-Herleitung ───────────────────────────────────────────────────
  const reconComplete = recon?.isComplete ?? false;
  const reconProgress = recon?.progressPct ?? null;
  const weighingCount = recon?.weighingCount ?? 0;
  const anyStaging = stagingKg > 0;
  const anyKitchen = kitchenKg > 0;
  const anyPost = postKg > 0;
  const platingNow = !!redzone?.platingNow;
  const platingDone = !!redzone?.platingDone;

  const stagingStatusKey: WoStageStatus =
    test(DONE_RE, stagingStatus) || anyStaging || anyKitchen || anyPost
      ? "done"
      : test(BLOCK_RE, stagingStatus)
        ? "blocked"
        : test(ACTIVE_RE, stagingStatus)
          ? "active"
          : "pending";

  const kitchenDone = anyKitchen || anyPost || reconComplete || test(DONE_RE, kitchenStatus);
  const kitchenStatusKey: WoStageStatus = kitchenDone
    ? "done"
    : test(BLOCK_RE, kitchenStatus)
      ? "blocked"
      : test(ACTIVE_RE, kitchenStatus) || weighingCount > 0
        ? "active"
        : "pending";

  const blastDone = anyPost || reconComplete || (reconProgress != null && reconProgress >= 95);
  const blastStatusKey: WoStageStatus = blastDone ? "done" : weighingCount > 0 ? "active" : "pending";

  const platingStatusKey: WoStageStatus = platingDone ? "done" : platingNow ? "active" : "pending";

  // Für die WO-Flow-Ansicht liegt aktuell noch kein verlässliches Sleeving-
  // Signal pro Work Order vor. Die Stufe bleibt deshalb sichtbar ausstehend,
  // statt einen Abschluss aus dem Plating-Status abzuleiten.
  const sleevingStatusKey: WoStageStatus = "pending";

  const doneStatusKey = deriveDoneStatus(sleevingStatusKey, reconComplete, anyPost);

  let stages: WoFlowStage[] = [
    {
      key: "created",
      label: "WO angelegt",
      icon: "📋",
      status: "done",
      when: kitchenDay,
      metrics: [
        { label: "Zieltermin", value: kitchenDay ?? "–" },
        { label: "Ziel-Portionen", value: fmtInt(targetPortions) },
        ...(run != null ? [{ label: "Run", value: String(run) }] : []),
      ],
      notes: [],
    },
    {
      key: "staging",
      label: "Staging",
      icon: "🗄️",
      status: stagingStatusKey,
      when: null,
      metrics: [
        { label: "Staging", value: fmtKg(stagingKg) },
        ...(stagingStatus ? [{ label: "Status", value: stagingStatus }] : []),
      ],
      notes: comments.filter((c) => /stag/i.test(c)),
    },
    {
      key: "kitchen",
      label: "Küche",
      icon: "🔥",
      status: kitchenStatusKey,
      when: eta,
      metrics: [
        { label: "Küche", value: fmtKg(kitchenKg) },
        ...(cookMethods.length ? [{ label: "Cook", value: cookMethods.join(" / ") }] : []),
        ...(eta ? [{ label: "ETA", value: eta }] : []),
        ...(kitchenStatus ? [{ label: "Status", value: kitchenStatus }] : []),
      ],
      notes: [],
    },
    {
      key: "blast",
      label: "Blast Chiller",
      icon: "❄️",
      status: blastStatusKey,
      when: recon?.lastWeighing ?? null,
      metrics: [
        { label: "Post-Blast", value: fmtKg(postKg) },
        ...(weighingCount ? [{ label: "Wiegungen", value: String(weighingCount) }] : []),
        ...(reconProgress != null ? [{ label: "Fortschritt", value: `${Math.round(reconProgress)} %` }] : []),
        ...(plannedKg != null ? [{ label: "Plan", value: fmtKg(plannedKg) }] : []),
        ...(recon?.actualKg != null ? [{ label: "Ist", value: fmtKg(recon.actualKg) }] : []),
        ...(plannedKg != null && recon?.actualKg != null ? [{ label: "Abweichung", value: fmtDeltaKg(plannedKg, recon.actualKg) }] : []),
        ...(recon?.lastWeighing ? [{ label: "letzte Wiegung", value: recon.lastWeighing }] : []),
      ],
      notes: [],
    },
    {
      key: "plating",
      label: "Plating",
      icon: "🍽️",
      status: platingStatusKey,
      when: null,
      metrics: [
        {
          label: "Redzone",
          value: platingDone ? "geplated" : platingNow ? "läuft gerade" : "kein Live-Signal",
        },
      ],
      notes: [],
    },
    {
      key: "sleeving",
      label: "Sleeving",
      icon: "🔄",
      status: sleevingStatusKey,
      when: null,
      metrics: [
        { label: "Status", value: "kein WO-Sleeving-Signal" },
      ],
      notes: [],
    },
    {
      key: "done",
      label: "Fertig",
      icon: "✅",
      status: doneStatusKey,
      when: null,
      metrics: [
        ...(cookedPortions != null ? [{ label: "gekocht", value: fmtInt(cookedPortions) }] : []),
        ...(logisticTarget != null ? [{ label: "Logistik-Ziel", value: fmtInt(logisticTarget) }] : []),
      ],
      notes: [],
    },
  ];

  // Rückwärts-Ableitung: ist eine spätere Stufe nachweislich erreicht, gelten die
  // früheren als erledigt (die Freitext-Statusfelder werden nicht lückenlos gepflegt).
  const lastDoneIdx = stages.reduce((acc, s, i) => (s.status === "done" ? i : acc), -1);
  stages = stages.map((s, i) => {
    if (i < lastDoneIdx && (s.status === "pending" || s.status === "unknown")) {
      return { ...s, status: "done" as WoStageStatus, notes: [...s.notes, "abgeleitet – spätere Stufe bereits erreicht"] };
    }
    return s;
  });

  // Genau eine aktive Stufe markieren, wenn es ein Live-Signal gibt, aber keine
  // Stufe aus echten Signalen schon "active" ist.
  const today = new Date().toISOString().slice(0, 10);
  const hasLiveSignal = weighingCount > 0 || platingNow || kitchenDay === today;
  if (hasLiveSignal && !stages.some((s) => s.status === "active")) {
    const firstPending = stages.findIndex((s, i) => i > lastDoneIdx && s.status === "pending");
    if (firstPending >= 0) {
      stages[firstPending] = {
        ...stages[firstPending],
        status: "active",
        notes: [...stages[firstPending].notes, "aktiv angenommen – Live-Signal vorhanden"],
      };
    }
  }

  const progressPct =
    reconProgress != null
      ? reconProgress
      : (() => {
          const done = stages.filter((s) => s.status === "done").length;
          return Math.round((done / stages.length) * 100);
        })();

  return {
    woNumber,
    recipeCode,
    recipeName,
    weekLabel: resolveWeekLabel(data, weekNum),
    weekNum,
    kitchenDay,
    targetPortions,
    cookedPortions,
    progressPct,
    severity: recon?.severity ?? null,
    sources: recon?.presentIn ?? (rows.length ? ["app"] : []),
    hasPlanRows: rows.length > 0,
    stages,
    submeals,
    cookMethods,
    allergens,
    weighingCount,
    lastWeighing: recon?.lastWeighing ?? null,
    platingNow,
    platingDone,
    comments,
    eta,
  };
}

/** Alle WO-Nummern, die zu einem Suchtreffer gehören. */
export function resolveWoNumbers(
  entry: { kind: string; woNumber?: string; recipeCode?: string; subRecipe?: string; sku?: string },
  planRows: WorkOrderEntry[],
  reconRows: WoReconciliationRow[],
): string[] {
  if (entry.kind === "wo" && entry.woNumber) return [entry.woNumber];

  const wanted = new Set<string>();
  const matches = (r: { recipeCode?: string; subRecipe?: string; recipeId?: string; workOrder?: string }) => {
    if (entry.recipeCode && r.recipeCode && r.recipeCode !== entry.recipeCode) return false;
    if (entry.kind === "submeal" && entry.subRecipe) {
      return String(r.subRecipe ?? "").trim().toLowerCase() === entry.subRecipe.toLowerCase();
    }
    if (entry.kind === "sku" && entry.sku) {
      return r.recipeId === entry.sku || String(r.subRecipe ?? "").toLowerCase().includes(entry.sku.toLowerCase());
    }
    return entry.kind === "meal";
  };
  for (const r of planRows) if (r.workOrder && matches(r)) wanted.add(r.workOrder);
  for (const r of reconRows) {
    if (!r.workOrder) continue;
    if (entry.recipeCode && r.recipeCode !== entry.recipeCode) continue;
    if (entry.kind === "submeal" && entry.subRecipe && r.subRecipe?.toLowerCase() !== entry.subRecipe.toLowerCase()) continue;
    if (entry.kind === "meal" || entry.kind === "submeal") wanted.add(r.workOrder);
  }
  return [...wanted].sort((a, b) => {
    const na = parseInt(a.split("-")[1] ?? "0", 10);
    const nb = parseInt(b.split("-")[1] ?? "0", 10);
    return na - nb || a.localeCompare(b);
  });
}
