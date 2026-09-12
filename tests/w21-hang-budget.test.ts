/**
 * W21 canonical contract — hang budget: one browser turn per request, and a turn that produces
 * no real content is stopped on a deadline instead of heartbeating forever.
 *
 * Why this contract exists (diagnosed 2026-09-12 from the live stack, task feat-09-12):
 *  - upstream `bridge.ts` emits `response.heartbeat` about once a second while the ChatGPT page
 *    thinks. The facade's stream watchdog counted *bytes*, so every heartbeat reset the timer and
 *    the watchdog never fired: one stuck step hung for as long as the client kept waiting.
 *  - the facade ALSO retried transient failures (default 5) while the harness retries 5 times by
 *    default (`packages/llm/llm/lib/index.js:232 DEFAULT_MAX_RETRIES = 5`), so a single stuck step
 *    could open up to 5 x 6 = 30 browser turns on the same page — the "runs for a whole day" bug.
 *    Decision (user, 2026-09-12): keep the client's retries, DROP the facade's — one turn per
 *    request, so the two layers can never multiply.
 *  - the user-facing bound is 7-8 minutes of "no real content", not "no bytes at all".
 *
 * Frozen contract:
 *  - `progressTimeoutMs` (env EXT_LAYER_PROGRESS_MS), default 420_000 ms, clamp finite>0, max
 *    3_600_000; it is the deadline for a turn that produces NO content-bearing frame.
 *  - progress = a frame that carries real work (`output_text.delta`, `function_call`,
 *    `reasoning*_text.delta`, `response.completed|incomplete|failed`, `[DONE]`).
 *    `response.heartbeat` and bare lifecycle frames (`response.created`, `response.in_progress`)
 *    are NOT progress.
 *  - a progress timeout fails LOUDLY: streaming gets an `event: error` frame + `data: [DONE]`
 *    (never a `response.completed`), non-streaming gets HTTP 504 `code="upstream_no_progress"`.
 *  - `transientRetryLimit` defaults to one attempt (0 or unset => no facade retry); an explicit
 *    positive value still retries that many times.
 *  - `/healthz` reports `active_requests`, `retry_limit`, `progress_timeout_ms`.
 *  - one log line per request (`req=<hex8>`), including `elapsed=` on completion and `code=` on
 *    failure.
 */
import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";

interface LayerOverrides {
  progressTimeoutMs?: number;
  transientRetryLimit?: number;
  retrySleepMs?: number;
  firstByteTimeoutMs?: number;
  stallTimeoutSec?: number;
}

function boot(upUrl: string, overrides: LayerOverrides = {}) {
  return startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: upUrl,
    tokenProvider: async () => "tok",
    port: 0,
    retrySleepMs: 1,
    ...overrides,
  });
}

function sse(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
    },
  });
}

const heartbeat = 'event: response.heartbeat\ndata: {"type":"response.heartbeat"}\n\n';
const created = 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_w21","status":"in_progress"}}\n\n';
const delta = (text: string) => `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${text}"}\n\n`;
const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_w21","status":"completed","output":[]}}\n\n';

async function readAll(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader!.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function post(layerUrl: string, body: Record<string, unknown>) {
  return fetch(`${layerUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Upstream that answers every turn with 500 + the transient family text. */
function failingUpstream() {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      calls += 1;
      return new Response(
        JSON.stringify({ error: { message: "ChatGPT ended the turn with 'Something went wrong'. Retry the turn." } }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), count: () => calls };
}

// A1 -----------------------------------------------------------------------------------------
test("A1: by default the facade opens exactly ONE upstream turn and lets the client retry", async () => {
  const up = failingUpstream();
  const layer = await boot(up.url);
  try {
    const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: "one turn only" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    // The client (harness) owns retries now: the facade must not multiply them.
    expect(up.count()).toBe(1);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

// A2 -----------------------------------------------------------------------------------------
test("A2: an explicit retry budget still retries (the knob survives for clients that do not)", async () => {
  const up = failingUpstream();
  const layer = await boot(up.url, { transientRetryLimit: 3 });
  try {
    const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: "explicit retries" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(up.count()).toBe(3);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

// A3 -----------------------------------------------------------------------------------------
test("A3: an empty completed turn fails closed once, not five times", async () => {
  let calls = 0;
  const up = Bun.serve({
    port: 0,
    async fetch() {
      calls += 1;
      return Response.json({
        id: "resp_empty",
        object: "response",
        status: "completed",
        model: "chatgpt-web/extra-high",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      });
    },
  });

  const layer = await boot(`http://127.0.0.1:${up.port}`);
  try {
    const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: "empty turn" });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("empty_turn_content");
    expect(calls).toBe(1);
  } finally {
    await layer.stop();
    up.stop(true);
  }
}, 20000);

