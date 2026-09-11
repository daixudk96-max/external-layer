import { createTokenProvider } from "./credentials";
import { startExternalLayer } from "./external-layer";

const port = Number(process.env.EXT_LAYER_PORT ?? 17843);
const apiKey = process.env.EXT_LAYER_API_KEY ?? "sk-dsh-web-cdfedbd300cc0e0ac0b4cc0c4209cd2cadc5271e61f5c103";
const upstreamBaseUrl = process.env.EXT_LAYER_UPSTREAM ?? "http://127.0.0.1:17842";
const authJsonPath = process.env.EXT_LAYER_AUTH_JSON ?? "C:\\Users\\daixu\\.codex\\auth.json";

const layer = await startExternalLayer({
  apiKey,
  upstreamBaseUrl,
  tokenProvider: createTokenProvider({ authJsonPath }),
  port,
});
console.log('[external-layer] listening on ' + layer.baseUrl + '/v1 (upstream ' + upstreamBaseUrl + ')');
