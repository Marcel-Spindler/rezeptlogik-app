' Unsichtbarer Wrapper — startet run-wms-cache-relay.cmd ohne CMD-Fenster.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """C:\dev\rezeptlogik-app\scripts\run-wms-cache-relay.cmd""", 0, True
