# Snowflake Key-Pair Auth für WMS-Endpoints (einmaliges Setup)

## Warum

`functions/index.js` fragt für die `wms*`-Endpoints (`wmsPlating`,
`wmsWorkorders`, `wmsStaging`, `wmsDebox`, `wmsPostblast`, `wmsSleeving`,
`wmsInbound`, `wmsPlatingHistory`) Snowflake bei **jedem Aufruf live** ab –
über JWT/Key-Pair-Auth (`createSnowflakeConnectionOptions()` in
`functions/index.js`). Das läuft **headless**, ganz ohne Browser-Login –
im Gegensatz zur älteren Doku in `WMS_CACHING.md`, die noch einen
SSO-Ansatz beschreibt (der Sync-Script dafür existiert nicht mehr im
Repo). Mit einem einmalig eingerichteten Snowflake-Service-User + Key
laufen die Endpoints dauerhaft automatisch, ohne dass jemand sich
einloggen oder etwas hochladen muss.

Fällt die Live-Query fehl (z. B. Netzwerkproblem), fällt der Endpoint auf
die Firestore-Collection `wmsCache` zurück – die ist aktuell leer, weil es
kein Sync-Script gibt. Das ist unkritisch, solange die Live-Query
funktioniert; nur wenn Snowflake selbst down ist, gäbe es aktuell keinen
Fallback mit Daten.

## 1) Key-Pair (bereits erledigt)

Ein RSA-2048-Schlüsselpaar liegt lokal unter:

- Private Key: `secrets/snowflake_wms_svc_key.p8` (PKCS8, unverschlüsselt — **niemals committen**, `secrets/` ist in `.gitignore`)
- Public Key: `secrets/snowflake_wms_svc_key.pub`

Public-Key-Body (für die Snowflake-SQL unten, unbedenklich zu teilen):

```
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu91QtZbjHjfNbK61VMZduU825iv4PJovhOXrCkMwIPWj333OEthKP+vjq26pTBhAZ6XTh5uRjaRVlF31fBklTyv/evx3jnROeiuH9dGY9PjducSGnMbJrbsn/cI0/tYG5B6hnynMAPHlnq9tKl2SSHVM/fdeH8kWI+RTTMZeY0ND1dDUgah6+hFm9+t569gfRXa49Qp/YtWQxp+ndf1GGYTT0uu38+vjphFxATTg5KGyWtC2MgWfgfEM3TN7TKn2IAo+VjG4vdDBcMspmvLu1g77AOuNibyJ/obwFempXEmClF3JP3GqRs866d1fAr/WbVceUzFqYvDcFsQhmN2QuQIDAQAB
```

## 2) Snowflake-Seite (braucht jemand mit Rechten für `CREATE USER` / `ALTER USER`, z. B. SECURITYADMIN — HelloFresh/Factor Data-/IT-Team)

Neuer, dedizierter Service-User (empfohlen — rührt niemandes persönlichen SSO-Zugang an):

```sql
CREATE USER IF NOT EXISTS RL_WMS_SVC
  RSA_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu91QtZbjHjfNbK61VMZduU825iv4PJovhOXrCkMwIPWj333OEthKP+vjq26pTBhAZ6XTh5uRjaRVlF31fBklTyv/evx3jnROeiuH9dGY9PjducSGnMbJrbsn/cI0/tYG5B6hnynMAPHlnq9tKl2SSHVM/fdeH8kWI+RTTMZeY0ND1dDUgah6+hFm9+t569gfRXa49Qp/YtWQxp+ndf1GGYTT0uu38+vjphFxATTg5KGyWtC2MgWfgfEM3TN7TKn2IAo+VjG4vdDBcMspmvLu1g77AOuNibyJ/obwFempXEmClF3JP3GqRs866d1fAr/WbVceUzFqYvDcFsQhmN2QuQIDAQAB'
  DEFAULT_ROLE = US_OPS_ANALYTICS_USER
  DEFAULT_WAREHOUSE = US_OPS_ANALYTICS
  MUST_CHANGE_PASSWORD = FALSE
  COMMENT = 'Rezeptlogik-App: Live-Lesezugriff für KET/PET/WMS Cloud Functions (Key-Pair Auth, kein Passwort)';

GRANT ROLE US_OPS_ANALYTICS_USER TO USER RL_WMS_SVC;
```

