@echo off
REM External layer in its VERIFIED production shape: no server-side tool execution
REM (tools stay client-owned, which is the path proven end to end on the real machine).
cd /d E:\github\chatgpt-web-2-api\external-layer
set EXT_LAYER_PORT=17843
"C:\Users\daixu\AppData\Roaming\npm\node_modules\bun\bin\bun.exe" run src/index.ts
