# ============================================================
# Factor Kitchen — Windows Task Scheduler setup
# Esegui UNA SOLA VOLTA come Amministratore:
#   Tasto destro su questo file → "Esegui con PowerShell"
#   oppure apri PowerShell come Admin e incolla il percorso
# ============================================================

$botDir  = 'C:\Users\MatteoSpessotto\Desktop\Aiuto Claude\factor-recipe-bot'
$bat     = Join-Path $botDir 'run.bat'
$user    = $env:USERDOMAIN + '\' + $env:USERNAME

$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$bat`"" -WorkingDirectory $botDir
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable -MultipleInstances IgnoreNew

# ---- Ricette: Lunedi-Giovedi 13:00 ----
$t1 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday -At '13:00'
Register-ScheduledTask -TaskName 'Factor Recipe - LunGio 13:00' -Action $action -Trigger $t1 -Principal $principal -Settings $settings -Force
Write-Host '  [OK] Factor Recipe - LunGio 13:00' -ForegroundColor Green

# ---- Ricette: Lunedi-Giovedi 18:00 ----
$t2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday -At '18:00'
Register-ScheduledTask -TaskName 'Factor Recipe - LunGio 18:00' -Action $action -Trigger $t2 -Principal $principal -Settings $settings -Force
Write-Host '  [OK] Factor Recipe - LunGio 18:00' -ForegroundColor Green

# ---- Ricette: Venerdi 12:30 ----
$t3 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At '12:30'
Register-ScheduledTask -TaskName 'Factor Recipe - Venerdi 12:30' -Action $action -Trigger $t3 -Principal $principal -Settings $settings -Force
Write-Host '  [OK] Factor Recipe - Venerdi 12:30' -ForegroundColor Green

Write-Host ''
Write-Host '=== Verifica task creati ===' -ForegroundColor Cyan
Get-ScheduledTask -TaskName 'Factor Recipe*' | Select-Object TaskName, State | Format-Table -AutoSize

Write-Host ''
Write-Host 'Setup completato! Premi Invio per chiudere.' -ForegroundColor Yellow
Read-Host
