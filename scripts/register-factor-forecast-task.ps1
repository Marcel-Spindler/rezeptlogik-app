# register-factor-forecast-task.ps1
# Registriert einen Windows-Aufgabenplaner-Task, der täglich um 07:30 Uhr
# die Factor-Forecast-CSV von Google Drive herunterlädt.
#
# Einmalig als Administrator ausführen:
#   powershell -ExecutionPolicy Bypass -File scripts\register-factor-forecast-task.ps1

$taskName  = "RezeptlogikFactorForecast"
$batFile   = "C:\rezeptlogik-app\scripts\schedule-factor-forecast.bat"
$logDir    = "C:\rezeptlogik-app\logs"

# Logs-Verzeichnis anlegen
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
    Write-Host "Verzeichnis erstellt: $logDir"
}

# Alten Task entfernen falls vorhanden
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Alter Task '$taskName' entfernt."
}

# Aktion: batch-Datei starten
$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$batFile`""

# Täglich um 07:30 Uhr
$trigger = New-ScheduledTaskTrigger -Daily -At "07:30"

# Mit aktuellem Benutzer ausführen
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName  $taskName `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -RunLevel  Highest `
    -Description "Lädt täglich um 07:30 die Factor-Forecast-CSV von Google Drive (Ordner Factor Forecast)" `
    | Out-Null

Write-Host ""
Write-Host "✅ Task '$taskName' erfolgreich registriert."
Write-Host "   Führt täglich um 07:30 aus: $batFile"
Write-Host "   Log: $logDir\factor-forecast.log"
Write-Host ""
Write-Host "Testen mit:"
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
