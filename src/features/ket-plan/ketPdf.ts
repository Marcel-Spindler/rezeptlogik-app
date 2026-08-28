// Baut das druckbare HTML/PDF für einen Satz Work Orders (Breakdown-Karten je WO).
import { EQUIP_LABELS, type BatchCalc, type IngCalc, type KetRow, type ScoopInfo, type WoInstruction } from "./ketTypes";
import { escHtml, fmtKg, fmtNum, parseDateShift, sortIngredients } from "./ketLogic";
import { orderCookingMethods, parseInstructionLines, splitInstructionKeywords } from "./woInstructionBot";
import { methodColorToCSS } from "../../lib/helpers";

// Portionierwerkzeug-Badge (Scoop/Ladle/…, siehe ScoopInfo) — Farbpunkt in der
// tatsächlichen Werkzeugfarbe (methodColorToCSS) hilft in der Küche direkt beim
// Greifen des richtigen physischen Scoops, ohne den Text lesen zu müssen.
function scoopBadgeHtml(info: ScoopInfo): string {
  const tool = [info.methodType, info.methodColor].filter(Boolean).join(" ") || "Portionierung";
  const portion = info.yieldGrams ? `${fmtNum(info.yieldGrams)} ${info.yieldUom || "g"}` : "";
  const dotColor = methodColorToCSS(info.methodColor ?? undefined);
  const dot = dotColor
    ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};border:1px solid rgba(0,0,0,.25);margin-right:3px;vertical-align:middle;"></span>`
    : "";
  return `${dot}${escHtml(tool)}${portion ? ` · ${escHtml(portion)}` : ""}`;
}

// escHtml je Segment, Stationsnamen (SPICE ROOM, GRILL, OFEN, …) farblich hervorgehoben.
function escHighlight(text: string, color: string): string {
  return splitInstructionKeywords(text)
    .map(seg => seg.isKeyword ? `<b style="color:${color};">${escHtml(seg.text)}</b>` : escHtml(seg.text))
    .join("");
}

// Stationsweise gerenderte Kochanweisung (EN/DE) — geteilt zwischen der
// WO-weiten Instruction und den Instructions je Zubereitungskomponente.
function renderSteps(text: string): string {
  const lines = parseInstructionLines(text);
  if (lines.length === 0) return `<div style="font-size:9px;color:#1e293b;white-space:pre-wrap;">${escHtml(text)}</div>`;
  return lines.map(line => {
    if (line.isHeader) {
      return `<div style="margin-top:5px;margin-bottom:2px;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:#166534;border-bottom:1px solid #d1fae5;padding-bottom:1px;">${escHtml(line.text)}</div>`;
    }
    return `<div style="display:flex;gap:4px;align-items:flex-start;margin-bottom:2px;"><span style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;background:#166534;color:#fff;border-radius:50%;font-size:7px;font-weight:900;flex-shrink:0;margin-top:1px;">${line.stepNum}</span><span style="font-size:9px;color:#1e293b;line-height:1.35;white-space:pre-wrap;">${escHighlight(line.text, "#166534")}</span></div>`;
  }).join("");
}

