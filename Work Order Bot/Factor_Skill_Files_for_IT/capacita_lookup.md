# Tabella di lookup capienze (batch) — Factor Kitchen

> Estratta dalle Bible (`Bibles_K_Operations_Manager_Supervisors.xlsx`, provvisorie) + regole confermate da Matteo.
> Usata dall'automazione per proporre la **Max Equipment Capacity** in MSKU. Le Bible sono provvisorie: dove Matteo ha un valore diverso, **vince il valore di Matteo** (vedi _Eccezioni_).

## 0. Valori confermati da Matteo (2026-07-04) — PREVALGONO

- **"1 solo batch" = 1000 kg** → proteine (pollo, salmone, gambero, maiale, manzo, carni sfilacciate), **bacon**, **cipollotti verdi/green onions**, **frutta secca** (pistacchi, pinoli). Tutto ciò che non si divide in batch (picking una volta sola).
- **Fagiolini / green beans → 65 kg**
- **Mixed roasted veg (verdure miste arrosto) → 100 kg**
- **Zucchine (mezzaluna/diced) → 80 kg**
- **Mash / stamppot → 95 kg**
- **Shredded / pulled BEEF e PORK → 100 kg** (Middle-Kitchen Varimixer; conferma dalla ricetta "50 kg per batch"→ Matteo usa 100 kg)
- **Planetary Mixer (Middle-Kitchen) → 110 kg** → salse-formaggio (es. Crack Chicken Cheese Mix) e **yogurt** (es. Cumin Coriander Yogurt).
- Unità: **sempre kg**.

> ⚠️ Da riportare anche nelle Bible ufficiali (Google Sheet) quando l'accesso al Drive sarà disponibile.

## 1. Regola di routing (per tipo di sotto-ricetta)

| Tipo sotto-ricetta | Stazione | Capienza da usare |
|---|---|---|
| 🥕 Verdura | Veggie-Debox | **Wanne (L)** della verdura (tab. 2) |
| 🍗 Proteina, bacon, cipollotti, frutta secca | Protein-Debox / — | **1000 kg → 1 batch** |
| 🍚 Riso / grani | Middle-Kitchen | **100 kg** |
| 🍄 Salsa ai funghi (mushroom cream sauce…) | Braiser | **90 kg** (Matteo 2026-07-24; prima delle salse generiche) |
| 🥣 Salsa calda | Braiser | **105 kg** |
| 🥛 Salsa-formaggio / yogurt (Planetary Mixer) | Middle-Kitchen | **110 kg** |
| 🥔 Mash / purè / stamppot | Braiser/Middle-K. | **95 kg** |
| 🍖 Macinata / sfilacciata | Braiser / Middle-K. | 72 / 50 kg |
| 🧂 Spezia / ingrediente freddo non cotto | Spice Room | **SALTATA** (nessun batch in MSKU) |

⚠️ **Le eccezioni emergono ricetta per ricetta** → l'automazione mostra SEMPRE una tabella di verifica prima di scrivere. Le eccezioni ricorrenti vanno in _Eccezioni_ (sez. 5).

## 2. Veggie-Debox — Wanne (L) per verdura

