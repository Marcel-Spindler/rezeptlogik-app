' Startet den Rezeptlogik-App Dev-Server unsichtbar (kein Konsolenfenster)
' und oeffnet danach den Browser.
Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
objShell.CurrentDirectory = scriptDir

' npm start (vite) im Hintergrund, kein sichtbares Fenster (0 = hidden, False = nicht warten)
objShell.Run "cmd /c npm start", 0, False

' kurz warten, bis Vite hochgefahren ist, dann Browser oeffnen
WScript.Sleep 4000
objShell.Run "http://localhost:5173/", 1, False
