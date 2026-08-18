# Factor Production Sheets — Complete Rules & Exceptions (EN)

Full English reference of **every rule, exception and known pitfall** for the Factor recipe production
sheets (`factor-recipe-bot`), as defined by Matteo Spessotto (Executive Chef, Factor EU — Verden).

**This is the English twin of `SKILL.md`** (which is written in Italian). Both describe the same rules.
When a rule changes, update **both files plus the code**, otherwise they drift apart.

| Where the rule actually lives | File |
|---|---|
| Batch capacities, RTI, SEPARATE, underlining | `capacity-rules.js` |
| Sheet layout / HTML rendering | `bot.mjs` → `buildHtml()` |
| Vegetable capacity lookup table | `../capacita_lookup.md` |
| Italian master reference | `SKILL.md` |

**Guiding principle:** exceptions surface recipe by recipe — this document grows over time.
**Units are ALWAYS kg.**

---

## 1. Batch capacities (Max Equipment Capacity)

Batches are computed as `batchCount = ceil(total_kg / capacity)` — **always rounded UP**
(e.g. 75.2 kg → 76). Then `batchQuantity = total_kg / batchCount`.

| Sub-recipe type | Capacity | Notes |
|---|---|---|
| 🚫 **NEVER batched** — shredded/pulled beef, shredded/pulled pork, burger, patty, meatball, chicken (breast/thighs/chunks), pork tenderloin, salmon, barramundi, shrimp | **no batching** (always "1", single total quantity) | Confirmed 2026-07-08. Splitting these by equipment capacity misrepresented real production — the sheet showed "1 batch" when the real total needed 2+. Always show the total quantity only. Supersedes the old 100 kg shredded beef/pork cap (2026-07-04) and the 1000 kg cap for chicken/fish. |
| 🍗 Other proteins/fish not listed above (bacon, tofu, turkey, generic fish, marinades, brined) | **1000 kg** = a single batch | The Spice Room picks only once |
| 🍄 **Mushroom sauces** (mushroom cream sauce etc.) | **90 kg** | Added 2026-07-24. More specific than generic sauces — evaluated first |
| 🥣 Other hot sauces (sauce, salsa, ketchup, marinara, gravy, fondue, teriyaki, dressing) | **105 kg** | Braiser |
| 🫘 Green beans | **65 kg** | |
| 🥗 Mixed roasted vegetables | **100 kg** | |
| 🥒 Zucchini / courgette (half-moon, diced, noodles) | **80 kg** | |
| 🥔 Mash / purée / stamppot | **95 kg** | |
| 🍚 Rice / grains (rice, risotto, pilaf, couscous, quinoa) | **100 kg** | Middle-Kitchen |
| 🧈 Compound butter (herb-parmesan butter…) | **105 kg** | Verimixer — **NOT RTI** even though it contains cheese |
| 🧀 Cheese mix / mozzarella mix / yogurt (planetary mixer) | **110 kg** | **NOT RTI** |
| 🌽 Edamame | **100 kg** | Matteo override (Bible entry was empty) |
| 🥕 Other vegetables (Veggie-Debox, "Wanne" value used as kg) | see below | carrot coin 105 · broccoli 65 · cauliflower 90 · cherry tomatoes 150 · mushroom 70 · potato 105 · pepper 125 · cabbage 95 · corn 90 |
| ❓ Unmapped vegetable/other | **100 kg** (fallback) | Logged as a fallback so it can be mapped properly later |

Full vegetable detail: `../capacita_lookup.md` §2.

### 1.1 ⚠️ Rule evaluation ORDER matters

`classify()` returns on the **first** matching rule, so the order is part of the logic. Changing the
order changes the output. Current order:

