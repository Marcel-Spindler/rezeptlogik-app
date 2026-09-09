// Parser für die echten Factor-Produktionsblätter ("Recipes <Tag> <Datum>.pdf"
// aus dem Shared Drive). Nimmt den `pdftotext`-Klartext (DEFAULT-Modus, NICHT
// `-layout` — im Default stehen EN- und DE-Anweisungsblock jeweils als ein
// zusammenhängender Absatz, im Layout-Modus zerhackt in zweispaltige Zeilen) und
// liefert je WO / Zubereitungskomponente ein `FactorInstruction`-Paar (EN + DE),
// bereits ins App-Zeilenformat normalisiert (`A. STATION` + nummerierte Schritte).
//
// Geerntet wird nach `recipeCode::subRecipeName[::componentName]` — derselbe
// Schlüssel wie `instructionCacheKey` in ketLogic.ts, damit die App die echten
// Anweisungen direkt aus dem Firestore-Instruction-Cache zieht statt sie per
// Gemini zu approximieren.

export interface FactorInstruction {
  recipeCode: string;
  recipeName: string;
  woNumber: string;
  /** Sub-Rezeptname der WO (Kopf des WO-Blocks). */
  subRecipeName: string;
  /** Gesetzt, wenn dies eine einzelne Zubereitungskomponente ist
   *  (`↳ … — sub-recipe`, `🧂 BRINE — …`, `MARINADE — …`). */
  componentName?: string;
  english: string;
  german: string;
}

