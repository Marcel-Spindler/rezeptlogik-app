// Plating-KI: Kontext-Builder, API-Call und Typen für den Linien-Planungs-Assistenten.
// Spezialisiert auf Allergen-Minimierung, Highrunner-Strategie und Line-Optimierung.
import type { DataBundle } from "../../../core/types";
import { DAYS, SLOTS, LINES, type PlanDay, type ScheduleMap } from "./linePlanningDomain";
import { extractAllergenProfile, detectCup } from "./autoPlatingAlgorithm";

// ─── Typen ───────────────────────────────────────────────────────────────────

export type PlatingMove = {
  recipeCode: string;
  recipeName?: string;
  fromDay: string;
  fromSlot: string;
  fromLine: number;
  toDay: string;
  toSlot: string;
  toLine: number;
  reason: string;
};

export type PlatingSequenceChange = {
  line: number;
  day: string;
  newOrder: string[]; // recipe codes in new order
  reason: string;
};

export type PlatingIssue = {
  severity: "critical" | "warning" | "info";
  description: string;
  affectedSlots?: string[];
  suggestion?: string;
};

export type PlatingAIMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  proposedMoves?: { moves: PlatingMove[]; summary: string };
  proposedSequence?: { changes: PlatingSequenceChange[]; summary: string };
  issues?: PlatingIssue[];
  accepted?: boolean;
  rejected?: boolean;
};

// ─── Kontext-Builder ─────────────────────────────────────────────────────────

export function buildPlatingContext(
  schedule: ScheduleMap,
  data: DataBundle,
  lineCapacity: Record<string, number>,
  dayLineCount: Record<PlanDay, number>,
  week: string,
): string {
  const lines: string[] = [];
  lines.push(`=== PLATING-LINIENPLAN KW ${week} ===`);
  lines.push("");

  // Kapazitäten
  lines.push("=== LINIEN-KONFIGURATION ===");
  for (let li = 0; li < 3; li++) {
    lines.push(`P-Linie ${li + 1}: ${lineCapacity[String(li)] ?? 1200} Portionen/Stunde`);
  }
  lines.push("");

  // Allergen-Profile sammeln
  const allergenCache = new Map<string, Set<string>>();
  const cupCache = new Map<string, boolean>();

  for (const [, recipe] of Object.entries(schedule)) {
    if (!recipe || recipe.isBreak) continue;
    if (!allergenCache.has(recipe.code)) {
      allergenCache.set(recipe.code, extractAllergenProfile(recipe.code, data));
      cupCache.set(recipe.code, detectCup(recipe.code, data));
    }
  }

  // Pro Tag: Linienplan + Allergen-Info
  for (const day of DAYS) {
    const linesActive = dayLineCount[day] ?? 3;
    if (linesActive === 0) continue;

    lines.push(`--- ${day} (${linesActive} Linien aktiv) ---`);

    for (let li = 0; li < linesActive; li++) {
      const lineRecipes: { slot: string; code: string; name: string; allergens: string; hasCup: boolean }[] = [];
      let allergenChanges = 0;
      let prevAllergens: Set<string> | null = null;

      for (const slot of SLOTS) {
        const key = `${day}|${slot.key}|${li}`;
        const recipe = schedule[key];
        if (!recipe || recipe.isBreak) continue;

        const allergens = allergenCache.get(recipe.code) ?? new Set();
        const hasCup = cupCache.get(recipe.code) ?? false;

        if (prevAllergens) {
          for (const a of allergens) {
            if (!prevAllergens.has(a)) { allergenChanges++; break; }
          }
        }
        prevAllergens = allergens;

        lineRecipes.push({
          slot: slot.label,
          code: recipe.code,
          name: recipe.name,
          allergens: allergens.size > 0 ? [...allergens].join(", ") : "keine",
          hasCup,
        });
      }

      if (lineRecipes.length === 0) {
        lines.push(`  Linie ${li + 1}: LEER`);
      } else {
        lines.push(`  Linie ${li + 1} (${allergenChanges} Allergen-Wechsel):`);
        for (const r of lineRecipes) {
          lines.push(`    ${r.slot} | ${r.code} "${r.name}" | Allergene: ${r.allergens}${r.hasCup ? " | CUP" : ""}`);
        }
      }
    }
    lines.push("");
  }

  // Regeln
  lines.push("=== PLATING-REGELN (IMMER EINHALTEN) ===");
  lines.push("1. LINIE 1 = HIGHRUNNER: Höchstes Volumen, MINIMALE Wechsel. Idealerweise 0-1 Allergen-Wechsel pro Tag.");
  lines.push("2. LINIE 2 = FLEX: Mittlere Rezepte, mehr Wechsel erlaubt (max 3-4/Tag), aber immer allergen-ähnliche Rezepte nacheinander.");
  lines.push("3. LINIE 3 = NUR BEI OVERLOAD: Aktiviere Linie 3 nur wenn Tages-Target > 16.000 Portionen.");
  lines.push("4. ALLERGEN-REIHENFOLGE: Rezepte mit gleichen Allergenen IMMER nacheinander planen. Jeder Allergen-Wechsel = 30min Reinigung.");
  lines.push("5. FISCH AM ENDE: Fisch-Rezepte (Salmon, Barramundi, Shrimp) IMMER am Donnerstag oder Freitag (MHD 9 Tage).");
  lines.push("6. CUP-REZEPTE: Parallel zur Linie läuft Cupping. Cup-Rezepte brauchen extra Vorlauf.");
  lines.push("7. VOLUMEN-FIRST: Höheres Volumen = mehr Stunden auf der Linie (Portionen ÷ Linienkapa = Stunden).");
  lines.push("8. CHANGEOVER-BREAKS: Bei Allergen-Wechsel = 30min Break. Bei Protein-Typ-Wechsel (Fisch→Fleisch) = Full Changeover (1h).");
  lines.push("9. OPTIMIERUNGSZIEL: Minimale Gesamtzeit (Changeovers reduzieren = mehr Produktionszeit).");
  lines.push("");
  lines.push("=== REGELN FÜR DEINE VORSCHLÄGE ===");
  lines.push("- propose_plating_move: Verschiebt ein Rezept von einem Slot/Linie zu einem anderen");
  lines.push("- optimize_line_sequence: Sortiert die Reihenfolge auf einer Linie allergen-optimal um");
  lines.push("- check_plating_issues: Meldet Probleme (Allergen-Kollisionen, MHD, Lücken, zu viele Wechsel)");
  lines.push("- Bei Optimierung IMMER die gesamte Tages-Linie als Sequenz vorschlagen, nicht einzelne Moves");
  lines.push("- Begründe JEDE Änderung mit Allergen-Logik oder Volumen-Grund");

  return lines.join("\n");
}

