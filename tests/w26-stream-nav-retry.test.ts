/**
 * w26-stream-nav-retry :: canonical contract for IN-STREAM navigation retries.
 *
 * Real-machine evidence (2026-09-12 17:03-17:16 UTC+8, upstream traces b6cdd0fff829 /
 * dd8259c4974c / cbc9709909fb, facade log "done status=200" with zero failure lines):
 * the unmodified upstream emits `response.created` FIRST — `startStream()` runs inside the
 * ReadableStream `start()` (ccw-upstream/src/bridge.ts:737, wired at :824/:841) — then
 * heartbeats every 2s, and a turn failure arrives as an IN-BAND `response.failed` frame
 * (ccw-upstream/src/bridge.ts:659/:685 `emit("response.failed", ...)`) inside a 200 SSE
 * stream. The facade relays edge-to-edge and logs `done status=200`, so the HTTP-level
 * nav retry (w25, `withNavigationRetry` judging `UpstreamHttpFailure`) can never see a
 * streaming `page.goto: net::ERR_CONNECTION_CLOSED ...` failure.
 *
 * The frozen contract encoded here:
 *  - the facade holds the upstream stream's first bytes (created + heartbeats) until the
 *    first MEANINGFUL frame (any frame that is neither `response.created` nor
 *    `response.heartbeat`); if that frame is a nav-class `response.failed` before any real
 *    content, the whole upstream attempt is retried invisibly on the OUTER nav budget
 *    (w25): the client sees only the successful attempt (A1) — one `response.created`, no
 *    failure bytes, same thread, fresh turn_id, `up.responsesCalls() === 2`.
 *  - when the nav budget is exhausted, the ORIGINAL stream bytes are relayed verbatim:
 *    `created → heartbeats → response.failed → [DONE]`, byte-shape identical to today
 *    (A2). A navigation failure is logged but must NOT feed the w24 failure breaker (A6) —
 *    a network blip is not a payload problem.
 *  - healthy turns keep their first-byte latency: the peek resolves on the first chunk
 *    (created), so nothing is buffered after it (A3, <350ms, regression lock for w9 A4).
 *  - a failure AFTER real content was relayed is never retried (the client already saw
 *    bytes): the failed frame is relayed as today (A4).
 *  - a NON-nav failure before content is relayed as today, no retry (A5) — generation-stage
 *    failures stay single-attempt (w21 semantics).
 *  - heartbeats still reach the client (A8).
 *  - THE W24-FOR-STREAMING FIX: an in-band upstream failure (`response.failed` /
 *    `response.incomplete`, without `response.completed`) must feed the failure breaker —
 *    today the relay's tap records it as a SUCCESS, which makes the death-spiral breaker
 *    dead for streaming clients (A7). Nav-class in-stream failures stay uncounted (A6).
 *  - regression locks: w25's non-streaming HTTP-level nav retry still works (A10); no
 *    globalThis side effects (A9).
 *
 * Every case carries an explicit timeout; the whole file stays well under 30s.
 */
import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";

const encoder = new TextEncoder();

/** The exact streaming goto failure the user reported on 2026-09-12 (trace dd8259c4974c). */
const NAV_MSG = "page.goto: net::ERR_CONNECTION_CLOSED at https://chatgpt.com/?temporary-chat=true";
/** The upstream's generic generation-stage failure text (browser-worker.ts:766-782). */
const SOMETHING_WRONG = "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.";

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const createdFrame = (id: string): string =>
  frame("response.created", {
    type: "response.created",
    response: { id, object: "response", status: "in_progress", model: "chatgpt-web/high" },
  });

const heartbeatFrame = frame("response.heartbeat", { type: "response.heartbeat" });

const failedFrame = (message: string): string =>
  frame("response.failed", {
    type: "response.failed",
    response: {
      id: "resp_failed_w26",
      object: "response",
      status: "failed",
      error: { message, code: "upstream_server_error" },
    },
  });

