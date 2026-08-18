// Factor-Produktionsregeln — 1:1 portiert aus Matteos externem "factor-recipe-bot"
// (capacity-rules.js + SKILL.md / PRODUCTION-RULES-EN.md, Stand 2026-08-17).
// Ergänzt unsere Equipment-/Kuechenbible-Batchlogik (ketLogic.ts calcBatch) um die
// dort gelernten, rezeptnamen-basierten Sonderregeln (RTI, "nie batchen"-Fleisch,
// SEPARATE/Spice-Room, Saucen/Gemüse-Kapazitäten, bilinguale Allergene).
// Bei Regeländerung: SKILL.md / PRODUCTION-RULES-EN.md im Bot-Repo bleiben führend —
// hier nur synchron nachziehen.

export const ONE_BATCH = 1000; // sonstige Proteine/Fisch/Nüsse → 1 Batch (Spice Room pickt einmalig)
export const NO_BATCH = 999999; // Fleisch/Fisch, das NIE in Batches gesplittet wird (Matteo 2026-07-08)

// Veggie-Debox-Kapazitäten (kg — aus der VEGGIE-Bible "Wanne"-Werten, als kg verwendet).
const VEG: Array<[RegExp, number]> = [
  [/coin cut carrot|carrot coin/i, 105],
  [/broccoli/i, 65],
  [/cauliflower/i, 90],
  [/cherry tomato|tomatoes/i, 150],
  [/green bean|fagiolini/i, 65],
  [/zucchini|courgette|zucchine/i, 80],
  [/edamame/i, 100],
  [/corn/i, 90],
  [/portobello|cremini|button mushroom|mushroom/i, 70],
  [/potato/i, 105],
  [/pepper/i, 125],
  [/cabbage/i, 95],
  [/mixed veg|roasted vegetable|mixed .*vegetable/i, 100],
];

export function isSeparate(name: string): boolean {
  const n = (name || "").toLowerCase();
  if (/oil/.test(n)) return false; // Öle sind nie SEPARATE
  if (/tapioca|xanthan|xantana|pine ?nut|pinoli|cashew|stevia/.test(n)) return true;
  if (/sunflower|sonnenblumenkern/.test(n)) return true;
  if (/sesame|sesamsamen/.test(n) && /seed|samen/.test(n)) return true;
  if (/almond|mandel|mandorl/.test(n) && /(flour|mehl|slic|flak|lamin|blanch|geschnitten|gehobelt)/.test(n)) return true;
  if (/starch|stärke/.test(n) && /(corn|mais)/.test(n)) return true;
  if (/coconut.*sugar|sugar.*coconut|kokos.*zucker|zucker.*kokos/.test(n)) return true;
  if (/coconut.*shredded|shredded.*coconut|kokosnuss.*raspeln|raspeln.*kokosnuss/.test(n)) return true;
  if (/^\s*fa-de/.test(n) && /date paste|dattelpaste/.test(n)) return true;
  return false;
}

// "FA-DE Zest IQF, Lemon/Gewürz, Zitronenschale IQF" ist kein Spice-Room-Produkt,
// obwohl die deutsche Namenshälfte "Gewürz" enthält (Matteo 2026-07-27).
const NOT_SPICE_ROOM = /zest[^/]*lemon|lemon[^/]*zest|zitronenschale|lemon skin/i;

export function isSpiceRoom(name: string): boolean {
  if (NOT_SPICE_ROOM.test(name || "")) return false;
  return /spice|gewürz/i.test(name || "") || isSeparate(name);
}

export const READY_MADE = /roasted garlic/i; // wöchentlich fertiges Produkt — nie expandieren

export interface FactorClassification {
  rti: boolean;
  capacityKg: number | null;
  fallback?: boolean;
}

// Hauptklassifizierer, Regelreihenfolge ist Teil der Logik (erste passende Regel gewinnt).
export function classify(name: string, cookMethods: string[] = []): FactorClassification {
  const n = (name || "").toLowerCase();

  // RTI = jeder rohe "FA-DE ..."-Artikel ohne Cook Methods → kein Batch, direkt Plating.
  const noCook = !cookMethods || cookMethods.length === 0;
  const raw = /^\s*fa-de/i.test(name || "");
  if (raw && noCook) return { rti: true, capacityKg: null };

  const isMushroomSauce = /mushroom|pilz|champignon|cremini|portobello|funghi/.test(n);
  // Führendes "Sauce" ist immer eine Sauce, auch wenn der Name die Proteinart nennt.
  if (/^\s*sauce\b/.test(n)) return { rti: false, capacityKg: isMushroomSauce ? 90 : 105 };

  // Generelle Sauce-Erkennung — auch "Chicken Teriyaki Sauce" ist eine Sauce,
  // nicht Fleisch. Muss VOR den Fleisch-Regeln stehen.
  if (/sauce|salsa|ketchup|marinara|gravy|fondue|teriyaki|dressing/.test(n)) return { rti: false, capacityKg: isMushroomSauce ? 90 : 105 };

  // Fleisch/Fisch, das NIE gesplittet wird (Matteo 2026-07-08).
  if (/(shred|pulled|sfilacc)/.test(n) && /(beef|rind|chuck|pork|schwein|maiale)/.test(n)) return { rti: false, capacityKg: NO_BATCH };
  if (/burger|patty|meatball|polpett/.test(n)) return { rti: false, capacityKg: NO_BATCH };
  if (/chicken|hähnchen|pork|schwein|beef|rind|tenderloin/.test(n)) return { rti: false, capacityKg: NO_BATCH };
  if (/salmon|lachs|barramundi|shrimp|garnele/.test(n)) return { rti: false, capacityKg: NO_BATCH };

  // Übrige Proteine & Einzel-Batch-Artikel.
  const cm = (cookMethods || []).join(" ").toLowerCase();
  if (
    /fish|fisch|bacon|tofu|turkey|pute|marinade|brined/.test(n)
    || (/brine|grill|marinade/.test(cm) && /chicken|pork|beef|salmon|fish|shrimp|bacon/.test(n))
  ) return { rti: false, capacityKg: ONE_BATCH };
  if (/green onion|cipollott|scallion/.test(n)) return { rti: false, capacityKg: ONE_BATCH };
  if (/pine ?nut|pinoli|nuts?\b|pistachio|almond/.test(n) && !/flour|mehl/.test(n)) return { rti: false, capacityKg: ONE_BATCH };

  if (/rice|reis|risotto|grain|basmati|spanakopita|pilaf|couscous|quinoa/.test(n)) return { rti: false, capacityKg: 100 };
  if (/mash|stamppot|puree|purè|püree/.test(n)) return { rti: false, capacityKg: 95 };
  if (/butter/.test(n)) return { rti: false, capacityKg: 105 };
  if (/yogurt|joghurt|cheese mix|crack chicken cheese|mozzarella|parsley mix/.test(n)) return { rti: false, capacityKg: 110 };

  for (const [re, kg] of VEG) if (re.test(n)) return { rti: false, capacityKg: kg };

  return { rti: false, capacityKg: 100, fallback: true };
}

