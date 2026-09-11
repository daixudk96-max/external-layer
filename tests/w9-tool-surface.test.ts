/**
 * w9-tool-surface :: canonical contract.
 *
 * Two gaps this wave must close at the FACADE level (the W5 unit helpers already
 * exist and are covered by tests/w5-tools.test.ts):
 *
 *  1. streaming is currently a lie: the facade buffers the whole upstream body
 *     (`await upstream.text()`) and hands it back in one piece, so a client sees
 *     nothing until the turn is over, and tool events cannot be relayed live.
 *  2. there is no `/v1/chat/completions` route at all, so non-Responses clients
 *     cannot use the endpoint.
 */
import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";

type Mode = "json" | "sse" | "truncate";

interface MockOptions {
  mode?: Mode;
  /** JSON response `output` items (default: one assistant message "PONG-1"). */
  output?: unknown[];
  /** SSE frames, already split: each entry is one chunk written to the wire. */
  frames?: string[][];
  /** Delay between SSE chunks — makes buffering distinguishable from forwarding. */
  chunkDelayMs?: number;
  /** First upstream call fails with this status/body (transient), later calls succeed. */
  failFirst?: { status: number; body: string };
}

function upstream(opts: MockOptions = {}) {
  const mode = opts.mode ?? "json";
  const bodies: Array<Record<string, unknown>> = [];
  const turnIds: string[] = [];
  let calls = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls += 1;
      const index = calls;
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      bodies.push(body);
      const meta = (body.client_metadata ?? {}) as Record<string, unknown>;
      const turn = (meta["x-codex-turn-metadata"] ?? {}) as Record<string, unknown>;
      turnIds.push(String(turn.turn_id ?? ""));

      if (opts.failFirst && index === 1) {
        return new Response(opts.failFirst.body, { status: opts.failFirst.status, headers: { "content-type": "application/json" } });
      }

      if (mode === "sse" || mode === "truncate") {
        const frames = opts.frames ?? defaultFrames(index);
        const delay = opts.chunkDelayMs ?? 0;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            for (let i = 0; i < frames.length; i += 1) {
              if (i > 0 && delay > 0) await new Promise(r => setTimeout(r, delay));
              controller.enqueue(encoder.encode(frames[i].join("\n") + "\n"));
            }
            if (mode === "truncate") {
              // The upstream connection dies mid-stream, AFTER bytes reached the client.
              await new Promise(r => setTimeout(r, 10));
              controller.error(new Error("upstream stream broke"));
              return;
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }

      const output = opts.output ?? [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: `PONG-${index}` }] },
      ];
      return Response.json({
        id: `resp_${index}`,
        object: "response",
        status: "completed",
        model: "chatgpt-web/extra-high",
        output,
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    stats: { get calls() { return calls; }, bodies, turnIds },
  };
}

/** response.created | one text delta | completed | [DONE], split into 4 wire chunks. */
function defaultFrames(index: number): string[][] {
  return [
    ["event: response.created", `data: {"type":"response.created","response":{"id":"resp_${index}","status":"in_progress"}}`],
    ["event: response.output_text.delta", `data: {"type":"response.output_text.delta","delta":"PONG-${index}"}`],
    [
      "event: response.completed",
      `data: {"type":"response.completed","response":{"id":"resp_${index}","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"PONG-${index}"}]}],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}`,
    ],
    ["data: [DONE]"],
  ];
}

function post(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "chatgpt-web/latest", input: "say PONG", ...body }),
  });
}

/** Read a response body incrementally, timing when the FIRST byte arrives.
 *
 * `startedAt` MUST be captured BEFORE the fetch call: `fetch` resolves as soon as
 * the response HEADERS arrive, so timing from after `await fetch(...)` can never
 * distinguish a buffering facade from a streaming one.
 */
async function readStream(res: Response, startedAt: number = Date.now()): Promise<{ firstChunkMs: number; text: string }> {
  const reader = res.body?.getReader();
  if (!reader) return { firstChunkMs: -1, text: "" };
  const decoder = new TextDecoder();
  let text = "";
  let firstChunkMs = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstChunkMs < 0) firstChunkMs = Date.now() - startedAt;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // A truncated upstream stream may surface as a client-side abort; the bytes
    // already received stay in `text`, which is what the test checks.
  }
  return { firstChunkMs, text };
}

const tools = [
  {
    type: "function",
    name: "read_file",
    description: "Read a file from the workspace",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    strict: true,
  },
];

// ---------------------------------------------------------------- tool surface

