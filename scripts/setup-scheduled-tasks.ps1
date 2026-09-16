# Registriert Windows Scheduled Tasks fuer den automatischen Daten-Sync.
#
# Ausfuehren (einmalig):
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\scripts\setup-scheduled-tasks.ps1
#
# Tasks:
#   RezeptlogikProductionPlanSync   -- alle 2h Mo-Fr 07-17 Uhr
#   RezeptlogikDailyBriefingRelay   -- Mo-Fr 14:30 Uhr

param()

$ProjectDir = Split-Path -Parent $PSScriptRoot
$Npm = (Get-Command npm -ErrorAction Stop).Source

function Register-RezeptlogikTask {
    param(
        [string]$TaskName,
        [string]$NpmScript,
        [string]$Description,
        [object[]]$Triggers
    )

    $Action = New-ScheduledTaskAction `
        -Execute $Npm `
        -Argument "run $NpmScript" `
        -WorkingDirectory $ProjectDir

    $Settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
        -StartWhenAvailable `
        -RunOnlyIfNetworkAvailable `
        -MultipleInstances IgnoreNew

    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "  Alter Task $TaskName entfernt."
    }

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $Action `
        -Trigger $Triggers `
        -Settings $Settings `
        -Description $Description `
        -RunLevel Limited | Out-Null

    Write-Host "OK Task $TaskName registriert."
}

# Produktionsplan-Sync: alle 2h Mo-Fr 07-17 Uhr (6 Trigger)
$PlanTriggers = @()
foreach ($Hour in @(7, 9, 11, 13, 15, 17)) {
    $AtTime = [datetime]::Today.AddHours($Hour)
    $PlanTriggers += New-ScheduledTaskTrigger `
        -Weekly `
        -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday `
        -At $AtTime
}

Register-RezeptlogikTask `
    -TaskName "RezeptlogikProductionPlanSync" `
    -NpmScript "sync:production-plan" `
    -Description "Liest GSheet-Produktionsplan alle 2h und schreibt ihn nach Firestore." `
    -Triggers $PlanTriggers

# Daily Briefing Relay: Mo-Fr 14:30 Uhr
$RelayTrigger = New-ScheduledTaskTrigger `
    -Weekly `
    -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday `
    -At ([datetime]::Today.AddHours(14).AddMinutes(30))

Register-RezeptlogikTask `
    -TaskName "RezeptlogikDailyBriefingRelay" `
    -NpmScript "daily-briefing:relay" `
    -Description "Equipment morgen + Backfill-Feasibility fuer 15:00-Slack-Post." `
    -Triggers $RelayTrigger

Write-Host ""
Write-Host "Alle Tasks registriert. Status pruefen:"
Write-Host "  Get-ScheduledTask | Where-Object { $_.TaskName -like 'Rezeptlogik*' } | Select-Object TaskName,State"
