import { Fragment, useState, useCallback, useMemo } from "react";

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
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})\s*-\s*(\d+)$/);
  if (!m) return { date: raw, shift: 1 };
  return { date: m[1], shift: parseInt(m[2], 10) };
}

function stagingDay(cookDate: string): string {
  const d = new Date(cookDate + "T12:00:00");
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function fmtDateLong(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString("de-DE", {
    weekday: "long", day: "2-digit", month: "2-digit", year: "numeric",
  });
}

function fmtDateShort(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString("de-DE", {
    weekday: "short", day: "2-digit", month: "2-digit",
  });
}

function splitCsvLine(line: string): string[] {
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
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(l => {
    const vals = splitCsvLine(l);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ""; });
    return obj;
  });
}

// ── Status-Badge ─────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, string> = {
  "Open":                "bg-slate-100 text-slate-700",
  "Released":            "bg-sky-100 text-sky-700",
  "Picking":             "bg-indigo-100 text-indigo-700",
  "Allocation Pending":  "bg-amber-100 text-amber-700",
  "Partially Allocated": "bg-amber-100 text-amber-700",
  "Partially Staged":    "bg-orange-100 text-orange-700",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLE[status] ?? "bg-slate-100 text-slate-500";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold whitespace-nowrap ${cls}`}>
      {status}
    </span>
  );
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
  // byDate → byShift → byRecipe
  const byDate = new Map<string, Map<number, Map<string, KetRow[]>>>();
  for (const row of rows) {
    const { date, shift } = parseDateNeeded(row.dateNeeded);
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
            .map(([recipeName, rows]) => ({ recipeName, rows }));
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
    background: #334155; color: #f8fafc; border-radius: 5px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th { background: #f1f5f9; text-align: left; padding: 5px 8px;
    font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #475569; }
  td { padding: 5px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
  tr.even td { background: #fff; }
  tr.odd td { background: #f8fafc; }
  tr.done td { opacity: .45; text-decoration: line-through; }
  tr.recipe-header td { background: #f0f9ff; color: #0369a1; font-weight: 600;
    font-size: 11px; padding: 6px 8px; border-top: 1px solid #bae6fd; }
  .mono { font-family: monospace; color: #475569; }
  .cb { width: 28px; text-align: center; }
  .wo { width: 100px; }
  .status { width: 160px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px;
    font-size: 10px; font-weight: 700; }
  @media print { body { margin: 8mm; } }
</style>
</head><body>
<h1>Stagientag: ${fmtDateLong(group.stagDate)}</h1>
<div class="sub">Kochtag: ${fmtDateLong(group.cookDate)} · ${group.totalRows} offene WOs · Staged ausgeblendet</div>
${shiftsHtml}
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
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parseCsv(text);
      if (!parsed.length || !("Date Needed" in parsed[0])) {
        setParseError('Keine gültige KET-Plan CSV — erwartet wird eine Spalte „Date Needed".');
        return;
      }
      const rows: KetRow[] = parsed
        .filter(r => r["Staging Status"] !== "Staged")
        .map(r => ({
          dateNeeded:    r["Date Needed"],
          workOrder:     r["Work Order Number"],
          recipeName:    r["Recipe Name"] ?? "",
          subRecipeName: r["Sub Recipe Name"],
          stagingStatus: r["Staging Status"],
        }));
      const newGroups = buildGroups(rows);
      setGroups(newGroups);
      setFileName(file.name);
      setSelectedCookDay(newGroups[0]?.cookDate ?? null);
      // Alle Tage sofort in GDrive sichern — läuft im Hintergrund
      const errors: string[] = [];
      setDriveStatus(null);
      setAllDaysProgress({ done: 0, total: newGroups.length });
      (async () => {
        for (let i = 0; i < newGroups.length; i++) {
          const g = newGroups[i];
          try {
            const [y, m, d] = g.cookDate.split("-");
            await saveToDrive(g, `KET-Druckplan-Kochtag-${d}.${m}.${y}.html`, new Set());
          } catch {
            errors.push(fmtDateLong(g.cookDate));
          }
          setAllDaysProgress({ done: i + 1, total: newGroups.length });
        }
        setAllDaysProgress(null);
        setDriveStatus(
          errors.length
            ? { ok: false, msg: `GDrive: Fehler bei ${errors.join(", ")}` }
            : { ok: true, msg: `GDrive: alle ${newGroups.length} Tage gespeichert.` },
        );
      })();
    };
    reader.readAsText(file, "utf-8");
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
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
      const driveFileName = `KET-Druckplan-Kochtag-${d}.${m}.${y}.html`;
      const result = await saveToDrive(selectedGroup, driveFileName, checkedWos);
      setDriveStatus(result);
    } catch (err) {
      setDriveStatus({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setDriveBusy(false);
    }
  }, [selectedGroup, checkedWos]);

  // Alle Tage auf einmal in GDrive — wird nach CSV-Upload angeboten
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
      } catch (err) {
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

  return (
    <div>
      {/* Toolbar — beim Drucken ausblenden */}
      <div className="flex flex-wrap items-center gap-3 mb-6 print:hidden">
        <label
          className="cursor-pointer flex items-center gap-2 px-4 py-2 rounded-lg bg-verden-600 text-white text-sm font-medium hover:bg-verden-700 transition-colors"
          onDrop={onDrop}
          onDragOver={e => e.preventDefault()}
        >
          <span>↑</span>
          <span>KET Plan CSV hochladen</span>
          <input type="file" accept=".csv" className="hidden" onChange={onInput} />
        </label>

        {groups.length > 0 && (
          <>
            {/* Kochtag-Selektor */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-500">Kochtag:</span>
              <select
                value={selectedCookDay ?? ""}
                onChange={e => {
                  setSelectedCookDay(e.target.value);
                  setDriveStatus(null);
                  setCheckedWos(new Set());
                }}
                className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-verden-500"
              >
                {groups.map(g => (
                  <option key={g.cookDate} value={g.cookDate}>
                    {fmtDateLong(g.cookDate)} ({g.totalRows} WOs)
                  </option>
                ))}
              </select>
            </div>

            {selectedGroup && (
              <span className="text-xs text-slate-400">
                Stagientag: <strong className="text-slate-600">{fmtDateShort(selectedGroup.stagDate)}</strong>
              </span>
            )}

            <button
              onClick={handleAllDaysDriveSave}
              disabled={driveBusy || !!allDaysProgress}
              title="Alle Tage aus der CSV in GDrive aktualisieren"
              className="px-3 py-1.5 rounded-lg bg-sky-100 text-sky-700 text-xs font-medium hover:bg-sky-200 disabled:opacity-50 transition-colors flex items-center gap-1.5"
            >
              <span>{allDaysProgress ? "⟳" : "☁"}</span>
              <span>Alle {groups.length} Tage → GDrive</span>
            </button>

            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={handleDriveSave}
                disabled={driveBusy || !selectedGroup}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                <span>{driveBusy ? "⟳" : "☁"}</span>
                <span>In GDrive speichern</span>
              </button>
              <button
                onClick={async () => {
                  // Erst in GDrive speichern, dann Drucken — damit beides garantiert gesichert ist
                  if (selectedGroup && !driveBusy) {
                    try {
                      await handleDriveSave();
                    } catch {
                      // Drucken trotzdem ausführen
                    }
                  }
                  window.print();
                }}
                disabled={driveBusy}
                className="px-4 py-2 rounded-lg bg-slate-700 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                <span>🖨</span>
                <span>Drucken + GDrive</span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* GDrive Upload-Fortschritt */}
      {allDaysProgress && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-sky-50 text-sky-700 text-sm font-medium print:hidden flex items-center gap-3">
          <span className="animate-spin inline-block">⟳</span>
          <span>
            GDrive Upload: {allDaysProgress.done} / {allDaysProgress.total} Tage …
          </span>
          <div className="flex-1 bg-sky-200 rounded-full h-1.5">
            <div
              className="bg-sky-600 h-1.5 rounded-full transition-all"
              style={{ width: `${Math.round((allDaysProgress.done / allDaysProgress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* GDrive Feedback */}
      {driveStatus && (
        <div className={`mb-4 px-4 py-2 rounded-lg text-sm font-medium print:hidden ${
          driveStatus.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
        }`}>
          {driveStatus.ok ? "✓" : "✗"} {driveStatus.msg}
        </div>
      )}

      {parseError && (
        <div className="card p-4 text-rose-700 bg-rose-50 text-sm mb-4 print:hidden">{parseError}</div>
      )}

      {!fileName && !parseError && (
        <div
          className="card p-16 text-center text-slate-400 print:hidden border-2 border-dashed border-slate-200"
          onDrop={onDrop}
          onDragOver={e => e.preventDefault()}
        >
          <div className="text-5xl mb-4">📋</div>
          <div className="text-base font-semibold text-slate-600">KET Plan CSV hochladen</div>
          <div className="text-sm mt-2 max-w-sm mx-auto">
            Datei auswählen oder hierher ziehen. Staged WOs werden automatisch ausgeblendet.
          </div>
        </div>
      )}

      {/* Druckinhalt — nur der gewählte Kochtag */}
      {selectedGroup && (
        <div>
          {/* Datums-Header */}
          <div className="flex flex-wrap items-baseline gap-2 mb-5 pb-3 border-b-2 border-slate-300">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Stagientag</span>
            <span className="text-xl font-bold text-slate-500">{fmtDateLong(selectedGroup.stagDate)}</span>
            <span className="text-slate-300 text-2xl mx-1">→</span>
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Kochtag</span>
            <span className="text-xl font-bold text-slate-900">{fmtDateLong(selectedGroup.cookDate)}</span>
            <span className="ml-2 text-sm text-slate-400">
              {selectedGroup.totalRows} offene WOs · Staged ausgeblendet
            </span>
          </div>

          {/* Shifts */}
          {selectedGroup.shifts.map(({ shift, recipeGroups, totalRows }) => (
            <div key={shift} className="mb-8">
              {/* Shift-Header (dunkel) */}
              <div className="flex items-center gap-2 mb-3 px-4 py-2 bg-slate-700 text-white rounded-lg">
                <span className="font-bold text-sm">Shift {shift}</span>
                <span className="text-slate-400 text-xs">—</span>
                <span className="text-slate-300 text-xs">{totalRows} Work Order{totalRows !== 1 ? "s" : ""}</span>
              </div>

              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-slate-100 text-left">
                    <th className="px-2 py-2 w-8"></th>
                    <th className="px-3 py-2 font-semibold text-slate-600 w-28 text-xs uppercase tracking-wide">Work Order</th>
                    <th className="px-3 py-2 font-semibold text-slate-600 text-xs uppercase tracking-wide">Sub Meal</th>
                    <th className="px-3 py-2 font-semibold text-slate-600 w-48 text-xs uppercase tracking-wide">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recipeGroups.map(({ recipeName, rows }) => (
                    <Fragment key={recipeName}>
                      {/* Kommentarzeile / Rezept-Trenner */}
                      <tr className="bg-sky-50 border-t border-sky-200">
                        <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold text-sky-700">
                          📋 {recipeName}
                        </td>
                      </tr>
                      {rows.map((row, i) => {
                        const done = checkedWos.has(row.workOrder);
                        return (
                          <tr
                            key={row.workOrder}
                            className={`border-b border-slate-100 cursor-pointer select-none ${
                              done
                                ? "opacity-40 line-through bg-slate-50"
                                : i % 2 === 0 ? "bg-white hover:bg-slate-50" : "bg-slate-50 hover:bg-slate-100"
                            }`}
                            onClick={() => toggleWo(row.workOrder)}
                          >
                            <td className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={done}
                                onChange={() => toggleWo(row.workOrder)}
                                onClick={e => e.stopPropagation()}
                                className="w-4 h-4 accent-verden-600 cursor-pointer"
                              />
                            </td>
                            <td className="px-3 py-2 font-mono text-slate-600 text-xs">{row.workOrder}</td>
                            <td className="px-3 py-2 text-slate-800">{row.subRecipeName}</td>
                            <td className="px-3 py-2"><StatusBadge status={row.stagingStatus} /></td>
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
  );
}
