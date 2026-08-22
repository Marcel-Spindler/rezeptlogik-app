import { useState, useRef, useEffect, useId } from "react";
import { parseKetCsv } from "./ketLogic";
import type { KetRow } from "./ketTypes";
import { readFileText } from "../csv-import/csvImportFirestore";
import { getFirebase } from "../../core/firebase";
import { doc, setDoc } from "firebase/firestore";

function detectWeekFromRows(rows: KetRow[]): string | null {
  for (const r of rows) {
    const m = r.woNumber.match(/(?<![A-Za-z])W(\d{2})(?!\d)/i) || r.dateNeeded.match(/(?<![A-Za-z])W(\d{2})(?!\d)/i);
    if (m) return `2026-W${m[1]}`;
  }
  return null;
}

async function saveKetPlanToFirestore(
  week: string,
  rows: KetRow[],
  log: (msg: string) => void,
): Promise<void> {
  const { db } = getFirebase();
  const docRef = doc(db, "apps/rezeptlogik/ketPlan", week);
  await setDoc(docRef, {
    week,
    importedAt: new Date().toISOString(),
    rows,
  });
  log(`✓ KET-Plan für ${week} gespeichert (${rows.length} Zeilen)`);
}

export function KetPlanImport() {
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<{ rows: KetRow[]; week: string; warnings: string[] } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [success, setSuccess] = useState<boolean | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (running && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines, running]);

  async function onFileChange(f: File | null) {
    setFile(f);
    setParsed(null);
    setParseError(null);
    setSuccess(null);
    setLines([]);
    if (!f) return;
    try {
      const text = await readFileText(f);
      const result = parseKetCsv(text);
      const week = detectWeekFromRows(result.rows);
      if (!week) throw new Error("Konnte Woche nicht aus WO-Nummern oder Datum erkennen");
      if (result.rows.length === 0) throw new Error("Keine gültigen Zeilen in der CSV gefunden");
      setParsed({ rows: result.rows, week, warnings: result.warnings });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runImport() {
    if (!parsed) return;
    setRunning(true);
    setLines([]);
    setSuccess(null);
    const log = (msg: string) => setLines(prev => [...prev, msg]);
    try {
      log(`Importiere KET-Plan ${parsed.week}…`);
      log(`  ${parsed.rows.length} Zeilen gefunden`);
      if (parsed.warnings.length > 0) {
        for (const w of parsed.warnings.slice(0, 5)) log(`  ⚠ ${w}`);
      }
      await saveKetPlanToFirestore(parsed.week, parsed.rows, log);
      setSuccess(true);
      window.dispatchEvent(new CustomEvent("rezeptlogik:ket-plan-saved", { detail: { week: parsed.week } }));
    } catch (err) {
      log(`✗ Fehler: ${err instanceof Error ? err.message : String(err)}`);
      setSuccess(false);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="card p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
        KET-Plan-Import
      </h3>
      <p className="text-sm text-slate-500 mb-3">
        KET-CSV hochladen (z.B. <code className="bg-slate-100 px-1 rounded">KET-Verden-2026-W35.csv</code>)
        → wird geparst und in Firestore gespeichert.
      </p>

      <div className="flex items-center gap-2 mb-3">
        <label
          htmlFor={inputId}
          className="cursor-pointer px-3 py-1.5 text-sm rounded-lg ring-1 ring-slate-300 bg-white text-slate-700 hover:bg-slate-50 select-none"
        >
          Datei wählen
        </label>
        <span className="text-sm text-slate-500 truncate max-w-xs">
          {file ? file.name : "keine Datei ausgewählt"}
        </span>
        <input
          id={inputId}
          type="file"
          accept=".csv"
          className="sr-only"
          onChange={e => onFileChange(e.target.files?.[0] ?? null)}
        />
      </div>

      {parseError && (
        <p className="text-sm text-red-600 mb-2">✗ {parseError}</p>
      )}

      {parsed && (
        <div className="flex items-center gap-3 mb-3">
          <span className="text-sm text-slate-700">
            {parsed.rows.length} Zeilen · Woche {parsed.week}
          </span>
          <button
            type="button"
            disabled={running}
            onClick={runImport}
            className={`px-4 py-2 text-sm font-semibold rounded-lg ring-1 transition-colors ${
              running
                ? "bg-slate-100 text-slate-400 ring-slate-200 cursor-not-allowed"
                : "bg-verden-600 text-white ring-verden-600 hover:bg-verden-700"
            }`}
          >
            {running ? "Importiere…" : "→ Firestore speichern"}
          </button>
          {success === true && (
            <span className="text-sm font-medium text-emerald-700">✓ Gespeichert</span>
          )}
          {success === false && (
            <span className="text-sm font-medium text-red-600">✗ Fehler</span>
          )}
        </div>
      )}

      {lines.length > 0 && (
        <pre
          ref={logRef}
          className="mt-3 text-xs text-slate-600 bg-slate-50 rounded-lg p-3 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed"
        >
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}
