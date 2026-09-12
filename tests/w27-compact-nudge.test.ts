/**
 * w27-compact-nudge :: after ONE qualifying big-payload failure, the next big request on the
 * same conversation gets a synthetic COMPLETED response (HTTP 200) whose text tells the agent
 * to compact / start a new conversation — instead of another doomed upstream turn (or a 429
 * the client would blindly retry). The agent can then act on it (call its compaction tool).
 *
 * Contract:
 * - trigger: breaker has >=1 counted failure for the thread AND this request's payload is
 *   >= payloadCharsThreshold (the same threshold that qualifies failures for counting);
 * - response: 200 + Responses-shaped completed output_text carrying the reminder; headers
 *   `x-ext-layer-nudge: conversation_too_large` and `x-ext-layer-conversation` (same thread
 *   as the failed turn); NO `x-ext-layer-replay` (must not enter the idempotency store);
 * - no upstream turn is opened for the nudged request;
 * - streaming requests get a full SSE sequence (created → output_text.delta → completed → [DONE]);
 * - chat/completions keeps the W24 429 refusal (nudge is Responses-surface only);
 * - the nudge is not recorded as a breaker success or failure; small payloads never nudge;
 * - failureBreaker.enabled:false restores the pre-W27 behavior entirely.
 */
import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";
const BIG_TEXT = "x".repeat(2500);

type UpstreamMock = {
  url: string;
  count: () => number;
  stop: () => Promise<void>;
};

function mockUpstream(opts: { failures?: number } = {}): UpstreamMock {
  let calls = 0;
  const failures = opts.failures ?? 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/admin/")) return Response.json({ ok: true });
      if (path === "/models") return Response.json({ models: [] });
      if (path === "/v1/responses" && req.method === "POST") {
        calls += 1;
        if (calls <= failures) {
          return Response.json(
            {
              error: {
                message: "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
                code: "upstream_server_error",
              },
            },
            { status: 500 },
          );
        }
        return Response.json({
          id: `resp_mock_${calls}`,
          object: "response",
          status: "completed",
          model: "chatgpt-web/high",
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: `OK-${calls}`, annotations: [] }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        });
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    count: () => calls,
    stop: () => server.stop(true),
  };
}

async function boot(upstreamBaseUrl: string, failureBreaker: Record<string, unknown>) {
  const layer = await startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl,
    tokenProvider: async () => "tok",
    port: 0,
    retrySleepMs: 1,
    failureBreaker,
  } as Parameters<typeof startExternalLayer>[0]);
  return layer;
}

function bigInput() {
  return [{ role: "user", type: "message", content: [{ type: "input_text", text: BIG_TEXT }] }];
}

async function post(baseUrl: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const breakerCfg = { payloadCharsThreshold: 2000 };

test("A1: after one qualifying failure the next big request is nudged with a completed reminder, not another upstream turn", async () => {
  const up = mockUpstream({ failures: 1 });
  const layer = await boot(up.url, breakerCfg);
  try {
    const first = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: false });
    expect(first.status).toBe(500);
    const firstConv = first.headers.get("x-ext-layer-conversation");
    expect(firstConv).toBeTruthy();

    const second = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: false });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-ext-layer-nudge")).toBe("conversation_too_large");
    expect(second.headers.get("x-ext-layer-conversation")).toBe(firstConv);
    expect(second.headers.get("x-ext-layer-replay")).toBeNull();
    const body = (await second.json()) as { status: string; output: Array<{ content: Array<{ text: string }> }> };
    expect(body.status).toBe("completed");
    const text = body.output[0].content[0].text;
    expect(text).toContain("Compact this conversation");
    expect(text).toMatch(/~\d+ tokens/);
    expect(up.count()).toBe(1);
  } finally {
    await layer.stop();
    await up.stop();
  }
}, 20000);

test("A2: streaming requests get the nudge as a full SSE sequence ending in [DONE]", async () => {
  const up = mockUpstream({ failures: 1 });
  const layer = await boot(up.url, breakerCfg);
  try {
    const first = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: false });
    expect(first.status).toBe(500);

    const second = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: true });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-ext-layer-nudge")).toBe("conversation_too_large");
    const text = await second.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain('"type":"response.output_text.delta"');
    expect(text).toContain("Compact this conversation");
    expect(text).toContain('"type":"response.completed"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(up.count()).toBe(1);
  } finally {
    await layer.stop();
    await up.stop();
  }
}, 20000);

test("A3: no prior failure — a big request still goes upstream and is never nudged", async () => {
  const up = mockUpstream({ failures: 0 });
  const layer = await boot(up.url, breakerCfg);
  try {
    const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: false });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ext-layer-nudge")).toBeNull();
    expect(up.count()).toBe(1);
  } finally {
    await layer.stop();
    await up.stop();
  }
}, 20000);

test("A4: a small payload in the same conversation is never nudged", async () => {
  const up = mockUpstream({ failures: 1 });
  const layer = await boot(up.url, breakerCfg);
  try {
    const first = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: false });
    expect(first.status).toBe(500);
    const small = await post(layer.baseUrl, {
      model: "chatgpt-web/latest",
      input: [{ role: "user", type: "message", content: [{ type: "input_text", text: "ping" }] }],
      stream: false,
    });
    expect(small.status).toBe(200);
    expect(small.headers.get("x-ext-layer-nudge")).toBeNull();
    expect(up.count()).toBe(2);
  } finally {
    await layer.stop();
    await up.stop();
  }
}, 20000);

test("A5: failureBreaker disabled restores the pre-W27 behavior (no nudge, upstream every time)", async () => {
  const up = mockUpstream({ failures: 1 });
  const layer = await boot(up.url, { enabled: false, payloadCharsThreshold: 2000 });
  try {
    const first = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: false });
    expect(first.status).toBe(500);
    const second = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: false });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-ext-layer-nudge")).toBeNull();
    expect(up.count()).toBe(2);
  } finally {
    await layer.stop();
    await up.stop();
  }
}, 20000);

test("A6: nudges repeat for repeated oversized sends and never enter the idempotency store", async () => {
  const up = mockUpstream({ failures: 1 });
  const layer = await boot(up.url, breakerCfg);
  try {
    const first = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: false });
    expect(first.status).toBe(500);
    for (let i = 0; i < 2; i += 1) {
      const nudged = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: false });
      expect(nudged.status).toBe(200);
      expect(nudged.headers.get("x-ext-layer-nudge")).toBe("conversation_too_large");
      expect(nudged.headers.get("x-ext-layer-replay")).toBeNull();
    }
    expect(up.count()).toBe(1);
  } finally {
    await layer.stop();
    await up.stop();
  }
}, 20000);

test("A7: no global side effects", async () => {
  const fetchBefore = globalThis.fetch;
  const serveBefore = Bun.serve;
  const up = mockUpstream({ failures: 1 });
  const layer = await boot(up.url, breakerCfg);
  try {
    await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: false });
    await post(layer.baseUrl, { model: "chatgpt-web/latest", input: bigInput(), stream: false });
  } finally {
    await layer.stop();
    await up.stop();
  }
  expect(globalThis.fetch).toBe(fetchBefore);
  expect(Bun.serve).toBe(serveBefore);
}, 20000);