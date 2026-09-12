/**
 * W19 canonical contract — per-ACCOUNT capabilities: who may see which tiers, where the account
 * truth comes from, and the fact that the request path must resolve a tier BEFORE opening any
 * upstream turn.
 *
 * Why this contract exists:
 *  - capabilities are currently a static pair of `ExternalLayerConfig` booleans defaulting to
 *    `true` (`config.solAvailable ?? true` / `config.proAvailable ?? true`), so a Luna-only or
 *    non-Pro account is served the Pro ladder unless the operator passes flags by hand;
 *  - the upstream home (`<upstreamHome>/config.json`) is already the source of truth for the
 *    deployment switch (`experimentalBiggerContext`), so account capabilities must come from the
 *    same file, per field, with an explicit config override, and must FAIL CLOSED to `false` when
 *    the file is missing, silent or corrupt;
 *  - the advertised window numbers must be copied verbatim per tier from the matching upstream
 *    row: no multiplication, no inheritance from a native row, no guessed default;
 *  - `model` + `reasoning_effort` must resolve to the concrete upstream tier slug before the turn
 *    is opened, and an impossible pair must fail loud (HTTP 400) instead of being silently
 *    answered by a different tier.
 *
 * Contract status: FROZEN. At the current code state these tests are RED on purpose — the
 * `account` block, the per-tier catalog rows and the request-side rejections below do not exist
 * yet. Do not relax them to make them pass.
 *
 * TypeScript-safety: `resolveAccountCapabilities` does not exist yet, so it is imported
 * DYNAMICALLY (`await import("../src/upstream-home")`) and reached through `any`; nothing in this
 * file statically imports a symbol that is missing, and no production module is cast with
 * `as any` / `@ts-ignore`, so `bunx tsc --noEmit` stays clean at the current code state.
 *
 * Contract adaptation (recorded for the implementer, see the A7/A8 note at the bottom of this
 * comment block) — A7 and A8 both name `solAvailable:false` yet demand opposite catalogs.
 * A7's "false/false config" case is therefore asserted only for the reading-independent half
 * (never extra-high, never pro), and the positive "latest + light/medium/high" half is asserted
 * against the internally consistent non-Pro Sol account.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startExternalLayer } from "../src/external-layer";
import { CHATGPT_WEB_UNIFIED_TIERS } from "../src/models";

const KEY = "sk-test-key";

// ---------------------------------------------------------------------------------------------
// Mock upstream
// ---------------------------------------------------------------------------------------------

interface UpRow {
  slug: string;
  context_window?: number;
  max_context_window?: number;
  effective_context_window_percent?: number | null;
  auto_compact_token_limit?: number | null;
  [key: string]: unknown;
}

/** The native Codex row: it must never leak into any advertised account row. */
const NATIVE_ROW: UpRow = {
  slug: "codex-auto-review",
  context_window: 272_000,
  max_context_window: 872_000,
  comp_hash: "3000",
};

/**
 * DELIBERATELY distinct window numbers per tier, so a copy/paste bug (one tier wearing another
 * tier's numbers) is visible instead of hidden behind shared values.
 */
const TIER_WINDOWS: Record<
  string,
  { context_window: number; max_context_window: number; effective_context_window_percent: number; auto_compact_token_limit: number }
> = {
  "chatgpt-web/light": { context_window: 41_000, max_context_window: 45_000, effective_context_window_percent: 81, auto_compact_token_limit: 32_000 },
  "chatgpt-web/medium": { context_window: 92_000, max_context_window: 96_000, effective_context_window_percent: 82, auto_compact_token_limit: 80_000 },
  "chatgpt-web/high": { context_window: 93_000, max_context_window: 97_000, effective_context_window_percent: 83, auto_compact_token_limit: 84_000 },
  "chatgpt-web/extra-high": { context_window: 111_193, max_context_window: 121_193, effective_context_window_percent: 84, auto_compact_token_limit: 95_000 },
  "chatgpt-web/pro": { context_window: 112_193, max_context_window: 122_193, effective_context_window_percent: 85, auto_compact_token_limit: 96_000 },
};

/** `reasoning_effort` → upstream tier slug, read from the live ladder export (never re-guessed). */
function slugForEffort(effort: string): string | undefined {
  return CHATGPT_WEB_UNIFIED_TIERS.find(tier => tier.effort === effort)?.slug;
}

function upstreamRows(): UpRow[] {
  return [
    NATIVE_ROW,
    ...Object.entries(TIER_WINDOWS).map(([slug, windows]) => ({ slug, ...windows })),
  ];
}

