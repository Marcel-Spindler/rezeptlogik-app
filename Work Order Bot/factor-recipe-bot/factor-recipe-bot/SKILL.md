# SKILL — Regole per i fogli di produzione ricette Factor

> Riferimento completo di **tutte le eccezioni e i dettagli** definiti da Matteo (Executive Chef) per l'automazione dei fogli di produzione (bot `factor-recipe-bot`).
> 🇬🇧 **Versione inglese completa: [`PRODUCTION-RULES-EN.md`](PRODUCTION-RULES-EN.md)** — stesse regole, in inglese. Quando una regola cambia aggiornare **entrambi i file + il codice**, altrimenti divergono.
> Sorgenti operative: le regole di capienza sono in `capacity-rules.js`, il layout in `bot.mjs` (`buildHtml`), la tabella capienze in `../capacita_lookup.md`.
> **Principio guida:** le eccezioni emergono ricetta per ricetta — questo file cresce nel tempo. Unità **sempre in kg**.

---

## 1. Capienze batch (Max Equipment Capacity)

Il batch si calcola come `batchCount = ceil(kg_totali / capienza)`, **sempre arrotondato per eccesso** (es. 75,2 kg → 76). `batchQuantity = kg_totali / batchCount`.

| Tipo sotto-ricetta | Capienza | Note |
|---|---|---|
| 🚫 **MAI in batch** — Shredded/pulled Beef, Shredded/pulled Pork, Burger, Meatball, Chicken (breast/thighs/chunks), Pork Tenderloin, Salmon, Barramundi, Shrimps | **nessun batch** (sempre "1", quantità totale unica) | **Eccezione confermata 08/07/2026**: la divisione in batch per capienza equipment falsava la lettura in cucina (il foglio mostrava "1 batch" quando il totale reale corrispondeva a 2+). Per queste carni/pesci si mostra sempre e solo la quantità totale, mai una divisione in batch. **Sostituisce** la regola precedente dei 100 kg per shredded beef/pork (04/07/2026) e il cap 1000 kg per pollo/pesce. |
| 🍗 Altre proteine/pesce non in lista sopra (bacon, tofu, turkey, pesce generico, marinature) | **1000 kg** = 1 solo batch | Il picking allo Spice Room si fa una volta sola |
| 🫘 Fagiolini / green beans | **65 kg** | |
| 🥗 Mixed roasted veg (verdure miste arrosto) | **100 kg** | |
| 🥒 Zucchine / courgette (mezzaluna, diced, noodles) | **80 kg** | |
| 🥔 Mash / purè / stamppot | **95 kg** | |
| 🍄 Salse ai funghi (mushroom cream sauce, ecc.) | **90 kg** | Aggiunto 2026-07-24 — regola PIÙ specifica, va valutata PRIMA delle salse generiche |
| 🥣 Salse calde (sauce, ketchup, marinara, gravy, dressing, teriyaki) | **105 kg** | Braiser |
| 🍚 Riso / grani (rice, risotto, pilaf, couscous, quinoa) | **100 kg** | Middle-Kitchen |
| 🧈 Burro composto (compound butter, herb-parmesan butter…) | **105 kg** | Verimixer — **NON è RTI** anche se contiene formaggio |
| 🧀 Mix di formaggio / mozzarella mix / yogurt (planetary mixer) | **110 kg** | **NON è RTI** |
| 🌽 Edamame | **100 kg** | Override Matteo (Bible vuota) |
| 🥕 Altre verdure (Veggie-Debox, valore "Wanne" usato in kg) | vedi tabella | carrot coin 105, broccoli 65, cauliflower 90, cherry tomatoes 150, mushroom 70, potato 105, pepper 125, cabbage 95, corn 90 |
| ❓ Verdura/altro non mappato | **100 kg** (fallback) | |

Dettaglio completo verdure in `../capacita_lookup.md` §2.

---

## 2. RTI — Ready-to-Eat (nessun batch, va al plating)