1. **RTI** — raw `FA-DE …` article with empty Cook Methods (see §2)
2. **Leading "Sauce"** — a sub-recipe whose name *starts with* "Sauce" is a sauce, **even if it names
   the protein it accompanies**. Added 2026-07-24 because *"Sauce - mushroom cream sauce - Chicken in
   creamy mushroom sauce"* and *"Sauce for Beef Stroganoff"* were matching the meat rules and wrongly
   returning "never batch". Mushroom sauce → 90 kg, other sauces → 105 kg.
   **Guard:** only a *leading* "Sauce" counts, so meat dishes cooked in a sauce
   (*"Pulled Beef - Beef and BBQ sauce"*, *"Ground beef … Ragu"*) still fall through to the meat rules
   and correctly stay un-batched.
3. **Meat & fish that must never be batched** (see table above)
4. **Remaining proteins / single-batch items** (generic fish, bacon, tofu, turkey, marinade, brined,
   green onions, nuts)
5. **Sauces not starting with "Sauce"** (e.g. *"Honey Mustard Sauce"*, *"Emmental Cheese Sauce"*)
6. Rice/grains → mash → butter → cheese/yogurt
7. **Vegetables** (Veggie-Debox table)
8. **Fallback** 100 kg

---

## 2. RTI — Ready-to-Eat (no batch, goes straight to plating)

**RTI = ANY purchased raw article `FA-DE …` with EMPTY Cook Methods** — ready to use, no processing,
no ingredients of its own. Examples seen so far:

- `FA-DE Cheese, Cheddar / Emmental / Parmesan / Mozzarella` (grated, sliced…)
- `FA-DE Spice, Sesame Seed, Roasted` (black and white sesame)
- `FA-DE Pork, Pulled, Sous Vide` (already-cooked sous-vide meat, no cooking step in the recipe)
- `FA-DE Pasta, Whole Wheat, Penne IQF`

RTI items render as **a single row with the total quantity needed**, labelled
`RTI · Ready to Eat → Plating`.

⚠️ **NOT RTI: prepared recipes** (name does NOT start with "FA-DE", or Cook Methods are non-empty).
These print in full with their own ingredients and batches:

- Herb-Parmesan Butter, Compound butter Parmesan-Chive → compound butter (105 kg)
- Cheddar Chive Mashed Potatoes → mash (95 kg)
- Mozzarella + Parsley Mix → cheese mix (110 kg)
- Parmesan Roasted Courgetti → vegetable/zucchini (80 kg)

> **Technical background (2026-07-10):** RTI requires name starts with "FA-DE" **AND** empty Cook
> Methods. Originally only cheese/sesame were matched by name; that was incidental. The MSKU
> `v2/bulk/pdf-export` endpoint **rejects any raw FA-DE article** passed as a `subRecipeId` with
> `400 "not found in Bill of Materials"`, so the rule must apply to *all* FA-DE articles without
> cooking — not just cheese/sesame. Example: "FA-DE Pork, Pulled, Sous Vide" in *Pulled Pork in Spicy
> Citrus Marinade*, W30. Practical consequence: **RTI items must be excluded from the pdf-export
> payload**, otherwise the whole call fails with 400.

---

## 3. "SEPARATE" ingredients (portioned separately at the Spice Room)

Flagged with a **`SEPARATE`** tag beside the ingredient. Source: Matteo's Google Sheet listing all
spices plus the Spice Room **DRY** category (confirmed 2026-07-16).

| Article (HelloFresh name) | Note |
|---|---|
| `FA-DE Sesame Seed / Sesamsamen` (black and white) | must contain seed/samen |
| `FA-DE Starch, Tapioca /Stärke, Tapioka` | |
| `FA-DE Gum, Xanthan /Gummi, Xanthan` | |
| `FA-DE Flour, Almond /Mehl, Mandel` | also flaked/sliced almonds |
| `FA-DE Cornstarch /Maisstärke` | |
| `FA-DE Nut, Cashew /Nuss, Cashew` | |
| `FA-DE Sunflower Seeds /Sonnenblumenkerne` | |
| `FA-DE Sugar, Coconut /Zucker, Kokosnuss` | ⚠️ EN/DE word order is reversed — the regex must cover both orders |
| `FA-DE Coconut, Dried Shredded /Kokosnuss, getrocknete Raspeln` | dried shredded coconut |
| `FA-DE Stevia Sweetener / Stevia-Süßstoff` | |
| **`FA-DE Date Paste/Dattelpaste`** | ➕ **added 2026-07-27.** Raw `FA-DE` article **only** — see the scoping note below |
| Pine nuts (pinoli) | |
| **The SALT in a BRINE** | always SEPARATE — it is portioned separately for the brine |

