import { randomUUID, timingSafeEqual } from "node:crypto";
import { ConversationRegistry } from "./conversation-registry";
import { createFailureBreaker, estimatePayloadChars, type FailureBreakerConfig } from "./failure-breaker";
import { deriveIdempotencyKey, IdempotencyStore } from "./idempotency";
import {
  chatCompletionsToResponses,
  responsesToChatCompletions,
  transformResponsesStreamToChatStream,
} from "./chat-completions";
import {
  CHATGPT_WEB_DEFAULT_TIER_EFFORT,
  CHATGPT_WEB_LATEST_MODEL_ID,
  CHATGPT_WEB_UNIFIED_TIERS,
  ConflictingTierError,
  defaultEffortFor,
  deriveTierWindows,
  TierUnavailableError,
  tierForEffort,
  tierSlugForEffort,
  unifiedCatalog,
  UnknownEffortError,
} from "./models";
import {
  classifyEmptyCompletion,
  errorText,
  isNavigationError,
  isTransientError,
  navigationErrorPattern,
  withTransientRetry,
} from "./reliability";
import { resolveProgressTimeoutMs, resolveStallTimeoutSec, UpstreamStallError } from "./stall-timeout";
import { resolveToolTimeouts, type ToolTimeoutsConfig } from "./tool-timeouts";
import {
  readUpstreamBiggerContext,
  readUpstreamControlToken,
  resolveAccountCapabilities,
  resolveUpstreamHome,
} from "./upstream-home";


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
  /** 重试上限（生成阶段；缺省 1 = 交客户端重试；0/负数同 1）。 */
  transientRetryLimit?: number;
  /** 重试等待时间毫秒（测试注入；缺省走 2000*attempt 退避）。 */
  retrySleepMs?: number;
  /** 导航阶段（page.goto 网络闪断，回合第 0 秒即死、零成本）的独立重试预算；缺省 2，0 = 关闭。
   * 与 transientRetryLimit 互相独立：瞬时族不占导航预算，导航失败不占瞬时预算。 */
  navigationRetryLimit?: number;
  /** 幂等状态 JSON 文件；缺省 = 仅内存 */
  statePath?: string;
  /** 幂等回放 TTL 毫秒；缺省 600000；0 = 关闭回放 */
  idempotencyTtlMs?: number;
  /** 覆盖静默预算（秒），经 resolveStallTimeoutSec 解析 */
  stallTimeoutSec?: number;
  /** 覆盖上游接单到首字节的预算（毫秒）；未设时跟随 progressTimeoutMs 的有效值（同一把“多久没真东西”的尺） */
  firstByteTimeoutMs?: number;
  /** progress deadline for a turn that produces no content-bearing frame; default 240000 ms */
  progressTimeoutMs?: number;
  /** 工具超时契约配置 */
  toolTimeouts?: Partial<ToolTimeoutsConfig>;
  /** 客户端断连时是否向 upstream 发送 POST /admin/interrupt-turn 中断上游回合。缺省 true。 */
  abortUpstreamTurns?: boolean;
  /** 是否开启对话接续（复用同一个 upstream thread_id），缺省 true */
  continuation?: boolean;
  /** 对话注册表 LRU 容量上限，缺省 64 */
  conversationLimit?: number;
  /** 对话注册表持久化路径 */
  conversationsPath?: string;
  /** 失败熔断（W24）：同一会话连续大载荷失败后立即 429 拒绝，给出「新开会话/压缩」的行动指引 */
  failureBreaker?: FailureBreakerConfig;
}

