/**
 * WD canonical contract — pre-flight payload signal: the facade must tell the client how big the
 * request payload is BEFORE the client burns a doomed upstream turn.
 *
 * Why this contract exists (evidence, 2026-09-12, the live w24/w27 data):
 *  - Payload vs outcome across 127 real turns: below the ~20k-token page cliff 68/83 turns
 *    completed (~82%); at or above it 1/44 completed (~2%). The history is pasted into the ChatGPT
 *    page, the DOM balloons, generation stalls, and after 60s with zero progress the turn is
 *    aborted. At those odds a turn is a gamble, so the client must be able to DECIDE (compact /
 *    start fresh / send anyway) before it spends one.
 *  - The facade already computes the number for its own breaker (`estimatePayloadSize` ->
 *    `estimateTokensFromChars`, src/external-layer.ts:807-812) and then drops it. The contract is to
 *    publish it: two response headers on every /v1/responses answer, plus the cliff itself on
 *    GET /v1/context so no caller restates a threshold in its own config.
 *
 * Frozen contract:
 *  - Non-streaming `POST /v1/responses` success responses carry `x-ext-layer-payload-chars` and
 *    `x-ext-layer-payload-tokens`: base-10 non-negative integers, tokens > 0 whenever chars > 0, and
 *    tokens <= chars (the estimator is chars/3.6 ASCII + chars/1.5 CJK, so the token count can never
 *    exceed the serialized char size).
 *  - Streaming responses carry both headers on the HTTP response object — available before the SSE
 *    body is interpreted, which is the entire point of a pre-flight signal.
 *  - The signal is monotone in payload size: a much larger history reports strictly larger chars
 *    and tokens.
 *  - The reported pair IS the documented estimator, so an overwhelmingly-ASCII payload reports
 *    tokens within ±25% of chars/3.6.
 *  - `GET /v1/context` publishes the cliff: numeric `payload_cliff_tokens` / `payload_cliff_chars`
 *    equal to DEFAULT_PAYLOAD_TOKEN_THRESHOLD / DEFAULT_PAYLOAD_CHARS_THRESHOLD (imported below —
 *    this file never restates those numbers), alongside latest_effort / bigger_context /
 *    latest_context_window / source / tiers.
 *  - Refusals carry the signal: with the breaker configured as in w24, the 4xx refusal for a
 *    tripped conversation reports chars AND tokens — the client that never got a turn still learns
 *    the size.
 *  - One source of truth: the cliff /v1/context reports is the cliff that actually gates requests,
 *    and a payload one char below/above it classifies accordingly. No literal threshold appears in
 *    this file.
 */
import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";
import {
  DEFAULT_PAYLOAD_CHARS_THRESHOLD,
  DEFAULT_PAYLOAD_TOKEN_THRESHOLD,
} from "../src/failure-breaker";

const KEY = "sk-test-key";
const CHARS_HEADER = "x-ext-layer-payload-chars";
const TOKENS_HEADER = "x-ext-layer-payload-tokens";
/** Small, purely ASCII history: far below every published threshold. */
const SMALL_ASCII_HISTORY = "Reply with one word: the payload size must be visible before the turn.";

const user = (text: string) => ({ type: "message", role: "user", content: text });

interface UpstreamCall {
  method: string;
  path: string;
}

/** Mock upstream: /v1/models answers a catalog, /admin/* answers ok (and is NEVER counted as a
 *  turn), POST /v1/responses answers a completed turn (JSON, or SSE when the client asked for a
 *  stream), with a settable failure budget. */
function mockUpstream(options: { failures?: number; sse?: boolean } = {}) {
  const calls: UpstreamCall[] = [];
  const turns: UpstreamCall[] = [];
  let seq = 0;
  let failures = options.failures ?? 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      // Turn cancellation / health chatter, never a turn.
      if (url.pathname.startsWith("/admin/")) return Response.json({ ok: true });
      calls.push({ method: req.method, path: url.pathname });
      if (url.pathname.endsWith("/models")) return Response.json({ models: [] });
      turns.push({ method: req.method, path: url.pathname });
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (failures > 0) {
        failures -= 1;
        return Response.json(
          { error: { message: "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.", code: "upstream_server_error" } },
          { status: 500 },
        );
      }
      seq += 1;
      const wantsSse = options.sse === true || body.stream === true;
      if (wantsSse) {
        const frames = [
          "event: response.created",
          `data: {"type":"response.created","response":{"id":"resp_mock_${seq}","status":"in_progress"}}`,
          "",
          "event: response.output_text.delta",
          `data: {"type":"response.output_text.delta","delta":"answer-${seq}"}`,
          "",
          "event: response.completed",
          `data: {"type":"response.completed","response":{"id":"resp_mock_${seq}","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer-${seq}"}]}]}}`,
          "",
          "data: [DONE]",
          "",
        ].join("\n");
        return new Response(frames, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        id: `resp_mock_${seq}`,
        object: "response",
        status: "completed",
        model: "chatgpt-web/high",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `answer-${seq}` }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls,
    turns,
    setFailures: (n: number) => { failures = n; },
    stop: () => server.stop(true),
  };
}

