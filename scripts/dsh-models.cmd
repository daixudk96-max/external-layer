@echo off
rem Query live context windows from external layer and emit DSH client configuration

set EXT_LAYER_PORT=17843
set EXT_LAYER_ENDPOINT=http://127.0.0.1:%EXT_LAYER_PORT%/v1/context

if "%EXT_LAYER_API_KEY%"=="" (
  set EXT_LAYER_API_KEY=sk-dsh-web-cdfedbd300cc0e0ac0b4cc0c4209cd2cadc5271e61f5c103
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ep = '%EXT_LAYER_ENDPOINT%';" ^
  "$key = '%EXT_LAYER_API_KEY%';" ^
  "try {" ^
  "  $resp = Invoke-RestMethod -Uri $ep -Headers @{ Authorization = ('Bearer ' + $key) } -Method Get -TimeoutSec 10;" ^
  "} catch {" ^
  "  Write-Host ('[ERROR] Failed to fetch context from ' + $ep + ': ' + $_.Exception.Message);" ^
  "  exit 1;" ^
  "}" ^
  "Write-Host '=== Available Tiers (Live Context) ===';" ^
  "if ($resp.tiers) {" ^
  "  $resp.tiers.PSObject.Properties | ForEach-Object {" ^
  "    $name = $_.Name;" ^
  "    $t = $_.Value;" ^
  "    Write-Host ('Tier [' + $name + ']: ' + $t.slug + ' (contextWindow: ' + $t.context_window + ', compact: ' + $t.auto_compact_token_limit + ')');" ^
  "  };" ^
  "  Write-Host '';" ^
  "  Write-Host '=== DSH settings.yaml Snippet ===';" ^
  "  Write-Host 'models:';" ^
  "  $resp.tiers.PSObject.Properties | ForEach-Object {" ^
  "    $t = $_.Value;" ^
  "    Write-Host ('  - id: ' + $t.slug);" ^
  "    Write-Host ('    name: ' + $t.slug);" ^
  "    Write-Host ('    contextWindow: ' + $t.context_window);" ^
  "  };" ^
  "} else {" ^
  "  Write-Host 'No tier data found in context response.';" ^
  "}"
