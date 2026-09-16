import { Fragment, useState, useCallback, useMemo, useEffect } from "react";

// ── CSV parsing ──────────────────────────────────────────────────────────────

interface KetRow {
  dateNeeded: string;
  workOrder: string;
  recipeName: string;
  subRecipeName: string;
  stagingStatus: string;
}

interface ParsedDate {
  date: string; // "YYYY-MM-DD" (Kochtag)
  shift: number;
}

function parseDateNeeded(raw: string): ParsedDate {
  // Robust: nimm einfach alles vor dem ersten Leerzeichen als Datum
  const date = raw.split(" ")[0].trim();
  const shiftMatch = raw.match(/-\s*(\d+)\s*$/);
  const shift = shiftMatch ? parseInt(shiftMatch[1], 10) : 1;
  return { date, shift };
}

function stagingDay(cookDate: string): string {
  const d = new Date(cookDate + "T12:00:00");
  if (isNaN(d.getTime())) return cookDate;
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function fmtDateLong(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("de-DE", {
    weekday: "long", day: "2-digit", month: "2-digit", year: "numeric",
  });
}

function fmtDateShort(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit",
  });
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++;
      let val = "";
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { val += line[i++]; }
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
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ""; });
    return obj;
  });
}

// ── Gruppierung ───────────────────────────────────────────────────────────────

interface RecipeGroup {
  recipeName: string;
  rows: KetRow[];
}

interface ShiftGroup {
  shift: number;
  recipeGroups: RecipeGroup[];
  totalRows: number;
}

interface DateGroup {
  cookDate: string;
  stagDate: string;
  shifts: ShiftGroup[];
  totalRows: number;
}

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
          const recipeGroups: RecipeGroup[] = Array.from(recipeMap.entries())
            .map(([recipeName, r]) => ({ recipeName, rows: r }));
          return {
            shift,
            recipeGroups,
            totalRows: recipeGroups.reduce((n, g) => n + g.rows.length, 0),
          };
        });
      return {
        cookDate: date,
        stagDate: stagingDay(date),
        shifts,
        totalRows: shifts.reduce((n, s) => n + s.totalRows, 0),
      };
    });
}

// ── HTML-Export für GDrive ────────────────────────────────────────────────────

