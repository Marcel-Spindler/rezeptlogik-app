// Zeigt das GSheet-Quellen-Register (welche Sheets/Tabs die App überhaupt kennt),
// geladen aus dem statischen Registry-Dump. Rein informativ, kein Live-Datenpfad.
import { useEffect, useState } from "react";

interface GsheetTab {
  title: string;
  rowCount: number;
  columnCount: number;
  hidden: boolean;
}

interface GsheetSource {
  spreadsheetId: string;
  title: string;
  purpose: string;
  aliases: string[];
  tags: string[];
  envKey?: string;
  tabHint?: string;
  dumpFile: string;
  generatedAt: string;
  sheetCount: number;
  totalRows: number;
  sheets: GsheetTab[];
}

interface GsheetExtraSource {
  type: string;
  label: string;
  sourceId: string;
  purpose: string;
  outputFiles: string[];
}

export interface GsheetRegistry {
  generatedAt: string;
  spreadsheetCount: number;
  spreadsheets: GsheetSource[];
  extraSources?: GsheetExtraSource[];
}

export function useGsheetRegistry(): GsheetRegistry | null {
  const [registry, setRegistry] = useState<GsheetRegistry | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/data/gsheet-sources.json?ts=${Date.now()}`, { cache: "no-store" })
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<GsheetRegistry>; })
      .then(payload => { if (!cancelled) setRegistry(payload); })
      .catch(() => { if (!cancelled) setRegistry(null); });
    return () => { cancelled = true; };
  }, []);

  return registry;
}

function fmtNum(n: number): string {
  return n.toLocaleString("de-DE");
}

function gsheetTagTone(tag: string): string {
  if (tag === "truth" || tag === "forecast") return "bg-sky-50 text-sky-700 ring-sky-200";
  if (tag === "equipment" || tag === "batch" || tag === "process") return "bg-violet-50 text-violet-700 ring-violet-200";
  if (tag === "planning-oase" || tag === "kpl" || tag === "ops") return "bg-amber-50 text-amber-700 ring-amber-200";
  if (tag === "quality" || tag === "shelf-life") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  return "bg-slate-50 text-slate-600 ring-slate-200";
}

function GsheetSourceCard({ sheet }: { sheet: GsheetSource }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-black text-slate-900">{sheet.title}</div>
          <div className="mt-1 font-mono text-[11px] text-slate-500">{sheet.spreadsheetId}</div>
        </div>
        <a href={sheet.dumpFile} target="_blank" rel="noreferrer"
          className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100">
          Dump
        </a>
      </div>

      <div className="mt-2 text-[12px] leading-5 text-slate-600">{sheet.purpose}</div>

      <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-semibold">
        {sheet.tags.map(tag => <span key={tag} className={`rounded-full px-2 py-1 ring-1 ${gsheetTagTone(tag)}`}>{tag}</span>)}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-600">
        <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <div className="font-semibold text-slate-800">{fmtNum(sheet.sheetCount)} Tabs</div>
          <div>gesamt {fmtNum(sheet.totalRows)} gelesene Zeilen</div>
        </div>
        <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
          <div className="font-semibold text-slate-800">{new Date(sheet.generatedAt).toLocaleString("de-DE")}</div>
          <div>{sheet.envKey ?? "Registry / Dump"}</div>
        </div>
      </div>

      <div className="mt-3 text-[11px] text-slate-500">
        {sheet.tabHint ? `Tab-Hinweis: ${sheet.tabHint} · ` : ""}
        Alias: {sheet.aliases.join(", ")}
      </div>

      <div className="mt-3 max-h-28 overflow-auto rounded-xl bg-white p-2 ring-1 ring-slate-200">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">Tabs</div>
        <div className="space-y-1 text-[11px] text-slate-600">
          {sheet.sheets.map(tab => (
            <div key={tab.title} className="flex items-center justify-between gap-2">
              <span className="truncate">{tab.title}{tab.hidden ? " (hidden)" : ""}</span>
              <span className="shrink-0 font-semibold text-slate-500">{fmtNum(tab.rowCount)} Zeilen</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function GsheetRegistryPanel({ registry }: { registry: GsheetRegistry }) {
  return (
    <details className="mt-4 rounded-2xl border border-slate-200 bg-white/80 p-4">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-black text-slate-900">GSheet Register</div>
          <div className="text-[11px] text-slate-500">
            {fmtNum(registry.spreadsheetCount)} Sheets sichtbar · letzter Registry-Sync{" "}
            {new Date(registry.generatedAt).toLocaleString("de-DE")}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700 ring-1 ring-slate-200">Inventory live in OASE</span>
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700 ring-1 ring-amber-200">alle bekannten GSheets gelistet</span>
        </div>
      </summary>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {registry.spreadsheets.map(sheet => <GsheetSourceCard key={sheet.spreadsheetId} sheet={sheet} />)}
      </div>

      {!!registry.extraSources?.length && (
        <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-[12px] text-slate-600">
          {registry.extraSources.map(source => (
            <div key={source.sourceId}>
              <span className="font-bold text-slate-800">{source.label}</span> · {source.sourceId} · {source.purpose}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
