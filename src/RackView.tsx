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

type RackSlotMeta = {
  level: number;
  station: string;
  demand: number;
  type: string;
  preferredPick: boolean;
  highRunner: boolean;
};

const AUTO_MULTILINE_URL = "/data/rack/MultiLine-latest.xlsx";
const AUTO_PDL_URL: Record<RackMarket, string> = {
  de: "/data/gsheet-truth-export/Factor_DE - PDL Forecast.csv",
  nordics: "/data/gsheet-truth-export/Factor_Nor - PDL Forecast.csv",
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

function lineAccent(line: string) {
  if (line.endsWith("1")) {
    return {
      shell: "from-sky-500/18 via-cyan-500/10 to-white",
      rail: "from-sky-500 via-cyan-500 to-sky-300",
      glow: "shadow-[0_20px_60px_-28px_rgba(14,165,233,0.75)]",
      slot: "border-sky-200 bg-sky-50/80",
      slotEmpty: "border-sky-100 bg-white/70",
      chip: "bg-sky-600 text-white",
      text: "text-sky-900",
    };
  }
  if (line.endsWith("3")) {
    return {
      shell: "from-emerald-500/18 via-teal-500/10 to-white",
      rail: "from-emerald-500 via-teal-500 to-emerald-300",
      glow: "shadow-[0_20px_60px_-28px_rgba(16,185,129,0.7)]",
      slot: "border-emerald-200 bg-emerald-50/80",
      slotEmpty: "border-emerald-100 bg-white/70",
      chip: "bg-emerald-600 text-white",
      text: "text-emerald-900",
    };
  }
  if (line.endsWith("4")) {
    return {
      shell: "from-orange-500/18 via-amber-500/10 to-white",
      rail: "from-orange-500 via-amber-500 to-orange-300",
      glow: "shadow-[0_20px_60px_-28px_rgba(249,115,22,0.72)]",
      slot: "border-orange-200 bg-orange-50/80",
      slotEmpty: "border-orange-100 bg-white/70",
      chip: "bg-orange-600 text-white",
      text: "text-orange-900",
    };
  }

  return {
    shell: "from-violet-500/18 via-fuchsia-500/10 to-white",
    rail: "from-violet-500 via-fuchsia-500 to-violet-300",
    glow: "shadow-[0_20px_60px_-28px_rgba(139,92,246,0.72)]",
    slot: "border-violet-200 bg-violet-50/80",
    slotEmpty: "border-violet-100 bg-white/70",
    chip: "bg-violet-600 text-white",
    text: "text-violet-900",
  };
}

function buildSlotColumns(slots: number[]) {
  const columns: Array<Array<{ slotNumber: number; position: string; tier: 1 | 2 | 3 }>> = [];
  for (let index = 0; index < slots.length; index += 3) {
    const slice = slots.slice(index, index + 3);
    columns.push(slice.map((slotNumber, tierIndex) => ({
      slotNumber,
      position: `F${String(slotNumber).padStart(2, "0")}`,
      tier: (tierIndex + 1) as 1 | 2 | 3,
    })));
  }
  return columns;
}

function tierTone(tier: 1 | 2 | 3) {
  if (tier === 1) return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (tier === 2) return "border-sky-200 bg-sky-50 text-sky-900";
  return "border-rose-200 bg-rose-50 text-rose-900";
}

function tierLabel(tier: 1 | 2 | 3, locale: UiLocale) {
  if (locale === "de") return tier === 1 ? "Etage 1" : tier === 2 ? "Etage 2" : "Etage 3";
  return tier === 1 ? "Tier 1" : tier === 2 ? "Tier 2" : "Tier 3";
}

function moveRackEntry(entries: RackEntry[], entryId: string, line: string, flowRackPosition: string): RackEntry[] {
  return updateRackEntry(entries, entryId, { line, flowRackPosition });
}

function visualizationSheetName(market: RackMarket) {
  return market === "de" ? "Visualization Rackplan - DACH" : "Visualization Rackplan - Nordic";
}

function parseDemandValue(text: string) {
  const normalized = text.replace(/[^0-9,.-]/g, "").replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

async function parseVisualizationRackplan(file: File, market: RackMarket): Promise<Map<string, RackSlotMeta>> {
  const { Workbook } = await import("exceljs");
  const workbook = new Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  const worksheet = workbook.getWorksheet(visualizationSheetName(market));
  if (!worksheet) return new Map();

  const slotMeta = new Map<string, RackSlotMeta>();
  for (let rowNumber = 13; rowNumber <= worksheet.rowCount - 2; rowNumber += 1) {
    const levelText = worksheet.getRow(rowNumber).getCell(5).text.trim();
    const demandLevelText = worksheet.getRow(rowNumber + 1).getCell(5).text.trim();
    const positionLevelText = worksheet.getRow(rowNumber + 2).getCell(5).text.trim();
    const level = Number(levelText);
    if (!Number.isFinite(level) || levelText !== demandLevelText || levelText !== positionLevelText) continue;

    for (let column = 6; column <= worksheet.columnCount; column += 1) {
      const position = worksheet.getRow(rowNumber + 2).getCell(column).text.trim();
      if (!/^F\d+$/i.test(position)) continue;
      const demand = parseDemandValue(worksheet.getRow(rowNumber + 1).getCell(column).text.trim());
      const station = worksheet.getRow(11).getCell(column).text.trim();
      const type = worksheet.getRow(9).getCell(column).text.trim();
      slotMeta.set(position.toUpperCase(), {
        level,
        station,
        demand,
        type,
        preferredPick: level === 2,
        highRunner: level === 2 && demand > 0,
      });
    }

    rowNumber += 2;
  }

  return slotMeta;
}

async function fetchPublicFile(url: string, fallbackName: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Auto-Quelle nicht gefunden: ${url}`);
  }
  const blob = await response.blob();
  const name = decodeURIComponent(url.split("/").at(-1) ?? fallbackName) || fallbackName;
  return new File([blob], name, { type: blob.type || undefined });
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
  const [draggedEntryId, setDraggedEntryId] = useState<string | null>(null);
  const [hoveredSlotKey, setHoveredSlotKey] = useState<string | null>(null);

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
    setStatus(locale === "de" ? `Automatischer Rack-Start für ${week} wird vorbereitet …` : `Preparing automatic rack startup for ${week} …`);
  }, [market, week, locale, profile.lines]);

  useEffect(() => {
    let cancelled = false;

    async function loadAutomaticSources() {
      setBusy(locale === "de" ? `Lade Standardquellen für ${week} …` : `Loading default sources for ${week} …`);
      try {
        const [multilineFile, pdlFile] = await Promise.all([
          fetchPublicFile(AUTO_MULTILINE_URL, "MultiLine-latest.xlsx"),
          fetchPublicFile(AUTO_PDL_URL[market], market === "de" ? "Factor_DE - PDL Forecast.csv" : "Factor_Nor - PDL Forecast.csv"),
        ]);
        if (cancelled) return;

        const [nextEntries, nextPdlIds] = await Promise.all([
          parseMultilineExcel(multilineFile, market, profile.lines),
          parsePdlCsv(pdlFile),
        ]);
        if (cancelled) return;

        setActiveLines(profile.lines);
        setEntries(nextEntries);
        setTemplateEntries(nextEntries);
        setPdlIds(nextPdlIds);
        setSourceLabel(`${multilineFile.name} · ${pdlFile.name}`);
        setStatus(locale === "de"
          ? `Rackfile-Basis für ${week} automatisch geladen. Export ist direkt möglich, Boxfile und CO2 sind nur noch optional für Zusatzchecks.`
          : `Rackfile base for ${week} loaded automatically. You can export immediately; boxfile and CO2 are only optional extra checks.`);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setStatus(locale === "de"
          ? `Automatischer Rack-Start fehlgeschlagen: ${message}. Du kannst die Dateien unten weiterhin manuell überschreiben.`
          : `Automatic rack startup failed: ${message}. You can still override files manually below.`);
      } finally {
        if (!cancelled) setBusy(null);
      }
    }

    void loadAutomaticSources();
    return () => {
      cancelled = true;
    };
  }, [market, week, locale, profile.lines]);

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
      setStatus(locale === "de" ? "Noch keine Rack-Basis geladen. Warte kurz auf den Auto-Import oder wähle unten Dateien manuell aus." : "No rack base loaded yet. Wait for the automatic import or choose files manually below.");
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

  function handlePillDragStart(entryId: string) {
    setDraggedEntryId(entryId);
  }

  function handlePillDragEnd() {
    setDraggedEntryId(null);
    setHoveredSlotKey(null);
  }

  function handleSlotDrop(line: string, flowRackPosition: string) {
    if (!draggedEntryId) return;
    setEntries((current) => moveRackEntry(current, draggedEntryId, line, flowRackPosition));
    setStatus(locale === "de"
      ? `Verschoben auf ${line} / ${flowRackPosition}. Etage 3 möglichst nur nutzen, wenn darunter nichts mehr frei ist.`
      : `Moved to ${line} / ${flowRackPosition}. Keep tier 3 as free as possible.`);
    setDraggedEntryId(null);
    setHoveredSlotKey(null);
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
                  ? "Beim Öffnen lädt das Tool die Standardquellen selbst und baut daraus direkt die Rackfile-Basis für die gewählte KW. MultiLine, PDL, Boxfile, CO2 oder ein bestehendes Rackfile kannst du unten nur noch optional als Override nachladen."
                  : "On open, the tool loads the default sources automatically and builds the rackfile base for the selected week. MultiLine, PDL, boxfile, CO2 or an existing rackfile below are optional overrides only."}
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
              <div className="md:col-span-2 xl:col-span-3 rounded-2xl border border-dashed border-slate-300 bg-white p-3 text-sm text-slate-600">
                {locale === "de"
                  ? "Standardquellen werden automatisch geladen. Die folgenden Uploads sind nur für manuelle Overrides oder zusätzliche Validierung gedacht."
                  : "Default sources are loaded automatically. The uploads below are only for manual overrides or additional validation."}
              </div>
              <UploadCard label="MultiLine XLSX" hint={locale === "de" ? `${profile.sheet} · optional überschreiben` : `${profile.sheet} · optional override`} onPick={handleMultilineUpload} accept=".xlsx" />
              <UploadCard label="Rackfile CSV" hint={locale === "de" ? "optional: bestehendes Rackfile importieren" : "optional: import existing rackfile"} onPick={handleRackfileUpload} accept=".csv" />
              <UploadCard label="PDL CSV" hint={locale === "de" ? "optional: Meal-Soll überschreiben" : "optional: override meal target"} onPick={handlePdlUpload} accept=".csv" />
              <UploadCard label="Boxfile CSV" hint={locale === "de" ? "optional: ETL BOXFILE_VE für Zusatzchecks" : "optional: ETL BOXFILE_VE for extra checks"} onPick={handleBoxfileUpload} accept=".csv" />
              <UploadCard label="CO2 CSV" hint={locale === "de" ? `optional: ETL CO_2 (${profile.boxPrefix})` : `optional: ETL CO_2 (${profile.boxPrefix})`} onPick={handleCo2Upload} accept=".csv" />
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
              <p className="mt-1 text-sm text-slate-500">{locale === "de" ? "Die ASLs werden als echte Förderlinie gezeigt: mit Track, Slotfolge, Belegung und den geplanten Artikeln pro Position." : "Each ASL is rendered like a real conveyor line with track, slot sequence, occupancy and planned items per position."}</p>
            </div>
          </div>

          <div className="mt-4 space-y-6">
            {(usedLines.length > 0 ? usedLines : activeLines).map((line) => {
              const slots = lineSlotRange(entries, line);
              return (
                <LineVisual
                  key={line}
                  line={line}
                  market={market}
                  slots={slots}
                  entries={entries}
                  entriesByLineAndSlot={entriesByLineAndSlot}
                  locale={locale}
                  draggedEntryId={draggedEntryId}
                  hoveredSlotKey={hoveredSlotKey}
                  onHoverSlot={setHoveredSlotKey}
                  onDropToSlot={handleSlotDrop}
                  onPillDragStart={handlePillDragStart}
                  onPillDragEnd={handlePillDragEnd}
                />
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

function LineVisual({
  line,
  market,
  slots,
  entries,
  entriesByLineAndSlot,
  locale,
  draggedEntryId,
  hoveredSlotKey,
  onHoverSlot,
  onDropToSlot,
  onPillDragStart,
  onPillDragEnd,
}: {
  line: string;
  market: RackMarket;
  slots: number[];
  entries: RackEntry[];
  entriesByLineAndSlot: Map<string, RackEntry[]>;
  locale: UiLocale;
  draggedEntryId: string | null;
  hoveredSlotKey: string | null;
  onHoverSlot: (slotKey: string | null) => void;
  onDropToSlot: (line: string, flowRackPosition: string) => void;
  onPillDragStart: (entryId: string) => void;
  onPillDragEnd: () => void;
}) {
  const accent = lineAccent(line);
  const lineEntries = entries.filter((entry) => entry.line === line);
  const slotColumns = buildSlotColumns(slots);
  const occupiedSlots = slots.filter((slotNumber) => {
    const position = `F${String(slotNumber).padStart(2, "0")}`;
    return (entriesByLineAndSlot.get(`${line}:${position}`) ?? []).length > 0;
  }).length;
  const emptySlots = Math.max(slots.length - occupiedSlots, 0);
  const density = slots.length > 0 ? Math.round((occupiedSlots / slots.length) * 100) : 0;
  const topTierOccupied = slotColumns.filter((column) => {
    const topSlot = column.at(2);
    if (!topSlot) return false;
    return (entriesByLineAndSlot.get(`${line}:${topSlot.position}`) ?? []).length > 0;
  }).length;

  return (
    <div className={`overflow-hidden rounded-[28px] border border-slate-200 bg-gradient-to-br ${accent.shell} p-4 sm:p-5 ${accent.glow}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className={lineBadge(line)}>{line}</span>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${accent.chip}`}>{locale === "de" ? "Aktive Förderlinie" : "Active conveyor line"}</span>
          </div>
          <div>
            <h4 className={`text-xl font-black tracking-tight ${accent.text}`}>{locale === "de" ? `${line} Rack-Linie` : `${line} rack lane`}</h4>
            <p className="mt-1 text-sm text-slate-600">
              {locale === "de"
                ? `Von ${slots.length > 0 ? `F${String(slots[0]).padStart(2, "0")}` : "-"} bis ${slots.length > 0 ? `F${String(slots[slots.length - 1]).padStart(2, "0")}` : "-"}. Die Fächer werden wie im Staffing echt dreietagig gebaut, also z. B. 13, 14, 15 übereinander.`
                : `From ${slots.length > 0 ? `F${String(slots[0]).padStart(2, "0")}` : "-"} to ${slots.length > 0 ? `F${String(slots[slots.length - 1]).padStart(2, "0")}` : "-"}. Compartments are rendered as real three-tier stacks, for example 13, 14, 15 vertically.`}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wide">
              <span className={`rounded-full px-2.5 py-1 ${accent.chip}`}>
                {market === "de" ? (locale === "de" ? "DE mit Liner-Bühne" : "DE with liner stage") : (locale === "de" ? "Nordics ohne Liner" : "Nordics without liner")}
              </span>
              <span className="rounded-full bg-white/70 px-2.5 py-1 text-slate-700 ring-1 ring-slate-200">
                {locale === "de" ? "Drag-and-drop Planung" : "Drag-and-drop planning"}
              </span>
            </div>
          </div>
        </div>

        <div className="grid min-w-[260px] grid-cols-3 gap-2 text-sm">
          <MiniStat label={locale === "de" ? "Slots" : "Slots"} value={slots.length} />
          <MiniStat label={locale === "de" ? "Belegt" : "Occupied"} value={occupiedSlots} />
          <MiniStat label={locale === "de" ? "Leer" : "Empty"} value={emptySlots} />
          <MiniStat label={locale === "de" ? "Items" : "Items"} value={lineEntries.length} />
          <MiniStat label={locale === "de" ? "Dichte" : "Density"} value={`${density}%`} accent={density >= 85} />
          <MiniStat label={locale === "de" ? "Etage 3 belegt" : "Tier 3 used"} value={topTierOccupied} accent={topTierOccupied > 0} />
        </div>
      </div>

      <div className="mt-5 rounded-[24px] border border-white/60 bg-white/75 p-3 ring-1 ring-white/50 backdrop-blur">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "ASL Überblick" : "ASL overview"}</div>
          <div className="text-xs text-slate-500">{locale === "de" ? "Scroll horizontal für die komplette Linie" : "Scroll horizontally for the full line"}</div>
        </div>

        <div className="mb-4 grid gap-2 md:grid-cols-3">
          {[1, 2, 3].map((tier) => (
            <div key={tier} className={`rounded-2xl border px-3 py-2 text-xs ${tierTone(tier as 1 | 2 | 3)}`}>
              <div className="font-bold uppercase tracking-wide">{tierLabel(tier as 1 | 2 | 3, locale)}</div>
              <div className="mt-1 opacity-80">
                {tier < 3
                  ? (locale === "de" ? "Direkte Arbeitszone in der Säule." : "Primary working zone in the column.")
                  : (locale === "de" ? "Obere Etage, möglichst sparsam belegen." : "Top tier, use sparingly when possible.")}
              </div>
            </div>
          ))}
        </div>

        <div className="overflow-x-auto pb-3">
          <div className="relative min-w-max px-2 pt-8">
            <div className={`absolute left-0 right-0 ${market === "de" ? "top-[1.8rem] h-4" : "top-[2.25rem] h-2"} rounded-full bg-gradient-to-r ${accent.rail} opacity-90`} />
            {market === "de" && <div className="absolute left-6 right-6 top-[2.55rem] h-[6px] rounded-full bg-white/70" />}
            <div className="relative flex items-start gap-3">
              {slotColumns.map((column, columnIndex) => {
                return (
                  <div key={`${line}-column-${columnIndex}`} className="relative w-[210px] shrink-0">
                    <div className={`absolute left-1/2 top-[-0.45rem] h-5 w-1 -translate-x-1/2 rounded-full ${column.some((slot) => (entriesByLineAndSlot.get(`${line}:${slot.position}`) ?? []).length > 0) ? accent.chip : "bg-slate-300"}`} />
                    <div className="rounded-[24px] border border-slate-200/80 bg-white/70 p-3 shadow-sm backdrop-blur">
                      <div className="mb-3 flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        <span>{locale === "de" ? "Säule" : "Column"} {columnIndex + 1}</span>
                        <span>{column.map((slot) => slot.position.replace("F", "")).join(" / ")}</span>
                      </div>
                      <div className="space-y-2">
                        {[...column].reverse().map((slot) => {
                          const slotEntries = entriesByLineAndSlot.get(`${line}:${slot.position}`) ?? [];
                          const occupied = slotEntries.length > 0;
                          const slotKey = `${line}:${slot.position}`;
                          const isHovered = hoveredSlotKey === slotKey;
                          return (
                            <div
                              key={slotKey}
                              className={`rounded-[22px] border p-3 transition ${occupied ? `${accent.slot} shadow-sm` : accent.slotEmpty} ${slot.tier === 3 ? "ring-1 ring-rose-200" : ""} ${isHovered ? "ring-2 ring-slate-900 ring-offset-2" : ""}`}
                              onDragOver={(event) => {
                                event.preventDefault();
                                onHoverSlot(slotKey);
                              }}
                              onDragLeave={() => onHoverSlot(null)}
                              onDrop={(event) => {
                                event.preventDefault();
                                onDropToSlot(line, slot.position);
                              }}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div>
                                  <div className="font-mono text-xs font-bold uppercase tracking-[0.22em] text-slate-500">{slot.position}</div>
                                  <div className="mt-1 text-[11px] text-slate-500">{tierLabel(slot.tier, locale)}</div>
                                </div>
                                <div className={`rounded-full px-2.5 py-1 text-xs font-bold ${slot.tier === 3 ? "bg-rose-600 text-white" : occupied ? accent.chip : "bg-slate-200 text-slate-600"}`}>{slotEntries.length}</div>
                              </div>

                              <div className="mt-3 space-y-1.5">
                                {slotEntries.map((entry) => {
                                  const kind = deriveEntryKind(entry);
                                  const isDragged = draggedEntryId === entry.id;
                                  return (
                                    <button
                                      key={entry.id}
                                      type="button"
                                      draggable
                                      onDragStart={() => onPillDragStart(entry.id)}
                                      onDragEnd={onPillDragEnd}
                                      className={`flex w-full items-center justify-between gap-2 rounded-full border px-3 py-2 text-left text-xs font-semibold transition ${kindTone(kind)} ${isDragged ? "scale-[0.98] opacity-60" : "hover:-translate-y-0.5 hover:shadow-sm"}`}
                                      title={locale === "de" ? "Zum Verschieben ziehen" : "Drag to move"}
                                    >
                                      <span className="truncate">{entry.recipe}</span>
                                      <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-bold">x{entry.quantity}</span>
                                    </button>
                                  );
                                })}
                                {!occupied && (
                                  <div className="rounded-full border border-dashed border-slate-200 px-3 py-2 text-center text-[11px] text-slate-400">
                                    {locale === "de" ? "frei" : "free"}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}