⚠️ **Oils are NEVER separate** — even "sesame oil" or "coconut oil". The `oil` exclusion takes
priority over every rule above.

⚠️ **Date paste scoping (2026-07-27):** the rule only matches the **raw `FA-DE` article**. A prepared
sub-recipe that merely *contains* date paste in its name (e.g. **`Date Paste Vinaigrette`**) does
**not** get the tag — it is a manufactured sub-recipe with its own WO and ingredients, it is not
portioned at the Spice Room. It expands normally, and the SEPARATE tag then appears on the raw
`FA-DE Date Paste` inside it. Same distinction as the RTI rule in §2.
Also note **`FA-DE Dates diced 5-7mm /gehackte Datteln 5-7mm` is not date paste** → no tag.

Implemented in `capacity-rules.js` → `isSeparate()`. When a new DRY product appears, add it there
using the same EN+DE keyword approach (watch for reversed word order between languages).

---

## 4. Underlining (spices & SEPARATE)

Every ingredient with **"spice / gewürz"** in its name, plus every **SEPARATE** item, is
**underlined** — both the **name** and the **quantities**.

### 4.1 ⚠️ Exception — do NOT underline (added 2026-07-27)

**`FA-DE Zest IQF, Lemon/Gewürz, Zitronenschale IQF`** (**lemon skin IQF**) is not a Spice Room
product and must **never** be underlined — even though the German half of its name reads "Gewürz",
which is what was matching it.

The exception is deliberately **narrow**, so the real lemon spices stay underlined:

| Article | Underlined? |
|---|---|
| `FA-DE Zest IQF, Lemon/Gewürz, Zitronenschale IQF` | ❌ no |
| `FA-DE Spice, Lemon Powder /Gewürz, Zitronenpulver` | ✅ yes |
| `FA-DE Spice, Lemongrass Powder /Gewürz, Zitronengraspulver` | ✅ yes |

Implemented as the `NOT_SPICE_ROOM` constant in `capacity-rules.js`, checked **before** the
`spice|gewürz` match inside `isSpiceRoom()`. Add further non-spice "Gewürz" articles there.

> **General lesson:** HelloFresh uses "Gewürz" as a *category prefix* in the German half of a name,
> including for zests and peels. So a `gewürz` match can catch things that are not spices. When an
> item is wrongly underlined, fix it in `NOT_SPICE_ROOM` — do **not** widen `isSeparate`.

### 4.2 Ordering (added 2026-07-16)

Underlined ingredients are **always listed first** in the ingredient table — spice/SEPARATE items on
top, everything else after. **Stable sort:** original relative order is preserved inside each group.

Reason: whoever portions spices/SEPARATE finds them immediately at the top, without scanning the
whole list.

Applies to: the main ingredient table of every sub-recipe, the recursive expansion of nested
sub-recipes, **and** the BRINE table (where salt also goes first). In the MARINADE section the
`↑ from BRINE` reference row always stays **last** — it is not an ingredient to portion, it is the
brined product moved as a block.

---

## 5. Ingredients that must NOT be expanded

- **Roasted Garlic / Roasted Garlic Oil** → a ready weekly product. Shown as `ready · weekly prep`,
  **never** expanded into ingredients — **at ANY nesting depth**, not only as a direct ingredient.
  *(Bug fixed 2026-07-16: the recursive expansion did not check the ready-made rule at inner levels,
  so Roasted Garlic found as an ingredient-of-an-ingredient was still being expanded.)*
- **"… - Yielded"** (e.g. `Heavy Cream- Yielded`) → **not** a sub-recipe. Show **only the quantity**
  of the product needed, no expansion.

---

## 6. Brine + Marinade

