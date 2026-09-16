@echo off
cd /d "C:\dev\rezeptlogik-app"
call npx tsx scripts\wms-cache-relay.ts >> logs\wms-cache-relay.log 2>&1