const BADGE_COLOR: Record<string, string> = {
  "Open":                "#e2e8f0",
  "Released":            "#bae6fd",
  "Picking":             "#c7d2fe",
  "Allocation Pending":  "#fde68a",
  "Partially Allocated": "#fde68a",
  "Partially Staged":    "#fed7aa",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function generatePrintHtml(group: DateGroup, checkedWos: Set<string>): string {
  const shiftsHtml = group.shifts.map(({ shift, recipeGroups, totalRows }) => {
    const recipesHtml = recipeGroups.map(({ recipeName, rows }) => {
      const rowsHtml = rows.map((r, i) => {
        const checked = checkedWos.has(r.workOrder) ? " checked" : "";
        return `<tr class="${i % 2 === 0 ? "even" : "odd"}${checked ? " done" : ""}">
          <td class="cb"><input type="checkbox"${checked}></td>
          <td class="mono">${esc(r.workOrder)}</td>
          <td>${esc(r.subRecipeName)}</td>
          <td><span class="badge" style="background:${BADGE_COLOR[r.stagingStatus] ?? "#e2e8f0"}">${esc(r.stagingStatus)}</span></td>
        </tr>`;
      }).join("");
      return `<tr class="recipe-header">
        <td colspan="4">📋 ${esc(recipeName)}</td>
      </tr>${rowsHtml}`;
    }).join("");

    return `<div class="shift-header">Shift ${shift} — ${totalRows} Work Order${totalRows !== 1 ? "s" : ""}</div>
    <table>
      <thead><tr>
        <th class="cb"></th>
        <th class="wo">Work Order</th>
        <th>Sub Meal</th>
        <th class="status">Status</th>
      </tr></thead>
      <tbody>${recipesHtml}</tbody>
    </table>`;
  }).join("");

  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<title>KET Druckplan — Stagientag ${fmtDateLong(group.stagDate)}</title>
<style>
  body { font-family: sans-serif; font-size: 12px; margin: 16px; color: #1e293b; }
  h1 { font-size: 16px; margin-bottom: 2px; }
  .sub { font-size: 13px; color: #64748b; margin-bottom: 16px; }
  .shift-header { font-weight: 600; margin: 16px 0 4px; padding: 5px 10px;
    background: #1F3864; color: #f8fafc; border-radius: 5px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th { background: #f1f5f9; text-align: left; padding: 5px 8px;
    font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #475569; }
  td { padding: 5px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
  tr.even td { background: #fff; }
  tr.odd td { background: #f8fafc; }
  tr.done td { opacity: .45; text-decoration: line-through; }
  tr.recipe-header td { background: #EDF4FF; color: #1F3864; font-weight: 600;
    font-size: 11px; padding: 6px 8px; border-top: 1px solid #BDD5FF; }
  .mono { font-family: monospace; color: #475569; }
  .cb { width: 28px; text-align: center; }
  .wo { width: 100px; }
  .status { width: 160px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px;
    font-size: 10px; font-weight: 700; }
  .footer-note { margin-top: 24px; padding: 10px 14px; background: #fef9c3;
    border: 1px solid #fde047; border-radius: 6px; font-weight: 700;
    font-size: 13px; color: #713f12; }
  @media print { body { margin: 8mm; } }
</style>
</head><body>
<h1>Stagientag: ${fmtDateLong(group.stagDate)}</h1>
<div class="sub">Kochtag: ${fmtDateLong(group.cookDate)} · ${group.totalRows} offene WOs · Staged ausgeblendet</div>
${shiftsHtml}
<div class="footer-note">&#9888; Wenn alle abgearbeitet &mdash; bitte melden, um den Fortschritt zu dokumentieren!</div>
</body></html>`;
}

// ── GDrive Upload ─────────────────────────────────────────────────────────────

async function saveToDrive(
  group: DateGroup,
  fileName: string,
  checkedWos: Set<string>,
): Promise<{ ok: boolean; msg: string }> {
  const html = generatePrintHtml(group, checkedWos);
  const res = await fetch("/api/local-db/ket-druckplan-save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stagingDay: group.stagDate,
      cookDay:    group.cookDate,
      html,
      fileName,
    }),
  });
  const data = await res.json() as { ok: boolean; folder?: string; error?: string; stub?: boolean };
  if (!data.ok) throw new Error(data.error ?? "Unbekannter Fehler");
  const stub = data.stub ? " (lokaler Stub)" : "";
  return { ok: true, msg: `Gespeichert in „${data.folder}"${stub}` };
}

// ── Styles (wie Blast Chiller) ────────────────────────────────────────────────

const S = {
  card:  { background: "#fff", borderRadius: 10, border: "0.5px solid #dde3ee", padding: 14 } as React.CSSProperties,
  btnSm: (bg: string, color = "#fff") => ({ padding: "5px 12px", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer", background: bg, color } as React.CSSProperties),
};

const STATUS_COLOR: Record<string, string> = {
  "Open":                "#e2e8f0",
  "Released":            "#bae6fd",
  "Picking":             "#c7d2fe",
  "Allocation Pending":  "#fde68a",
  "Partially Allocated": "#fde68a",
  "Partially Staged":    "#fed7aa",
};

// ── View ─────────────────────────────────────────────────────────────────────

export function KetDruckplanView() {
  const [groups, setGroups] = useState<DateGroup[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [selectedCookDay, setSelectedCookDay] = useState<string | null>(null);
  const [driveStatus, setDriveStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [driveBusy, setDriveBusy] = useState(false);
  const [allDaysProgress, setAllDaysProgress] = useState<{ done: number; total: number } | null>(null);
  const [checkedWos, setCheckedWos] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState(false);

  const toggleWo = useCallback((wo: string) => {
    setCheckedWos(prev => {
      const next = new Set(prev);
      if (next.has(wo)) next.delete(wo); else next.add(wo);
      return next;
    });
  }, []);

  const handleFile = useCallback((file: File) => {
    setParseError(null);
    setDriveStatus(null);
    setCheckedWos(new Set());
    setGroups([]);
    setFileName(null);
    setSelectedCookDay(null);

    const reader = new FileReader();
    reader.onerror = () => setParseError(`Datei konnte nicht gelesen werden: ${file.name}`);
    reader.onload = (e) => {
      try {
        let text = e.target?.result as string;
        if (!text) { setParseError("Datei ist leer."); return; }
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

        const parsed = parseCsv(text);
        if (!parsed.length) { setParseError("CSV hat keine Datenzeilen."); return; }

        const headers = Object.keys(parsed[0]);
        console.log("[KET Druckplan] Spalten:", headers);

        const dateCol   = headers.find(h => h.trim() === "Date Needed");
        const statusCol = headers.find(h => h.trim() === "Staging Status");

        if (!dateCol || !statusCol) {
          setParseError(
            `Spalten nicht gefunden. Erwartet: "Date Needed", "Staging Status". ` +
            `Gefunden: ${headers.slice(0, 8).join(", ")}`,
          );
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

        if (!rows.length) {
          setParseError(`Alle ${parsed.length} Work Orders sind bereits gestaged — nichts offen.`);
          return;
        }

        const newGroups = buildGroups(rows);
        if (!newGroups.length) {
          setParseError("Keine gültigen Datumsangaben gefunden. Erwartet: YYYY-MM-DD oder YYYY-MM-DD - Shift.");
          return;
        }

        setGroups(newGroups);
        setFileName(file.name);
        setSelectedCookDay(newGroups[0]?.cookDate ?? null);
      } catch (err) {
        console.error("[KET Druckplan] Fehler:", err);
        setParseError(`Fehler: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file, "utf-8");
  }, []);

  // Auto-GDrive-Upload aller Tage sobald CSV geladen
  useEffect(() => {
    if (!groups.length) return;
    let cancelled = false;
    const errors: string[] = [];
    setAllDaysProgress({ done: 0, total: groups.length });
    setDriveStatus(null);
    (async () => {
      for (let i = 0; i < groups.length; i++) {
        if (cancelled) break;
        const g = groups[i];
        try {
          const [y, m, d] = g.cookDate.split("-");
          await saveToDrive(g, `KET-Druckplan-Kochtag-${d}.${m}.${y}.html`, new Set());
        } catch {
          errors.push(fmtDateLong(g.cookDate));
        }
        if (!cancelled) setAllDaysProgress({ done: i + 1, total: groups.length });
      }
      if (!cancelled) {
        setAllDaysProgress(null);
        setDriveStatus(
          errors.length
            ? { ok: false, msg: `GDrive: Fehler bei ${errors.join(", ")}` }
            : { ok: true, msg: `GDrive: alle ${groups.length} Tage gespeichert.` },
        );
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const selectedGroup = useMemo(
    () => groups.find(g => g.cookDate === selectedCookDay) ?? null,
    [groups, selectedCookDay],
  );

  const handleDriveSave = useCallback(async () => {
    if (!selectedGroup) return;
    setDriveBusy(true);
    setDriveStatus(null);
    try {
      const [y, m, d] = selectedGroup.cookDate.split("-");
      const result = await saveToDrive(selectedGroup, `KET-Druckplan-Kochtag-${d}.${m}.${y}.html`, checkedWos);
      setDriveStatus(result);
    } catch (err) {
      setDriveStatus({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setDriveBusy(false);
    }
  }, [selectedGroup, checkedWos]);

  const handleAllDaysDriveSave = useCallback(async () => {
    if (!groups.length) return;
    setDriveBusy(true);
    setDriveStatus(null);
    setAllDaysProgress({ done: 0, total: groups.length });
    const errors: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      try {
        const [y, m, d] = g.cookDate.split("-");
        await saveToDrive(g, `KET-Druckplan-Kochtag-${d}.${m}.${y}.html`, new Set());
      } catch {
        errors.push(fmtDateLong(g.cookDate));
      }
      setAllDaysProgress({ done: i + 1, total: groups.length });
    }
    setDriveBusy(false);
    setAllDaysProgress(null);
    setDriveStatus(
      errors.length
        ? { ok: false, msg: `Fehler bei: ${errors.join(", ")}` }
        : { ok: true, msg: `Alle ${groups.length} Tage in GDrive gespeichert.` },
    );
  }, [groups]);

  const weekLabel = useMemo(() => {
    if (!fileName) return "";
    const m = fileName.match(/[Ww](\d{2,})/);
    return m ? `KW ${m[1]}` : "";
  }, [fileName]);

  return (
    <div style={{ fontFamily: "Arial, sans-serif", fontSize: 13, color: "#222" }}>

      {/* Header */}
      <div style={{ background: "#1F3864", color: "#fff", padding: "13px 20px", display: "flex", alignItems: "center", gap: 11, borderRadius: "10px 10px 0 0" }}>
        <div style={{ width: 32, height: 32, background: "rgba(255,255,255,.15)", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>📋</div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            KET Druckplan
            {weekLabel && (
              <span style={{ background: "rgba(255,255,255,.18)", borderRadius: 4, padding: "1px 7px", fontSize: 10, marginLeft: 8 }}>{weekLabel}</span>
            )}
          </div>
          <div style={{ fontSize: 11, opacity: .7, marginTop: 1 }}>KET-CSV hochladen → Druckzettel je Stagientag, geordnet nach Shift &amp; Rezept</div>
        </div>
      </div>

      <div style={{ padding: "14px 4px" }}>

        {/* CSV Upload Card */}
        <div style={{ ...S.card, marginBottom: 12 }} className="print:hidden">
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1F3864", marginBottom: 9 }}>📊 KET Plan CSV hochladen</div>
          <div
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            style={{
              border: `2px ${groups.length ? "solid" : "dashed"} ${groups.length ? "#4CAF50" : drag ? "#1F3864" : "#BDD5FF"}`,
              borderRadius: 9, padding: "20px 14px", textAlign: "center", cursor: "pointer",
              position: "relative", background: groups.length ? "#E8F5E9" : drag ? "#EDF4FF" : "#F7FAFF",
            }}
          >
            <input
              type="file"
              accept=".csv,.CSV,text/csv,text/plain,application/vnd.ms-excel"
              style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
            />
            <div style={{ fontSize: 22, marginBottom: 4 }}>{groups.length ? "✅" : "📋"}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: groups.length ? "#2E7D32" : "#1F3864" }}>
              {groups.length
                ? `${groups.reduce((n, g) => n + g.totalRows, 0)} offene WOs · ${groups.length} Kochtag${groups.length !== 1 ? "e" : ""} — ${fileName}`
                : "KET Plan CSV hier ablegen oder klicken"}
            </div>
            <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
              Spalten: Work Order Number · Sub Recipe Name · Date Needed · Recipe Name · Staging Status
            </div>
          </div>

          {/* Vorschau der Kochtage */}
          {groups.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
              {groups.map(g => (
                <div key={g.cookDate} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderRadius: 6, fontSize: 11,
                  background: g.cookDate === selectedCookDay ? "#EDF4FF" : "#f7f9fc",
                  border: `1px solid ${g.cookDate === selectedCookDay ? "#BDD5FF" : "#eef1f6"}`,
                  cursor: "pointer" }}
                  onClick={() => { setSelectedCookDay(g.cookDate); setCheckedWos(new Set()); setDriveStatus(null); }}
                >
                  <span style={{ fontWeight: 700, color: "#1F3864", minWidth: 200 }}>
                    📅 Kochtag: {fmtDateShort(g.cookDate)}
                  </span>
                  <span style={{ color: "#666" }}>Stagientag: {fmtDateShort(g.stagDate)}</span>
                  <span style={{ marginLeft: "auto", color: "#888", fontSize: 10 }}>{g.totalRows} WOs · {g.shifts.length} Shift{g.shifts.length !== 1 ? "s" : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Fehlermeldung */}
        {parseError && (
          <div style={{ ...S.card, marginBottom: 12, background: "#FFF5F5", border: "1px solid #FCA5A5", color: "#991B1B", fontSize: 12 }} className="print:hidden">
            ✗ {parseError}
          </div>
        )}

        {/* GDrive-Fortschritt */}
        {allDaysProgress && (
          <div style={{ ...S.card, marginBottom: 12, background: "#EDF4FF", border: "1px solid #BDD5FF", color: "#1F3864", fontSize: 12, display: "flex", alignItems: "center", gap: 10 }} className="print:hidden">
            <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span>
            <span>GDrive Upload: {allDaysProgress.done} / {allDaysProgress.total} Tage …</span>
            <div style={{ flex: 1, background: "#BDD5FF", borderRadius: 99, height: 5 }}>
              <div style={{ background: "#1F3864", height: 5, borderRadius: 99, transition: "width .3s", width: `${Math.round((allDaysProgress.done / allDaysProgress.total) * 100)}%` }} />
            </div>
          </div>
        )}

        {/* GDrive Feedback */}
        {driveStatus && (
          <div style={{ ...S.card, marginBottom: 12, fontSize: 12,
            background: driveStatus.ok ? "#E8F5E9" : "#FFF5F5",
            border: `1px solid ${driveStatus.ok ? "#A5D6A7" : "#FCA5A5"}`,
            color: driveStatus.ok ? "#1B5E20" : "#991B1B" }} className="print:hidden">
            {driveStatus.ok ? "✓" : "✗"} {driveStatus.msg}
          </div>
        )}

        {/* Aktions-Leiste — nur wenn CSV geladen */}
        {selectedGroup && (
          <div style={{ ...S.card, marginBottom: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} className="print:hidden">
            <span style={{ fontSize: 11, fontWeight: 700, color: "#1F3864" }}>Aktionen:</span>
            <button style={S.btnSm("#1F3864")} disabled={driveBusy || !!allDaysProgress} onClick={handleAllDaysDriveSave}>
              {allDaysProgress ? "⟳" : "☁"} Alle {groups.length} Tage → GDrive
            </button>
            <button style={S.btnSm("#2E7D32")} disabled={driveBusy} onClick={handleDriveSave}>
              {driveBusy ? "⟳" : "☁"} Dieser Tag → GDrive
            </button>
            <button
              style={S.btnSm("#37474F")}
              disabled={driveBusy}
              onClick={async () => {
                if (!driveBusy) { try { await handleDriveSave(); } catch { /* drucken trotzdem */ } }
                window.print();
              }}
            >
              🖨 Drucken + GDrive
            </button>
          </div>
        )}

        {/* Druckinhalt */}
        {selectedGroup && (
          <div>
            {/* Datums-Header */}
            <div style={{ ...S.card, marginBottom: 12, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8, borderLeft: "4px solid #1F3864" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: ".05em" }}>Stagientag</span>
              <span style={{ fontSize: 20, fontWeight: 700, color: "#64748b" }}>{fmtDateLong(selectedGroup.stagDate)}</span>
              <span style={{ color: "#ccc", fontSize: 22 }}>→</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: ".05em" }}>Kochtag</span>
              <span style={{ fontSize: 20, fontWeight: 700, color: "#1F3864" }}>{fmtDateLong(selectedGroup.cookDate)}</span>
              <span style={{ fontSize: 11, color: "#aaa", marginLeft: 4 }}>{selectedGroup.totalRows} offene WOs</span>
            </div>

            {/* Abschluss-Hinweis */}
            <div style={{ marginBottom: 12, padding: "10px 14px", background: "#FEF9C3", border: "1px solid #FDE047", borderRadius: 8, fontWeight: 700, fontSize: 13, color: "#713f12" }}>
              ⚠ Wenn alle abgearbeitet — bitte melden, um den Fortschritt zu dokumentieren!
            </div>

            {/* Shifts */}
            {selectedGroup.shifts.map(({ shift, recipeGroups, totalRows }) => (
              <div key={shift} style={{ ...S.card, marginBottom: 16 }}>
                {/* Shift-Header */}
                <div style={{ background: "#1F3864", color: "#fff", padding: "7px 12px", borderRadius: 7, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>Shift {shift}</span>
                  <span style={{ color: "rgba(255,255,255,.5)" }}>—</span>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,.75)" }}>{totalRows} Work Order{totalRows !== 1 ? "s" : ""}</span>
                </div>

                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "#f1f5f9" }}>
                      <th style={{ padding: "5px 8px", width: 32, textAlign: "center" }}></th>
                      <th style={{ padding: "5px 10px", textAlign: "left", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "#64748b", width: 110 }}>Work Order</th>
                      <th style={{ padding: "5px 10px", textAlign: "left", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "#64748b" }}>Sub Meal</th>
                      <th style={{ padding: "5px 10px", textAlign: "left", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "#64748b", width: 160 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipeGroups.map(({ recipeName, rows }) => (
                      <Fragment key={recipeName}>
                        {/* Kommentarzeile / Rezept-Trenner */}
                        <tr style={{ background: "#EDF4FF", borderTop: "1px solid #BDD5FF" }}>
                          <td colSpan={4} style={{ padding: "6px 10px", fontSize: 11, fontWeight: 700, color: "#1F3864" }}>
                            📋 {recipeName}
                          </td>
                        </tr>
                        {rows.map((row, i) => {
                          const done = checkedWos.has(row.workOrder);
                          return (
                            <tr
                              key={row.workOrder}
                              style={{
                                background: done ? "#f8fafc" : i % 2 === 0 ? "#fff" : "#f8fafc",
                                opacity: done ? .45 : 1,
                                cursor: "pointer",
                                borderBottom: "1px solid #f1f5f9",
                              }}
                              onClick={() => toggleWo(row.workOrder)}
                            >
                              <td style={{ padding: "5px 8px", textAlign: "center" }}>
                                <input
                                  type="checkbox"
                                  checked={done}
                                  onChange={() => toggleWo(row.workOrder)}
                                  onClick={e => e.stopPropagation()}
                                  style={{ width: 14, height: 14, cursor: "pointer" }}
                                />
                              </td>
                              <td style={{ padding: "5px 10px", fontFamily: "monospace", fontSize: 11, color: "#64748b", textDecoration: done ? "line-through" : "none" }}>{row.workOrder}</td>
                              <td style={{ padding: "5px 10px", color: "#1e293b", textDecoration: done ? "line-through" : "none" }}>{row.subRecipeName}</td>
                              <td style={{ padding: "5px 10px" }}>
                                <span style={{
                                  display: "inline-block", padding: "2px 7px", borderRadius: 4,
                                  fontSize: 10, fontWeight: 700,
                                  background: STATUS_COLOR[row.stagingStatus] ?? "#e2e8f0",
                                  color: "#334155",
                                }}>
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
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
