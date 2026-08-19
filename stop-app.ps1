$ports = 5173, 3141, 3142
$found = $false
foreach ($port in $ports) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        try {
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
            Write-Output "Port $port (PID $($c.OwningProcess)) gestoppt."
            $found = $true
        } catch {
            Write-Output "Port $port (PID $($c.OwningProcess)) konnte nicht gestoppt werden: $_"
        }
    }
}
if (-not $found) {
    Write-Output "Kein laufender Server auf Port 5173/3141/3142 gefunden."
}