interface LayerOverrides {
  failureBreaker?: {
    enabled?: boolean;
    failureThreshold?: number;
    payloadCharsThreshold?: number;
    payloadTokenThreshold?: number;
    cooldownMs?: number;
  };
}

function boot(upstreamBaseUrl: string, overrides: LayerOverrides = {}) {
  return startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl,
    tokenProvider: async () => "tok",
    port: 0,
    retrySleepMs: 1,
    ...overrides,
  });
}

async function turn(baseUrl: string, input: unknown[]) {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/high", input, stream: false }),
  });
  const headers = res.headers;
  const text = await res.text();
  return { status: res.status, headers, text };
}

/** The frozen signal, read straight off a response. Every header assertion in this file goes
 *  through here, so a missing header fails AS a missing header, not as a null comparison. */
function payloadSignal(charsRaw: string | null, tokensRaw: string | null): { chars: number; tokens: number } {
  expect(charsRaw).not.toBeNull();
  expect(tokensRaw).not.toBeNull();
  if (charsRaw === null || tokensRaw === null) {
    throw new Error(`payload signal headers missing: ${CHARS_HEADER}=${String(charsRaw)} ${TOKENS_HEADER}=${String(tokensRaw)}`);
  }
  expect(charsRaw).toMatch(/^\d+$/);
  expect(tokensRaw).toMatch(/^\d+$/);
  const chars = Number(charsRaw);
  const tokens = Number(tokensRaw);
  expect(Number.isSafeInteger(chars)).toBe(true);
  expect(Number.isSafeInteger(tokens)).toBe(true);
  expect(chars).toBeGreaterThanOrEqual(0);
  expect(tokens).toBeGreaterThanOrEqual(0);
  if (chars > 0) expect(tokens).toBeGreaterThan(0);
  expect(tokens).toBeLessThanOrEqual(chars);
  return { chars, tokens };
}

function signalOf(headers: Headers): { chars: number; tokens: number } {
  return payloadSignal(headers.get(CHARS_HEADER), headers.get(TOKENS_HEADER));
}

/** The cliff exactly as GET /v1/context publishes it — the only cliff this file uses. */
async function fetchCliff(baseUrl: string): Promise<{ chars: number; tokens: number }> {
  const res = await fetch(`${baseUrl}/v1/context`, { headers: { authorization: `Bearer ${KEY}` } });
  expect(res.status).toBe(200);
  const doc = (await res.json()) as Record<string, unknown>;
  const chars = doc.payload_cliff_chars;
  const tokens = doc.payload_cliff_tokens;
  expect(typeof chars).toBe("number");
  expect(typeof tokens).toBe("number");
  if (typeof chars !== "number" || typeof tokens !== "number") {
    throw new Error(`/v1/context did not publish the payload cliff: ${JSON.stringify(doc).slice(0, 400)}`);
  }
  return { chars, tokens };
}

/** The constant JSON overhead of one normalized message item, MEASURED from the facade's own
 *  reported char size (a probe turn), never assumed. */
async function calibrateOverhead(baseUrl: string, tag: string): Promise<number> {
  const probe = await turn(baseUrl, [user(tag)]);
  expect(probe.status).toBe(200);
  const chars = signalOf(probe.headers).chars;
  expect(chars).toBeGreaterThan(tag.length);
  return chars - tag.length;
}

/** A one-item history whose reported payload size lands on exactly `targetChars`: the item's
 *  serialized overhead is constant, so the content absorbs the difference. */
function sizedHistory(tag: string, targetChars: number, overhead: number): string {
  const fill = targetChars - overhead - tag.length;
  expect(fill).toBeGreaterThan(0);
  return tag + "x".repeat(fill);
}

/** Classification against the PUBLISHED char cliff: no literal threshold in this file. */
function classifyByCharCliff(payloadChars: number, cliffChars: number): "above" | "below" {
  return payloadChars >= cliffChars ? "above" : "below";
}

