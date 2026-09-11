import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** ChatGPT OAuth credential management for the external layer.
 *
 * The upstream accepts a ChatGPT access token, which expires and must be refreshed with the stored
 * refresh token. Refreshing here keeps the client-facing apiKey contract stable: clients never see
 * ChatGPT credentials, and an expired token is renewed automatically instead of forcing a re-login.
 */

const DEFAULT_REFRESH_SKEW_MS = 60_000;
const CHATGPT_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

interface AuthTokens {
  access_token?: unknown;
  refresh_token?: unknown;
  account_id?: unknown;
  [key: string]: unknown;
}

interface AuthJson {
  auth_mode?: unknown;
  tokens?: AuthTokens;
  last_refresh?: unknown;
  [key: string]: unknown;
}

export interface ResolveTokenConfig {
  authJsonPath: string;
  refreshSkewMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ResolvedToken {
  token: string;
  refreshed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readAuthJson(path: string): AuthJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`ChatGPT credential file is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error(`ChatGPT credential file is not a JSON object: ${path}`);
  return parsed as AuthJson;
}

/** Reads the JWT `exp` claim; an opaque or malformed token yields undefined (treated as usable). */
export function jwtExpiresAtMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!isRecord(payload)) return undefined;
    const exp = payload["exp"];
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1_000 : undefined;
  } catch {
    return undefined;
  }
}

async function refreshAccessToken(
  auth: AuthJson,
  refreshToken: string,
  config: ResolveTokenConfig,
  nowMs: number,
): Promise<{ token: string; updated: AuthJson }> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const response = await fetchImpl(CHATGPT_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CHATGPT_OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    // Fail closed: an expired credential must never be handed to the upstream as if it were valid.
    throw new Error(`ChatGPT credential refresh failed with HTTP ${response.status}`);
  }
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!isRecord(payload) || typeof payload["access_token"] !== "string" || !payload["access_token"]) {
    throw new Error("ChatGPT credential refresh returned no access_token");
  }
  const rotated = typeof payload["refresh_token"] === "string" && payload["refresh_token"]
    ? payload["refresh_token"]
    : undefined;
  const updated: AuthJson = {
    ...auth,
    tokens: {
      ...(auth.tokens ?? {}),
      access_token: payload["access_token"],
      ...(rotated ? { refresh_token: rotated } : {}),
    },
    last_refresh: new Date(nowMs).toISOString(),
  };
  return { token: payload["access_token"], updated };
}

/** Resolve a usable ChatGPT access token, refreshing and persisting it when it is expired. */
export async function resolveChatGptAccessToken(config: ResolveTokenConfig): Promise<ResolvedToken> {
  const nowMs = config.now?.() ?? Date.now();
  const auth = readAuthJson(config.authJsonPath);
  const tokens = isRecord(auth.tokens) ? auth.tokens as AuthTokens : {};
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : undefined;
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined;

  if (accessToken) {
    const expiresAt = jwtExpiresAtMs(accessToken);
    const skewMs = config.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    // An opaque token (no readable exp) is passed through: the upstream remains the authority.
    if (expiresAt === undefined || expiresAt - nowMs > skewMs) {
      return { token: accessToken, refreshed: false };
    }
  }
  if (!refreshToken) {
    throw new Error("ChatGPT credential cannot be refreshed: auth.json has no refresh_token");
  }
  const { token, updated } = await refreshAccessToken(auth, refreshToken, config, nowMs);
  const tempPath = `${config.authJsonPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(updated, null, 2)}\n`);
  renameSync(tempPath, config.authJsonPath);
  return { token, refreshed: true };
}

/** A provider for the facade: call it before each upstream request to obtain a live token. */
export function createTokenProvider(config: ResolveTokenConfig): () => Promise<string> {
  return async () => (await resolveChatGptAccessToken(config)).token;
}