// Zutatentabellen-Zeilen — geteilt zwischen der WO-weiten Gesamtliste und der
// Zutatenliste je Zubereitungskomponente (siehe buildComponentsHtml).
function buildIngRows(ingredients: IngCalc[]): string {
  return [...ingredients]
    .filter(ing => ing.totalKg > 0.0005 || ing.totalPcs > 0)
    .sort(sortIngredients)
    .map(ing => {
      const cat = (ing.category ?? "").trim().toUpperCase().slice(0, 3);
      const isSpice = cat === "SPI";
      const underline = ing.spiceRoom || ing.separate;
      const catBg = isSpice ? "#fbbf24" :
        ing.category === "PRO" ? "#fee2e2" :
        ing.category === "PHF" ? "#dbeafe" :
        ing.category === "DRY" ? "#f3f4f6" : "#fff";
      const rowStyle = isSpice
        ? "background:#fef3c7;border-left:4px solid #f59e0b;font-weight:700;"
        : `background:${catBg}`;
      const yieldNote = ing.yieldPct && ing.yieldPct < 1
        ? `<br><span style="font-size:8px;color:#d97706;font-weight:700">${Math.round((1 - ing.yieldPct) * 100)}% Verlust</span>`
        : "";
      const spiceBadge = isSpice
        ? `<span style="display:inline-block;font-size:7px;font-weight:900;padding:1px 5px;border-radius:3px;background:#f59e0b;color:#fff;margin-right:4px;letter-spacing:.04em;">🌶 SPICE ROOM</span>`
        : "";
      // SEPARATE = im Spice Room separat portioniert (Matteos capacity-rules.js isSeparate()).
      const separateBadge = ing.separate
        ? `<span style="display:inline-block;font-size:7px;font-weight:900;padding:1px 5px;border-radius:3px;background:#b23c17;color:#fff;margin-right:4px;letter-spacing:.04em;">SEPARATE</span>`
        : "";
      // Zeigt direkt an der Zutat, WELCHES Allergen sie einbringt — statt nur
      // die aggregierte WO-weite CONTAINS-Liste zu kennen.
      const allergenBadge = ing.allergen
        ? `<span style="display:inline-block;font-size:7px;font-weight:900;padding:1px 5px;border-radius:3px;background:#c62828;color:#fff;margin-left:4px;letter-spacing:.03em;">⚠ ${escHtml(ing.allergen)}</span>`
        : "";
      // GN-Blech-Bedarf dieser Zutat (siehe ketLogic.resolveGnTrays) — null bei
      // Zutaten ohne bekannte Kapazitäts-/Tray-Quelle (nie geraten).
      const gnBadge = ing.gnTrays && ing.gnType
        ? `<span style="display:inline-block;font-size:7px;font-weight:900;padding:1px 5px;border-radius:3px;background:#0369a1;color:#fff;margin-left:4px;letter-spacing:.03em;">📦 ${ing.gnTrays}× ${escHtml(ing.gnType)}</span>`
        : "";
      const nameStyle = underline ? ' style="text-decoration:underline;text-decoration-color:#c77d17;"' : "";
      return `<tr style="${rowStyle}">
        <td>
          ${spiceBadge}${separateBadge}${ing.category ? `<span class="cat"${isSpice ? ' style="background:#f59e0b;color:#fff;font-weight:900;"' : ""}>${ing.category}</span>` : ""}
          <span${nameStyle}>${ing.name}</span>${allergenBadge}${gnBadge}${yieldNote}
        </td>
        <td class="num hi"${underline ? ' style="text-decoration:underline;"' : ""}>${ing.totalPcs > 0 ? `${Math.round(ing.totalPcs)} Stk` : fmtKg(ing.perBatchKg)}</td>
        <td class="num"${underline ? ' style="text-decoration:underline;"' : ""}>${ing.totalPcs > 0 ? `${Math.round(ing.totalPcs)} Stk` : fmtKg(ing.totalKg)}</td>
      </tr>`;
    }).join("");
}

