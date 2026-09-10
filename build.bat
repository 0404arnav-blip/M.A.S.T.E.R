@echo off
setlocal
cd /d %~dp0
echo === installing build deps ===
venv\Scripts\python -m pip install -q pyinstaller
echo === building the exe ===
venv\Scripts\python -m PyInstaller --noconfirm --clean MASTER.spec || goto :err
echo === bundling runtime assets next to the exe ===
if not exist dist\MASTER\voices mkdir dist\MASTER\voices
copy /y voices\en_US-kusal-medium.onnx      dist\MASTER\voices\ >nul
copy /y voices\en_US-kusal-medium.onnx.json dist\MASTER\voices\ >nul
copy /y config.json.example dist\MASTER\config.json >nul
copy /y README.md  dist\MASTER\ >nul
copy /y LICENSE    dist\MASTER\ >nul
copy /y master.ico dist\MASTER\ >nul
echo === zipping ===
powershell -NoProfile -Command "Compress-Archive -Path 'dist\MASTER\*' -DestinationPath 'dist\MASTER-windows.zip' -Force"
echo.
echo Done:  dist\MASTER\MASTER.exe   and   dist\MASTER-windows.zip
goto :eof
:err
echo BUILD FAILED
exit /b 1
