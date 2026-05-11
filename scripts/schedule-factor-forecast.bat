@echo off
REM Lädt die neueste Factor-Forecast-CSV von Google Drive.
REM Wird vom Windows-Aufgabenplaner täglich um 07:30 Uhr aufgerufen.

cd /d "C:\rezeptlogik-app"
call npm run sync:factor:forecast >> "C:\rezeptlogik-app\logs\factor-forecast.log" 2>&1
