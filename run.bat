@echo off
set PATH=C:\Factor Projekte\rezeptlogik-app\.node\node-v20.11.1-win-x64;%PATH%
node -v
npm -v
call npm install
call npm run build
call npx firebase-tools deploy --only hosting
