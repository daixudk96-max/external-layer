/**
 * W25 :: navigation-stage failures (network blips) are retried automatically.
 *
 * Why: the upstream `page.goto` to the temporary-chat surface dies in <1s on a
 * transport blip (`net::ERR_CONNECTION_CLOSED` at https://chatgpt.com/?temporary-chat=true,
 * observed ~5 times in 40h, self-healing). At that point the turn has done NO work —
 * the prompt was never attached and the model spent zero tokens — so a facade-side
 * retry is nearly free and saves the client a whole visible error round trip.
 *
 * This does NOT reopen the retry multiplication we removed in W21: generation-stage
 * failures ("Something went wrong" mid-turn) keep their default single attempt
 * (regression-locked in A3). Navigation errors get their OWN outer budget
 * (`navigationRetryLimit`, default 2 → up to 3 attempts), the inner transient budget
 * explicitly skips nav-class errors (A8 proves no multiplication), and nav failures
 * never count toward the W24 failure breaker (a network blip must not be misdiagnosed
 * as `conversation_too_large`, A4). `net::ERR_ABORTED` is intentionally NOT retried —
 * that signature means the browser was intercepted by the sign-in wall (retrying
 * would just burn attempts against a permanent state, A6).
 *
 * Frozen contract:
 * - new config `navigationRetryLimit?: number` (default 2; 0 = off; nav budget is
 *   separate from `transientRetryLimit`).
 * - nav retries stay on the SAME thread identity; each attempt gets a fresh turn id
 *   (same as the existing retry loop).
 * - matched nav patterns: net::err_connection_closed / _connection_reset /
 *   _connection_refused / _timed_out / _internet_disconnected / _network_changed /
 *   _name_not_resolved / _address_unreachable (case-insensitive substring).
 */

import { describe, expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";
import type { ExternalLayerConfig } from "../src/external-layer";

const KEY = "sk-test-key";
const NAV_MESSAGE =
  "page.goto: net::ERR_CONNECTION_CLOSED at https://chatgpt.com/?temporary-chat=true\nCall log:\n  - navigating to \"https://chatgpt.com/?temporary-chat=true\", waiting until \"load\"";
const ABORTED_MESSAGE =
  "page.goto: net::ERR_ABORTED at https://chatgpt.com/?temporary-chat=true\nCall log:\n  - navigating to \"https://chatgpt.com/?temporary-chat=true\", waiting until \"load\"";
const SWW_MESSAGE = "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.";

const NAV_ERR_BODY = { error: { message: NAV_MESSAGE, code: "upstream_server_error" } };
const ABORTED_ERR_BODY = { error: { message: ABORTED_MESSAGE, code: "upstream_server_error" } };
const SWW_ERR_BODY = { error: { message: SWW_MESSAGE, code: "upstream_server_error" } };

const OK_BODY = {
  id: "resp_ok",
  object: "response",
  status: "completed",
  model: "chatgpt-web/high",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "DONE" }],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 2 },
};

type ScriptStep = { status: number; body: unknown; contentType?: string } | "ok";

const SSE_OK = [
  'event: response.created',
  'data: {"type":"response.created"}',
  '',
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"DONE"}',
  '',
  'event: response.completed',
  'data: {"type":"response.completed"}',
  '',
  'data: [DONE]',
  '',
].join("\n");

interface RecordedCall {
  threadId?: string;
  turnId?: string;
}

function mockUpstream(script: ScriptStep[]) {
  const calls: RecordedCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/admin/")) return Response.json({ ok: true });
      if (path === "/v1/models") return Response.json({ models: [] });
      if (path === "/v1/responses") {
        const body = (await req.json()) as Record<string, unknown>;
        const meta = (body?.client_metadata as Record<string, any> | undefined)?.["x-codex-turn-metadata"] as
          | Record<string, string>
          | undefined;
        calls.push({ threadId: meta?.thread_id, turnId: meta?.turn_id });
        const step = script.shift();
        if (step === "ok" || step === undefined) return Response.json(OK_BODY);
        if (typeof step.body === "string") {
          return new Response(step.body, {
            status: step.status,
            headers: { "content-type": step.contentType ?? "application/json" },
          });
        }
        return Response.json(step.body, { status: step.status });
      }
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop: () => server.stop(true),
  };
}

async function boot(
  upstreamBaseUrl: string,
  overrides: Partial<ExternalLayerConfig> = {},
): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const layer = await startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl,
    tokenProvider: async () => "tok",
    port: 0,
    retrySleepMs: 1,
    ...overrides,
  });
  return layer;
}

async function turn(
  baseUrl: string,
  options: { stream?: boolean } = {},
): Promise<{ status: number; text: string; conversation: string | null }> {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/latest",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: options.stream ?? false,
    }),
  });
  const text = await res.text();
  return { status: res.status, text, conversation: res.headers.get("x-ext-layer-conversation") };
}

