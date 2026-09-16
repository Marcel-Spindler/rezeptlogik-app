import { Fragment, useState, useCallback, useMemo, useEffect } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// CSS: wird einmalig in <head> injiziert; @media print blendet alle UI-Elemente
// aus und gibt nur den Druckinhalt sauber wieder.
// ─────────────────────────────────────────────────────────────────────────────
const PRINT_CSS = `
@media print {
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }

  /* Alles ausblenden außer dem Druckbereich */
  #ket-noprint { display: none !important; }

  /* Druckbereich: normaler Dokumentfluss, kein fixed/absolute → kein Clipping */
  #ket-print-area {
    display: block !important;
    font-family: Arial, sans-serif;
    font-size: 10.5pt;
    color: #000;
    margin: 0;
    padding: 0;
  }

  #ket-print-area .print-warning {
    border: 1.5pt solid #ca8a04 !important;
    background: #fef9c3 !important;
    border-radius: 4pt;
    font-weight: 700;
    font-size: 10pt;
    color: #713f12;
  }

  /* Shift-Karte: keine harte page-break-Regel, damit langer Inhalt fließt */
  #ket-print-area .shift-card {
    border: 0.5pt solid #dde3ee;
    border-radius: 6pt;
    margin-bottom: 12pt;
    padding: 0;
    overflow: hidden;
    break-before: auto;
  }

  #ket-print-area .shift-card-header {
    background: #1F3864 !important;
    color: #fff !important;
    padding: 5pt 10pt;
    font-weight: 700;
    font-size: 10pt;
  }

  #ket-print-area table {
    width: 100%;
    border-collapse: collapse;
    font-size: 9.5pt;
  }
  #ket-print-area thead th {
    background: #f1f5f9 !important;
    padding: 4pt 7pt;
    text-align: left;
    font-size: 7.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .04em;
    color: #64748b;
    border-bottom: 1pt solid #cbd5e1;
  }
  #ket-print-area tbody td {
    padding: 4pt 7pt;
    border-bottom: .5pt solid #e2e8f0;
    vertical-align: middle;
  }
  #ket-print-area .row-recipe td {
    background: #dbeafe !important;
    color: #1e3a8a !important;
    font-weight: 700;
    font-size: 9pt;
    padding: 4pt 8pt;
    border-top: 1pt solid #93c5fd;
  }
  #ket-print-area .row-data-even td { background: #fff !important; }
  #ket-print-area .row-data-odd  td { background: #f8fafc !important; }
  #ket-print-area .row-done td { opacity: .4; text-decoration: line-through; }
  #ket-print-area .badge {
    display: inline-block;
    padding: 1pt 5pt;
    border-radius: 3pt;
    font-size: 8pt;
    font-weight: 700;
  }
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// CSV-Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface KetRow {
  dateNeeded:    string;
  workOrder:     string;
  recipeName:    string;
  subRecipeName: string;
  stagingStatus: string;
}

interface ParsedDate { date: string; shift: number; }

function parseDateNeeded(raw: string): ParsedDate {
  const date = raw.split(" ")[0].trim();
  const shiftMatch = raw.match(/-\s*(\d+)\s*$/);
  return { date, shift: shiftMatch ? parseInt(shiftMatch[1], 10) : 1 };
}

function stagingDay(cookDate: string): string {
  const d = new Date(cookDate + "T12:00:00");
  if (isNaN(d.getTime())) return cookDate;
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function fmtLong(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtShort(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
}

function fmtDD_MM_YYYY(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++; let val = "";
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else val += line[i++];
      }
      fields.push(val);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { fields.push(line.slice(i)); i = line.length; }
      else { fields.push(line.slice(i, end)); i = end + 1; }
    }
  }
  return fields;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(l => {
    const vals = parseCsvLine(l);
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] ?? ""; });
    return obj;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Gruppierung
// ─────────────────────────────────────────────────────────────────────────────

interface RecipeGroup  { recipeName: string; rows: KetRow[]; }
interface ShiftGroup   { shift: number; recipeGroups: RecipeGroup[]; totalRows: number; }
interface DateGroup    { cookDate: string; stagDate: string; shifts: ShiftGroup[]; totalRows: number; }

function buildGroups(rows: KetRow[]): DateGroup[] {
  const byDate = new Map<string, Map<number, Map<string, KetRow[]>>>();
  for (const row of rows) {
    const { date, shift } = parseDateNeeded(row.dateNeeded);
    if (!date || date.length < 8) continue;
    if (!byDate.has(date)) byDate.set(date, new Map());
    const byShift = byDate.get(date)!;
    if (!byShift.has(shift)) byShift.set(shift, new Map());
    const byRecipe = byShift.get(shift)!;
    const key = row.recipeName || "(kein Rezept)";
    if (!byRecipe.has(key)) byRecipe.set(key, []);
    byRecipe.get(key)!.push(row);
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, shiftMap]) => {
      const shifts: ShiftGroup[] = Array.from(shiftMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([shift, recipeMap]) => {
          const recipeGroups = Array.from(recipeMap.entries())
            .map(([recipeName, r]) => ({ recipeName, rows: r }));
          return { shift, recipeGroups, totalRows: recipeGroups.reduce((n, g) => n + g.rows.length, 0) };
        });
      return { cookDate: date, stagDate: stagingDay(date), shifts, totalRows: shifts.reduce((n, s) => n + s.totalRows, 0) };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// GDrive-HTML — standalone Druckseite (muss IDENTISCH mit Print-CSS aussehen)
// ─────────────────────────────────────────────────────────────────────────────

const BADGE_BG: Record<string, string> = {
  "Open":                "#e2e8f0",
  "Released":            "#bae6fd",
  "Picking":             "#c7d2fe",
  "Allocation Pending":  "#fde68a",
  "Partially Allocated": "#fde68a",
  "Partially Staged":    "#fed7aa",
};

function esc(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function generatePrintHtml(group: DateGroup, checkedWos: Set<string>): string {
  const shiftsHtml = group.shifts.map(({ shift, recipeGroups, totalRows }) => {
    const tbody = recipeGroups.map(({ recipeName, rows }) => {
      const dataRows = rows.map((r, i) => {
        const done = checkedWos.has(r.workOrder);
        const bg = i % 2 === 0 ? "#fff" : "#f8fafc";
        return `<tr style="background:${bg};${done ? "opacity:.4;text-decoration:line-through;" : ""}">
          <td style="width:28px;text-align:center;padding:4px 4px;border-bottom:.5pt solid #e2e8f0;"><input type="checkbox"${done ? " checked" : ""}></td>
          <td style="padding:4px 8px;border-bottom:.5pt solid #e2e8f0;font-family:monospace;font-size:10px;color:#475569;">${esc(r.workOrder)}</td>
          <td style="padding:4px 8px;border-bottom:.5pt solid #e2e8f0;">${esc(r.subRecipeName)}</td>
          <td style="padding:4px 8px;border-bottom:.5pt solid #e2e8f0;">
            <span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;background:${BADGE_BG[r.stagingStatus] ?? "#e2e8f0"};">${esc(r.stagingStatus)}</span>
          </td>
        </tr>`;
      }).join("");
      return `<tr style="background:#dbeafe;">
          <td colspan="4" style="padding:5px 10px;font-weight:700;font-size:10px;color:#1e3a8a;border-top:1pt solid #93c5fd;">&#128203; ${esc(recipeName)}</td>
        </tr>${dataRows}`;
    }).join("");

    return `<div style="margin-bottom:14px;page-break-inside:avoid;">
      <div style="background:#1F3864;color:#fff;padding:5px 10px;border-radius:5px;font-weight:700;font-size:11px;margin-bottom:5px;">
        ${shift === 1 ? "Frühschicht (Shift 1)" : shift === 2 ? "Spätschicht (Shift 2)" : `Shift ${shift}`} &mdash; ${totalRows} Work Order${totalRows !== 1 ? "s" : ""}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:10.5px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="width:28px;padding:4px 4px;"></th>
            <th style="padding:4px 8px;text-align:left;font-size:8px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;border-bottom:1pt solid #cbd5e1;width:100px;">Work Order</th>
            <th style="padding:4px 8px;text-align:left;font-size:8px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;border-bottom:1pt solid #cbd5e1;">Sub Meal</th>
            <th style="padding:4px 8px;text-align:left;font-size:8px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;border-bottom:1pt solid #cbd5e1;width:160px;">Status</th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
  }).join("");

  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<title>KET Druckplan &mdash; Stagientag ${fmtLong(group.stagDate)}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 11pt; margin: 14mm 16mm; color: #000; }
  @media print { body { margin: 10mm 12mm; } }
  input[type=checkbox] { width: 13px; height: 13px; cursor: pointer; }
  @media print {
    input[type=checkbox] { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head><body>
<h1 style="font-size:15pt;margin:0 0 2px;color:#000;">
  Stagientag: <strong>${fmtLong(group.stagDate)}</strong>
</h1>
<div style="font-size:10pt;color:#475569;margin-bottom:14px;">
  Kochtag: <strong style="color:#1F3864;">${fmtLong(group.cookDate)}</strong>
  &nbsp;&middot;&nbsp; ${group.totalRows} offene WOs &nbsp;&middot;&nbsp; Staged ausgeblendet
</div>

<div style="margin-bottom:14px;padding:8px 12px;border:1.5px solid #ca8a04;background:#fef9c3;border-radius:5px;font-weight:700;font-size:11pt;color:#713f12;">
  &#9888;&#65039; Wenn alle abgearbeitet &mdash; bitte melden, um den Fortschritt zu dokumentieren!
  <br><span style="font-size:10pt;">Und ihr glaubt ihr seid fertig? Neeee &mdash; wir haben garantiert noch was! &#128521;</span>
</div>

${shiftsHtml}
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GDrive
// ─────────────────────────────────────────────────────────────────────────────

async function saveToDrive(group: DateGroup, fileName: string, checkedWos: Set<string>): Promise<{ ok: boolean; msg: string }> {
  const html = generatePrintHtml(group, checkedWos);
  const res = await fetch("/api/local-db/ket-druckplan-save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stagingDay: group.stagDate, cookDay: group.cookDate, html, fileName }),
  });
  const data = await res.json() as { ok: boolean; folder?: string; error?: string; stub?: boolean };
  if (!data.ok) throw new Error(data.error ?? "Unbekannter Fehler");
  return { ok: true, msg: `Gespeichert in „${data.folder}"${data.stub ? " (lokaler Stub)" : ""}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline-Style-Konstanten (Blast-Chiller-Look)
// ─────────────────────────────────────────────────────────────────────────────

const S = {
  card:  { background: "#fff", borderRadius: 10, border: "0.5px solid #dde3ee", padding: 14 } as React.CSSProperties,
  btn:   (bg: string, color = "#fff", disabled = false) => ({
    padding: "6px 14px", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    background: disabled ? "#ccc" : bg, color, opacity: disabled ? .5 : 1,
  } as React.CSSProperties),
};

const STATUS_COLOR: Record<string, string> = {
  "Open":                "#e2e8f0",
  "Released":            "#bae6fd",
  "Picking":             "#c7d2fe",
  "Allocation Pending":  "#fde68a",
  "Partially Allocated": "#fde68a",
  "Partially Staged":    "#fed7aa",
};

// ─────────────────────────────────────────────────────────────────────────────
// Komponente
// ─────────────────────────────────────────────────────────────────────────────

export function KetDruckplanView() {
  const [groups, setGroups]         = useState<DateGroup[]>([]);
  const [fileName, setFileName]     = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [driveStatus, setDriveStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [driveBusy, setDriveBusy]   = useState(false);
  const [allProgress, setAllProgress] = useState<{ done: number; total: number } | null>(null);
  const [checkedWos, setCheckedWos] = useState<Set<string>>(new Set());
  const [drag, setDrag]             = useState(false);

  // Print-CSS einmalig in <head> injizieren
  useEffect(() => {
    const tag = document.createElement("style");
    tag.id = "ket-druckplan-print-css";
    tag.textContent = PRINT_CSS;
    document.head.appendChild(tag);
    return () => { document.head.removeChild(tag); };
  }, []);

  const toggleWo = useCallback((wo: string) => {
    setCheckedWos(prev => { const n = new Set(prev); n.has(wo) ? n.delete(wo) : n.add(wo); return n; });
  }, []);

  // ── CSV lesen ───────────────────────────────────────────────────────────────

  const handleFile = useCallback((file: File) => {
    setParseError(null); setDriveStatus(null); setCheckedWos(new Set());
    setGroups([]); setFileName(null); setSelectedDay(null);

    const reader = new FileReader();
    reader.onerror = () => setParseError(`Datei konnte nicht gelesen werden: ${file.name}`);
    reader.onload = (e) => {
      try {
        let text = e.target?.result as string;
        if (!text) { setParseError("Datei ist leer."); return; }
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM

        const parsed = parseCsv(text);
        if (!parsed.length) { setParseError("CSV hat keine Datenzeilen."); return; }

        const headers = Object.keys(parsed[0]);
        console.log("[KET Druckplan] Spalten:", headers);

        const dateCol   = headers.find(h => h.trim() === "Date Needed");
        const statusCol = headers.find(h => h.trim() === "Staging Status");
        if (!dateCol || !statusCol) {
          setParseError(`Spalten nicht gefunden. Erwartet: "Date Needed", "Staging Status". Gefunden: ${headers.slice(0, 8).join(", ")}`);
          return;
        }
        const woCol     = headers.find(h => h.trim() === "Work Order Number") ?? "";
        const recipeCol = headers.find(h => h.trim() === "Recipe Name") ?? "";
        const subCol    = headers.find(h => h.trim() === "Sub Recipe Name") ?? "";

        const rows: KetRow[] = parsed
          .filter(r => (r[statusCol] ?? "").trim() !== "Staged")
          .map(r => ({
            dateNeeded:    (r[dateCol] ?? "").trim(),
            workOrder:     (r[woCol] ?? "").trim(),
            recipeName:    (r[recipeCol] ?? "").trim(),
            subRecipeName: (r[subCol] ?? "").trim(),
            stagingStatus: (r[statusCol] ?? "").trim(),
          }))
          .filter(r => r.dateNeeded);

        console.log("[KET Druckplan] Offene WOs:", rows.length);
        if (!rows.length) { setParseError(`Alle ${parsed.length} Work Orders sind bereits gestaged.`); return; }

        const newGroups = buildGroups(rows);
        if (!newGroups.length) { setParseError("Keine gültigen Datumsangaben gefunden."); return; }
        setGroups(newGroups);
        setFileName(file.name);
        setSelectedDay(newGroups[0].cookDate);
      } catch (err) {
        console.error("[KET Druckplan] Fehler:", err);
        setParseError(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file, "utf-8");
  }, []);

  // ── Auto-GDrive-Upload wenn CSV geladen ────────────────────────────────────

  useEffect(() => {
    if (!groups.length) return;
    let cancelled = false;
    const errors: string[] = [];
    setAllProgress({ done: 0, total: groups.length });
    setDriveStatus(null);
    (async () => {
      for (let i = 0; i < groups.length; i++) {
        if (cancelled) break;
        const g = groups[i];
        try {
          await saveToDrive(g, `KET-Druckplan-Kochtag-${fmtDD_MM_YYYY(g.cookDate)}.html`, new Set());
        } catch { errors.push(fmtLong(g.cookDate)); }
        if (!cancelled) setAllProgress({ done: i + 1, total: groups.length });
      }
      if (!cancelled) {
        setAllProgress(null);
        setDriveStatus(errors.length
          ? { ok: false, msg: `GDrive: Fehler bei ${errors.join(", ")}` }
          : { ok: true, msg: `GDrive: alle ${groups.length} Tage gespeichert.` });
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  // ── GDrive speichern ────────────────────────────────────────────────────────

  const selectedGroup = useMemo(() => groups.find(g => g.cookDate === selectedDay) ?? null, [groups, selectedDay]);

  const driveSaveSelected = useCallback(async () => {
    if (!selectedGroup || driveBusy) return;
    setDriveBusy(true); setDriveStatus(null);
    try {
      const r = await saveToDrive(selectedGroup, `KET-Druckplan-Kochtag-${fmtDD_MM_YYYY(selectedGroup.cookDate)}.html`, checkedWos);
      setDriveStatus(r);
    } catch (err) {
      setDriveStatus({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally { setDriveBusy(false); }
  }, [selectedGroup, checkedWos, driveBusy]);

  const driveSaveAll = useCallback(async () => {
    if (!groups.length || driveBusy) return;
    setDriveBusy(true); setDriveStatus(null);
    setAllProgress({ done: 0, total: groups.length });
    const errors: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      try { await saveToDrive(g, `KET-Druckplan-Kochtag-${fmtDD_MM_YYYY(g.cookDate)}.html`, new Set()); }
      catch { errors.push(fmtLong(g.cookDate)); }
      setAllProgress({ done: i + 1, total: groups.length });
    }
    setDriveBusy(false); setAllProgress(null);
    setDriveStatus(errors.length
      ? { ok: false, msg: `Fehler bei: ${errors.join(", ")}` }
      : { ok: true, msg: `Alle ${groups.length} Tage in GDrive gespeichert.` });
  }, [groups, driveBusy]);

  // "Drucken + GDrive": erst speichern, dann drucken — 1000% Sicherheit
  const driveSaveAndPrint = useCallback(async () => {
    if (!selectedGroup) return;
    // Warten falls noch Auto-Upload läuft
    if (driveBusy || allProgress) {
      window.print(); // trotzdem drucken
      return;
    }
    setDriveBusy(true); setDriveStatus(null);
    try {
      const r = await saveToDrive(selectedGroup, `KET-Druckplan-Kochtag-${fmtDD_MM_YYYY(selectedGroup.cookDate)}.html`, checkedWos);
      setDriveStatus(r);
    } catch (err) {
      setDriveStatus({ ok: false, msg: `GDrive-Fehler (Druck trotzdem): ${err instanceof Error ? err.message : err}` });
    } finally {
      setDriveBusy(false);
      window.print();
    }
  }, [selectedGroup, checkedWos, driveBusy, allProgress]);

  const weekLabel = useMemo(() => {
    if (!fileName) return "";
    const m = fileName.match(/[Ww](\d{2,})/);
    return m ? `KW ${m[1]}` : "";
  }, [fileName]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const shiftName = (shift: number) =>
    shift === 1 ? "Frühschicht (Shift 1)" : shift === 2 ? "Spätschicht (Shift 2)" : `Shift ${shift}`;

  return (
    <div style={{ fontFamily: "Arial, sans-serif", fontSize: 13, color: "#222" }}>
      {/* ═══ NICHT-DRUCK: im Print via CSS ausgeblendet ═══ */}
      <div id="ket-noprint">

      {/* ── Header ── */}
      <div style={{ background: "#1F3864", color: "#fff", padding: "13px 20px", display: "flex", alignItems: "center", gap: 11, borderRadius: "10px 10px 0 0" }}>
        <div style={{ width: 32, height: 32, background: "rgba(255,255,255,.15)", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>📋</div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            KET Druckplan
            {weekLabel && <span style={{ background: "rgba(255,255,255,.18)", borderRadius: 4, padding: "1px 7px", fontSize: 10, marginLeft: 8 }}>{weekLabel}</span>}
          </div>
          <div style={{ fontSize: 11, opacity: .7, marginTop: 1 }}>KET-CSV hochladen → Druckzettel je Stagientag, geordnet nach Shift &amp; Rezept</div>
        </div>
      </div>

      <div id="ket-ui-body" style={{ padding: "14px 4px" }}>

        {/* ── CSV Upload ── */}
        <div id="ket-upload" style={{ ...S.card, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1F3864", marginBottom: 9 }}>📊 KET Plan CSV hochladen</div>
          <div
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            style={{ border: `2px ${groups.length ? "solid" : "dashed"} ${groups.length ? "#4CAF50" : drag ? "#1F3864" : "#BDD5FF"}`,
              borderRadius: 9, padding: "18px 14px", textAlign: "center", cursor: "pointer",
              position: "relative", background: groups.length ? "#E8F5E9" : drag ? "#EDF4FF" : "#F7FAFF" }}
          >
            <input type="file" accept=".csv,.CSV,text/csv,text/plain,application/vnd.ms-excel"
              style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
            <div style={{ fontSize: 22, marginBottom: 4 }}>{groups.length ? "✅" : "📋"}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: groups.length ? "#2E7D32" : "#1F3864" }}>
              {groups.length
                ? `${groups.reduce((n, g) => n + g.totalRows, 0)} offene WOs · ${groups.length} Kochtag${groups.length !== 1 ? "e" : ""} — ${fileName}`
                : "KET Plan CSV hier ablegen oder klicken"}
            </div>
            <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>Spalten: Work Order Number · Sub Recipe Name · Date Needed · Recipe Name · Staging Status</div>
          </div>

          {/* Kochtag-Liste */}
          {groups.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
              {groups.map(g => (
                <div key={g.cookDate}
                  onClick={() => { setSelectedDay(g.cookDate); setCheckedWos(new Set()); setDriveStatus(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderRadius: 7, fontSize: 11,
                    cursor: "pointer", userSelect: "none",
                    background: g.cookDate === selectedDay ? "#EDF4FF" : "#f7f9fc",
                    border: `1px solid ${g.cookDate === selectedDay ? "#BDD5FF" : "#eef1f6"}`,
                    fontWeight: g.cookDate === selectedDay ? 700 : 400 }}
                >
                  <span style={{ color: "#1F3864", minWidth: 220 }}>📅 Kochtag: {fmtLong(g.cookDate)}</span>
                  <span style={{ color: "#666" }}>Stagientag: {fmtShort(g.stagDate)}</span>
                  <span style={{ marginLeft: "auto", color: "#aaa", fontSize: 10 }}>{g.totalRows} WOs · {g.shifts.length} Shift{g.shifts.length !== 1 ? "s" : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Fehler ── */}
        {parseError && (
          <div id="ket-error" style={{ ...S.card, marginBottom: 12, background: "#FFF5F5", border: "1px solid #FCA5A5", color: "#991B1B", fontSize: 12 }}>
            ✗ {parseError}
          </div>
        )}

        {/* ── GDrive-Fortschritt ── */}
        {allProgress && (
          <div id="ket-progress" style={{ ...S.card, marginBottom: 12, background: "#EDF4FF", border: "1px solid #BDD5FF", color: "#1F3864", fontSize: 12, display: "flex", alignItems: "center", gap: 10 }}>
            <span>⟳</span>
            <span>GDrive Upload: {allProgress.done} / {allProgress.total} Tage …</span>
            <div style={{ flex: 1, background: "#BDD5FF", borderRadius: 99, height: 5 }}>
              <div style={{ background: "#1F3864", height: 5, borderRadius: 99, transition: "width .3s", width: `${Math.round((allProgress.done / allProgress.total) * 100)}%` }} />
            </div>
          </div>
        )}

        {/* ── GDrive Feedback ── */}
        {driveStatus && (
          <div id="ket-status" style={{ ...S.card, marginBottom: 12, fontSize: 12,
            background: driveStatus.ok ? "#E8F5E9" : "#FFF5F5",
            border: `1px solid ${driveStatus.ok ? "#A5D6A7" : "#FCA5A5"}`,
            color: driveStatus.ok ? "#1B5E20" : "#991B1B" }}>
            {driveStatus.ok ? "✓" : "✗"} {driveStatus.msg}
          </div>
        )}

        {/* ── Aktions-Leiste ── */}
        {selectedGroup && (
          <div id="ket-actions" style={{ ...S.card, marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#1F3864", marginRight: 4 }}>Aktionen:</span>

            {/* Alle Tage → GDrive */}
            <button style={S.btn("#475569", "#fff", driveBusy || !!allProgress)} onClick={driveSaveAll} disabled={driveBusy || !!allProgress}>
              {allProgress ? `⟳ ${allProgress.done}/${allProgress.total}` : `☁ Alle ${groups.length} Tage → GDrive`}
            </button>

            {/* Dieser Tag → GDrive */}
            <button style={S.btn("#2E7D32", "#fff", driveBusy)} onClick={driveSaveSelected} disabled={driveBusy}>
              {driveBusy ? "⟳ Speichern …" : "☁ Dieser Tag → GDrive"}
            </button>

            {/* Drucken + GDrive — die wichtigste Funktion */}
            <button
              style={{ ...S.btn("#1F3864", "#fff", driveBusy), marginLeft: "auto", padding: "8px 18px", fontSize: 12 }}
              onClick={driveSaveAndPrint}
              disabled={driveBusy}
            >
              {driveBusy ? "⟳ Speichern …" : "🖨 Drucken + GDrive"}
            </button>
          </div>
        )}

      </div>{/* end ket-ui-body */}
      </div>{/* end ket-noprint */}

      {/* ═══ DRUCKINHALT: nur dieser Block im Print sichtbar ═══ */}
      {selectedGroup && (
        <div id="ket-print-area">

            {/* Datums-Header */}
            <div className="print-header" style={{ ...S.card, marginBottom: 12, borderLeft: "4px solid #1F3864", display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: ".06em" }}>Stagientag</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#64748b" }}>{fmtLong(selectedGroup.stagDate)}</div>
              </div>
              <div style={{ color: "#cbd5e1", fontSize: 26, padding: "0 4px" }}>→</div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: ".06em" }}>Kochtag</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#1F3864" }}>{fmtLong(selectedGroup.cookDate)}</div>
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginLeft: 8, alignSelf: "center" }}>{selectedGroup.totalRows} offene WOs</div>
            </div>

            {/* Abschluss-Hinweis */}
            <div className="print-warning" style={{ marginBottom: 12, padding: "10px 14px", background: "#FEF9C3", border: "1.5px solid #ca8a04", borderRadius: 8, fontWeight: 700, fontSize: 12, color: "#713f12" }}>
              ⚠️ Wenn alle abgearbeitet — bitte melden, um den Fortschritt zu dokumentieren!
              <br /><span style={{ fontWeight: 400, fontSize: 11, color: "#92400e" }}>Und ihr glaubt ihr seid fertig? Neeee — wir haben garantiert noch was! 😉</span>
            </div>

            {/* Shifts */}
            {selectedGroup.shifts.map(({ shift, recipeGroups, totalRows }) => (
              <div key={shift} className="shift-card" style={{ ...S.card, marginBottom: 14, padding: 0, overflow: "hidden" }}>
                <div className="shift-card-header" style={{ background: "#1F3864", color: "#fff", padding: "7px 14px", display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 12 }}>
                  {shiftName(shift)}
                  <span style={{ color: "rgba(255,255,255,.4)", fontWeight: 400 }}>—</span>
                  <span style={{ color: "rgba(255,255,255,.75)", fontWeight: 400 }}>{totalRows} Work Order{totalRows !== 1 ? "s" : ""}</span>
                </div>
                <div style={{ padding: "8px 0 0" }}>

                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9" }}>
                      <th style={{ width: 32, padding: "5px 4px", textAlign: "center", borderBottom: "1px solid #cbd5e1" }}></th>
                      <th style={{ padding: "5px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "#64748b", borderBottom: "1px solid #cbd5e1", width: 110 }}>Work Order</th>
                      <th style={{ padding: "5px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "#64748b", borderBottom: "1px solid #cbd5e1" }}>Sub Meal</th>
                      <th style={{ padding: "5px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "#64748b", borderBottom: "1px solid #cbd5e1", width: 160 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipeGroups.map(({ recipeName, rows }) => (
                      <Fragment key={recipeName}>
                        <tr className="row-recipe" style={{ background: "#dbeafe", borderTop: "1px solid #93c5fd" }}>
                          <td colSpan={4} style={{ padding: "5px 10px", fontSize: 11, fontWeight: 700, color: "#1e3a8a" }}>
                            📋 {recipeName}
                          </td>
                        </tr>
                        {rows.map((row, i) => {
                          const done = checkedWos.has(row.workOrder);
                          return (
                            <tr key={row.workOrder}
                              className={done ? "row-done" : i % 2 === 0 ? "row-data-even" : "row-data-odd"}
                              style={{ background: done ? "#f8fafc" : i % 2 === 0 ? "#fff" : "#f8fafc",
                                opacity: done ? .45 : 1, cursor: "pointer", borderBottom: "1px solid #f1f5f9" }}
                              onClick={() => toggleWo(row.workOrder)}
                            >
                              <td style={{ padding: "5px 4px", textAlign: "center" }}>
                                <input type="checkbox" checked={done}
                                  onChange={() => toggleWo(row.workOrder)}
                                  onClick={e => e.stopPropagation()}
                                  style={{ width: 14, height: 14, cursor: "pointer" }} />
                              </td>
                              <td className="wo-num" style={{ padding: "5px 10px", fontFamily: "monospace", fontSize: 11, color: "#475569",
                                textDecoration: done ? "line-through" : "none" }}>{row.workOrder}</td>
                              <td style={{ padding: "5px 10px", color: "#1e293b", textDecoration: done ? "line-through" : "none" }}>{row.subRecipeName}</td>
                              <td style={{ padding: "5px 10px" }}>
                                <span className="badge" style={{ display: "inline-block", padding: "2px 7px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: STATUS_COLOR[row.stagingStatus] ?? "#e2e8f0" }}>
                                  {row.stagingStatus}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
                </div>{/* end padding wrapper */}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