// A4 -----------------------------------------------------------------------------------------
test("A4: a turn that only heartbeats is killed on the progress deadline, never completed", async () => {
  let calls = 0;
  const up = Bun.serve({
    port: 0,
    async fetch() {
      calls += 1;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(created));
          // Heartbeats forever, zero content — the exact shape of the stuck page.
          for (;;) {
            await new Promise(resolve => setTimeout(resolve, 100));
            controller.enqueue(encoder.encode(heartbeat));
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });

  const layer = await boot(`http://127.0.0.1:${up.port}`, { progressTimeoutMs: 600, stallTimeoutSec: 30 });
  try {
    const started = Date.now();
    const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", stream: true, input: "heartbeats only" });
    expect(res.status).toBe(200);
    const text = await readAll(res);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(6000);
    expect(text).toContain("event: error");
    expect(text).toContain("data: [DONE]");
    // The whole point: the client must never see this turn as a finished answer.
    expect(text).not.toContain("response.completed");
    expect(calls).toBe(1);
  } finally {
    await layer.stop();
    up.stop(true);
  }
}, 20000);

// A5 -----------------------------------------------------------------------------------------
test("A5: heartbeats plus steady real content keep the turn alive past the deadline", async () => {
  let calls = 0;
  const up = Bun.serve({
    port: 0,
    async fetch() {
      calls += 1;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(created));
          // 1.2s of work against a 600ms progress deadline: only real deltas may reset it.
          for (let i = 0; i < 6; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            controller.enqueue(encoder.encode(heartbeat));
            await new Promise(resolve => setTimeout(resolve, 100));
            controller.enqueue(encoder.encode(delta(`chunk-${i} `)));
          }
          controller.enqueue(encoder.encode(completed));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });

  const layer = await boot(`http://127.0.0.1:${up.port}`, { progressTimeoutMs: 600, stallTimeoutSec: 30 });
  try {
    const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", stream: true, input: "steady content" });
    expect(res.status).toBe(200);
    const text = await readAll(res);
    expect(text).toContain("chunk-5");
    expect(text).toContain("response.completed");
    expect(text).not.toContain("event: error");
    expect(calls).toBe(1);
  } finally {
    await layer.stop();
    up.stop(true);
  }
}, 20000);

// A6 -----------------------------------------------------------------------------------------
test("A6: a non-streaming turn with no answer at all fails 504 upstream_no_progress", async () => {
  const up = Bun.serve({
    port: 0,
    // Never answers: the deadline must be the only thing that ends this request.
    fetch() {
      return new Promise<Response>(() => {});
    },
  });

  const layer = await boot(`http://127.0.0.1:${up.port}`, { progressTimeoutMs: 600 });
  try {
    const started = Date.now();
    const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: "no answer" });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(504);
    const body = await res.text();
    expect(body).toContain("upstream_no_progress");
    expect(elapsed).toBeLessThan(6000);
  } finally {
    await layer.stop();
    up.stop(true);
  }
}, 20000);

// A7 -----------------------------------------------------------------------------------------
test("A7: every request is logged, and a failed one names its code", async () => {
  const up = Bun.serve({
    port: 0,
    fetch() {
      return new Promise<Response>(() => {});
    },
  });

  const layer = await boot(`http://127.0.0.1:${up.port}`, { progressTimeoutMs: 600 });
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await post(layer.baseUrl, { model: "chatgpt-web/latest", input: "logged request" });
    const joined = lines.join("\n");
    expect(joined).toContain("[external-layer] req=");
    expect(joined).toContain("model=");
    expect(joined).toMatch(/elapsed=\d+/);
    expect(joined).toContain("code=upstream_no_progress");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    await layer.stop();
    up.stop(true);
  }
}, 20000);

// A8 -----------------------------------------------------------------------------------------
test("A8: /healthz exposes the live budget so an operator can see the knobs", async () => {
  const up = failingUpstream();
  const layer = await boot(up.url, { progressTimeoutMs: 1234 });
  try {
    const res = await fetch(`${layer.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.progress_timeout_ms).toBe(1234);
    expect(body.retry_limit).toBe(1);
    expect(typeof body.active_requests).toBe("number");
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

// A9 -----------------------------------------------------------------------------------------
test("A9: a normal turn is untouched, and an explicit 0 still means one attempt", async () => {
  const up = Bun.serve({
    port: 0,
    async fetch() {
      return new Response(sse([created, delta("hello"), completed]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const layer = await boot(`http://127.0.0.1:${up.port}`, { transientRetryLimit: 0 });
  try {
    const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", stream: true, input: "normal turn" });
    expect(res.status).toBe(200);
    const text = await readAll(res);
    expect(text).toContain("hello");
    expect(text).toContain("response.completed");
    expect(text).toContain("data: [DONE]");
  } finally {
    await layer.stop();
    up.stop(true);
  }
}, 20000);

// A10 ----------------------------------------------------------------------------------------
test("A10: the facade installs no global side effects", async () => {
  const up = failingUpstream();
  const fetchBefore = globalThis.fetch;
  const serveBefore = globalThis.Bun.serve;
  const layer = await boot(up.url, { progressTimeoutMs: 5000 });
  try {
    await post(layer.baseUrl, { model: "chatgpt-web/latest", input: "no patching" });
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(globalThis.Bun.serve).toBe(serveBefore);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);
