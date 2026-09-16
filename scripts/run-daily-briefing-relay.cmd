@echo off
rem Wrapper fuer den Windows Scheduled Task "RezeptlogikDailyBriefingRelay" —
rem siehe scripts/daily-briefing-equipment-feasibility-relay.ts fuer den eigentlichen Job.
cd /d "C:\dev\rezeptlogik-app"
call npx tsx scripts\daily-briefing-equipment-feasibility-relay.ts >> logs\daily-briefing-relay.log 2>&1