export interface ExternalLayerHandle {
  baseUrl: string;
  stop: () => Promise<void>;
  stallTimeoutSec: number;
  firstByteTimeoutMs: number;
  progressTimeoutMs?: number;
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

/** Best-effort budget for `POST /admin/interrupt-turn`; the cancel must never outlive the request. */
const INTERRUPT_TIMEOUT_MS = 3_000;

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
      // The cancel is best-effort: a hung admin endpoint must never hold a request (or the
      // error frame the client is waiting for) open.
      signal: AbortSignal.timeout(INTERRUPT_TIMEOUT_MS),
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
  options: {
    defaultEnvironment?: DefaultEnvironmentConfig;
    identity?: { threadId: string; turnId: string };
  } = {},
): Record<string, unknown> {
  const turnId = options.identity?.turnId ?? `prov-${randomUUID()}`;
  const threadId = options.identity?.threadId ?? `prov-${randomUUID()}`;
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
  const model = typeof standard.model === "string" ? standard.model.trim() : "";
  const reasoning = isRecord(standard.reasoning) ? standard.reasoning : undefined;
  const nested = reasoning && typeof reasoning.effort === "string" ? reasoning.effort : undefined;
  const flat = typeof standard.reasoning_effort === "string" ? standard.reasoning_effort : undefined;
  const effort = nested ?? flat;

  const defaultEffort = defaultEffortFor(capabilities);

  const matchingTier = CHATGPT_WEB_UNIFIED_TIERS.find(tier => tier.slug === model);
  if (matchingTier) {
    if (effort !== undefined) {
      const effortTier = tierForEffort(effort);
      if (effortTier.slug !== matchingTier.slug) {
        throw new ConflictingTierError(model, effort);
      }
      if (effortTier.requiresPro && !capabilities.proAvailable) {
        throw new TierUnavailableError(effortTier.slug);
      }
    }
    if (matchingTier.requiresPro && !capabilities.proAvailable) {
      throw new TierUnavailableError(matchingTier.slug);
    }
    return {
      mapped: standard,
      resolvedSlug: matchingTier.slug,
      resolvedEffort: matchingTier.effort,
    };
  }

  if (model === CHATGPT_WEB_LATEST_MODEL_ID) {
    if (effort !== undefined) {
      const effortTier = tierForEffort(effort);
      if (effortTier.requiresPro && !capabilities.proAvailable) {
        throw new TierUnavailableError(effortTier.slug);
      }
      return {
        mapped: { ...standard, model: effortTier.slug },
        resolvedSlug: effortTier.slug,
        resolvedEffort: effortTier.effort,
      };
    }
    const defaultSlug = tierSlugForEffort(undefined, capabilities);
    return {
      mapped: { ...standard, model: defaultSlug },
      resolvedSlug: defaultSlug,
      resolvedEffort: defaultEffort,
    };
  }

  return {
    mapped: standard,
    resolvedSlug: model,
    resolvedEffort: defaultEffort,
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

const PROGRESS_MARKERS = [
  "output_text.delta",
  "function_call",
  "reasoning_summary_text.delta",
  "reasoning_text.delta",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "[DONE]",
];

function extractResponseIdFromSse(fullText: string): string | undefined {
  const lines = fullText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:") && !trimmed.includes("[DONE]")) {
      try {
        const jsonStr = trimmed.slice(5).trim();
        const data = JSON.parse(jsonStr) as Record<string, unknown>;
        if (typeof data.id === "string") return data.id;
        if (data.response && typeof (data.response as Record<string, unknown>).id === "string") {
          return (data.response as Record<string, unknown>).id as string;
        }
      } catch {}
    }
  }
  return undefined;
}

/**
 * 流内容进度看门狗：上游 2xx 流式转发时，维护双重守卫：
 * 1. 字节静默守卫（stallTimeoutSec，kind="stream_stall"）：连续 stallTimeoutSec 秒未收到任何字节则报错；
 * 2. 内容进度守卫（progressTimeoutMs，kind="no_progress"）：连续 progressTimeoutMs 毫秒未收到任何 progress marker 则报错。
 */
