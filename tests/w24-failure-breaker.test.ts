/**
 * W24 canonical contract — failure breaker: stop the big-conversation death spiral with an
 * immediate, actionable error instead of minutes of silent churn.
 *
 * Evidence (2026-09-12, live `C:\Users\daixu\AppData\Local\Temp\upstream-serve.log`):
 *  - 6 turns aborted today, each preceded by a `20-response-stalled-60s` checkpoint (1:1): the page
 *    generates halfway, then the ~630KB DOM (full 40k-token history pasted into a FRESH temporary
 *    conversation) stalls the browser observation pipeline, and after 60s with zero progress the
 *    turn is aborted ("ChatGPT web turn aborted").
 *  - Payload vs outcome across 127 turns: <20k tokens completed 68/83 (~82%); >=20k tokens
 *    completed 1/44 (~2%).
 *  - The facade issued ZERO interrupts (external-layer.log has none) — the turns die on their own,
 *    every abort releases the retained tab, and the agent's next step opens ANOTHER fresh
 *    conversation and re-pastes the whole history. The user sees "still working -> cut off ->
 *    a new conversation appears" in a loop.
 *
 * Frozen contract:
 *  - New config `failureBreaker?: { enabled?; failureThreshold?; payloadCharsThreshold?; cooldownMs?; now? }`
 *    (default ENABLED, threshold 3, payloadCharsThreshold 50_000, cooldownMs 300_000, `now` injectable clock).
 *  - Per-conversation (per resolved thread) consecutive-failure counter. A failure QUALIFIES only when
 *    the request payload (sum of JSON.stringify(item).length over normalized input items + instructions)
 *    is >= payloadCharsThreshold. `client_aborted` (user pressed stop) never counts. Client-side 4xx
 *    validation failures (no upstream turn opened) never count.
 *  - Tripped (count >= failureThreshold): requests for that conversation are refused BEFORE any upstream
 *    call with HTTP 429 `{error:{type:"rate_limit_error", code:"conversation_too_large", message}}` where
 *    message names the estimated size (~payloadChars/2.5 tokens, calibrated on today's live data:
 *    102,808 chars <-> 39,866 tokens) and tells the user to start a new conversation or compact.
 *  - Streaming refusals are plain JSON 429 (no SSE) — errors before stream start are JSON per the
 *    Responses API.
 *  - After cooldownMs the breaker is half-open: the next request goes upstream; success closes and resets,
 *    failure re-opens with a fresh cooldown.
 *  - A FAILED turn must still bind its thread in the conversation registry (recordTurn without a response
 *    id) so an identical client retry resolves to the SAME conversation — otherwise the counter would
 *    never accumulate across retries (each retry would look like a brand-new conversation).
 *  - The refusal carries `x-ext-layer-conversation: <threadId>` for observability.
 *  - `enabled: false` restores today's behaviour (never refuse).
 *  - Red line unchanged: the facade NEVER slices or rewrites client history (A10 of w23).
 */
import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";
const BIG = "x".repeat(60_000);

const user = (text: string) => ({ type: "message", role: "user", content: text });
const bigConv = (suffix: string) => [user(BIG + suffix)];

interface CapturedCall {
  thread: string;
  turn: string;
}

function mockUpstream(options: { failures?: number; delayMs?: number } = {}) {
  const calls: CapturedCall[] = [];
  let seq = 0;
  let failures = options.failures ?? 0;
  const delayMs = options.delayMs ?? 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/admin/")) return Response.json({ ok: true });
      if (url.pathname.endsWith("/models")) return Response.json({ models: [] });
      const body = (await req.json()) as Record<string, unknown>;
      const metadata = (body.client_metadata ?? {}) as Record<string, unknown>;
      const turnMetadata = (metadata["x-codex-turn-metadata"] ?? {}) as Record<string, unknown>;
      calls.push({
        thread: String(turnMetadata.thread_id ?? ""),
        turn: String(turnMetadata.turn_id ?? ""),
      });
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (failures > 0) {
        failures -= 1;
        return Response.json(
          { error: { message: "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.", code: "upstream_server_error" } },
          { status: 500 },
        );
      }
      seq += 1;
      return Response.json({
        id: `resp_mock_${seq}`,
        object: "response",
        status: "completed",
        model: "chatgpt-web/high",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `answer-${seq}` }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls,
    setFailures: (n: number) => { failures = n; },
    stop: () => server.stop(true),
  };
}

