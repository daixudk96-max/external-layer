/**
 * w18-health-latch :: canonical contract.
 *
 * The gap this wave closes: `GET /healthz` treats the last error as a LATCH. One failed turn
 * (an upstream 4xx/5xx, or a client abort) pins `status:"degraded"` for the whole life of the
 * process, so a long-running facade that has fully recovered still reports itself as broken --
 * which is exactly what produced the false failure in tests/w13-equivalence.test.ts case 3 on a
 * long-running process.
 *
 * The frozen contract encoded here: /healthz reflects the CURRENT state, never a permanent scar.
 *  - fresh process, no request -> status:"ok" and last_error absent/null/null-ish.
 *  - the most recent terminal upstream outcome was a failure -> status:"degraded" plus a
 *    non-empty last_error string.
 *  - a LATER successful turn clears it -> status:"ok" and last_error cleared.
 *  - another failure after that success re-arms it -> status:"degraded" again (so it is not
 *    "clear once and never set again").
 *  - a client aborted turn is just another non-success outcome: it may degrade health, and a
 *    later success must clear it.
 *  - /healthz stays unauthenticated, keeps its existing shape (status, requests, optional
 *    last_error), answers HTTP 200 in every state, and leaks neither the upstream control token
 *    nor the facade api key.
 *  - /v1/models stays byte-identical whether or not the health semantics were exercised, and
 *    booting/turning mutates no global.
 *
 * Why this is RED before the wave lands: the "cleared after a later success" cases (H3, H5) fail
 * against the latch, while "fresh is ok" / "a failure degrades" (H1, H2, H4) already pass -- so
 * the file pins the fix rather than the current behaviour, and never the other way round.
 *
 * Test-harness notes:
 *  - the mock upstream switches from failing to succeeding INSIDE a test (a mutable per-request
 *    flag), which is what lets one test prove "failure, then success, then cleared" in order.
 *  - every turn body carries a fresh nonce: two identical bodies would be replayed by the
 *    facade's idempotency store instead of opening a new upstream turn.
 *  - every boot sets `transientRetryLimit: 1` (one attempt, no backoff sleep): retry pacing is
 *    orthogonal to what health reports, and it keeps a failing turn terminal inside the budget
 *    instead of burning 2s+4s+... on the real backoff. All other config is the wave's plain
 *    `{ apiKey, upstreamBaseUrl, tokenProvider, port: 0 }` shape.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startExternalLayer } from "../src/external-layer";

/** Distinctive client-facing key: if it ever surfaces in /healthz, H7 fails. */
const KEY = "sk-w18-health-latch-key-9f3a7c1d5b8e2";
/** Distinctive control token in the mock upstream home: any leak into /healthz is an H7 failure. */
const CONTROL_TOKEN = "ctl-W18Zx9Qw3Er7Ty1Ui5Op8As2Df4Gh6Jk0Lm3Nv5Bc";

/** Upstream first-byte delay long enough that a client abort lands mid-flight (H5, H7). */
const ABORT_CASE_UPSTREAM_DELAY_MS = 3000;
/** How long the client waits before aborting: comfortably inside the upstream delay. */
const ABORT_AT_MS = 400;
/** How long the interrupt may take to appear after the abort (the abort path's completion signal). */
const INTERRUPT_DEADLINE_MS = 2000;
/** How long the degraded state may take to show up after an event with no client-visible answer. */
const DEGRADED_DEADLINE_MS = 2000;
/** How many async-failure probes a case is allowed before declaring no unhandled rejection. */
const ASYNC_QUIET_MS = 300;

/** Deterministic upstream catalog, so /v1/models is meaningful and byte-stable (H8). */
const UPSTREAM_CATALOG = {
  models: [
    { slug: "chatgpt-web/extra-high", context_window: 111_193, max_context_window: 111_193, effective_context_window_percent: 85, auto_compact_token_limit: 95_000 },
    { slug: "chatgpt-web/light", context_window: 41_000, max_context_window: 41_000, effective_context_window_percent: 85, auto_compact_token_limit: 32_000 },
  ],
};

