' Starts the Claude factory dashboard (server.js next to this file) with no window, like Hermes_Gateway.vbs.
Option Explicit
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c node """ & dir & "\server.js"" >> """ & fso.GetParentFolderName(dir) & "\data\dashboard.log"" 2>&1", 0, False