For protein recipes with both a **brine** and a **marinade** step, the card shows **two sections, in
this order**:

1. **🧂 BRINE** (first) — the brined product with its components:
   - the product (e.g. pork tenderloin), the water, and the **salt tagged SEPARATE**
   - brine instructions EN + DE
2. **MARINADE** (second):
   - the marinade ingredients (garlic, oil, spices…)
   - the brined product referenced as **`↑ from BRINE (raw protein, no water)`**
   - marinade instructions EN + DE

### 6.1 ⚠️ Definitive weight model (2026-07-24)

**All ingredient weights at every level come directly from the `manufacturingProcess` tree of the
`pdf-export` response** — which already returns real production weights — and are read recursively
via `node.manufacturingProcess.paths[].kitchenStations[].billOfMaterials[]`. Each `totalAmount` is
used **as-is**.

> **NEVER apply proportional scaling or fractions to weights.**

This single change fixed two bugs at once:

1. **Raw vs cooked meat** (flagged by Matteo 2026-07-24): proportional scaling of the v4 BOM forced
   raw = cooked. Raw now correctly comes out **higher** than cooked — e.g. ragù: raw ground beef
   368 kg → cooked 262 kg.
2. **Halved brine**: the `X - BRINED` node has children with real weights (salt, water, raw protein).
   Protein weight = sum of children **excluding water and salt** = the real raw meat weight (e.g.
   pork tenderloin 230 kg), taken directly. No more "fraction of the combined weight", which was
   halving it.

The v4 detail endpoint is still called, but **only to read EN/DE instructions** per sub-recipe — never
for weights.

<details><summary>Superseded historical rules (kept for context)</summary>

**2026-07-21** — Matteo reported brine meat quantities appearing halved (243.55 kg shown instead of
the real 487.1 kg): *"it looks like it divides it by 2, that's not right"*. The fix at the time made
the brine meat row use `brinedIng.g` directly, with water and salt scaled proportionally. Now
superseded by the tree model above.

**2026-07-16** — Assumed `brinedIng.g` was a combined water+protein total from which the protein
fraction had to be extracted. This was wrong and caused the double-halving. Superseded.

</details>

---

## 7. Nested sub-recipes (recursive expansion)

Sub-recipes are expanded **in depth, at every level**, with quantities — not just the first level.

Example (Beef Burger Master EU):

```
Burger Patty
 ├ Beef Ground
 ├ Cooked Burger Veggies → onion, garlic, oil, spices, salt
 └ Burger Stock → water, chicken stock, salt
```

**Detection rule:** an entry is an **expandable sub-recipe** if its name does **NOT** start with
"FA-DE". `FA-DE …` entries are raw ingredients (leaf nodes).

---

## 8. Print sheet format

- **Layout in English**; cooking instructions in **English + German** for every sub-recipe.
- **One WO per page** (for the Spice Room) — never two WOs on the same page.
- **Parent recipe reference** (name + REC code + portions + run) on every page.
- **WO number clearly visible.**
- **Batches:** `count × kg`, rounded up.
- **Weight per batch + total**; in **grams** if < 1 kg, otherwise in kg.
- **Oven setup name highlighted** in yellow — the text found in quotes in the English instructions
  (e.g. `Roast per "pork tenderloin" Oven Setting` → highlights `pork tenderloin`).
- **RTI** rows with the required quantity highlighted.
- **NO plating instructions.**
- **Large type** (base 14 px, recipe title 19 px — raised from 12/16 px on 2026-07-08) so it stays
  readable on the production line.
- Compact cards: no orphan rows spilling onto another page, rows never split in half.

### 8.1 Allergens

- **Bilingual EN + DE, NEVER Italian** — e.g. `Milk (incl. lactose) / Milch (einschließlich Laktose)`.
  The HelloFresh API returns German only; translation table is `ALLERGEN_EN` / `biAllergen()` in
  `bot.mjs`.
