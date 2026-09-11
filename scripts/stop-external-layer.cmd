@echo off
rem Stop only the process listening on the external layer port (upstream untouched)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":17843" ^| findstr /C:"LISTENING"') do taskkill /F /PID %%p >nul 2>&1
echo [ext-layer] stopped (upstream untouched)
pause