// Zusammengesetzte Sub-Rezepte (calc.components, siehe ketLogic.buildWoComponents):
// jede Komponente (auch mehrstufig verschachtelte "Sub-Sub-Meals") bekommt ihren
// eigenen Block mit eigenem Equipment/Batchen, eigener Zutatenliste und eigener,
// unabhängig generierter Kochanweisung — layoutet wie der Rest der App (dunkelblaue
// Kopfzeile, .ings-Tabelle), nicht als 1:1-Kopie des Factor-Referenzblatts.
function buildComponentsHtml(row: KetRow, calc: BatchCalc, woInstructions: Record<string, WoInstruction>): string {
  if (calc.components.length === 0) return "";

  const blocks = calc.components.map((component) => {
    const ingRows = buildIngRows(component.ingredients);
    const equipTiles = component.equipBatches.map((eb) => `
      <div style="background:#1e3a5f;color:#fff;border-radius:7px;padding:5px 9px;min-width:64px;text-align:center;">
        <div style="font-size:7px;color:#93c5fd;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">${escHtml(eb.label)}</div>
        <div style="font-size:14px;font-weight:900;line-height:1.2;">${eb.batches}×</div>
        <div style="font-size:7px;color:#93c5fd;">à ${fmtKg(eb.perBatchKg)}</div>
      </div>`).join("");

    const instruction = woInstructions[`${row.key}::${component.name}`];
    const instrBlock = instruction
      ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:7px 10px 4px;">
          <div>
            <div style="font-size:8px;font-weight:900;color:#166534;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px;">English</div>
            ${renderSteps(instruction.english)}
          </div>
          <div>
            <div style="font-size:8px;font-weight:900;color:#1e40af;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px;">Deutsch</div>
            ${renderSteps(instruction.german)}
          </div>
        </div>`
      : `<div style="padding:6px 10px;font-size:9px;color:#b45309;font-weight:800;background:#fffbeb;border-top:1px solid #fcd34d;">⚠ Keine Kochanweisung erzeugt / No cooking instruction generated</div>`;

    // Factor-Produktionsregeln für DIESE Komponente (eigener Name) — siehe
    // Kommentar bei factorBadgeHtml oben.
    const componentFactorHtml = [
      component.rti
        ? `<div style="margin:6px 10px 0;padding:5px 9px;background:#fff8f0;border:1px solid #e0a94f;border-radius:6px;font-size:9px;font-weight:800;color:#9a5b0e;">RTI · Ready to Eat → direkt zum Plating (kein Batch)</div>`
        : "",
      component.neverBatch
        ? `<div style="margin:6px 10px 0;padding:5px 9px;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;font-size:9px;font-weight:800;color:#991b1b;">⚠ Kein Batch — wird als Gesamtmenge produziert (Fleisch/Fisch-Regel)</div>`
        : "",
      component.readyMade
        ? `<div style="margin:6px 10px 0;padding:5px 9px;background:#faf5ff;border:1px solid #d8b4fe;border-radius:6px;font-size:9px;font-weight:800;color:#6b21a8;">Fertigprodukt — wöchentlich vorbereitet, nicht expandieren</div>`
        : "",
      !component.rti && !component.neverBatch && component.factorCapacityKg != null
        ? `<div style="margin:6px 10px 0;padding:5px 9px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-size:9px;font-weight:700;color:#166534;">
            Batch (Factor-Regel): <strong>${component.factorBatches ?? "—"}×</strong> ${component.factorBatchQtyKg != null ? fmtKg(component.factorBatchQtyKg) : "—"}
            (Kapazität ${component.factorCapacityKg} kg${component.factorFallbackCapacity ? " · Fallback" : ""})
          </div>`
        : "",
    ].join("");
    const componentGnHtml = component.gnTraySummary.length > 0
      ? `<div style="margin:5px 10px 0;font-size:9px;font-weight:800;color:#0369a1;">📦 ${component.gnTraySummary.map(s => `${s.trays}× ${escHtml(s.gnType)}`).join(" · ")}</div>`
      : "";
    const componentScoopHtml = component.scoopInfo
      ? `<div style="margin:5px 10px 0;padding:4px 8px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:5px;font-size:10px;font-weight:800;color:#7c3aed;">🥄 ${scoopBadgeHtml(component.scoopInfo)}</div>`
      : "";

    return `
    <div class="component-block">
      <div class="component-wo-ref">WO ${escHtml(row.woNumber)} · ${escHtml(row.recipeCode)} · ${escHtml(row.subRecipeName || row.recipeName)}</div>
      <div class="component-head">
        <span class="component-name">${escHtml(component.name)}</span>
        <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">${equipTiles}</div>
      </div>
      ${componentFactorHtml}
      ${componentGnHtml}
      ${componentScoopHtml}
      ${instrBlock}
      ${ingRows ? `<table class="ings"><thead><tr><th>Zutat</th><th class="num hi">Pro Batch</th><th class="num">Total</th></tr></thead><tbody>${ingRows}</tbody></table>` : ""}
    </div>`;
  }).join("");

  return `
  <div class="components-section">
    <div class="components-title">Zubereitungskomponenten (${calc.components.length}) — jede mit eigener Kochanweisung</div>
    ${blocks}
  </div>`;
}

export function buildPdf(
  rows: KetRow[],
  calcMap: Map<string, BatchCalc>,
  _caps: Record<string, number>,
  title: string,
  _source: "CSV" | "Firestore" | "LiveWMS" | "FirestoreStale" | null = null,
  woInstructions: Record<string, WoInstruction> = {},
): string {

  const cards = rows.map((row, i) => {
    const calc = calcMap.get(row.key);
    if (!calc) return "";

    const { date, shift } = parseDateShift(row.dateNeeded);
    const d = new Date(date);
    const dateStr = d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

    const cookDisplay = orderCookingMethods(calc.resolvedCookMethods).join(" → ") || "—";

    const ingRows = buildIngRows(calc.ingredients);

    const equip = calc.primaryEquip ? (EQUIP_LABELS[calc.primaryEquip] ?? calc.primaryEquip) : "—";
    const cap = calc.capacityKg ? `${calc.capacityKg} kg` : "—";
    const capBibleNote = calc.primaryCapBibleMatch
      ? ` <span style="color:#b45309;font-weight:800;" title="Kuechenbible-Kapazität (provisorisch)">📖 Kuechenbible: ${escHtml(calc.primaryCapBibleMatch.itemName)}</span>`
      : "";

    // Per-Equipment Batch-Übersicht — Rest-Batch als eigene Kachel neben den Voll-Batches,
    // statt als Zusatzzeile innerhalb der Voll-Batch-Kachel (bessere Lesbarkeit).
    const equipBatchHtml = calc.equipBatches.length > 0
      ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin:3px 0;">
          ${calc.equipBatches.map(eb => {
            const fullBatches = Math.max(0, eb.batches - (eb.remainderKg > 0 ? 1 : 0));
            const remainderTile = eb.remainderKg > 0
              ? `<div style="background:#78350f;color:#fff;border-radius:5px;padding:3px 7px;min-width:60px;text-align:center;">
                  <div style="font-size:6px;color:#fde68a;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${eb.label} · Rest</div>
                  <div style="font-size:11px;font-weight:900;line-height:1;">1× REST</div>
                  <div style="font-size:7px;color:#fde68a;">${eb.remainderKg.toFixed(1)} kg</div>
                </div>`
              : "";
            return `
            <div style="background:#1e3a5f;color:#fff;border-radius:5px;padding:3px 7px;min-width:60px;text-align:center;">
              <div style="font-size:6px;color:#93c5fd;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${eb.label}</div>
              <div style="font-size:11px;font-weight:900;line-height:1;">${fullBatches}×</div>
              <div style="font-size:7px;color:#93c5fd;">${eb.perBatchKg} kg je Batch (Kap. ${eb.capacityKg} kg)</div>
            </div>${remainderTile}`;
          }).join("")}
        </div>`
      : "";
    const primaryFullBatches = Math.max(0, calc.batches - (calc.remainderKg > 0 ? 1 : 0));
    const batchSummary = calc.remainderKg > 0
      ? `${primaryFullBatches} Batches + 1 Rest-Batch (${calc.remainderKg.toFixed(1)} kg)`
      : `${primaryFullBatches} Batches à ${fmtKg(calc.perBatchKg)}`;
    const gnTrayHtml = calc.gnTraySummary.length > 0
      ? `<div style="margin:2px 0;font-size:8px;font-weight:800;color:#0369a1;">📦 ${calc.gnTraySummary.map(s => `${s.trays}× ${escHtml(s.gnType)}`).join(" · ")}${calc.components.length > 0 ? " (aus Komponenten)" : ""}</div>`
      : "";

    // Factor-Produktionsregeln (Matteos capacity-rules.js/classify()) — ergänzt die
    // Equipment-Batch-Ansicht oben, ersetzt sie nicht. Bei zusammengesetzten
    // Sub-Rezepten (calc.components) wird das NICHT hier gezeigt (würde nach dem
    // zusammengesetzten WO-Namen klassifizieren — z.B. "Stuffed PEPPER Casserole
    // Base-V2" träfe zufällig die Paprika-Regel statt der Rindfleisch-Regel für
    // die eigentliche "Ground Beef"-Komponente), sondern pro Komponente in
    // buildComponentsHtml.
    const factorBadgeHtml = calc.components.length > 0 ? "" : [
      calc.rti
        ? `<div style="margin:3px 0;padding:3px 8px;background:#fff8f0;border:1px solid #e0a94f;border-radius:4px;font-size:8px;font-weight:800;color:#9a5b0e;">RTI · Ready to Eat → direkt zum Plating (kein Batch)</div>`
        : "",
      calc.neverBatch
        ? `<div style="margin:3px 0;padding:3px 8px;background:#fef2f2;border:1px solid #fca5a5;border-radius:4px;font-size:8px;font-weight:800;color:#991b1b;">⚠ Kein Batch — Gesamtmenge (Fleisch/Fisch)</div>`
        : "",
      calc.readyMade
        ? `<div style="margin:3px 0;padding:3px 8px;background:#faf5ff;border:1px solid #d8b4fe;border-radius:4px;font-size:8px;font-weight:800;color:#6b21a8;">Fertigprodukt — wöchentlich vorbereitet</div>`
        : "",
      !calc.rti && !calc.neverBatch && calc.factorCapacityKg
        ? `<div style="margin:3px 0;padding:3px 8px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:4px;font-size:8px;font-weight:700;color:#166534;">
            Batch (Factor): <strong>${calc.factorBatches ?? "—"}×</strong> ${calc.factorBatchQtyKg != null ? fmtKg(calc.factorBatchQtyKg) : "—"}
            (Kap. ${calc.factorCapacityKg} kg${calc.factorFallbackCapacity ? " · Fallback" : ""})
          </div>`
        : "",
    ].join("");
    const allergenHtml = calc.allergensContains.length > 0
      ? `<div style="margin:3px 0;padding:3px 8px;background:#fff8f6;border-bottom:1px solid #f0d8d0;border-radius:4px;display:flex;flex-wrap:wrap;gap:3px;align-items:center;">
          <span style="font-weight:900;color:#c62828;font-size:8px;">⚠ CONTAINS</span>
          ${calc.allergensContains.map(a => `<span style="background:#c62828;color:#fff;font-weight:800;font-size:7px;padding:1px 5px;border-radius:6px;">${escHtml(a)}</span>`).join("")}
        </div>`
      : "";
    const chillerHtml = calc.chillerAssignment
      ? `<div style="margin:3px 0;padding:3px 8px;background:${calc.chillerAssignment.cfg.headBg};border-radius:4px;display:flex;align-items:center;gap:4px;">
          <span style="font-weight:900;color:${calc.chillerAssignment.cfg.headColor};font-size:8px;">❄️ ${escHtml(calc.chillerAssignment.cfg.label)}</span>
          <span style="font-weight:700;color:${calc.chillerAssignment.cfg.headColor};font-size:7px;opacity:.8;">${escHtml(calc.chillerAssignment.cfg.sub)}</span>
          ${calc.chillerAssignment.unknown ? `<span style="font-weight:900;color:#b45309;font-size:7px;">⚠ unbekannt</span>` : ""}
        </div>`
      : "";

    // Zusammengesetzte Sub-Rezepte bekommen ihre Instruction(s) NICHT hier
    // (eine WO-weite, vermischte Anweisung wäre irreführend), sondern je
    // Komponente in componentsHtml unten (siehe buildComponentsHtml).
    const generatedInstruction = calc.components.length === 0 ? woInstructions[row.key] : undefined;
    const instrHtml = generatedInstruction
      ? `<div style="margin-top:8px;border:1px solid #d1fae5;border-radius:7px;overflow:hidden;">
          <div style="background:#f0fdf4;padding:4px 10px;border-bottom:1px solid #d1fae5;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:#166534;">Kochanweisung · ${escHtml(row.subRecipeName)}</span>
            ${generatedInstruction.status === "needs_review" ? '<span style="font-size:7px;color:#d97706;font-weight:700;">⚠ Review erforderlich</span>' : ""}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:6px 10px;">
            <div>
              <div style="font-size:8px;font-weight:900;color:#166534;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px;">English</div>
              ${renderSteps(generatedInstruction.english)}
            </div>
            <div>
              <div style="font-size:8px;font-weight:900;color:#1e40af;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px;">Deutsch</div>
              ${renderSteps(generatedInstruction.german)}
            </div>
          </div>
        </div>`
      : "";
    // Notfall-Druck ohne Kochanweisung (Gate-Override in der UI): die Seite wird
    // trotzdem gedruckt, trägt aber einen deutlichen Hinweis. Nur für einfache
    // WOs — zusammengesetzte zeigen den Hinweis je Komponente (buildComponentsHtml).
    const noInstrHtml = calc.components.length === 0 && !generatedInstruction
      ? `<div style="margin-top:8px;padding:5px 10px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;font-size:9px;font-weight:900;color:#92400e;">⚠ Ohne Kochanweisung / Without cooking instruction</div>`
      : "";
    const componentsHtml = buildComponentsHtml(row, calc, woInstructions);

    const unlockedEtaStr = row.unlockedEta
      ? (() => { try { return new Date(row.unlockedEta).toLocaleString("de-DE"); } catch { return row.unlockedEta; } })()
      : null;


    // Duplex-Druck: "card-front" (alles außer Zutaten) und "card-back" (Zutaten)
    // sind je ein page-break-inside:avoid-Block (siehe CSS). Passt beides auf eine
    // Seite, bleibt es eine Seite; reicht der Platz nicht, rutscht der komplette
    // card-back-Block als Ganzes auf die Rückseite (nie nur ein Teil der Tabelle).
    // Die Meal-Kennung wird deshalb im card-back-Block wiederholt — falls er allein
    // auf der Rückseite landet, weiß man ohne Vorderseite trotzdem, zu welcher WO
    // die Zutaten gehören.
    return `
<section class="card" style="page-break-before:${i > 0 ? "always" : "auto"};page-break-after:auto">
  <div class="card-front">
  <div class="card-top">
    <div>
      <div class="wo-num">WO ${row.woNumber}</div>
      <div class="date-tag">${dateStr}${shift ? ` · Shift ${shift}` : ""}</div>
    </div>
    <div class="recipe-tag">
      <div class="code">${row.recipeCode}</div>
      <div class="rname">${row.recipeName}</div>
    </div>
  </div>

  <div class="sub">${row.subRecipeName || "—"}</div>

  <div class="methods">${cookDisplay}</div>

  <div class="stats">
    <div class="stat">
      <div class="slabel">Ziel-Portionen</div>
      <div class="sval">${fmtNum(row.targetPortions)}</div>
    </div>
    <div class="stat">
      <div class="slabel">Total KG (Roh)</div>
      <div class="sval">${calc.totalKg > 0 ? fmtKg(calc.totalKg) : (calc.recipeFound ? "kein Sub" : "Rezept?")}</div>
    </div>
    <div class="stat">
      <div class="slabel">Primär-Equipment</div>
      <div class="sval" style="font-size:13px">${equip}</div>
      <div style="font-size:9px;color:#6b7280;margin-top:1px">${cap} / Batch${capBibleNote}</div>
    </div>
    <div class="stat hi-stat">
      <div class="slabel">BATCHE (${equip})${calc.primaryCapBibleMatch ? ` <span title="Kuechenbible-Kapazität (provisorisch)">📖</span>` : ""}</div>
      <div class="sval big">${calc.batches > 0 ? calc.batches : "—"}</div>
      <div style="font-size:9px;color:#dbeafe;font-weight:800;margin-top:2px;">${calc.batches > 0 ? batchSummary : "—"}</div>
    </div>
    <div class="stat">
      <div class="slabel">Pro Batch</div>
      <div class="sval">${calc.perBatchKg > 0 ? fmtKg(calc.perBatchKg) : "—"}</div>
    </div>
  </div>

  ${equipBatchHtml}
  ${gnTrayHtml}
  ${calc.scoopInfo ? `<div style="margin:3px 0;padding:4px 8px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:5px;display:flex;align-items:center;gap:4px;font-size:10px;font-weight:800;color:#7c3aed;">🥄 ${scoopBadgeHtml(calc.scoopInfo)}</div>` : ""}
  ${factorBadgeHtml}
  ${allergenHtml}
  ${chillerHtml}

  <div class="badges">
    <span class="badge ${row.kitchenStatus === "Post Blast" ? "badge-green" : row.kitchenStatus === "Pre Blast" ? "badge-amber" : "badge-gray"}">
      Kitchen: ${row.kitchenStatus || "—"}
    </span>
    <span class="badge ${row.stagingStatus === "Staged" ? "badge-green" : row.stagingStatus === "Partially Staged" ? "badge-orange" : row.stagingStatus === "Picking" ? "badge-blue" : "badge-gray"}">
      Staging: ${row.stagingStatus || "—"}
    </span>
    ${unlockedEtaStr ? `<span class="badge badge-blue">🔓 Unlocked: ${unlockedEtaStr}</span>` : ""}
  </div>

  ${row.workOrderComment ? `<div class="comment warn">⚠ WO Kommentar: ${row.workOrderComment}</div>` : ""}
  ${row.stagingComment ? `<div class="comment info">💬 Staging: ${row.stagingComment}</div>` : ""}
  ${instrHtml}
  ${noInstrHtml}
  </div>

  ${componentsHtml}

  <div class="card-back">
  <div class="back-id">WO ${row.woNumber} · ${escHtml(row.recipeCode)} · ${escHtml(row.subRecipeName || row.recipeName)}</div>
  ${calc.scoopInfo ? `<div style="margin:2px 0 4px;padding:3px 8px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:4px;font-size:9px;font-weight:800;color:#7c3aed;">🥄 ${scoopBadgeHtml(calc.scoopInfo)}</div>` : ""}
  ${ingRows ? `
  <table class="ings">
    <thead><tr><th>Zutat</th><th class="num hi">Pro Batch</th><th class="num">Total</th></tr></thead>
    <tbody>${ingRows}</tbody>
    <tfoot><tr>
      <td><strong>${calc.components.length > 0 ? "ALLE ZUTATEN GESAMT" : "GESAMT"} (${calc.batches > 0 ? batchSummary : "1 Batch"})</strong></td>
      <td class="num hi"><strong>${fmtKg(calc.perBatchKg)}</strong></td>
      <td class="num"><strong>${fmtKg(calc.totalKg)}</strong></td>
    </tr></tfoot>
  </table>` : `
  <div class="no-data">${!calc.recipeFound ? "⚠ Rezept nicht in App-Daten — KG-Berechnung nicht möglich." : "⚠ Sub-Rezept in Zutaten nicht gefunden."}</div>`}
  </div>
</section>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:9px;color:#111;background:#fff}
.page-header,.equip-section{display:none}
.card{padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;margin:4px;background:#fff}
.card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.wo-num{font-size:13px;font-weight:900;color:#1e3a5f;line-height:1}
.date-tag{font-size:8px;color:#6b7280;margin-top:1px}
.recipe-tag{text-align:right}
.code{font-size:8px;font-weight:700;color:#9ca3af;font-family:monospace}
.rname{font-size:8px;font-weight:600;color:#374151;max-width:220px;text-align:right}
.sub{font-size:11px;font-weight:900;color:#111;border-bottom:1px solid #e2e8f0;padding-bottom:3px;margin-bottom:4px}
.methods{background:linear-gradient(135deg,#0f2240,#1e3a5f);color:#fff;border-radius:4px;padding:3px 8px;font-size:8px;font-weight:700;letter-spacing:.03em;margin-bottom:4px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;margin-bottom:4px}
.stat{background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:2px 4px}
.hi-stat{background:#1e3a5f;border-color:#1e3a5f}
.stat-green{background:#f0fdf4;border-color:#bbf7d0}
.stat-red{background:#fef2f2;border-color:#fecaca}
.slabel{font-size:5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;margin-bottom:0}
.hi-stat .slabel{color:#93c5fd}
.stat-green .slabel{color:#16a34a}
.stat-red .slabel{color:#dc2626}
.sval{font-size:9px;font-weight:900;color:#111;line-height:1.1}
.hi-stat .sval{color:#fff}
.stat-green .sval{color:#15803d}
.stat-red .sval{color:#b91c1c}
.sval.big{font-size:11px}

.components-section{margin-bottom:4px}
.components-title{font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:#64748b;margin:4px 0 3px;padding-top:4px;border-top:1px solid #e2e8f0}
.component-block{border:1px solid #dbe3ee;border-radius:6px;margin-bottom:4px;overflow:hidden;page-break-inside:avoid;break-inside:avoid-page}
.component-head{background:#0f2240;color:#fff;padding:4px 8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px}
.component-name{font-size:10px;font-weight:900}
.component-wo-ref{font-size:7px;font-weight:700;color:#64748b;padding:2px 8px;border-bottom:1px solid #e2e8f0;background:#f8fafc}
.badges{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:3px}
.badge{font-size:8px;font-weight:700;padding:1px 5px;border-radius:4px}
.badge-green{background:#d1fae5;color:#065f46}
.badge-amber{background:#fef3c7;color:#92400e}
.badge-orange{background:#ffedd5;color:#9a3412}
.badge-blue{background:#dbeafe;color:#1e40af}
.badge-gray{background:#f1f5f9;color:#475569}
.badge-red{background:#fee2e2;color:#991b1b}
.comment{font-size:8px;padding:3px 8px;border-radius:4px;margin-bottom:3px;border-left:2px solid transparent}
.comment.warn{background:#fef3c7;color:#92400e;border-color:#fbbf24}
.comment.info{background:#f1f5f9;color:#374151;border-color:#94a3b8}
.comment.instr{background:#eff6ff;color:#1e40af;border-color:#93c5fd}
.ings{width:100%;border-collapse:collapse;margin-top:4px;font-size:8px}
.ings th{background:#f1f5f9;padding:2px 6px;text-align:left;font-weight:700;font-size:7px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e2e8f0;color:#475569}
.ings td{padding:2px 6px;border-bottom:1px solid #f1f5f9;vertical-align:top}
.ings thead{display:table-header-group}
.ings tr{break-inside:avoid;page-break-inside:avoid}
.ings{break-inside:auto;page-break-inside:auto}
.ings tfoot td{border-top:1.5px solid #1e3a5f;padding-top:3px;background:#f8fafc}
.num{text-align:right;white-space:nowrap;font-weight:600}
.hi{color:#1e40af;font-weight:700}
.cat{display:inline-block;font-size:7px;font-weight:700;padding:0 3px;border-radius:2px;background:#f1f5f9;color:#64748b;margin-right:3px}
.no-data{padding:6px;background:#fef3c7;border-radius:4px;font-size:8px;color:#92400e;margin-top:4px;border-left:2px solid #fbbf24}
.back-id{display:none}
@media print{
  body{font-size:8px}
  .card{
    page-break-before:always;page-break-after:auto;page-break-inside:auto;
    break-before:page;break-after:auto;break-inside:auto;
    margin:0;border-width:1px;box-shadow:none;border-radius:4px;
    padding:6px 8px;
    max-height:none;overflow:visible;
  }
  .card:first-of-type{page-break-before:auto;break-before:auto}
  .card-front,.card-back{page-break-inside:avoid;break-inside:avoid-page}
  .back-id{
    display:block;font-size:8px;font-weight:800;color:#1e3a5f;
    padding-bottom:2px;margin-bottom:3px;border-bottom:1.5px solid #1e3a5f;
  }
  .wo-num{font-size:11px}.sub{font-size:10px}
  .stats{gap:2px;margin-bottom:3px}
  .sval{font-size:8px}.sval.big{font-size:10px}
  .stat{padding:1px 3px}.slabel{font-size:5px}

  .methods{padding:3px 6px;font-size:8px}
  .component-name{font-size:9px}
  /* Sub-Meals dürfen nie durch einen Seitenumbruch getrennt werden,
     aber auch nicht erzwungen auf neue Seiten — so wenig Papier wie möglich. */
  .component-block{page-break-inside:avoid;break-inside:avoid-page}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  @page{size:A4;margin:8mm}
}
</style>
</head>
<body>
${cards}
</body>
</html>`;
}
