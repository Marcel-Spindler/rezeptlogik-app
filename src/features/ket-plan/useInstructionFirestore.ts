// Firestore-Persistierung des Instruction-Cache: Instructions sind teuer
// (Gemini-Token-Kosten) und sollen geräteübergreifend erhalten bleiben.
// Ein Dokument pro cacheKey unter apps/rezeptlogik/woInstructions/{encodedKey}.
// Zusätzlich: lokale IndexedDB-Persistierung für Offline-Zugriff und schnellen Start.
import type { WoInstruction } from "./ketTypes";
import { collection, doc, getDocs, getFirebase, setDoc, writeBatch } from "../../core/firebase";
import { persistGet, persistSet, STORES } from "../../lib/persistentStore";

const COLLECTION_PATH = "apps/rezeptlogik/woInstructions";

function encodeKey(cacheKey: string): string {
  return cacheKey.replace(/\//g, "__");
}

export type InstructionCache = Record<string, WoInstruction>;

export async function loadInstructionsFromFirestore(): Promise<InstructionCache> {
  // Erst IndexedDB (instant), dann Firestore im Hintergrund
  const local = await persistGet<InstructionCache>(STORES.geminiInstructions, "all");
  if (local?.data && Object.keys(local.data).length > 0) {
    console.log(`[instructions] IndexedDB-Hit: ${Object.keys(local.data).length} Instruktionen vom ${new Date(local.updatedAt).toLocaleString("de-DE")}`);
    void refreshInstructionsFromFirestore();
    return local.data;
  }
  return refreshInstructionsFromFirestore();
}

async function refreshInstructionsFromFirestore(): Promise<InstructionCache> {
  try {
    const { db } = getFirebase();
    const snap = await getDocs(collection(db, COLLECTION_PATH));
    const cache: InstructionCache = {};
    snap.forEach((d) => {
      const data = d.data() as WoInstruction & { cacheKey?: string };
      const key = data.cacheKey ?? d.id;
      cache[key] = {
        english: data.english, german: data.german, status: data.status,
        generatedAt: data.generatedAt, model: data.model,
        source: data.source, sourceFile: data.sourceFile,
      };
    });
    void persistSet(STORES.geminiInstructions, "all", cache);
    return cache;
  } catch (error) {
    console.error("[useInstructionFirestore] Load failed:", error);
    return {};
  }
}

export async function saveInstructionToFirestore(cacheKey: string, instruction: WoInstruction): Promise<void> {
  try {
    const { db } = getFirebase();
    const ref = doc(db, COLLECTION_PATH, encodeKey(cacheKey));
    await setDoc(ref, { ...instruction, cacheKey }, { merge: true });
    // Auch lokal aktualisieren
    const local = await persistGet<InstructionCache>(STORES.geminiInstructions, "all");
    const updated = { ...(local?.data ?? {}), [cacheKey]: instruction };
    void persistSet(STORES.geminiInstructions, "all", updated);
  } catch (error) {
    console.error("[useInstructionFirestore] Save failed for", cacheKey, error);
  }
}

export async function saveInstructionsBatchToFirestore(entries: [string, WoInstruction][]): Promise<void> {
  if (!entries.length) return;
  try {
    const { db } = getFirebase();
    // Firestore writeBatch hat ein 500-Operationen-Limit
    for (let i = 0; i < entries.length; i += 450) {
      const chunk = entries.slice(i, i + 450);
      const batch = writeBatch(db);
      for (const [cacheKey, instruction] of chunk) {
        const ref = doc(db, COLLECTION_PATH, encodeKey(cacheKey));
        batch.set(ref, { ...instruction, cacheKey }, { merge: true });
      }
      await batch.commit();
    }
  } catch (error) {
    console.error("[useInstructionFirestore] Batch save failed:", error);
  }
}
