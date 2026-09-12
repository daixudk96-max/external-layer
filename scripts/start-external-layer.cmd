@echo off
setlocal
rem Start the external layer (standard Responses API facade) on port 17843.
rem Portable: resolves the repo from this script location, needs bun on PATH.
set "PORT=17843"
if not "%EXT_LAYER_PORT%"=="" set "PORT=%EXT_LAYER_PORT%"
set "ROOT=%~dp0.."

netstat -ano | findstr /C:":%PORT%" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 goto already

echo [ext-layer] starting on %PORT% from %ROOT%
start "ext-layer" /min /d "%ROOT%" cmd /k "bun run src/index.ts"

set /a tries=0
:wait
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr /C:":%PORT%" | findstr /C:"LISTENING" >nul 2>&1
if not errorlevel 1 goto up
set /a tries+=1
if %tries% lss 15 goto wait
echo [ext-layer] FAILED: nothing is listening on %PORT%; run bun run src/index.ts to see the error
exit /b 1

:up
echo [ext-layer] UP on http://127.0.0.1:%PORT%/v1
exit /b 0

:already
echo [ext-layer] already running on %PORT% - nothing to do
exit /b 0
