@echo off
setlocal
rem Production shape: the verified configuration (progress budget 420s, one upstream
rem attempt per client request, client-owned tools). Identical to start-external-layer.cmd
rem but pins the operational defaults explicitly.
set "PORT=17843"
if not "%EXT_LAYER_PORT%"=="" set "PORT=%EXT_LAYER_PORT%"
set "ROOT=%~dp0.."
set "EXT_LAYER_PORT=%PORT%"
if "%EXT_LAYER_PROGRESS_MS%"=="" set "EXT_LAYER_PROGRESS_MS=240000"
echo [ext-layer] starting production shape on %PORT% from %ROOT%
cd /d "%ROOT%"
bun run src/index.ts
