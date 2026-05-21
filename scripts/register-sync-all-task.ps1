# register-sync-all-task.ps1
# Registriert einen Windows-Aufgabenplaner-Task, der alle 2 Stunden
# alle GSheet-Datenquellen aktualisiert, die App baut und deployt.
#
# Einmalig als Administrator ausführen:
#   powershell -ExecutionPolicy Bypass -File scripts\register-sync-all-task.ps1

$taskName  = "RezeptlogikSyncAllAndDeploy"
$batFile   = "C:\rezeptlogik-app\scripts\sync-all-and-deploy.bat"
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
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$batFile`""

# Alle 2 Stunden ab 06:00 Uhr (06:00, 08:00, 10:00, 12:00, 14:00, 16:00, 18:00, 20:00)
$triggers = @()
foreach ($hour in 6, 8, 10, 12, 14, 16, 18, 20) {
    $triggers += New-ScheduledTaskTrigger -Daily -At "${hour}:00"
}

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName    $taskName `
    -Action      $action `
    -Trigger     $triggers `
    -Settings    $settings `
    -RunLevel    Highest `
    -Description "Alle 2h: GSheet-Sync (KPL, Factor Forecast, Hauptdaten) + Build + Firebase Deploy" `
    | Out-Null

Write-Host ""
Write-Host "✅ Task '$taskName' erfolgreich registriert."
Write-Host "   Laeuft taeglich um: 06:00 · 08:00 · 10:00 · 12:00 · 14:00 · 16:00 · 18:00 · 20:00"
Write-Host "   Batch: $batFile"
Write-Host "   Log:   $logDir\sync-all.log"
Write-Host ""
Write-Host "Jetzt einmalig testen:"
Write-Host "  Start-ScheduledTask -TaskName '$taskName'"
Write-Host ""
Write-Host "Status pruefen:"
Write-Host "  Get-ScheduledTask -TaskName '$taskName' | Get-ScheduledTaskInfo"