// ─── API-Call ────────────────────────────────────────────────────────────────

type HistoryMessage = { role: "user" | "assistant"; content: string };

export async function callPlatingAI(
  context: string,
  history: HistoryMessage[],
  message: string,
): Promise<{
  text: string;
  proposedMoves?: { moves: PlatingMove[]; summary: string };
  proposedSequence?: { changes: PlatingSequenceChange[]; summary: string };
  issues?: PlatingIssue[];
}> {
  const res = await fetch("/api/local-db/gemini-plating-chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context, history, message }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "Unbekannter Fehler");
    throw new Error(`Plating-KI-Fehler ${res.status}: ${err.slice(0, 300)}`);
  }

  const result = (await res.json()) as {
    text: string;
    toolName: string | null;
    toolInput: unknown;
  };

  let proposedMoves: { moves: PlatingMove[]; summary: string } | undefined;
  let proposedSequence: { changes: PlatingSequenceChange[]; summary: string } | undefined;
  let issues: PlatingIssue[] | undefined;

  if (result.toolName === "propose_plating_move" && result.toolInput) {
    proposedMoves = result.toolInput as { moves: PlatingMove[]; summary: string };
  } else if (result.toolName === "optimize_line_sequence" && result.toolInput) {
    proposedSequence = result.toolInput as { changes: PlatingSequenceChange[]; summary: string };
  } else if (result.toolName === "check_plating_issues" && result.toolInput) {
    issues = (result.toolInput as { issues: PlatingIssue[] }).issues;
  }

  return { text: result.text, proposedMoves, proposedSequence, issues };
}
