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

const serverTools = process.env.EXT_LAYER_TOOLS === "1"
  ? {
      enabled: true,
      workspaceRoots: (process.env.EXT_LAYER_TOOLS_ROOTS ?? defaultEnvironment.workspaceRoots.join(";"))
        .split(";")
        .filter(Boolean),
      allowedTools: process.env.EXT_LAYER_TOOLS_ALLOW
        ? process.env.EXT_LAYER_TOOLS_ALLOW.split(",").map(t => t.trim()).filter(Boolean)
        : undefined,
      approvals: (process.env.EXT_LAYER_TOOLS_APPROVALS as "auto" | "deny") || undefined,
      auditPath: process.env.EXT_LAYER_TOOLS_AUDIT,
      maxRounds: process.env.EXT_LAYER_TOOLS_MAX_ROUNDS ? Number(process.env.EXT_LAYER_TOOLS_MAX_ROUNDS) : undefined,
    }
  : undefined;

const layer = await startExternalLayer({
  apiKey,
  upstreamBaseUrl,
  tokenProvider: createTokenProvider({ authJsonPath }),
  port,
  defaultEnvironment,
  statePath,
  stallTimeoutSec,
  firstByteTimeoutMs,
  serverTools,
});
console.log(
  `[external-layer] listening on ${layer.baseUrl}/v1 (upstream ${upstreamBaseUrl}) [stall=${layer.stallTimeoutSec}s firstByte=${layer.firstByteTimeoutMs}ms]`,
);