// Allergennamen kommen aus unseren CSV-Importen teils Deutsch, teils Englisch —
// Tabelle deckt beide Richtungen ab (Quelle: bot.mjs ALLERGEN_EN, Matteo 2026-07-13).
const ALLERGEN_BILINGUAL: Record<string, string> = {
  "milch (einschließlich laktose)": "Milk (incl. lactose) / Milch (einschließlich Laktose)",
  milch: "Milk (incl. lactose) / Milch (einschließlich Laktose)",
  milk: "Milk (incl. lactose) / Milch (einschließlich Laktose)",
  "schwefeldioxide und sulfite": "Sulphur dioxide & sulphites / Schwefeldioxide und Sulfite",
  erdnüsse: "Peanuts / Erdnüsse",
  peanuts: "Peanuts / Erdnüsse",
  schalenfrüchte: "Tree nuts / Schalenfrüchte",
  "tree nuts": "Tree nuts / Schalenfrüchte",
  sesamsamen: "Sesame seeds / Sesamsamen",
  "sesame seeds": "Sesame seeds / Sesamsamen",
  soja: "Soya / Soja",
  soya: "Soya / Soja",
  soy: "Soya / Soja",
  "glutenhaltiges getreide": "Cereals containing gluten / Glutenhaltiges Getreide",
  gluten: "Cereals containing gluten / Glutenhaltiges Getreide",
  weizen: "Wheat / Weizen",
  wheat: "Wheat / Weizen",
  gerste: "Barley / Gerste",
  barley: "Barley / Gerste",
  hafer: "Oats / Hafer",
  oats: "Oats / Hafer",
  roggen: "Rye / Roggen",
  rye: "Rye / Roggen",
  dinkel: "Spelt / Dinkel",
  spelt: "Spelt / Dinkel",
  mandeln: "Almonds / Mandeln",
  almonds: "Almonds / Mandeln",
  walnüsse: "Walnuts / Walnüsse",
  walnuts: "Walnuts / Walnüsse",
  kaschunüsse: "Cashew nuts / Kaschunüsse",
  "cashew nuts": "Cashew nuts / Kaschunüsse",
  pistazien: "Pistachios / Pistazien",
  pistachios: "Pistachios / Pistazien",
  sellerie: "Celery / Sellerie",
  celery: "Celery / Sellerie",
  eier: "Eggs / Eier",
  eggs: "Eggs / Eier",
  senf: "Mustard / Senf",
  mustard: "Mustard / Senf",
  haselnüsse: "Hazelnuts / Haselnüsse",
  hazelnuts: "Hazelnuts / Haselnüsse",
  fisch: "Fish / Fisch",
  fish: "Fish / Fisch",
  krebstiere: "Crustaceans / Krebstiere",
  crustaceans: "Crustaceans / Krebstiere",
  weichtiere: "Molluscs / Weichtiere",
  molluscs: "Molluscs / Weichtiere",
  lupinen: "Lupin / Lupinen",
  lupin: "Lupin / Lupinen",
  paranüsse: "Brazil nuts / Paranüsse",
  "brazil nuts": "Brazil nuts / Paranüsse",
  pekannüsse: "Pecans / Pekannüsse",
  pecans: "Pecans / Pekannüsse",
  macadamianüsse: "Macadamia nuts / Macadamianüsse",
  "macadamia nuts": "Macadamia nuts / Macadamianüsse",
};

// Bilinguale Anzeige eines Allergens (EN / DE), Fallback: unverändert anzeigen,
// falls der Wert nicht in der Übersetzungstabelle steht (nie italienisch, nie raten).
export function biAllergen(name: string): string {
  const key = (name || "").trim().toLowerCase();
  return ALLERGEN_BILINGUAL[key] ?? name;
}
