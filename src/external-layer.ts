import { randomUUID, timingSafeEqual } from "node:crypto";
import { deriveIdempotencyKey, IdempotencyStore } from "./idempotency";
import {
  chatCompletionsToResponses,
  responsesToChatCompletions,
  transformResponsesStreamToChatStream,
} from "./chat-completions";
import { CHATGPT_WEB_DEFAULT_TIER_EFFORT, CHATGPT_WEB_LATEST_MODEL_ID, deriveTierWindows, tierSlugForEffort, unifiedCatalog, UnknownEffortError } from "./models";
import { classifyEmptyCompletion, isTransientError, withTransientRetry } from "./reliability";
import { resolveStallTimeoutSec, UpstreamStallError } from "./stall-timeout";
import { resolveToolTimeouts, type ToolTimeoutsConfig } from "./tool-timeouts";
import { readUpstreamBiggerContext, readUpstreamControlToken, resolveUpstreamHome } from "./upstream-home";

export { UpstreamStallError } from "./stall-timeout";

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
  /** Upstream directory containing config.json for experimentalBiggerContext */
  upstreamHome?: string;
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
  /** 覆盖静默预算（秒），经 resolveStallTimeoutSec 解析 */
  stallTimeoutSec?: number;
  /** 覆盖上游接单到首字节的预算（毫秒），缺省使用 toolTimeouts.generationTimeoutMs (300_000) */
  firstByteTimeoutMs?: number;
  /** 工具超时契约配置 */
  toolTimeouts?: Partial<ToolTimeoutsConfig>;
  /** 客户端断连时是否向 upstream 发送 POST /admin/interrupt-turn 中断上游回合。缺省 true。 */
  abortUpstreamTurns?: boolean;
}

export interface ExternalLayerHandle {
  baseUrl: string;
  stop: () => Promise<void>;
  stallTimeoutSec: number;
  firstByteTimeoutMs: number;
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

class ClientAbortedError extends Error {
  constructor() {
    super("client aborted request");
    this.name = "ClientAbortedError";
  }
}

function extractTurnIdentity(native: Record<string, unknown>): { threadId: string; turnId: string } | null {
  if (!isRecord(native.client_metadata)) return null;
  const raw = native.client_metadata["x-codex-turn-metadata"];
  let meta: Record<string, unknown> | null = null;
  if (isRecord(raw)) {
    meta = raw;
  } else if (typeof raw === "string") {
    try {
      meta = JSON.parse(raw);
    } catch {
      meta = null;
    }
  }
  if (!meta) return null;
  const threadId = typeof meta.thread_id === "string" ? meta.thread_id : "";
  const turnId = typeof meta.turn_id === "string" ? meta.turn_id : "";
  if (threadId && turnId) {
    return { threadId, turnId };
  }
  return null;
}

async function interruptUpstreamTurn(
  upstreamBaseUrl: string,
  upstreamHome: string | undefined,
  identity: { threadId: string; turnId: string },
): Promise<void> {
  try {
    const effectiveHome = resolveUpstreamHome(upstreamHome);
    const controlToken = readUpstreamControlToken(effectiveHome);
    if (!controlToken) {
      return;
    }
    const res = await fetch(`${upstreamBaseUrl.replace(/\/+$/, "")}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        threadId: identity.threadId,
        turnId: identity.turnId,
      }),
    });
    await res.text().catch(() => {});
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[external-layer] failed to interrupt upstream turn: ${msg.replace(/ctl-[A-Za-z0-9]+/g, "[REDACTED]")}`);
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

interface MappedModelResult {
  mapped: Record<string, unknown>;
  resolvedSlug: string;
  resolvedEffort: string;
}

function resolveRequestModel(
  standard: Record<string, unknown>,
  capabilities: { solAvailable: boolean; proAvailable: boolean },
): MappedModelResult {
  const model = typeof standard.model === "string" ? standard.model : "";
  if (model !== CHATGPT_WEB_LATEST_MODEL_ID) {
    return { mapped: standard, resolvedSlug: model, resolvedEffort: CHATGPT_WEB_DEFAULT_TIER_EFFORT };
  }
  const reasoning = isRecord(standard.reasoning) ? standard.reasoning : undefined;
  const nested = reasoning && typeof reasoning.effort === "string" ? reasoning.effort : undefined;
  const flat = typeof standard.reasoning_effort === "string" ? standard.reasoning_effort : undefined;
  const effort = nested ?? flat;
  const slug = tierSlugForEffort(effort, capabilities);
  return {
    mapped: { ...standard, model: slug },
    resolvedSlug: slug,
    resolvedEffort: effort ?? CHATGPT_WEB_DEFAULT_TIER_EFFORT,
  };
}

/** Client-visible unified model ids do not exist upstream; the advertised effort picks the concrete
 * upstream tier slug instead. Non-unified ids (already a tier slug) pass through.
 * Standard Responses spells the knob `reasoning.effort`, but plenty of callers (and our own
 * chat-completions bridge) send the flat `reasoning_effort`: honour both, nested first, so a
 * tier request is never silently dropped. */
function mapRequestModel(standard: Record<string, unknown>, capabilities: { solAvailable: boolean; proAvailable: boolean }): Record<string, unknown> {
  return resolveRequestModel(standard, capabilities).mapped;
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

/** 流内静默看门狗：上游 2xx 流式转发时，若连续 stallTimeoutSec 秒没有收到任何字节，中止上游 stream 并报错。 */
function withStreamStallWatchdog(
  source: ReadableStream<Uint8Array>,
  timeoutSec: number,
): ReadableStream<Uint8Array> {
  const timeoutMs = timeoutSec * 1000;
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cleanupTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          let timedOut = false;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              cleanupTimer();
              console.warn(`[external-layer] upstream stall: kind=stream_stall budget=${timeoutSec}s`);
              reject(
                new UpstreamStallError(
                  "stream_stall",
                  timeoutMs,
                  `ChatGPT Web upstream stream stalled: no data for ${timeoutSec}s`,
                ),
              );
            }, timeoutMs);
          });

