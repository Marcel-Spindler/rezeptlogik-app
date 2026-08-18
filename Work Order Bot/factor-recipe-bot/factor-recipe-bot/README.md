# Factor Recipe Bot — automazione schede di produzione (Strada B)

Genera in automatico le **schede di produzione** (batch + WO + ingredienti + istruzioni EN/DE + allergeni + RTI)
leggendo il planning (ET) di HelloFresh e le salva nel **Drive condiviso**.
Gira **da solo alle 13:00 e alle 17:00**, ogni giorno, e crea solo le schede dei **WO nuovi** (incluse le ricotture/rework).

## Come funziona (a ogni esecuzione)
1. Apre HelloFresh con la sessione salvata (login fatto una volta sola).
2. Legge i WO del giorno da ET (Export CSV).
3. Confronta con `generated-wos.json` → tiene solo i **WO nuovi** (ricette nuove + rework).
4. Per ogni gruppo nuovo: chiama le API MSKU (`bulk/pdf-export` + dettaglio di ogni sotto-ricetta) → costruisce l'HTML → **PDF**.
5. Salva il PDF nel Drive condiviso e aggiorna lo stato.

## Prerequisiti (una tantum, con l'IT se serve)
1. **Node.js 18+** installato sul PC/server che resterà acceso. (verifica: `node -v`)
2. In questa cartella: `npm install` (installa Playwright), poi `npx playwright install chromium`.
3. **Login una volta**: `node bot.mjs --login` → si apre il browser, accedi a HelloFresh (Azure AD, anche MFA), poi chiudi. La sessione resta salvata in `chrome-profile/`.
4. Imposta in `bot.mjs` (sezione CONFIG):
   - `outDir` = percorso della cartella **Drive condivisa sincronizzata** (es. `G:\\Drive condivisi\\Kitchen Recipes Workload`).
   - `distributionCenter` (default `Verden`).

## Uso
- **Test manuale:** `node bot.mjs` (genera le schede nuove di oggi nel Drive).
- **Automatico 13:00 e 17:00:** Utilità di pianificazione di Windows → nuova attività di base →
  - Trigger: giornaliero 13:00; (seconda attività) giornaliero 17:00.
  - Azione: `node` con argomento `bot.mjs`, "Esegui in" = questa cartella.
  - (Oppure `run.bat` incluso.)

## Note / da rifinire in fase di test (lunedì)
- **Rework parziali** (solo alcune sotto-ricette, ognuna con il suo target): il batch va calcolato per singola sotto-ricetta (target × peso/porzione ÷ capienza, arrotondato per eccesso). Nel codice è marcato `TODO REWORK` — da validare col caso reale.
- Le **capienze/regole** sono in `capacity-rules.js` (allineate a `../capacita_lookup.md`): aggiornabili senza toccare il resto.
- Se il token scade / login perso → rilanciare `node bot.mjs --login`.
- Nome file PDF: `<Ricetta> - Run N.pdf` nel Drive.

## Stato
Logica API + generazione PDF **già validate** (in-browser) sul piatto FV4064A.
Questo pacchetto porta la stessa logica in un servizio autonomo. **Da installare e testare** quando ci sono Node + Drive.
