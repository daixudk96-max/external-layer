import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";

/** Mock upstream: counts calls and returns a body whose `id` reveals the call index. */
function upstream(mode: "json" | "sse" = "json") {
  let calls = 0;
  const turnIds: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const adminPath = new URL(req.url).pathname;
      // /admin/* is turn cancellation, not a turn: it must not be counted as one.
      if (adminPath.startsWith('/admin/')) return Response.json({ ok: true });
      calls += 1;
      const index = calls;
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const meta = (body.client_metadata ?? {}) as Record<string, unknown>;
      const turn = (meta["x-codex-turn-metadata"] ?? {}) as Record<string, unknown>;
      turnIds.push(String(turn.turn_id ?? ""));
      if (mode === "sse") {
        const payload = [
          "event: response.created",
          `data: {"type":"response.created","response":{"id":"resp_${index}","status":"in_progress"}}`,
          "",
          "event: response.output_text.delta",
          `data: {"type":"response.output_text.delta","delta":"PONG-${index}"}`,
          "",
          "event: response.completed",
          `data: {"type":"response.completed","response":{"id":"resp_${index}","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"PONG-${index}"}]}],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n");
        return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        id: `resp_${index}`,
        object: "response",
        status: "completed",
        model: "chatgpt-web/extra-high",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `PONG-${index}` }] }],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    stats: { get calls() { return calls; }, turnIds },
  };
}

function post(layerUrl: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${layerUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "chatgpt-web/latest", input: "say PONG", ...body }),
  });
}

test("an identical request replays the stored response without touching the upstream", async () => {
  const up = upstream();
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const first = await post(layer.baseUrl, {});
    const firstBody = await first.text();
    expect(first.status).toBe(200);
    expect(up.stats.calls).toBe(1);

    const started = Date.now();
    const second = await post(layer.baseUrl, {});
    const secondBody = await second.text();
    const elapsed = Date.now() - started;

    expect(second.status).toBe(200);
    expect(up.stats.calls).toBe(1);
    expect(secondBody).toBe(firstBody);
    expect(second.headers.get("x-ext-layer-replay")).toBe("true");
    expect(elapsed).toBeLessThan(300);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("a different request body is a different idempotency key", async () => {
  const up = upstream();
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const first = await post(layer.baseUrl, { input: "say PONG" });
    const second = await post(layer.baseUrl, { input: "say PONG again" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(up.stats.calls).toBe(2);
    expect(up.stats.turnIds[0]).not.toBe(up.stats.turnIds[1]);
    expect(second.headers.get("x-ext-layer-replay")).toBeNull();
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("an explicit Idempotency-Key header wins over the body digest", async () => {
  const up = upstream();
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const first = await post(layer.baseUrl, { input: "first wording" }, { "idempotency-key": "turn-abc" });
    const firstBody = await first.text();
    const second = await post(layer.baseUrl, { input: "second wording" }, { "idempotency-key": "turn-abc" });
    expect(await second.text()).toBe(firstBody);
    expect(up.stats.calls).toBe(1);
    expect(second.headers.get("x-ext-layer-replay")).toBe("true");
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("concurrent identical requests open exactly one upstream turn", async () => {
  const up = upstream();
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const [a, b] = await Promise.all([post(layer.baseUrl, {}), post(layer.baseUrl, {})]);
    const [bodyA, bodyB] = [await a.text(), await b.text()];
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(up.stats.calls).toBe(1);
    expect(bodyA).toBe(bodyB);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("a failed turn is never stored as a replayable success", async () => {
  const up = upstream();
  let failing = true;
  const flaky = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (failing) {
        return Response.json({ error: { message: "ChatGPT ended the turn with 'Something went wrong'. Retry the turn." } }, { status: 502 });
      }
      // Preserve the path when proxying: the facade fires a fire-and-forget
      // POST /admin/interrupt-turn after a failed turn (W22), and a path-dropping
      // proxy would land it on "/" where `up` counts it as a turn — the source of
      // this test's historic flake.
      return fetch(up.url + new URL(req.url).pathname, { method: req.method, headers: req.headers, body: await req.text() });
    },
  });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: `http://127.0.0.1:${flaky.port}`, tokenProvider: async () => "tok", port: 0, transientRetryLimit: 1, retrySleepMs: 1 });
  try {
    const failed = await post(layer.baseUrl, {});
    expect(failed.status).toBe(502);

    failing = false;
    const retried = await post(layer.baseUrl, {});
    expect(retried.status).toBe(200);
    expect(up.stats.calls).toBe(1);
    expect(retried.headers.get("x-ext-layer-replay")).toBeNull();
  } finally {
    await layer.stop();
    flaky.stop(true);
    up.stop();
  }
});

test("a replay survives a process restart when a state path is configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ext-layer-w8-"));
  const statePath = join(dir, "state.json");
  const up = upstream();
  const first = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0, statePath });
  let firstBody = "";
  try {
    const res = await post(first.baseUrl, {});
    firstBody = await res.text();
    expect(res.status).toBe(200);
  } finally {
    await first.stop();
  }
  const second = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0, statePath });
  try {
    const res = await post(second.baseUrl, {});
    expect(await res.text()).toBe(firstBody);
    expect(res.headers.get("x-ext-layer-replay")).toBe("true");
    expect(up.stats.calls).toBe(1);
  } finally {
    await second.stop();
    up.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a streamed response is replayed as the same event stream", async () => {
  const up = upstream("sse");
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const first = await post(layer.baseUrl, { stream: true });
    const firstBody = await first.text();
    expect(first.status).toBe(200);
    expect(firstBody).toContain('"delta":"PONG-1"');
    expect(up.stats.calls).toBe(1);

    const second = await post(layer.baseUrl, { stream: true });
    expect(await second.text()).toBe(firstBody);
    expect(second.headers.get("x-ext-layer-replay")).toBe("true");
    expect(up.stats.calls).toBe(1);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("an expired entry hits the upstream again", async () => {
  const up = upstream();
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0, idempotencyTtlMs: 20 });
  try {
    await post(layer.baseUrl, {});
    await Bun.sleep(80);
    const res = await post(layer.baseUrl, {});
    expect(res.status).toBe(200);
    expect(up.stats.calls).toBe(2);
    expect(res.headers.get("x-ext-layer-replay")).toBeNull();
  } finally {
    await layer.stop();
    up.stop();
  }
});
