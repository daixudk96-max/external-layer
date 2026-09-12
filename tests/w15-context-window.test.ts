/**
 * W15 canonical contract — context windows come from the LIVE upstream catalog, never from a
 * hand-filled table and never from a non-`chatgpt-web/` (native) row.
 *
 * Why this contract exists (observed on 2026-09-12, all values live):
 *  - the facade advertised `context_window: 272000 / max_context_window: 872000` because the
 *    template row was the native `codex-auto-review` row, while the upstream ChatGPT-web rows
 *    (which carry the real per-tier numbers) said 333579 / 285000 / 85;
 *  - the client hard-coded a third number (333579) in its own settings;
 *  - the multiplier is a *deployment* switch: upstream `experimentalBiggerContext` is true today
 *    (so 333579 = 111193 x 3) and is forced off for manual/Zero-Risk interaction, so the same
 *    route answers with 111193 at other times.
 *
 * Therefore: the facade must REPORT the upstream truth (per tier) and must never invent, guess,
 * or inherit it from a different row family.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";

interface UpRow {
  slug: string;
  context_window?: number;
  max_context_window?: number;
  effective_context_window_percent?: number | null;
  auto_compact_token_limit?: number | null;
  [key: string]: unknown;
}

/** The native Codex row the facade used to inherit its (wrong) numbers from. */
const NATIVE_ROW: UpRow = { slug: "codex-auto-review", context_window: 272_000, max_context_window: 872_000, comp_hash: "3000" };

/** Per-tier upstream rows with DELIBERATELY distinct numbers so per-tier derivation is provable. */
function distinctTiers(): UpRow[] {
  return [
    { slug: "chatgpt-web/light", context_window: 41_000, max_context_window: 41_000, effective_context_window_percent: 85, auto_compact_token_limit: 32_000 },
    { slug: "chatgpt-web/medium", context_window: 90_000, max_context_window: 90_000, effective_context_window_percent: 85, auto_compact_token_limit: 80_000 },
    { slug: "chatgpt-web/high", context_window: 90_000, max_context_window: 90_000, effective_context_window_percent: 85, auto_compact_token_limit: 80_000 },
    { slug: "chatgpt-web/extra-high", context_window: 111_193, max_context_window: 111_193, effective_context_window_percent: 85, auto_compact_token_limit: 95_000 },
    { slug: "chatgpt-web/pro", context_window: 112_193, max_context_window: 112_193, effective_context_window_percent: 85, auto_compact_token_limit: 95_000 },
  ];
}

/** The same ladder with the 3x deployment switch ON (the live 2026-09-12 numbers). */
function tripleTiers(): UpRow[] {
  return [
    { slug: "chatgpt-web/light", context_window: 333_579, max_context_window: 333_579, effective_context_window_percent: 85, auto_compact_token_limit: 285_000 },
    { slug: "chatgpt-web/medium", context_window: 333_579, max_context_window: 333_579, effective_context_window_percent: 85, auto_compact_token_limit: 285_000 },
    { slug: "chatgpt-web/high", context_window: 333_579, max_context_window: 333_579, effective_context_window_percent: 85, auto_compact_token_limit: 285_000 },
    { slug: "chatgpt-web/extra-high", context_window: 333_579, max_context_window: 333_579, effective_context_window_percent: 85, auto_compact_token_limit: 285_000 },
    { slug: "chatgpt-web/pro", context_window: 336_579, max_context_window: 336_579, effective_context_window_percent: 85, auto_compact_token_limit: 285_000 },
  ];
}

function upstreamWith(rows: UpRow[] | "models-fail") {
  const modelsCalls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        modelsCalls.push(url.search);
        if (rows === "models-fail") return new Response("boom", { status: 500 });
        return Response.json({ models: rows });
      }
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      return Response.json({
        id: "resp_ctx",
        object: "response",
        status: "completed",
        model: String(body.model ?? "chatgpt-web/extra-high"),
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), modelsCalls };
}

function homeWithConfig(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ext-layer-home-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(value), "utf8");
  return dir;
}

function boot(upUrl: string, upstreamHome: string, proAvailable = true) {
  return startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: upUrl,
    tokenProvider: async () => "tok",
    port: 0,
    solAvailable: true,
    proAvailable,
    upstreamHome,
  });
}