interface LayerOverrides {
  failureBreaker?: {
    enabled?: boolean;
    failureThreshold?: number;
    payloadCharsThreshold?: number;
    cooldownMs?: number;
    now?: () => number;
  };
}

function boot(upstreamBaseUrl: string, overrides: LayerOverrides = {}) {
  return startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl,
    tokenProvider: async () => "tok",
    port: 0,
    retrySleepMs: 1,
    ...overrides,
  });
}

async function turn(baseUrl: string, input: unknown[], extra: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/high", input, stream: false, ...extra }),
  });
  const body = (await res.json()) as { error?: { type?: string; code?: string; message?: string } };
  return {
    status: res.status,
    conversation: res.headers.get("x-ext-layer-conversation"),
    errorType: body.error?.type,
    errorCode: body.error?.code,
    message: body.error?.message ?? "",
    body,
  };
}

test("A1 three consecutive big-payload failures trip the breaker and the next request is refused instantly", async () => {
  const up = mockUpstream({ failures: 99 });
  const layer = await boot(up.baseUrl);
  try {
    for (let i = 0; i < 3; i += 1) {
      const r = await turn(layer.baseUrl, bigConv("A1"));
      expect(r.status).toBe(500);
    }
    expect(up.calls.length).toBe(3);
    const refused = await turn(layer.baseUrl, bigConv("A1"));
    expect(refused.status).toBe(429);
    expect(refused.errorType).toBe("rate_limit_error");
    expect(refused.errorCode).toBe("conversation_too_large");
    expect(refused.message).toMatch(/new conversation/i);
    expect(refused.message).toMatch(/~\d+ tokens/);
    expect(up.calls.length).toBe(3);
    expect(refused.conversation).toBe(up.calls[0]!.thread);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A2 a failed turn still binds its conversation so an identical retry resolves to the same thread", async () => {
  const up = mockUpstream({ failures: 1 });
  const layer = await boot(up.baseUrl);
  try {
    const first = await turn(layer.baseUrl, bigConv("A2"));
    expect(first.status).toBe(500);
    expect(first.conversation).toBe(up.calls[0]!.thread);
    const retry = await turn(layer.baseUrl, bigConv("A2"));
    expect(retry.status).toBe(200);
    expect(up.calls.length).toBe(2);
    expect(up.calls[1]!.thread).toBe(up.calls[0]!.thread);
    expect(retry.conversation).toBe(first.conversation);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A3 small-payload failures never trip the breaker", async () => {
  const up = mockUpstream({ failures: 99 });
  const layer = await boot(up.baseUrl);
  try {
    for (let i = 0; i < 5; i += 1) {
      const r = await turn(layer.baseUrl, [user("tiny retry")]);
      expect(r.status).toBe(500);
    }
    const sixth = await turn(layer.baseUrl, [user("tiny retry")]);
    expect(sixth.status).toBe(500);
    expect(up.calls.length).toBe(6);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A4 a success resets the consecutive counter", async () => {
  const up = mockUpstream({ failures: 2 });
  const layer = await boot(up.baseUrl);
  try {
    expect((await turn(layer.baseUrl, bigConv("A4"))).status).toBe(500);
    expect((await turn(layer.baseUrl, bigConv("A4"))).status).toBe(500);
    expect((await turn(layer.baseUrl, bigConv("A4"))).status).toBe(200);
    up.setFailures(99);
    expect((await turn(layer.baseUrl, bigConv("A4"))).status).toBe(500);
    expect((await turn(layer.baseUrl, bigConv("A4"))).status).toBe(500);
    const sixth = await turn(layer.baseUrl, bigConv("A4"));
    expect(sixth.status).toBe(500);
    expect(up.calls.length).toBe(6);
    const seventh = await turn(layer.baseUrl, bigConv("A4"));
    expect(seventh.status).toBe(429);
    expect(seventh.errorCode).toBe("conversation_too_large");
    expect(up.calls.length).toBe(6);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A5 after the cooldown the breaker is half-open: one attempt is allowed and a failure re-opens it", async () => {
  let clock = 1_000_000;
  const up = mockUpstream({ failures: 99 });
  const layer = await boot(up.baseUrl, { failureBreaker: { cooldownMs: 5_000, now: () => clock } });
  try {
    for (let i = 0; i < 3; i += 1) await turn(layer.baseUrl, bigConv("A5"));
    expect((await turn(layer.baseUrl, bigConv("A5"))).status).toBe(429);
    clock += 6_000;
    const halfOpen = await turn(layer.baseUrl, bigConv("A5"));
    expect(halfOpen.status).toBe(500);
    expect(up.calls.length).toBe(4);
    const reRefused = await turn(layer.baseUrl, bigConv("A5"));
    expect(reRefused.status).toBe(429);
    expect(up.calls.length).toBe(4);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A6 after the cooldown a successful attempt closes the breaker", async () => {
  let clock = 1_000_000;
  const up = mockUpstream({ failures: 3 });
  const layer = await boot(up.baseUrl, { failureBreaker: { cooldownMs: 5_000, now: () => clock } });
  try {
    for (let i = 0; i < 3; i += 1) await turn(layer.baseUrl, bigConv("A6"));
    expect((await turn(layer.baseUrl, bigConv("A6"))).status).toBe(429);
    clock += 6_000;
    const halfOpen = await turn(layer.baseUrl, bigConv("A6"));
    expect(halfOpen.status).toBe(200);
    const next = await turn(layer.baseUrl, bigConv("A6"));
    expect(next.status).toBe(200);
    expect(up.calls.length).toBe(5);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A7 conversations are isolated: a tripped conversation never blocks another one", async () => {
  const up = mockUpstream({ failures: 99 });
  const layer = await boot(up.baseUrl);
  try {
    for (let i = 0; i < 3; i += 1) await turn(layer.baseUrl, bigConv("A7-a"));
    expect((await turn(layer.baseUrl, bigConv("A7-a"))).status).toBe(429);
    const other = await turn(layer.baseUrl, bigConv("A7-b"));
    expect(other.status).toBe(500);
    expect(up.calls.length).toBe(4);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A8 a streaming request is refused with plain JSON 429, not an SSE stream", async () => {
  const up = mockUpstream({ failures: 99 });
  const layer = await boot(up.baseUrl);
  try {
    for (let i = 0; i < 3; i += 1) await turn(layer.baseUrl, bigConv("A8"));
    const res = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/high", input: bigConv("A8"), stream: true }),
    });
    expect(res.status).toBe(429);
    expect((res.headers.get("content-type") ?? "").includes("json")).toBe(true);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("conversation_too_large");
    expect(up.calls.length).toBe(3);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A9 failureBreaker disabled restores today's behaviour", async () => {
  const up = mockUpstream({ failures: 99 });
  const layer = await boot(up.baseUrl, { failureBreaker: { enabled: false } });
  try {
    for (let i = 0; i < 5; i += 1) {
      const r = await turn(layer.baseUrl, bigConv("A9"));
      expect(r.status).toBe(500);
    }
    expect(up.calls.length).toBe(5);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A10 client aborts (user pressed stop) never count toward the breaker", async () => {
  const up = mockUpstream({ delayMs: 800 });
  const layer = await boot(up.baseUrl);
  try {
    for (let i = 0; i < 3; i += 1) {
      const controller = new AbortController();
      const request = fetch(`${layer.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-web/high", input: bigConv("A10"), stream: true }),
        signal: controller.signal,
      });
      await new Promise(resolve => setTimeout(resolve, 120));
      controller.abort();
      await request.catch(() => undefined);
    }
    const fourth = await turn(layer.baseUrl, bigConv("A10"));
    expect(fourth.status).toBe(200);
    expect(up.calls.length).toBe(4);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);