#!/usr/bin/env sh
# Stop whatever is listening on the external layer port; upstream is untouched.
PORT="${EXT_LAYER_PORT:-17843}"
PIDS=$(netstat -ano 2>/dev/null | grep "LISTENING" | grep ":${PORT}" | awk '{print $NF}' | sort -u)
if [ -z "$PIDS" ]; then echo "[ext-layer] nothing was listening on ${PORT}"; exit 0; fi
for pid in $PIDS; do kill -9 "$pid" 2>/dev/null && echo "[ext-layer] killed pid $pid"; done
