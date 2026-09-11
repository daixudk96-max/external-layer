/**
 * w17-abort-propagation :: canonical contract.
 *
 * The gap this wave closes: the facade ignores client disconnects. When the client aborts its
 * HTTP request, the upstream browser turn keeps driving a real ChatGPT tab to completion, which
 * burns minutes of browser time and blocks the next turn behind the abandoned one.
 *
 * The frozen contract encoded here:
 *  - `abortUpstreamTurns?: boolean` on ExternalLayerConfig, DEFAULT TRUE (a caller that says
 *    nothing gets propagation); `false` disables propagation entirely (no admin call, ever).
 *  - trigger: the client request aborts (`req.signal` fires) while the facade's upstream fetch
 *    for that turn is still in flight.
 *  - action: exactly ONE `POST <upstreamBaseUrl>/admin/interrupt-turn` with
 *    `Authorization: Bearer <controlToken>` and a JSON body holding exactly the two camelCase
 *    keys `threadId` and `turnId`, equal to the identity the facade itself minted into the
 *    native request it sent upstream (client_metadata["x-codex-turn-metadata"]).
 *  - `<controlToken>` is read fresh from `<upstreamHome>/config.json` field `controlToken`.
 *  - NO interrupt when: the client did not abort, the turn already finished,
 *    `abortUpstreamTurns: false`, or the control token / upstream home is missing or unreadable
 *    (that last case must still terminate the client request cleanly, with no unhandled rejection).
 *  - the control token must never appear in a response body, a response header, or an error payload.
 *  - aborting must not break the streaming path (no hang, no unhandled rejection).
 *  - regression locks: a normal turn still answers 200 `status:"completed"`, `previous_response_id`
 *    is still passed through unchanged, `/v1/models` is byte-identical with the switch on and off,
 *    and nothing mutates globalThis or a built-in prototype.
 *
 * Every abort case gives the mock upstream a 3000ms first-byte delay so the abort lands mid-flight,
 * and abort cases never wait for that 3000ms upstream body: they wait for the interrupt instead.
 * The whole file is budgeted under 30s of wall clock, asserted in A10.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";

/** Distinctive control token: any leak of this string into a body, header or error payload fails A6. */
const CONTROL_TOKEN = "ctl-Zx9Qw3Er7Ty1Ui5Op8As2Df4Gh6Jk0Lm3Nv5Bc7Xz9Qw1Er2";

/** Mock-upstream first-byte delay for the abort cases: long enough for the abort to land mid-flight. */
const UPSTREAM_FIRST_BYTE_DELAY_MS = 3000;
/** How long the client waits before aborting: comfortably inside the upstream delay. */
const ABORT_AT_MS = 400;
/** How long one interrupt may take to appear after the abort (the abort handler must be prompt). */
const INTERRUPT_DEADLINE_MS = 2000;
/** Quiet window after the first interrupt: a second one inside it breaks the "exactly one" lock. */
const DUPLICATE_WINDOW_MS = 700;
/** Whole-file wall-clock budget, asserted in A10. */
const WALL_CLOCK_BUDGET_MS = 30_000;

const FILE_STARTED_AT = Date.now();

/** Deterministic upstream catalog, so /v1/models and /v1/context have meaningful, stable output. */
const UPSTREAM_CATALOG = {
  models: [
    { slug: "chatgpt-web/extra-high", context_window: 111_193, max_context_window: 111_193, effective_context_window_percent: 85, auto_compact_token_limit: 95_000 },
    { slug: "chatgpt-web/light", context_window: 41_000, max_context_window: 41_000, effective_context_window_percent: 85, auto_compact_token_limit: 32_000 },
  ],
};

// ---------------------------------------------------------------------------------------------
// A process-level rejection watcher: "must NOT throw an unhandled rejection" is part of the
// contract, so the abort paths are observed, not assumed. Drained at the start of every case
// that asserts on it.
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

interface TurnIdentity {
  threadId: string;
  turnId: string;
}

/** The facade mints the turn identity into client_metadata["x-codex-turn-metadata"] in the native
 * JSON body. A JSON string encoding of the same value is accepted too, so the capture survives
 * either wire shape and the test can never silently compare two empty strings. */
