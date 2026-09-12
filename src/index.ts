import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTokenProvider } from "./credentials";
import { startExternalLayer } from "./external-layer";

/**
 * External-layer entrypoint.
 *
 * Every value below is overridable by environment (see `.env.example` and README):
 * the layer is designed to run on someone else's machine, in front of their own
 * pristine `codex-chatgpt-web` upstream, so nothing here may bake in a machine
 * specific path or a shared credential.
 */

const port = Number(process.env.EXT_LAYER_PORT ?? 17843);
const upstreamBaseUrl = process.env.EXT_LAYER_UPSTREAM ?? "http://127.0.0.1:17842";
const authJsonPath = process.env.EXT_LAYER_AUTH_JSON ?? join(homedir(), ".codex", "auth.json");
const statePath = process.env.EXT_LAYER_STATE;
const stallTimeoutSec = process.env.EXT_LAYER_STALL_SEC !== undefined
  ? Number(process.env.EXT_LAYER_STALL_SEC)
  : undefined;
const firstByteTimeoutMs = process.env.EXT_LAYER_FIRST_BYTE_MS !== undefined
  ? Number(process.env.EXT_LAYER_FIRST_BYTE_MS)
  : undefined;
const progressTimeoutMs = process.env.EXT_LAYER_PROGRESS_MS !== undefined
  ? Number(process.env.EXT_LAYER_PROGRESS_MS)
  : undefined;

// The trusted Codex environment handed to upstream for envelope-less standard clients.
// Defaults to the working directory the layer was started from, never to an author path.
const environmentCwd = process.env.EXT_LAYER_CWD ?? process.cwd();
const defaultEnvironment = {
  cwd: environmentCwd,
  workspaceRoots: (process.env.EXT_LAYER_ROOTS ?? environmentCwd).split(";").filter(Boolean),
  sandboxMode: process.env.EXT_LAYER_SANDBOX ?? "danger-full-access",
};

function parseBooleanEnv(raw?: string): boolean | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "1" || trimmed === "true") return true;
  if (trimmed === "0" || trimmed === "false") return false;
  return undefined;
}

const solAvailable = parseBooleanEnv(process.env.EXT_LAYER_SOL_AVAILABLE);
const proAvailable = parseBooleanEnv(process.env.EXT_LAYER_PRO_AVAILABLE);

const continuation = parseBooleanEnv(process.env.EXT_LAYER_CONTINUATION);
const conversationLimit = process.env.EXT_LAYER_CONVERSATION_LIMIT !== undefined
  ? Number(process.env.EXT_LAYER_CONVERSATION_LIMIT)
  : undefined;
const conversationsPath = process.env.EXT_LAYER_CONVERSATIONS;

const upstreamHome = process.env.EXT_LAYER_UPSTREAM_HOME;

// No shared default key ships with this repo: an unset EXT_LAYER_API_KEY generates a
// per-install key instead of accepting a well-known one. Loopback-only, but a fixed
// public default would still be an open door for any local process.
const providedApiKey = process.env.EXT_LAYER_API_KEY?.trim();
const apiKey = providedApiKey && providedApiKey.length > 0
  ? providedApiKey
  : `sk-ext-layer-${randomBytes(16).toString("hex")}`;

const layer = await startExternalLayer({
  apiKey,
  upstreamBaseUrl,
  tokenProvider: createTokenProvider({ authJsonPath }),
  port,
  ...(solAvailable !== undefined ? { solAvailable } : {}),
  ...(proAvailable !== undefined ? { proAvailable } : {}),
  defaultEnvironment,
  statePath,
  stallTimeoutSec,
  firstByteTimeoutMs,
  progressTimeoutMs,
  upstreamHome,
  ...(continuation !== undefined ? { continuation } : {}),
  ...(conversationLimit !== undefined ? { conversationLimit } : {}),
  ...(conversationsPath ? { conversationsPath } : {}),
});

console.log(
  `[external-layer] listening on ${layer.baseUrl}/v1 (upstream ${upstreamBaseUrl}) [stall=${layer.stallTimeoutSec}s firstByte=${layer.firstByteTimeoutMs}ms]`,
);
if (providedApiKey && providedApiKey.length > 0) {
  console.log(
    `[external-layer] api key: ${apiKey.slice(0, 12)}…${apiKey.slice(-4)} (from EXT_LAYER_API_KEY)`,
  );
} else {
  console.log(`[external-layer] api key: ${apiKey}`);
  console.log(
    "[external-layer] that key was generated for this run only — set EXT_LAYER_API_KEY (e.g. in .env.local) to keep clients working across restarts",
  );
}
