import { randomUUID, timingSafeEqual } from "node:crypto";
import { tierSlugForEffort, unifiedCatalog } from "./models";
import { classifyEmptyCompletion, isTransientError, withTransientRetry } from "./reliability";

/** External layer: a standard Responses API facade in front of the original codex-chatgpt-web upstream.
 * The upstream expects Codex-native requests authenticated with a ChatGPT OAuth bearer; this layer
 * owns the client-facing apiKey contract, the synthetic turn identity, and the response relay. */
export interface DefaultEnvironmentConfig {
  cwd: string;
  workspaceRoots: string[];
  sandboxMode?: string;
}

export interface ExternalLayerConfig {
  apiKey: string;
  upstreamBaseUrl: string;
  tokenProvider: () => Promise<string>;
  port?: number;
  /** Account capability flags used to fold the upstream catalog into the unified model. */
  solAvailable?: boolean;
  proAvailable?: boolean;
  /** Trusted Codex environment synthesized for envelope-less standard clients (the upstream
   * requires a cwd-bearing `<environment_context>` user message bound to the turn identity). */
  defaultEnvironment?: DefaultEnvironmentConfig;
  /** 重试上限（缺省 5；0 = 关闭重试）。 */
  transientRetryLimit?: number;
  /** 重试等待时间毫秒（测试注入；缺省走 2000*attempt 退避）。 */
  retrySleepMs?: number;
}

export interface ExternalLayerHandle {
  baseUrl: string;
  stop: () => Promise<void>;
}

class UpstreamHttpFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly contentType: string,
  ) {
    super(body);
    this.name = "UpstreamHttpFailure";
  }
}

class EmptyTurnError extends Error {
  constructor(public readonly reason: string) {
    super(`empty turn content: ${reason}`);
    this.name = "EmptyTurnError";
  }
}

class UpstreamNetworkError extends Error {
  constructor(public readonly detail: string) {
    super(`ChatGPT Web upstream is unreachable: ${detail}`);
    this.name = "UpstreamNetworkError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unauthorized(): Response {
  return Response.json(
    { error: { message: "Incorrect API key provided", type: "authentication_error", code: "invalid_api_key" } },
    { status: 401 },
  );
}

function bearerMatches(header: string | null, apiKey: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${apiKey}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Canonicalize the standard Responses `input` into Codex-native message items. */
function normalizeInput(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) {
    return input.map(item => {
      if (!isRecord(item)) {
        return { type: "message", role: "user", content: [{ type: "input_text", text: String(item ?? "") }] };
      }
      // Standard clients may legally omit `type`; a role-carrying item is a message.
      if (item.type === "message" || (item.type === undefined && typeof item.role === "string")) {
        const content = typeof item.content === "string"
          ? [{ type: "input_text", text: item.content }]
          : Array.isArray(item.content) ? item.content : [];
        return { ...item, type: "message", content };
      }
      return item;
    });
  }
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: typeof input === "string" ? input : JSON.stringify(input ?? "") }],
  }];
}

function itemPlainText(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map(part => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

/** The upstream refuses a turn whose trusted Codex environment has no cwd. Standard clients never
 * send that envelope, so the facade synthesizes one bound to the same turn identity. */
function environmentEnvelope(environment: DefaultEnvironmentConfig): string {
  const roots = environment.workspaceRoots.map(root => `<root>${root}</root>`).join("");
  const sandbox = environment.sandboxMode ?? "danger-full-access";
  return `<environment_context><cwd>${environment.cwd}</cwd><filesystem><workspace_roots>${roots}</workspace_roots><sandbox_mode>${sandbox}</sandbox_mode></filesystem></environment_context>`;
}

/** Translate a standard request into the upstream's Codex-native shape, minting a synthetic identity. */
export function toNativeRequest(
  standard: Record<string, unknown>,
  options: { defaultEnvironment?: DefaultEnvironmentConfig } = {},
): Record<string, unknown> {
  const turnId = `prov-${randomUUID()}`;
  const threadId = `prov-${randomUUID()}`;
  const items = normalizeInput(standard.input);
  const carriesEnvelope = items.some(item => /<\/?environment_context\b/i.test(itemPlainText(item)));
  if (!carriesEnvelope && options.defaultEnvironment) {
    // The envelope must precede the activity message and share its turn identity.
    items.unshift({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: environmentEnvelope(options.defaultEnvironment) }],
      internal_chat_message_metadata_passthrough: { thread_id: threadId, turn_id: turnId },
    });
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.role !== "user") continue;
    const existing = isRecord(item.internal_chat_message_metadata_passthrough)
      ? item.internal_chat_message_metadata_passthrough
      : {};
    item.internal_chat_message_metadata_passthrough = { ...existing, thread_id: threadId, turn_id: turnId };
    break;
  }
  const metadata = isRecord(standard.client_metadata) ? standard.client_metadata : {};
  const turnMetadata = isRecord(metadata["x-codex-turn-metadata"]) ? metadata["x-codex-turn-metadata"] : {};
  return {
    ...standard,
    input: items,
    client_metadata: {
      ...metadata,
      "x-codex-turn-metadata": { ...turnMetadata, thread_id: threadId, turn_id: turnId },
    },
  };
}