test("tools and tool_choice are forwarded to the upstream untouched", async () => {
  const up = upstream();
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const res = await post(`${layer.baseUrl}/v1/responses`, { tools, tool_choice: "auto" });
    expect(res.status).toBe(200);
    expect(up.stats.bodies[0].tools).toEqual(tools as never);
    expect(up.stats.bodies[0].tool_choice).toBe("auto");
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("a function_call produced by the upstream reaches the client unchanged", async () => {
  const call = { type: "function_call", id: "fc_1", call_id: "call_a1", name: "read_file", arguments: '{"path":"packages/dsh/package.json"}' };
  const up = upstream({ output: [call] });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const res = await post(`${layer.baseUrl}/v1/responses`, { tools });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.output).toEqual([call] as never);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("client function_call and function_call_output items round-trip into the native request", async () => {
  const up = upstream();
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const call = { type: "function_call", id: "fc_1", call_id: "call_a1", name: "read_file", arguments: '{"path":"a.txt"}' };
    const out = { type: "function_call_output", call_id: "call_a1", output: "{\"content\":\"hello\"}" };
    const res = await post(`${layer.baseUrl}/v1/responses`, {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "read a.txt" }] },
        call,
        out,
      ],
    });
    expect(res.status).toBe(200);
    const sent = up.stats.bodies[0].input as Array<Record<string, unknown>>;
    expect(sent.some(item => item.type === "function_call" && item.call_id === "call_a1" && item.arguments === '{"path":"a.txt"}')).toBe(true);
    expect(sent.some(item => item.type === "function_call_output" && item.call_id === "call_a1" && item.output === out.output)).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
});

// ------------------------------------------------------------------- streaming

