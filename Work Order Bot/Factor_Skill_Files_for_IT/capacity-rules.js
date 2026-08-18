// Capacity / routing rules — mirrors ../capacita_lookup.md (confirmed by Matteo).
// Given a sub-recipe name + its cook methods, returns the batch capacity (kg) to send to MSKU,
// whether it's RTI (Ready-to-Eat, no batch), and helper flags.
// Unit is ALWAYS kg. "1 batch" items get a very large capacity so MSKU makes a single batch.

const ONE_BATCH = 1000; // remaining proteins/fish, bacon, green onions, nuts → single batch (spice-room picks once)
const NO_BATCH = 999999; // meat/fish that must NEVER show as multi-batch (Matteo 2026-07-08) — see classify()

// Veggie-Debox capacities (kg — from the VEGGIE Bible "Wanne" values, used as kg).
const VEG = [
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

// non-spice-named items that are still handled in Spice Room and must be kept SEPARATE
// Full DRY-category source list (Matteo's Spice Room Google Sheet, 2026-07-16):
// FA-DE Stevia Sweetener / Stevia-Süßstoff, FA-DE Cornstarch /Maisstärke, FA-DE Gum, Xanthan /Gummi, Xanthan,
// FA-DE Nut, Cashew /Nuss, Cashew, FA-DE Flour, Almond /Mehl, Mandel, FA-DE Sunflower Seeds /Sonnenblumenkerne,
// FA-DE Sugar, Coconut /Zucker, Kokosnuss, FA-DE Coconut, Dried Shredded/Kokosnuss, getrocknete Raspeln,
// FA-DE Starch, Tapioca /Stärke, Tapioka — every DRY item always gets the SEPARATE tag.
export function isSeparate(name) {
  const n = (name || '').toLowerCase();
  if (/oil/.test(n)) return false; // oils are not the separate seed/powder items
  if (/tapioca|xanthan|xantana|pine ?nut|pinoli|cashew|stevia/.test(n)) return true;
  if (/sunflower|sonnenblumenkern/.test(n)) return true;
  if (/sesame|sesamsamen/.test(n) && /seed|samen/.test(n)) return true;
  if (/almond|mandel|mandorl/.test(n) && /(flour|mehl|slic|flak|lamin|blanch|geschnitten|gehobelt)/.test(n)) return true;
  if (/starch|stärke/.test(n) && /(corn|mais)/.test(n)) return true;
  if (/coconut.*sugar|sugar.*coconut|kokos.*zucker|zucker.*kokos/.test(n)) return true;
  if (/coconut.*shredded|shredded.*coconut|kokosnuss.*raspeln|raspeln.*kokosnuss/.test(n)) return true;
  // "FA-DE Date Paste/Dattelpaste" (Matteo 2026-07-27). Scoped to the raw FA-DE article on purpose: a
  // prepared sub-recipe that merely CONTAINS date paste (e.g. "Date Paste Vinaigrette") is not portioned
  // at the Spice Room — it expands into its own ingredients, where the FA-DE paste gets the tag itself.
  // Same distinction as the RTI rule in SKILL.md §2. NB "FA-DE Dates diced 5-7mm" is not paste → no tag.
  if (/^\s*fa-de/.test(n) && /date paste|dattelpaste/.test(n)) return true;
  return false;
}

// Items whose name contains "Spice/Gewürz" but that are NOT spice-room products (Matteo 2026-07-27).
// "FA-DE Zest IQF, Lemon/Gewürz, Zitronenschale IQF" — lemon skin IQF must NEVER be underlined, even
// though the German half of the name reads "Gewürz". Kept deliberately narrow so the real lemon spices
// ("FA-DE Spice, Lemon Powder /Gewürz, Zitronenpulver", "Spice, Lemongrass Powder") stay underlined.
const NOT_SPICE_ROOM = /zest[^/]*lemon|lemon[^/]*zest|zitronenschale|lemon skin/i;

export function isSpiceRoom(name) {
  if (NOT_SPICE_ROOM.test(name || '')) return false; // exclusion wins over the spice/gewürz match
  return /spice|gewürz/i.test(name || '') || isSeparate(name);
}
export const READY_MADE = /roasted garlic/i; // always-ready weekly products — don't expand

// Main classifier → { rti:boolean, capacityKg:number|null, unit:'kilograms' }
export function classify(name, cookMethods = []) {
  const n = (name || '').toLowerCase();
  const cm = (cookMethods || []).join(' ').toLowerCase();

  // RTI = any raw purchased article ("FA-DE ...") with NO cook methods listed → single WO,
  // straight to plating, no equipment/batch. Generalized 2026-07-10 after MSKU v2/bulk/pdf-export
  // rejected "FA-DE Pork, Pulled, Sous Vide" as an invalid subRecipeId (400 "not found in Bill of
  // Materials") — raw FA-DE articles are never valid sub-recipe ids for that endpoint, regardless
  // of what they are (cheese, sesame, pulled pork, pasta...). Previously this only matched
  // cheese/sesame by name; that was incidental (those were the only raw+no-cook items seen so far).
  // MUST be a raw article ("FA-DE ..."), NOT a prepared recipe that merely CONTAINS cheese
  // (e.g. Herb-Parmesan Butter, Cheddar Chive Mash, Mozzarella + Parsley Mix, Parmesan Courgetti) —
  // those have their own ingredients, non-empty cook methods, and must render as full recipes.
  const noCook = !cookMethods || cookMethods.length === 0;
  const raw = /^\s*fa-de/i.test(name || '');
  if (raw && noCook) {
    return { rti: true, capacityKg: null, unit: 'kilograms' };
  }

  const isMushroomSauce = /mushroom|pilz|champignon|cremini|portobello|funghi/.test(n);
  // A sub whose NAME STARTS WITH "Sauce" is a sauce, even if it names the protein it accompanies
  // (e.g. "Sauce - mushroom cream sauce - Chicken in creamy mushroom sauce", "Sauce for Beef
  // Stroganoff"). Detect these BEFORE the meat rules so they don't get caught on "chicken"/"beef"
  // and wrongly return NO_BATCH (Matteo 2026-07-24: mushroom sauces weren't dividing into batches).
  // Guard: only the LEADING "Sauce" — so meat dishes cooked in a sauce ("Pulled Beef - Beef and BBQ
  // sauce", "Ground beef ... Ragu") still fall to the meat rules and stay NO_BATCH. Mushroom sauce
  // = 90 kg, other sauces = 105 kg.
  if (/^\s*sauce\b/.test(n)) return { rti: false, capacityKg: isMushroomSauce ? 90 : 105, unit: 'kilograms' };

  // Meat & fish that must NEVER be split into batches (Matteo 2026-07-08): the equipment-capacity
  // batch math misrepresented real production (sheet showed e.g. "1 batch" while the real total
  // needed 2) — these always render as a single batch regardless of total kg. This supersedes the
  // 100kg shredded-beef/pork cap confirmed 2026-07-04.
  if (/(shred|pulled|sfilacc)/.test(n) && /(beef|rind|chuck|pork|schwein|maiale)/.test(n)) return { rti: false, capacityKg: NO_BATCH, unit: 'kilograms' };
  if (/burger|patty|meatball|polpett/.test(n)) return { rti: false, capacityKg: NO_BATCH, unit: 'kilograms' };
  if (/chicken|hähnchen|pork|schwein|beef|rind|tenderloin/.test(n)) return { rti: false, capacityKg: NO_BATCH, unit: 'kilograms' };
  if (/salmon|lachs|barramundi|shrimp|garnele/.test(n)) return { rti: false, capacityKg: NO_BATCH, unit: 'kilograms' };

  // Remaining proteins & single-batch items (generic fish, bacon, tofu, turkey, marinade/brined)
  if (/fish|fisch|bacon|tofu|turkey|pute|marinade|brined/.test(n)
      || /brine|grill|marinade/.test(cm) && /chicken|pork|beef|salmon|fish|shrimp|bacon/.test(n)) {
    return { rti: false, capacityKg: ONE_BATCH, unit: 'kilograms' };
  }
  if (/green onion|cipollott|scallion/.test(n)) return { rti: false, capacityKg: ONE_BATCH, unit: 'kilograms' };
  if (/pine ?nut|pinoli|nuts?\b|pistachio|almond/.test(n) && !/flour|mehl/.test(n)) return { rti: false, capacityKg: ONE_BATCH, unit: 'kilograms' };

  // Sauces not starting with "Sauce" and not caught as meat above (e.g. "Honey Mustard Sauce",
  // "Emmental Cheese Sauce", a bare "Creamy Mushroom Sauce"). Mushroom sauce = 90 kg, else 105 kg.
  if (/sauce|salsa|ketchup|marinara|gravy|fondue|teriyaki|dressing/.test(n)) return { rti: false, capacityKg: isMushroomSauce ? 90 : 105, unit: 'kilograms' };
  // Rice / grains → Middle-Kitchen 100
  if (/rice|reis|risotto|grain|basmati|spanakopita|pilaf|couscous|quinoa/.test(n)) return { rti: false, capacityKg: 100, unit: 'kilograms' };
  // Mash / stamppot → 95
  if (/mash|stamppot|puree|purè|püree/.test(n)) return { rti: false, capacityKg: 95, unit: 'kilograms' };
  // Compound butter → Middle-Kitchen Verimixer (butter) 105
  if (/butter/.test(n)) return { rti: false, capacityKg: 105, unit: 'kilograms' };
  // Cheese/yogurt at planetary mixer → 110 (incl. mozzarella / cheese mixes)
  if (/yogurt|joghurt|cheese mix|crack chicken cheese|mozzarella|parsley mix/.test(n)) return { rti: false, capacityKg: 110, unit: 'kilograms' };

  // Vegetables → Veggie-Debox specific value
  for (const [re, kg] of VEG) if (re.test(n)) return { rti: false, capacityKg: kg, unit: 'kilograms' };

  // Fallback: generic veg/other → 100 kg (flag in log)
  return { rti: false, capacityKg: 100, unit: 'kilograms', fallback: true };
}