| Verdura | Wanne (L) |
|---|---|
| Fresh & Trimmed Green Bean | 75 |
| Fresh & Trimmed Green Beans No Spices | 120 |
| IQF Green Beans | 95 |
| 1-1/2 Cut Green Beans | 105 |
| Broccoli Florets | 65 |
| IQF Broccoli Florets | 90 |
| IQF Cauliflower Florets | 90 |
| Mixed 5mm Diced Vegetables | 135 |
| Mixed 10mm Diced Vegetables | 125 |
| Eggs | 270 |
| Sauces | 270 |
| Shredded Brussel Sprouts | 60 |
| Zucchini Noodles | 70 |
| Diced Broccoli | 115 |
| Diced Cauliflower | 115 |
| Halve Brussel Sprouts | 60 |
| Cherry Tomatoes | 150 |
| 10mm Diced Zucchini | 135 |
| 10mm Coin Cut Carrot | 105 |
| 5mm Coin Cut Carrot | 110 |
| Cauliflower Florets | 90 |
| 10mm Diced Cabbage | 95 |
| Corn Kernels | 90 |
| Sliced Cremini Mushrooms | 70 |
| Sliced Button Mushrooms | 70 |
| Sliced Portobello Mushrooms | 65 |
| Cauliflower Rice | 90 |
| 10mm Diced Russet Potatoes | 105 |
| 10mm Diced Yukon Potatoes | 105 |
| 10mm Diced Sweet Potatoes | 125 |
| 10mm Diced Pepper | 125 |
| 5mm Diced Russet Potatoes | 115 |
| 5mm Diced Yukon Potatoes | 115 |
| 5mm Sliced Russet Potatoes | 95 |
| Edamame Mixed Vegetable | 85 |
| Edamame | **100 kg** (override Matteo) |
| 5mm Shredded Cabbage | 70 |
| Artichoke Quartered | 95 |
| 5-Spice Smoked Tofu | 135 |
| 5mm Sliced Peppers | 110 |
| Wedges Potatoes | 90 |
| Oven Nuts / Spinach / Leek / Basil / Scallion / Roasted Garlic | (n/d — verificare) |

## 3. Braiser — MAX RAW (kg) per categoria

| Categoria | kg |
|---|---|
| Sauces (Bible) | 100 · _salsa calda Matteo = **105**_ |
| Ground proteins (beef/turkey/chorizo/pork) | 72 |
| Risottos | 100 |
| Mashes (celery root / sweet potato / cauliflower) | 90 |
| Sauteed caramelized onions | 68 |
| Braised mushrooms | 68 |
| Chilis (sloppy joes / turkey / chorizo) | 100 |

## 4. Middle-Kitchen — MAX CAPACITY (kg)

| Macchina · prodotto | kg |
|---|---|
| Verimixer · Butter / Ground Meat / Cream Cheese | 105 |
| Verimixer · Mash | 95 |
| Verimixer · Shredded Pork | 50 |
| Verimixer · Shredded Beef | 50 |
| Oven · IQF Corn | 149 |
| **Riso / grani (regola Matteo)** | **100** |

## 5. Protein-Debox

- Capienza fisica V-Mag 200L = **90 kg** (dato tecnico), ma in **MSKU si mette una capienza altissima → 1 solo batch** (picking Spice Room una volta sola). Vale per pollo, filetto di maiale, ecc.

## 6. Eccezioni per ricetta (elenco che cresce nel tempo)

| Ricetta | Sotto-ricetta | Regola speciale |
|---|---|---|
| FV4067A Honey Miso Chicken | Steamed Edamame | 100 kg (non Wanne 85) |
| (varie) | Burro composto (Herb-Parmesan Butter, Compound butter…) | **105 kg** (Verimixer butter). NON è RTI anche se contiene parmesan |
| (varie) | Mozzarella + Parsley Mix / cheese mix | **110 kg** (planetary mixer). NON è RTI |
| _(si aggiungono man mano che emergono)_ | | |

## 7. Regola RTI (Ready-to-Eat) — CRITICA

**RTI = SOLO articoli grezzi acquistati "FA-DE ..." pronti al piatto** (formaggio grattugiato/a fette, sesamo tostato): es. `FA-DE Cheese, Parmesan, Grated`, `FA-DE Cheese, Mozzarella, Shredded`, `FA-DE Spice, Sesame Seed, Roasted`. Hanno **0 ingredienti propri** → nessun batch, solo plating.

⚠️ **NON sono RTI** le ricette *preparate* che contengono formaggio nel nome (Herb-Parmesan Butter, Cheddar Chive Mashed Potatoes, Mozzarella + Parsley Mix, Parmesan Roasted Courgetti): hanno ingredienti propri → si stampano come ricette complete coi loro batch. (Bug corretto 2026-07-06: la vecchia regola catturava per nome qualunque "parmesan/mozzarella/cheddar" e svuotava la ricetta.)
