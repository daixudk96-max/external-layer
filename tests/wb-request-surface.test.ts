/**
 * WB canonical contract — request-surface passthrough: the facade MUST expose the upstream's
 * companion request surfaces instead of answering them with its own 404.
 *
 * Why this contract exists:
 *  - A Codex client talks to the facade as if it were the upstream, so every route the upstream
 *    serves has to exist at the facade. Today only `POST /v1/responses`, `POST /v1/chat/completions`,
 *    `GET /v1/models`, `GET /v1/context` and `GET /healthz` are routed; everything else falls through
 *    to `src/external-layer.ts:1916` (`Unsupported route: ...`, status 404).
 *  - Upstream (the unmodified codex-chatgpt-web) serves the missing surfaces at
 *    `ccw-upstream/src/server.ts:1001` (`POST /v1/responses/compact`),
 *    `ccw-upstream/src/server.ts:981` (`GET /v1/responses`) and
 *    `ccw-upstream/src/server.ts:1015` (`POST /v1/alpha/search`).
 *
 * Frozen contract (the facade MUST gain these three routes):
 *  1. `POST /v1/responses/compact` is a BYTE-IDENTICAL passthrough: the upstream sees method POST on
 *     pathname `/v1/responses/compact` and the exact body text the client sent; the client gets the
 *     upstream status code and body back verbatim and NO `x-ext-layer-replay` header (a compaction is
 *     not a replayed turn).
 *  2. Compaction is NOT idempotency-cached: two identical bodies produce two upstream calls.
 *  3. `GET /v1/responses` must not be a facade 404; the upstream status (426) and body message text
 *     reach the client unchanged.
 *  4. `POST /v1/alpha/search` is forwarded to pathname `/v1/alpha/search` and the upstream body is
 *     returned verbatim.
 *  5. Auth parity with the rest of the surface: all three routes answer 401 (facade
 *     `unauthorized()`, `src/external-layer.ts:202-207`) when the apiKey is missing, without a single
 *     upstream call and without leaking any upstream body into the 401.
 *  6. Upstream unreachable (dead port) maps to 502 with `error.code === "upstream_unreachable"` on all
 *     three routes — the same facade-synthesized envelope the turn routes use
 *     (`src/external-layer.ts:1359`, `:1737`).
 *  7. These routes fabricate no conversation state: repeated small payloads must never come back with
 *     an `x-ext-layer-conversation` header that the turn routes mint (`src/external-layer.ts:829`).
 */
import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";
/** Dead port: connection refused immediately (verified on this machine), so the 502 path is fast. */
const DEAD_UPSTREAM = "http://127.0.0.1:1";

/** Raw client body, byte-identical check target for A1. */
const COMPACT_BODY =
  '{"model":"chatgpt-web/latest","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"compact me"}]}]}';
/** Raw upstream answers, verbatim forwarding check targets. */
const COMPACT_RESPONSE = '{"object":"response.compaction","status":"completed"}';
const RESPONSES_426_BODY =
  '{"error":{"message":"Responses WebSocket transport is not enabled on this local route","type":"invalid_request_error"}}';
const SEARCH_BODY = '{"query":"x"}';
const SEARCH_RESPONSE = '{"results":[]}';

interface ParsedBody {
  error?: { message?: string; type?: string; code?: string };
  [key: string]: unknown;
}

function parseBody(text: string): ParsedBody | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as ParsedBody) : undefined;
  } catch {
    return undefined;
  }
}

interface CapturedCall {
  method: string;
  path: string;
  bodyText: string;
  authorization: string;
  contentType: string;
}

/**
 * Mock upstream: serves the catalog (so facade catalog calls can never hang) plus the three
 * request-surface routes, then records and 404s everything else. Admin paths are answered but NOT
 * recorded — only non-admin paths count as upstream calls.
 */
function mockUpstream() {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/admin/")) return Response.json({ ok: true });
      calls.push({
        method: req.method,
        path: url.pathname,
        bodyText: req.method === "GET" || req.method === "HEAD" ? "" : await req.text(),
        authorization: req.headers.get("authorization") ?? "",
        contentType: req.headers.get("content-type") ?? "",
      });
      if (url.pathname === "/v1/models") return Response.json({ models: [] });
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        return new Response(COMPACT_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (req.method === "GET" && url.pathname === "/v1/responses") {
        return new Response(RESPONSES_426_BODY, { status: 426, headers: { "content-type": "application/json" } });
      }
      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        return new Response(SEARCH_RESPONSE, { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: `mock upstream: unhandled ${req.method} ${url.pathname}` } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls,
    callsTo: (path: string, method?: string) =>
      calls.filter(call => call.path === path && (method === undefined || call.method === method)),
    stop: () => server.stop(true),
  };
}

function boot(upstreamBaseUrl: string) {
  return startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl,
    tokenProvider: async () => "tok",
    port: 0,
    retrySleepMs: 1,
  });
}

