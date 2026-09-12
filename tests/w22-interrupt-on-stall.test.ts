/**
 * w22-interrupt-on-stall :: canonical contract.
 *
 * The gap this wave closes (user report, 2026-09-12): when OUR watchdog gives up on a hung
 * upstream turn, the facade only fails the client request — it never cancels the browser turn
 * that is still grinding away on the ChatGPT page. The client then retries, and the retry has to
 * share the page with the abandoned turn; under retry multiplication that is what makes the page
 * answer "too many requests" and refuse to reach chat history.
 *
 * The frozen contract encoded here:
 *  - when the facade gives up on a turn because of its OWN deadline
 *    (`UpstreamStallError`, kind `no_progress` or `stream_stall`, on either path), it must send
 *    exactly ONE `POST <upstreamBaseUrl>/admin/interrupt-turn` — the same call the client-abort
 *    path already makes (w17) — BEFORE the client response is completed, so the retry starts on a
 *    page that is no longer busy.
 *  - the body holds exactly the camelCase pair `{threadId, turnId}` equal to the identity the
 *    facade itself minted into `client_metadata["x-codex-turn-metadata"]` of the native request,
 *    and `Authorization: Bearer <controlToken>` read fresh from `<upstreamHome>/config.json`.
 *  - `abortUpstreamTurns: false` disables this too: a stall must still terminate the client
 *    request cleanly, with NO call under `/admin/` at all.
 *  - a missing/unreadable control token must not break the stall path: the client still gets its
 *    error frames / 504, no admin call is attempted, and no unhandled rejection escapes.
 *  - the control token never appears in the client-visible bytes.
 *  - regression locks: the stall still terminates the stream with `event: error` + `data: [DONE]`
 *    and no `response.completed`; a healthy turn is untouched.
 *
 * Every case is budgeted with an explicit timeout; the whole file stays well under 30s.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";
/** Distinctive control token: any leak of this string into client-visible bytes fails A1. */
const CONTROL_TOKEN = "ctl-W22Zx9Qw3Er7Ty1Ui5Op8As2Df4Gh6Jk0Lm3Nv5Bc7Xz9Qw";

/** The facade's progress budget for the stall cases: short, so the deadline lands mid-flight. */
const PROGRESS_TIMEOUT_MS = 700;
/** How long one interrupt may take to appear after the stall (the call must be prompt). */
const INTERRUPT_DEADLINE_MS = 2000;
/** Quiet window after the first interrupt: a second one inside it breaks the "exactly one" lock. */
const DUPLICATE_WINDOW_MS = 700;

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

/** The facade mints the turn identity into client_metadata["x-codex-turn-metadata"]; a JSON-string
 * encoding of the same value is accepted too, so the capture survives either wire shape. */
function turnIdentityOf(nativeBody: Record<string, unknown>): TurnIdentity {
  const metadata = asRecord(nativeBody.client_metadata) ?? {};
  const raw = metadata["x-codex-turn-metadata"];
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const turn = asRecord(parsed) ?? {};
  return { threadId: String(turn.thread_id ?? ""), turnId: String(turn.turn_id ?? "") };
}

interface InterruptCall {
  auth: string | null;
  raw: string;
  body: unknown;
}

/** A temp upstream home whose config.json holds (or deliberately omits) the control token. */
function homeWithConfig(controlToken: string | undefined): string {
  const home = mkdtempSync(join(tmpdir(), "w22-home-"));
  const config: Record<string, unknown> = { experimentalBiggerContext: false };
  if (controlToken !== undefined) config.controlToken = controlToken;
  writeFileSync(join(home, "config.json"), JSON.stringify(config), { encoding: "utf8" });
  return home;
}

interface MockOptions {
  /** `sse`: answer with an SSE stream that only ever emits heartbeats (no content progress).
   *  Otherwise: sleep forever-ish before answering at all (no bytes). */
  sse?: boolean;
}

