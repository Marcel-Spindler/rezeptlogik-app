@echo off
cd /d "%~dp0"
echo Starte Rezeptlogik-App (WMS-Server + lokale DB werden automatisch mitgestartet)...
call npm start
pause