/** Client-visible unified model ids do not exist upstream; the advertised `reasoning.effort` picks
 * the concrete upstream tier slug instead. Non-unified ids (already a tier slug) pass through. */
function mapRequestModel(standard: Record<string, unknown>, capabilities: { solAvailable: boolean; proAvailable: boolean }): Record<string, unknown> {
  const model = typeof standard.model === "string" ? standard.model : "";
  if (model !== "chatgpt-web/latest") return standard;
  const reasoning = isRecord(standard.reasoning) ? standard.reasoning : undefined;
  const effort = reasoning && typeof reasoning.effort === "string" ? reasoning.effort : undefined;
  return { ...standard, model: tierSlugForEffort(effort, capabilities) };
}

export async function startExternalLayer(config: ExternalLayerConfig): Promise<ExternalLayerHandle> {
  let requests = 0;
  let lastError: string | undefined;
  const upstreamBase = config.upstreamBaseUrl.replace(/\/+$/, "");
  const server = Bun.serve({
    port: config.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (!bearerMatches(req.headers.get("authorization"), config.apiKey)) return unauthorized();
        requests += 1;
        let standard: Record<string, unknown>;
        try {
          standard = await req.json() as Record<string, unknown>;
        } catch {
          return Response.json({ error: { message: "ChatGPT Web facade requires a JSON request body" } }, { status: 400 });
        }
        let token: string;
        try {
          token = await config.tokenProvider();
        } catch {
          lastError = "credential unavailable";
          return Response.json(
            { error: { message: "ChatGPT credential unavailable", type: "authentication_error", code: "credential_unavailable" } },
            { status: 401 },
          );
        }
        const capabilities = { solAvailable: config.solAvailable ?? true, proAvailable: config.proAvailable ?? true };

        const retryLimit = config.transientRetryLimit === 0
          ? 1
          : (config.transientRetryLimit !== undefined && config.transientRetryLimit < 0)
            ? 1
            : (config.transientRetryLimit ?? 5);

        const injectedSleepMs = config.retrySleepMs !== undefined
          ? config.retrySleepMs
          : (process.env.NODE_ENV === "test" ? 1 : undefined);

        const retrySleep = injectedSleepMs !== undefined
          ? async () => {
              if (injectedSleepMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, injectedSleepMs));
              }
            }
          : undefined;

        try {
          const response = await withTransientRetry(
            async (_attempt) => {
              const clonedStandard = JSON.parse(JSON.stringify(standard)) as Record<string, unknown>;
              const native = toNativeRequest(
                mapRequestModel(clonedStandard, capabilities),
                { ...(config.defaultEnvironment ? { defaultEnvironment: config.defaultEnvironment } : {}) },
              );

              let upstream: Response;
              try {
                upstream = await fetch(`${upstreamBase}/v1/responses`, {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": req.headers.get("content-type") ?? "application/json",
                  },
                  body: JSON.stringify(native),
                });
              } catch (error) {
                const detail = error instanceof Error ? error.message : "upstream unreachable";
                throw new UpstreamNetworkError(detail);
              }

              const body = await upstream.text();
              const contentType = upstream.headers.get("content-type") ?? "application/json";

              if (upstream.status >= 400 && upstream.status < 500) {
                lastError = `upstream ${upstream.status}`;
                return new Response(body, { status: upstream.status, headers: { "content-type": contentType } });
              }

              if (upstream.status >= 500 || isTransientError(body)) {
                throw new UpstreamHttpFailure(upstream.status, body, contentType);
              }

              if (!upstream.ok) {
                lastError = `upstream ${upstream.status}`;
                return new Response(body, { status: upstream.status, headers: { "content-type": contentType } });
              }

              let parsed: unknown;
              try {
                parsed = JSON.parse(body);
              } catch {
                return new Response(body, { status: upstream.status, headers: { "content-type": contentType } });
              }

              const verdict = classifyEmptyCompletion(parsed);
              if (verdict.empty) {
                throw new EmptyTurnError(verdict.reason ?? "completed turn produced no output and no tool calls");
              }

              return new Response(body, { status: upstream.status, headers: { "content-type": contentType } });
            },
            {
              limit: retryLimit,
              sleep: retrySleep,
              isRetryable: (error: unknown) => {
                if (error instanceof UpstreamHttpFailure) {
                  return error.status >= 500 || isTransientError(error.body);
                }
                if (error instanceof EmptyTurnError) {
                  return true;
                }
                if (error instanceof UpstreamNetworkError) {
                  return isTransientError(error.detail);
                }
                return false;
              },
              onRetry: (attempt: number, message: string) => {
                const family = isTransientError(message)
                  ? "transient_error"
                  : message.includes("empty turn content")
                    ? "empty_turn_content"
                    : "upstream_http_5xx";
                console.warn(`[external-layer] transient retry attempt ${attempt}/${retryLimit} family=${family}`);
              },
            },
          );
          return response;
        } catch (error) {
          if (error instanceof UpstreamHttpFailure) {
            lastError = `upstream ${error.status}`;
            return new Response(error.body, { status: error.status, headers: { "content-type": error.contentType } });
          }
          if (error instanceof EmptyTurnError) {
            lastError = "empty turn content";
            return Response.json(
              {
                error: {
                  message: "ChatGPT completed turn produced empty content",
                  type: "server_error",
                  code: "empty_turn_content",
                },
                code: "empty_turn_content",
              },
              { status: 502 },
            );
          }
          if (error instanceof UpstreamNetworkError) {
            lastError = error.detail;
            return Response.json(
              {
                error: {
                  message: `ChatGPT Web upstream is unreachable: ${lastError}`,
                  type: "server_error",
                  code: "upstream_unreachable",
                },
              },
              { status: 502 },
            );
          }
          lastError = error instanceof Error ? error.message : String(error);
          return Response.json(
            { error: { message: `Internal server error: ${lastError}` } },
            { status: 500 },
          );
        }
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (!bearerMatches(req.headers.get("authorization"), config.apiKey)) return unauthorized();
        let token: string;
        try {
          token = await config.tokenProvider();
        } catch {
          lastError = "credential unavailable";
          return Response.json(
            { error: { message: "ChatGPT credential unavailable", type: "authentication_error", code: "credential_unavailable" } },
            { status: 401 },
          );
        }
        const upstream = await fetch(`${upstreamBase}/v1/models?client_version=0.0.0`, {
          headers: { authorization: `Bearer ${token}` },
        }).catch(() => undefined);
        if (!upstream || !upstream.ok) {
          lastError = `upstream models ${upstream?.status ?? "unreachable"}`;
          return Response.json(
            { error: { message: `ChatGPT Web model catalog is unavailable (${lastError})`, type: "server_error", code: "upstream_unreachable" } },
            { status: 502 },
          );
        }
        const upstreamCatalog = await upstream.json().catch(() => undefined);
        const catalog = unifiedCatalog(upstreamCatalog, {
          solAvailable: config.solAvailable ?? true,
          proAvailable: config.proAvailable ?? true,
        });
        return Response.json(catalog);
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ status: lastError ? "degraded" : "ok", requests, ...(lastError ? { last_error: lastError } : {}) });
      }
      return Response.json({ error: { message: `Unsupported route: ${req.method} ${url.pathname}` } }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      server.stop(true);
    },
  };
}