// ---------------------------------------------------------------------------------------------
// A process-level rejection watcher: "the abort path must not break the process" is part of the
// contract, so those paths are observed rather than assumed.
// ---------------------------------------------------------------------------------------------
const asyncFailures: string[] = [];
process.on("unhandledRejection", (reason: unknown) => {
  asyncFailures.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
process.on("uncaughtException", (error: unknown) => {
  asyncFailures.push(`uncaughtException: ${error instanceof Error ? error.message : String(error)}`);
});

function drainAsyncFailures(): void {
  asyncFailures.length = 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
}

// ---------------------------------------------------------------------------------------------
// Mock upstream. Its failure mode is a MUTABLE flag read per request, so one test can prove
// "it failed, then it succeeded, and health followed" -- a fixed-failure mock could never do it.
// ---------------------------------------------------------------------------------------------
interface InterruptCall {
  auth: string | null;
  raw: string;
}

function upstream(opts: { firstByteDelayMs?: number; hostileFailureBody?: boolean; sse?: boolean } = {}) {
  let firstByteDelayMs = opts.firstByteDelayMs ?? 0;
  /** Mutable per-request outcome: the same mock can fail first and succeed later inside one test. */
  let failing = false;
  let responsesCalls = 0;
  let completedResponses = 0;
  const interrupts: InterruptCall[] = [];
  const adminAttempts: string[] = [];

  const serve = Bun.serve({
    port: 0,
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/admin/")) {
        adminAttempts.push(`${req.method} ${url.pathname}`);
        const raw = await req.text();
        if (url.pathname === "/admin/interrupt-turn") {
          interrupts.push({ auth: req.headers.get("authorization"), raw });
        }
        return Response.json({ ok: true });
      }

      if (url.pathname === "/v1/models") {
        return Response.json(UPSTREAM_CATALOG);
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        responsesCalls += 1;
        const callIndex = responsesCalls;
        await req.text().catch(() => "");
        await Bun.sleep(firstByteDelayMs);

        if (failing) {
          // Optionally hostile: the failure payload carries both secrets, so a facade that stores
          // the raw upstream payload as its "last error" would leak them through /healthz (H7).
          const detail = opts.hostileFailureBody ? `${CONTROL_TOKEN} ${KEY}` : "deliberate mock failure";
          return Response.json({ error: { message: `mock upstream failure ${callIndex}`, detail } }, { status: 500 });
        }

        completedResponses += 1;
        // Streaming mode (`opts.sse`): the same successful turn as real SSE frames ending in the
        // `data: [DONE]` terminator, so a client that drains the body really drives the facade's
        // stream-completion path -- the one that clears a previous failure. The failure branch above
        // stays JSON in both modes: an upstream 5xx never arrives as an event stream.
        if (opts.sse) {
          const sse = [
            "event: response.created",
            `data: {"type":"response.created","response":{"id":"resp_w18_${callIndex}","status":"in_progress"}}`,
            "",
            "event: response.output_text.delta",
            `data: {"type":"response.output_text.delta","delta":"PONG-${callIndex}"}`,
            "",
            "event: response.completed",
            `data: {"type":"response.completed","response":{"id":"resp_w18_${callIndex}","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"PONG-${callIndex}"}]}],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}`,
            "",
            "data: [DONE]",
            "",
          ].join("\n");
          return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({
          id: `resp_w18_${callIndex}`,
          object: "response",
          status: "completed",
          model: "chatgpt-web/extra-high",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `PONG-${callIndex}` }] }],
          usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
        });
      }

      return Response.json({ error: { message: `mock upstream has no route for ${req.method} ${url.pathname}` } }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${serve.port}`,
    stop: () => serve.stop(true),
    interrupts,
    adminAttempts,
    /** Switch the mock to its failure mode (HTTP 500 on every /v1/responses). */
    fail: () => {
      failing = true;
    },
    /** Switch it back to a healthy completed turn. */
    succeed: () => {
      failing = false;
    },
    setFirstByteDelayMs: (ms: number) => {
      firstByteDelayMs = ms;
    },
    stats: {
      get responsesCalls() {
        return responsesCalls;
      },
      get completedResponses() {
        return completedResponses;
      },
    },
  };
}

function homeWithConfig(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "ext-layer-w18-home-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8");
  return dir;
}

/**
 * Boot the facade exactly as the wave's contract describes. The two extra fields are pacing only:
 * one attempt per turn (a failing turn is terminal immediately) with no real backoff sleep.
 */
function boot(upstreamUrl: string, upstreamHome: string) {
  return startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: upstreamUrl,
    tokenProvider: async () => "tok",
    port: 0,
    upstreamHome,
    transientRetryLimit: 1,
    retrySleepMs: 1,
  });
}

let nonce = 0;

/** One authenticated non-streaming turn. The nonce keeps the body unique, so the idempotency
 * store can never replay a previous turn instead of opening a new one. */
async function turn(layerUrl: string, label: string): Promise<{ status: number; text: string }> {
  nonce += 1;
  const res = await fetch(`${layerUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/latest", input: `health probe ${label} #${nonce} ${Date.now()}` }),
  });
  return { status: res.status, text: await res.text() };
}

