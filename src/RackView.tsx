import { useEffect, useMemo, useState } from "react";
import type { UiLocale } from "./i18n";
import {
  RACK_MARKET_PROFILES,
  deriveEntryKind,
  exportRackfileCsv,
  lineSlotRange,
  parseBoxfileCsv,
  parseCo2Csv,
  parseMultilineExcel,
  parsePdlCsv,
  parseRackfileCsv,
  projectRackEntriesToLines,
  rackSummary,
  type RackBoxSnapshot,
  type RackEntry,
  type RackMarket,
  type RackValidationResult,
  uniqueRackLines,
  updateRackEntry,
  validateRackPlan,
} from "./rack";

type Props = {
  week: string;
  locale: UiLocale;
};

type LineScenario = {
  id: string;
  label: string;
  lines: string[];
  note: string;
};

function scenarioOptions(market: RackMarket, locale: UiLocale): LineScenario[] {
  if (market === "de") {
    return [
      {
        id: "dual",
        label: locale === "de" ? "Dual: ASL3 + ASL4" : "Dual: ASL3 + ASL4",
        lines: ["ASL3", "ASL4"],
        note: locale === "de" ? "Standardbetrieb mit beiden Linien vorbereitet." : "Prepared dual-line operation.",
      },
      {
        id: "primary-4",
        label: locale === "de" ? "Primär: nur ASL4" : "Primary: ASL4 only",
        lines: ["ASL4"],
        note: locale === "de" ? "DE läuft komplett auf ASL4." : "Run DE fully on ASL4.",
      },
      {
        id: "backup-3",
        label: locale === "de" ? "Backup: nur ASL3" : "Backup: ASL3 only",
        lines: ["ASL3"],
        note: locale === "de" ? "Schneller Fallback wenn ASL4 ausfällt." : "Fast fallback if ASL4 fails.",
      },
    ];
  }

  return [
    {
      id: "dual",
      label: locale === "de" ? "Dual: ASL1 + ASL5" : "Dual: ASL1 + ASL5",
      lines: ["ASL1", "ASL5"],
      note: locale === "de" ? "Standardbetrieb mit beiden Nordics-Linien." : "Prepared dual-line operation.",
    },
    {
      id: "primary-5",
      label: locale === "de" ? "Primär: nur ASL5" : "Primary: ASL5 only",
      lines: ["ASL5"],
      note: locale === "de" ? "Nordics läuft komplett auf ASL5." : "Run Nordics fully on ASL5.",
    },
    {
      id: "backup-1",
      label: locale === "de" ? "Backup: nur ASL1" : "Backup: ASL1 only",
      lines: ["ASL1"],
      note: locale === "de" ? "Schneller Fallback wenn ASL5 ausfällt." : "Fast fallback if ASL5 fails.",
    },
  ];
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function issueTone(severity: RackValidationResult["issues"][number]["severity"]) {
  if (severity === "error") return "bg-rose-50 text-rose-800 ring-rose-200";
  if (severity === "warning") return "bg-amber-50 text-amber-900 ring-amber-200";
  return "bg-sky-50 text-sky-800 ring-sky-200";
}

function kindTone(kind: ReturnType<typeof deriveEntryKind>) {
  switch (kind) {
    case "meal": return "bg-emerald-100 text-emerald-900 border-emerald-300";
    case "packaging": return "bg-slate-100 text-slate-900 border-slate-300";
    case "ice": return "bg-cyan-100 text-cyan-900 border-cyan-300";
    case "loyalty": return "bg-amber-100 text-amber-900 border-amber-300";
    case "beverage": return "bg-fuchsia-100 text-fuchsia-900 border-fuchsia-300";
    case "protein": return "bg-rose-100 text-rose-900 border-rose-300";
    default: return "bg-violet-100 text-violet-900 border-violet-300";
  }
}

function lineBadge(line: string) {
  const hue = line.endsWith("1") ? "bg-sky-100 text-sky-900" : line.endsWith("3") ? "bg-emerald-100 text-emerald-900" : line.endsWith("4") ? "bg-orange-100 text-orange-900" : "bg-violet-100 text-violet-900";
  return `rounded-full px-2 py-0.5 text-xs font-semibold ${hue}`;
}

export function RackView({ week, locale }: Props) {
  const [market, setMarket] = useState<RackMarket>("de");
  const [entries, setEntries] = useState<RackEntry[]>([]);
  const [templateEntries, setTemplateEntries] = useState<RackEntry[]>([]);
  const [pdlIds, setPdlIds] = useState<Set<string> | undefined>();
  const [boxfile, setBoxfile] = useState<RackBoxSnapshot | undefined>();
  const [co2MealIds, setCo2MealIds] = useState<Set<string> | undefined>();
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [status, setStatus] = useState<string>(locale === "de" ? "Noch keine Rackdaten geladen." : "No rack data loaded yet.");
  const [busy, setBusy] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [activeLines, setActiveLines] = useState<string[]>(RACK_MARKET_PROFILES.de.lines);

  const profile = RACK_MARKET_PROFILES[market];
  const scenarios = useMemo(() => scenarioOptions(market, locale), [market, locale]);

  useEffect(() => {
    setActiveLines(profile.lines);
    setEntries([]);
    setTemplateEntries([]);
    setPdlIds(undefined);
    setBoxfile(undefined);
    setCo2MealIds(undefined);
    setSourceLabel("");
    setStatus(locale === "de" ? "Markt gewechselt. Bitte Rackdaten neu laden oder Szenario anwenden." : "Market changed. Reload rack data or apply a scenario.");
  }, [market]);

  const validation = useMemo(
    () => validateRackPlan(entries, { pdlIds, boxfile, co2MealIds }),
    [entries, pdlIds, boxfile, co2MealIds],
  );
  const summary = useMemo(() => rackSummary(entries), [entries]);
  const usedLines = useMemo(() => uniqueRackLines(entries), [entries]);

  const filteredEntries = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      [entry.recipe, entry.line, entry.flowRackPosition, entry.sku, entry.ingredient, entry.displayName]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [entries, filterText]);

  const entriesByLineAndSlot = useMemo(() => {
    const bucket = new Map<string, RackEntry[]>();
    for (const entry of entries) {
      const key = `${entry.line}:${entry.flowRackPosition}`;
      const rows = bucket.get(key) ?? [];
      rows.push(entry);
      bucket.set(key, rows);
    }
    return bucket;
  }, [entries]);

  async function handleMultilineUpload(file: File) {
    setBusy(locale === "de" ? "MultiLine wird geladen …" : "Loading MultiLine …");
    try {
      const nextEntries = await parseMultilineExcel(file, market, activeLines);
      setEntries(nextEntries);
      setTemplateEntries(nextEntries);
      setSourceLabel(file.name);
      setStatus(locale === "de" ? `MultiLine importiert: ${file.name}` : `MultiLine imported: ${file.name}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleRackfileUpload(file: File) {
    setBusy(locale === "de" ? "Rackfile wird geladen …" : "Loading rackfile …");
    try {
      const nextEntries = await parseRackfileCsv(file);
      setEntries(nextEntries);
      setTemplateEntries(nextEntries);
      setActiveLines(uniqueRackLines(nextEntries));
      setSourceLabel(file.name);
      setStatus(locale === "de" ? `Rackfile importiert: ${file.name}` : `Rackfile imported: ${file.name}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function handlePdlUpload(file: File) {
    setBusy(locale === "de" ? "PDL wird geprüft …" : "Loading PDL …");
    try {
      setPdlIds(await parsePdlCsv(file));
      setStatus(locale === "de" ? `PDL geladen: ${file.name}` : `PDL loaded: ${file.name}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleBoxfileUpload(file: File) {
    setBusy(locale === "de" ? "Boxfile wird geprüft …" : "Loading boxfile …");
    try {
      setBoxfile(await parseBoxfileCsv(file));
      setStatus(locale === "de" ? `Boxfile geladen: ${file.name}` : `Boxfile loaded: ${file.name}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleCo2Upload(file: File) {
    setBusy(locale === "de" ? "CO2 wird geprüft …" : "Loading CO2 …");
    try {
      setCo2MealIds(await parseCo2Csv(file, profile.boxPrefix));
      setStatus(locale === "de" ? `CO2 geladen: ${file.name}` : `CO2 loaded: ${file.name}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(null);
    }
  }

  function applyScenario(lines: string[]) {
    const source = templateEntries.length > 0 ? templateEntries : entries;
    if (source.length === 0) {
      setStatus(locale === "de" ? "Zuerst MultiLine oder Rackfile laden, dann kann ein Szenario aufgebaut werden." : "Load MultiLine or rackfile first before applying a scenario.");
      return;
    }
    const nextEntries = projectRackEntriesToLines(source, lines);
    setActiveLines(lines);
    setEntries(nextEntries);
    setStatus(locale === "de" ? `Szenario aktiv: ${lines.join(", ")}` : `Scenario active: ${lines.join(", ")}`);
  }

  function handleActiveLineChange(line: string, enabled: boolean) {
    const next = enabled
      ? [...new Set([...activeLines, line])].sort((a, b) => a.localeCompare(b))
      : activeLines.filter((candidate) => candidate !== line);
    if (next.length === 0) return;
    setActiveLines(next);
  }

  function rebuildForSelectedLines() {
    applyScenario(activeLines);
  }

  return (
    <div className="space-y-4">
      <section className="card overflow-hidden">
        <div className="border-b border-slate-200 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.18),_transparent_28%),linear-gradient(135deg,_#0f172a,_#1e293b_45%,_#334155)] p-5 text-white">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-200">{locale === "de" ? "Rack Orchestrator" : "Rack orchestrator"}</div>
              <h2 className="text-2xl font-bold tracking-tight">{locale === "de" ? "Rack-Planung, Visualisierung und Validierung" : "Rack planning, visualization and validation"}</h2>
              <p className="max-w-3xl text-sm text-slate-200">
                {locale === "de"
                  ? "Lade MultiLine, Rackfile, PDL, Boxfile und CO2 lokal hoch. Die Ansicht zeigt die komplette Linienbelegung visuell, erlaubt manuelle Slot-Anpassungen und exportiert am Ende wieder eine saubere Rackfile CSV."
                  : "Upload MultiLine, rackfile, PDL, boxfile and CO2 locally. The view shows the full line allocation, supports manual slot edits and exports a clean rackfile CSV."}
              </p>
            </div>
            <div className="min-w-[220px] rounded-2xl bg-white/10 p-3 ring-1 ring-white/15 backdrop-blur">
              <div className="text-[11px] uppercase tracking-wide text-sky-200">{locale === "de" ? "Woche / Markt" : "Week / market"}</div>
              <div className="mt-1 text-lg font-semibold">{week}</div>
              <div className="mt-3 flex gap-2">
                {(["de", "nordics"] as RackMarket[]).map((candidate) => (
                  <button
                    key={candidate}
                    onClick={() => setMarket(candidate)}
                    className={`rounded-xl px-3 py-2 text-sm font-semibold ${market === candidate ? "bg-white text-slate-950" : "bg-white/10 text-white ring-1 ring-white/15"}`}
                  >
                    {candidate === "de" ? "DE" : "Nordics"}
                  </button>
                ))}
              </div>
              <div className="mt-3 rounded-xl bg-white/10 p-2 ring-1 ring-white/10">
                <div className="text-[11px] uppercase tracking-wide text-sky-200">{locale === "de" ? "Aktive Linien" : "Active lines"}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {profile.lines.map((line) => (
                    <label key={line} className={`inline-flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs font-semibold ring-1 ${activeLines.includes(line) ? "bg-white text-slate-950 ring-white" : "bg-white/10 text-white ring-white/15"}`}>
                      <input
                        type="checkbox"
                        checked={activeLines.includes(line)}
                        onChange={(event) => handleActiveLineChange(line, event.target.checked)}
                      />
                      {line}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-4 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Linien-Szenarien" : "Line scenarios"}</div>
                  <div className="mt-1 text-sm text-slate-700">{locale === "de" ? "Plane Primär- und Backup-Linien vor. Ein Klick baut die Rackfile sofort für die Ersatzlinie neu auf." : "Pre-plan primary and backup lines. One click rebuilds the rackfile for the backup line."}</div>
                </div>
                <button className="btn" onClick={rebuildForSelectedLines} disabled={activeLines.length === 0 || (entries.length === 0 && templateEntries.length === 0)}>
                  {locale === "de" ? "Mit aktiven Linien neu aufbauen" : "Rebuild with active lines"}
                </button>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-3">
                {scenarios.map((scenario) => (
                  <button
                    key={scenario.id}
                    className={`rounded-2xl border p-3 text-left transition ${activeLines.join("|") === scenario.lines.join("|") ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white hover:border-slate-300"}`}
                    onClick={() => applyScenario(scenario.lines)}
                  >
                    <div className="font-semibold">{scenario.label}</div>
                    <div className={`mt-1 text-sm ${activeLines.join("|") === scenario.lines.join("|") ? "text-slate-300" : "text-slate-500"}`}>{scenario.note}</div>
                    <div className="mt-3 flex flex-wrap gap-1">
                      {scenario.lines.map((line) => <span key={line} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${activeLines.join("|") === scenario.lines.join("|") ? "bg-white/15 text-white" : lineBadge(line)}`}>{line}</span>)}
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Aktuell geplant auf" : "Currently planned on"}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {usedLines.length > 0 ? usedLines.map((line) => <span key={line} className={lineBadge(line)}>{line}</span>) : <span className="text-sm text-slate-500">{locale === "de" ? "noch keine Daten" : "no data yet"}</span>}
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <UploadCard label="MultiLine XLSX" hint={profile.sheet} onPick={handleMultilineUpload} accept=".xlsx" />
            <UploadCard label="Rackfile CSV" hint={locale === "de" ? "existierende Rackfile laden" : "load existing rackfile"} onPick={handleRackfileUpload} accept=".csv" />
            <UploadCard label="PDL CSV" hint={locale === "de" ? "Meal-Soll prüfen" : "check meal target"} onPick={handlePdlUpload} accept=".csv" />
            <UploadCard label="Boxfile CSV" hint={locale === "de" ? "ETL BOXFILE_VE" : "ETL BOXFILE_VE"} onPick={handleBoxfileUpload} accept=".csv" />
            <UploadCard label="CO2 CSV" hint={locale === "de" ? `ETL CO_2 (${profile.boxPrefix})` : `ETL CO_2 (${profile.boxPrefix})`} onPick={handleCo2Upload} accept=".csv" />
          </div>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Status" : "Status"}</div>
                <div className="mt-1 text-sm font-medium text-slate-800">{busy ?? status}</div>
                {sourceLabel && <div className="mt-1 text-xs text-slate-500">{locale === "de" ? "Quelle" : "Source"}: {sourceLabel}</div>}
              </div>
              <button
                className="btn btn-primary"
                disabled={entries.length === 0}
                onClick={() => downloadText(market === "de" ? `Rackfile_[${week}]_[F-DE]_[${usedLines.join("_") || activeLines.join("_")}].csv` : `Rackfile_KW${week.split("W").at(-1)}_[Fact-Nordics]_[ASL${(usedLines.length > 0 ? usedLines : activeLines).map((line) => line.replace("ASL", "")).join(",")}].csv`, exportRackfileCsv(entries))}
              >
                {locale === "de" ? "Rackfile exportieren" : "Export rackfile"}
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 xl:grid-cols-7">
              <MiniStat label="Meals" value={summary.meal} />
              <MiniStat label="Packaging" value={summary.packaging} />
              <MiniStat label="Ice" value={summary.ice} />
              <MiniStat label="Loyalty" value={summary.loyalty} />
              <MiniStat label="Beverage" value={summary.beverage} />
              <MiniStat label="Protein" value={summary.protein} />
              <MiniStat label={locale === "de" ? "Validierung" : "Validation"} value={validation.ok ? "OK" : validation.issues.filter((issue) => issue.severity === "error").length} accent={!validation.ok} />
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.78fr_1.22fr]">
        <div className="space-y-4">
          <div className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold uppercase tracking-wide text-slate-600">{locale === "de" ? "Validierungsreport" : "Validation report"}</h3>
              <span className={`rounded-full px-2 py-1 text-xs font-semibold ${validation.ok ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>{validation.ok ? "OK" : `${validation.issues.filter((issue) => issue.severity === "error").length} Errors`}</span>
            </div>
            <div className="mt-3 max-h-[34rem] space-y-2 overflow-auto pr-1">
              {validation.issues.length === 0 && (
                <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 ring-1 ring-emerald-200">{locale === "de" ? "Noch keine Abweichungen. Sobald Daten geladen sind, erscheinen hier alle Checks." : "No deviations yet. Checks appear here once data is loaded."}</div>
              )}
              {validation.issues.map((issue, index) => (
                <div key={`${issue.severity}-${index}`} className={`rounded-xl p-3 text-sm ring-1 ${issueTone(issue.severity)}`}>
                  <div className="font-semibold uppercase tracking-wide">{issue.severity}</div>
                  <div className="mt-1">{issue.message}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold uppercase tracking-wide text-slate-600">{locale === "de" ? "Manuelle Planung" : "Manual planning"}</h3>
              <input
                value={filterText}
                onChange={(event) => setFilterText(event.target.value)}
                placeholder={locale === "de" ? "Recipe, Linie, Slot …" : "Recipe, line, slot …"}
                className="w-52 rounded-lg border-slate-300 px-3 py-2 text-sm ring-1 ring-slate-300"
              />
            </div>
            <div className="mt-3 max-h-[42rem] overflow-auto rounded-xl ring-1 ring-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Recipe</th>
                    <th className="px-3 py-2">Line</th>
                    <th className="px-3 py-2">Slot</th>
                    <th className="px-3 py-2">Qty</th>
                    <th className="px-3 py-2">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {filteredEntries.map((entry) => {
                    const kind = deriveEntryKind(entry);
                    return (
                      <tr key={entry.id}>
                        <td className="px-3 py-2 align-top">
                          <div className="font-semibold text-slate-900">{entry.recipe}</div>
                          <div className="text-xs text-slate-500">{entry.displayName || entry.ingredient}</div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <select
                            className="w-full rounded-lg border-slate-300 px-2 py-1.5 ring-1 ring-slate-300"
                            value={entry.line}
                            onChange={(event) => setEntries((current) => updateRackEntry(current, entry.id, { line: event.target.value }))}
                          >
                            {[...new Set([...profile.lines, ...usedLines, ...activeLines])].sort((a, b) => a.localeCompare(b)).map((line) => <option key={line} value={line}>{line}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <input
                            value={entry.flowRackPosition}
                            onChange={(event) => setEntries((current) => updateRackEntry(current, entry.id, { flowRackPosition: event.target.value.toUpperCase() }))}
                            className="w-24 rounded-lg border-slate-300 px-2 py-1.5 ring-1 ring-slate-300"
                          />
                        </td>
                        <td className="px-3 py-2 align-top">
                          <input
                            type="number"
                            min={0}
                            value={entry.quantity}
                            onChange={(event) => setEntries((current) => updateRackEntry(current, entry.id, { quantity: Number(event.target.value) || 0 }))}
                            className="w-20 rounded-lg border-slate-300 px-2 py-1.5 ring-1 ring-slate-300"
                          />
                        </td>
                        <td className="px-3 py-2 align-top">
                          <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${kindTone(kind)}`}>{kind}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wide text-slate-600">{locale === "de" ? "Linienbild" : "Line map"}</h3>
              <p className="mt-1 text-sm text-slate-500">{locale === "de" ? "Jeder Rackplatz wird als Slot dargestellt. Leere Plätze bleiben sichtbar, damit die Verteilung in der Linie sofort auffällt." : "Each rack position is rendered as a slot. Empty positions remain visible so distribution issues stand out immediately."}</p>
            </div>
          </div>

          <div className="mt-4 space-y-6">
            {(usedLines.length > 0 ? usedLines : activeLines).map((line) => {
              const slots = lineSlotRange(entries, line);
              return (
                <div key={line} className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className={lineBadge(line)}>{line}</span>
                      <span className="text-sm text-slate-500">{locale === "de" ? `${entries.filter((entry) => entry.line === line).length} Items geplant` : `${entries.filter((entry) => entry.line === line).length} planned items`}</span>
                    </div>
                    <div className="text-xs text-slate-400">{slots.length > 0 ? `F${String(slots[0]).padStart(2, "0")} – F${String(slots[slots.length - 1]).padStart(2, "0")}` : (locale === "de" ? "keine Slots" : "no slots")}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
                    {slots.map((slotNumber) => {
                      const position = `F${String(slotNumber).padStart(2, "0")}`;
                      const slotEntries = entriesByLineAndSlot.get(`${line}:${position}`) ?? [];
                      const occupied = slotEntries.length > 0;
                      return (
                        <div key={`${line}-${position}`} className={`min-h-[120px] rounded-2xl border p-3 ${occupied ? "border-slate-300 bg-white shadow-sm" : "border-dashed border-slate-200 bg-slate-50"}`}>
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-mono text-xs font-semibold text-slate-500">{position}</div>
                            <div className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${occupied ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-500"}`}>{slotEntries.length}</div>
                          </div>
                          <div className="mt-3 space-y-2">
                            {slotEntries.map((entry) => {
                              const kind = deriveEntryKind(entry);
                              return (
                                <div key={entry.id} className={`rounded-xl border px-2 py-2 text-xs ${kindTone(kind)}`}>
                                  <div className="font-semibold">{entry.recipe}</div>
                                  <div className="mt-1 line-clamp-2 text-[11px] opacity-80">{entry.displayName || entry.ingredient || entry.sku}</div>
                                  <div className="mt-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide opacity-70">
                                    <span>{kind}</span>
                                    <span>Qty {entry.quantity}</span>
                                  </div>
                                </div>
                              );
                            })}
                            {!occupied && <div className="rounded-xl border border-dashed border-slate-200 px-2 py-6 text-center text-xs text-slate-400">leer</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function UploadCard({ label, hint, accept, onPick }: { label: string; hint: string; accept: string; onPick: (file: File) => Promise<void> }) {
  return (
    <label className="group cursor-pointer rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-sm">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-sm text-slate-700">{hint}</div>
      <div className="mt-4 inline-flex rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white">Datei wählen</div>
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void onPick(file);
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

function MiniStat({ label, value, accent = false }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className={`rounded-xl px-3 py-2 ring-1 ${accent ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-900 ring-slate-200"}`}>
      <div className={`text-[11px] uppercase tracking-wide ${accent ? "text-slate-300" : "text-slate-500"}`}>{label}</div>
      <div className="mt-1 text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}