describe("w25: navigation blips retry on their own outer budget", () => {
  test("A1: a nav failure followed by success answers 200 on the same thread", async () => {
    const up = mockUpstream([{ status: 500, body: NAV_ERR_BODY }, "ok"]);
    const layer = await boot(up.url);
    try {
      const res = await turn(layer.baseUrl);
      expect(res.status).toBe(200);
      expect(res.text).toContain("DONE");
      expect(up.calls.length).toBe(2);
      expect(up.calls[0]!.threadId).toBeTruthy();
      expect(up.calls[0]!.threadId).toBe(up.calls[1]!.threadId);
    } finally {
      await layer.stop();
      up.stop();
    }
  }, 20000);

  test("A2: navigationRetryLimit 0 restores single-attempt passthrough", async () => {
    const up = mockUpstream([{ status: 500, body: NAV_ERR_BODY }, "ok"]);
    const layer = await boot(up.url, { navigationRetryLimit: 0 });
    try {
      const res = await turn(layer.baseUrl);
      expect(res.status).toBe(500);
      expect(res.text).toContain("net::ERR_CONNECTION_CLOSED");
      expect(up.calls.length).toBe(1);
    } finally {
      await layer.stop();
      up.stop();
    }
  }, 20000);

  test("A3: generation-stage failures keep the default single attempt", async () => {
    const up = mockUpstream([{ status: 500, body: SWW_ERR_BODY }, "ok"]);
    const layer = await boot(up.url);
    try {
      const res = await turn(layer.baseUrl);
      expect(res.status).toBe(500);
      expect(up.calls.length).toBe(1);
    } finally {
      await layer.stop();
      up.stop();
    }
  }, 20000);

  test("A4: nav failures never feed the W24 failure breaker", async () => {
    const up = mockUpstream([
      { status: 500, body: NAV_ERR_BODY },
      { status: 500, body: NAV_ERR_BODY },
      "ok",
    ]);
    const layer = await boot(up.url, {
      navigationRetryLimit: 0,
      failureBreaker: { enabled: true, failureThreshold: 2, payloadCharsThreshold: 1 },
    });
    try {
      const first = await turn(layer.baseUrl);
      expect(first.status).toBe(500);
      const second = await turn(layer.baseUrl);
      expect(second.status).toBe(500);
      const third = await turn(layer.baseUrl);
      expect(third.status).toBe(200);
      expect(up.calls.length).toBe(3);
      expect(third.text).toContain("DONE");
    } finally {
      await layer.stop();
      up.stop();
    }
  }, 20000);

  test("A5: the streaming route retries nav failures too", async () => {
    const up = mockUpstream([
      { status: 500, body: NAV_ERR_BODY },
      { status: 200, body: SSE_OK, contentType: "text/event-stream" },
    ]);
    const layer = await boot(up.url);
    try {
      const res = await turn(layer.baseUrl, { stream: true });
      expect(res.status).toBe(200);
      expect(res.text).toContain("DONE");
      expect(res.text).toContain("[DONE]");
      expect(up.calls.length).toBe(2);
      expect(up.calls[0]!.threadId).toBe(up.calls[1]!.threadId);
    } finally {
      await layer.stop();
      up.stop();
    }
  }, 20000);

  test("A6: net::ERR_ABORTED (sign-in interception) is not retried", async () => {
    const up = mockUpstream([{ status: 500, body: ABORTED_ERR_BODY }, "ok"]);
    const layer = await boot(up.url);
    try {
      const res = await turn(layer.baseUrl);
      expect(res.status).toBe(500);
      expect(up.calls.length).toBe(1);
    } finally {
      await layer.stop();
      up.stop();
    }
  }, 20000);

  test("A7: nav retries honour the injected retry sleep (no real 2s backoff)", async () => {
    const up = mockUpstream([{ status: 500, body: NAV_ERR_BODY }, "ok"]);
    const layer = await boot(up.url, { retrySleepMs: 5 });
    try {
      const startedAt = Date.now();
      const res = await turn(layer.baseUrl);
      const elapsed = Date.now() - startedAt;
      expect(res.status).toBe(200);
      expect(up.calls.length).toBe(2);
      // Real backoff would be BACKOFF_BASE_MS(2000) * attempt; the injected sleep is 5ms.
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await layer.stop();
      up.stop();
    }
  }, 20000);

  test("A8: nav budget ignores transientRetryLimit and never multiplies", async () => {
    const up = mockUpstream([
      { status: 500, body: NAV_ERR_BODY },
      { status: 500, body: NAV_ERR_BODY },
      "ok",
    ]);
    const layer = await boot(up.url, { transientRetryLimit: 5, navigationRetryLimit: 1 });
    try {
      const res = await turn(layer.baseUrl);
      // The nav budget is navigationRetryLimit(1)+1 = 2 attempts: both nav failures burn it
      // and the third script step ("ok") is never consumed. A raised transientRetryLimit (5)
      // must NOT give nav failures more rope — the budgets are independent.
      expect(res.status).toBe(500);
      expect(up.calls.length).toBe(2);
    } finally {
      await layer.stop();
      up.stop();
    }
  }, 20000);
});