import { useState, useRef, useEffect, useId } from "react";
import type { DataBundle } from "./types";
import { formatDateTime } from "./i18n";
import { parseRecipesCsv, parseDetailedCsv, mergeGrossIntoRecipes } from "./lib/csv-parser";

// ─── Firestore-Batch-Write ───────────────────────────────────────────────────

async function pushToFirestore(
  recipes: Record<string, unknown>,
  structures: Record<string, unknown>,
  onProgress: (msg: string) => void
): Promise<void> {
  const [{ getFirebase }, { doc, collection, writeBatch }] = await Promise.all([
    import("./firebase"),
    import("firebase/firestore"),
  ]);
  const { db } = getFirebase();
  const ROOT = doc(db, "apps", "rezeptlogik");

  async function batchWrite(coll: any, entries: [string, unknown][], label: string) {
    const CHUNK = 400;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const batch = writeBatch(db);
      for (const [id, data] of entries.slice(i, i + CHUNK)) {
        batch.set(doc(coll, id), data as any);
      }
      await batch.commit();
      onProgress(`  ${label}: ${Math.min(i + CHUNK, entries.length)}/${entries.length}`);
    }
  }

  const recipeEntries = Object.entries(recipes);
  if (recipeEntries.length > 0) {
    onProgress(`Schreibe ${recipeEntries.length} Rezepte nach Firestore…`);
    await batchWrite(collection(ROOT, "recipes"), recipeEntries, "Rezepte");
  }

  const structEntries = Object.entries(structures);
  if (structEntries.length > 0) {
    onProgress(`Schreibe ${structEntries.length} Strukturen nach Firestore…`);
    await batchWrite(collection(ROOT, "structures"), structEntries, "Strukturen");
  }
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

async function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve((e.target?.result as string) ?? "");
    reader.onerror = () => reject(new Error(`Datei konnte nicht gelesen werden: ${file.name}`));
    reader.readAsText(file, "utf-8");
  });
}

// ─── Komponente ──────────────────────────────────────────────────────────────

