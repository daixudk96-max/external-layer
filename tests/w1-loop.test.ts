import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";

function fakeUpstream(): { url: string; stop: () => void; seen: { auth?: string; body?: unknown } } {
  const seen: { auth?: string; body?: unknown } = {};
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.auth = req.headers.get("authorization") ?? undefined;
      seen.body = await req.json().catch(() => undefined);
      return Response.json({ id: "resp_fake", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "PONG" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), seen };
}

test("standard /v1/responses round-trips through the external layer", async () => {
  const upstream = fakeUpstream();
  const layer = await startExternalLayer({ apiKey: "sk-test-key", upstreamBaseUrl: upstream.url, tokenProvider: async () => "oauth-token", port: 0 });
  try {
    const res = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer sk-test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", input: "say PONG" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status?: string; output?: unknown[] };
    expect(body.status).toBe("completed");
    expect(JSON.stringify(body.output)).toContain("PONG");
    expect(upstream.seen.auth).toBe("Bearer oauth-token");
    const forwarded = JSON.stringify(upstream.seen.body ?? {});
    expect(forwarded).toContain("prov-");
  } finally {
    await layer.stop();
    upstream.stop();
  }
});

test("missing or wrong api key fails closed with 401", async () => {
  const upstream = fakeUpstream();
  const layer = await startExternalLayer({ apiKey: "sk-test-key", upstreamBaseUrl: upstream.url, tokenProvider: async () => "oauth-token", port: 0 });
  try {
    const noKey = await fetch(`${layer.baseUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chatgpt-web/latest", input: "x" }) });
    expect(noKey.status).toBe(401);
    const wrongKey = await fetch(`${layer.baseUrl}/v1/responses`, { method: "POST", headers: { authorization: "Bearer sk-wrong", "content-type": "application/json" }, body: JSON.stringify({ model: "chatgpt-web/latest", input: "x" }) });
    expect(wrongKey.status).toBe(401);
  } finally {
    await layer.stop();
    upstream.stop();
  }
});

test("an upstream failure is surfaced, never faked as success", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: { message: "upstream boom" } }, { status: 502 }) });
  const layer = await startExternalLayer({ apiKey: "sk-test-key", upstreamBaseUrl: `http://127.0.0.1:${server.port}`, tokenProvider: async () => "oauth-token", port: 0 });
  try {
    const res = await fetch(`${layer.baseUrl}/v1/responses`, { method: "POST", headers: { authorization: "Bearer sk-test-key", "content-type": "application/json" }, body: JSON.stringify({ model: "chatgpt-web/latest", input: "x" }) });
    expect(res.status).toBe(502);
  } finally {
    await layer.stop();
    server.stop(true);
  }
});
