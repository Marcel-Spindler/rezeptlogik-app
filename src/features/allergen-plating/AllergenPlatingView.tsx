import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import type { DataBundle } from "../../core/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const AM: Record<string, string> = {
  "MILCH (EINSCHLIESSLICH LAKTOSE)": "Milch (Laktose)",
  "SCHWEFELDIOXIDE UND SULFITE":      "Sulfite / Schwefeldioxid",
  "FISCH":           "Fisch",
  "EIER":            "Eier",
  "SESAMSAMEN":      "Sesam",
  "SESAM":           "Sesam",
  "SELLERIE":        "Sellerie",
  "SENF":            "Senf",
  "SCHALENFRÜCHTE":  "Nüsse / Schalenfrüchte",
  "KASCHUNÜSSE":     "Nüsse / Schalenfrüchte",
  "MANDELN":         "Nüsse / Schalenfrüchte",
  "NÜSSE":           "Nüsse / Schalenfrüchte",
  "SOJA":            "Soja",
  "GLUTENHALTIGES GETREIDE": "Weizen / Gluten",
  "WEIZEN":          "Weizen / Gluten",
};

const COLS = [
  "Milch (Laktose)", "Sulfite / Schwefeldioxid", "Fisch", "Eier",
  "Sesam", "Sellerie", "Senf", "Nüsse / Schalenfrüchte", "Soja", "Weizen / Gluten",
];

const PALETTE = [
  "#FFE0E0","#FFE8CC","#FFF5CC","#E0F2D6","#D6EAF8",
  "#E8D6F8","#D6F2EE","#FDECEA","#E8F0FE","#F8D6E8",
  "#D6F0F8","#F0F8D6","#F8ECD6","#E0E8FF","#FFD6F0",
  "#D6FFE8","#FFF0D6","#E8FFD6","#D6D6FF","#FFE8E8",
];