/** Mock upstream: records every native turn identity and every /admin/ hit. */
function upstream(opts: MockOptions = {}) {
  const turns: TurnIdentity[] = [];
  const bodies: Record<string, unknown>[] = [];
  const interrupts: InterruptCall[] = [];
  const adminAttempts: string[] = [];
  let responsesCalls = 0;

  const server = Bun.serve({
    port: 0,
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/admin/")) {
        adminAttempts.push(`${req.method} ${url.pathname}`);
        const raw = await req.text();
        if (url.pathname === "/admin/interrupt-turn") {
          interrupts.push({ auth: req.headers.get("authorization"), raw, body: parseJson(raw) });
        }
        return Response.json({ ok: true });
      }

      if (url.pathname === "/v1/models") {
        return Response.json({
          models: [
            {
              slug: "chatgpt-web/light",
              context_window: 41_000,
              max_context_window: 41_000,
              effective_context_window_percent: 85,
              auto_compact_token_limit: 32_000,
            },
          ],
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        responsesCalls += 1;
        const native = asRecord(parseJson(await req.text())) ?? {};
        bodies.push(native);
        turns.push(turnIdentityOf(native));

        if (opts.sse) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              // Heartbeats only: the pipe is alive, nothing is being produced. Exactly the shape
              // that fed the old byte-counting watchdog forever.
              for (let frame = 0; frame < 60; frame += 1) {
                await Bun.sleep(150);
                try {
                  controller.enqueue(
                    encoder.encode(`event: response.heartbeat\ndata: {"type":"response.heartbeat"}\n\n`),
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

        await Bun.sleep(6000);
        return Response.json({ id: "resp_late", object: "response", status: "completed", output: [] });
      }

      return Response.json({ error: { message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    turns,
    bodies,
    interrupts,
    adminAttempts,
    responsesCalls: () => responsesCalls,
  };
}

async function waitForInterrupt(up: { interrupts: InterruptCall[] }, atLeast = 1): Promise<void> {
  const deadline = Date.now() + INTERRUPT_DEADLINE_MS;
  while (Date.now() < deadline && up.interrupts.length < atLeast) {
    await Bun.sleep(50);
  }
}

function post(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// -------------------------------------------------------------------------------------------
// A1: heartbeat-only stream → our no_progress deadline fires → exactly one interrupt-turn,
// carrying the identity we minted, before the client sees its error.
// -------------------------------------------------------------------------------------------
test(
  "A1 a stalled stream cancels the upstream browser turn it abandoned",
  async () => {
    const up = upstream({ sse: true });
    const home = homeWithConfig(CONTROL_TOKEN);
    const layer = await startExternalLayer({
      apiKey: KEY,
      upstreamBaseUrl: up.url,
      tokenProvider: async () => "tok",
      port: 0,
      upstreamHome: home,
      progressTimeoutMs: PROGRESS_TIMEOUT_MS,
    });
    try {
      const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: "hi", stream: true });
      const text = await res.text();

      // The stall must still be reported to the client, and the stream still terminated properly.
      expect(text).toContain("event: error");
      expect(text).toContain("no_progress");
      expect(text).toContain("data: [DONE]");
      expect(text).not.toContain("response.completed");

      await waitForInterrupt(up);
      expect(up.interrupts.length).toBe(1);
      const identity = up.turns[0];
      expect(identity?.turnId ?? "").not.toBe("");
      expect(up.interrupts[0].body).toEqual({ threadId: identity.threadId, turnId: identity.turnId });
      expect(up.interrupts[0].auth).toBe(`Bearer ${CONTROL_TOKEN}`);
      // No second interrupt once the client response is settled.
      await Bun.sleep(DUPLICATE_WINDOW_MS);
      expect(up.interrupts.length).toBe(1);
      // The control token is a server-side secret: it must never reach client-visible bytes.
      expect(text.includes(CONTROL_TOKEN)).toBe(false);
    } finally {
      await layer.stop();
      up.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
  20_000,
);

// -------------------------------------------------------------------------------------------
// A2: non-streaming path, upstream answers nothing at all → 504 upstream_no_progress, and the
// abandoned turn is cancelled as well.
// -------------------------------------------------------------------------------------------
test(
  "A2 a stalled non-streaming turn cancels the upstream browser turn too",
  async () => {
    const up = upstream();
    const home = homeWithConfig(CONTROL_TOKEN);
    const layer = await startExternalLayer({
      apiKey: KEY,
      upstreamBaseUrl: up.url,
      tokenProvider: async () => "tok",
      port: 0,
      upstreamHome: home,
      progressTimeoutMs: PROGRESS_TIMEOUT_MS,
    });
    try {
      const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: "hi" });
      expect(res.status).toBe(504);
      const body = await res.text();
      expect(body).toContain("upstream_no_progress");

      await waitForInterrupt(up);
      expect(up.interrupts.length).toBe(1);
      const identity = up.turns[0];
      expect(up.interrupts[0].body).toEqual({ threadId: identity.threadId, turnId: identity.turnId });
      await Bun.sleep(DUPLICATE_WINDOW_MS);
      expect(up.interrupts.length).toBe(1);
    } finally {
      await layer.stop();
      up.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
  20_000,
);

// -------------------------------------------------------------------------------------------
// A3: abortUpstreamTurns: false is a full opt-out — the stall still terminates, but nothing is
// ever sent under /admin/.
// -------------------------------------------------------------------------------------------
test(
  "A3 abortUpstreamTurns:false means a stall touches no admin route",
  async () => {
    const up = upstream({ sse: true });
    const home = homeWithConfig(CONTROL_TOKEN);
    const layer = await startExternalLayer({
      apiKey: KEY,
      upstreamBaseUrl: up.url,
      tokenProvider: async () => "tok",
      port: 0,
      upstreamHome: home,
      progressTimeoutMs: PROGRESS_TIMEOUT_MS,
      abortUpstreamTurns: false,
    });
    try {
      const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: "hi", stream: true });
      const text = await res.text();
      expect(text).toContain("no_progress");
      await Bun.sleep(DUPLICATE_WINDOW_MS);
      expect(up.interrupts.length).toBe(0);
      expect(up.adminAttempts.length).toBe(0);
    } finally {
      await layer.stop();
      up.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
  20_000,
);

// -------------------------------------------------------------------------------------------
// A4: no control token on disk → the stall path must stay clean: client still gets its error,
// no admin call is attempted, nothing rejects in the background.
// -------------------------------------------------------------------------------------------
test(
  "A4 a missing control token cannot break the stall path",
  async () => {
    const unhandled: string[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason instanceof Error ? reason.message : String(reason));
    };
    process.on("unhandledRejection", onUnhandled);
    const up = upstream({ sse: true });
    const home = homeWithConfig(undefined);
    const layer = await startExternalLayer({
      apiKey: KEY,
      upstreamBaseUrl: up.url,
      tokenProvider: async () => "tok",
      port: 0,
      upstreamHome: home,
      progressTimeoutMs: PROGRESS_TIMEOUT_MS,
    });
    try {
      const res = await post(layer.baseUrl, { model: "chatgpt-web/latest", input: "hi", stream: true });
      const text = await res.text();
      expect(text).toContain("no_progress");
      expect(text).toContain("data: [DONE]");
      await Bun.sleep(DUPLICATE_WINDOW_MS);
      expect(up.adminAttempts.length).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await layer.stop();
      up.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
  20_000,
);
