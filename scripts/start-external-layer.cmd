@echo off
rem DSH external layer (standard Responses facade) - one-click idempotent start on port 17843
set PORT=17843
netstat -ano | findstr /C:":17843" | findstr /C:"LISTENING" >nul 2>&1
if %errorlevel%==0 goto already
echo [ext-layer] starting external layer on %PORT%...
start "" /min cmd /c "cd /d E:\github\chatgpt-web-2-api\external-layer && set EXT_LAYER_PORT=%PORT% && bun run src/index.ts > C:\Users\daixu\AppData\Local\Temp\external-layer.log 2>&1"
set /a tries=0
:wait
ping -n 3 127.0.0.1 >nul
netstat -ano | findstr /C:":17843" | findstr /C:"LISTENING" >nul 2>&1
if %errorlevel%==0 goto up
set /a tries+=1
if %tries% GEQ 20 goto fail
goto wait
:up
echo [ext-layer] endpoint UP: http://127.0.0.1:%PORT%/v1
pause
exit /b 0
:already
echo [ext-layer] already listening on %PORT% - nothing to do
pause
exit /b 0
:fail
echo [ext-layer] FAILED: see C:\Users\daixu\AppData\Local\Temp\external-layer.log
pause
exit /b 1
