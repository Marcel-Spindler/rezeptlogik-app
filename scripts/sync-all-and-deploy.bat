@echo off
REM sync-all-and-deploy.bat
REM Aktualisiert alle GSheet-Datenquellen, baut die App und deployt zu Firebase Hosting.
REM Wird vom Windows-Aufgabenplaner alle 2 Stunden aufgerufen.

cd /d "C:\rezeptlogik-app"

set LOG=C:\rezeptlogik-app\logs\sync-all.log
set TIMESTAMP=%date% %time%

echo. >> "%LOG%"
echo ========================================== >> "%LOG%"
echo %TIMESTAMP% — Sync gestartet >> "%LOG%"
echo ========================================== >> "%LOG%"

echo [1/4] Hauptdaten von GSheet laden (import:gsheet)... >> "%LOG%"
call npm run import:gsheet >> "%LOG%" 2>&1
if errorlevel 1 (
    echo WARNUNG: import:gsheet fehlgeschlagen ^(lokale Rezeptlogik-Daten fehlen?^) >> "%LOG%"
) else (
    echo OK: import:gsheet abgeschlossen >> "%LOG%"
)

echo [2/4] KPL-Dump aktualisieren (Kitchen Priority List)... >> "%LOG%"
call npx tsx scripts\dump-gsheet.ts 13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U >> "%LOG%" 2>&1
if errorlevel 1 (
    echo FEHLER: KPL-Dump fehlgeschlagen >> "%LOG%"
) else (
    echo OK: KPL-Dump abgeschlossen >> "%LOG%"
)

echo [3/4] Factor Forecast (PDL Daily) aktualisieren... >> "%LOG%"
call npm run sync:factor:forecast >> "%LOG%" 2>&1
if errorlevel 1 (
    echo FEHLER: Factor Forecast Sync fehlgeschlagen >> "%LOG%"
) else (
    echo OK: Factor Forecast abgeschlossen >> "%LOG%"
)

echo [4/4] Build + Deploy zu Firebase Hosting... >> "%LOG%"
call npm run build >> "%LOG%" 2>&1
if errorlevel 1 (
    echo FEHLER: Build fehlgeschlagen — kein Deploy >> "%LOG%"
    goto :end
)
call firebase deploy --only hosting >> "%LOG%" 2>&1
if errorlevel 1 (
    echo FEHLER: Firebase Deploy fehlgeschlagen >> "%LOG%"
) else (
    echo OK: Deploy abgeschlossen >> "%LOG%"
)

:end
echo %date% %time% — Sync fertig >> "%LOG%"
