import { randomUUID, timingSafeEqual } from "node:crypto";
import { deriveIdempotencyKey, IdempotencyStore } from "./idempotency";
import {
  chatCompletionsToResponses,
  responsesToChatCompletions,
  transformResponsesStreamToChatStream,
} from "./chat-completions";
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
  /** 幂等状态 JSON 文件；缺省 = 仅内存 */
  statePath?: string;
  /** 幂等回放 TTL 毫秒；缺省 600000；0 = 关闭回放 */
  idempotencyTtlMs?: number;
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
    const envelope = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: environmentEnvelope(options.defaultEnvironment) }],
      internal_chat_message_metadata_passthrough: { thread_id: threadId, turn_id: turnId },
    };
    // The upstream resolves turn trust from the environment text found BEFORE the ACTIVE user
    // instruction (the last user item, `rawEnvironmentText` in adapters/chatgpt-web/environment.ts).
    // Unshifting only works while the input holds a single user message; with tool results and a
    // trailing instruction in the same array the parse finds nothing and the turn is rejected at
    // 0ms with "missing cwd in trusted Codex environment context". Insert directly before the
    // active user item instead.
    let activeUserIndex = -1;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index]?.role === "user") {
        activeUserIndex = index;
        break;
      }
    }
    if (activeUserIndex <= 0) items.unshift(envelope);
    else items.splice(activeUserIndex, 0, envelope);
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