const W35 = [
  "Cabbage in Cheese Sauce & Minced Beef","Salmon and Sweet Soy Dressing",
  "Creamy Lemon Pepper Chicken","Salmon in creamy Gochugaru sauce",
  "Rosemary-Tomato Chicken","Chicken in tomato cream sauce",
  "Sun-Dried Tomato Penne","Vegetarian Biryani","Creamy Leek Pork tenderloin",
  "Spicy Beef & Black Bean Chili - Version B","Souvlaki-style pork tenderloin",
  "Pulled chicken with cheddar and bacon","Honey Mustard Pork Tenderloin",
  "Bulgogi Pulled Beef Bowl","Indian style butter chicken",
  "Cheddar & Red Pepper Chicken Thigh Pasta","Hot Honey Barramundi & Wild rice",
  "Chive & Garlic Chicken","Beef & pepper casserole",
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Result {
  name:     string;
  allergens: Set<string>;
  found:    boolean;
  matchedTo?: string;
}

interface IndexEntry {
  allergenRaw: string;
  displayName: string;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function normStr(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

/** Strip "FV0849A - " prefix and " [DE]" suffix from recipe name locals */
function cleanRecipeName(raw: string): string {
  return raw
    .replace(/^(?:FE|FV)\d{4}[A-Z0-9]?\s*-\s*/i, "")
    .replace(/\s*\[(?:DE|BENL|DKSE|BNL|NORDICS)\]\s*$/i, "")
    .trim();
}

function tokenScoreNorm(a: string, b: string): number {
  const ta = a.split(/\s+/).filter(x => x.length > 2);
  const tb = new Set(b.split(/\s+/).filter(x => x.length > 2));
  if (!ta.length || !tb.size) return 0;
  return ta.filter(t => tb.has(t)).length / Math.max(ta.length, tb.size);
}

/** Returns extracted canonical allergen columns for a raw allergen string */
function extractAllergens(raw: string): Set<string> {
  const s = new Set<string>();
  (raw || "").split(",").forEach(a => {
    const u = a.trim().toUpperCase();
    for (const [k, v] of Object.entries(AM)) {
      if (u.includes(k)) s.add(v);
    }
  });
  return s;
}

// ─── Build recipe allergen index from DataBundle ──────────────────────────────

function buildRecipeIndex(data: DataBundle): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();

  for (const recipe of Object.values(data.recipes)) {
    // Pick the best allergen string: prefer DE, then any market
    const allergenRaw =
      recipe.markets["DE"]?.allergens ||
      recipe.markets["BENL"]?.allergens ||
      recipe.markets["DKSE"]?.allergens ||
      "";

    const displayName = recipe.baseName;
    const entry: IndexEntry = { allergenRaw, displayName };

    const nameCandidates: string[] = [recipe.baseName];
    for (const mkt of Object.values(recipe.markets)) {
      if (mkt?.recipeNameLocal) {
        nameCandidates.push(mkt.recipeNameLocal);
        nameCandidates.push(cleanRecipeName(mkt.recipeNameLocal));
      }
    }

    for (const name of nameCandidates) {
      if (!name) continue;
      const key = normStr(name);
      if (key && !map.has(key)) map.set(key, entry);
    }
  }

  return map;
}


function findBestMatch(
  inputName: string,
  index: Map<string, IndexEntry>,
): { entry: IndexEntry; score: number } | null {
  const inputNorm = normStr(inputName);

  // 1. Exact normalized match
  const exact = index.get(inputNorm);
  if (exact) return { entry: exact, score: 1.0 };

  // 2. Substring + token match
  let best: { entry: IndexEntry; score: number } | null = null;

  for (const [key, entry] of index) {
    let score = 0;
    if (key.includes(inputNorm) || inputNorm.includes(key)) {
      score = 0.9 + Math.min(inputNorm.length, key.length) / 10_000;
    } else {
      score = tokenScoreNorm(inputNorm, key);
    }
    if (score > 0.35 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }

  return best;
}

// ─── Color assignment ─────────────────────────────────────────────────────────

function buildColorMap(results: Result[]): Record<string, string> {
  const map: Record<string, string> = {};
  let idx = 0;
  for (const r of results) {
    const key = [...r.allergens].sort().join("|");
    if (key && !map[key]) { map[key] = PALETTE[idx % PALETTE.length]; idx++; }
  }
  return map;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AllergenPlatingView({ data }: { data: DataBundle }) {
  const [recipeText, setRecipeText] = useState("");
  const [weekLabel,  setWeekLabel]  = useState("W??");
  const [results,    setResults]    = useState<Result[]>([]);
  const [showResult, setShowResult] = useState(false);
  const [toast,      setToast]      = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recipeIndex = useMemo(() => buildRecipeIndex(data), [data]);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }

  function getRecipes() {
    return recipeText.split("\n").map(l => l.trim()).filter(l => l.length > 1);
  }

  const canProcess = getRecipes().length > 0;

  // ── Process ───────────────────────────────────────────────────────────────

  function processData() {
    const recipes = getRecipes();
    if (!recipes.length) return;

    const sorted: Result[] = recipes
      .map(name => {
        const match = findBestMatch(name, recipeIndex);
        if (!match) return { name, allergens: new Set<string>(), found: false };
        return {
          name,
          allergens: extractAllergens(match.entry.allergenRaw),
          found: true,
          matchedTo: match.entry.displayName,
        };
      })
      .sort((a, b) => {
        if (a.allergens.size !== b.allergens.size) return a.allergens.size - b.allergens.size;
        return [...a.allergens].sort().join("|").localeCompare([...b.allergens].sort().join("|"));
      });

    setResults(sorted);
    setShowResult(true);

    const notFound = sorted.filter(r => !r.found).length;
    if (notFound > 0) showToast(`${sorted.length - notFound} gefunden, ${notFound} nicht in App-Daten`);
    else showToast(`Alle ${sorted.length} Rezepte gefunden ✓`);
  }

  // ── Live preview while typing ─────────────────────────────────────────────

  function matchPreview() {
    const recipes = getRecipes();
    if (!recipes.length) return null;
    return recipes.slice(0, 8).map(name => {
      const m = findBestMatch(name, recipeIndex);
      return (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 7px", borderRadius: 6, fontSize: 11, background: m ? "#E8F5E9" : "#FFF8E1" }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: m ? "#4CAF50" : "#FF9800" }} />
          <div style={{ flex: 1, fontWeight: 600, color: "#222" }}>{name}</div>
          <div style={{ color: "#888", fontSize: 10 }}>
            {m ? `→ ${m.entry.displayName.substring(0, 40)}` : "nicht in App-Daten"}
          </div>
        </div>
      );
    });
  }

  // ── Colors & Legend ───────────────────────────────────────────────────────

  const colorMap = buildColorMap(results);
  const getColor = (key: string) => key === "" ? "#FFFFFF" : (colorMap[key] ?? "#fff");

  function buildLegend() {
    const keys = [...new Set(results.map(r => [...r.allergens].sort().join("|")))];
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {keys.includes("") && <LegendItem color="#fff" label="Keine Allergene" />}
        {keys.filter(k => k !== "").map(k => (
          <LegendItem key={k} color={getColor(k)} label={k.split("|").join(" + ")} />
        ))}
      </div>
    );
  }

  // ── Export ────────────────────────────────────────────────────────────────

  function exportExcel() {
    if (!results.length) return;
    const wb = XLSX.utils.book_new();
    const rows: (string | number)[][] = [
      [`${weekLabel} – Allergenkennzeichnung`],
      ["Rezeptname", ...COLS],
    ];
    results.forEach(r => rows.push([r.name, ...COLS.map(c => r.allergens.has(c) ? "X" : "")]));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 42 }, ...COLS.map(() => ({ wch: 14 }))];
    XLSX.utils.book_append_sheet(wb, ws, `${weekLabel} Allergene`);
    XLSX.writeFile(wb, `${weekLabel}_Allergene_Plating.xlsx`);
    showToast("Excel exportiert ✓");
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  const found = results.filter(r => r.found).length;

  const s = {
    card: { background: "#fff", borderRadius: 10, border: "0.5px solid #dde3ee", padding: 14 } as React.CSSProperties,
    btnPrimary: (disabled?: boolean) => ({ padding: "7px 14px", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", background: disabled ? "#ccc" : "#2E5AAC", color: "#fff", opacity: disabled ? .4 : 1 } as React.CSSProperties),
    btnSm: (bg: string, color = "#444") => ({ padding: "4px 10px", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer", background: bg, color } as React.CSSProperties),
  };

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ fontFamily: "Arial, sans-serif", fontSize: 13, color: "#222" }}>

      {/* Header */}
      <div style={{ background: "#1F3864", color: "#fff", padding: "13px 20px", display: "flex", alignItems: "center", gap: 11, borderRadius: "10px 10px 0 0" }}>
        <div style={{ width: 32, height: 32, background: "rgba(255,255,255,.15)", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>🥗</div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            Allergen Plating Bot
            <span style={{ background: "rgba(255,255,255,.18)", borderRadius: 4, padding: "1px 7px", fontSize: 10, marginLeft: 8 }}>
              {recipeIndex.size} Rezepte in App-Daten
            </span>
          </div>
          <div style={{ fontSize: 11, opacity: .7, marginTop: 1 }}>Allergene direkt aus MSKU-Import · Sulfite / Schwefeldioxid werden nur angezeigt wenn wirklich deklariert</div>
        </div>
      </div>

      <div style={{ padding: "14px 4px" }}>

        {/* Info banner */}
        <div style={{ marginBottom: 12, borderRadius: 9, border: "1px solid #A5D6A7", background: "#E8F5E9", padding: "10px 14px", fontSize: 11.5, color: "#1B5E20" }}>
          <strong>✓ Keine Datei-Uploads nötig</strong> — Allergen-Daten werden direkt aus den MSKU-importierten Rezept­daten gelesen. Die Deklaration entspricht exakt dem, was MSKU auf Rezept­ebene ausweist. Sulfite erscheint nur bei Rezepten, bei denen es tatsächlich deklariert ist.
        </div>

        {/* Two columns: recipe input + preview */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>

          {/* Recipe names */}
          <div style={s.card}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#1F3864", marginBottom: 9 }}>📋 Rezeptnamen einfügen (einen pro Zeile)</div>
            <textarea
              value={recipeText}
              onChange={e => setRecipeText(e.target.value)}
              rows={13}
              placeholder={"Cabbage in Cheese Sauce & Minced Beef\nSalmon and Sweet Soy Dressing\n…"}
              style={{ width: "100%", border: "1px solid #d0d8e8", borderRadius: 7, padding: 9, fontSize: 12, fontFamily: "Arial, sans-serif", resize: "vertical", color: "#333", outline: "none", boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button style={s.btnSm("#f0f2f5")} onClick={() => { setRecipeText(W35.join("\n")); setWeekLabel("W35"); }}>W35 Standard laden</button>
              <button style={s.btnSm("#f0f2f5")} onClick={() => setRecipeText("")}>✕ Leeren</button>
              <span style={{ fontSize: 11, color: "#888", marginLeft: "auto" }}>{getRecipes().length} Rezepte</span>
            </div>
          </div>

          {/* Live preview */}
          <div style={s.card}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#1F3864", marginBottom: 9 }}>🔍 Matching-Vorschau (App-Daten)</div>
            {getRecipes().length > 0 ? (
              <>
                <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                  {matchPreview()}
                  {getRecipes().length > 8 && (
                    <div style={{ fontSize: 10, color: "#888", padding: "4px 7px" }}>… +{getRecipes().length - 8} weitere</div>
                  )}
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "#888" }}>KW-Label:</span>
                  <input
                    value={weekLabel}
                    onChange={e => setWeekLabel(e.target.value)}
                    style={{ border: "1px solid #d0d8e8", borderRadius: 5, padding: "3px 7px", fontSize: 11, width: 70 }}
                  />
                </div>
              </>
            ) : (
              <div style={{ color: "#aaa", fontSize: 11, textAlign: "center", marginTop: 40 }}>
                Rezeptnamen links eingeben →<br/>Matching-Vorschau erscheint automatisch
              </div>
            )}
          </div>
        </div>

        {/* Process button */}
        <div style={{ textAlign: "center", marginBottom: 14 }}>
          <button style={s.btnPrimary(!canProcess)} onClick={processData} disabled={!canProcess}>
            ⚡ Allergene aus App-Daten laden & Tabelle erstellen
          </button>
        </div>

        {/* Results */}
        {showResult && (
          <>
            {/* Stats */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <StatBox label="Woche" value={weekLabel} />
              <StatBox label="Rezepte" value={String(results.length)} />
              <StatBox label="gefunden" value={String(found)} borderColor="#4CAF50" valueColor="#2E7D32" />
              {results.length - found > 0 && (
                <StatBox label="nicht gefunden" value={String(results.length - found)} borderColor="#FF9800" valueColor="#E65100" />
              )}
            </div>

            {buildLegend()}

            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
              <button style={s.btnSm("#2E7D32", "#fff")} onClick={exportExcel}>📥 Excel exportieren</button>
            </div>

            {/* Table */}
            <div style={{ overflowX: "auto", borderRadius: 9, border: "0.5px solid #dde3ee" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 700, fontSize: 11.5 }}>
                <thead>
                  <tr>
                    <th style={{ background: "#1F3864", color: "#fff", padding: "7px 5px 7px 10px", fontSize: 10, fontWeight: 700, textAlign: "left", border: "0.5px solid rgba(255,255,255,.1)", minWidth: 200 }}>
                      Rezeptname
                    </th>
                    {COLS.map(c => (
                      <th key={c} style={{ background: "#1F3864", color: "#fff", padding: "7px 5px", fontSize: 10, fontWeight: 700, textAlign: "center", border: "0.5px solid rgba(255,255,255,.1)", whiteSpace: "nowrap" }}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map(r => {
                    const key = [...r.allergens].sort().join("|");
                    const bg = getColor(key);
                    return (
                      <tr key={r.name} style={{ background: bg }}>
                        <td style={{ padding: "5px 10px", border: "0.5px solid rgba(0,0,0,.07)", verticalAlign: "middle" }}>
                          <div style={{ fontSize: 11.5, fontWeight: 600, color: r.found ? "#222" : "#999", fontStyle: r.found ? "normal" : "italic" }}>
                            {r.name}
                          </div>
                          {r.matchedTo && r.matchedTo !== r.name && (
                            <div style={{ fontSize: 9.5, color: "#888", marginTop: 1 }}>→ {r.matchedTo}</div>
                          )}
                        </td>
                        {COLS.map(c => (
                          <td key={c} style={{ padding: "5px", border: "0.5px solid rgba(0,0,0,.07)", textAlign: "center", fontWeight: r.allergens.has(c) ? 900 : 400, fontSize: r.allergens.has(c) ? 12 : 10, color: r.allergens.has(c) ? "#222" : "rgba(0,0,0,.18)" }}>
                            {r.allergens.has(c) ? "X" : "–"}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Not found hint */}
            {results.some(r => !r.found) && (
              <div style={{ marginTop: 10, padding: "9px 12px", background: "#FFF8E1", border: "1px solid #FFD54F", borderRadius: 7, fontSize: 11, color: "#7B3F00" }}>
                <strong>Nicht gefundene Rezepte:</strong> Diese Rezeptnamen konnten nicht in den App-Daten gematcht werden. Prüfe ob der Name exakt so in MSKU steht oder nutze leicht abgewandelte Schreibweise.
                <ul style={{ marginTop: 4, marginBottom: 0, paddingLeft: 18 }}>
                  {results.filter(r => !r.found).map(r => <li key={r.name}>{r.name}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 16, right: 16, background: "#1F3864", color: "#fff", padding: "10px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, boxShadow: "0 3px 16px rgba(0,0,0,.22)", zIndex: 9999 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#333", background: "#fff", border: "0.5px solid #dde3ee", borderRadius: 6, padding: "3px 9px" }}>
      <div style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0, border: "0.5px solid rgba(0,0,0,.1)", background: color }} />
      {label}
    </div>
  );
}

function StatBox({ label, value, borderColor, valueColor }: { label: string; value: string; borderColor?: string; valueColor?: string }) {
  return (
    <div style={{ background: "#fff", border: `0.5px solid ${borderColor ?? "#dde3ee"}`, borderRadius: 7, padding: "6px 12px", fontSize: 11, color: "#555" }}>
      <strong style={{ color: valueColor ?? "#1F3864", fontSize: 13, display: "block" }}>{value}</strong>
      {label}
    </div>
  );
}