**RTI = QUALSIASI articolo grezzo acquistato `FA-DE ...` con Cook Methods VUOTI** (nessuna lavorazione), pronto all'uso, con 0 ingredienti propri. Esempi visti finora:
- `FA-DE Cheese, Cheddar / Emmental / Parmesan / Mozzarella` (grattugiato, a fette…)
- `FA-DE Spice, Sesame Seed, Roasted` (sesamo nero/bianco)
- `FA-DE Pork, Pulled, Sous Vide` (carne sous-vide già pronta, senza step di cottura in ricetta)
- `FA-DE Pasta, Whole Wheat, Penne IQF`

Per gli RTI il foglio mostra **una sola riga con la quantità totale necessaria** e l'etichetta `RTI · Ready to Eat → Plating`.

⚠️ **NON sono RTI** le ricette *preparate* (nome NON inizia con "FA-DE", oppure ha Cook Methods non vuoti) — vanno stampate complete con i loro ingredienti e batch:
- Herb-Parmesan Butter, Compound butter Parmesan-Chive → burro composto (105 kg)
- Cheddar Chive Mashed Potatoes → mash (95 kg)
- Mozzarella + Parsley Mix → cheese mix (110 kg)
- Parmesan Roasted Courgetti → verdura/zucchine (80 kg)

