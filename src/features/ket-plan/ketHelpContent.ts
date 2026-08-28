// Zweisprachige Hilfe-Inhalte für KET Plan / WO.
// Bilingual help content for KET Plan / WO.
//
// Struktur bewusst als Daten (nicht JSX): so bleibt der Text wartbar, testbar
// und an einer Stelle. Der Renderer (KetHelp.tsx) versteht ein Markdown-lite:
//   "## Titel"  → Zwischenüberschrift
//   "- Text"    → Aufzählungspunkt
//   sonst       → Absatz
// Structure is deliberately data (not JSX) so the copy stays maintainable,
// testable and in one place. The renderer (KetHelp.tsx) understands a
// markdown-lite dialect: "## " heading, "- " bullet, anything else = paragraph.

export interface HelpSection {
  id: string;
  icon: string;
  titleDe: string;
  titleEn: string;
  /** 1–2 Sätze für den Popover am Hilfe-Button. */
  shortDe: string;
  shortEn: string;
  /** Ausführlicher Text fürs Handbuch (markdown-lite, s. o.). */
  bodyDe: string[];
  bodyEn: string[];
}

export const KET_HELP_SECTIONS: HelpSection[] = [
  {
    id: "overview",
    icon: "🧭",
    titleDe: "Überblick & Workflow",
    titleEn: "Overview & workflow",
    shortDe:
      "KET Plan / WO wandelt Work Orders in druckbare Küchen-Breakdowns mit KI-Kochanweisung um. Der Ablauf hat sechs Schritte.",
    shortEn:
      "KET Plan / WO turns work orders into printable kitchen breakdowns with an AI cooking instruction. The flow has six steps.",
    bodyDe: [
      "Diese Ansicht baut aus den Work Orders (WOs) einer Produktionswoche für jede WO einen „Breakdown\": Batch-Anzahl, Equipment, Kapazität, Zutatenmengen pro Batch und gesamt, Allergene, Blast-Chiller-Zuteilung, GN-Blech-Bedarf und Portionierwerkzeug. Dazu kommt eine zweisprachige, KI-generierte Kochanweisung. Das Ergebnis wird pro WO als eine PDF-Seite gedruckt oder gespeichert.",
      "## Der Workflow in sechs Schritten",
      "- 1. Daten laden: KET-CSV aus KitchenOS hochladen (oder die App nutzt Firestore / Live-WMS als Quelle).",
      "- 2. Woche & Liste filtern: KW-Filter, Tag-Filter, Debox-Filter und Suche grenzen die WO-Liste links ein.",
      "- 3. Breakdown prüfen: WO anklicken, Batch-/Equipment-/Zutaten-Rechnung im Detail kontrollieren, bei Bedarf Equipment-Kapazität anpassen.",
      "- 4. Kochanweisungen erzeugen: für einzelne WOs, für ausgewählte Tage oder für eine Checkbox-Auswahl (KI, zweisprachig DE/EN).",
      "- 5. Drucken: Einzeldruck der ausgewählten WO oder Massendruck mehrerer WOs. Der Druck ist nur mit vollständiger Kochanweisung möglich (Notfall-Override vorhanden).",
      "- 6. Nacharbeiten: gedruckte WOs sind mit ✓ markiert; weitere Tabs (Equipment-Gesamtbedarf, Shopfloor, Frischeliste) ergänzen die Planung.",
      "## Wichtige Konvention",
      "- „KW\" in dieser App = echte ISO-Kalenderwoche + 1 (HelloFresh-Wochenzählung). Das zieht sich durch alle Filter und Datumsbereiche.",
    ],
    bodyEn: [
      "This view builds a \"breakdown\" for every work order (WO) of a production week: batch count, equipment, capacity, ingredient amounts per batch and in total, allergens, blast-chiller assignment, GN-tray demand and portioning tool. On top of that comes a bilingual, AI-generated cooking instruction. The result is printed or saved as one PDF page per WO.",
      "## The workflow in six steps",
      "- 1. Load data: upload the KET CSV from KitchenOS (or the app falls back to Firestore / live WMS as its source).",
      "- 2. Filter week & list: week filter, day filter, debox filter and search narrow the WO list on the left.",
      "- 3. Review the breakdown: click a WO, check the batch / equipment / ingredient math in detail, adjust equipment capacity if needed.",
      "- 4. Generate cooking instructions: for single WOs, for selected days, or for a checkbox selection (AI, bilingual DE/EN).",
      "- 5. Print: single print of the selected WO, or bulk print of several WOs. Printing is only possible with a complete cooking instruction (an emergency override exists).",
      "- 6. Follow-up: printed WOs are marked with ✓; further tabs (equipment total demand, shopfloor, fresh list) round out the planning.",
      "## Key convention",
      "- \"CW\" in this app = true ISO calendar week + 1 (HelloFresh week numbering). This runs through every filter and date range.",
    ],
  },
  {
    id: "data-sources",
    icon: "📥",
    titleDe: "Datenquellen",
    titleEn: "Data sources",
    shortDe:
      "Die Ansicht nutzt in dieser Reihenfolge: hochgeladene CSV → Firestore (aktuelle Woche) → Live-WMS → veraltetes Firestore.",
    shortEn:
      "The view uses, in this order: uploaded CSV → Firestore (current week) → live WMS → stale Firestore.",
    bodyDe: [
      "## Quellen-Priorität",
      "- CSV: Eine per Drag & Drop oder Klick hochgeladene KET-CSV aus KitchenOS hat immer Vorrang. Sie wird im Browser (localStorage) gespeichert und überlebt einen Reload.",
      "- Firestore: Enthält Firestore Zeilen für die aktuell gewählte KW, werden diese genutzt.",
      "- Live-WMS (Snowflake): Fallback, wenn keine CSV und kein passendes Firestore da ist. Achtung: Feldzuordnung ist hier ungeprüft — als Vorschau behandeln.",
      "- Veraltetes Firestore: Gibt es nur Firestore-Zeilen ohne die aktuelle KW, erscheint eine rote „veraltet\"-Warnung.",
      "## CSV-Format",
      "Erwartet werden u. a. die Spalten Work Order Number, Recipe Name, Date Needed, Target Portions, Kitchen Status, Staging Status, Cook Methods, Sub Recipe Name. Fehlerhafte Zeilen werden übersprungen und in der Browser-Konsole als Warnung protokolliert.",
      "## CSV entfernen",
      "Über das ×-Symbol neben dem Dateinamen wird die CSV verworfen und die App fällt auf Firestore zurück.",
    ],
    bodyEn: [
      "## Source priority",
      "- CSV: a KET CSV from KitchenOS uploaded via drag & drop or click always wins. It is stored in the browser (localStorage) and survives a reload.",
      "- Firestore: if Firestore holds rows for the currently selected CW, those are used.",
      "- Live WMS (Snowflake): fallback when there is no CSV and no matching Firestore data. Note: field mapping here is unverified — treat as a preview.",
      "- Stale Firestore: if only Firestore rows without the current CW exist, a red \"stale\" warning appears.",
      "## CSV format",
      "Expected columns include Work Order Number, Recipe Name, Date Needed, Target Portions, Kitchen Status, Staging Status, Cook Methods, Sub Recipe Name. Malformed rows are skipped and logged as a warning in the browser console.",
      "## Removing the CSV",
      "The × next to the file name discards the CSV and the app falls back to Firestore.",
    ],
  },
  {
    id: "week-filter",
    icon: "🎯",
    titleDe: "Wochenfilter (KW)",
    titleEn: "Week filter (CW)",
    shortDe:
      "Standardmäßig zeigt die Liste nur WOs der aktuellen KW. HF-Woche = ISO-Woche + 1. Folge-KW-Zeilen für Middle-Kitchen-Spezialartikel werden separat geführt.",
    shortEn:
      "By default the list shows only WOs of the current CW. HF week = ISO week + 1. Next-CW rows for middle-kitchen special items are tracked separately.",
    bodyDe: [
      "Der blaue Button oben links schaltet zwischen „Nur KW N\" und „Alle Wochen\" um. Bei aktivem Filter werden nur WOs gezeigt, deren WO-Nummer mit dem KW-Präfix beginnt; die Zahl in Klammern nennt die ausgeblendeten WOs.",
      "## KW-Konvention",
      "Die in der App genutzte KW ist die echte ISO-Kalenderwoche plus 1 (HelloFresh-Zählung). Wer eine WO-Nummer mit „35-…\" sieht, meint ISO-Woche 34. Diese Regel ist überall load-bearing — Datumsbereiche, Filter, die Folge-KW-Logik.",
      "## Folge-KW",
      "Für componentlose Solo-WOs von Middle-Kitchen-Spezialartikeln liest die App zusätzlich die Zeilen der nächsten KW ein (z. B. für die Frischeliste), ohne sie in die Hauptliste zu mischen.",
    ],
    bodyEn: [
      "The blue button at the top left toggles between \"Only CW N\" and \"All weeks\". With the filter on, only WOs whose WO number starts with the CW prefix are shown; the number in parentheses names the hidden WOs.",
      "## CW convention",
      "The CW used in the app is the true ISO calendar week plus 1 (HelloFresh counting). A WO number starting \"35-…\" refers to ISO week 34. This rule is load-bearing everywhere — date ranges, filters, the next-CW logic.",
      "## Next CW",
      "For component-less solo WOs of middle-kitchen special items the app additionally reads the next CW's rows (e.g. for the fresh list) without mixing them into the main list.",
    ],
  },
  {
    id: "wo-list",
    icon: "📋",
    titleDe: "WO-Liste, Sortierung & Filter",
    titleEn: "WO list, sorting & filters",
    shortDe:
      "Die WO-Liste links lässt sich nach Datum, Nummer, Rezept, Status, Batchen oder KG sortieren und per Tag-, Debox- und Textfilter eingrenzen.",
    shortEn:
      "The WO list on the left can be sorted by date, number, recipe, status, batches or kg and narrowed with day, debox and text filters.",
    bodyDe: [
      "## Sortierung",
      "Datum (neuester Tag oben, innerhalb des Tages nach Schicht und Name), WO-Nummer, Rezept, Kitchen-Status, Batchen absteigend, KG absteigend.",
      "## Tag-Filter",
      "Erster Klick auf einen Tag isoliert diesen Tag; weitere Klicks fügen Tage hinzu oder entfernen sie. „Alle\" hebt den Filter auf.",
      "## Debox-Filter",
      "Trennt WOs nach Protein-Debox und Veggie-Debox (gleiche Klassifizierung wie im Shopfloor-Dashboard und den Debox-Badges).",
      "## Suche",
      "Freitext über WO-Nummer, Rezeptcode, Rezeptname und Sub-Rezeptname.",
      "## Marken an der WO-Karte",
      "- ✓ (grün): WO wurde bereits gedruckt oder gespeichert (Details siehe Abschnitt „Gedruckt-Markierung\").",
      "- Batch-Chip (blau): Anzahl Batche; 📖 davor = Kapazität stammt aus der Küchenbibel (provisorisch).",
      "- ❄️-Chip: Blast-Chiller-Gruppe; ⚠ = keine Allergen-Daten, Zuteilung ungesichert.",
      "- 🔁 Run: nur bei aktivem Run-Toggle — eine Schätzung, keine WMS-Tatsache.",
    ],
    bodyEn: [
      "## Sorting",
      "Date (newest day on top, within a day by shift and name), WO number, recipe, kitchen status, batches descending, kg descending.",
      "## Day filter",
      "The first click on a day isolates that day; further clicks add or remove days. \"All\" clears the filter.",
      "## Debox filter",
      "Splits WOs into protein debox and veggie debox (same classification as the shopfloor dashboard and the debox badges).",
      "## Search",
      "Free text across WO number, recipe code, recipe name and sub-recipe name.",
      "## Marks on the WO card",
      "- ✓ (green): WO has already been printed or saved (see the \"Printed marker\" section for details).",
      "- Batch chip (blue): number of batches; a 📖 in front = capacity comes from the kitchen bible (provisional).",
      "- ❄️ chip: blast-chiller group; ⚠ = no allergen data, assignment unverified.",
      "- 🔁 Run: only with the run toggle on — an estimate, not a WMS fact.",
    ],
  },
  {
    id: "breakdown",
    icon: "🔬",
    titleDe: "Breakdown-Detail lesen",
    titleEn: "Reading the breakdown detail",
    shortDe:
      "Das Detail zeigt Ziel-Portionen, Roh-KG, Primär-Equipment mit Kapazität, Batch-Zahl, Factor-Regeln, Allergene, Blast Chiller, GN-Bleche und Portionierwerkzeug.",
    shortEn:
      "The detail shows target portions, raw kg, primary equipment with capacity, batch count, Factor rules, allergens, blast chiller, GN trays and portioning tool.",
    bodyDe: [
      "## Batche & Equipment",
      "Die Batch-Zahl ergibt sich aus Roh-KG geteilt durch die effektive Kapazität pro Batch des Primär-Equipments, aufgerundet. Ein Rest-Batch wird separat ausgewiesen. Sind mehrere Equipments beteiligt, gibt es je Equipment eine eigene Batch-Kachel.",
      "## Kapazitätsquelle",
      "Reihenfolge: manuell in der Sidebar gesetzte Kapazität → Prozess-Spezifikation → Factor-Regel → Küchenbibel-Fallback (mit 📖 markiert, provisorisch).",
      "## Factor-Produktionsregeln",
      "- RTI (Ready to Eat): geht direkt zum Plating, kein Batch.",
      "- Kein Batch (Fleisch/Fisch): wird als Gesamtmenge produziert.",
      "- Fertigprodukt: wöchentlich vorbereitet, nicht expandieren.",
      "Bei zusammengesetzten WOs werden diese Regeln pro Komponente nach deren eigenem Namen klassifiziert, nicht nach dem WO-Namen.",
      "## Weitere Blöcke",
      "- Allergene (CONTAINS): rekursiv aus dem Rezeptbaum; einzelne Zutaten tragen zusätzlich ihr eigenes Allergen-Badge.",
      "- Blast Chiller: Gruppe abhängig von den Allergenen.",
      "- GN-Bleche: kg-basiert über die Kapazitätsdichte oder stückbasiert über Tray-Specs — nie geraten; unbekannt bleibt leer.",
      "- Scoop / Portionierwerkzeug: Typ und Farbe direkt aus der Sub-Rezept-Definition.",
    ],
    bodyEn: [
      "## Batches & equipment",
      "The batch count is raw kg divided by the primary equipment's effective capacity per batch, rounded up. A remainder batch is shown separately. If several equipments are involved, each gets its own batch tile.",
      "## Capacity source",
      "Order: capacity set manually in the sidebar → process spec → Factor rule → kitchen-bible fallback (marked 📖, provisional).",
      "## Factor production rules",
      "- RTI (ready to eat): goes straight to plating, no batch.",
      "- No batch (meat/fish): produced as one total quantity.",
      "- Ready-made: prepared weekly, do not expand.",
      "For composite WOs these rules are classified per component by the component's own name, not by the WO name.",
      "## Further blocks",
      "- Allergens (CONTAINS): recursively from the recipe tree; individual ingredients additionally carry their own allergen badge.",
      "- Blast chiller: group depends on the allergens.",
      "- GN trays: kg-based via capacity density or piece-based via tray specs — never guessed; unknown stays blank.",
      "- Scoop / portioning tool: type and colour directly from the sub-recipe definition.",
    ],
  },
  {
    id: "equipment-caps",
    icon: "⚙️",
    titleDe: "Equipment-Kapazitäten",
    titleEn: "Equipment capacities",
    shortDe:
      "Im ausklappbaren Sidebar-Block lässt sich die effektive Kapazität pro Batch je Equipment ändern. Das bestimmt direkt die Batch-Zahl und wird im Browser gespeichert.",
    shortEn:
      "The collapsible sidebar block lets you change the effective capacity per batch per equipment. It drives the batch count directly and is stored in the browser.",
    bodyDe: [
      "Die eingegebenen Werte (in kg) gelten global für alle WOs und überschreiben Prozess-Spezifikation und Factor-Regel. Sie werden im localStorage gespeichert und bleiben erhalten.",
      "## Manuelle Equipment-Ausnahme je WO",
      "Im Detail einer WO ohne automatisch erkanntes Equipment kannst du Equipment und kg/Batch einmalig eintragen. Bei zusammengesetzten WOs geht das je Komponente. Eine globale Sidebar-Kapazität hat immer Vorrang vor einem manuellen Override — der Override greift nur dort, wo die Sidebar für dieses Equipment keinen Wert gesetzt hat.",
    ],
    bodyEn: [
      "The values entered (in kg) apply globally to all WOs and override the process spec and Factor rule. They are stored in localStorage and persist.",
      "## Manual per-WO equipment exception",
      "In the detail of a WO with no auto-detected equipment you can set equipment and kg/batch once. For composite WOs this works per component. A global sidebar capacity always takes precedence over a manual override — the override only applies where the sidebar has no value set for that equipment.",
    ],
  },
  {
    id: "instructions",
    icon: "🤖",
    titleDe: "Kochanweisungen (KI)",
    titleEn: "Cooking instructions (AI)",
    shortDe:
      "Kochanweisungen werden von der KI zweisprachig erzeugt — für einzelne WOs, für ausgewählte Tage oder für eine Checkbox-Auswahl. Ergebnisse werden lokal und in Firestore gecacht.",
    shortEn:
      "Cooking instructions are generated bilingually by the AI — for single WOs, for selected days or for a checkbox selection. Results are cached locally and in Firestore.",
    bodyDe: [
      "## Wo erzeugen",
      "- Einzeln: im Detail einer WO über „Erzeugen\" bzw. „Neu erzeugen\".",
      "- Tage-Auswahl: im Sidebar-Block „Kochanweisungen (KI)\" die gewünschten Tage wählen und den grünen Sammel-Button drücken.",
      "- Checkbox-Auswahl: im Tab „Alle WOs\" WOs markieren und „Anweisungen erzeugen\" in der Massendruck-Leiste.",
      "## Delta statt alles",
      "Der Sammel-Button erzeugt standardmäßig nur fehlende Anweisungen; vorhandene werden aus dem Cache übernommen. Ein separater Button erzeugt bewusst alle neu.",
      "## Cache & Backup",
      "- Lokaler Cache (localStorage): stabiler Schlüssel aus Rezeptcode + Sub-Rezeptname (+ Komponentenname). Dadurch werden Anweisungen über Wochen hinweg wiederverwendet, auch wenn die WO-Nummer wechselt.",
      "- Firestore-Backup: füllt den lokalen Cache nach einem Cache-Verlust automatisch wieder auf.",
      "## Bearbeiten & Status",
      "Jede Anweisung ist im Detail inline editierbar (EN und DE). Der Status „Review erforderlich\" markiert Anweisungen, die die KI selbst als unsicher einstuft. Fehlgeschlagene Generierungen lassen sich gesammelt erneut versuchen.",
    ],
    bodyEn: [
      "## Where to generate",
      "- Single: in a WO's detail via \"Generate\" / \"Regenerate\".",
      "- Day selection: in the sidebar block \"Cooking instructions (AI)\" pick the days and press the green bulk button.",
      "- Checkbox selection: in the \"All WOs\" tab mark WOs and press \"Generate instructions\" in the bulk-print bar.",
      "## Delta instead of all",
      "The bulk button generates only missing instructions by default; existing ones are taken from the cache. A separate button deliberately regenerates all of them.",
      "## Cache & backup",
      "- Local cache (localStorage): stable key from recipe code + sub-recipe name (+ component name). This reuses instructions across weeks even when the WO number changes.",
      "- Firestore backup: automatically refills the local cache after a cache loss.",
      "## Editing & status",
      "Every instruction is editable inline in the detail (EN and DE). The status \"needs review\" marks instructions the AI itself rates as uncertain. Failed generations can be retried in bulk.",
    ],
  },
  {
    id: "composite-wos",
    icon: "🧩",
    titleDe: "Zusammengesetzte WOs",
    titleEn: "Composite WOs",
    shortDe:
      "Manche Sub-Rezepte bestehen aus mehreren Zubereitungskomponenten auf unterschiedlichem Equipment. Jede Komponente hat eigene Batch-Rechnung und eigene Kochanweisung.",
    shortEn:
      "Some sub-recipes consist of several prep components on different equipment. Each component has its own batch math and its own cooking instruction.",
    bodyDe: [
      "Eine WO wird in Komponenten aufgeteilt, wenn das gematchte Sub-Rezept im Rezeptbaum selbst ≥ 2 Kind-Sub-Rezepte mit unterschiedlichen Cook Methods hat (z. B. „Ground Beef - cooked\" [Braiser] + „Vegetable Mix\" [Ofen]).",
      "- Jede Komponente rechnet mit ihrer eigenen Menge, nicht mit der kombinierten Gesamtmenge.",
      "- Jede Komponente braucht eine eigene, unabhängig generierte Kochanweisung.",
      "- Im Druck erscheint je Komponente ein eigener Abschnitt mit eigenem Equipment, eigener Zutatenliste und eigener Anweisung.",
      "## Für das Druck-Gate",
      "Eine zusammengesetzte WO gilt nur dann als druckbar, wenn ALLE ihre Komponenten eine Kochanweisung haben. Der Badge „Anweisung 2/3\" zeigt, wie viele fehlen; die Fehlliste nennt die konkrete Komponente.",
    ],
    bodyEn: [
      "A WO is split into components when the matched sub-recipe itself has ≥ 2 child sub-recipes with different cook methods in the recipe tree (e.g. \"Ground Beef - cooked\" [braiser] + \"Vegetable Mix\" [oven]).",
      "- Each component uses its own quantity, not the combined total.",
      "- Each component needs its own, independently generated cooking instruction.",
      "- In print, each component gets its own section with its own equipment, ingredient list and instruction.",
      "## For the print gate",
      "A composite WO counts as printable only when ALL of its components have a cooking instruction. The badge \"instruction 2/3\" shows how many are missing; the missing list names the specific component.",
    ],
  },
  {
    id: "printing",
    icon: "🖨️",
    titleDe: "Einzeldruck & Massendruck",
    titleEn: "Single print & bulk print",
    shortDe:
      "Einzeldruck betrifft die eine ausgewählte WO (Sidebar-Fuß oder Detail-Kopf). Massendruck betrifft mehrere WOs: „Alle sichtbaren\" in der Sidebar oder die Checkbox-Auswahl im Tab „Alle WOs\".",
    shortEn:
      "Single print concerns the one selected WO (sidebar footer or detail header). Bulk print concerns several WOs: \"all visible\" in the sidebar or the checkbox selection in the \"All WOs\" tab.",
    bodyDe: [
      "Jede WO wird als genau eine PDF-Seite gedruckt. Das Layout ist Duplex-fähig: Vorderseite = Kopf, Batche, Equipment, Anweisung; Rückseite = vollständige Zutatentabelle mit wiederholter Meal-Kennung.",
      "## Einzeldruck",
      "- „Drucken\": öffnet den Druckdialog des Browsers (Popups müssen erlaubt sein).",
      "- „Speichern\": erzeugt serverseitig eine PDF-Datei (1 WO = 1 Seite). Dateiname = WO-Nummer + KW + Mealcode + Sub-Rezept.",
      "## Massendruck",
      "- Sidebar „Alle sichtbaren WOs\": nimmt alle aktuell gefilterten WOs. Bereits gedruckte werden standardmäßig übersprungen (Häkchen zum Einschließen).",
      "- Tab „Alle WOs\": WOs einzeln oder tageweise per Checkbox markieren, dann in der Leiste oben drucken oder speichern.",
      "- Beim Speichern entsteht pro WO eine eigene PDF-Datei (sequenziell); Fortschritt und Fehler werden angezeigt.",
      "## Reihenfolge",
      "Ein gedruckter Mehrtages-Stapel ist chronologisch sortiert (ältester Tag zuerst) — wie ein Papierstapel, den die Küche der Reihe nach abarbeitet.",
    ],
    bodyEn: [
      "Every WO is printed as exactly one PDF page. The layout is duplex-capable: front = header, batches, equipment, instruction; back = full ingredient table with the meal ID repeated.",
      "## Single print",
      "- \"Print\": opens the browser print dialog (pop-ups must be allowed).",
      "- \"Save\": generates a PDF file server-side (1 WO = 1 page). File name = WO number + CW + meal code + sub-recipe.",
      "## Bulk print",
      "- Sidebar \"all visible WOs\": takes all currently filtered WOs. Already-printed ones are skipped by default (checkbox to include them).",
      "- \"All WOs\" tab: mark WOs individually or by day via checkbox, then print or save from the bar at the top.",
      "- Saving produces one PDF file per WO (sequentially); progress and errors are shown.",
      "## Order",
      "A printed multi-day stack is sorted chronologically (oldest day first) — like a paper stack the kitchen works through in order.",
    ],
  },
  {
    id: "instruction-gate",
    icon: "🚦",
    titleDe: "Anweisungs-Gate & Notfall-Override",
    titleEn: "Instruction gate & emergency override",
    shortDe:
      "Gedruckt werden kann nur, was eine vollständige Kochanweisung hat. Fehlt sie, wird angezeigt was und wo — der Rest wird trotzdem gedruckt, und im Notfall lässt sich alles erzwingen.",
    shortEn:
      "Only WOs with a complete cooking instruction can be printed. If it is missing, you are shown what and where — the rest still prints, and in an emergency everything can be forced.",
    bodyDe: [
      "## Warum",
      "Das WMS exportiert immer den kompletten Stand (neue und bereits abgearbeitete WOs gemischt). Ohne Gate landen WOs ohne Anweisung unbemerkt im Druckstapel und die Küche bekommt ein halbleeres Blatt.",
      "## Verhalten",
      "- Einzeldruck (Sidebar & Detail): „Drucken\" / „Speichern\" sind deaktiviert, solange die ausgewählte WO keine vollständige Anweisung hat. Darunter steht, was fehlt (bei zusammengesetzten WOs die konkrete Komponente), plus ein Knopf zum Erzeugen.",
      "- Massendruck: die Auswahl wird in „mit Anweisung\" und „ohne Anweisung\" geteilt. Der Hauptknopf druckt nur die vollständigen und nennt die Anzahl. Eine aufklappbare Liste zeigt jede fehlende WO mit Rezept und fehlender Komponente.",
      "- „Fehlende Anweisungen erzeugen\": erzeugt gezielt nur die fehlenden Anweisungen der Auswahl.",
      "## Notfall-Override",
      "An jeder Stelle gibt es einen weniger prominenten Knopf „Ohne Anweisung drucken\" bzw. „Trotzdem alle drucken\". Damit wird der komplette Satz gedruckt. Seiten ohne Anweisung tragen im PDF den Hinweis „⚠ Ohne Kochanweisung / Without cooking instruction\".",
    ],
    bodyEn: [
      "## Why",
      "The WMS always exports the full state (new and already-processed WOs mixed). Without the gate, WOs without an instruction end up in the print stack unnoticed and the kitchen gets a half-empty sheet.",
      "## Behaviour",
      "- Single print (sidebar & detail): \"Print\" / \"Save\" are disabled as long as the selected WO has no complete instruction. Below, it shows what is missing (for composite WOs the specific component) plus a button to generate it.",
      "- Bulk print: the selection is split into \"with instruction\" and \"without instruction\". The main button prints only the complete ones and states the count. An expandable list shows every missing WO with recipe and missing component.",
      "- \"Generate missing instructions\": generates precisely the missing instructions of the selection.",
      "## Emergency override",
      "Everywhere there is a less prominent button \"Print without instruction\" / \"Print all anyway\". It prints the full set. Pages without an instruction carry the note \"⚠ Ohne Kochanweisung / Without cooking instruction\" in the PDF.",
    ],
  },
  {
    id: "printed-marker",
    icon: "✅",
    titleDe: "Gedruckt-Markierung",
    titleEn: "Printed marker",
    shortDe:
      "Jede gedruckte oder gespeicherte WO bekommt ein ✓ mit Zeitstempel. Die Marke überlebt einen erneuten CSV-Upload und lässt sich zurücksetzen.",
    shortEn:
      "Every printed or saved WO gets a ✓ with a timestamp. The marker survives a re-upload of the CSV and can be reset.",
    bodyDe: [
      "Die Marke wird je WO-Nummer gemerkt (nicht je CSV-Zeile), damit sie einen erneuten Upload übersteht — im WMS lässt sich nur der komplette aktuelle Stand exportieren, nie nur die neuen WOs.",
      "- Im Massendruck werden bereits gedruckte WOs standardmäßig übersprungen; ein Häkchen schließt sie wieder ein.",
      "- „Alle gedruckt-Markierungen zurücksetzen\" leert den Speicher, z. B. zu Beginn einer neuen Produktionswoche.",
      "- Der Zeitstempel ist optimistisch: window.print() meldet keinen Abschluss, daher wird nach Auslösen des Drucks markiert, nicht nach Bestätigung.",
    ],
    bodyEn: [
      "The marker is remembered per WO number (not per CSV row) so it survives a re-upload — the WMS can only export the full current state, never just the new WOs.",
      "- In bulk print, already-printed WOs are skipped by default; a checkbox includes them again.",
      "- \"Reset all printed markers\" clears the store, e.g. at the start of a new production week.",
      "- The timestamp is optimistic: window.print() reports no completion, so the mark is set when the print is triggered, not on confirmation.",
    ],
  },
  {
    id: "exports",
    icon: "📊",
    titleDe: "Excel- & CSV-Export",
    titleEn: "Excel & CSV export",
    shortDe:
      "Über die Kopfleiste lassen sich die gefilterten WOs als Excel (2 Sheets: WO-Übersicht + Zutaten) oder als flache CSV exportieren.",
    shortEn:
      "The header bar exports the filtered WOs as Excel (2 sheets: WO overview + ingredients) or as a flat CSV.",
    bodyDe: [
      "- Excel-Sheet „WOs\": eine Zeile pro WO mit allen Feldern — Batche, Equipment, KG gesamt/je Batch, Factor-Werte, Allergene, Blast Chiller, Scoop, GN-Bleche, Anweisung DE/EN.",
      "- Excel-Sheet „Zutaten\": eine Zeile pro Zutat pro WO, Komponenten aufgelöst, mit KG, Stück, Yield, Allergen, SEPARATE/Spice-Room, GN-Blech-Infos.",
      "- CSV: die flache WO-Übersicht mit denselben Feldern wie Sheet 1.",
      "Der Export folgt der aktuellen Filterung/Sortierung und ist NICHT an das Druck-Gate gebunden — er darf unvollständige Anweisungen enthalten.",
    ],
    bodyEn: [
      "- Excel sheet \"WOs\": one row per WO with all fields — batches, equipment, total/per-batch kg, Factor values, allergens, blast chiller, scoop, GN trays, instruction DE/EN.",
      "- Excel sheet \"Ingredients\": one row per ingredient per WO, components resolved, with kg, pieces, yield, allergen, SEPARATE/spice room, GN-tray info.",
      "- CSV: the flat WO overview with the same fields as sheet 1.",
      "The export follows the current filtering/sorting and is NOT bound to the print gate — it may contain incomplete instructions.",
    ],
  },
  {
    id: "other-tabs",
    icon: "🗂️",
    titleDe: "Weitere Tabs",
    titleEn: "Other tabs",
    shortDe:
      "Neben „Detail\" und „Alle WOs\" gibt es Equipment (Gesamtbedarf), Shopfloor (Fortschritt) und Frischeliste.",
    shortEn:
      "Besides \"Detail\" and \"All WOs\" there are Equipment (total demand), Shopfloor (progress) and Fresh list.",
    bodyDe: [
      "- Equipment: aggregierter Ressourcenbedarf der Woche über alle WOs (Batche und Zeit je Station), inkl. Wochen-Delta.",
      "- Shopfloor: Live-Dashboard des Küchenfortschritts je WO/Komponente; Häkchen werden über Firestore synchronisiert (nur aktiv, solange der Tab offen ist).",
      "- Frischeliste: Wochenbedarf frischer Zutaten in kg, inkl. Folge-KW-Zeilen für Middle-Kitchen-Spezialartikel.",
    ],
    bodyEn: [
      "- Equipment: aggregated resource demand for the week across all WOs (batches and time per station), incl. week delta.",
      "- Shopfloor: live dashboard of kitchen progress per WO/component; checkmarks are synced via Firestore (only active while the tab is open).",
      "- Fresh list: weekly demand for fresh ingredients in kg, incl. next-CW rows for middle-kitchen special items.",
    ],
  },
  {
    id: "troubleshooting",
    icon: "🛠️",
    titleDe: "Fehlerbehebung",
    titleEn: "Troubleshooting",
    shortDe:
      "Häufige Stolpersteine: blockierte Popups beim Drucken, PDF-Server offline beim Speichern, „Rezept nicht in App-Daten\", fehlende Kapazität.",
    shortEn:
      "Common snags: blocked pop-ups when printing, PDF server offline when saving, \"recipe not in app data\", missing capacity.",
    bodyDe: [
      "- „Popup-Blocker hat das Fenster blockiert\": Popups für diese Seite erlauben, dann erneut drucken.",
      "- Fehler beim Speichern: der lokale PDF-Server (/api/local-db/generate-pdf) muss laufen. Alternativ „Drucken\" nutzen und im Dialog „Als PDF speichern\" wählen.",
      "- „Rezept nicht in App-Daten\" / „Sub-Rezept nicht gefunden\": die KG-Berechnung ist ohne Rezeptbaum nicht möglich. Prüfen, ob der Sub-Recipe-Import aktuell ist.",
      "- „Kein Equipment automatisch erkannt\": im Detail Equipment und kg/Batch manuell eintragen, sonst bleiben Batche und PDF-Rechnung unvollständig.",
      "- Anweisungen weg nach Browser-Wechsel: der lokale Cache ist geräte-/browsergebunden; das Firestore-Backup füllt ihn beim nächsten Laden wieder auf.",
    ],
    bodyEn: [
      "- \"Pop-up blocker blocked the window\": allow pop-ups for this page, then print again.",
      "- Error when saving: the local PDF server (/api/local-db/generate-pdf) must be running. Alternatively use \"Print\" and choose \"Save as PDF\" in the dialog.",
      "- \"Recipe not in app data\" / \"sub-recipe not found\": the kg calculation is impossible without the recipe tree. Check that the sub-recipe import is up to date.",
      "- \"No equipment auto-detected\": set equipment and kg/batch manually in the detail, otherwise batches and the PDF math stay incomplete.",
      "- Instructions gone after switching browser: the local cache is device/browser-bound; the Firestore backup refills it on the next load.",
    ],
  },
];

export function getHelpSection(id: string): HelpSection | undefined {
  return KET_HELP_SECTIONS.find((s) => s.id === id);
}