function turnIdentityOf(nativeBody: Record<string, unknown>): TurnIdentity {
  const metadata = asRecord(nativeBody.client_metadata) ?? {};
  const raw = metadata["x-codex-turn-metadata"];
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const turn = asRecord(parsed) ?? {};
  return { threadId: String(turn.thread_id ?? ""), turnId: String(turn.turn_id ?? "") };
}

interface InterruptCall {
  auth: string | null;
  contentType: string | null;
  raw: string;
  body: unknown;
}

interface MockOptions {
  /** Delay before the upstream answers a /v1/responses call (per call, see firstCallDelayMs). */
  delayMs?: number;
  /** Delay for the FIRST /v1/responses call only; later calls use delayMs. */
  firstCallDelayMs?: number;
  /** Answer /v1/responses with an SSE stream instead of JSON. */
  sse?: boolean;
  /** Interval between SSE frames after the first one. */
  frameIntervalMs?: number;
  /** Override the /v1/models catalog. */
  catalog?: unknown;
}

/** Mock upstream: serves /v1/responses (slow first byte), /v1/models, and records every /admin/* hit. */
function upstream(opts: MockOptions = {}) {
  const delayMs = opts.delayMs ?? 0;
  const firstCallDelayMs = opts.firstCallDelayMs ?? delayMs;
  const turns: TurnIdentity[] = [];
  const bodies: Record<string, unknown>[] = [];
  const interrupts: InterruptCall[] = [];
  /** ANY request under /admin/, authenticated or not: proves "no admin call ever" cases. */
  const adminAttempts: string[] = [];
  let responsesCalls = 0;
  let completedResponses = 0;

  const server = Bun.serve({
    port: 0,
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/admin/")) {
        adminAttempts.push(`${req.method} ${url.pathname}`);
        const raw = await req.text();
        if (url.pathname === "/admin/interrupt-turn") {
          interrupts.push({
            auth: req.headers.get("authorization"),
            contentType: req.headers.get("content-type"),
            raw,
            body: parseJson(raw),
          });
        }
        return Response.json({ ok: true });
      }

      if (url.pathname === "/v1/models") {
        return Response.json(opts.catalog ?? UPSTREAM_CATALOG);
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        responsesCalls += 1;
        const callIndex = responsesCalls;
        const native = asRecord(parseJson(await req.text())) ?? {};
        bodies.push(native);
        turns.push(turnIdentityOf(native));
        const waitMs = callIndex === 1 ? firstCallDelayMs : delayMs;

        if (opts.sse) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              for (let frame = 0; frame < 40; frame += 1) {
                await Bun.sleep(frame === 0 ? waitMs : (opts.frameIntervalMs ?? 250));
                try {
                  controller.enqueue(
                    encoder.encode(
                      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"PONG-${frame}"}\n\n`,
                    ),
                  );
                } catch {
                  return;
                }
              }
              try {
                controller.close();
              } catch {}
            },
          });
          return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
        }

        await Bun.sleep(waitMs);
        completedResponses += 1;
        return Response.json({
          id: `resp_${callIndex}`,
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
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    adminAttempts,
    interrupts,
    turns,
    bodies,
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

/** A temp upstream home. `value === undefined` writes no config.json (missing home config);
 * a string is written verbatim (unreadable/garbage config). */
function homeWithConfig(value?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ext-layer-w17-home-"));
  if (value !== undefined) {
    writeFileSync(join(dir, "config.json"), typeof value === "string" ? value : JSON.stringify(value), "utf8");
  }
  return dir;
}

/** Boot the facade. `abortUpstreamTurns` is ALWAYS passed explicitly: omitting the field is the
 * "caller said nothing" case, which the contract fixes at true. */
function boot(upstreamUrl: string, upstreamHome: string, abortUpstreamTurns?: boolean) {
  return startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: upstreamUrl,
    tokenProvider: async () => "tok",
    port: 0,
    upstreamHome,
    abortUpstreamTurns,
  });
}

function responsesFetch(layerUrl: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`${layerUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/latest", input: "say PONG", ...body }),
    ...(signal ? { signal } : {}),
  });
}

type ClientOutcome =
  | { kind: "response"; status: number; text: string }
  | { kind: "abort"; name: string };

/** Start a non-streaming turn on the layer base URL, abort the client request after
 * `abortAfterMs`, report the outcome. */
async function abortMidFlight(
  layerBaseUrl: string,
  body: Record<string, unknown>,
  abortAfterMs: number,
): Promise<{ outcome: ClientOutcome; abortedAt: number }> {
  const controller = new AbortController();
  const pending = responsesFetch(layerBaseUrl, body, controller.signal).then(
    async (res): Promise<ClientOutcome> => ({ kind: "response", status: res.status, text: await res.text().catch(() => "") }),
    (error: unknown): ClientOutcome => ({ kind: "abort", name: error instanceof Error ? error.name : String(error) }),
  );
  await Bun.sleep(abortAfterMs);
  controller.abort();
  const abortedAt = Date.now();
  return { outcome: await pending, abortedAt };
}

type StreamOutcome =
  | { kind: "completed"; bytes: number }
  | { kind: "no-body"; bytes: number }
  | { kind: "abort"; bytes: number; name: string };

/** Start a streaming turn on the layer base URL, read until `abortAfterMs`, then abort: the
 * abort lands mid-stream. */
async function abortMidStream(
  layerBaseUrl: string,
  body: Record<string, unknown>,
  abortAfterMs: number,
): Promise<{ outcome: StreamOutcome; elapsedMs: number }> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = (async (): Promise<StreamOutcome> => {
    let bytes = 0;
    try {
      const res = await responsesFetch(layerBaseUrl, body, controller.signal);
      const reader = res.body?.getReader();
      if (!reader) return { kind: "no-body", bytes };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return { kind: "completed", bytes };
        bytes += value?.length ?? 0;
      }
    } catch (error) {
      return { kind: "abort", bytes, name: error instanceof Error ? error.name : String(error) };
    }
  })();
  await Bun.sleep(abortAfterMs);
  controller.abort();
  const outcome = await pending;
  return { outcome, elapsedMs: Date.now() - startedAt };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
}

/** Assert one interrupt arrived for the single captured turn and that its body carries exactly
 * the two camelCase keys, matching the identity the facade minted. */
function expectSingleInterrupt(up: ReturnType<typeof upstream>, tokenExpected: string): void {
  expect(up.turns.length).toBe(1);
  const minted = up.turns[0];
  expect(minted.threadId.length).toBeGreaterThan(0);
  expect(minted.turnId.length).toBeGreaterThan(0);
  expect(minted.threadId).not.toBe(minted.turnId);

  expect(up.interrupts.length).toBe(1);
  const call = up.interrupts[0];
  expect(call.auth).toBe(`Bearer ${tokenExpected}`);
  expect(call.contentType ?? "").toContain("application/json");
  const body = asRecord(call.body) ?? {};
  expect(Object.keys(body).sort()).toEqual(["threadId", "turnId"]);
  expect(body.threadId).toBe(minted.threadId);
  expect(body.turnId).toBe(minted.turnId);
}

// ---------------------------------------------------------------------------------------------
// A1 -- default on: an aborted client turn propagates exactly one interrupt carrying the exact
// identity the facade minted into its own native request.
// ---------------------------------------------------------------------------------------------
test("A1 an aborted turn issues exactly one interrupt with the facade's own minted identity (default on)", async () => {
  const up = upstream({ delayMs: UPSTREAM_FIRST_BYTE_DELAY_MS });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN, experimentalBiggerContext: true });
  // No abortUpstreamTurns field: the contract default (true) must apply.
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    const { outcome } = await abortMidFlight(layer.baseUrl, { input: "abort me" }, ABORT_AT_MS);
    expect(outcome.kind).toBe("abort");

    // The interrupt must be prompt, and exactly one - a duplicate inside the quiet window fails.
    expect(await waitUntil(() => up.interrupts.length > 0, INTERRUPT_DEADLINE_MS)).toBe(true);
    await Bun.sleep(DUPLICATE_WINDOW_MS);
    expectSingleInterrupt(up, CONTROL_TOKEN);
    expect(up.adminAttempts.length).toBe(1);

    // The abandoned turn is never re-opened upstream: a retry here would drive a second browser turn.
    expect(up.stats.responsesCalls).toBe(1);

    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// A2 -- abortUpstreamTurns:false disables propagation entirely, and the upstream turn is left alone.
// ---------------------------------------------------------------------------------------------
test("A2 abortUpstreamTurns:false issues no interrupt at all and leaves the upstream turn running", async () => {
  const up = upstream({ delayMs: UPSTREAM_FIRST_BYTE_DELAY_MS });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN, experimentalBiggerContext: true });
  const layer = await boot(up.url, home, false);
  try {
    drainAsyncFailures();
    const { outcome } = await abortMidFlight(layer.baseUrl, { input: "abort me" }, ABORT_AT_MS);
    expect(outcome.kind).toBe("abort");

    // Wait for the upstream turn itself to finish: nothing may have touched it.
    expect(await waitUntil(() => up.stats.completedResponses > 0, UPSTREAM_FIRST_BYTE_DELAY_MS + 2000)).toBe(true);
    await Bun.sleep(DUPLICATE_WINDOW_MS);
    expect(up.adminAttempts).toEqual([]);
    expect(up.interrupts).toEqual([]);

    // The facade is still alive and serving.
    const health = await fetch(`${layer.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// A3 -- regression lock: a turn nobody aborted still answers 200 / completed and never interrupts.
// ---------------------------------------------------------------------------------------------
test("A3 a normal turn still returns 200 status:completed and issues no interrupt", async () => {
  const up = upstream({ delayMs: 0 });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN, experimentalBiggerContext: true });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    const res = await responsesFetch(layer.baseUrl, { input: "no abort here" });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { status?: string };
    expect(doc.status).toBe("completed");

    await Bun.sleep(DUPLICATE_WINDOW_MS);
    expect(up.adminAttempts).toEqual([]);
    expect(up.interrupts).toEqual([]);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// A4 -- an abort that arrives AFTER the turn finished interrupts nothing (there is no turn to stop).
// ---------------------------------------------------------------------------------------------
test("A4 aborting after the turn has already completed interrupts nothing", async () => {
  const up = upstream({ delayMs: 0 });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN, experimentalBiggerContext: true });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    const controller = new AbortController();
    const res = await responsesFetch(layer.baseUrl, { input: "finish first" }, controller.signal);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("PONG-1");

    controller.abort(); // the client is gone, but its turn already completed
    await Bun.sleep(DUPLICATE_WINDOW_MS + 300);
    expect(up.adminAttempts).toEqual([]);
    expect(up.interrupts).toEqual([]);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// A5 -- no control token / unreadable upstream home: zero admin traffic, clean termination,
// and the facade must survive it (no unhandled rejection, still serving).
// ---------------------------------------------------------------------------------------------
test("A5 a missing or unreadable control token means no admin call and a cleanly terminated request", async () => {
  const homes: Array<{ label: string; home: string }> = [
    { label: "no config.json at all", home: homeWithConfig(undefined) },
    { label: "config.json without controlToken", home: homeWithConfig({ experimentalBiggerContext: true }) },
    { label: "config.json that is not JSON", home: homeWithConfig("{ not json") },
  ];
  try {
    for (const variant of homes) {
      const up = upstream({ firstCallDelayMs: UPSTREAM_FIRST_BYTE_DELAY_MS, delayMs: 0 });
      const layer = await boot(up.url, variant.home);
      try {
        drainAsyncFailures();
        const { outcome } = await abortMidFlight(layer.baseUrl, { input: "abort me" }, ABORT_AT_MS);
        expect({ variant: variant.label, clientOutcome: outcome.kind }).toEqual({ variant: variant.label, clientOutcome: "abort" });

        // Give any (wrong) admin call a window to show up before declaring that none was made.
        await waitUntil(() => up.adminAttempts.length > 0, 1500);
        expect({ variant: variant.label, adminAttempts: up.adminAttempts }).toEqual({ variant: variant.label, adminAttempts: [] });

        // "Terminate the client request cleanly" = the facade survives and keeps serving.
        const health = await fetch(`${layer.baseUrl}/healthz`);
        expect({ variant: variant.label, health: health.status }).toEqual({ variant: variant.label, health: 200 });
        const next = await responsesFetch(layer.baseUrl, { input: `after ${variant.label}` });
        expect({ variant: variant.label, next: next.status }).toEqual({ variant: variant.label, next: 200 });
        const nextDoc = (await next.json()) as { status?: string };
        expect({ variant: variant.label, nextStatus: nextDoc.status }).toEqual({ variant: variant.label, nextStatus: "completed" });
        expect(asyncFailures).toEqual([]);
      } finally {
        await layer.stop();
        up.stop();
      }
    }
  } finally {
    for (const variant of homes) rmSync(variant.home, { recursive: true, force: true });
  }
}, 20_000);

// ---------------------------------------------------------------------------------------------
// A6 -- the control token is never echoed back: not in a body, not in a header, not in an error
// payload, on any route, while the abort path is actively using it.
// ---------------------------------------------------------------------------------------------
test("A6 the control token never appears in any response body, header, or error payload", async () => {
  const up = upstream({ firstCallDelayMs: UPSTREAM_FIRST_BYTE_DELAY_MS, delayMs: 0 });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN, experimentalBiggerContext: true });
  const layer = await boot(up.url, home);
  const authorized = { authorization: `Bearer ${KEY}` };
  try {
    drainAsyncFailures();
    // Exercise the path that reads the token, and prove it really was read and used.
    await abortMidFlight(layer.baseUrl, { input: "abort me" }, ABORT_AT_MS);
    expect(await waitUntil(() => up.interrupts.length > 0, INTERRUPT_DEADLINE_MS)).toBe(true);
    expect(up.interrupts[0].auth).toBe(`Bearer ${CONTROL_TOKEN}`);
    await Bun.sleep(DUPLICATE_WINDOW_MS);

    const probes: Array<{ label: string; res: Response }> = [
      { label: "GET /healthz", res: await fetch(`${layer.baseUrl}/healthz`) },
      { label: "GET /v1/context", res: await fetch(`${layer.baseUrl}/v1/context`, { headers: authorized }) },
      { label: "GET /v1/models", res: await fetch(`${layer.baseUrl}/v1/models`, { headers: authorized }) },
      { label: "GET /v1/models without a key", res: await fetch(`${layer.baseUrl}/v1/models`) },
      { label: "GET /v1/unknown", res: await fetch(`${layer.baseUrl}/v1/unknown`, { headers: authorized }) },
      { label: "POST /v1/responses", res: await responsesFetch(layer.baseUrl, { input: "leak probe" }) },
      { label: "POST /v1/responses without a key", res: await fetch(`${layer.baseUrl}/v1/responses`, { method: "POST", body: "{}" }) },
    ];

    for (const probe of probes) {
      const text = await probe.res.text();
      expect({ probe: probe.label, bodyLeaks: text.includes(CONTROL_TOKEN) }).toEqual({ probe: probe.label, bodyLeaks: false });
      for (const [name, value] of probe.res.headers.entries()) {
        expect({ probe: probe.label, header: name, headerLeaks: value.includes(CONTROL_TOKEN) }).toEqual({
          probe: probe.label,
          header: name,
          headerLeaks: false,
        });
      }
    }
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// A7 -- streaming: aborting mid-stream still interrupts exactly once, with the same identity,
// without hanging the client and without an unhandled rejection.
// ---------------------------------------------------------------------------------------------
test("A7 aborting mid-stream issues exactly one interrupt, does not hang, and leaves no unhandled rejection", async () => {
  const up = upstream({ sse: true, firstCallDelayMs: 250, frameIntervalMs: 250 });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN, experimentalBiggerContext: true });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    const { outcome, elapsedMs } = await abortMidStream(layer.baseUrl, { input: "stream and abort", stream: true }, 1000);
    expect(outcome.kind).toBe("abort");
    expect(outcome.bytes).toBeGreaterThan(0); // the abort really landed mid-stream
    expect(elapsedMs).toBeLessThan(3000); // the aborting client is released promptly, it never hangs

    expect(await waitUntil(() => up.interrupts.length > 0, INTERRUPT_DEADLINE_MS)).toBe(true);
    await Bun.sleep(DUPLICATE_WINDOW_MS);
    expectSingleInterrupt(up, CONTROL_TOKEN);
    expect(up.adminAttempts.length).toBe(1);
    expect(asyncFailures).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// A8 -- regression lock: previous_response_id is still forwarded to the upstream untouched, with
// abort propagation enabled and disabled.
// ---------------------------------------------------------------------------------------------
test("A8 previous_response_id is forwarded upstream unchanged with the switch on and off", async () => {
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN, experimentalBiggerContext: true });
  try {
    for (const abortUpstreamTurns of [true, false]) {
      const up = upstream({ delayMs: 0 });
      const layer = await boot(up.url, home, abortUpstreamTurns);
      try {
        const res = await responsesFetch(layer.baseUrl, { input: "continue", previous_response_id: "resp_prev_123" });
        expect({ abortUpstreamTurns, status: res.status }).toEqual({ abortUpstreamTurns, status: 200 });
        const doc = (await res.json()) as { status?: string };
        expect({ abortUpstreamTurns, status: doc.status }).toEqual({ abortUpstreamTurns, status: "completed" });
        expect(up.bodies.length).toBe(1);
        expect({ abortUpstreamTurns, previous: up.bodies[0].previous_response_id }).toEqual({ abortUpstreamTurns, previous: "resp_prev_123" });
        expect(up.adminAttempts).toEqual([]);
      } finally {
        await layer.stop();
        up.stop();
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// A9 -- regression lock: /v1/models (and /v1/context) are byte-identical whether or not the
// abort switch is set: the new option must not leak into the public surface.
// ---------------------------------------------------------------------------------------------
test("A9 /v1/models is byte-identical with abortUpstreamTurns on and off", async () => {
  const up = upstream({ delayMs: 0 });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN, experimentalBiggerContext: true });
  const authorized = { authorization: `Bearer ${KEY}` };
  const on = await boot(up.url, home, true);
  const off = await boot(up.url, home, false);
  try {
    const modelsOn = await (await fetch(`${on.baseUrl}/v1/models`, { headers: authorized })).text();
    const modelsOff = await (await fetch(`${off.baseUrl}/v1/models`, { headers: authorized })).text();
    expect(modelsOff).toBe(modelsOn);
    expect(modelsOn.length).toBeGreaterThan(2);

    const contextOn = await (await fetch(`${on.baseUrl}/v1/context`, { headers: authorized })).text();
    const contextOff = await (await fetch(`${off.baseUrl}/v1/context`, { headers: authorized })).text();
    expect(contextOff).toBe(contextOn);

    expect(modelsOn).not.toContain(CONTROL_TOKEN);
    expect(contextOn).not.toContain(CONTROL_TOKEN);
    expect(up.adminAttempts).toEqual([]);
  } finally {
    await on.stop();
    await off.stop();
    up.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);

// ---------------------------------------------------------------------------------------------
// A10 -- regression lock: booting the facade and running an aborted turn must not mutate
// globalThis, a built-in prototype, or the built-ins the facade itself uses; the file must also
// stay inside its wall-clock budget.
// ---------------------------------------------------------------------------------------------
test("A10 nothing mutates globalThis or a built-in, and the whole file stays inside its time budget", async () => {
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

  const up = upstream({ firstCallDelayMs: UPSTREAM_FIRST_BYTE_DELAY_MS, delayMs: 0 });
  const home = homeWithConfig({ controlToken: CONTROL_TOKEN, experimentalBiggerContext: true });
  const layer = await boot(up.url, home);
  try {
    drainAsyncFailures();
    await abortMidFlight(layer.baseUrl, { input: "abort me" }, ABORT_AT_MS);
    await waitUntil(() => up.interrupts.length > 0, INTERRUPT_DEADLINE_MS);
    const normal = await responsesFetch(layer.baseUrl, { input: "still normal" });
    expect(normal.status).toBe(200);
    await normal.text();
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

  // No module-level side effects: importing the module again is a cached no-op, adds no global,
  // and hands back the very same entry point.
  const again = await import("../src/external-layer");
  expect(typeof again.startExternalLayer).toBe("function");
  expect(Object.getOwnPropertyNames(globalThis).sort().join(",")).toBe(before.globalOwnKeys);

  expect(Date.now() - FILE_STARTED_AT).toBeLessThan(WALL_CLOCK_BUDGET_MS);
}, 20000);