/** One authenticated turn opened with `stream: true`, read to the end of the body. Draining the
 * stream is not optional: the facade's completion callback -- the one that clears a previous
 * failure -- only runs once the stream really terminates. */
async function streamTurn(
  layerUrl: string,
  label: string,
): Promise<{ status: number; contentType: string; text: string }> {
  nonce += 1;
  const res = await fetch(`${layerUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/latest",
      input: `stream health probe ${label} #${nonce} ${Date.now()}`,
      stream: true,
    }),
  });
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text() };
}

type AbortOutcome = { kind: "response"; status: number } | { kind: "abort"; name: string };

/** Start a turn and abort the client request mid-flight (the upstream is still thinking).
 * `opts.stream` opens the same abort against a `stream: true` turn; the default stays the
 * non-streaming turn H5/H7 already exercise. */
async function abortMidFlight(
  layerUrl: string,
  label: string,
  abortAfterMs: number,
  opts: { stream?: boolean } = {},
): Promise<AbortOutcome> {
  nonce += 1;
  const controller = new AbortController();
  const pending = fetch(`${layerUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/latest",
      input: `abort probe ${label} #${nonce} ${Date.now()}`,
      ...(opts.stream ? { stream: true } : {}),
    }),
    signal: controller.signal,
  }).then(
    async (res): Promise<AbortOutcome> => ({ kind: "response", status: res.status }),
    (error: unknown): AbortOutcome => ({ kind: "abort", name: error instanceof Error ? error.name : String(error) }),
  );
  await Bun.sleep(abortAfterMs);
  controller.abort();
  return pending;
}

interface HealthProbe {
  httpStatus: number;
  text: string;
  doc: Record<string, unknown>;
}

/** `GET /healthz`, unauthenticated, exactly as an operator's monitor would call it. */
async function readHealth(layerUrl: string): Promise<HealthProbe> {
  const res = await fetch(`${layerUrl}/healthz`);
  const text = await res.text();
  return { httpStatus: res.status, text, doc: asRecord(parseJson(text)) ?? {} };
}

/** Health must be 200 in every state -- a degraded facade that answers 5xx is unobservable. */
function expectHealthyHttp(probe: HealthProbe, label: string): void {
  expect({ label, http: probe.httpStatus }).toEqual({ label, http: 200 });
  const keys = Object.keys(probe.doc);
  expect({ label, unknownKeys: keys.filter(key => !["status", "requests", "last_error"].includes(key)) })
    .toEqual({ label, unknownKeys: [] });
  expect({ label, hasStatus: keys.includes("status") }).toEqual({ label, hasStatus: true });
  expect({ label, hasRequests: keys.includes("requests") }).toEqual({ label, hasRequests: true });
  expect({ label, requestsIsNumber: typeof probe.doc.requests === "number" })
    .toEqual({ label, requestsIsNumber: true });
}

