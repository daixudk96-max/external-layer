import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";

const KEY = "audit-test-only";
const text = (role: string, value: string) => ({ role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text: value }] });
const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const completed = (id: string, output: unknown[], endTurn = true) => ({ id, object: "response", status: "completed", output, end_turn: endTurn });
const sse = (response: Record<string, unknown>) => new Response(event("response.created", { response: { id: response.id, status: "in_progress" } }) + event("response.completed", { response }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const identity = (body: Record<string, any>) => body.client_metadata["x-codex-turn-metadata"] as { thread_id: string; turn_id: string };
const bodyOf = (input: unknown[], key = "dsh-session-1") => ({ model: "chatgpt-web/high", stream: true, store: false, prompt_cache_key: key, input });
async function boot(handler: (body: Record<string, any>) => Response | Promise<Response>) {
  const up = Bun.serve({ port: 0, async fetch(req) {
    if (new URL(req.url).pathname.startsWith("/admin/")) return Response.json({ ok: true });
    return handler(await req.json() as Record<string, any>);
  } });
  const layer = await startExternalLayer({ apiKey: KEY, upstreamBaseUrl: `http://127.0.0.1:${up.port}`, tokenProvider: async () => "test-token", port: 0, solAvailable: true, proAvailable: true, navigationRetryLimit: 0, progressTimeoutMs: 500, defaultEnvironment: { cwd: "/tmp", workspaceRoots: ["/tmp"] } });
  return { layer, up, post: (body: unknown) => fetch(`${layer.baseUrl}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) }), stop: async () => { await layer.stop(); up.stop(true); } };
}

test("DSH session key survives changing developer context and isolates identical chats", async () => {
  const calls: Record<string, any>[] = [];
  const fixture = await boot(body => { calls.push(body); return sse(completed(`resp_${calls.length}`, [text("assistant", "OK")])); });
  try {
    for (const body of [
      bodyOf([text("developer", "clock=1"), text("user", "start")], "A"),
      bodyOf([text("developer", "clock=2"), text("user", "start"), text("assistant", "OK"), text("user", "continue")], "A"),
      bodyOf([text("developer", "clock=1"), text("user", "start")], "B"),
    ]) { const res = await fixture.post(body); expect(res.status).toBe(200); await res.text(); }
    expect(identity(calls[1]).thread_id).toBe(identity(calls[0]).thread_id);
    expect(identity(calls[2]).thread_id).not.toBe(identity(calls[0]).thread_id);
  } finally { await fixture.stop(); }
});

test("a tool result resumes the SAME native turn; a new human instruction gets a new turn", async () => {
  const calls: Record<string, any>[] = [];
  const tool = { type: "function_call", call_id: "call_audit_1", name: "read_file", arguments: "{}" };
  const fixture = await boot(body => {
    calls.push(body);
    if (calls.length === 1) return sse(completed("resp_tool", [tool], false));
    if (calls.length === 2 && identity(body).turn_id !== identity(calls[0]).turn_id) {
      return new Response(event("response.failed", { response: { status: "failed", error: { code: "wrong_native_turn", message: "tool result never reached the original execution" } } }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    return sse(completed(`resp_final_${calls.length}`, [text("assistant", "done")]));
  });
  try {
    const initial = [text("user", "read a file")];
    await (await fixture.post(bodyOf(initial))).text();
    const continued = [...initial, tool, { type: "function_call_output", call_id: tool.call_id, output: "file body" }];
    const second = await (await fixture.post(bodyOf(continued))).text();
    expect(second).not.toContain("wrong_native_turn");
    expect(identity(calls[1]).turn_id).toBe(identity(calls[0]).turn_id);
    await (await fixture.post(bodyOf([...continued, text("assistant", "done"), text("user", "new task")]))).text();
    expect(identity(calls[2]).thread_id).toBe(identity(calls[0]).thread_id);
    expect(identity(calls[2]).turn_id).not.toBe(identity(calls[0]).turn_id);
    // Full history and tool output were not sliced, rewritten, or locally executed.
    expect(calls[1].input.find((item: any) => item.type === "function_call_output")).toEqual(continued[2]);
  } finally { await fixture.stop(); }
});

test("same-session overlapping HTTP requests do not create two simultaneous owners", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const calls: Record<string, any>[] = [];
  const fixture = await boot(body => {
    calls.push(body);
    if (calls.length !== 1) return sse(completed("resp_two", [text("assistant", "OK")]));
    return new Response(new ReadableStream<Uint8Array>({ async start(c) {
      const enc = new TextEncoder();
      c.enqueue(enc.encode(event("response.output_text.delta", { delta: "hello" })));
      await wait;
      c.enqueue(enc.encode(event("response.completed", { response: completed("resp_one", [text("assistant", "OK")]) }) + "data: [DONE]\n\n"));
      c.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  try {
    const first = await fixture.post(bodyOf([text("user", "first")]));
    const firstText = first.text();
    const secondPromise = fixture.post(bodyOf([text("user", "first"), text("assistant", "OK"), text("user", "next")]));
    await Bun.sleep(40);
    expect(calls.length).toBe(1);
    release();
    await firstText;
    await (await secondPromise).text();
    expect(calls.length).toBe(2);
    expect(identity(calls[0]).thread_id).toBe(identity(calls[1]).thread_id);
  } finally { release(); await fixture.stop(); }
});

test("an upstream in-band failure is never saved as a successful idempotent replay", async () => {
  let calls = 0;
  const fixture = await boot(() => ++calls === 1
    ? new Response(event("response.failed", { response: { status: "failed", error: { message: "generation failed" } } }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    : sse(completed("resp_ok", [text("assistant", "OK")])));
  try {
    const body = { model: "chatgpt-web/high", stream: true, input: "a retryable test" };
    await (await fixture.post(body)).text();
    const second = await (await fixture.post(body)).text();
    expect(calls).toBe(2);
    expect(second).toContain("resp_ok");
  } finally { await fixture.stop(); }
});

test("destructive full-history replacement must not reuse a stale retained epoch", async () => {
  const calls: Record<string, any>[] = [];
  const fixture = await boot(body => { calls.push(body); return sse(completed(`resp_${calls.length}`, [text("assistant", "OK")])); });
  try {
    await (await fixture.post(bodyOf([text("user", "original"), text("assistant", "old answer"), text("user", "old next")]))).text();
    await (await fixture.post(bodyOf([text("user", "compacted checkpoint and a new task")]))).text();
    expect(identity(calls[1]).thread_id).not.toBe(identity(calls[0]).thread_id);
  } finally { await fixture.stop(); }
});

test("a pending tool-batch reconnect replays the native execution instead of rotating turn_id", async () => {
  const calls: Record<string, any>[] = [];
  const fixture = await boot(body => {
    calls.push(body);
    return sse(completed(`resp_${calls.length}`, [{ type: "function_call", call_id: "same_call", name: "read_file", arguments: "{}" }], false));
  });
  try {
    const body = bodyOf([text("user", "pending task")]);
    await (await fixture.post(body)).text();
    await (await fixture.post(body)).text();
    expect(identity(calls[1]).turn_id).toBe(identity(calls[0]).turn_id);
  } finally { await fixture.stop(); }
});

test("heartbeats cannot reuse a prior delta to reset the no-progress watchdog forever", async () => {
  const fixture = await boot(() => new Response(new ReadableStream<Uint8Array>({ async start(c) {
    const enc = new TextEncoder();
    try {
      c.enqueue(enc.encode(event("response.output_text.delta", { delta: "one real update" })));
      for (let i = 0; i < 40; i++) { await Bun.sleep(40); c.enqueue(enc.encode(event("response.heartbeat", {}))); }
      c.enqueue(enc.encode(event("response.completed", { response: completed("too_late", [text("assistant", "late")]) })));
      c.close();
    } catch { /* cancellation stops this mock producer */ }
  } }), { headers: { "content-type": "text/event-stream" } }));
  try {
    const answer = await (await fixture.post(bodyOf([text("user", "stall after progress")]))).text();
    expect(answer).toContain("no_progress");
    expect(answer).not.toContain("too_late");
  } finally { await fixture.stop(); }
}, 4000);

test("peek's deadline bounds a silent reader and hands off its pending first chunk losslessly", async () => {
  const { peekUpstreamSse } = await import("../src/stream-peek");
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const started = Date.now();
  const stream = await peekUpstreamSse(source, "text/event-stream", 1000);
  expect(Date.now() - started).toBeLessThan(1800);
  const bytes = event("response.output_text.delta", { delta: "not lost" }) + event("response.completed", { response: completed("after_peek", [text("assistant", "OK")]) });
  controller.enqueue(new TextEncoder().encode(bytes)); controller.close();
  expect(await new Response(stream).text()).toBe(bytes);
}, 3000);

test("several tool batches stay within one native turn and a repeated human message starts a new one", async () => {
  const { NativeTurnState } = await import("../src/native-turn-state");
  const turns = new NativeTurnState();
  const input: unknown[] = [text("user", "continue")];
  const first = turns.choose("t", input, "route");
  for (const id of ["c1", "c2", "c3"]) {
    const call = { type: "function_call", name: "read_file", call_id: id, arguments: "{}" };
    turns.observe(first, completed("r", [call], false));
    input.push(call, { type: "function_call_output", call_id: id, output: "OK" });
    expect(turns.choose("t", input, "route").turnId).toBe(first.turnId);
  }
  input.push(text("user", "continue"));
  expect(turns.choose("t", input, "route").turnId).not.toBe(first.turnId);
});

test("SSE event observation tolerates CRLF and arbitrary byte splits without recounting old progress", async () => {
  const { SseEvents } = await import("../src/sse-events");
  const parser = new SseEvents();
  const bytes = new TextEncoder().encode(event("response.completed", { response: completed("utf8", [text("assistant", "\u4e2d\u6587")]) }).replaceAll("\n", "\r\n"));
  const events = [...bytes].flatMap(byte => parser.push(new Uint8Array([byte])));
  expect(events.length).toBe(1);
  expect(events[0].type).toBe("response.completed");
  expect((events[0].data?.response as any).id).toBe("utf8");
  expect(parser.push(new TextEncoder().encode(": keepalive\r\n\r\n"))).toEqual([]);
});
