' Unsichtbarer Wrapper fuer run-rti-redzone-relay.cmd — startet das CMD
' ohne sichtbares Fenster (WindowStyle 0 = Hidden). Wird vom Windows
' Scheduled Task "RezeptlogikRtiRedzoneRelay" aufgerufen.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """C:\dev\rezeptlogik-app\scripts\run-rti-redzone-relay.cmd""", 0, True
