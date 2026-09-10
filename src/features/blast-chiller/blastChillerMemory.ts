// Merker des Blast Chiller Bots: welche Work Orders für eine KW schon in einem
// Handout waren. Marcel lädt den KET-Plan Fr + Mo–Do neu — das Quellprogramm gibt
// jedes Mal die schon gelaufenen WOs mit aus. Über diesen Merker zeigt der Bot
// beim Folge-Upload nur noch die NEUEN WO-Nummern.
//
// Speicher: localStorage (dieser Bot ist upload-getrieben, kein Firestore).
// Quelle der Wahrheit = die WO-Nummer aus dem CSV (stabil, exakt).

const SEEN_KEY = "rezeptlogik-blast-chiller-seen-v1";

interface SeenEntry {
  wos: string[];
  updatedAt: string;
}
type SeenStore = Record<string, SeenEntry>;

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readStore(): SeenStore {
  const ls = store();
  if (!ls) return {};
  try {
    const raw = ls.getItem(SEEN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SeenStore) : {};
  } catch {
    return {};
  }
}

const MAX_WEEKS = 8;

function writeStore(next: SeenStore): void {
  const ls = store();
  if (!ls) return;
  // Alte Wochen aufräumen: nur die letzten MAX_WEEKS behalten.
  const keys = Object.keys(next);
  if (keys.length > MAX_WEEKS) {
    keys.sort((a, b) => (next[a].updatedAt ?? "").localeCompare(next[b].updatedAt ?? ""));
    for (const k of keys.slice(0, keys.length - MAX_WEEKS)) delete next[k];
  }
  try {
    ls.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    /* Speicher voll / blockiert — dann eben ohne Merker */
  }
}

/** Bereits gemerkte WO-Nummern für eine KW ("W37"). */
export function loadSeenWos(week: string): Set<string> {
  if (!week) return new Set();
  return new Set(readStore()[week]?.wos ?? []);
}

/** WO-Nummern für eine KW als "bearbeitet" merken (wird zur bestehenden Menge dazugelegt). */
export function rememberWos(week: string, woNumbers: Iterable<string>): Set<string> {
  if (!week) return new Set();
  const store = readStore();
  const merged = new Set(store[week]?.wos ?? []);
  for (const w of woNumbers) if (w) merged.add(w);
  store[week] = { wos: [...merged].sort(), updatedAt: new Date().toISOString() };
  writeStore(store);
  return merged;
}

/** Merker für eine KW löschen (dann zeigt der Bot wieder alles). */
export function clearSeenWos(week: string): void {
  if (!week) return;
  const store = readStore();
  delete store[week];
  writeStore(store);
}

/** Nur der Teil einer WO-Liste, der noch nicht gemerkt ist. */
export function splitNewWos<T extends { wo: string }>(
  items: T[],
  seen: Set<string>,
): { fresh: T[]; known: T[] } {
  const fresh: T[] = [];
  const known: T[] = [];
  for (const it of items) (seen.has(it.wo) ? known : fresh).push(it);
  return { fresh, known };
}