Falls `US_OPS_ANALYTICS_USER` noch keinen `SELECT` auf die benötigten
Objekte hat, zusätzlich (read-only, nichts weiter):

```sql
GRANT USAGE ON WAREHOUSE US_OPS_ANALYTICS TO ROLE US_OPS_ANALYTICS_USER;
GRANT USAGE ON DATABASE US_OPS_ANALYTICS TO ROLE US_OPS_ANALYTICS_USER;
GRANT USAGE ON SCHEMA US_OPS_ANALYTICS.HIGHJUMP TO ROLE US_OPS_ANALYTICS_USER;
GRANT SELECT ON TABLE US_OPS_ANALYTICS.HIGHJUMP.T_STORED_ITEM TO ROLE US_OPS_ANALYTICS_USER;
GRANT SELECT ON TABLE US_OPS_ANALYTICS.HIGHJUMP.T_TRAN_LOG TO ROLE US_OPS_ANALYTICS_USER;
GRANT SELECT ON TABLE US_OPS_ANALYTICS.HIGHJUMP.T_RECEIPT TO ROLE US_OPS_ANALYTICS_USER;
GRANT USAGE ON SCHEMA US_OPS_ANALYTICS.HIGHJUMP_ANALYTICS TO ROLE US_OPS_ANALYTICS_USER;
GRANT SELECT ON VIEW US_OPS_ANALYTICS.HIGHJUMP_ANALYTICS.V_SUBMEAL_PRODUCTION TO ROLE US_OPS_ANALYTICS_USER;
```

Falls stattdessen ein **bereits existierender** Service-User wiederverwendet
werden soll, reicht:

```sql
ALTER USER <bestehender_user> SET RSA_PUBLIC_KEY = '<Public-Key-Body oben>';
```

Danach den Account-Locator besorgen (steht z. B. in der Snowflake-URL,
Format meist `XG02811-OO69432` o. ä. — Root-`.env` hatte laut alter Doku
`SNOWFLAKE_ACCOUNT=XG02811-OO69432`, ggf. wiederverwenden).

## 3) Lokal testen

`functions/.env` anlegen (kopiert von `functions/.env.example`, gitignored) mit:

```env
SNOWFLAKE_ACCOUNT=<Account-Locator>
SNOWFLAKE_USER=RL_WMS_SVC
SNOWFLAKE_PRIVATE_KEY=<Inhalt von secrets/snowflake_wms_svc_key.p8, OHNE "-----BEGIN/END PRIVATE KEY-----" Zeilen, Zeilenumbrüche egal>
```

Dann im Emulator testen:

```bash
cd functions && npm install && npx firebase-tools emulators:start --only functions
curl "http://127.0.0.1:5001/<project-id>/europe-west3/wmsWorkorders?whId=VF&limit=5"
```

Erwartet: `"source": "snowflake-live"` mit echten Zeilen statt Fehler.

## 4) Deployen

`functions/.env` wird bei `firebase deploy --only functions`
(bzw. `npm run deploy:functions`) automatisch mit hochgeladen (Firebase
Functions v2 Dotenv-Konvention — genauso wie `GEMINI_API_KEY` etc. schon
heute gehandhabt werden). Kein zusätzlicher `secrets:`-Code nötig.

## 5) Danach

Sobald das läuft, können `KetBreakdownView.tsx` / `PetPlanView.tsx` von
CSV-Upload auf diese Live-Endpoints umgestellt werden (nächster Schritt,
noch offen — Feldnamen von `mapWmsWorkordersRow` unterscheiden sich vom
aktuellen `WorkOrderEntry`-Shape, braucht eine kleine Mapping-Funktion).
