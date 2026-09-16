@echo off
rem Wrapper fuer den Windows Scheduled Task "RezeptlogikRtiRedzoneRelay" —
rem siehe scripts/rti-redzone-relay.ts fuer den eigentlichen Job.
cd /d "C:\dev\rezeptlogik-app"
call npx tsx scripts\rti-redzone-relay.ts >> logs\rti-redzone-relay.log 2>&1
