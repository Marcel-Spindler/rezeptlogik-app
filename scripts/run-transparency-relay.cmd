@echo off
cd /d "C:\dev\rezeptlogik-app"
call npx tsx scripts\transparency-relay.ts >> logs\transparency-relay.log 2>&1
