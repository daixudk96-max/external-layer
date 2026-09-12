@echo off
setlocal
rem Stop only the process listening on the external layer port; upstream is untouched.
set "PORT=17843"
if not "%EXT_LAYER_PORT%"=="" set "PORT=%EXT_LAYER_PORT%"
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":%PORT%" ^| findstr /C:"LISTENING"') do (
  if not "%%p"=="0" (
    taskkill /F /PID %%p >nul 2>&1
    echo [ext-layer] killed pid %%p
    set "FOUND=1"
  )
)
if not defined FOUND echo [ext-layer] nothing was listening on %PORT%
exit /b 0