export function CsvImportView({ data }: { data: DataBundle }) {
  const recipesInputId  = useId();
  const detailedInputId = useId();

  const [recipesFile,  setRecipesFile]  = useState<File | null>(null);
  const [detailedFile, setDetailedFile] = useState<File | null>(null);

  const [running,  setRunning]  = useState(false);
  const [lines,    setLines]    = useState<string[]>([]);
  const [success,  setSuccess]  = useState<boolean | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (running && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines, running]);

  function log(msg: string) {
    setLines(prev => [...prev, msg]);
  }

  // ── Browser-Import (online): CSV parsen + Firestore ─────────────────────────
  async function runBrowserImport() {
    if (!recipesFile && !detailedFile) return;
    setRunning(true);
    setLines([]);
    setSuccess(null);

    try {
      const recipesText  = recipesFile  ? await readFileText(recipesFile)  : "";
      const detailedText = detailedFile ? await readFileText(detailedFile) : "";

      log("Parsing export-recipes CSV…");
      const recipes = recipesText ? parseRecipesCsv(recipesText) : {};
      log(`  ${Object.keys(recipes).length} Rezept-Codes gelesen`);

      log("Parsing Detailed-CSV (Zutaten, Yield)…");
      const { structures, grossByCode } = detailedText
        ? parseDetailedCsv(detailedText)
        : { structures: {}, grossByCode: {} };
      log(`  ${Object.keys(structures).length} Strukturen gelesen`);

      if (detailedText) {
        mergeGrossIntoRecipes(recipes, grossByCode);
        log("  Gross-Ingredients eingemischt");
      }

      await pushToFirestore(recipes, structures, log);

      log("✓ Import abgeschlossen");
      setSuccess(true);
    } catch (err) {
      log(`✗ Fehler: ${err instanceof Error ? err.message : String(err)}`);
      setSuccess(false);
    } finally {
      setRunning(false);
    }
  }

  // ── Dev-Server-Import (lokal): npm run import:local ───────────────────────
  const [devRunning,  setDevRunning]  = useState(false);
  const [devLines,    setDevLines]    = useState<string[]>([]);
  const [devExitCode, setDevExitCode] = useState<number | null>(null);
  const devLogRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (devRunning && devLogRef.current) {
      devLogRef.current.scrollTop = devLogRef.current.scrollHeight;
    }
  }, [devLines, devRunning]);

  async function runDevImport() {
    setDevRunning(true);
    setDevLines([]);
    setDevExitCode(null);

    try {
      const res = await fetch("/api/import-local", { method: "POST", cache: "no-store" });
      if (!res.body) throw new Error("Kein Streaming — nur im Vite Dev-Server verfügbar");

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";

        const newLines: string[] = [];
        for (const part of parts) {
          const m = /^__DONE:(\d+)__/.exec(part);
          if (m) setDevExitCode(parseInt(m[1], 10));
          else    newLines.push(part);
        }
        if (newLines.length) setDevLines(prev => [...prev, ...newLines]);
      }
      if (buffer) {
        const m = /^__DONE:(\d+)__/.exec(buffer);
        if (m) setDevExitCode(parseInt(m[1], 10));
        else if (buffer.trim()) setDevLines(prev => [...prev, buffer]);
      }
    } catch (err) {
      setDevLines(prev => [...prev, `Fehler: ${err instanceof Error ? err.message : String(err)}`]);
      setDevExitCode(1);
    } finally {
      setDevRunning(false);
    }
  }

  const canImport = (!!recipesFile || !!detailedFile) && !running;

  return (
    <div className="space-y-4 max-w-3xl">

      {/* ── Online-Import: Datei-Upload ──────────────────────────────────────── */}
      <div className="card p-5">
        <h2 className="text-base font-semibold text-slate-800 mb-0.5">CSV-Import</h2>
        <p className="text-sm text-slate-500 mb-4">
          CSV-Dateien direkt auswählen → werden im Browser geparst und in Firestore
          gespeichert. Funktioniert von überall, auch ohne lokale Skripte.
        </p>

        <div className="space-y-3">
          {/* Datei 1: export-recipes*.csv */}
          <div>
            <label htmlFor={recipesInputId} className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
              export-recipes*.csv
            </label>
            <div className="flex items-center gap-2">
              <label
                htmlFor={recipesInputId}
                className="cursor-pointer px-3 py-1.5 text-sm rounded-lg ring-1 ring-slate-300 bg-white text-slate-700 hover:bg-slate-50 select-none"
              >
                Datei wählen
              </label>
              <span className="text-sm text-slate-500 truncate max-w-xs">
                {recipesFile ? recipesFile.name : "keine Datei ausgewählt"}
              </span>
            </div>
            <input
              id={recipesInputId}
              type="file"
              accept=".csv"
              className="sr-only"
              onChange={e => setRecipesFile(e.target.files?.[0] ?? null)}
            />
          </div>

          {/* Datei 2: export-sub-recipes-by-recipe-detailed*.csv */}
          <div>
            <label htmlFor={detailedInputId} className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
              export-sub-recipes-by-recipe-detailed*.csv
            </label>
            <div className="flex items-center gap-2">
              <label
                htmlFor={detailedInputId}
                className="cursor-pointer px-3 py-1.5 text-sm rounded-lg ring-1 ring-slate-300 bg-white text-slate-700 hover:bg-slate-50 select-none"
              >
                Datei wählen
              </label>
              <span className="text-sm text-slate-500 truncate max-w-xs">
                {detailedFile ? detailedFile.name : "keine Datei ausgewählt"}
              </span>
            </div>
            <input
              id={detailedInputId}
              type="file"
              accept=".csv"
              className="sr-only"
              onChange={e => setDetailedFile(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-4">
          <button
            type="button"
            disabled={!canImport}
            onClick={runBrowserImport}
            className={`px-4 py-2 text-sm font-semibold rounded-lg ring-1 transition-colors ${
              !canImport
                ? "bg-slate-100 text-slate-400 ring-slate-200 cursor-not-allowed"
                : "bg-verden-600 text-white ring-verden-600 hover:bg-verden-700"
            }`}
          >
            {running
              ? <span className="flex items-center gap-2">
                  <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  Importiere…
                </span>
              : "Importieren → Firestore"
            }
          </button>

          {success === true && (
            <>
              <span className="text-sm font-medium text-emerald-700">✓ Gespeichert</span>
              <button
                type="button"
                className="px-3 py-1.5 text-xs font-semibold rounded-lg ring-1 ring-emerald-400 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                onClick={() => window.location.reload()}
              >
                Seite neu laden
              </button>
            </>
          )}
          {success === false && (
            <span className="text-sm font-medium text-red-600">✗ Fehler</span>
          )}

          <span className="text-xs text-slate-400 ml-auto">
            Letzter Stand: {formatDateTime("de", data.generatedAt)}
          </span>
        </div>

        {/* Log-Output */}
        {lines.length > 0 && (
          <pre
            ref={logRef}
            className="mt-3 text-xs text-slate-600 bg-slate-50 rounded-lg p-3 max-h-56 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed"
          >
            {lines.join("\n")}
          </pre>
        )}
      </div>

      {/* ── Info: Was importiert wird ──────────────────────────────────────────── */}
      <div className="card p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Was passiert beim Import</h3>
        <ul className="text-sm text-slate-600 space-y-1.5">
          <li className="flex gap-2">
            <span className="text-slate-400 shrink-0">▸</span>
            <span><strong>export-recipes*.csv</strong> — Sub-Rezepte, Mengen, Allergen-Info, MSKU je Markt</span>
          </li>
          <li className="flex gap-2">
            <span className="text-slate-400 shrink-0">▸</span>
            <span><strong>export-sub-recipes-by-recipe-detailed*.csv</strong> — Zutaten (Gross/Net), Yield%, Allergene je Zutat</span>
          </li>
          <li className="flex gap-2">
            <span className="text-slate-400 shrink-0">▸</span>
            <span>Jede importierte Datei <em>ergänzt</em> Firestore — Rezepte die nicht in der aktuellen CSV sind bleiben erhalten. So akkumuliert sich die Datenbank über die Wochen.</span>
          </li>
        </ul>
      </div>

      {/* ── Dev-Server-Import (nur lokal) ─────────────────────────────────────── */}
      <details className="card p-4">
        <summary className="text-xs font-semibold uppercase tracking-wide text-slate-500 cursor-pointer select-none">
          Lokaler Vollimport (nur Vite Dev-Server)
        </summary>
        <p className="text-sm text-slate-500 mt-2 mb-3">
          Liest alle CSVs, XLSX und Google-Sheets-Quellen aus{" "}
          <code className="bg-slate-100 px-1 rounded">C:\Rezeptlogik</code> und schreibt
          lokal in <code className="bg-slate-100 px-1 rounded">public/data/data.json</code>.
          Funktioniert nur wenn der Vite Dev-Server läuft.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={devRunning}
            onClick={runDevImport}
            className={`px-4 py-2 text-sm font-semibold rounded-lg ring-1 transition-colors ${
              devRunning
                ? "bg-slate-100 text-slate-400 ring-slate-200 cursor-not-allowed"
                : "bg-slate-700 text-white ring-slate-700 hover:bg-slate-800"
            }`}
          >
            {devRunning ? "Läuft…" : "npm run import:local"}
          </button>
          {devExitCode === 0 && (
            <button
              type="button"
              className="px-3 py-1.5 text-xs font-semibold rounded-lg ring-1 ring-emerald-400 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
              onClick={() => window.location.reload()}
            >
              Neu laden
            </button>
          )}
          {devExitCode !== null && devExitCode !== 0 && (
            <span className="text-sm text-red-600">✗ Exit {devExitCode}</span>
          )}
        </div>
        {devLines.length > 0 && (
          <pre
            ref={devLogRef}
            className="mt-3 text-xs text-slate-600 bg-slate-50 rounded-lg p-3 max-h-64 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed"
          >
            {devLines.join("\n")}
          </pre>
        )}
      </details>

    </div>
  );
}
