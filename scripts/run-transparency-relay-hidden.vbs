' Unsichtbarer Wrapper — startet run-transparency-relay.cmd ohne CMD-Fenster.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """C:\dev\rezeptlogik-app\scripts\run-transparency-relay.cmd""", 0, True
