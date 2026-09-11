import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";

function upstreamSequence(mode: "transient-then-ok" | "non-transient") {
  let calls = 0;
  const turnIds: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls += 1;
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const meta = (body.client_metadata ?? {}) as Record<string, unknown>;
      const turn = (meta["x-codex-turn-metadata"] ?? {}) as Record<string, unknown>;
      turnIds.push(String(turn.turn_id ?? ""));
      if (mode === "non-transient") {
        return Response.json({ error: { message: "invalid_request_error: bad model" } }, { status: 400 });
      }
      if (calls === 1) {
        return Response.json({ error: { message: "ChatGPT ended the turn with 'Something went wrong'. Retry the turn." } }, { status: 502 });
      }
      return Response.json({ id: "resp_ok", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "PONG" }] }] });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), stats: { get calls() { return calls; }, turnIds } };
}

async function post(layerUrl: string): Promise<Response> {
  return fetch(`${layerUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer sk-test-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/latest", input: "say PONG" }),
  });
}

test("a transient upstream failure is retried with a fresh identity and then succeeds", async () => {
  const upstream = upstreamSequence("transient-then-ok");
  const layer = await startExternalLayer({ apiKey: "sk-test-key", upstreamBaseUrl: upstream.url, tokenProvider: async () => "tok", port: 0, transientRetryLimit: 3, retrySleepMs: 1 });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(200);
    expect(upstream.stats.calls).toBe(2);
    expect(upstream.stats.turnIds[0]).not.toBe(upstream.stats.turnIds[1]);
    expect(upstream.stats.turnIds[0]?.startsWith("prov-")).toBe(true);
  } finally {
    await layer.stop();
    upstream.stop();
  }
});

test("a non-transient upstream error is surfaced and never retried", async () => {
  const upstream = upstreamSequence("non-transient");
  const layer = await startExternalLayer({ apiKey: "sk-test-key", upstreamBaseUrl: upstream.url, tokenProvider: async () => "tok", port: 0, transientRetryLimit: 3, retrySleepMs: 1 });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(400);
    expect(upstream.stats.calls).toBe(1);
  } finally {
    await layer.stop();
    upstream.stop();
  }
});

test("retries can be disabled with transientRetryLimit 0", async () => {
  const upstream = upstreamSequence("transient-then-ok");
  const layer = await startExternalLayer({ apiKey: "sk-test-key", upstreamBaseUrl: upstream.url, tokenProvider: async () => "tok", port: 0, transientRetryLimit: 0, retrySleepMs: 1 });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(502);
    expect(upstream.stats.calls).toBe(1);
  } finally {
    await layer.stop();
    upstream.stop();
  }
});

test("an empty completed turn is not passed through as success", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ id: "resp_empty", object: "response", status: "completed", output: [] }) });
  const layer = await startExternalLayer({ apiKey: "sk-test-key", upstreamBaseUrl: `http://127.0.0.1:${server.port}`, tokenProvider: async () => "tok", port: 0, transientRetryLimit: 1, retrySleepMs: 1 });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(502);
    const body = await res.json() as { code?: string; error?: { code?: string } };
    expect(String(body.code ?? body.error?.code)).toContain("empty_turn_content");
  } finally {
    await layer.stop();
    server.stop(true);
  }
});
