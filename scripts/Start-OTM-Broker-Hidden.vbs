Option Explicit
Dim shell, fso, nodePath, brokerPath, launchLine, rc
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
nodePath = "C:\nvm4w\nodejs\node.exe"
brokerPath = fso.GetAbsolutePathName(fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "..\bin\otm-broker.mjs"))
If Not fso.FileExists(nodePath) Then WScript.Quit 2
If Not fso.FileExists(brokerPath) Then WScript.Quit 3
shell.CurrentDirectory = fso.GetParentFolderName(brokerPath)
launchLine = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & brokerPath & Chr(34)
rc = shell.Run(launchLine, 0, True)
If rc <> 0 Then shell.LogEvent 1, "Overtli Task Manager broker exited with code " & CStr(rc)
WScript.Quit rc