interface MockUpstream {
  url: string;
  stop: () => void;
  /** Query strings of every `GET /v1/models` hit. */
  modelsCalls: string[];
  /** Codex-native bodies of every `POST /v1/responses` turn — the proof a turn was opened. */
  turns: Array<Record<string, unknown>>;
}

function upstreamWith(rows: UpRow[] | "models-fail"): MockUpstream {
  const modelsCalls: string[] = [];
  const turns: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        modelsCalls.push(url.search);
        if (rows === "models-fail") return new Response("boom", { status: 500 });
        return Response.json({ models: rows });
      }
      if (url.pathname === "/v1/responses") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        turns.push(body);
        return Response.json({
          id: "resp_w19",
          object: "response",
          status: "completed",
          model: String(body.model ?? "chatgpt-web/extra-high"),
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), modelsCalls, turns };
}

// ---------------------------------------------------------------------------------------------
// Upstream home fixtures
// ---------------------------------------------------------------------------------------------

interface CapabilityConfig {
  solAvailable?: boolean;
  proAvailable?: boolean;
  experimentalBiggerContext?: boolean;
  [key: string]: unknown;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ext-layer-w19-"));
}

function homeWithConfig(value: unknown): string {
  const dir = tempDir();
  writeFileSync(join(dir, "config.json"), JSON.stringify(value), "utf8");
  return dir;
}

function homeWithRawConfig(raw: string): string {
  const dir = tempDir();
  writeFileSync(join(dir, "config.json"), raw, "utf8");
  return dir;
}

function homeWithoutConfig(): string {
  return tempDir();
}

// ---------------------------------------------------------------------------------------------
// Facade boot + HTTP helpers
// ---------------------------------------------------------------------------------------------

interface ExplicitCapabilities {
  solAvailable?: boolean;
  proAvailable?: boolean;
}

async function boot(upUrl: string, upstreamHome: string, explicit: ExplicitCapabilities = {}) {
  return startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: upUrl,
    tokenProvider: async () => "tok",
    port: 0,
    // Only forward the fields the test really declares: an omitted field must stay "unset" so the
    // config.json → false precedence chain is what gets exercised.
    ...(explicit.solAvailable === undefined ? {} : { solAvailable: explicit.solAvailable }),
    ...(explicit.proAvailable === undefined ? {} : { proAvailable: explicit.proAvailable }),
    upstreamHome,
  });
}