- **CONTAINS only** (🔴): underlined, bold, bright red — clearly marked but in a **compact font**
  (not huge; adjusted 2026-07-13 after Matteo's "smaller type" feedback).
- **TRACES is no longer shown** (removed 2026-07-13): not relevant for the kitchen, only CONTAINS
  matters.
- **No fallback to the parent recipe** (fixed 2026-07-13). The API *always* returns computed
  `allergenData` for every sub-recipe — an empty array means "verified: zero allergens in this batch",
  not "data missing". The old fallback wrongly stuck other sub-recipes' allergens onto harmless items
  (e.g. Green Beans, Green Onions), making the data useless for organising the blast chiller by
  allergen-free batches.

---

## 9. Execution & scheduling

- **Schedule:** the bot does **not** run Saturday or Sunday. Monday–Thursday it runs at **13:00 and
  17:00**; Friday at **11:45 and 15:00** (different, earlier times).
- Every run checks **both the current week and the next week** — next week's WOs can appear in ET
  early, and must be printed immediately rather than waiting for the date.
- Each run generates sheets **only for new WOs** (state in `generated-wos.json`, deduplicated by WO
  number), including **reworks** (same recipe re-cooked with new WOs / different portions, full or
  partial), labelled Run 1, Run 2, …
- **Output:** one PDF per sheet in the shared Drive folder **`G:\Shared drives\Recipe  Bible`**
  (`CONFIG.outDir`) — Google Drive for Desktop, synced locally. Confirmed 2026-07-12 (previously the
  Desktop, now obsolete).
- **File names always in English:** `Recipes <DAY> <DD.MM.YYYY> <HHMM>.pdf` with the weekday in
  English (Monday/Tuesday/…), never Italian. Mark reworks in English too (`REWORK`).
- **Autonomous execution:** each run should use as few tokens as possible and must not ask
  clarifying questions unless there is a real blocker (expired auth, broken API). Make reasonable
  choices and document them in the final report.

### 9.1 ⚠️ Known pitfalls

**a) Late extra WO on an already-printed group (2026-07-08).** A group printed early sometimes gets
one late additional WO for a single sub-recipe, while the others stay unchanged. This is a genuine
rework: regenerate that sub-recipe's card as Run N+1, even though only 1 WO in the group is "new".

**b) Partial groups/shifts — print ONLY the sub-recipes with a new WO (2026-07-15).** A
recipe+date+shift group in ET sometimes contains rows for **only some** of the recipe's sub-recipes
(e.g. shift 2 covering 2 of 7 — the other 5 were produced in shift 1). In that case **do not** print
the full recipe card with "WO -" on untouched sub-recipes: print **exclusively** the sub-recipes that
actually have a new WO in that group/shift. Filter the `subs` list before building the HTML, keeping
only those whose resolved WO is among the group's new WOs — otherwise the sheet looks like "all the
WO numbers are missing", because the many WO-less rows drown the few real ones.

**c) The ET CSV export can silently omit collapsed rows (2026-07-21).** Rows for future days/shifts
that were never expanded in the UI may be missing from the export. On 2026-07-21 a first W31 export
had only Mon–Wed shift 1 (143 rows) and looked like "0 new WOs", while the ET summary clearly listed
active rows for Wednesday shift 2 and Thursday shift 1. Expanding them revealed **52 real new WOs**
absent from the CSV.
➡️ **Before concluding "no new WOs"**, compare the date/shift rows in the ET summary against those
present in the CSV. If the summary shows more date+shift combinations, expand the missing rows and
re-export.

**d) Chrome blocks repeated CSV exports (2026-07-27).** In the browser pipeline the **first** click on
"Export to CSV" downloads normally, but **later clicks in the same session produce no file at all** —
Chrome's "multiple automatic downloads" block for the origin. Reloading or re-navigating does not
help. The export is also generated **client-side** from data already in memory (no network request
fires on click — `fetch` and `XMLHttpRequest` hooks capture nothing), so there is no endpoint to call
instead of the button.
➡️ **Do ONE export per run** and work from that file. To re-verify later in the same run without a
new export, use this completeness check: for each date+shift row, the number of **Recipe Statuses**
badges (In Progress + Completed + In Progress With Issue) must equal the number of **distinct Recipe
IDs** for that date+shift in the CSV. If they match on every row, the CSV covers every recipe in ET.
*(Valid at recipe granularity — it will not catch a single WO added inside an already-present recipe.)*

