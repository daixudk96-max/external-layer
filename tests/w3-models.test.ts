import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";
import { tierSlugForEffort, unifiedCatalog, UnknownEffortError } from "../src/models";

const upstreamCatalog = { models: [{ slug: "gpt-6-astra" }, { slug: "gpt-6-mini" }] };

test("a Sol account gets one unified latest row with five effort levels", () => {
  const catalog = unifiedCatalog(upstreamCatalog, { solAvailable: true, proAvailable: true });
  expect(catalog.models.map(model => model.slug)).toEqual(["chatgpt-web/latest"]);
  expect(catalog.data.map(row => row.id)).toEqual(["chatgpt-web/latest"]);
  const latest = catalog.models[0] as { default_reasoning_level?: string; supported_reasoning_levels?: Array<{ effort: string }> };
  expect(latest.default_reasoning_level).toBe("xhigh");
  expect(latest.supported_reasoning_levels?.map(level => level.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
});

test("a luna-only account keeps its historical rows", () => {
  const catalog = unifiedCatalog(upstreamCatalog, { solAvailable: false, proAvailable: false });
  const slugs = catalog.models.map(model => String(model.slug));
  expect(slugs).toContain("chatgpt-web/luna");
  expect(slugs).toContain("chatgpt-web/think");
  expect(slugs).not.toContain("chatgpt-web/latest");
});

test("effort maps to tiers with xhigh as the default", () => {
  const capabilities = { solAvailable: true, proAvailable: true };
  expect(tierSlugForEffort(undefined, capabilities)).toBe("chatgpt-web/extra-high");
  expect(tierSlugForEffort("low", capabilities)).toBe("chatgpt-web/light");
  expect(tierSlugForEffort("medium", capabilities)).toBe("chatgpt-web/medium");
  expect(tierSlugForEffort("high", capabilities)).toBe("chatgpt-web/high");
  expect(tierSlugForEffort("xhigh", capabilities)).toBe("chatgpt-web/extra-high");
  expect(tierSlugForEffort("max", capabilities)).toBe("chatgpt-web/pro");
});

test("an effort outside the ladder throws instead of silently dropping to the default tier", () => {
  const capabilities = { solAvailable: true, proAvailable: true };
  expect(() => tierSlugForEffort("nonsense", capabilities)).toThrow(UnknownEffortError);
  expect(() => tierSlugForEffort("pro", capabilities)).toThrow(/supported values: low, medium, high, xhigh, max/);
});

/** Mock upstream that echoes the tier slug it was asked for, so the mapping is observable on the wire. */
function tierEchoUpstream() {
  const models: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { model?: string };
      models.push(String(body.model));
      return Response.json({
        id: "resp_tier",
        object: "response",
        status: "completed",
        model: body.model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), models };
}

test("the flat reasoning_effort field selects the tier, and nested reasoning.effort wins over it", async () => {
  const upstream = tierEchoUpstream();
  const layer = await startExternalLayer({ apiKey: "sk-test-key", upstreamBaseUrl: upstream.url, tokenProvider: async () => "tok", port: 0, solAvailable: true, proAvailable: true });
  const post = (body: Record<string, unknown>) => fetch(`${layer.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer sk-test-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/latest", input: "say OK", ...body }),
  });
  try {
    const flat = await post({ reasoning_effort: "low" });
    expect(flat.status).toBe(200);
    expect((await flat.json() as { model?: string }).model).toBe("chatgpt-web/light");

    const nested = await post({ reasoning: { effort: "max" } });
    expect(nested.status).toBe(200);
    expect((await nested.json() as { model?: string }).model).toBe("chatgpt-web/pro");

    const both = await post({ reasoning_effort: "low", reasoning: { effort: "high" } });
    expect(both.status).toBe(200);
    expect((await both.json() as { model?: string }).model).toBe("chatgpt-web/high");

    const unset = await post({});
    expect(unset.status).toBe(200);
    expect((await unset.json() as { model?: string }).model).toBe("chatgpt-web/extra-high");

    expect(upstream.models).toEqual(["chatgpt-web/light", "chatgpt-web/pro", "chatgpt-web/high", "chatgpt-web/extra-high"]);
  } finally {
    await layer.stop();
    upstream.stop();
  }
});

test("an unknown effort is rejected with 400 before any upstream turn is opened", async () => {
  const upstream = tierEchoUpstream();
  const layer = await startExternalLayer({ apiKey: "sk-test-key", upstreamBaseUrl: upstream.url, tokenProvider: async () => "tok", port: 0, solAvailable: true, proAvailable: true });
  try {
    const res = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer sk-test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", reasoning_effort: "maxx", input: "say OK" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string; type?: string } };
    expect(body.error?.code).toBe("invalid_reasoning_effort");
    expect(body.error?.type).toBe("invalid_request_error");
    expect(body.error?.message).toContain("low, medium, high, xhigh, max");
    expect(upstream.models).toEqual([]);
  } finally {
    await layer.stop();
    upstream.stop();
  }
});
