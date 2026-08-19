@echo off
cd /d "%~dp0"
echo Stoppe Rezeptlogik-App (Vite, WMS-Server, lokale DB)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-app.ps1"
echo.
pause
