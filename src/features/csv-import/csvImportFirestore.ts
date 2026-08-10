// CSV Import – Firestore-Batch-Write (writeBatch, additiv, 400er-Chunks) und
// Datei-Lese-Helper. Verhalten unverändert aus CsvImportView.tsx übernommen —
// dies ist der einzige Live-Firestore-Schreibpfad der App.

export async function pushToFirestore(
  recipes: Record<string, unknown>,
  structures: Record<string, unknown>,
  onProgress: (msg: string) => void
): Promise<void> {
  const [{ getFirebase }, { doc, collection, writeBatch }] = await Promise.all([
    import("../../core/firebase"),
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

export async function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve((e.target?.result as string) ?? "");
    reader.onerror = () => reject(new Error(`Datei konnte nicht gelesen werden: ${file.name}`));
    reader.readAsText(file, "utf-8");
  });
}
