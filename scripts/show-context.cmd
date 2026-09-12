@echo off
setlocal
rem One command view of the live context-window contract of the running facade.
set "PORT=17843"
if not "%EXT_LAYER_PORT%"=="" set "PORT=%EXT_LAYER_PORT%"
if "%EXT_LAYER_API_KEY%"=="" (
  echo [show-context] set EXT_LAYER_API_KEY first (the key the layer printed at startup)
  exit /b 1
)
curl.exe -s -H "Authorization: Bearer %EXT_LAYER_API_KEY%" "http://127.0.0.1:%PORT%/v1/context"
echo.
exit /b 0
