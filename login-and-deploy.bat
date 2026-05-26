@echo off
set PATH=C:\Factor Projekte\rezeptlogik-app\.node\node-v20.11.1-win-x64;%PATH%

echo Bitte logge dich im folgenden Schritt im Browser ein:
call npx firebase-tools login

echo.
echo Starte Deployment...
call npx firebase-tools deploy --only hosting

echo Fertig!
pause
