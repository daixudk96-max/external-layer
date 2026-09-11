@echo off
REM External layer WITH server-side tool execution enabled.
REM read_file only (run_command stays out of the allow list on purpose: least privilege).
REM approvals=auto is required for the layer to execute anything locally.
cd /d E:\github\chatgpt-web-2-api\external-layer
set EXT_LAYER_PORT=17843
set EXT_LAYER_TOOLS=1
set EXT_LAYER_TOOLS_ROOTS=E:\github\chatgpt-web-2-api
set EXT_LAYER_TOOLS_ALLOW=read_file
set EXT_LAYER_TOOLS_APPROVALS=auto
set EXT_LAYER_TOOLS_AUDIT=C:\Users\daixu\AppData\Local\Temp\ext-layer-audit.jsonl
set EXT_LAYER_TOOLS_MAX_ROUNDS=8
"C:\Users\daixu\AppData\Roaming\npm\node_modules\bun\bin\bun.exe" run src/index.ts
