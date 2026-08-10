// What-If Rechner – Per-Ingredient-Yield-Override-Persistenz (localStorage).
// Schlüsselformat: rezeptlogik_v1_yield_override_<ingredientId>__<subRecipeId>.
// Meals wiederholen sich wochenübergreifend, daher bleiben Overrides absichtlich persistent.

export const LS_PREFIX = "rezeptlogik_v1_yield_override_";

export function overrideKey(ingredientId: string, subRecipeId: string): string {
  return `${LS_PREFIX}${ingredientId || "noId"}__${subRecipeId || "noSub"}`;
}

export function saveOverride(ingredientId: string, subRecipeId: string, value: number | null): void {
  try {
    const k = overrideKey(ingredientId, subRecipeId);
    if (value === null) localStorage.removeItem(k);
    else localStorage.setItem(k, String(value));
  } catch { /* quota */ }
}

export function listAllOverrides(): Array<{ ingredientId: string; subRecipeId: string; value: number; key: string }> {
  const out: Array<{ ingredientId: string; subRecipeId: string; value: number; key: string }> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LS_PREFIX)) continue;
      const tail = key.substring(LS_PREFIX.length);
      const [ingId, subId] = tail.split("__");
      const v = parseFloat(localStorage.getItem(key) || "");
      if (!isNaN(v)) out.push({ ingredientId: ingId || "", subRecipeId: subId || "", value: v, key });
    }
  } catch { /* */ }
  return out;
}

