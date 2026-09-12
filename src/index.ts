import { createTokenProvider } from "./credentials";
import { startExternalLayer } from "./external-layer";

const port = Number(process.env.EXT_LAYER_PORT ?? 17843);
const apiKey = process.env.EXT_LAYER_API_KEY ?? "sk-dsh-web-cdfedbd300cc0e0ac0b4cc0c4209cd2cadc5271e61f5c103";
const upstreamBaseUrl = process.env.EXT_LAYER_UPSTREAM ?? "http://127.0.0.1:17842";
const authJsonPath = process.env.EXT_LAYER_AUTH_JSON ?? "C:\\Users\\daixu\\.codex\\auth.json";
const statePath = process.env.EXT_LAYER_STATE;
const stallTimeoutSec = process.env.EXT_LAYER_STALL_SEC !== undefined
  ? Number(process.env.EXT_LAYER_STALL_SEC)
  : undefined;
const firstByteTimeoutMs = process.env.EXT_LAYER_FIRST_BYTE_MS !== undefined
  ? Number(process.env.EXT_LAYER_FIRST_BYTE_MS)
  : undefined;

const defaultEnvironment = {
  cwd: process.env.EXT_LAYER_CWD ?? "E:/github/chatgpt-web-2-api",
  workspaceRoots: (process.env.EXT_LAYER_ROOTS ?? "E:/github/chatgpt-web-2-api").split(";").filter(Boolean),
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

const upstreamHome = process.env.EXT_LAYER_UPSTREAM_HOME;

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
  upstreamHome,
});

console.log(
  `[external-layer] listening on ${layer.baseUrl}/v1 (upstream ${upstreamBaseUrl}) [stall=${layer.stallTimeoutSec}s firstByte=${layer.firstByteTimeoutMs}ms]`,
);