/** The cleared form of `last_error`: absent, null, or an empty/whitespace-only string. */
function isCleared(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function expectClearedHealth(probe: HealthProbe, label: string): void {
  expectHealthyHttp(probe, label);
  expect({ label, status: probe.doc.status }).toEqual({ label, status: "ok" });
  expect({ label, lastErrorCleared: isCleared(probe.doc.last_error), raw: probe.doc.last_error })
    .toEqual({ label, lastErrorCleared: true, raw: probe.doc.last_error });
}

function expectDegradedHealth(probe: HealthProbe, label: string): void {
  expectHealthyHttp(probe, label);
  expect({ label, status: probe.doc.status }).toEqual({ label, status: "degraded" });
  const raw = probe.doc.last_error;
  expect({ label, nonEmptyLastError: typeof raw === "string" && raw.length > 0 })
    .toEqual({ label, nonEmptyLastError: true });
}

/** Poll until the degraded state is visible. Needed where the transition has no client-visible
 * response to await (a client abort). The final probe is what gets asserted. */
async function waitForDegraded(layerUrl: string, timeoutMs: number): Promise<HealthProbe> {
  const deadline = Date.now() + timeoutMs;
  let probe = await readHealth(layerUrl);
  for (;;) {
    if (probe.doc.status === "degraded") return probe;
    if (Date.now() >= deadline) return probe;
    await Bun.sleep(25);
    probe = await readHealth(layerUrl);
  }
}

function requestsOf(probe: HealthProbe): number {
  return typeof probe.doc.requests === "number" ? probe.doc.requests : Number.NaN;
}

/** Poll until the cleared state is visible, mirroring waitForDegraded: the clear rides the
 * facade's stream-completion path, so it is waited for with a bounded deadline rather than
 * assumed instant. The final probe is what gets asserted. */
async function waitForClearedHealth(layerUrl: string, timeoutMs: number): Promise<HealthProbe> {
  const deadline = Date.now() + timeoutMs;
  let probe = await readHealth(layerUrl);
  for (;;) {
    if (probe.doc.status === "ok" && isCleared(probe.doc.last_error)) return probe;
    if (Date.now() >= deadline) return probe;
    await Bun.sleep(25);
    probe = await readHealth(layerUrl);
  }
}

// ---------------------------------------------------------------------------------------------
// H1 -- a process that never saw a failure is healthy: no requests, status ok, no last_error.
// ---------------------------------------------------------------------------------------------
test("H1 a fresh facade with no requests reports ok with no last_error", async () => {
  const up = upstream();
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    const fresh = await readHealth(layer.baseUrl);
    expectClearedHealth(fresh, "fresh /healthz");
    expect(requestsOf(fresh)).toBe(0);
    expect(up.stats.responsesCalls).toBe(0);

    // Health probes are not turns: reading /healthz twice must not invent a request.
    const second = await readHealth(layer.baseUrl);
    expectClearedHealth(second, "second fresh /healthz");
    expect(requestsOf(second)).toBe(0);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// H2 -- a failed turn (upstream 500) is the current state: degraded plus a non-empty last_error.
// ---------------------------------------------------------------------------------------------
test("H2 a failed turn reports degraded with a non-empty last_error", async () => {
  const up = upstream();
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    expectClearedHealth(await readHealth(layer.baseUrl), "before the failure");

    up.fail();
    const failed = await turn(layer.baseUrl, "H2-fail");
    // The contract only says "the request fails"; the wave's prose expects 502 while today's code
    // surfaces the upstream 500 status verbatim. Both are a failure -- a 2xx would be the bug.
    expect([500, 502]).toContain(failed.status);

    const health = await readHealth(layer.baseUrl);
    expectDegradedHealth(health, "after one failed turn");
    expect(requestsOf(health)).toBe(1);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// H3 -- THE BUG: a later successful turn clears the degraded state the failure left behind.
// ---------------------------------------------------------------------------------------------
test("H3 a successful turn after a failure clears the degraded status", async () => {
  const up = upstream();
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    up.fail();
    const failed = await turn(layer.baseUrl, "H3-fail");
    expect([500, 502]).toContain(failed.status);
    expectDegradedHealth(await readHealth(layer.baseUrl), "after the failure");

    // Same process, same facade: only the upstream outcome changes.
    up.succeed();
    const recovered = await turn(layer.baseUrl, "H3-recover");
    expect(recovered.status).toBe(200);
    expect(asRecord(parseJson(recovered.text))?.status).toBe("completed");

    expectClearedHealth(await readHealth(layer.baseUrl), "after the later successful turn");
    expect(requestsOf(await readHealth(layer.baseUrl))).toBe(2);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// H4 -- clearing is not permanent: a failure AFTER a good turn must degrade health again.
// ---------------------------------------------------------------------------------------------
test("H4 a failure after a good turn degrades health again", async () => {
  const up = upstream();
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    // One good turn first (H3 owns the "cleared" assertion; here it only sets up the sequence).
    up.succeed();
    expect((await turn(layer.baseUrl, "H4-good")).status).toBe(200);

    up.fail();
    const failed = await turn(layer.baseUrl, "H4-fail");
    expect([500, 502]).toContain(failed.status);

    const health = await readHealth(layer.baseUrl);
    expectDegradedHealth(health, "after the failure that follows a good turn");
    expect(requestsOf(health)).toBe(2);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// H5 -- a client abort is just another non-success outcome: it must not become a permanent scar.
// ---------------------------------------------------------------------------------------------
test("H5 an aborted turn does not leave a permanent degraded status", async () => {
  const up = upstream({ firstByteDelayMs: ABORT_CASE_UPSTREAM_DELAY_MS });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    const outcome = await abortMidFlight(layer.baseUrl, "H5-abort", ABORT_AT_MS);
    expect(outcome.kind).toBe("abort");

    // The abort path has no client-visible response, so the interrupt is its completion signal.
    expect(await waitUntil(() => up.interrupts.length > 0, INTERRUPT_DEADLINE_MS)).toBe(true);
    expectDegradedHealth(await waitForDegraded(layer.baseUrl, DEGRADED_DEADLINE_MS), "after the client abort");

    // A later turn succeeds: the abort must stop being reported.
    up.setFirstByteDelayMs(0);
    up.succeed();
    const recovered = await turn(layer.baseUrl, "H5-recover");
    expect(recovered.status).toBe(200);
    expect(asRecord(parseJson(recovered.text))?.status).toBe("completed");

    expectClearedHealth(await readHealth(layer.baseUrl), "after the successful turn that follows the abort");
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// H6 -- the health surface stays public, 200-always, same shape, and `requests` keeps counting.
// ---------------------------------------------------------------------------------------------
test("H6 /healthz stays unauthenticated with a stable shape and a strictly increasing requests counter", async () => {
  const up = upstream();
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    const fresh = await readHealth(layer.baseUrl);
    expectClearedHealth(fresh, "fresh /healthz");
    expect(requestsOf(fresh)).toBe(0);

    // No credential, and even a wrong credential, must keep answering the health surface.
    const anonymous = await fetch(`${layer.baseUrl}/healthz`);
    expect(anonymous.status).toBe(200);
    const bogusKey = await fetch(`${layer.baseUrl}/healthz`, { headers: { authorization: "Bearer not-the-key" } });
    expect(bogusKey.status).toBe(200);

    let previous = requestsOf(fresh);
    up.fail();
    expect((await turn(layer.baseUrl, "H6-fail")).status).toBeGreaterThanOrEqual(400);
    const afterFailure = await readHealth(layer.baseUrl);
    expectDegradedHealth(afterFailure, "after the failed turn");
    expect(requestsOf(afterFailure)).toBeGreaterThan(previous);
    previous = requestsOf(afterFailure);

    up.succeed();
    expect((await turn(layer.baseUrl, "H6-ok")).status).toBe(200);
    const afterSuccess = await readHealth(layer.baseUrl);
    expect(requestsOf(afterSuccess)).toBeGreaterThan(previous);
    previous = requestsOf(afterSuccess);

    // A catalog read is not a turn: the counter must not move, and neither must the status.
    const models = await fetch(`${layer.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(models.status).toBe(200);
    await models.text();
    const afterModels = await readHealth(layer.baseUrl);
    expect(requestsOf(afterModels)).toBe(previous);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// H7 -- health never leaks the control token or the api key, even when the failure payload is
// hostile and the abort path really did read and use the control token.
// ---------------------------------------------------------------------------------------------
test("H7 /healthz leaks neither the control token nor the api key", async () => {
  const up = upstream({ hostileFailureBody: true });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    up.fail();
    const failed = await turn(layer.baseUrl, "H7-fail");
    expect([500, 502]).toContain(failed.status);

    // Degraded means last_error is populated: a leak probe here is not vacuous.
    const afterFailure = await readHealth(layer.baseUrl);
    expectDegradedHealth(afterFailure, "after the failed turn");
    expect(afterFailure.text).not.toContain(CONTROL_TOKEN);
    expect(afterFailure.text).not.toContain(KEY);

    // Same forced through the abort path, which really does read the control token from the
    // upstream home -- proven by the authorization header the mock recorded.
    up.succeed();
    up.setFirstByteDelayMs(ABORT_CASE_UPSTREAM_DELAY_MS);
    expect((await abortMidFlight(layer.baseUrl, "H7-abort", ABORT_AT_MS)).kind).toBe("abort");
    expect(await waitUntil(() => up.interrupts.length > 0, INTERRUPT_DEADLINE_MS)).toBe(true);
    expect(up.interrupts[0].auth).toBe(`Bearer ${CONTROL_TOKEN}`);
    await Bun.sleep(ASYNC_QUIET_MS);

    const afterAbort = await readHealth(layer.baseUrl);
    expectHealthyHttp(afterAbort, "after the aborted turn");
    expect(afterAbort.text).not.toContain(CONTROL_TOKEN);
    expect(afterAbort.text).not.toContain(KEY);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// H8 -- the catalog is untouched by health bookkeeping: /v1/models is byte-identical whether or
// not the health semantics were exercised on that process.
// ---------------------------------------------------------------------------------------------
test("H8 /v1/models is byte-identical whether or not the health semantics were exercised", async () => {
  const up = upstream();
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN });
  const exercised = await boot(up.url, home);
  const untouched = await boot(up.url, home);
  try {
    drainAsyncFailures();
    up.fail();
    expect((await turn(exercised.baseUrl, "H8-fail")).status).toBeGreaterThanOrEqual(400);
    up.succeed();
    expect((await turn(exercised.baseUrl, "H8-ok")).status).toBe(200);
    // Evidence that the health semantics really were exercised: two turns were served.
    expect(requestsOf(await readHealth(exercised.baseUrl))).toBeGreaterThanOrEqual(2);
    expect(requestsOf(await readHealth(untouched.baseUrl))).toBe(0);

    const authorized = { authorization: `Bearer ${KEY}` };
    const modelsExercisedRes = await fetch(`${exercised.baseUrl}/v1/models`, { headers: authorized });
    expect(modelsExercisedRes.status).toBe(200);
    const modelsExercised = await modelsExercisedRes.text();
    const modelsUntouchedRes = await fetch(`${untouched.baseUrl}/v1/models`, { headers: authorized });
    expect(modelsUntouchedRes.status).toBe(200);
    const modelsUntouched = await modelsUntouchedRes.text();

    expect(modelsUntouched).toBe(modelsExercised);
    expect(modelsExercised.length).toBeGreaterThan(2);
    expect(modelsExercised).not.toContain(CONTROL_TOKEN);
    expect(modelsExercised).not.toContain(KEY);
    expect(asyncFailures).toEqual([]);
  } finally {
    await exercised.stop();
    await untouched.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// H9 -- no module-level side effects: booting and exercising health mutates no global, no
// built-in, and re-importing the module adds nothing.
// ---------------------------------------------------------------------------------------------
test("H9 exercising the health semantics mutates no global and no built-in", async () => {
  const before = {
    fetch: globalThis.fetch,
    bun: (globalThis as { Bun?: unknown }).Bun,
    process,
    globalProto: Object.getPrototypeOf(globalThis),
    arrayPush: Array.prototype.push,
    jsonStringify: JSON.stringify,
    responseJson: Response.json,
    responseJsonProto: Response.prototype.json,
    globalOwnKeys: Object.getOwnPropertyNames(globalThis).sort().join(","),
  };

  const up = upstream();
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    up.fail();
    expect((await turn(layer.baseUrl, "H9-fail")).status).toBeGreaterThanOrEqual(400);
    up.succeed();
    expect((await turn(layer.baseUrl, "H9-ok")).status).toBe(200);
    expect(await readHealth(layer.baseUrl)).toBeTruthy();
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }

  expect(globalThis.fetch).toBe(before.fetch);
  expect((globalThis as { Bun?: unknown }).Bun).toBe(before.bun);
  expect(process).toBe(before.process);
  expect(Object.getPrototypeOf(globalThis)).toBe(before.globalProto);
  expect(Array.prototype.push).toBe(before.arrayPush);
  expect(JSON.stringify).toBe(before.jsonStringify);
  expect(Response.json).toBe(before.responseJson);
  expect(Response.prototype.json).toBe(before.responseJsonProto);
  expect(Object.getOwnPropertyNames(globalThis).sort().join(",")).toBe(before.globalOwnKeys);

  // Importing again is a cached no-op that adds no global and hands back the same entry point.
  const again = await import("../src/external-layer");
  expect(typeof again.startExternalLayer).toBe("function");
  expect(Object.getOwnPropertyNames(globalThis).sort().join(",")).toBe(before.globalOwnKeys);
  expect(asyncFailures).toEqual([]);
}, 20000);

// ---------------------------------------------------------------------------------------------
// H10 -- the STREAMING twin of H3. Measured gap this closes: replacing the `lastError = undefined;`
// inside the `stream: true` completion callback with `void 0;` left all of H1-H9 green (9 pass /
// 0 fail), so a client that only ever streams could stay degraded for the life of the process.
// ---------------------------------------------------------------------------------------------
test("H10 a successful streaming turn after a failed streaming turn clears the degraded status", async () => {
  const up = upstream({ sse: true });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    expectClearedHealth(await readHealth(layer.baseUrl), "before the failure");

    up.fail();
    const failed = await streamTurn(layer.baseUrl, "H10-fail");
    // As in H2: the contract says "the request fails"; 500 (today's verbatim upstream status) and
    // 502 are both acceptable, a 2xx would be the bug.
    expect([500, 502]).toContain(failed.status);

    const afterFailure = await readHealth(layer.baseUrl);
    expectDegradedHealth(afterFailure, "after the failed streaming turn");
    expect(requestsOf(afterFailure)).toBe(1);

    // Same process, same facade: only the upstream outcome changes, and this time it streams.
    up.succeed();
    const recovered = await streamTurn(layer.baseUrl, "H10-recover");
    expect(recovered.status).toBe(200);
    expect(recovered.contentType).toContain("text/event-stream");
    // Evidence the stream was consumed to its terminator: if the body were never drained, the
    // facade's completion callback would not run and this case would pass against the mutant it
    // exists to kill.
    expect(recovered.text).toContain("response.completed");
    expect(recovered.text).toContain("data: [DONE]");

    const afterSuccess = await waitForClearedHealth(layer.baseUrl, DEGRADED_DEADLINE_MS);
    expectClearedHealth(afterSuccess, "after the later successful streaming turn");
    expect(requestsOf(afterSuccess)).toBe(2);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// H11 -- the STREAMING twin of H5: an aborted streaming turn must not become a permanent scar.
// The failed streaming turn comes FIRST on purpose. It pins a deterministic degraded pre-state, so
// the "a later streaming success clears it" half is never vacuous (it dies on the streaming-clear
// mutant) and the case never has to assert a race: the abort cannot clear a failure, and the
// recovery is waited for with a bounded deadline.
// ---------------------------------------------------------------------------------------------
test("H11 a streamed turn aborted by the client does not leave a permanent degraded status", async () => {
  const up = upstream({ sse: true });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();

    // Deterministic pre-state: one failed streaming turn degrades health.
    up.fail();
    const failed = await streamTurn(layer.baseUrl, "H11-fail");
    expect([500, 502]).toContain(failed.status);
    expectDegradedHealth(await readHealth(layer.baseUrl), "after the failed streaming turn");

    // Now abort a streaming turn mid-flight while the upstream is still thinking.
    up.succeed();
    up.setFirstByteDelayMs(ABORT_CASE_UPSTREAM_DELAY_MS);
    const outcome = await abortMidFlight(layer.baseUrl, "H11-abort", ABORT_AT_MS, { stream: true });
    expect(outcome.kind).toBe("abort");
    // The abort path has no client-visible response, so the interrupt is its completion signal.
    expect(await waitUntil(() => up.interrupts.length > 0, INTERRUPT_DEADLINE_MS)).toBe(true);

    // The aborted turn is a non-success outcome, so it is not a recovery: the most recent terminal
    // turn still failed and health must still say so. Polled with a bounded deadline, not raced.
    expectDegradedHealth(await waitForDegraded(layer.baseUrl, DEGRADED_DEADLINE_MS), "after the client abort");

    // A later STREAMING turn that runs to completion must clear it.
    up.setFirstByteDelayMs(0);
    const recovered = await streamTurn(layer.baseUrl, "H11-recover");
    expect(recovered.status).toBe(200);
    expect(recovered.contentType).toContain("text/event-stream");
    expect(recovered.text).toContain("response.completed");
    expect(recovered.text).toContain("data: [DONE]");

    const afterSuccess = await waitForClearedHealth(layer.baseUrl, DEGRADED_DEADLINE_MS);
    expectClearedHealth(afterSuccess, "after the successful streaming turn that follows the abort");
    expect(requestsOf(afterSuccess)).toBe(3);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);