*(Distinzione tecnica — aggiornata 10/07/2026: RTI se il nome inizia con "FA-DE" **E** il campo Cook Methods è vuoto. Prima si controllava solo cheese/sesame per nome; l'endpoint MSKU v2/bulk/pdf-export rifiuta qualunque articolo grezzo FA-DE passato come subRecipeId con errore 400 "not found in Bill of Materials", quindi la regola va applicata a TUTTI gli articoli FA-DE senza cottura, non solo formaggio/sesamo — es. "FA-DE Pork, Pulled, Sous Vide" nella ricetta Pulled Pork in Spicy Citrus Marinade, W30.)*

---

## 3. Ingredienti "SEPARATE" (manipolati a parte allo Spice Room)

Vanno segnalati con il tag **`SEPARATE`** al lato. Elenco completo (fonte: Google Sheet di Matteo con tutte le spezie + categoria **DRY** dello Spice Room, confermato 2026-07-16):

| Articolo (nome HelloFresh) | Nota |
|---|---|
| FA-DE Sesame Seed / Sesamsamen (nero e bianco) | seed/samen |
| FA-DE Starch, Tapioca /Stärke, Tapioka | |
| FA-DE Gum, Xanthan /Gummi, Xanthan | |
| FA-DE Flour, Almond /Mehl, Mandel | anche mandorle laminate/a scaglie |
| FA-DE Cornstarch /Maisstärke | |
| FA-DE Nut, Cashew /Nuss, Cashew | |
| FA-DE Sunflower Seeds /Sonnenblumenkerne | |
| FA-DE Sugar, Coconut /Zucker, Kokosnuss | ⚠️ ordine parole invertito EN/DE — regex deve coprire entrambi gli ordini |
| FA-DE Coconut, Dried Shredded /Kokosnuss, getrocknete Raspeln | cocco disidratato a scaglie |
| FA-DE Stevia Sweetener / Stevia-Süßstoff | |
| **FA-DE Date Paste/Dattelpaste** | ➕ aggiunto 2026-07-27 (Matteo). Solo l'articolo grezzo `FA-DE`: una sotto-ricetta preparata che contiene date paste nel nome (es. *Date Paste Vinaigrette*) **non** prende il tag — viene espansa e il tag compare sull'articolo grezzo dentro di essa. ⚠️ `FA-DE Dates diced 5-7mm /gehackte Datteln` NON è date paste → nessun tag |
| Pinoli (pine nuts) | |

⚠️ Gli **oli** NON sono "separate" (anche se contengono es. "sesame oil" o "coconut oil" — l'esclusione per `oil` ha priorità su tutte le regole sopra).

Implementato in `capacity-rules.js` → `isSeparate()`. Se emerge un nuovo prodotto DRY non in elenco, aggiungerlo lì con lo stesso criterio (match su parole chiave EN+DE, attenzione all'ordine delle parole).

---

## 4. Sottolineatura spezie

Tutti gli ingredienti con **"spice / gewürz"** nel nome, più gli item **SEPARATE**, vanno **sottolineati** — sia il **nome** che le **quantità**.

**⚠️ Eccezione — NON sottolineare (aggiunta 2026-07-27, Matteo):** `FA-DE Zest IQF, Lemon/Gewürz, Zitronenschale IQF` (**lemon skin IQF**) non è un prodotto dello Spice Room e **non va mai sottolineato**, nonostante la metà tedesca del nome contenga "Gewürz" (era questo a farlo matchare). L'eccezione è volutamente **stretta**: le vere spezie al limone — `FA-DE Spice, Lemon Powder /Gewürz, Zitronenpulver` e `FA-DE Spice, Lemongrass Powder /Gewürz, Zitronengraspulver` — restano sottolineate. Implementata in `capacity-rules.js` → costante `NOT_SPICE_ROOM`, controllata **prima** del match `spice|gewürz` in `isSpiceRoom()`. Se emergono altri articoli con "Gewürz" nel nome che non sono spezie, aggiungerli lì.

**Ordine (aggiunto 2026-07-16):** gli ingredienti sottolineati vanno **sempre elencati per primi** nella tabella ingredienti — prima gli spice/SEPARATE, poi tutti gli altri (ordinamento stabile: l'ordine relativo originale si mantiene dentro ciascun gruppo). Motivo: chi porziona spezie/SEPARATE le trova subito in cima, senza scorrere tutta la lista. Vale per: la tabella ingredienti principale di ogni sotto-ricetta, l'espansione ricorsiva delle sotto-ricette annidate, e la tabella BRINE. Nella sezione MARINADE la riga di riferimento "↑ from BRINE" resta sempre ultima (non è un ingrediente da porzionare, è il prodotto brinato in blocco).

---

## 5. Ingredienti da NON espandere

- **Roasted Garlic / Roasted Garlic Oil** → prodotto settimanale già pronto: mostrato come `ready · weekly prep`, **non** espanso in ingredienti — **a QUALSIASI livello di annidamento**, non solo quando è ingrediente diretto della sotto-ricetta. Bug corretto 2026-07-16: l'espansione ricorsiva (sotto-ricette annidate in profondità) non controllava la regola "ready-made" ai livelli più interni, quindi Roasted Garlic/Oil trovato come ingrediente-di-un-ingrediente veniva comunque espanso con la sua lista ingredienti. Ora la regola vale a ogni profondità.
- **"... - Yielded"** (es. `Heavy Cream- Yielded`) → **non** è una sotto-ricetta: mostrare **solo la quantità** necessaria del prodotto (es. la panna), senza espansione.

---

## 6. Brine + Marinade

Nelle ricette proteiche con un passo di **brine** e uno di **marinade**, la card mostra **due sezioni in ordine**:

1. **🧂 BRINE** (per primo) — il prodotto brinato con i suoi componenti:
   - il prodotto (es. filetto di maiale), l'acqua, e il sale
   - istruzioni del brine EN + DE
2. **MARINADE** (per secondo) — la marinatura:
   - gli ingredienti della marinade (aglio, olio, spezie…)
   - il prodotto brinato con riferimento **`↑ from BRINE`**
   - istruzioni della marinade EN + DE

⚠️ **MODELLO DEFINITIVO 2026-07-24 (sostituisce sia il 07-21 che il 07-16 qui sotto):** i pesi di TUTTI gli ingredienti a ogni livello ora arrivano **direttamente dall'albero `manufacturingProcess` della risposta pdf-export** (che calcola già i pesi reali di produzione crudo/cotto), NON più da scaling proporzionale del BOM v4. Questo ha risolto di netto **due bug insieme**:
> 1. **Carne cruda vs cotta** (segnalato da Matteo 07-24): lo scaling proporzionale forzava crudo = cotto. Ora il crudo esce correttamente MAGGIORE del cotto (es. ragù: macinato crudo 368 kg → cotto 262 kg; una sotto-ricetta "X - cooked" contiene il "FA-DE Beef" crudo col suo peso reale, superiore).
> 2. **Brine dimezzato**: il nodo "X - BRINED" nell'albero ha figli con pesi REALI (sale, acqua, proteina cruda). Il peso proteina = somma dei figli escludendo acqua e sale = peso reale della carne cruda (es. pork tenderloin 230 kg), preso direttamente — NIENTE frazione-del-combinato che dimezzava. La riga "↑ from BRINE (raw protein, no water)" mostra questa somma proteina; la tabella BRINE mostra sale (SEPARATE), acqua e proteina coi loro pesi reali. Il vecchio `scale = brinedIng.g / proteinBOM` non è più usato.
>
> In pratica: **non applicare MAI scaling/frazioni ai pesi**; leggere `node.totalAmount` così com'è dall'albero pdf-export, ricorsivamente via `node.manufacturingProcess`.

⚠️ **CORREZIONE 2026-07-21 (storico — ora inglobata nel modello ad albero 2026-07-24 sopra):** Matteo ha segnalato che le quantità di carne/pesce nel BRINE risultavano dimezzate (es. 243,55 kg mostrati invece di 487,1 kg reali) — "sembra che lo dividi in 2 ma non è corretto". La regola del 07-16 (sotto) partiva dal presupposto sbagliato che `brinedIng.g` (il peso dell'ingrediente "X - BRINED" consumato dalla marinade) fosse un totale combinato acqua+proteina da cui va estratta la sola frazione proteina — ma **`brinedIng.g` è già il peso della proteina/carne necessaria**, non un totale gonfiato dall'acqua. Applicare la frazione proteina lo dimezzava due volte. Ora: la riga "carne" nella tabella BRINE = `brinedIng.g` diretto (nessuna riduzione), acqua e sale nella tabella BRINE scalati proporzionalmente alla carne usando il rapporto proprio della ricetta brine (quindi il totale della tabella BRINE supera `brinedIng.g`, il che è corretto: acqua e sale sono input di processo aggiuntivi). La riga `↑ from BRINE` nella sezione MARINADE mostra anch'essa `brinedIng.g` diretto, senza etichetta "(net, no water)" residua. Implementato in `bot.mjs` (variabile `scale = brinedIng.g / proteinBOM`).
<details><summary>Regola precedente 2026-07-16 (superata, lasciata per storico)</summary>
Peso netto del prodotto brinato = SOLO la proteina, MAI acqua + proteina insieme. L'ingrediente "brinato" usato nella marinade (`X - BRINED`) arriva dall'API con un peso totale che include l'acqua di brine assorbita (spesso quasi il 50% del totale). Il peso che deve uscire come "prodotto netto" nella riga `↑ from BRINE` è **solo la frazione proteina** del brine (BOM del brine meno sale e acqua), **non** il peso combinato acqua+proteina. Esempio: se il brine è 1700g acqua + 1700g proteina + 15g sale e l'ingrediente brinato nella marinade pesa 248,65 kg totali, il peso netto mostrato doveva essere ~124,3 kg (solo la proteina), non 248,65 kg.
</details>

---

## 7. Sotto-ricette annidate (espansione ricorsiva)

Le sotto-ricette vanno espanse **in profondità, a ogni livello**, con le quantità — non solo il primo livello.
Esempio (Beef Burger Master EU):
```
Burger Patty
 ├ Beef Ground
 ├ Cooked Burger Veggies → cipolla, aglio, olio, spezie, sale
 └ Burger Stock → acqua, brodo di pollo, sale
```
Regola di rilevamento: una voce è una **sotto-ricetta espandibile** se il nome **NON** inizia con "FA-DE"; le voci `FA-DE ...` sono ingredienti grezzi (foglia).

---

## 8. Formato del foglio di stampa

- **Layout in inglese**; istruzioni di cottura in **inglese + tedesco** per ogni sotto-ricetta.
- **Un solo WO per pagina** (per lo Spice Room) — mai più WO sulla stessa pagina.
- **Riferimento alla ricetta-madre** (nome + codice REC + porzioni + run) su ogni pagina.
- **Numero WO** ben visibile.
- **Batch**: `numero × kg`, arrotondati per eccesso.
- **Grammatura per batch + totale**; in **grammi** se < 1 kg, in kg altrimenti.
- **Nome del setup forno evidenziato** (giallo).
- **Allergeni colorati e BILINGUE (aggiornato 2026-07-13)**: nomi allergeni sempre in **inglese + tedesco** (es. "Milk (incl. lactose) / Milch (einschließlich Laktose)") — MAI in italiano (l'API HelloFresh restituisce solo tedesco, va tradotto; tabella di traduzione in `bot.mjs` `ALLERGEN_EN`/`biAllergen()`). Solo **CONTAINS** (🔴): testo sottolineato, grassetto, rosso acceso — marcato ma con font compatto (non enorme, aggiornato 2026-07-13 dopo feedback "carattere minore"). **TRACES NON si mostra più** (rimosso su richiesta di Matteo 2026-07-13: non rilevante per la cucina, solo gli allergeni CONTAINS contano).
- **RTI** con la quantità necessaria evidenziata.
- **NIENTE istruzioni di plating**.
- **Caratteri grandi** (base 14px, titolo ricetta 19px — aumentati da 12/16px l'08/07/2026 su richiesta di Matteo) — leggibili sulla linea di produzione.
- Ricette compatte: nessuna riga orfana che sconfina su un'altra pagina (le righe non si spezzano a metà).

---

## 9. Esecuzione / scheduling

- **Aggiornato 2026-07-12:** il bot NON gira sabato né domenica. Lunedì-giovedì gira alle **13:00 e 17:00**; venerdì gira alle **11:45 e 15:00** (orari anticipati/diversi rispetto agli altri giorni). Ogni run controlla sempre **sia la settimana ISO corrente sia quella successiva** (non solo quella corrente), perché i WO della settimana dopo possono già comparire in ET in anticipo.
- Ad ogni run genera i fogli **solo per i WO nuovi** (stato in `generated-wos.json`), inclusi i **rework** (da martedì in poi: stessa ricetta ri-cotta con nuovi WO / porzioni diverse, totali o parziali), etichettati Run 1, Run 2…
- Output: **un unico PDF per run** (non uno per ricetta) contenente tutti i WO nuovi di quel run ordinati per gruppo-ricetta, salvato nella sottocartella KW di turno nella Drive condivisa **`G:\Shared drives\Recipe  Bible\KW NN\`** — Google Drive for Desktop sincronizzato in locale. Naming convention: `REWORK KW{N} {Day} {DD.MM.YYYY} {HHmm}.pdf` (per run con WO di tipo rework) o `KW{N} {Day} {DD.MM.YYYY} {HHmm}.pdf` (run iniziali). Matteo ha confermato il formato "un file per run/giorno" il 2026-08-13 (prima si creava un PDF per ricetta — superato).
- **Esecuzione autonoma:** ogni run deve usare il numero di token più efficiente possibile, senza porre domande di chiarimento che non riguardano un blocco reale (es. autenticazione scaduta, API rotta) — fare scelte ragionevoli e documentarle nel report finale.
- **Anticipo giorni futuri**: se in un run l'ET mostra già i WO di un giorno successivo (es. giovedì/venerdì), il bot li stampa subito (non aspetta la data). Conseguenza osservata (2026-07-08): a volte un gruppo già stampato in anticipo riceve **un WO aggiuntivo tardivo** per una sola sotto-ricetta (le altre restano invariate) — è un REWORK a tutti gli effetti: si rigenera l'intera card di quella sotto-ricetta con Run N+1, pur avendo solo 1 WO "nuovo" nel gruppo.
- **⚠️ Gruppi/turni parziali — stampare SOLO le sotto-ricette con WO nuovo (scoperto 2026-07-15):** un gruppo ricetta+data+turno nell'ET a volte contiene righe per **solo alcune** delle sotto-ricette della ricetta (es. turno 2 di un giorno con solo 2 sotto-ricette su 7 — le altre 5 sono coperte dal turno 1 e non hanno bisogno di altra produzione). In questi casi **NON** si stampa la card completa della ricetta (tutte le sotto-ricette, con "WO -" per quelle senza WO in questo turno) — si stampano **esclusivamente** le sotto-ricette che hanno un WO realmente nuovo in quel gruppo/turno, esattamente come per un rework parziale. Il bot deve filtrare l'elenco `subs` tenendo solo quelle il cui WO risolto è presente tra i WO nuovi di quel gruppo, prima di generare l'HTML — altrimenti il foglio appare con "mancano tutti i numeri WO" (la maggioranza delle righe senza WO affoga le poche con WO reale).
- **⚠️ ATTENZIONE (scoperto 2026-07-21): l'Export to CSV dell'ET può NON includere righe di giorni/turni futuri se quelle righe non sono mai state espanse nella UI.** Il 21/07/2026 un primo export CSV per W31 conteneva solo Mon-Wed shift1 (143 righe) e risultava "0 WO nuovi", ma il riepilogo in alto della pagina ET mostrava chiaramente righe attive anche per "Wednesday shift 2" e "Thursday shift 1" (con Recipe Statuses tipo "8 In Progress"). Cliccando la freccina di espansione su quelle righe collassate sono comparsi 52 WO reali (nuovi) non presenti nel CSV. **Prima di concludere "nessun WO nuovo"**, confrontare il numero di righe data/turno mostrate nel riepilogo ET con quelle effettivamente presenti nel CSV esportato; se il riepilogo mostra più combinazioni data+turno di quelle nel CSV, espandere manualmente le righe mancanti (click sulla freccia) e ri-esportare/rileggere prima di dare per buono il conteggio.
- **⚠️ Chrome blocca gli export CSV ripetuti (scoperto 2026-07-27):** nella pipeline via browser (MCP claude-in-chrome) il primo click su "Export to CSV" scarica regolarmente, ma **i click successivi nella stessa sessione non producono più alcun file** — è il blocco Chrome "multiple automatic downloads" per origine. Non si risolve né ricaricando la pagina né rinavigando. Inoltre l'export è generato **client-side** dai dati già in memoria (nessuna richiesta di rete al click: hook su `fetch` e `XMLHttpRequest` non catturano nulla), quindi non esiste un endpoint da richiamare al posto del pulsante. **Conseguenza operativa:** fare **UN SOLO export per run** e lavorare su quel file. Se serve ri-verificare lo stato più tardi nello stesso run, usare come controllo di completezza il confronto tra il riepilogo ET a video e il CSV: per ogni riga data+turno il numero di **Recipe Statuses** (somma dei badge: In Progress + Completed + In Progress With Issue) deve corrispondere al numero di **Recipe ID distinti** di quella data+turno nel CSV. Se coincidono su tutte le righe, il CSV copre tutte le ricette in ET (verifica valida a livello di ricetta; non intercetta un singolo WO aggiunto dentro una ricetta già presente).
- **⚠️ ATTENZIONE (scoperto 2026-07-13): il "menuWeek" di HelloFresh NON coincide col numero di settimana ISO standard.** Il calcolo ISO week "da manuale" (formula `isoWeek()` in bot.mjs) dava "2026-W29" per oggi 13/07/2026, ma la settimana reale mostrata da HelloFresh per quella data è **"2026-W30"** (verificato aprendo l'ET con entrambi i valori: W29 mostrava 6-10/7, W30 mostrava 13-17/7 — offset di +1). NON fidarsi mai del calcolo puro: dopo aver calcolato la settimana, aprire SEMPRE la pagina ET con quel valore e controllare che le date mostrate corrispondano davvero a oggi/ai giorni attesi; se non corrispondono, riprovare con week±1 finché le date combaciano.

---

## 9bis. ⚠️ Target Portions per-sub, non per-gruppo (bug scoperto 2026-07-28)

**Un gruppo ricetta+data(+turno) può contenere WO con "Target Portions" DIVERSI tra loro** — non è detto che tutte le sotto-ricette dello stesso turno condividano lo stesso target. Caso reale, W32 2026-07-29 turno 2, REC-030480-4-001 (Cheddar & Red Pepper Chicken Thigh Pasta):
- WO 32-201 (Low Fat Red Pepper Fondue): Target Portions = **1200**
- WO 32-202 (Shredded Chicken Thighs - Mod Marinade #3): Target Portions = **280**

Sono due top-up parziali indipendenti nello stesso turno, non la stessa produzione. Il bot (sia `bot.mjs` che la pipeline via browser) prima prendeva `Math.max()` dei target portions su tutte le righe del gruppo e passava quel valore unico a `bulk/pdf-export` per **tutte** le sotto-ricette del gruppo — così facendo il WO 32-202 riceveva 1200 invece di 280, con pesi ingredienti gonfiati ~4,3×. **Segnalato da Matteo il 2026-07-29: "il WO 202 le porzioni non erano quelle corrette".**

**Fix (2026-07-28):** raggruppare per **(recCode, date, target)** invece di solo (recCode, date) — ogni valore di target distinto nello stesso recCode+data diventa una chiamata `bulk/pdf-export` separata (con il proprio `portions`), poi le sotto-ricette risultanti si uniscono in un'unica card-set per quel recCode+data, sempre sotto un unico Run N (è un solo evento di produzione in cucina, solo con quantità diverse per sotto-ricetta). Implementato in `bot.mjs` (raggruppamento `groups[key].variants[vkey]`) — replicare la stessa logica nella pipeline via browser (`window.gatherAndDownload`/`gatherAndDownloadMulti`).

**⚠️ Controllare SEMPRE, prima di stampare, se le righe di uno stesso gruppo recCode+data hanno "Target Portions" diversi tra loro** (confronto diretto sulle righe CSV) — se sì, NON usare un target unico per tutto il gruppo.

## 10. Eccezioni per ricetta (elenco che cresce)

| Ricetta | Sotto-ricetta | Regola |
|---|---|---|
| FV4067A Honey Miso Chicken | Steamed Edamame | 100 kg (non Wanne 85) |
| *(aggiungere man mano che emergono)* | | |

> Quando emerge una nuova eccezione: aggiungila qui **e** nella regola corrispondente in `capacity-rules.js` / `../capacita_lookup.md`.

---

## 11. Lista giornaliera allergeni (WO del giorno)

**Aggiunta 2026-07-12** — automazione separata da quella dei fogli di produzione, task schedulato dedicato Lun-Ven alle 6:00 (niente sab/dom).

- Genera un PDF con la lista di **TUTTI i WO in produzione quel giorno** (l'intero piano del giorno preso da ET, letto tramite la colonna "Date Needed" = data odierna nella menu week ISO corrente — NON solo i WO nuovi, e NON serve controllare la settimana successiva).
- Colonne richieste (dati): sotto-ricetta (colonna "Sub Recipe Name" della ET), ricetta madre/pietanza completa (colonna "Recipe Name"), WO (colonna "Work Order Number"), allergeni, forno (aggiunta 2026-07-14, vedi sotto). **⚠️ Intestazioni delle colonne nel PDF SEMPRE in inglese/tedesco, MAI in italiano (corretto 2026-07-15):** "Sub-recipe / Rezept" | "Full dish / Komplettes Gericht" | "WO" | "Allergens (CONTAINS) / Allergene (ENTHÄLT)" | "Oven / Ofen".
- **Colonna "Forno":** SOLO per i WO la cui colonna "Cook Methods" (ET) contiene "Oven" — mostra il **nome del programma/setup di cottura**, cioè il testo tra virgolette trovato nelle istruzioni inglesi della sotto-ricetta (stesso meccanismo di evidenziazione giallo `.setup` di `buildHtml` in bot.mjs, es. "Roast per "pork tenderloin" Oven Setting" → mostra `pork tenderloin`). Per ottenerlo serve **una chiamata v4 detail aggiuntiva** SOLO per queste sotto-ricette (per leggerne `instructions` EN) — le altre righe (non-forno) restano leggere come prima, nessuna chiamata extra. Se il WO non va in forno, la cella resta vuota/"—". Se non si trova nessun testo tra virgolette nelle istruzioni, mostra "—".
  ⚠️ **BUG scoperto 2026-07-28: `billOfMaterials[]` della v4 `manufactured-skus/{mskuId}` detail (a livello di RICETTA) NON ha il campo `cookMethods`** (le sue chiavi sono solo `skuId,name,code,manufactured,unitAmount,totalAmount,lossPercent,status,allergenData,cookedShelfLifeFamily,billOfMaterialId,editableDetails,appliedCulinarySkuYield,portioningMethodData,mskuEachToWeight,cuppingPortioningRequired` — nessun `cookMethods`). Usare quel campo per decidere quali sotto-ricette hanno il forno dà **sempre e comunque array vuoto** → nessuna riga risulta "forno" e la colonna esce tutta "—" anche quando le istruzioni contengono chiaramente virgolette (verificato: "Extra Crispy Diced Bacon" ha `Cook on "Crispy Bacon."` nell'istruzione ma `cookMethods` è assente sul BOM). **La colonna "Cook Methods" affidabile è SOLO quella della riga ET/CSV** (per WO/sotto-ricetta) — usare quella per decidere se fare la chiamata extra di istruzioni, non un campo dell'API MSKU.
- Allergeni: stessa logica/stile di `buildHtml`'s `algBox` — **bilingue EN/DE, mai italiano** (traduzione via `ALLERGEN_EN`/`biAllergen()` in bot.mjs). Solo **CONTAINS**, marcato (sottolineato, grassetto, rosso acceso) ma con font compatto — **TRACES non si mostra** (irrilevante per la cucina). **NIENTE fallback alla ricetta madre** (corretto 2026-07-13, bug scoperto da Matteo): l'API HelloFresh restituisce SEMPRE un `allergenData` calcolato per ogni sotto-ricetta (mai nullo) — un array vuoto significa "verificato: zero allergeni in questo batch", non "dato mancante". Il vecchio fallback (`s.alg.c.length ? s.alg : rec.alg`) appiccicava agli ingredienti innocui (es. Green Beans, Green Onions) gli allergeni di altre sotto-ricette della stessa ricetta madre, rendendo il dato inutilizzabile per organizzare il blast chiller per batch senza allergeni. Ora si mostra sempre e solo `s.alg` proprio della sotto-ricetta, "—" se vuoto.
- Raccolta dati MOLTO più leggera della pipeline dei fogli di produzione: per ogni gruppo ricetta+data serve solo **1 chiamata v4 detail + 1 chiamata v2 bulk/pdf-export** (per ottenere `rec0.allergenData` e l'allergenData di ogni sotto-ricetta in `primaryPackaging.compartmentData[].billOfMaterials[]`) — NIENTE `detail()` ricorsivo, NIENTE classify()/capacità/batch. Nome ricetta/sotto-ricetta/WO si prendono direttamente dalle righe della ET (CSV), non serve fare matching fuzzy. Istruzioni EN si leggono SOLO per le sotto-ricette forno (colonna "Forno", vedi sopra) — per tutte le altre righe restano non necessarie.
- Layout: tabella semplice, una riga per WO, raggruppata/ordinata per Full dish poi per WO crescente; intestazione ripetuta su ogni pagina (thead `table-header-group`); niente batch/istruzioni per esteso/plating (solo il nome del setup forno in una colonna dedicata).
- Output: PDF in `G:\Shared drives\Recipe  Bible`, nome tipo `"Allergens <DAY> <DD.MM.YYYY>.pdf"` — **⚠️ nome file SEMPRE in inglese (corretto 2026-07-15)**: giorno della settimana in inglese (Monday/Tuesday/Wednesday/Thursday/Friday), MAI in italiano (era "Allergeni <GIORNO in italiano>"). Stessa regola per i fogli di produzione: `"Recipes <DAY> <DD.MM.YYYY> <HHMM>.pdf"`, non "Ricette <GIORNO>...".
- Task schedulato: `factor-allergeni-giornaliero` (cron `0 6 * * 1-5`), indipendente dai task dei fogli di produzione.