async function modelsBody(layerUrl: string): Promise<string> {
  const res = await fetch(`${layerUrl}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
  expect(res.status).toBe(200);
  return res.text();
}

function latestRowOf(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as { models?: Array<Record<string, unknown>> };
  const row = (parsed.models ?? []).find(entry => entry.slug === "chatgpt-web/latest");
  expect(row).toBeTruthy();
  return row as Record<string, unknown>;
}

// A1 -----------------------------------------------------------------------------------------
test("A1 the unified row reports the upstream web-tier numbers, never the native row's", async () => {
  const up = upstreamWith([NATIVE_ROW, ...distinctTiers()]);
  const home = homeWithConfig({ experimentalBiggerContext: false });
  const layer = await boot(up.url, home);
  try {
    const body = await modelsBody(layer.baseUrl);
    const row = latestRowOf(body);
    expect(row.context_window).toBe(111_193); // the facade's default tier (xhigh -> extra-high)
    expect(row.max_context_window).toBe(111_193);
    expect(row.auto_compact_token_limit).toBe(95_000);
    expect(row.effective_context_window_percent).toBe(85);
    expect(row.x_ext_layer_latest_effort).toBe("xhigh");
    expect(body).not.toContain("272000");
    expect(body).not.toContain("872000");
    expect(row.comp_hash).toBeUndefined();
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// A2 -----------------------------------------------------------------------------------------
test("A2 the same code reports 3x numbers when the deployment switch is on (nothing is hardcoded)", async () => {
  const up = upstreamWith([NATIVE_ROW, ...tripleTiers()]);
  const home = homeWithConfig({ experimentalBiggerContext: true });
  const layer = await boot(up.url, home);
  try {
    const row = latestRowOf(await modelsBody(layer.baseUrl));
    expect(row.context_window).toBe(333_579);
    expect(row.max_context_window).toBe(333_579);
    expect(row.auto_compact_token_limit).toBe(285_000);
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// A3 -----------------------------------------------------------------------------------------
test("A3 every tier keeps its own window, exposed per effort", async () => {
  const up = upstreamWith([NATIVE_ROW, ...distinctTiers()]);
  const home = homeWithConfig({ experimentalBiggerContext: false });
  const layer = await boot(up.url, home);
  try {
    const row = latestRowOf(await modelsBody(layer.baseUrl));
    const tiers = row.x_ext_layer_tier_windows as Record<string, Record<string, unknown>>;
    expect(Object.keys(tiers).sort()).toEqual(["high", "low", "max", "medium", "xhigh"]);
    expect(tiers.low.slug).toBe("chatgpt-web/light");
    expect(tiers.low.context_window).toBe(41_000);
    expect(tiers.medium.context_window).toBe(90_000);
    expect(tiers.xhigh.context_window).toBe(111_193);
    expect(tiers.max.slug).toBe("chatgpt-web/pro");
    expect(tiers.max.context_window).toBe(112_193);
    expect(row.x_ext_layer_context_source).toBe("upstream");
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// A4 -----------------------------------------------------------------------------------------
test("A4 an account without Pro never sees a Pro window", async () => {
  const up = upstreamWith([NATIVE_ROW, ...distinctTiers()]);
  const home = homeWithConfig({ experimentalBiggerContext: false });
  const layer = await boot(up.url, home, false);
  try {
    const row = latestRowOf(await modelsBody(layer.baseUrl));
    const tiers = row.x_ext_layer_tier_windows as Record<string, Record<string, unknown>>;
    expect(Object.keys(tiers)).not.toContain("max");
    // AMENDED 2026-09-12 (task feat-09-12-account-capability-models, wave w19): the previous
    // assertion here was `expect(row.context_window).toBe(111_193)` with the comment "the default
    // tier (xhigh) is available without Pro". That premise was factually wrong: upstream marks the
    // `extra-high` (xhigh) route `requiresPro: true` (ccw-upstream/src/chatgpt-web-models.ts:345-346),
    // so on an account without Pro both xhigh and max are unavailable and the default tier falls back
    // to `high` => 90_000. W19 supersedes the old expectation; see tests/w19-account-capabilities.test.ts.
    expect(row.x_ext_layer_latest_effort).toBe("high");
    expect(row.context_window).toBe(90_000);
    expect(row.context_window).not.toBe(111_193); // xhigh is Pro-only: its window must not leak here
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// A5 -----------------------------------------------------------------------------------------
test("A5 with no upstream web tier row the facade reports unavailability instead of a wrong number", async () => {
  const up = upstreamWith([NATIVE_ROW]); // native row only: nothing may be inherited from it
  const home = homeWithConfig({ experimentalBiggerContext: true });
  const layer = await boot(up.url, home);
  try {
    const body = await modelsBody(layer.baseUrl);
    const row = latestRowOf(body);
    expect(row.x_ext_layer_context_source).toBe("unavailable");
    expect(row.x_ext_layer_tier_windows).toEqual({});
    expect(row.context_window).toBeUndefined();
    expect(row.max_context_window).toBeUndefined();
    expect(row.auto_compact_token_limit).toBeUndefined();
    expect(body).not.toContain("272000");
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// A6 -----------------------------------------------------------------------------------------
test("A6 /v1/context reports the ladder plus the deployment switch, and leaks no upstream config", async () => {
  const up = upstreamWith([NATIVE_ROW, ...distinctTiers()]);
  const secret = "Zx9_Qw3-Er7Ty1Ui5Op8As2Df4Gh6Jk0Lm3Nv5Bc7Xz9Qw1Er";
  const home = homeWithConfig({ experimentalBiggerContext: true, controlToken: secret });
  const layer = await boot(up.url, home);
  try {
    const res = await fetch(`${layer.baseUrl}/v1/context`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(secret);
    const doc = JSON.parse(text) as Record<string, unknown>;
    expect(doc.object).toBe("context");
    expect(doc.model).toBe("chatgpt-web/latest");
    expect(doc.bigger_context).toBe(true);
    expect(doc.latest_context_window).toBe(111_193);
    expect(doc.latest_effort).toBe("xhigh");
    expect(typeof doc.source).toBe("string");
    const tiers = doc.tiers as Record<string, Record<string, unknown>>;
    expect(tiers.xhigh.context_window).toBe(111_193);
    expect(tiers.xhigh.auto_compact_token_limit).toBe(95_000);

    // The switch flips without restarting the facade: the config is read per request.
    writeFileSync(join(home, "config.json"), JSON.stringify({ experimentalBiggerContext: false }), "utf8");
    const again = await fetch(`${layer.baseUrl}/v1/context`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(((await again.json()) as Record<string, unknown>).bigger_context).toBe(false);

    // An unreadable / silent config must answer null, never a guess.
    writeFileSync(join(home, "config.json"), "{ not json", "utf8");
    const broken = await fetch(`${layer.baseUrl}/v1/context`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(broken.status).toBe(200);
    expect(((await broken.json()) as Record<string, unknown>).bigger_context).toBeNull();
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// A7 -----------------------------------------------------------------------------------------
test("A7 /v1/context fails loudly when the upstream catalog is unavailable", async () => {
  const up = upstreamWith("models-fail");
  const home = homeWithConfig({ experimentalBiggerContext: true });
  const layer = await boot(up.url, home);
  try {
    const res = await fetch(`${layer.baseUrl}/v1/context`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(502);
    const doc = (await res.json()) as { error?: { code?: string } };
    expect(doc.error?.code).toBe("upstream_unreachable");
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// A8 -----------------------------------------------------------------------------------------
test("A8 each turn is stamped with the window of the tier it actually used", async () => {
  const up = upstreamWith([NATIVE_ROW, ...distinctTiers()]);
  const home = homeWithConfig({ experimentalBiggerContext: false });
  const layer = await boot(up.url, home);
  try {
    const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
    const low = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "chatgpt-web/latest", input: "hi", reasoning_effort: "low" }),
    });
    expect(low.status).toBe(200);
    expect(low.headers.get("x-ext-layer-context-window")).toBe("41000");

    const medium = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "chatgpt-web/latest", input: "hi", reasoning_effort: "medium" }),
    });
    expect(medium.headers.get("x-ext-layer-context-window")).toBe("90000");

    const chat = await fetch(`${layer.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "chatgpt-web/latest", messages: [{ role: "user", content: "hi" }], reasoning_effort: "xhigh" }),
    });
    expect(chat.status).toBe(200);
    expect(chat.headers.get("x-ext-layer-context-window")).toBe("111193");
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// A9 -----------------------------------------------------------------------------------------
test("A9 an unknown effort is still rejected, and the catalog shape is unchanged", async () => {
  const up = upstreamWith([NATIVE_ROW, ...distinctTiers()]);
  const home = homeWithConfig({ experimentalBiggerContext: false });
  const layer = await boot(up.url, home);
  try {
    const bad = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", input: "hi", reasoning_effort: "maxx" }),
    });
    expect(bad.status).toBe(400);
    const doc = (await bad.json()) as { error?: { code?: string } };
    expect(doc.error?.code).toBe("invalid_reasoning_effort");

    const listing = JSON.parse(await modelsBody(layer.baseUrl)) as { object?: string; data?: Array<{ id?: string }> };
    expect(listing.object).toBe("list");
    // AMENDED 2026-09-12 (task feat-09-12-account-capability-models, wave w19): the pre-W19 shape was
    // exactly `data === ["chatgpt-web/latest"]`. W19 deliberately advertises one row per tier the
    // account can use — a client that discovers models from `data[].id` must be able to see them —
    // so the shape guarantee is now "the unified id leads, and every listed id is a facade row".
    const listed = (listing.data ?? []).map(entry => entry.id);
    expect(listed[0]).toBe("chatgpt-web/latest");
    expect(listed.length).toBeGreaterThanOrEqual(1);
    expect(listed.every(id => typeof id === "string" && id.startsWith("chatgpt-web/"))).toBe(true);
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

// A10 ----------------------------------------------------------------------------------------
test("A10 /v1/context is behind the same api key as every other route", async () => {
  const up = upstreamWith([NATIVE_ROW, ...distinctTiers()]);
  const home = homeWithConfig({ experimentalBiggerContext: true });
  const layer = await boot(up.url, home);
  try {
    const res = await fetch(`${layer.baseUrl}/v1/context`);
    expect(res.status).toBe(401);
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