// ── Block-/Kopf-Erkennung ───────────────────────────────────────────────────
// Kopf jeder WO — Namensteil sehr variabel: "FV0485A - Rosemary-tomato chicken -
// [DE] · REC-… · 3232 portions · RUN 12", "FV4027A [DE]-Beef & BBQ sauce · REC-…",
// "FV1404A Bulgogi Shredded Beef Bowl [DE] · REC-…". Anker ist "· REC-… · N portions".
const RECIPE_HEADER_RE = /^([A-Z]{2}\d{4}[A-Z])\s*[-–]?\s*(.+?)\s*·\s*(?:REC-[\d-]+\s*·\s*)?[\d.,]+\s*portions?\b/i;
// Alles mit "· REC-…" ODER am Anfang ein Rezeptcode ist eine Kopfzeile, kein Sub-Name.
const LOOKS_LIKE_HEADER_RE = /·\s*REC-\d|^[A-Z]{2}\d{4}[A-Z]\b/;
// WO-Nummer: "WO 38-56" — steht am Kopfende oder auf der Sub-Rezept-Zeile.
const WO_RE = /\bWO\s(\d{2,3}-\d{1,4})\b/;
// Anweisungs-Marker. Präfix "BRINE — " / "MARINADE — " kennzeichnet eine
// Teilstufe (Sole-Bad bzw. Öl-Marinade) derselben WO.
const INSTR_EN_RE = /^(?:(BRINE|MARINADE|COOK|MISE EN PLACE)\s*[—–-]\s*)?INSTRUCTIONS\s*\(EN\)\s*(.*)$/i;
const INSTR_DE_RE = /^(?:(BRINE|MARINADE|COOK|MISE EN PLACE)\s*[—–-]\s*)?ANLEITUNG\s*\(DE\)\s*(.*)$/i;
// "↳ Burger Patty — sub-recipe" / "Shredded Ranch Chicken (…) -- sub-recipe"
const SUBRECIPE_MARK_RE = /^\s*↳?\s*(.+?)\s*[—–-]{1,2}\s*sub-recipe\s*$/i;
// "🧂 BRINE — Chicken Thighs - BRINED" / "MARINADE — Shredded Chicken - naturel"
const STAGE_MARK_RE = /^\s*(?:🧂\s*)?(BRINE|MARINADE)\s*[—–-]\s*(.+?)\s*$/;
// Zeilen, die sicher KEINE Anweisung / kein Sub-Rezeptname sind (Tabellen-/Meta-
// Zeilen im WO-Block).
const NOISE_LINE_RE = /^(INGREDIENT|PER BATCH|TOTAL|Cooking:|Process:|Batches:|Portion:|Shelf Life:|Marinade Name|⚠|CONTAINS|Allergen|FA-DE |DRY |SPI |PRO |PTN |OTH |Roasted Garlic \(use\)|Roasted Garlic oil|Reserved Braising|Kitchen:|Staging:|❄️|🥄|🧂|\s*$)/i;
// Allergen-Namenszeilen (nach einem gebrochenen "⚠ CONTAINS …") — nie ein Sub-Rezeptname.
const ALLERGEN_LINE_RE = /^\s*(Milk \(incl|Sulphur dioxide|Cereals containing|Tree nuts|Fish \/|Soya \/|Sesame seeds|Mustard \/|Celery \/|Eggs? \/|Peanuts?|Crustacean|Mollus|Lupin|Almonds?|Cashews?|Walnuts?|Hazelnuts?|Milch \(einschl|Schwefeldioxide|Glutenhaltiges|Schalenfrüchte|Erdnüss|Weichtiere|Krebstiere)/i;
const MARKET_TAG_RE = /\s*\[(?:DE|BENL|BNL|DKSE|NORD|EU)[}\]]\s*/gi;

// Namensteil der Kopfzeile säubern: Markt-Tags, führende/abschließende Striche.
function cleanHeaderName(raw: string): string {
  return raw
    .replace(MARKET_TAG_RE, " ")
    .replace(/^[\s–—-]+|[\s–—-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── Sprach-Heuristik (für den seltenen mehr-Absatz-Fall ohne Marker) ─────────
const DE_MARKERS = /\b(und|nicht|Sie|die|der|das|mit|auf|einer|einem|Zutaten|vermischen|hinzufügen|umfüllen|Blech|Ofen|Wanne|bis|über|für|ruhen|abtropfen)\b/gi;
const EN_MARKERS = /\b(the|and|with|until|transfer|remove|combine|mix|add|place|sheet|oven|tray|from|into|for|drain|reserve)\b/gi;

function looksGerman(text: string): boolean {
  const de = (text.match(DE_MARKERS) || []).length;
  const en = (text.match(EN_MARKERS) || []).length;
  // ß / typische Umlaut-Cluster als Tie-Breaker
  const umlaut = /[äöüÄÖÜß]/.test(text) ? 1 : 0;
  return de + umlaut > en;
}

// ── Normalisierung in unser Zeilenformat ────────────────────────────────────
// Aus "A. VEGGIE DEBOX 1. Foo 2. Bar B. OVEN 1. Baz Appearance - X 2. …" wird
//   A. VEGGIE DEBOX
//   1. Foo
//   2. Bar
//   B. OVEN
//   1. Baz
//   Appearance - X
//   2. …
export function normalizeFactorSteps(raw: string): string {
  let t = (raw || "")
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:INSTRUCTIONS\s*\(EN\)|ANLEITUNG\s*\(DE\))\s*/i, "")
    .trim();
  if (!t) return "";
  // Ganze Anweisung in "…" gewickelt (Factor-Eigenart) → Anführungszeichen weg.
  t = t.replace(/^["„]\s*/, "").replace(/\s*["""]\s*$/, "");
  // "" doppelt gesetzte "" Zitate → einfache.
  t = t.replace(/""\s*(.+?)\s*""/g, '"$1"');
  // Fehlendes Leerzeichen nach dem Stationsbuchstaben ("A.MIDDLE" → "A. MIDDLE").
  t = t.replace(/\b([A-H])\.([A-ZÄÖÜ])/g, "$1. $2");
  // Zeilenumbruch vor Stations-Headern: "A. STATION" / "A: STATION" / "B. OFEN".
  // Ein einzelner Großbuchstabe A–H, dann .|: dann GROSSWORT — der Header läuft
  // bis zum ersten Schritt ("1.") oder bis zu einem weiteren Header.
  t = t.replace(/\s+([A-H][.:]\s+[A-ZÄÖÜ][A-ZÄÖÜ0-9 ()/&'"*-]{1,}?)(?=\s+\d+[.):]\s|\s+[A-H][.:]\s+[A-ZÄÖÜ]|$)/g, "\n$1");
  // Zeilenumbruch vor Schritt-Nummern "1." / "1)" / "1:" … "12.".
  t = t.replace(/\s+(\d{1,2}[.):]\s+)/g, "\n$1");
  // Appearance-/Aussehen-Cue auf eigene Zeile. Trenner: ":", en dash oder "-".
  // Reihenfolge in der Zeichenklasse bewusst mit ":" zuerst — sonst liest
  // Tailwinds JIT-Scanner sie als Arbitrary-Property und baut invalides CSS.
  t = t.replace(/\s+((?:Appearance|Aussehen)\s*[:–-])/gi, "\n$1");
  // Stations-Header einheitlich "A." statt "A:" (Factor mischt beides).
  const out = t.split("\n")
    .map((l) => l.trim().replace(/^([A-H]):(\s)/, "$1.$2"))
    .filter(Boolean);
  // Unnummerierte Klartext-Station am Anfang (Assembly-/Middle-Kitchen-Anweisung
  // ohne Buchstaben) bekommt "A. " vorangestellt, damit der Renderer sie als
  // Stations-Header erkennt.
  const BARE_STATION = /^(MIDDLE KITCHEN|MITTLERE KÜCHE|PRODUCTION|PRODUKTION|PLATING|PLATTIEREN|SPICE ROOM|GEWÜRZRAUM|(?:VEGGIE|VEGETARISCHE|GEMÜSE|PROTEIN)[- ]?DEBOX|PROTEINDEBOX|DEBOX)\s*[:*]*\s*(\*PRE-BLAST MIX\*)?$/i;
  const hasLettered = out.some((l) => /^[A-H]\.\s/.test(l));
  return out
    .map((l) => (!hasLettered && BARE_STATION.test(l.replace(/:$/, "")) ? `A. ${l}` : l))
    .join("\n");
}

// ── Kern ────────────────────────────────────────────────────────────────────
interface RawSegment {
  lang: "en" | "de";
  stage?: string;      // "BRINE" | "MARINADE" | …
  component?: string;  // aus "↳ … — sub-recipe" oder Stage-Header
  text: string;
}

/**
 * Zerlegt den Klartext EINES Factor-Recipe-PDF (pdftotext DEFAULT-Modus) in
 * `FactorInstruction`-Einträge.
 */
export function parseFactorRecipePdfText(text: string, sourceFile?: string): FactorInstruction[] {
  void sourceFile;
  const lines = text.replace(/\r/g, "").split("\n");

  // 1) In WO-Blöcke schneiden.
  // Reihenfolge im PDF: Rezept-Kopf → Sub-Rezeptname → "WO nn-nn" → Cooking/… →
  // Zutatentabelle → INSTRUCTIONS. Der Kopf wiederholt sich (meist) vor jeder WO;
  // die WO-Nummer steht auf einer eigenen Zeile ODER am Kopfende. Wir puffern die
  // jüngste „name-artige" Zeile und schneiden bei jeder WO-Nummer einen Block.
  interface Block { recipeCode: string; recipeName: string; woNumber: string; subRecipeName: string; body: string[] }
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let recipeCode = "";
  let recipeName = "";
  let nameBuf: string[] = []; // Kandidaten für den Sub-Rezeptnamen seit der letzten Grenze

  const isNameLike = (l: string) => {
    const s = l.trim();
    return s.length >= 3 && s.length <= 90
      && !NOISE_LINE_RE.test(s) && !LOOKS_LIKE_HEADER_RE.test(s) && !ALLERGEN_LINE_RE.test(s)
      && !STAGE_MARK_RE.test(s) && !SUBRECIPE_MARK_RE.test(s)
      && !INSTR_EN_RE.test(s) && !INSTR_DE_RE.test(s)
      && !/^[A-H][.:]\s/.test(s)            // kein Stations-Header
      && !/^\d/.test(s)                      // kein Schritt / keine Menge
      && !/^[a-zäöü]/.test(s)                // Sub-Rezeptnamen sind groß/Titelcase
      && !/^\s*↳/.test(s)
      && !/\b(remove|transfer|combine|deliver|place|mix until|preheat|roast per|entfernen|vermischen|umfüllen)\b/i.test(s);
  };

  for (const line of lines) {
    const head = line.match(RECIPE_HEADER_RE);
    if (head) {
      recipeCode = head[1].toUpperCase();
      recipeName = cleanHeaderName(head[2]);
      nameBuf = [];
      const woOnHead = line.match(WO_RE);
      if (woOnHead) {
        cur = { recipeCode, recipeName, woNumber: woOnHead[1], subRecipeName: "", body: [] };
        blocks.push(cur);
      } else {
        cur = null;
      }
      continue;
    }
    if (!recipeCode) continue;

    const wo = !INSTR_EN_RE.test(line) && !INSTR_DE_RE.test(line) ? line.match(WO_RE) : null;
    if (wo) {
      const inlineName = line.replace(WO_RE, "").replace(MARKET_TAG_RE, " ").replace(/[·×\-\s]+$/u, "").trim();
      const subName = ((inlineName && isNameLike(inlineName) ? inlineName : "")
        || [...nameBuf].reverse().find(isNameLike)?.trim()
        || "").replace(MARKET_TAG_RE, " ").replace(/\s{2,}/g, " ").trim();
      if (cur && !cur.subRecipeName && cur.body.length === 0) {
        // WO-Zeile direkt nach einem Kopf-mit-WO: nur den Namen nachtragen.
        cur.woNumber = wo[1];
        cur.subRecipeName = subName;
      } else {
        cur = { recipeCode, recipeName, woNumber: wo[1], subRecipeName: subName, body: [] };
        blocks.push(cur);
      }
      nameBuf = [];
      continue;
    }

    // Name-artige Zeilen laufend puffern (nur die letzten 3) — die jüngste
    // unmittelbar vor einer "WO nn-nn"-Zeile ist deren Sub-Rezeptname.
    if (isNameLike(line)) { nameBuf.push(line.trim()); if (nameBuf.length > 3) nameBuf.shift(); }

    if (!cur) continue;
    // Sub-Rezeptname steht direkt nach der WO-Zeile / dem Kopf-mit-WO — die erste
    // name-artige Zeile vor der Zutatentabelle/den Anweisungen übernehmen.
    if (!cur.subRecipeName && isNameLike(line) && cur.body.filter((b) => b.trim()).length < 2) {
      cur.subRecipeName = cleanHeaderName(line);
    }
    cur.body.push(line);
  }

  // 2) Je Block: Anweisungs-Segmente einsammeln.
  const out: FactorInstruction[] = [];
  for (const block of blocks) {
    const segments: RawSegment[] = [];
    let activeComponent: string | undefined;
    let expectAlternating: RawSegment["lang"] | null = null;

    for (let i = 0; i < block.body.length; i++) {
      const line = block.body[i];

      const sub = line.match(SUBRECIPE_MARK_RE);
      if (sub) { activeComponent = cleanComponentName(sub[1]); expectAlternating = null; continue; }

      const stage = line.match(STAGE_MARK_RE);
      if (stage && !/INSTRUCTIONS|ANLEITUNG/i.test(line)) {
        // "🧂 BRINE — Chicken Thighs - BRINED" → Komponente = der genannte Name.
        activeComponent = cleanComponentName(stage[2]);
        expectAlternating = null;
        continue;
      }

      const en = line.match(INSTR_EN_RE);
      if (en) {
        const stageTag = en[1]?.toUpperCase();
        const inline = en[2]?.trim();
        const component = stageTag && !activeComponent ? undefined : activeComponent;
        if (inline) {
          segments.push({ lang: "en", stage: stageTag, component, text: inline });
          expectAlternating = null;
        } else {
          expectAlternating = "en";
          segments.push({ lang: "en", stage: stageTag, component, text: "" });
        }
        continue;
      }
      const de = line.match(INSTR_DE_RE);
      if (de) {
        const stageTag = de[1]?.toUpperCase();
        const inline = de[2]?.trim();
        if (inline) {
          segments.push({ lang: "de", stage: stageTag, component: activeComponent, text: inline });
          expectAlternating = null;
        } else {
          expectAlternating = "de";
          segments.push({ lang: "de", stage: stageTag, component: activeComponent, text: "" });
        }
        continue;
      }

      // Fortsetzungs-Absatz im marker-losen Mehr-Absatz-Layout.
      if (expectAlternating && line.trim() && !NOISE_LINE_RE.test(line) && !RECIPE_HEADER_RE.test(line)) {
        const lang: RawSegment["lang"] = looksGerman(line) ? "de" : "en";
        const last = [...segments].reverse().find((s) => s.lang === lang && s.component === activeComponent);
        if (last) last.text = `${last.text} ${line.trim()}`.trim();
        else segments.push({ lang, component: activeComponent, text: line.trim() });
        // nach EN folgt DE folgt EN …
        expectAlternating = lang === "en" ? "de" : "en";
      }
    }

    // 3) Segmente → EN/DE-Paare je (component ?? "WO"-Ebene), Stufen zusammenführen.
    // Der Stufen-Tag (BRINE/MARINADE) wird NICHT als Text-Header übernommen — die
    // Komponente ist über ihren Namen ("… - BRINED") bereits eindeutig.
    const groups = new Map<string, { component?: string; en: string[]; de: string[] }>();
    for (const seg of segments) {
      if (!seg.text.trim()) continue;
      const key = seg.component ?? "__wo__";
      let g = groups.get(key);
      if (!g) { g = { component: seg.component, en: [], de: [] }; groups.set(key, g); }
      (seg.lang === "en" ? g.en : g.de).push(seg.text);
    }

    for (const g of groups.values()) {
      const english = normalizeFactorSteps(g.en.join("\n"));
      const german = normalizeFactorSteps(g.de.join("\n"));
      if (!english && !german) continue;
      out.push({
        recipeCode: block.recipeCode ?? (block as unknown as { code: string }).code,
        recipeName: block.recipeName ?? (block as unknown as { name: string }).name,
        woNumber: block.woNumber,
        subRecipeName: block.subRecipeName || block.recipeName || "",
        componentName: g.component,
        english: english || german,
        german: german || english,
      });
    }
  }

  return out;
}

function cleanComponentName(name: string): string {
  return name
    .replace(/\s*↓\s*$/, "")
    .replace(/\s*↑.*$/, "")
    .replace(/\s+sub(-recipe)?\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
