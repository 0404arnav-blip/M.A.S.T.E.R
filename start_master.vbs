Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\master"
sh.Run """D:\master\venv\Scripts\pythonw.exe"" ""D:\master\Master_code.py""", 0, False
