#!/usr/bin/env sh
# Start the external layer (standard Responses API facade). Needs bun on PATH.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${EXT_LAYER_PORT:-17843}"
echo "[ext-layer] starting on ${PORT} from ${ROOT}"
cd "$ROOT"
exec bun run src/index.ts
