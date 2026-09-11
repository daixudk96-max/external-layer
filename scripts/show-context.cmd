@echo off
rem One-command view of live context-window contract from external layer facade

set EXT_LAYER_PORT=17843
set EXT_LAYER_ENDPOINT=http://127.0.0.1:%EXT_LAYER_PORT%/v1/context

if "%EXT_LAYER_API_KEY%"=="" (
  set EXT_LAYER_API_KEY=sk-dsh-web-cdfedbd300cc0e0ac0b4cc0c4209cd2cadc5271e61f5c103
)

curl.exe -s -H "Authorization: Bearer %EXT_LAYER_API_KEY%" "%EXT_LAYER_ENDPOINT%"
echo.