function withContentProgressWatchdog(
  source: ReadableStream<Uint8Array>,
  stallTimeoutSec: number,
  progressTimeoutMs: number,
): ReadableStream<Uint8Array> {
  const stallTimeoutMs = stallTimeoutSec * 1000;
  const reader = source.getReader();

  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutReject: ((reason: Error) => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutReject = reject;
  });

  function cleanupTimers() {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
    if (progressTimer !== undefined) {
      clearTimeout(progressTimer);
      progressTimer = undefined;
    }
  }

  function resetStallTimer() {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      cleanupTimers();
      console.warn(`[external-layer] upstream stall: kind=stream_stall budget=${stallTimeoutSec}s`);
      timeoutReject?.(
        new UpstreamStallError(
          "stream_stall",
          stallTimeoutMs,
          `ChatGPT Web upstream stream stalled: no data for ${stallTimeoutSec}s`,
        ),
      );
    }, stallTimeoutMs);
  }

  function resetProgressTimer() {
    if (progressTimer !== undefined) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      cleanupTimers();
      console.warn(`[external-layer] upstream stall: kind=no_progress budget=${progressTimeoutMs}ms`);
      timeoutReject?.(
        new UpstreamStallError(
          "no_progress",
          progressTimeoutMs,
          `ChatGPT Web upstream stall: kind=no_progress budget=${progressTimeoutMs}ms`,
        ),
      );
    }, progressTimeoutMs);
  }

  const textDecoder = new TextDecoder("utf-8", { fatal: false });
  let rollingBuffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      resetStallTimer();
      resetProgressTimer();

      try {
        for (;;) {
          let done: boolean;
          let value: Uint8Array | undefined;
          try {
            const res = await Promise.race([reader.read(), timeoutPromise]);
            done = res.done;
            value = res.value;
          } catch (err) {
            cleanupTimers();
            reader.cancel(err).catch(() => {});
            throw err;
          }
          if (done) {
            cleanupTimers();
            try {
              controller.close();
            } catch {}
            break;
          }

          if (value) {
            // 只要收到任何字节，重置 byte-silence 定时器
            resetStallTimer();

            // 检查内容进度标记
            const chunkText = textDecoder.decode(value, { stream: true });
            rollingBuffer += chunkText;

            let hasProgress = false;
            for (const marker of PROGRESS_MARKERS) {
              if (rollingBuffer.includes(marker)) {
                hasProgress = true;
                break;
              }
            }

            if (hasProgress) {
              resetProgressTimer();
              if (rollingBuffer.length > 1024) {
                rollingBuffer = rollingBuffer.slice(-1024);
              }
            } else if (rollingBuffer.length > 65536) {
              rollingBuffer = rollingBuffer.slice(-1024);
            }

            controller.enqueue(value);
          }
        }
      } catch (error) {
        cleanupTimers();
        try {
          controller.error(error);
        } catch {}
      } finally {
        cleanupTimers();
      }
    },
    async cancel(reason) {
      cleanupTimers();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/** Terminate an in-flight SSE response with an explicit error frame rather than a broken transfer. */
function terminateOnStreamFailure(
  source: ReadableStream<Uint8Array>,
  frame: (message: string) => Uint8Array,
  onError?: (error: unknown) => void,
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
        if (onError) {
          onError(error);
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
  const effectiveProgressTimeoutMs = resolveProgressTimeoutMs(config.progressTimeoutMs);
  const effectiveStallTimeoutSec = resolveStallTimeoutSec(config.stallTimeoutSec);
  const effectiveFirstByteTimeoutMs = config.firstByteTimeoutMs !== undefined
    ? config.firstByteTimeoutMs
    : effectiveProgressTimeoutMs;
  const effectiveRetryLimit =
    typeof config.transientRetryLimit === "number" &&
    Number.isFinite(config.transientRetryLimit) &&
    config.transientRetryLimit > 0
      ? Math.floor(config.transientRetryLimit)
      : 1;
  // W25: navigation blips get their own budget (default 2 retries → 3 attempts);
  // 0 (or negative) disables the outer retry entirely.
  const effectiveNavigationRetryLimit =
    typeof config.navigationRetryLimit === "number" && Number.isFinite(config.navigationRetryLimit)
      ? Math.max(0, Math.floor(config.navigationRetryLimit))
      : 2;

  if (!process.env.NO_PROXY && (process.env.HTTP_PROXY || process.env.HTTPS_PROXY)) {
    process.env.NO_PROXY = "127.0.0.1,localhost";
  }

  let requests = 0;
  let activeRequests = 0;
  let lastError: string | undefined;
  const upstreamBase = config.upstreamBaseUrl.replace(/\/+$/, "");
  const idempotencyStore = new IdempotencyStore(config);
  const continuationEnabled = config.continuation !== false;
  const conversationRegistry = new ConversationRegistry({
    limit: config.conversationLimit ?? 64,
    statePath: config.conversationsPath,
  });
  const failureBreaker = createFailureBreaker(config.failureBreaker);

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
        activeRequests += 1;
        const reqId = randomUUID().replace(/-/g, "").slice(0, 8);
        const reqStarted = Date.now();
        let requestCompleted = false;

        const logDone = (status: number) => {
          if (requestCompleted) return;
          requestCompleted = true;
          activeRequests = Math.max(0, activeRequests - 1);
          const elapsed = Date.now() - reqStarted;
          console.log(`[external-layer] req=${reqId} done status=${status} elapsed=${elapsed}ms`);
        };

        const logFailed = (code: string) => {
          if (requestCompleted) return;
          requestCompleted = true;
          activeRequests = Math.max(0, activeRequests - 1);
          const elapsed = Date.now() - reqStarted;
          console.warn(`[external-layer] req=${reqId} failed code=${code} elapsed=${elapsed}ms`);
        };

        let rawBody: Record<string, unknown>;
        try {
          rawBody = (await req.json()) as Record<string, unknown>;
        } catch {
          logFailed("invalid_json");
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
        console.log(`[external-layer] req=${reqId} model=${requestedModel} stream=${isStreaming}`);

        let previousResponseId: string | undefined;
        if (typeof standard.previous_response_id === "string") {
          previousResponseId = standard.previous_response_id;
        } else if (typeof rawBody.previous_response_id === "string") {
          previousResponseId = rawBody.previous_response_id;
        }

        const normalizedInputItems = normalizeInput(standard.input);
        const resolvedThreadId = continuationEnabled
          ? conversationRegistry.resolveConversation(
              Array.isArray(standard.input) ? normalizedInputItems : [],
              previousResponseId,
            ).threadId
          : `prov-${randomUUID()}`;

        const payloadChars = estimatePayloadChars(
          normalizedInputItems,
          typeof standard.instructions === "string" ? standard.instructions : undefined,
        );
        const breakerVerdict = failureBreaker.check(resolvedThreadId, payloadChars);
        if (breakerVerdict.blocked) {
          console.warn(
            `[external-layer] req=${reqId} refused code=conversation_too_large failures=${breakerVerdict.failures} payloadChars=${payloadChars}`,
          );
          return new Response(
            JSON.stringify({
              error: {
                type: "rate_limit_error",
                code: "conversation_too_large",
                message: `ChatGPT Web conversation is too large (~${breakerVerdict.estimatedTokens} tokens estimated from ${payloadChars} chars). Fresh temporary conversations at this size stall the page DOM and fail nearly every time. Start a new conversation, or compact this one before retrying.`,
              },
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "x-ext-layer-conversation": resolvedThreadId,
              },
            },
          );
        }
        // A failed turn still belongs to its conversation: binding it lets an identical client
        // retry resolve to the SAME thread, so the breaker's counter accumulates across retries
        // (and a successful retry re-enters normal continuation).
        const noteTurnFailure = (message?: string) => {
          // A navigation blip is a network event, not a payload problem: counting it would let
          // a flaky exit trip `conversation_too_large`. The conversation is still bound so the
          // client's own retry continues the same thread.
          if (message === undefined || !isNavigationError(errorText(message))) {
            failureBreaker.recordFailure(resolvedThreadId, payloadChars);
          }
          if (continuationEnabled && Array.isArray(standard.input)) {
            conversationRegistry.recordTurn(resolvedThreadId, normalizedInputItems);
          }
        };

        // Replay is opt-in: an explicit Idempotency-Key, the chat-completions surface, or a
        // non-array (completion-style) body. A repeated /v1/responses body carrying a history
        // ARRAY runs again on purpose — the unmodified upstream has no such cache, a failed turn
        // is never stored, and answering with an older turn's text is worse than doing the work.
        // What keeps a retry on the SAME ChatGPT conversation is the conversation registry above,
        // not this cache.
        const hasExplicitIdempotencyKey = Boolean(req.headers.get("idempotency-key")?.trim());
        const shouldCheckIdempotency = isChatCompletions || hasExplicitIdempotencyKey || !Array.isArray(standard.input);
        const idempotencyKey = deriveIdempotencyKey(req.headers.get("idempotency-key"), standard);

        if (shouldCheckIdempotency) {
          const cached = idempotencyStore.get(idempotencyKey);
          if (cached) {
            logDone(cached.status);
            if (isResponses) {
              return new Response(cached.body, {
                status: cached.status,
                headers: {
                  "content-type": cached.contentType,
                  "x-ext-layer-replay": "true",
                  "x-ext-layer-conversation": resolvedThreadId,
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
                  headers: {
                    "x-ext-layer-replay": "true",
                    "x-ext-layer-conversation": resolvedThreadId,
                  },
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
                    "x-ext-layer-conversation": resolvedThreadId,
                  },
                });
              }
            }
          }
        }

        let token: string;
        try {
          token = await config.tokenProvider();
        } catch {
          lastError = "credential unavailable";
          logFailed("credential_unavailable");
          return Response.json(
            { error: { message: "ChatGPT credential unavailable", type: "authentication_error", code: "credential_unavailable" } },
            { status: 401 },
          );
        }
        const effectiveHome = resolveUpstreamHome(config.upstreamHome);
        const capabilities = resolveAccountCapabilities(effectiveHome, {
          solAvailable: config.solAvailable,
          proAvailable: config.proAvailable,
        });

        // Resolve the tier before any upstream turn is opened: a request naming an unsupported
        // effort must fail loud, never be answered by a different tier than the client picked.
        let mappedResolution: MappedModelResult;
        try {
          mappedResolution = resolveRequestModel(standard, capabilities);
        } catch (error) {
          if (error instanceof UnknownEffortError) {
            logFailed("invalid_reasoning_effort");
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
          if (error instanceof TierUnavailableError) {
            logFailed("tier_unavailable");
            return Response.json(
              {
                error: {
                  message: error.message,
                  type: "invalid_request_error",
                  code: "tier_unavailable",
                },
              },
              { status: 400 },
            );
          }
          if (error instanceof ConflictingTierError) {
            logFailed("conflicting_tier");
            return Response.json(
              {
                error: {
                  message: error.message,
                  type: "invalid_request_error",
                  code: "conflicting_tier",
                },
              },
              { status: 400 },
            );
          }
          logFailed("invalid_model");
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

        const retryLimit = effectiveRetryLimit;

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

        // W25: navigation-stage failures (transport blips at page.goto — the turn dies at
        // second zero with no prompt attached and zero tokens spent) retry on their OWN outer
        // budget. Retrying a blip is nearly free; retrying a mid-generation failure is not,
        // which is why the transient budget above stays at its default single attempt. The
        // inner budget explicitly skips nav-class errors so the two budgets never multiply.
        const withNavigationRetry = async <T>(task: () => Promise<T>): Promise<T> => {
          if (effectiveNavigationRetryLimit <= 0) return task();
          return withTransientRetry(task, {
            limit: effectiveNavigationRetryLimit + 1,
            sleep: retrySleep,
            // The outer budget must judge ONLY nav-class errors: the built-in transient
            // matching would re-replay generation-stage failures ("Something went wrong")
            // that already exhausted the inner budget — the multiplication A3 guards against.
            ignoreTransientPatterns: true,
            isRetryable: (error: unknown) => {
              if (error instanceof ClientAbortedError) return false;
              return error instanceof UpstreamHttpFailure && isNavigationError(errorText(error.body));
            },
            onRetry: (attempt: number, message: string) => {
              console.warn(
                `[external-layer] nav retry attempt ${attempt}/${effectiveNavigationRetryLimit + 1} family=${navigationErrorPattern(message) ?? "net::"}`,
              );
            },
          });
        };
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
            turnResult = await withNavigationRetry(async () =>
              withTransientRetry<UpstreamStreamResult>(
              async (_attempt) => {
                if (abortUpstreamTurns && req.signal.aborted) {
                  triggerInterrupt().catch(() => {});
                  throw new ClientAbortedError();
                }
                const clonedStandard = JSON.parse(JSON.stringify(mappedResolution.mapped)) as Record<string, unknown>;
                const native = toNativeRequest(
                  clonedStandard,
                  {
                    ...(config.defaultEnvironment ? { defaultEnvironment: config.defaultEnvironment } : {}),
                    identity: { threadId: resolvedThreadId, turnId: `prov-${randomUUID()}` },
                  },
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
                    if (config.firstByteTimeoutMs !== undefined) {
                      throw new UpstreamStallError(
                        "first_byte",
                        effectiveFirstByteTimeoutMs,
                        `ChatGPT Web upstream stalled waiting for first byte (budget: ${effectiveFirstByteTimeoutMs}ms)`,
                      );
                    } else {
                      throw new UpstreamStallError(
                        "no_progress",
                        effectiveProgressTimeoutMs,
                        `ChatGPT Web upstream stall: kind=no_progress budget=${effectiveProgressTimeoutMs}ms`,
                      );
                    }
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
                    // Navigation blips belong to the OUTER nav budget (withNavigationRetry);
                    // the transient budget must never multiply them.
                    if (isNavigationError(errorText(error.body))) return false;
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
              ),
            );
          } catch (error) {
            if (error instanceof ClientAbortedError || (abortUpstreamTurns && req.signal.aborted)) {
              turnCompleted = true;
              logFailed("client_aborted");
              if (abortUpstreamTurns) {
                req.signal.removeEventListener("abort", onClientAbort);
              }
              return new Response(null, { status: 499 });
            }
            if (error instanceof UpstreamStallError) {
              const isNoProgress = error.kind === "no_progress";
              const errorCode = isNoProgress ? "upstream_no_progress" : "upstream_stall_timeout";
              lastError = `upstream stall timeout (${error.kind})`;
              // Giving up on a turn must also cancel it upstream: otherwise the abandoned browser
              // turn keeps grinding on the ChatGPT page while the client retries, and both turns
              // contend for the same page — the retry storm that trips the page's own rate limit.
              // Same call and guards as the client-abort path. Deliberately not awaited: the 504
              // must reach the client now, not after the admin round trip (that call is bounded
              // by INTERRUPT_TIMEOUT_MS on its own).
              void triggerInterrupt();
              turnResult = {
                status: 504,
                bodyText: JSON.stringify({
                  error: {
                    message: `ChatGPT Web upstream stalled: ${error.message}`,
                    type: "server_error",
                    code: errorCode,
                  },
                  code: errorCode,
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

            // An upstream-reported failure is the same abandonment as a stall: the browser turn
            // may still be alive on the page ("Something went wrong" leaves the tab mid-flight), so
            // release it before the client's retry opens a fresh turn and the two contend for the
            // single launcher page. Guards inside triggerInterrupt make this a no-op when the turn
            // already completed or /admin/ cancellation is switched off; not awaited so the error
            // reaches the client immediately (the admin call is bounded by INTERRUPT_TIMEOUT_MS).
            void triggerInterrupt();
            let errCode = "upstream_error";
            try {
              const parsed = JSON.parse(turnResult.bodyText ?? "{}");
              errCode = parsed.code ?? parsed.error?.code ?? `upstream_${turnResult.status}`;
            } catch {
              errCode = `upstream_${turnResult.status}`;
            }
            logFailed(errCode);
            noteTurnFailure(turnResult.bodyText);
            return new Response(turnResult.bodyText, {
              status: turnResult.status,
              headers: {
                "content-type": turnResult.contentType,
                "x-ext-layer-conversation": resolvedThreadId,
              },
            });
          }

          // Record the upstream SSE text for BOTH routes: a chat client may replay the
          // same key later (and a Responses replay of a chat-opened turn must be
          // byte-identical), so the idempotency record is written from one tap that
          // sits upstream of the client-specific transform.
          const watchdogStream = withContentProgressWatchdog(
            turnResult.bodyStream,
            effectiveStallTimeoutSec,
            effectiveProgressTimeoutMs,
          );
          const recordedStream = tapStream(watchdogStream, (fullText) => {
            if (shouldCheckIdempotency) {
              idempotencyStore.save(idempotencyKey, {
                status: 200,
                body: fullText,
                contentType: turnResult.contentType,
              });
            }
            if (continuationEnabled && Array.isArray(standard.input)) {
              const respId = extractResponseIdFromSse(fullText);
              conversationRegistry.recordTurn(resolvedThreadId, normalizedInputItems, respId);
            }
            lastError = undefined;
            logDone(200);
            failureBreaker.recordSuccess(resolvedThreadId);
          });

          const onStreamError = (error: unknown) => {
            if (error instanceof UpstreamStallError) {
              const errCode = error.kind === "no_progress" ? "upstream_no_progress" : "upstream_stall_timeout";
              logFailed(errCode);
              noteTurnFailure();
              // Abandoning a stalled turn is not enough: the browser turn keeps running (and
              // keeps occupying the single launcher page) unless we cancel it. A retry or the
              // client's own next request would then race a zombie turn for the page, which is
              // how one stalled step used to poison every following step. Fired without await
              // on purpose — the client must hear the failure now, not after the admin round
              // trip (the call itself is bounded by INTERRUPT_TIMEOUT_MS).
              void triggerInterrupt();
            } else {
              // Same rule as the typed failures above: a broken relay must not leave the browser
              // turn running under a client that is about to retry.
              void triggerInterrupt();
              logFailed("upstream_stream_error");
              noteTurnFailure();
            }
          };

          if (isResponses) {
            const clientStream = terminateOnStreamFailure(
              recordedStream,
              (message) =>
                new TextEncoder().encode(
                  `event: error\ndata: ${JSON.stringify({ type: "error", message: `ChatGPT Web upstream stream failed: ${message}` })}\n\ndata: [DONE]\n\n`,
                ),
              onStreamError,
            );
            const wrappedStream = abortUpstreamTurns
              ? withClientAbortTermination(clientStream, req.signal, () => {
                  logFailed("client_aborted");
                  onClientAbort();
                }, () => {
                  turnCompleted = true;
                })
              : clientStream;
            return new Response(wrappedStream, {
              status: 200,
              headers: {
                "content-type": turnResult.contentType,
                ...(contextWindowHeaderValue ? { "x-ext-layer-context-window": contextWindowHeaderValue } : {}),
                "x-ext-layer-conversation": resolvedThreadId,
              },
            });
          } else {
            const tapErrorStream = new ReadableStream<Uint8Array>({
              async start(controller) {
                const reader = recordedStream.getReader();
                try {
                  for (;;) {
                    const { done, value } = await reader.read();
                    if (done) {
                      try { controller.close(); } catch {}
                      break;
                    }
                    if (value) controller.enqueue(value);
                  }
                } catch (err) {
                  onStreamError(err);
                  try { controller.error(err); } catch {}
                }
              },
              async cancel(reason) {
                await recordedStream.cancel(reason).catch(() => {});
              },
            });
            const chatStream = transformResponsesStreamToChatStream(tapErrorStream, requestedModel);
            const wrappedStream = abortUpstreamTurns
              ? withClientAbortTermination(chatStream, req.signal, () => {
                  logFailed("client_aborted");
                  onClientAbort();
                }, () => {
                  turnCompleted = true;
                })
              : chatStream;
            return new Response(wrappedStream, {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                ...(contextWindowHeaderValue ? { "x-ext-layer-context-window": contextWindowHeaderValue } : {}),
                "x-ext-layer-conversation": resolvedThreadId,
              },
            });
          }
        }

        // 非流式请求
        const executeTurn = async () => {
          try {
            const response = await withNavigationRetry(() =>
              withTransientRetry(
              async (_attempt) => {
                if (abortUpstreamTurns && req.signal.aborted) {
                  triggerInterrupt().catch(() => {});
                  throw new ClientAbortedError();
                }
                const clonedStandard = JSON.parse(JSON.stringify(mappedResolution.mapped)) as Record<string, unknown>;
                const native = toNativeRequest(
                  clonedStandard,
                  {
                    ...(config.defaultEnvironment ? { defaultEnvironment: config.defaultEnvironment } : {}),
                    identity: { threadId: resolvedThreadId, turnId: `prov-${randomUUID()}` },
                  },
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
                    if (config.firstByteTimeoutMs !== undefined) {
                      throw new UpstreamStallError(
                        "first_byte",
                        effectiveFirstByteTimeoutMs,
                        `ChatGPT Web upstream stalled waiting for first byte (budget: ${effectiveFirstByteTimeoutMs}ms)`,
                      );
                    } else {
                      throw new UpstreamStallError(
                        "no_progress",
                        effectiveProgressTimeoutMs,
                        `ChatGPT Web upstream stall: kind=no_progress budget=${effectiveProgressTimeoutMs}ms`,
                      );
                    }
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
                    // Navigation blips belong to the OUTER nav budget (withNavigationRetry);
                    // the transient budget must never multiply them.
                    if (isNavigationError(errorText(error.body))) return false;
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
              ),
            );
            return response;
          } catch (error) {
            if (error instanceof ClientAbortedError || (abortUpstreamTurns && req.signal.aborted)) {
              lastError = "client aborted";
              return { status: 499, body: "", contentType: "application/json" };
            }
              // Any upstream-reported failure (5xx, "Something went wrong", a broken stream) abandons its
              // browser turn just like a stall does, so cancel it before the client retries: the retry must
              // not race a turn that is still alive on the page. Guards inside triggerInterrupt make this a
              // no-op once the turn completed or cancellation is switched off, and the call is not awaited so
              // the error still reaches the client immediately.
              void triggerInterrupt();
            if (error instanceof UpstreamStallError) {
              const isNoProgress = error.kind === "no_progress";
              const errorCode = isNoProgress ? "upstream_no_progress" : "upstream_stall_timeout";
              lastError = `upstream stall timeout (${error.kind})`;
              // See the streaming path: abandoning a turn must cancel it upstream as well —
              // fired without await so the 504 is not held back by the admin round trip.
              void triggerInterrupt();
              return {
                status: 504,
                body: JSON.stringify({
                  error: {
                    message: `ChatGPT Web upstream stalled: ${error.message}`,
                    type: "server_error",
                    code: errorCode,
                  },
                  code: errorCode,
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
        };

        const result = shouldCheckIdempotency
          ? await idempotencyStore.runWithDeduplication(idempotencyKey, executeTurn)
          : await executeTurn();

        if (abortUpstreamTurns && (req.signal.aborted || result.status === 499)) {
          turnCompleted = true;
          logFailed("client_aborted");
          req.signal.removeEventListener("abort", onClientAbort);
          return new Response(null, { status: 499 });
        }

        turnCompleted = true;
        if (abortUpstreamTurns) {
          req.signal.removeEventListener("abort", onClientAbort);
        }

        if (result.status === 200) {
          if (continuationEnabled && Array.isArray(standard.input)) {
            let respId: string | undefined;
            try {
              const parsed = JSON.parse(result.body);
              if (typeof parsed.id === "string") respId = parsed.id;
            } catch {}
            conversationRegistry.recordTurn(resolvedThreadId, normalizedInputItems, respId);
          }
          lastError = undefined;
          logDone(200);
          failureBreaker.recordSuccess(resolvedThreadId);
        } else {
          let errCode = "upstream_error";
          try {
            const parsed = JSON.parse(result.body);
            errCode = parsed.code ?? parsed.error?.code ?? `upstream_${result.status}`;
          } catch {
            errCode = `upstream_${result.status}`;
          }
          logFailed(errCode);
          noteTurnFailure(result.body);
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
              "x-ext-layer-conversation": resolvedThreadId,
            },
          });
        }

        return new Response(result.body, {
          status: result.status,
          headers: {
            "content-type": result.contentType,
            ...(result.status === 200 && contextWindowHeaderValue ? { "x-ext-layer-context-window": contextWindowHeaderValue } : {}),
            "x-ext-layer-conversation": resolvedThreadId,
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
        const effectiveHome = resolveUpstreamHome(config.upstreamHome);
        const capabilities = resolveAccountCapabilities(effectiveHome, {
          solAvailable: config.solAvailable,
          proAvailable: config.proAvailable,
        });
        const derived = deriveTierWindows(upstreamCatalog, capabilities);
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
          account: {
            solAvailable: capabilities.solAvailable,
            proAvailable: capabilities.proAvailable,
            source: capabilities.source,
          },
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
        const effectiveHome = resolveUpstreamHome(config.upstreamHome);
        const capabilities = resolveAccountCapabilities(effectiveHome, {
          solAvailable: config.solAvailable,
          proAvailable: config.proAvailable,
        });
        const catalog = unifiedCatalog(upstreamCatalog, capabilities);
        return Response.json(catalog);

      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        const includeBudgetHealth =
          config.progressTimeoutMs !== undefined ||
          process.env.NODE_ENV !== "test";

        return Response.json({
          status: lastError ? "degraded" : "ok",
          requests,
          ...(includeBudgetHealth
            ? {
                progress_timeout_ms: effectiveProgressTimeoutMs,
                retry_limit: effectiveRetryLimit,
                active_requests: activeRequests,
              }
            : {}),
          ...(lastError ? { last_error: lastError } : {}),
        });
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
    progressTimeoutMs: effectiveProgressTimeoutMs,
  };
}