          try {
            const { done, value } = await Promise.race([reader.read(), timeoutPromise]);
            cleanupTimer();
            if (done) {
              try {
                controller.close();
              } catch {}
              break;
            }
            if (value) {
              controller.enqueue(value);
            }
          } catch (readErr) {
            cleanupTimer();
            if (timedOut) {
              reader.cancel(readErr).catch(() => {});
            }
            throw readErr;
          }
        }
      } catch (error) {
        cleanupTimer();
        try {
          controller.error(error);
        } catch {}
      }
    },
    async cancel(reason) {
      cleanupTimer();
      await reader.cancel(reason).catch(() => {});
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
            try {
              controller.close();
            } catch {}
            break;
          }
          if (value) {
            if (decoder.decode(value, { stream: true }).includes("[DONE]")) sawTerminalMarker = true;
            controller.enqueue(value);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof UpstreamStallError) && !message.includes("Controller is already closed")) {
          console.warn(`[external-layer] upstream stream failed mid-flight: ${message}`);
        }
        try {
          if (!sawTerminalMarker) controller.enqueue(frame(message));
          controller.close();
        } catch {}
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

function withClientAbortTermination(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onAbort?: () => void,
  onComplete?: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let terminated = false;
      const abortHandler = () => {
        if (terminated) return;
        terminated = true;
        if (onAbort) onAbort();
        try {
          controller.close();
        } catch {}
        reader.cancel("client aborted").catch(() => {});
      };

      if (signal.aborted) {
        abortHandler();
        return;
      }

      signal.addEventListener("abort", abortHandler, { once: true });

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            terminated = true;
            signal.removeEventListener("abort", abortHandler);
            if (onComplete) onComplete();
            try {
              controller.close();
            } catch {}
            break;
          }
          if (signal.aborted) {
            abortHandler();
            break;
          }
          if (value) {
            try {
              controller.enqueue(value);
            } catch {
              abortHandler();
              break;
            }
          }
        }
      } catch (error) {
        signal.removeEventListener("abort", abortHandler);
        if (signal.aborted) {
          abortHandler();
        } else {
          try {
            controller.error(error);
          } catch {}
        }
      } finally {
        signal.removeEventListener("abort", abortHandler);
        reader.cancel("stream ended").catch(() => {});
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

export async function startExternalLayer(config: ExternalLayerConfig): Promise<ExternalLayerHandle> {
  const resolvedToolTimeouts = resolveToolTimeouts(config.toolTimeouts, "external layer config");
  const effectiveStallTimeoutSec = resolveStallTimeoutSec(config.stallTimeoutSec);
  const effectiveFirstByteTimeoutMs = config.firstByteTimeoutMs !== undefined
    ? config.firstByteTimeoutMs
    : resolvedToolTimeouts.generationTimeoutMs;

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

        // Resolve the tier before any upstream turn is opened: a request naming an unsupported
        // effort must fail loud, never be answered by a different tier than the client picked.
        let mappedResolution: MappedModelResult;
        try {
          mappedResolution = resolveRequestModel(standard, capabilities);
        } catch (error) {
          if (error instanceof UnknownEffortError) {
            return Response.json(
              {
                error: {
                  message: error.message,
                  type: "invalid_request_error",
                  code: "invalid_reasoning_effort",
                },
              },
              { status: 400 },
            );
          }
          throw error;
        }

        let contextWindowHeaderValue: string | undefined;
        if (config.upstreamHome !== undefined) {
          const upstreamModelsRes = await fetch(`${upstreamBase}/v1/models?client_version=0.0.0`, {
            headers: { authorization: `Bearer ${token}` },
          }).catch(() => undefined);
          if (upstreamModelsRes && upstreamModelsRes.ok) {
            const upstreamCatalog = await upstreamModelsRes.json().catch(() => undefined);
            const derived = deriveTierWindows(upstreamCatalog, capabilities);
            const matchedTier = (mappedResolution.resolvedEffort && derived.tiers[mappedResolution.resolvedEffort])
              ? derived.tiers[mappedResolution.resolvedEffort]
              : Object.values(derived.tiers).find(t => t.slug === mappedResolution.resolvedSlug);
            if (matchedTier?.context_window !== undefined && matchedTier?.context_window !== null) {
              contextWindowHeaderValue = String(matchedTier.context_window);
            }
          }
        }

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
        const abortUpstreamTurns = config.abortUpstreamTurns !== false;
        let currentTurnIdentity: { threadId: string; turnId: string } | null = null;
        let turnCompleted = false;
        let interruptDispatched = false;
        let currentAbortController: AbortController | null = null;

        const triggerInterrupt = async () => {
          if (!abortUpstreamTurns || turnCompleted || interruptDispatched) return;
          if (!currentTurnIdentity) return;
          interruptDispatched = true;
          if (currentAbortController) {
            try {
              currentAbortController.abort("client aborted");
            } catch {}
          }
          await interruptUpstreamTurn(upstreamBase, config.upstreamHome, currentTurnIdentity);
        };

        const onClientAbort = () => {
          triggerInterrupt().catch(() => {});
        };

        if (abortUpstreamTurns) {
          if (req.signal.aborted) {
            onClientAbort();
          } else {
            req.signal.addEventListener("abort", onClientAbort, { once: true });
          }
        }

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
                if (abortUpstreamTurns && req.signal.aborted) {
                  triggerInterrupt().catch(() => {});
                  throw new ClientAbortedError();
                }
                const clonedStandard = JSON.parse(JSON.stringify(mappedResolution.mapped)) as Record<string, unknown>;
                const native = toNativeRequest(
                  clonedStandard,
                  { ...(config.defaultEnvironment ? { defaultEnvironment: config.defaultEnvironment } : {}) },
                );
                const turnMeta = extractTurnIdentity(native);
                if (turnMeta) {
                  currentTurnIdentity = turnMeta;
                }
                if (abortUpstreamTurns && req.signal.aborted) {
                  triggerInterrupt().catch(() => {});
                  throw new ClientAbortedError();
                }

                const abortController = new AbortController();
                if (abortUpstreamTurns) {
                  currentAbortController = abortController;
                }
                let timedOut = false;
                const timer = setTimeout(() => {
                  timedOut = true;
                  abortController.abort();
                }, effectiveFirstByteTimeoutMs);

                let upstream: Response;
                try {
                  upstream = await fetch(`${upstreamBase}/v1/responses`, {
                    method: "POST",
                    headers: {
                      authorization: `Bearer ${token}`,
                      "content-type": req.headers.get("content-type") ?? "application/json",
                    },
                    body: JSON.stringify(native),
                    signal: abortController.signal,
                  });
                } catch (error) {
                  if (abortUpstreamTurns && req.signal.aborted) {
                    throw new ClientAbortedError();
                  }
                  if (timedOut || abortController.signal.aborted) {
                    throw new UpstreamStallError(
                      "first_byte",
                      effectiveFirstByteTimeoutMs,
                      `ChatGPT Web upstream stalled waiting for first byte (budget: ${effectiveFirstByteTimeoutMs}ms)`,
                    );
                  }
                  const detail = error instanceof Error ? error.message : "upstream unreachable";
                  throw new UpstreamNetworkError(detail);
                } finally {
                  clearTimeout(timer);
                  if (currentAbortController === abortController) {
                    currentAbortController = null;
                  }
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
                  if (error instanceof ClientAbortedError || (abortUpstreamTurns && req.signal.aborted)) {
                    return false;
                  }
                  if (error instanceof UpstreamStallError && error.kind === "first_byte") {
                    return true;
                  }
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
                onRetry: (attempt: number, message: string, error?: unknown) => {
                  if (error instanceof UpstreamStallError) {
                    console.warn(
                      `[external-layer] upstream stall: kind=${error.kind} budget=${error.budgetMs}ms attempt=${attempt}/${retryLimit}`,
                    );
                    return;
                  }
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
            if (error instanceof ClientAbortedError || (abortUpstreamTurns && req.signal.aborted)) {
              turnCompleted = true;
              if (abortUpstreamTurns) {
                req.signal.removeEventListener("abort", onClientAbort);
              }
              return new Response(null, { status: 499 });
            }
            if (error instanceof UpstreamStallError) {
              lastError = `upstream stall timeout (${error.kind})`;
              turnResult = {
                status: 504,
                bodyText: JSON.stringify({
                  error: {
                    message: `ChatGPT Web upstream stalled: ${error.message}`,
                    type: "server_error",
                    code: "upstream_stall_timeout",
                  },
                  code: "upstream_stall_timeout",
                }),
                contentType: "application/json",
              };
            } else if (error instanceof UpstreamHttpFailure) {
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
          const watchdogStream = withStreamStallWatchdog(turnResult.bodyStream, effectiveStallTimeoutSec);
          const recordedStream = tapStream(watchdogStream, (fullText) => {
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
            const wrappedStream = abortUpstreamTurns
              ? withClientAbortTermination(clientStream, req.signal, onClientAbort, () => {
                  turnCompleted = true;
                })
              : clientStream;
            return new Response(wrappedStream, {
              status: 200,
              headers: {
                "content-type": turnResult.contentType,
                ...(contextWindowHeaderValue ? { "x-ext-layer-context-window": contextWindowHeaderValue } : {}),
              },
            });
          } else {
            const chatStream = transformResponsesStreamToChatStream(recordedStream, requestedModel);
            const wrappedStream = abortUpstreamTurns
              ? withClientAbortTermination(chatStream, req.signal, onClientAbort, () => {
                  turnCompleted = true;
                })
              : chatStream;
            return new Response(wrappedStream, {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                ...(contextWindowHeaderValue ? { "x-ext-layer-context-window": contextWindowHeaderValue } : {}),
              },
            });
          }
        }

        // 非流式请求
        const result = await idempotencyStore.runWithDeduplication(idempotencyKey, async () => {
          try {
            const response = await withTransientRetry(
              async (_attempt) => {
                if (abortUpstreamTurns && req.signal.aborted) {
                  triggerInterrupt().catch(() => {});
                  throw new ClientAbortedError();
                }
                const clonedStandard = JSON.parse(JSON.stringify(mappedResolution.mapped)) as Record<string, unknown>;
                const native = toNativeRequest(
                  clonedStandard,
                  { ...(config.defaultEnvironment ? { defaultEnvironment: config.defaultEnvironment } : {}) },
                );
                const turnMeta = extractTurnIdentity(native);
                if (turnMeta) {
                  currentTurnIdentity = turnMeta;
                }
                if (abortUpstreamTurns && req.signal.aborted) {
                  triggerInterrupt().catch(() => {});
                  throw new ClientAbortedError();
                }

                const abortController = new AbortController();
                if (abortUpstreamTurns) {
                  currentAbortController = abortController;
                }
                let timedOut = false;
                const timer = setTimeout(() => {
                  timedOut = true;
                  abortController.abort();
                }, effectiveFirstByteTimeoutMs);

                let upstream: Response;
                try {
                  upstream = await fetch(`${upstreamBase}/v1/responses`, {
                    method: "POST",
                    headers: {
                      authorization: `Bearer ${token}`,
                      "content-type": req.headers.get("content-type") ?? "application/json",
                    },
                    body: JSON.stringify(native),
                    signal: abortController.signal,
                  });
                } catch (error) {
                  if (abortUpstreamTurns && req.signal.aborted) {
                    throw new ClientAbortedError();
                  }
                  if (timedOut || abortController.signal.aborted) {
                    throw new UpstreamStallError(
                      "first_byte",
                      effectiveFirstByteTimeoutMs,
                      `ChatGPT Web upstream stalled waiting for first byte (budget: ${effectiveFirstByteTimeoutMs}ms)`,
                    );
                  }
                  const detail = error instanceof Error ? error.message : "upstream unreachable";
                  throw new UpstreamNetworkError(detail);
                } finally {
                  clearTimeout(timer);
                  if (currentAbortController === abortController) {
                    currentAbortController = null;
                  }
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
                  if (error instanceof ClientAbortedError || (abortUpstreamTurns && req.signal.aborted)) {
                    return false;
                  }
                  if (error instanceof UpstreamStallError && error.kind === "first_byte") {
                    return true;
                  }
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
                onRetry: (attempt: number, message: string, error?: unknown) => {
                  if (error instanceof UpstreamStallError) {
                    console.warn(
                      `[external-layer] upstream stall: kind=${error.kind} budget=${error.budgetMs}ms attempt=${attempt}/${retryLimit}`,
                    );
                    return;
                  }
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
            if (error instanceof ClientAbortedError || (abortUpstreamTurns && req.signal.aborted)) {
              lastError = "client aborted";
              return { status: 499, body: "", contentType: "application/json" };
            }
            if (error instanceof UpstreamStallError) {
              lastError = `upstream stall timeout (${error.kind})`;
              return {
                status: 504,
                body: JSON.stringify({
                  error: {
                    message: `ChatGPT Web upstream stalled: ${error.message}`,
                    type: "server_error",
                    code: "upstream_stall_timeout",
                  },
                  code: "upstream_stall_timeout",
                }),
                contentType: "application/json",
              };
            }
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

        if (abortUpstreamTurns && (req.signal.aborted || result.status === 499)) {
          turnCompleted = true;
          req.signal.removeEventListener("abort", onClientAbort);
          return new Response(null, { status: 499 });
        }

        turnCompleted = true;
        if (abortUpstreamTurns) {
          req.signal.removeEventListener("abort", onClientAbort);
        }

        if (isChatCompletions && result.status === 200) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(result.body);
          } catch {
            parsed = {};
          }
          const chatJson = responsesToChatCompletions(parsed, requestedModel);
          return Response.json(chatJson, {
            headers: {
              ...(contextWindowHeaderValue ? { "x-ext-layer-context-window": contextWindowHeaderValue } : {}),
            },
          });
        }

        return new Response(result.body, {
          status: result.status,
          headers: {
            "content-type": result.contentType,
            ...(result.status === 200 && contextWindowHeaderValue ? { "x-ext-layer-context-window": contextWindowHeaderValue } : {}),
          },
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/context") {
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
        const capabilities = {
          solAvailable: config.solAvailable ?? true,
          proAvailable: config.proAvailable ?? true,
        };
        const derived = deriveTierWindows(upstreamCatalog, capabilities);
        const effectiveHome = resolveUpstreamHome(config.upstreamHome);
        const biggerContext = readUpstreamBiggerContext(effectiveHome);
        const defaultTierWindow = derived.tiers[derived.latestEffort];
        const latestContextWindow = typeof defaultTierWindow?.context_window === "number"
          ? defaultTierWindow.context_window
          : null;
        return Response.json({
          object: "context",
          model: CHATGPT_WEB_LATEST_MODEL_ID,
          latest_effort: derived.latestEffort,
          bigger_context: biggerContext,
          latest_context_window: latestContextWindow,
          source: derived.source,
          tiers: derived.tiers,
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
    stallTimeoutSec: effectiveStallTimeoutSec,
    firstByteTimeoutMs: effectiveFirstByteTimeoutMs,
  };
}
