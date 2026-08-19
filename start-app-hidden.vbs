Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "c:\Users\MarcelSpindler\Documents\GitHub\rezeptlogik-app"
WshShell.Run "cmd /c npm start", 0, False
