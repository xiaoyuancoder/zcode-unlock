' ZCode 破限守护进程 —— 隐藏窗口启动器
'
' node.exe 是控制台子系统程序，直接启动会弹出黑色命令行窗口。
' 这里用 WScript.Shell 以 SW_HIDE(0) 方式拉起，进程在后台静默运行。
'
' 用法： wscript.exe C:\zcode-unlock\run-hidden.vbs

Option Explicit

Dim shell, fso, here, nodeExe, script, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = here & "\watchdog.cjs"

' 优先用 nodew.exe（无窗口的 node 变体），没有则退回 node.exe + SW_HIDE
nodeExe = ""
If fso.FileExists(here & "\node.exe") Then
  nodeExe = here & "\node.exe"
Else
  Dim candidates, i, p
  candidates = Array( _
    "C:\nvm4w\nodejs\nodew.exe", _
    "C:\Program Files\nodejs\nodew.exe", _
    "C:\nvm4w\nodejs\node.exe", _
    "C:\Program Files\nodejs\node.exe")
  For i = 0 To UBound(candidates)
    p = candidates(i)
    If fso.FileExists(p) Then
      nodeExe = p
      Exit For
    End If
  Next
End If

If nodeExe = "" Then
  ' 找不到 node，把错误写进日志
  Dim logFile, f
  Set f = fso.CreateTextFile(here & "\watchdog.log", True)
  f.WriteLine "[" & Now() & " ] ERROR: node executable not found"
  f.Close
  WScript.Quit 1
End If

cmd = """" & nodeExe & """ """ & script & """"

' 0 = SW_HIDE：隐藏窗口
' False = 不等待子进程（异步启动，脚本立即退出）
shell.Run cmd, 0, False