**e) HelloFresh "menuWeek" ≠ standard ISO week number (2026-07-13).** The manual ISO week calculation
gave `2026-W29` for 13/07/2026, but the real week shown by HelloFresh was **`2026-W30`** (+1 offset;
verified: W29 showed 6–10/7, W30 showed 13–17/7).
➡️ **Never trust the computed week.** After calculating it, always open the ET page with that value
and check the displayed dates match the expected days; if not, retry with week ±1 until they line up.
Reliable alternative: open ET (it opens on the current week), click "Export to CSV" and read the real
week from the downloaded file name (`KET-Verden-YYYY-Www.csv`).

**f) `javascript_tool` does not await async IIFEs** (returns `{}`). Use a **synchronous
`XMLHttpRequest`**, or store results on `window` and read them back in a following synchronous call.

---

## 10. Per-recipe exceptions (growing list)

| Recipe | Sub-recipe | Rule |
|---|---|---|
| FV4067A Honey Miso Chicken | Steamed Edamame | 100 kg (not Wanne 85) |
| *(add new ones as they surface)* | | |

---

## 11. Daily allergen list (separate automation)

A **separate** scheduled task (`factor-allergeni-giornaliero`, cron `0 6 * * 1-5`, Mon–Fri 06:00),
independent from the production sheets.

- Generates a PDF listing **ALL WOs in production that day** — the whole day plan from ET, read via
  the "Date Needed" column = today, in the current menu week. **Not** only new WOs, and **no** need
  to check next week.
- **Columns:** sub-recipe ("Sub Recipe Name"), full dish ("Recipe Name"), WO ("Work Order Number"),
  allergens, oven.
  ⚠️ **Column headers always EN/DE, never Italian:** `Sub-recipe / Rezept` | `Full dish / Komplettes
  Gericht` | `WO` | `Allergens (CONTAINS) / Allergene (ENTHÄLT)` | `Oven / Ofen`.
- **Oven column:** only for WOs whose ET "Cook Methods" contains "Oven" — shows the cooking
  setup/program name, i.e. the quoted text in the sub-recipe's English instructions. This needs **one
  extra v4 detail call** for those sub-recipes only. Non-oven rows stay light (no extra call). Empty
  or no quoted text → `—`.
- **Allergens:** same logic/style as `buildHtml`'s `algBox` — bilingual EN/DE, CONTAINS only, marked
  but compact, no TRACES, **no fallback to the parent recipe** (see §8.1).
- **Much lighter data gathering** than the production pipeline: per recipe+date group only **1 v4
  detail call + 1 v2 bulk/pdf-export call**. No recursive detail, no classify/capacity/batch logic.
  Recipe/sub-recipe/WO names come straight from the ET rows.
- **Layout:** simple table, one row per WO, grouped/sorted by full dish then ascending WO; header
  repeated on every page (`thead` `table-header-group`); no batches, no full instructions, no plating.
- **Output:** `G:\Shared drives\Recipe  Bible`, named `Allergens <DAY> <DD.MM.YYYY>.pdf` —
  **weekday in English**, never Italian.

---

## 12. Adding a new rule

When a new exception surfaces:

1. Implement it in **`capacity-rules.js`** (or `bot.mjs` for layout), matching on **EN + DE keywords**
   — watch for reversed word order between languages.
2. Check whether it belongs to the **rule order** in §1.1 (a more specific rule must be evaluated
   before a more generic one).
3. Document it in **`SKILL.md`** (Italian) **and in this file** (English).
4. If it is a capacity value, also update **`../capacita_lookup.md`**.
5. Verify against **real article names** — pull them from a previously generated HTML sheet or from
   the API, don't guess the spelling.
6. Re-test that existing items did not regress.