const deltaFrame = (text: string): string =>
  frame("response.output_text.delta", { type: "response.output_text.delta", delta: text });

const completedFrame = frame("response.completed", {
  type: "response.completed",
  response: { id: "resp_ok_w26", object: "response", status: "completed", model: "chatgpt-web/high" },
});

const DONE = "data: [DONE]\n\n";

const healthyScript = () => ({ frames: [createdFrame("resp_ok_w26"), heartbeatFrame, deltaFrame("OK-W26"), completedFrame, DONE] });
const navFailScript = () => ({
  frames: [createdFrame("resp_nav_w26"), heartbeatFrame, failedFrame(NAV_MSG), DONE],
  chunkDelayMs: 150,
});
const contentThenFailScript = () => ({
  frames: [createdFrame("resp_part_w26"), deltaFrame("partial-"), failedFrame(SOMETHING_WRONG), DONE],
});
const nonNavEarlyFailScript = () => ({
  frames: [createdFrame("resp_sw_w26"), failedFrame(SOMETHING_WRONG), DONE],
});

interface StreamScript {
  frames?: string[];
  chunkDelayMs?: number;
  /** Raw chunks enqueued verbatim (an SSE frame split across network chunks); wins over frames. */
  rawChunks?: string[];
}

interface TurnIdentity {
  threadId: string;
  turnId: string;
}

function turnIdentityOf(nativeBody: Record<string, unknown>): TurnIdentity {
  const metadata =
    nativeBody.client_metadata && typeof nativeBody.client_metadata === "object"
      ? (nativeBody.client_metadata as Record<string, unknown>)
      : {};
  const raw = metadata["x-codex-turn-metadata"];
  const parsed =
    typeof raw === "string"
      ? (JSON.parse(raw) as Record<string, unknown>)
      : ((raw ?? {}) as Record<string, unknown>);
  return { threadId: String(parsed.thread_id ?? ""), turnId: String(parsed.turn_id ?? "") };
}

/** Mock upstream: every POST /v1/responses is answered by the script for its call index;
 *  the recorded turn identities and frames make the retry semantics observable. */
