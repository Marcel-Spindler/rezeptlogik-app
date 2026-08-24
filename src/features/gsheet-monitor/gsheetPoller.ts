// GSheet Monitor – Generischer Poller mit Hash-basierter Änderungserkennung.
import type { GSheetConfig, GSheetChange, GSheetSnapshot } from "./gsheetTypes";
import { buildSheetCsvUrl } from "./gsheetRegistry";

export async function fetchSheetCsv(config: GSheetConfig, signal?: AbortSignal): Promise<string> {
  const url = buildSheetCsvUrl(config);
  const resp = await fetch(url, { signal, cache: "no-store" });
  if (!resp.ok) throw new Error(`GSheet fetch failed: ${resp.status} ${resp.statusText}`);
  return resp.text();
}

// Echter Single-Pass-CSV-Parser: muss über den GESAMTEN Text laufen, nicht
// zeilenweise nach einem vorherigen split("\n") — sonst reißt ein Zeilenumbruch
// INNERHALB eines Anführungszeichen-Felds (z.B. ein mehrzeiliger Kommentar in
// LinePlaiting/RTI) die logische Zeile mittendrin auseinander und verschiebt
// danach alle Spalten. War vorher zeilenbasiert und hat genau das falsch
// gemacht — betraf potenziell jeden Sheet-Export mit einem solchen Feld.
export function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let current = "";
  let inQuotes = false;

  const pushCell = () => { row.push(current.trim()); current = ""; };
  const pushRow = () => {
    pushCell();
    if (row.some(c => c.length > 0)) rows.push(row);
    row = [];
  };

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") pushCell();
    else if (ch === "\r") { /* wird über \n behandelt */ }
    else if (ch === "\n") pushRow();
    else current += ch;
  }
  // Letzte Zeile, falls die Datei nicht mit Zeilenumbruch endet.
  if (current.length > 0 || row.length > 0) pushRow();

  return rows;
}

export async function hashString(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function diffRows(oldRows: string[][], newRows: string[][]): {
  changedRowIndices: number[];
  addedRowIndices: number[];
  removedCount: number;
} {
  const changed: number[] = [];
  const added: number[] = [];

  for (let i = 0; i < newRows.length; i++) {
    if (i >= oldRows.length) {
      added.push(i);
    } else if (newRows[i].join("|") !== oldRows[i].join("|")) {
      changed.push(i);
    }
  }

  const removedCount = Math.max(0, oldRows.length - newRows.length);
  return { changedRowIndices: changed, addedRowIndices: added, removedCount };
}

export type SheetChangeCallback = (change: GSheetChange, snapshot: GSheetSnapshot) => void;

export function createPoller(
  config: GSheetConfig,
  parser: (rows: string[][]) => unknown,
  onChange: SheetChangeCallback,
  onError?: (err: Error) => void
): { start: () => void; stop: () => void; getSnapshot: () => GSheetSnapshot | null; forceRefresh: () => Promise<void> } {
  let abortController: AbortController | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSnapshot: GSheetSnapshot | null = null;

  async function poll() {
    try {
      abortController = new AbortController();
      const csv = await fetchSheetCsv(config, abortController.signal);
      const newHash = await hashString(csv);

      if (lastSnapshot && newHash === lastSnapshot.hash) return;

      const rows = parseCsvRows(csv);
      const parsed = parser(rows);
      const newSnapshot: GSheetSnapshot = { timestamp: Date.now(), hash: newHash, rawCsv: csv, rows, parsed };

      // Immer onChange feuern — bei erstem Load mit leeren Diff-Arrays
      const diff = lastSnapshot
        ? diffRows(lastSnapshot.rows, rows)
        : { changedRowIndices: [], addedRowIndices: [], removedCount: 0 };

      onChange({
        sheetId: config.id,
        sheetName: config.name,
        prevHash: lastSnapshot?.hash ?? "",
        newHash,
        changedRowIndices: diff.changedRowIndices,
        addedRowIndices: diff.addedRowIndices,
        removedCount: diff.removedCount,
        timestamp: Date.now()
      }, newSnapshot);

      lastSnapshot = newSnapshot;
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      onError?.(err as Error);
    }
  }

  return {
    start() {
      poll();
      timer = setInterval(poll, config.pollIntervalMs);
    },
    stop() {
      abortController?.abort();
      if (timer) clearInterval(timer);
      timer = null;
    },
    getSnapshot() { return lastSnapshot; },
    forceRefresh() { return poll(); },
  };
}
