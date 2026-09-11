import { createTokenProvider } from "./credentials";
import { startExternalLayer } from "./external-layer";

const port = Number(process.env.EXT_LAYER_PORT ?? 17843);
const apiKey = process.env.EXT_LAYER_API_KEY ?? "sk-dsh-web-cdfedbd300cc0e0ac0b4cc0c4209cd2cadc5271e61f5c103";
const upstreamBaseUrl = process.env.EXT_LAYER_UPSTREAM ?? "http://127.0.0.1:17842";
const authJsonPath = process.env.EXT_LAYER_AUTH_JSON ?? "C:\\Users\\daixu\\.codex\\auth.json";
const statePath = process.env.EXT_LAYER_STATE;

const defaultEnvironment = {
  cwd: process.env.EXT_LAYER_CWD ?? "E:/github/chatgpt-web-2-api",
  workspaceRoots: (process.env.EXT_LAYER_ROOTS ?? "E:/github/chatgpt-web-2-api").split(";").filter(Boolean),
  sandboxMode: process.env.EXT_LAYER_SANDBOX ?? "danger-full-access",
};

const layer = await startExternalLayer({
  apiKey,
  upstreamBaseUrl,
  tokenProvider: createTokenProvider({ authJsonPath }),
  port,
  defaultEnvironment,
  statePath,
});
console.log('[external-layer] listening on ' + layer.baseUrl + '/v1 (upstream ' + upstreamBaseUrl + ')');