function tapStream(
  source: ReadableStream<Uint8Array>,
  onComplete: (fullText: string) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            onComplete(accumulated);
            break;
          }
          if (value) {
            accumulated += decoder.decode(value, { stream: true });
            controller.enqueue(value);
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/** Terminate an in-flight SSE response with an explicit error frame rather than a broken transfer. */
function terminateOnStreamFailure(
  source: ReadableStream<Uint8Array>,
  frame: (message: string) => Uint8Array,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let sawTerminalMarker = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            break;
          }
          if (value) {
            if (decoder.decode(value, { stream: true }).includes("[DONE]")) sawTerminalMarker = true;
            controller.enqueue(value);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[external-layer] upstream stream failed mid-flight: ${message}`);
        if (!sawTerminalMarker) controller.enqueue(frame(message));
        controller.close();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

export async function startExternalLayer(config: ExternalLayerConfig): Promise<ExternalLayerHandle> {
  if (!process.env.NO_PROXY && (process.env.HTTP_PROXY || process.env.HTTPS_PROXY)) {
    process.env.NO_PROXY = "127.0.0.1,localhost";
  }

  let requests = 0;
  let lastError: string | undefined;
  const upstreamBase = config.upstreamBaseUrl.replace(/\/+$/, "");
  const idempotencyStore = new IdempotencyStore(config);

  const server = Bun.serve({
    port: config.port ?? 0,
    // Bun closes an idle socket after 10s by default, which kills a long-thinking SSE turn:
    // the upstream can sit behind its own heartbeats for minutes before the first delta.
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);
      const isResponses = req.method === "POST" && url.pathname === "/v1/responses";
      const isChatCompletions = req.method === "POST" && url.pathname === "/v1/chat/completions";

      if (isResponses || isChatCompletions) {
        if (!bearerMatches(req.headers.get("authorization"), config.apiKey)) return unauthorized();
        requests += 1;
        let rawBody: Record<string, unknown>;
        try {
          rawBody = (await req.json()) as Record<string, unknown>;
        } catch {
          return Response.json({ error: { message: "ChatGPT Web facade requires a JSON request body" } }, { status: 400 });
        }

        let standard: Record<string, unknown>;
        let requestedModel: string;
        if (isChatCompletions) {
          requestedModel = typeof rawBody.model === "string" ? rawBody.model : "chatgpt-web/latest";
          standard = chatCompletionsToResponses(rawBody);
        } else {
          standard = rawBody;
          requestedModel = typeof standard.model === "string" ? standard.model : "chatgpt-web/latest";
        }

        const isStreaming = Boolean(standard.stream);
        const idempotencyKey = deriveIdempotencyKey(req.headers.get("idempotency-key"), standard);

        const cached = idempotencyStore.get(idempotencyKey);
        if (cached) {
          if (isResponses) {
            return new Response(cached.body, {
              status: cached.status,
              headers: {
                "content-type": cached.contentType,
                "x-ext-layer-replay": "true",
              },
            });
          } else {
            // isChatCompletions
            if (!isStreaming) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(cached.body);
              } catch {
                parsed = {};
              }
              const chatJson = responsesToChatCompletions(parsed, requestedModel);
              return Response.json(chatJson, {
                status: cached.status,
                headers: { "x-ext-layer-replay": "true" },
              });
            } else {
              const replayStream = transformResponsesStreamToChatStream(
                new ReadableStream({
                  start(c) {
                    c.enqueue(new TextEncoder().encode(cached.body));
                    c.close();
                  },
                }),
                requestedModel,
              );
              return new Response(replayStream, {
                status: cached.status,
                headers: {
                  "content-type": "text/event-stream",
                  "x-ext-layer-replay": "true",
                },
              });
            }
          }
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

        if (isStreaming) {
          interface UpstreamStreamResult {
            status: number;
            bodyStream?: ReadableStream<Uint8Array>;
            bodyText?: string;
            contentType: string;
          }

          let turnResult: UpstreamStreamResult;
          try {
            turnResult = await withTransientRetry<UpstreamStreamResult>(
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

                const contentType = upstream.headers.get("content-type") ?? "application/json";

                if (upstream.status >= 400 && upstream.status < 500) {
                  lastError = `upstream ${upstream.status}`;
                  const bodyText = await upstream.text();
                  return { status: upstream.status, bodyText, contentType };
                }

                if (upstream.status >= 500) {
                  const bodyText = await upstream.text();
                  throw new UpstreamHttpFailure(upstream.status, bodyText, contentType);
                }

                // 2xx 成功：流式边到边转发，不读 bodyText
                return { status: upstream.status, bodyStream: upstream.body!, contentType };
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
          } catch (error) {
            if (error instanceof UpstreamHttpFailure) {
              lastError = `upstream ${error.status}`;
              turnResult = { status: error.status, bodyText: error.body, contentType: error.contentType };
            } else if (error instanceof UpstreamNetworkError) {
              lastError = error.detail;
              turnResult = {
                status: 502,
                bodyText: JSON.stringify({
                  error: {
                    message: `ChatGPT Web upstream is unreachable: ${lastError}`,
                    type: "server_error",
                    code: "upstream_unreachable",
                  },
                }),
                contentType: "application/json",
              };
            } else {
              lastError = error instanceof Error ? error.message : String(error);
              turnResult = {
                status: 500,
                bodyText: JSON.stringify({ error: { message: `Internal server error: ${lastError}` } }),
                contentType: "application/json",
              };
            }
          }

          if (turnResult.status >= 400 || !turnResult.bodyStream) {
            return new Response(turnResult.bodyText, {
              status: turnResult.status,
              headers: { "content-type": turnResult.contentType },
            });
          }

          // Record the upstream SSE text for BOTH routes: a chat client may replay the
          // same key later (and a Responses replay of a chat-opened turn must be
          // byte-identical), so the idempotency record is written from one tap that
          // sits upstream of the client-specific transform.
          const recordedStream = tapStream(turnResult.bodyStream, (fullText) => {
            idempotencyStore.save(idempotencyKey, {
              status: 200,
              body: fullText,
              contentType: turnResult.contentType,
            });
          });

          if (isResponses) {
            const clientStream = terminateOnStreamFailure(recordedStream, (message) =>
              new TextEncoder().encode(
                `event: error\ndata: ${JSON.stringify({ type: "error", message: `ChatGPT Web upstream stream failed: ${message}` })}\n\ndata: [DONE]\n\n`,
              ),
            );
            return new Response(clientStream, {
              status: 200,
              headers: { "content-type": turnResult.contentType },
            });
          } else {
            const chatStream = transformResponsesStreamToChatStream(recordedStream, requestedModel);
            return new Response(chatStream, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          }
        }

        // 非流式请求
        const result = await idempotencyStore.runWithDeduplication(idempotencyKey, async () => {
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
                  return { status: upstream.status, body, contentType };
                }

                if (upstream.status >= 500 || isTransientError(body)) {
                  throw new UpstreamHttpFailure(upstream.status, body, contentType);
                }

                if (!upstream.ok) {
                  lastError = `upstream ${upstream.status}`;
                  return { status: upstream.status, body, contentType };
                }

                let parsed: unknown;
                try {
                  parsed = JSON.parse(body);
                } catch {
                  return { status: upstream.status, body, contentType };
                }

                const verdict = classifyEmptyCompletion(parsed);
                if (verdict.empty) {
                  throw new EmptyTurnError(verdict.reason ?? "completed turn produced no output and no tool calls");
                }

                return { status: upstream.status, body, contentType };
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
              return { status: error.status, body: error.body, contentType: error.contentType };
            }
            if (error instanceof EmptyTurnError) {
              lastError = "empty turn content";
              return {
                status: 502,
                body: JSON.stringify({
                  error: {
                    message: "ChatGPT completed turn produced empty content",
                    type: "server_error",
                    code: "empty_turn_content",
                  },
                  code: "empty_turn_content",
                }),
                contentType: "application/json",
              };
            }
            if (error instanceof UpstreamNetworkError) {
              lastError = error.detail;
              return {
                status: 502,
                body: JSON.stringify({
                  error: {
                    message: `ChatGPT Web upstream is unreachable: ${lastError}`,
                    type: "server_error",
                    code: "upstream_unreachable",
                  },
                }),
                contentType: "application/json",
              };
            }
            lastError = error instanceof Error ? error.message : String(error);
            return {
              status: 500,
              body: JSON.stringify({ error: { message: `Internal server error: ${lastError}` } }),
              contentType: "application/json",
            };
          }
        });

        if (isChatCompletions && result.status === 200) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(result.body);
          } catch {
            parsed = {};
          }
          const chatJson = responsesToChatCompletions(parsed, requestedModel);
          return Response.json(chatJson);
        }

        return new Response(result.body, {
          status: result.status,
          headers: { "content-type": result.contentType },
        });
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
