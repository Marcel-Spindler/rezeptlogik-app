@echo off
cd /d "%~dp0"
node bot.mjs >> bot.log 2>&1