function upstream(script: (callIndex: number) => StreamScript) {
  const turns: TurnIdentity[] = [];
  const interrupts: string[] = [];
  let responsesCalls = 0;

  const server = Bun.serve({
    port: 0,
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/admin/")) {
        interrupts.push(`${req.method} ${url.pathname}`);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/v1/models") {
        return Response.json({
          models: [
            {
              slug: "chatgpt-web/light",
              context_window: 41_000,
              max_context_window: 41_000,
              effective_context_window_percent: 85,
              auto_compact_token_limit: 32_000,
            },
          ],
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        responsesCalls += 1;
        const native = (JSON.parse(await req.text()) ?? {}) as Record<string, unknown>;
        turns.push(turnIdentityOf(native));
        const plan = script(responsesCalls - 1);
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const chunks = plan.rawChunks ?? plan.frames ?? [];
            for (const frameText of chunks) {
              if (plan.chunkDelayMs) await Bun.sleep(plan.chunkDelayMs);
              try {
                controller.enqueue(encoder.encode(frameText));
              } catch {
                return;
              }
            }
            try {
              controller.close();
            } catch {}
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    turns,
    interrupts,
    responsesCalls: () => responsesCalls,
  };
}

type BootOverrides = Partial<Parameters<typeof startExternalLayer>[0]> & Record<string, unknown>;

async function boot(upstreamBaseUrl: string, overrides: BootOverrides = {}) {
  return startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl,
    tokenProvider: async () => "tok",
    port: 0,
    retrySleepMs: 1,
    ...overrides,
  } as Parameters<typeof startExternalLayer>[0]);
}

const turnBody = (nonce: string) => ({
  model: "chatgpt-web/latest",
  input: [{ role: "user", content: [{ type: "input_text", text: `w26 ${nonce} ${"y".repeat(400)}` }] }],
  stream: true,
});

/** POST a streaming turn and read the WHOLE client-visible SSE text. */
async function streamTurn(baseUrl: string, body: unknown): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

const BREAKER = { enabled: true, failureThreshold: 1, payloadCharsThreshold: 1, cooldownMs: 60_000 };

test("A1: an in-stream goto failure before any content is retried invisibly", async () => {
  const up = upstream((call) => (call === 0 ? navFailScript() : healthyScript()));
  const layer = await boot(up.url);
  try {
    const { status, text } = await streamTurn(layer.baseUrl, turnBody("a1"));
    expect(status).toBe(200);
    expect(up.responsesCalls()).toBe(2);
    expect(up.turns.length).toBe(2);
    expect(up.turns[0].threadId).toBe(up.turns[1].threadId);
    expect(up.turns[0].turnId).not.toBe(up.turns[1].turnId);
    // Attempt 1's bytes never reach the client.
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("net::ERR");
    expect(text).not.toContain("resp_nav_w26");
    // Exactly one created frame, then the healthy attempt's payload.
    expect(text.split('"type":"response.created"').length - 1).toBe(1);
    expect(text).toContain("OK-W26");
    expect(text).toContain("response.completed");
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A2: an exhausted nav budget relays the original failure stream byte-shape", async () => {
  const up = upstream(() => navFailScript());
  const layer = await boot(up.url, { navigationRetryLimit: 1 });
  try {
    const { status, text } = await streamTurn(layer.baseUrl, turnBody("a2"));
    expect(status).toBe(200);
    expect(up.responsesCalls()).toBe(2);
    expect(text).toContain("response.created");
    expect(text).toContain("response.heartbeat");
    expect(text).toContain("response.failed");
    expect(text).toContain(NAV_MSG);
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A3: healthy turns keep their first-byte latency (the peek resolves on the first chunk)", async () => {
  const up = upstream(() => healthyScript());
  const layer = await boot(up.url);
  try {
    const startedAt = Date.now();
    const res = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(turnBody("a3")),
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstByteMs = Date.now() - startedAt;
    await reader.cancel();
    expect(res.status).toBe(200);
    expect(firstByteMs).toBeLessThan(350);
    expect(new TextDecoder().decode(first.value!).length).toBeGreaterThan(0);
    expect(up.responsesCalls()).toBe(1);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A4: a failure AFTER content is relayed, never retried", async () => {
  const up = upstream(() => contentThenFailScript());
  const layer = await boot(up.url);
  try {
    const { status, text } = await streamTurn(layer.baseUrl, turnBody("a4"));
    expect(status).toBe(200);
    expect(up.responsesCalls()).toBe(1);
    expect(text).toContain("partial-");
    expect(text).toContain("response.failed");
    expect(text).toContain("Something went wrong");
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A5: a non-nav failure before content is relayed as today, single attempt", async () => {
  const up = upstream(() => nonNavEarlyFailScript());
  const layer = await boot(up.url);
  try {
    const { status, text } = await streamTurn(layer.baseUrl, turnBody("a5"));
    expect(status).toBe(200);
    expect(up.responsesCalls()).toBe(1);
    expect(text).toContain("response.failed");
    expect(text).toContain("Something went wrong");
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A6: an in-stream nav failure is never counted by the failure breaker", async () => {
  const up = upstream(() => navFailScript());
  const layer = await boot(up.url, { navigationRetryLimit: 1, failureBreaker: BREAKER });
  try {
    const body = turnBody("a6-same");
    const first = await streamTurn(layer.baseUrl, body);
    expect(first.text).toContain("response.failed");
    // The breaker would refuse this second request with 429 conversation_too_large if the
    // nav failure had been counted (same conversation thread, threshold 1).
    const second = await streamTurn(layer.baseUrl, body);
    expect(second.status).toBe(200);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A7: an in-band non-nav failure feeds the failure breaker (w24 works for streaming)", async () => {
  const up = upstream(() => nonNavEarlyFailScript());
  const layer = await boot(up.url, { failureBreaker: BREAKER });
  try {
    const body = turnBody("a7-same");
    const first = await streamTurn(layer.baseUrl, body);
    expect(first.status).toBe(200);
    expect(first.text).toContain("response.failed");
    const second = await streamTurn(layer.baseUrl, body);
    expect(second.status).toBe(429);
    const refused = JSON.parse(second.text) as { error?: { code?: string } };
    expect(refused.error?.code).toBe("conversation_too_large");
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A8: held heartbeats still reach the client unchanged", async () => {
  const up = upstream((call) => (call === 0 ? navFailScript() : healthyScript()));
  const layer = await boot(up.url);
  try {
    const { text } = await streamTurn(layer.baseUrl, turnBody("a8"));
    expect(text).toContain("response.heartbeat");
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A9: the peek leaves globalThis untouched", async () => {
  const fetchBefore = globalThis.fetch;
  const serveBefore = globalThis.Bun.serve;
  const up = upstream((call) => (call === 0 ? navFailScript() : healthyScript()));
  const layer = await boot(up.url);
  try {
    await streamTurn(layer.baseUrl, turnBody("a9"));
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(globalThis.Bun.serve).toBe(serveBefore);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A10: the w25 HTTP-level nav retry still fires for non-streaming turns", async () => {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/admin/")) return Response.json({ ok: true });
      if (url.pathname === "/v1/models") return Response.json({ models: [] });
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message: "page.goto: net::ERR_CONNECTION_CLOSED at https://chatgpt.com/?temporary-chat=true",
                code: "upstream_server_error",
              },
            }),
            { status: 502, headers: { "content-type": "application/json" } },
          );
        }
        return Response.json({
          id: "resp_w25_ok",
          object: "response",
          status: "completed",
          model: "chatgpt-web/high",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "PONG-W25" }] }],
        });
      }
      return Response.json({ error: { message: "no route" } }, { status: 404 });
    },
  });
  const layer = await boot(`http://127.0.0.1:${server.port}`);
  try {
    const res = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", input: "w25 regression", stream: false }),
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("completed");
  } finally {
    await layer.stop();
    server.stop(true);
  }
}, 20000);
// AMENDED 2026-09-12 (real machine, trace d75de6825145, facade req=0430371d): the upstream
// delivers SSE frames in arbitrary network chunks, and the 20:59 `page.goto:
// net::ERR_SSL_PROTOCOL_ERROR` failure was relayed to the client after a SINGLE upstream
// attempt (facade log "done status=200 elapsed=2062ms", zero `nav retry` lines) even though
// A1 proves the same failure whole-frame is retried. Root cause: classifySseHead decided on
// an INCOMPLETE trailing line — the failed data line arrived split mid-JSON, JSON.parse
// failed, and the fallback message (partial text, no "net::err_") was judged non-nav.
test("A11: a failure frame split across network chunks still retries (an incomplete line never decides)", async () => {
  const up = upstream((call) => {
    if (call !== 0) return healthyScript();
    // Split the failure frame mid-JSON of its data line, like a real chunk boundary would.
    const failed = failedFrame(NAV_MSG);
    const cut = failed.indexOf('"type"') + 12;
    return {
      rawChunks: [createdFrame("resp_split_w26"), failed.slice(0, cut), failed.slice(cut), DONE],
      chunkDelayMs: 60,
    };
  });
  const layer = await boot(up.url);
  try {
    const { status, text } = await streamTurn(layer.baseUrl, turnBody("a11"));
    expect(status).toBe(200);
    // The split failure attempt is retried invisibly; the client sees only the healthy turn.
    expect(up.responsesCalls()).toBe(2);
    expect(up.turns[0].threadId).toBe(up.turns[1].threadId);
    expect(up.turns[0].turnId).not.toBe(up.turns[1].turnId);
    expect(text).not.toContain("response.failed");
    expect(text).not.toContain("net::ERR");
    expect(text).toContain("OK-W26");
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);