test("a streamed turn is forwarded chunk by chunk, not buffered until the end", async () => {
  const up = upstream({ mode: "sse", chunkDelayMs: 200 });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const started = Date.now();
    const res = await post(`${layer.baseUrl}/v1/responses`, { stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { firstChunkMs, text } = await readStream(res, started);
    // 4 frames with a 200ms gap = ~600ms of upstream pacing; a buffering facade
    // cannot deliver anything before the last frame lands.
    expect(firstChunkMs).toBeGreaterThanOrEqual(0);
    expect(firstChunkMs).toBeLessThan(350);
    expect(text).toContain('"delta":"PONG-1"');
    expect(text).toContain("data: [DONE]");
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("function_call events inside a stream are relayed verbatim", async () => {
  const frames = [
    ["event: response.created", 'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}'],
    [
      "event: response.output_item.added",
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_a1","name":"read_file","arguments":""}}',
    ],
    ["event: response.function_call_arguments.delta", 'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"pa"}'],
    ["event: response.function_call_arguments.delta", 'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"th\\":\\"a.txt\\"}"}'],
    ["data: [DONE]"],
  ];
  const up = upstream({ mode: "sse", frames });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const res = await post(`${layer.baseUrl}/v1/responses`, { stream: true, tools });
    const { text } = await readStream(res);
    expect(text).toContain('"call_id":"call_a1"');
    expect(text).toContain('"delta":"{\\"pa"');
    expect(text).toContain("data: [DONE]");
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("a transient failure before the first byte is retried", async () => {
  const up = upstream({ mode: "sse", failFirst: { status: 500, body: '{"error":{"message":"server_is_overloaded"}}' } });
  const layer = await startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: up.url,
    tokenProvider: async () => "tok",
    port: 0,
    transientRetryLimit: 2,
    retrySleepMs: 1,
  });
  try {
    const res = await post(`${layer.baseUrl}/v1/responses`, { stream: true });
    expect(res.status).toBe(200);
    expect(up.stats.calls).toBe(2);
    const { text } = await readStream(res);
    expect(text).toContain('"delta":"PONG-2"');
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("no retry once bytes have reached the client", async () => {
  const up = upstream({ mode: "truncate" });
  const layer = await startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: up.url,
    tokenProvider: async () => "tok",
    port: 0,
    transientRetryLimit: 3,
    retrySleepMs: 1,
  });
  try {
    const res = await post(`${layer.baseUrl}/v1/responses`, { stream: true });
    const { text } = await readStream(res);
    expect(up.stats.calls).toBe(1);
    expect(text).toContain('"delta":"PONG-1"');
  } finally {
    await layer.stop();
    up.stop();
  }
});

// --------------------------------------------------------- chat/completions

test("/v1/chat/completions answers a plain chat request in the OpenAI shape", async () => {
  const up = upstream();
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const res = await fetch(`${layer.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", messages: [{ role: "user", content: "say PONG" }] }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const choices = body.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;
    expect(message.content).toBe("PONG-1");
    expect(message.role).toBe("assistant");
    expect(choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } as never);
    // The upstream only speaks the native Responses shape.
    expect(Array.isArray(up.stats.bodies[0].input)).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("/v1/chat/completions surfaces tool calls and enforces the same api key", async () => {
  const call = { type: "function_call", id: "fc_1", call_id: "call_a1", name: "read_file", arguments: '{"path":"a.txt"}' };
  const up = upstream({ output: [call] });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const res = await fetch(`${layer.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/latest",
        messages: [{ role: "user", content: "read a.txt" }],
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }],
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const choices = body.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("tool_calls");
    expect(toolCalls[0].id).toBe("call_a1");
    expect(toolCalls[0].type).toBe("function");
    expect((toolCalls[0].function as Record<string, unknown>).name).toBe("read_file");
    expect((toolCalls[0].function as Record<string, unknown>).arguments).toBe('{"path":"a.txt"}');

    const unauthenticated = await fetch(`${layer.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(unauthenticated.status).toBe(401);
    const badKey = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", input: "hi" }),
    });
    expect(badKey.status).toBe(401);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("/v1/chat/completions streams chat chunks terminated by [DONE]", async () => {
  const up = upstream({ mode: "sse", chunkDelayMs: 120 });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const started = Date.now();
    const res = await fetch(`${layer.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", messages: [{ role: "user", content: "say PONG" }], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { firstChunkMs, text } = await readStream(res, started);
    expect(firstChunkMs).toBeLessThan(250);
    const payloads = text
      .split("\n")
      .filter(line => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const deltas = payloads
      .flatMap(p => (p.choices as Array<Record<string, unknown>> | undefined) ?? [])
      .map(c => (c.delta as Record<string, unknown> | undefined)?.content)
      .filter(value => typeof value === "string");
    expect(deltas.join("")).toBe("PONG-1");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("/v1/chat/completions streaming records its upstream turn, so a repeated key replays byte-identically", async () => {
  const up = upstream({ mode: "sse", chunkDelayMs: 0 });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const body = JSON.stringify({
      model: "chatgpt-web/latest",
      messages: [{ role: "user", content: "say PONG" }],
      stream: true,
    });
    const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
    const first = await fetch(`${layer.baseUrl}/v1/chat/completions`, { method: "POST", headers, body });
    const firstText = await first.text();
    expect(first.status).toBe(200);
    expect(up.stats.calls).toBe(1);

    const started = Date.now();
    const second = await fetch(`${layer.baseUrl}/v1/chat/completions`, { method: "POST", headers, body });
    const secondText = await second.text();
    expect(up.stats.calls).toBe(1);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-ext-layer-replay")).toBe("true");
    expect(secondText).toBe(firstText);
    expect(Date.now() - started).toBeLessThan(300);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("a chat stream that breaks upstream before its terminal marker ends with an error frame and [DONE]", async () => {
  // Frames without the upstream's own [DONE]: the turn dies mid-flight.
  const up = upstream({ mode: "truncate", chunkDelayMs: 0, frames: defaultFrames(1).slice(0, 2) });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const res = await fetch(`${layer.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", messages: [{ role: "user", content: "say PONG" }], stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("upstream_error");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("a chat stream that breaks after [DONE] keeps the terminated turn intact", async () => {
  const up = upstream({ mode: "truncate", chunkDelayMs: 0 });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const res = await fetch(`${layer.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", messages: [{ role: "user", content: "say PONG" }], stream: true }),
    });
    const text = await res.text();
    expect(text).not.toContain("upstream_error");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("a responses stream that breaks upstream before [DONE] terminates with an error event and [DONE]", async () => {
  const up = upstream({ mode: "truncate", chunkDelayMs: 0, frames: defaultFrames(1).slice(0, 2) });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const res = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", stream: true, input: "say PONG" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"error"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("upstream heartbeats become keep-alive comments on the chat stream", async () => {
  // The upstream sends `response.heartbeat` every ~1s while it thinks. A chat stream that drops
  // them writes nothing for the whole thinking window and the server closes the socket mid-turn.
  const up = upstream({
    mode: "sse",
    frames: [
      ["event: response.created", `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`],
      ["event: response.heartbeat", `data: {"type":"response.heartbeat"}`],
      ["event: response.heartbeat", `data: {"type":"response.heartbeat"}`],
      ["event: response.output_text.delta", `data: {"type":"response.output_text.delta","delta":"PONG-1"}`],
      ["event: response.completed", `data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}`],
      ["data: [DONE]"],
    ],
  });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: up.url, tokenProvider: async () => "tok", port: 0 });
  try {
    const res = await fetch(`${layer.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", messages: [{ role: "user", content: "say PONG" }], stream: true }),
    });
    const text = await res.text();
    expect(text.match(/: keep-alive/g)?.length).toBe(2);
    expect(text).toContain('"content":"PONG-1"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
});