interface CallResult {
  status: number;
  text: string;
  replay: string | null;
  conversation: string | null;
  body: ParsedBody | undefined;
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  rawBody?: string,
  options: { authorized?: boolean } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (options.authorized !== false) headers.authorization = `Bearer ${KEY}`;
  if (rawBody !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(rawBody !== undefined ? { body: rawBody } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    replay: res.headers.get("x-ext-layer-replay"),
    conversation: res.headers.get("x-ext-layer-conversation"),
    body: parseBody(text),
  };
}

interface RouteSpec {
  label: string;
  method: string;
  path: string;
  rawBody?: string;
}

const ROUTES: RouteSpec[] = [
  { label: "POST /v1/responses/compact", method: "POST", path: "/v1/responses/compact", rawBody: COMPACT_BODY },
  { label: "GET /v1/responses", method: "GET", path: "/v1/responses" },
  { label: "POST /v1/alpha/search", method: "POST", path: "/v1/alpha/search", rawBody: SEARCH_BODY },
];

test("A1 POST /v1/responses/compact forwards the body byte-identically and returns the upstream answer verbatim", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const res = await call(layer.baseUrl, "POST", "/v1/responses/compact", COMPACT_BODY);
    const forwarded = up.callsTo("/v1/responses/compact", "POST");
    expect(forwarded.length).toBe(1);
    expect(forwarded[0]!.path).toBe("/v1/responses/compact");
    expect(forwarded[0]!.method).toBe("POST");
    // Byte-identical: the facade forwards the client's raw text, it does not re-serialize it.
    expect(forwarded[0]!.bodyText).toBe(COMPACT_BODY);
    // The upstream call is authenticated (the facade's own credential, not the client key).
    expect(forwarded[0]!.authorization).not.toBe("");
    // Upstream status + body come back verbatim, and compaction is never marked as a replay.
    expect(res.status).toBe(200);
    expect(res.text).toBe(COMPACT_RESPONSE);
    expect(res.body).toEqual({ object: "response.compaction", status: "completed" });
    expect(res.replay).toBeNull();
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A2 compaction is not idempotency-cached: the identical body is sent upstream twice", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const first = await call(layer.baseUrl, "POST", "/v1/responses/compact", COMPACT_BODY);
    const second = await call(layer.baseUrl, "POST", "/v1/responses/compact", COMPACT_BODY);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const forwarded = up.callsTo("/v1/responses/compact", "POST");
    expect(forwarded.length).toBe(2);
    expect(forwarded.map(call => call.bodyText)).toEqual([COMPACT_BODY, COMPACT_BODY]);
    // Neither answer may be a cached replay.
    expect(first.replay).toBeNull();
    expect(second.replay).toBeNull();
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A3 GET /v1/responses is not a facade 404: the upstream status and body message reach the client", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const res = await call(layer.baseUrl, "GET", "/v1/responses");
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(426);
    expect(res.text).toBe(RESPONSES_426_BODY);
    expect(res.body?.error?.message).toBe("Responses WebSocket transport is not enabled on this local route");
    expect(res.body?.error?.type).toBe("invalid_request_error");
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A4 POST /v1/alpha/search is forwarded and its upstream body is returned verbatim", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const res = await call(layer.baseUrl, "POST", "/v1/alpha/search", SEARCH_BODY);
    const forwarded = up.callsTo("/v1/alpha/search", "POST");
    expect(forwarded.length).toBe(1);
    expect(forwarded[0]!.bodyText).toBe(SEARCH_BODY);
    expect(res.status).toBe(200);
    expect(res.text).toBe(SEARCH_RESPONSE);
    expect(res.body).toEqual({ results: [] });
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A5 auth parity: each new route answers 401 without the apiKey and leaks no upstream body", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    for (const route of ROUTES) {
      const res = await call(layer.baseUrl, route.method, route.path, route.rawBody, { authorized: false });
      expect(`${route.label} -> ${res.status}`).toBe(`${route.label} -> 401`);
      // The 401 is the facade's own envelope, never the upstream's answer echoed back.
      expect(res.text.includes("response.compaction")).toBe(false);
      expect(res.text.includes("Responses WebSocket transport is not enabled on this local route")).toBe(false);
      expect(res.text.includes("compact me")).toBe(false);
      expect(res.text.includes('"results"')).toBe(false);
    }
    // Rejected before any upstream work happened at all.
    expect(up.calls.length).toBe(0);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A6 a dead upstream maps every new route to 502 upstream_unreachable", async () => {
  const layer = await boot(DEAD_UPSTREAM);
  try {
    for (const route of ROUTES) {
      const res = await call(layer.baseUrl, route.method, route.path, route.rawBody);
      expect(`${route.label} -> ${res.status}`).toBe(`${route.label} -> 502`);
      expect(res.body?.error?.code).toBe("upstream_unreachable");
      expect(res.body?.error?.message).toBeTruthy();
    }
  } finally {
    await layer.stop();
  }
}, 20000);

test("A7 the new routes fabricate no conversation state across repeated requests", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    for (const route of ROUTES) {
      const first = await call(layer.baseUrl, route.method, route.path, route.rawBody);
      const second = await call(layer.baseUrl, route.method, route.path, route.rawBody);
      // The route must really exist: otherwise the header assertions below pass vacuously on a 404.
      expect(`${route.label} first -> ${first.status}`).not.toBe(`${route.label} first -> 404`);
      expect(`${route.label} second -> ${second.status}`).not.toBe(`${route.label} second -> 404`);
      // Absence is either a missing header or an empty string, never a minted thread id.
      expect(first.conversation === null || first.conversation === "").toBe(true);
      expect(second.conversation === null || second.conversation === "").toBe(true);
    }
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);