test("A1 a non-streaming /v1/responses success carries the pre-flight payload signal", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const res = await turn(layer.baseUrl, [user(SMALL_ASCII_HISTORY)]);
    expect(res.status).toBe(200);
    expect(up.turns.length).toBe(1);
    expect(up.calls.length).toBe(1);
    const signal = signalOf(res.headers);
    expect(signal.chars).toBeGreaterThan(0);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A2 a streaming success carries the same signal on the HTTP response object", async () => {
  const up = mockUpstream({ sse: true });
  const layer = await boot(up.baseUrl);
  try {
    const res = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/high", input: [user(SMALL_ASCII_HISTORY)], stream: true }),
    });
    // Read the signal off the response object the client is holding, before the SSE body means
    // anything: deciding before the turn burns is the whole point.
    const charsRaw = res.headers.get(CHARS_HEADER);
    const tokensRaw = res.headers.get(TOKENS_HEADER);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    expect(text).toContain("data: [DONE]");
    const signal = payloadSignal(charsRaw, tokensRaw);
    expect(signal.chars).toBeGreaterThan(0);
    expect(up.turns.length).toBe(1);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A3 the signal is monotone: a much larger history reports strictly larger chars and tokens", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    // Two DIFFERENT conversations (distinct first user item) so the two calls are separate threads,
    // not one growing thread answered from an idempotency cache.
    const small = await turn(layer.baseUrl, [user("conversation small: one short line")]);
    const large = await turn(layer.baseUrl, [user(`conversation large: ${"L".repeat(8000)}`)]);
    expect(small.status).toBe(200);
    expect(large.status).toBe(200);
    expect(large.headers.get("x-ext-layer-conversation")).not.toBe(small.headers.get("x-ext-layer-conversation"));
    const smallSignal = signalOf(small.headers);
    const largeSignal = signalOf(large.headers);
    expect(largeSignal.chars).toBeGreaterThan(smallSignal.chars);
    expect(largeSignal.tokens).toBeGreaterThan(smallSignal.tokens);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A4 the reported tokens agree with the documented ASCII estimator", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const res = await turn(layer.baseUrl, [user(SMALL_ASCII_HISTORY)]);
    expect(res.status).toBe(200);
    const signal = signalOf(res.headers);
    expect(signal.chars).toBeGreaterThan(0);
    // Overwhelmingly-ASCII payload: the documented estimate is chars / 3.6 tokens, and the reported
    // pair must BE that estimate. The expected value comes from the REPORTED chars, never assumed.
    const expectedTokens = signal.chars / 3.6;
    expect(Math.abs(signal.tokens - expectedTokens)).toBeLessThanOrEqual(0.25 * expectedTokens);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A5 GET /v1/context publishes the cliff next to the existing fields", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const res = await fetch(`${layer.baseUrl}/v1/context`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    // The published cliff IS the exported default — the two can never drift apart.
    expect(typeof doc.payload_cliff_tokens).toBe("number");
    expect(typeof doc.payload_cliff_chars).toBe("number");
    expect(doc.payload_cliff_tokens).toBe(DEFAULT_PAYLOAD_TOKEN_THRESHOLD);
    expect(doc.payload_cliff_chars).toBe(DEFAULT_PAYLOAD_CHARS_THRESHOLD);
    // The pre-existing shape stays intact.
    expect(doc.object).toBe("context");
    expect(typeof doc.latest_effort).toBe("string");
    expect("bigger_context" in doc).toBe(true);
    expect("latest_context_window" in doc).toBe(true);
    expect(typeof doc.source).toBe("string");
    expect(typeof doc.tiers).toBe("object");
    expect(doc.tiers).not.toBeNull();
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A6 a breaker refusal still carries the payload signal", async () => {
  const up = mockUpstream({ failures: 99 });
  const layer = await boot(up.baseUrl, {
    failureBreaker: { enabled: true, failureThreshold: 1, payloadCharsThreshold: 1, cooldownMs: 60000 },
  });
  try {
    const failing = await turn(layer.baseUrl, [user("refused after one failed turn")]);
    expect(failing.status).toBeGreaterThanOrEqual(500);
    const turnsAfterFailure = up.turns.length;
    expect(turnsAfterFailure).toBeGreaterThanOrEqual(1);
    // The identical repeat resolves to the same conversation and is refused before any upstream turn.
    const refused = await turn(layer.baseUrl, [user("refused after one failed turn")]);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(up.turns.length).toBe(turnsAfterFailure);
    // A refusal is a response too: the client that never got a turn still learns the size.
    const signal = signalOf(refused.headers);
    expect(signal.chars).toBeGreaterThan(0);
    expect(refused.headers.get("x-ext-layer-conversation")).not.toBeNull();
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A7 the published cliff classifies a just-above / just-below payload", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const cliff = await fetchCliff(layer.baseUrl);
    const overhead = await calibrateOverhead(layer.baseUrl, "sizing-probe");
    const below = await turn(layer.baseUrl, [user(sizedHistory("below-the-cliff", cliff.chars - 1, overhead))]);
    const above = await turn(layer.baseUrl, [user(sizedHistory("above-the-cliff", cliff.chars + 1, overhead))]);
    expect(below.status).toBe(200);
    expect(above.status).toBe(200);
    const belowSignal = signalOf(below.headers);
    const aboveSignal = signalOf(above.headers);
    // The numbers are what they claim to be: the reported char sizes straddle the published cliff.
    expect(belowSignal.chars).toBe(cliff.chars - 1);
    expect(aboveSignal.chars).toBe(cliff.chars + 1);
    // Classification uses the reported cliff, not a literal.
    expect(classifyByCharCliff(belowSignal.chars, cliff.chars)).toBe("below");
    expect(classifyByCharCliff(aboveSignal.chars, cliff.chars)).toBe("above");
    // The token cliff is a real token number of the same shape: the small payload sits under it,
    // the cliff-sized ASCII payload sits over it.
    const probe = await turn(layer.baseUrl, [user("token-probe")]);
    expect(signalOf(probe.headers).tokens).toBeLessThan(cliff.tokens);
    expect(aboveSignal.tokens).toBeGreaterThanOrEqual(cliff.tokens);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A8 the breaker gates on the cliff /v1/context publishes, not on a literal", async () => {
  // Read the cliff from a live facade of this same build, then use THAT value as the gate below:
  // this test states no threshold of its own.
  const contextUp = mockUpstream();
  const contextLayer = await boot(contextUp.baseUrl);
  let cliffChars: number;
  try {
    cliffChars = (await fetchCliff(contextLayer.baseUrl)).chars;
  } finally {
    await contextLayer.stop();
    contextUp.stop();
  }

  const up = mockUpstream();
  const layer = await boot(up.baseUrl, {
    failureBreaker: {
      enabled: true,
      failureThreshold: 1,
      payloadCharsThreshold: cliffChars,
      // Isolate the char gate: the published char cliff sits far above the token cliff, so a
      // payload sized against it would otherwise qualify through the token gate too.
      payloadTokenThreshold: Number.MAX_SAFE_INTEGER,
      cooldownMs: 60000,
    },
  });
  try {
    const overhead = await calibrateOverhead(layer.baseUrl, "gate-probe");
    // The sizing arithmetic is verified on contract-covered success responses before it is used.
    const justBelowText = sizedHistory("sizing-below", cliffChars - 1, overhead);
    const justAboveText = sizedHistory("sizing-above", cliffChars + 1, overhead);
    const checkBelow = await turn(layer.baseUrl, [user(justBelowText)]);
    const checkAbove = await turn(layer.baseUrl, [user(justAboveText)]);
    expect(checkBelow.status).toBe(200);
    expect(checkAbove.status).toBe(200);
    expect(signalOf(checkBelow.headers).chars).toBe(cliffChars - 1);
    expect(signalOf(checkAbove.headers).chars).toBe(cliffChars + 1);

    up.setFailures(99);

    // Just BELOW the published cliff: the failure does not qualify, so the conversation is never refused.
    const belowText = sizedHistory("below-the-gate", cliffChars - 1, overhead);
    const below = await turn(layer.baseUrl, [user(belowText)]);
    expect(below.status).toBeGreaterThanOrEqual(500);
    const belowRetry = await turn(layer.baseUrl, [user(belowText)]);
    expect(belowRetry.status).toBeGreaterThanOrEqual(500);

    // Just ABOVE the published cliff: one qualifying failure trips the breaker, and the identical
    // repeat is refused before any upstream turn.
    const aboveText = sizedHistory("above-the-gate", cliffChars + 1, overhead);
    const above = await turn(layer.baseUrl, [user(aboveText)]);
    expect(above.status).toBeGreaterThanOrEqual(500);
    const turnsAfterAbove = up.turns.length;
    const aboveRetry = await turn(layer.baseUrl, [user(aboveText)]);
    expect(aboveRetry.status).toBeGreaterThanOrEqual(400);
    expect(aboveRetry.status).toBeLessThan(500);
    expect(up.turns.length).toBe(turnsAfterAbove);
    // The refusal reports the size that put it over the PUBLISHED cliff.
    expect(signalOf(aboveRetry.headers).chars).toBe(cliffChars + 1);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);
