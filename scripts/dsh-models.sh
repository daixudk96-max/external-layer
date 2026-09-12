#!/usr/bin/env sh
# Emit the DSH client model snippet for the running facade, using the live numbers.
# Usage: EXT_LAYER_API_KEY=<key> sh scripts/dsh-models.sh
set -e
PORT="${EXT_LAYER_PORT:-17843}"
if [ -z "${EXT_LAYER_API_KEY:-}" ]; then
  echo "[dsh-models] set EXT_LAYER_API_KEY first (the key the layer printed at startup)" >&2
  exit 1
fi
curl -s -H "Authorization: Bearer ${EXT_LAYER_API_KEY}" "http://127.0.0.1:${PORT}/v1/context" | python -c '
import json, sys
doc = json.load(sys.stdin)
print("# paste under your provider entry; contextWindow follows the deployment switch")
print("  - id: %s" % doc["model"])
print("    contextWindow: %s" % doc["latest_context_window"])
print("    reasoningEfforts:")
for effort in sorted(doc["tiers"]):
    print("      - %s" % effort)
'
