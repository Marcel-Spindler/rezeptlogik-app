import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "rezeptlogik";
const DB_VERSION = 1;

const STORES = {
  dataBundle: "dataBundle",
  mealCatalog: "mealCatalog",
  wmsInventory: "wmsInventory",
  wmsSearch: "wmsSearch",
  geminiInstructions: "geminiInstructions",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

interface PersistEntry<T = unknown> {
  key: string;
  data: T;
  updatedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        for (const name of Object.values(STORES)) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: "key" });
          }
        }
      },
    });
  }
  return dbPromise;
}

export async function persistGet<T>(store: StoreName, key: string): Promise<{ data: T; updatedAt: number } | null> {
  try {
    const db = await getDb();
    const entry = await db.get(store, key) as PersistEntry<T> | undefined;
    if (!entry) return null;
    return { data: entry.data, updatedAt: entry.updatedAt };
  } catch {
    return null;
  }
}

export async function persistSet<T>(store: StoreName, key: string, data: T): Promise<void> {
  try {
    const db = await getDb();
    const entry: PersistEntry<T> = { key, data, updatedAt: Date.now() };
    await db.put(store, entry);
  } catch { /* quota/error — silently ignore */ }
}

export async function persistDelete(store: StoreName, key: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(store, key);
  } catch { /* ignore */ }
}

export async function persistClear(store: StoreName): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(store);
  } catch { /* ignore */ }
}

export async function persistKeys(store: StoreName): Promise<string[]> {
  try {
    const db = await getDb();
    return (await db.getAllKeys(store)) as string[];
  } catch {
    return [];
  }
}

export async function persistGetAll<T>(store: StoreName): Promise<Array<{ key: string; data: T; updatedAt: number }>> {
  try {
    const db = await getDb();
    const entries = await db.getAll(store) as PersistEntry<T>[];
    return entries.map(e => ({ key: e.key, data: e.data, updatedAt: e.updatedAt }));
  } catch {
    return [];
  }
}

export { STORES };