async function contextDoc(layerUrl: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${layerUrl}/v1/context`, { headers: { authorization: `Bearer ${KEY}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function accountOf(layerUrl: string): Promise<Record<string, unknown>> {
  const doc = await contextDoc(layerUrl);
  const account = doc.account;
  expect(account).toBeTruthy();
  expect(typeof account).toBe("object");
  return account as Record<string, unknown>;
}

interface Catalog {
  object?: unknown;
  /** Union of `models[].slug` and `data[].id`: the ids this account advertises, whatever the shape. */
  ids: string[];
  rows: Array<Record<string, unknown>>;
}

async function catalogOf(layerUrl: string): Promise<Catalog> {
  const res = await fetch(`${layerUrl}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
  expect(res.status).toBe(200);
  return parseCatalog(await res.text());
}

function parseCatalog(raw: string): Catalog {
  const parsed = JSON.parse(raw) as { data?: unknown; models?: unknown };
  const rows: Array<Record<string, unknown>> = [];
  const pushRows = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) rows.push(entry as Record<string, unknown>);
    }
  };
  pushRows(parsed.models);
  pushRows(parsed.data);
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.slug === "string") ids.add(row.slug);
    if (typeof row.id === "string") ids.add(row.id);
  }
  return { object: (parsed as Record<string, unknown>).object, ids: [...ids], rows };
}

function rowFor(catalog: Catalog, slug: string): Record<string, unknown> | undefined {
  return catalog.rows.find(row => row.slug === slug || row.id === slug);
}

async function postResponses(layerUrl: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${layerUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function parseBody(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The contract error shape is `{"error":{"type":"invalid_request_error","code":"<code>"}}`. */
async function expectClientError(res: Response, code: string): Promise<void> {
  const raw = await res.text();
  expect(res.status).toBe(400);
  const doc = parseBody(raw);
  const error = doc.error;
  expect(error).toBeTruthy();
  expect(typeof error).toBe("object");
  const record = error as Record<string, unknown>;
  expect(record.code).toBe(code);
  expect(record.type).toBe("invalid_request_error");
}

// ---------------------------------------------------------------------------------------------
// Capability resolution helper (to-be-created pure function, imported dynamically)
// ---------------------------------------------------------------------------------------------

interface CapabilityResult {
  solAvailable: boolean;
  proAvailable: boolean;
  source: string;
}

async function resolveCaps(home: string, explicit?: ExplicitCapabilities): Promise<CapabilityResult> {
  const mod: any = await import("../src/upstream-home");
  expect(typeof mod.resolveAccountCapabilities).toBe("function");
  const result = mod.resolveAccountCapabilities(home, explicit);
  expect(result).toBeTruthy();
  return result as CapabilityResult;
}

// =============================================================================================
// A1 — config.json is the account's source of truth
// =============================================================================================

test("A1 /v1/context exposes account {solAvailable, proAvailable, source} read from config.json", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: true, proAvailable: true });
  const layer = await boot(up.url, home);
  try {
    expect(await accountOf(layer.baseUrl)).toEqual({
      solAvailable: true,
      proAvailable: true,
      source: "upstream-config",
    });
    expect(await resolveCaps(home)).toEqual({
      solAvailable: true,
      proAvailable: true,
      source: "upstream-config",
    });
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A2 — an account that says "no" is reported as "no"
// =============================================================================================

test("A2 config.json {solAvailable:false, proAvailable:false} is reported as false/false from upstream-config", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: false, proAvailable: false });
  const layer = await boot(up.url, home);
  try {
    expect(await accountOf(layer.baseUrl)).toEqual({
      solAvailable: false,
      proAvailable: false,
      source: "upstream-config",
    });
    expect(await resolveCaps(home)).toEqual({
      solAvailable: false,
      proAvailable: false,
      source: "upstream-config",
    });
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A3 — capabilities merge PER FIELD with priority explicit → config.json → false
// =============================================================================================

test("A3 an explicit capability overrides only its own field and marks the result source explicit", async () => {
  const partial = homeWithConfig({ solAvailable: true, proAvailable: false });
  const full = homeWithConfig({ solAvailable: true, proAvailable: true });
  try {
    // explicit pro wins; sol still comes from config.json.
    const upgraded = await resolveCaps(partial, { proAvailable: true });
    expect(upgraded.solAvailable).toBe(true);
    expect(upgraded.proAvailable).toBe(true);
    expect(upgraded.source).toBe("explicit");

    // explicit sol wins (false); pro still comes from config.json (true).
    const downgraded = await resolveCaps(full, { solAvailable: false });
    expect(downgraded.solAvailable).toBe(false);
    expect(downgraded.proAvailable).toBe(true);
    expect(downgraded.source).toBe("explicit");
  } finally {
    rmSync(partial, { recursive: true, force: true });
    rmSync(full, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A4 — fail closed: missing fields / missing file / corrupt JSON ⇒ default + both false
// =============================================================================================

test("A4a missing fields, a missing config.json and corrupt JSON all resolve to false/false from default", async () => {
  const empty = homeWithConfig({});
  const absent = homeWithoutConfig();
  const corrupt = homeWithRawConfig("{ not json");
  try {
    for (const home of [empty, absent, corrupt]) {
      const caps = await resolveCaps(home);
      expect(caps.solAvailable).toBe(false);
      expect(caps.proAvailable).toBe(false);
      expect(caps.source).toBe("default");
    }
  } finally {
    for (const home of [empty, absent, corrupt]) rmSync(home, { recursive: true, force: true });
  }
}, 20000);

test("A4b a corrupt or missing config.json leaves the HTTP surface usable and never claims explicit", async () => {
  const up = upstreamWith(upstreamRows());
  const corrupt = homeWithRawConfig("{ not json");
  const absent = homeWithoutConfig();
  const corruptLayer = await boot(up.url, corrupt);
  try {
    const caps = await accountOf(corruptLayer.baseUrl);
    expect(caps.source).not.toBe("explicit");
    expect(caps.source).toBe("default");
    expect(caps.solAvailable).toBe(false);
    expect(caps.proAvailable).toBe(false);
  } finally {
    corruptLayer.stop();
  }
  const absentLayer = await boot(up.url, absent);
  try {
    const caps = await accountOf(absentLayer.baseUrl);
    expect(caps.source).toBe("default");
    expect(caps.solAvailable).toBe(false);
    expect(caps.proAvailable).toBe(false);
  } finally {
    absentLayer.stop();
    up.stop();
    rmSync(corrupt, { recursive: true, force: true });
    rmSync(absent, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A5 — an explicit yes beats a config.json that says no
// =============================================================================================

test("A5 explicit {true,true} beats a config.json that says false/false", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: false, proAvailable: false });
  const layer = await boot(up.url, home, { solAvailable: true, proAvailable: true });
  try {
    const caps = await accountOf(layer.baseUrl);
    expect(caps.solAvailable).toBe(true);
    expect(caps.proAvailable).toBe(true);
    expect(caps.source).toBe("explicit");
    expect(await resolveCaps(home, { solAvailable: true, proAvailable: true })).toEqual({
      solAvailable: true,
      proAvailable: true,
      source: "explicit",
    });

    // The override must also reach the model surface: a Pro tier is advertised again.
    const catalog = await catalogOf(layer.baseUrl);
    expect(catalog.ids).toContain("chatgpt-web/pro");
    expect(catalog.ids).toContain("chatgpt-web/extra-high");
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A6 — a Pro account advertises every tier as its OWN row with that tier's OWN windows
// =============================================================================================

test("A6 a Pro account advertises latest plus every tier row, each with its own upstream windows", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: true, proAvailable: true });
  const layer = await boot(up.url, home);
  try {
    const res = await fetch(`${layer.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const catalog = parseCatalog(raw);

    for (const id of ["chatgpt-web/latest", "chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/pro"]) {
      expect(catalog.ids).toContain(id);
    }

    const extraHigh = rowFor(catalog, "chatgpt-web/extra-high");
    expect(extraHigh).toBeTruthy();
    expect(extraHigh?.context_window).toBe(TIER_WINDOWS["chatgpt-web/extra-high"].context_window);
    expect(extraHigh?.max_context_window).toBe(TIER_WINDOWS["chatgpt-web/extra-high"].max_context_window);
    expect(extraHigh?.auto_compact_token_limit).toBe(TIER_WINDOWS["chatgpt-web/extra-high"].auto_compact_token_limit);
    expect(extraHigh?.effective_context_window_percent).toBe(TIER_WINDOWS["chatgpt-web/extra-high"].effective_context_window_percent);

    const pro = rowFor(catalog, "chatgpt-web/pro");
    expect(pro).toBeTruthy();
    expect(pro?.context_window).toBe(TIER_WINDOWS["chatgpt-web/pro"].context_window);
    expect(pro?.max_context_window).toBe(TIER_WINDOWS["chatgpt-web/pro"].max_context_window);
    expect(pro?.auto_compact_token_limit).toBe(TIER_WINDOWS["chatgpt-web/pro"].auto_compact_token_limit);
    expect(pro?.effective_context_window_percent).toBe(TIER_WINDOWS["chatgpt-web/pro"].effective_context_window_percent);

    // `latest` is the unified id: its default effort must name a real tier and wear that tier's
    // numbers — never a number of its own.
    const latest = rowFor(catalog, "chatgpt-web/latest");
    expect(latest).toBeTruthy();
    const latestEffort = latest?.x_ext_layer_latest_effort;
    expect(typeof latestEffort).toBe("string");
    const defaultSlug = slugForEffort(String(latestEffort));
    expect(defaultSlug).toBeTruthy();
    expect(latest?.context_window).toBe(TIER_WINDOWS[String(defaultSlug)].context_window);
    expect(latest?.max_context_window).toBe(TIER_WINDOWS[String(defaultSlug)].max_context_window);
    expect(latest?.auto_compact_token_limit).toBe(TIER_WINDOWS[String(defaultSlug)].auto_compact_token_limit);

    // No native-row number and no native-row metadata may leak into the body.
    expect(raw).not.toContain("272000");
    expect(raw).not.toContain("872000");
    expect(latest?.comp_hash).toBeUndefined();
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A7 — a non-Pro account never sees the Pro tier
// =============================================================================================

test("A7a a non-Pro Sol account advertises latest, light, medium, high — never extra-high or pro", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: true, proAvailable: false });
  const layer = await boot(up.url, home);
  try {
    const catalog = await catalogOf(layer.baseUrl);
    expect(catalog.ids).toContain("chatgpt-web/latest");
    expect(catalog.ids).toContain("chatgpt-web/light");
    expect(catalog.ids).toContain("chatgpt-web/medium");
    expect(catalog.ids).toContain("chatgpt-web/high");
    expect(catalog.ids).not.toContain("chatgpt-web/extra-high");
    expect(catalog.ids).not.toContain("chatgpt-web/pro");
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

test("A7b an explicit proAvailable:false trims the Pro tier even when config.json says true", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: true, proAvailable: true });
  const layer = await boot(up.url, home, { proAvailable: false });
  try {
    const catalog = await catalogOf(layer.baseUrl);
    expect(catalog.ids).toContain("chatgpt-web/latest");
    expect(catalog.ids).toContain("chatgpt-web/light");
    expect(catalog.ids).toContain("chatgpt-web/medium");
    expect(catalog.ids).toContain("chatgpt-web/high");
    expect(catalog.ids).not.toContain("chatgpt-web/extra-high");
    expect(catalog.ids).not.toContain("chatgpt-web/pro");
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

test("A7c a config.json false/false account never advertises extra-high or pro", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: false, proAvailable: false });
  const layer = await boot(up.url, home);
  try {
    // Reading-agnostic half of A7: whatever a solAvailable:false account advertises, the Pro
    // ladder must not appear (the positive half is A7a/A7b above — see the A7/A8 note).
    const catalog = await catalogOf(layer.baseUrl);
    expect(catalog.ids).not.toContain("chatgpt-web/extra-high");
    expect(catalog.ids).not.toContain("chatgpt-web/pro");
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A8 — a Luna-only account keeps luna/think and never sees the unified id
// =============================================================================================

test("A8 a solAvailable:false account advertises luna and think, never chatgpt-web/latest", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: false });
  const layer = await boot(up.url, home);
  try {
    const caps = await accountOf(layer.baseUrl);
    expect(caps.solAvailable).toBe(false);

    const catalog = await catalogOf(layer.baseUrl);
    expect(catalog.ids).toContain("chatgpt-web/luna");
    expect(catalog.ids).toContain("chatgpt-web/think");
    expect(catalog.ids).not.toContain("chatgpt-web/latest");
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A9 — every advertised row's numbers ARE the matching upstream row's numbers
// =============================================================================================

test("A9 every advertised tier row copies its context_window verbatim from the matching upstream row", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: true, proAvailable: true });
  const layer = await boot(up.url, home);
  try {
    const catalog = await catalogOf(layer.baseUrl);
    for (const [slug, windows] of Object.entries(TIER_WINDOWS)) {
      const row = rowFor(catalog, slug);
      expect(`${slug}:${row ? "present" : "MISSING"}`).toBe(`${slug}:present`);
      expect(row?.context_window).toBe(windows.context_window);
      expect(row?.max_context_window).toBe(windows.max_context_window);
      expect(row?.auto_compact_token_limit).toBe(windows.auto_compact_token_limit);
      expect(row?.effective_context_window_percent).toBe(windows.effective_context_window_percent);
    }
    // Nothing invented: no advertised row may report a multiplication or a native-row number.
    for (const row of catalog.rows) {
      expect(row.context_window).not.toBe(NATIVE_ROW.context_window);
      expect(row.max_context_window).not.toBe(NATIVE_ROW.max_context_window);
    }
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A10 — request side: an available tier reaches the upstream as its own slug
// =============================================================================================

test("A10 a Pro account's chatgpt-web/pro and consistent high+high both reach the upstream slug", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: true, proAvailable: true });
  const layer = await boot(up.url, home, { solAvailable: true, proAvailable: true });
  try {
    const pro = await postResponses(layer.baseUrl, { model: "chatgpt-web/pro", input: "hi" });
    expect(pro.status).toBe(200);
    expect(up.turns.length).toBe(1);
    expect(up.turns[0]?.model).toBe("chatgpt-web/pro");

    const high = await postResponses(layer.baseUrl, { model: "chatgpt-web/high", input: "hi", reasoning_effort: "high" });
    expect(high.status).toBe(200);
    expect(up.turns.length).toBe(2);
    expect(up.turns[1]?.model).toBe("chatgpt-web/high");
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A11 — a contradictory model/effort pair fails BEFORE any upstream turn
// =============================================================================================

test("A11 model chatgpt-web/high with reasoning_effort max is rejected as conflicting_tier with no upstream turn", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: true, proAvailable: true });
  const layer = await boot(up.url, home, { solAvailable: true, proAvailable: true });
  try {
    const res = await postResponses(layer.baseUrl, {
      model: "chatgpt-web/high",
      input: "hi",
      reasoning_effort: "max",
    });
    await expectClientError(res, "conflicting_tier");
    expect(up.turns.length).toBe(0);
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A12 — an unavailable tier is refused, never silently degraded
// =============================================================================================

test("A12 a non-Pro account is refused chatgpt-web/pro and latest+max with tier_unavailable and no turn", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ experimentalBiggerContext: false });
  const layer = await boot(up.url, home, { solAvailable: true, proAvailable: false });
  try {
    const pro = await postResponses(layer.baseUrl, { model: "chatgpt-web/pro", input: "hi" });
    await expectClientError(pro, "tier_unavailable");
    expect(up.turns.length).toBe(0);

    const maxEffort = await postResponses(layer.baseUrl, {
      model: "chatgpt-web/latest",
      input: "hi",
      reasoning_effort: "max",
    });
    await expectClientError(maxEffort, "tier_unavailable");
    expect(up.turns.length).toBe(0);
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// =============================================================================================
// A13 — regression locks: unknown effort still 400, and the no-effort default still resolves
// =============================================================================================

test("A13 nonsense effort is invalid_reasoning_effort, while no effort resolves to the advertised default tier", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: true, proAvailable: true });
  const layer = await boot(up.url, home, { solAvailable: true, proAvailable: true });
  try {
    const nonsense = await postResponses(layer.baseUrl, {
      model: "chatgpt-web/latest",
      input: "hi",
      reasoning_effort: "nonsense",
    });
    await expectClientError(nonsense, "invalid_reasoning_effort");
    expect(up.turns.length).toBe(0);

    // The tier actually used is measured from the native body the mock received, and it must be
    // the tier the catalog advertised as `x_ext_layer_latest_effort`.
    const catalog = await catalogOf(layer.baseUrl);
    const latest = rowFor(catalog, "chatgpt-web/latest");
    expect(latest).toBeTruthy();
    const advertisedEffort = String(latest?.x_ext_layer_latest_effort);
    const expectedSlug = slugForEffort(advertisedEffort);
    expect(expectedSlug).toBeTruthy();

    const implied = await postResponses(layer.baseUrl, { model: "chatgpt-web/latest", input: "hi" });
    expect(implied.status).toBe(200);
    expect(up.turns.length).toBe(1);
    expect(up.turns[0]?.model).toBe(String(expectedSlug));
    expect(up.turns[0]?.model).not.toBe("chatgpt-web/latest");
    expect(String(up.turns[0]?.model).startsWith("chatgpt-web/")).toBe(true);
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// A14 — the unified row's default tier follows the ACCOUNT (added 2026-09-12 by the landing owner:
// the mutation gate found that nothing asserted the non-Pro default, so a mutant that kept the
// Pro-only `xhigh` default for every account survived the wave's own contract).
test("A14 a non-Pro account's unified row defaults to the highest tier it can use (high), never the Pro-only xhigh", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: true, proAvailable: false });
  const layer = await boot(up.url, home);
  try {
    const catalog = await catalogOf(layer.baseUrl);
    const latest = rowFor(catalog, "chatgpt-web/latest");
    expect(latest).toBeDefined();
    expect(latest!.x_ext_layer_latest_effort).toBe("high");
    expect(latest!.default_reasoning_level).toBe("high");
    expect(latest!.context_window).toBe(TIER_WINDOWS["chatgpt-web/high"].context_window);
    expect(latest!.auto_compact_token_limit).toBe(TIER_WINDOWS["chatgpt-web/high"].auto_compact_token_limit);
    // the Pro-only tier's numbers must not leak onto the summary row
    expect(latest!.context_window).not.toBe(TIER_WINDOWS["chatgpt-web/extra-high"].context_window);
    const levels = latest!.supported_reasoning_levels as Array<{ effort?: string }>;
    expect(levels.map(level => level.effort)).toEqual(["low", "medium", "high"]);
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// A15 — the OpenAI `data[]` surface must list every advertised tier (added 2026-09-12 by the landing
// owner). Standard clients discover models from `data[].id`; advertising the tiers only in `models[]`
// would silently defeat the whole point of per-tier rows.
test("A15 the OpenAI data[] surface lists every advertised tier, not only the unified id", async () => {
  const up = upstreamWith(upstreamRows());
  const home = homeWithConfig({ solAvailable: true, proAvailable: true });
  const layer = await boot(up.url, home);
  try {
    const res = await fetch(`${layer.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(await res.text()) as { data?: Array<{ id?: string }> };
    const ids = (parsed.data ?? []).map(entry => entry.id);
    for (const slug of ["chatgpt-web/latest", "chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/pro"]) {
      expect(ids).toContain(slug);
    }
    expect(ids.length).toBe(6);
  } finally {
    layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);
