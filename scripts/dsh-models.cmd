@echo off
setlocal
rem Emit the DSH client model snippet for the running facade, using the live numbers
rem (no numbers are hardcoded here: they come from the /v1/context endpoint).
set "PORT=17843"
if not "%EXT_LAYER_PORT%"=="" set "PORT=%EXT_LAYER_PORT%"
if "%EXT_LAYER_API_KEY%"=="" (
  echo [dsh-models] set EXT_LAYER_API_KEY first (the key the layer printed at startup)
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$r = Invoke-RestMethod -Uri ('http://127.0.0.1:%PORT%/v1/context') -Headers @{ Authorization = ('Bearer ' + $env:EXT_LAYER_API_KEY) };" ^
  "Write-Output '# paste this under your provider entry (contextWindow follows the switch)';" ^
  "Write-Output ('  - id: ' + $r.model);" ^
  "Write-Output ('    contextWindow: ' + $r.latest_context_window);" ^
  "Write-Output '    reasoningEfforts:';" ^
  "($r.tiers.PSObject.Properties.Name | Sort-Object) | ForEach-Object { Write-Output ('      - ' + $_) }"
exit /b 0
