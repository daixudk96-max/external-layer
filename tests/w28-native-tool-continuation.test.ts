import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";
import { canonicalItemDigest, ConversationRegistry } from "../src/conversation-registry";

const key = "test-key";
const user = { type: "message", role: "user", content: "Read the file" };
const call = { type: "function_call", call_id: "call-1", name: "read", arguments: '{"path":"a"}' };
const output = { type: "function_call_output", call_id: "call-1", output: "contents" };
const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] };
const completed = (items: unknown[], id: string) => ({ id, object: "response", status: "completed", end_turn: !items.some(item => (item as any).type === "function_call"), output: items });
const frame = (response: unknown) => `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`;

async function fixture(firstOutput: unknown[] = [call], delayedEof = false, lateSocketError = false) {
  const requests: Record<string, any>[] = [];
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const upstream = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as Record<string, any>;
    requests.push(body);
    const response = completed(requests.length === 1 ? firstOutput : [answer], `resp_${requests.length}`);
    if (!body.stream) return Response.json(response);
    const first = requests.length === 1;
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(new TextEncoder().encode(frame(response)));
      if (first && delayedEof) await hold;
      if (first && lateSocketError) {
        await Bun.sleep(10);
        controller.error(new Error("trailing socket failure after terminal event"));
        return;
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const layer = await startExternalLayer({ apiKey: key, upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`, tokenProvider: async () => "test-token", port: 0, navigationRetryLimit: 0, retrySleepMs: 1, solAvailable: true, proAvailable: true });
  return {
    requests, release,
    post: (input: unknown[], extra: Record<string, unknown> = {}) => fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/high", input, stream: false, ...extra }),
    }),
    async stop() { release(); await layer.stop(); upstream.stop(true); },
  };
}
const identity = (request: Record<string, any>) => request.client_metadata["x-codex-turn-metadata"];

for (const streaming of [false, true]) {
  test(`tool-result round keeps native execution identity; next user turn stays fresh (stream=${streaming})`, async () => {
    const f = await fixture();
    try {
      await (await f.post([user], { stream: streaming })).text();
      const input = [user, call, output];
      await (await f.post(input, { stream: streaming })).text();
      await (await f.post([...input, answer, { ...user, content: "Next task" }], { stream: streaming })).text();
      expect(identity(f.requests[1]!).thread_id).toBe(identity(f.requests[0]!).thread_id);
      expect(identity(f.requests[1]!).turn_id).toBe(identity(f.requests[0]!).turn_id);
      expect(identity(f.requests[2]!).turn_id).not.toBe(identity(f.requests[1]!).turn_id);
      expect(f.requests[1]!.input.map((item: any) => { const { internal_chat_message_metadata_passthrough, ...rest } = item; return rest; })).toEqual(input.map(item => typeof (item as any).content === "string" ? { ...item, content: [{ type: "input_text", text: (item as any).content }] } : item));
    } finally { await f.stop(); }
  });
}

test("terminal tool batch is bound BEFORE forwarding response.completed, not at transport EOF", async () => {
  const f = await fixture([call], true);
  let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } | undefined;
  try {
    const first = await f.post([user], { stream: true });
    reader = first.body!.getReader();
    let text = "";
    while (!text.includes("response.completed")) text += new TextDecoder().decode((await reader.read()).value);
    // The upstream HTTP body is deliberately still open while the client supplies results.
    await (await f.post([user, call, output])).text();
    expect(identity(f.requests[1]!).thread_id).toBe(identity(f.requests[0]!).thread_id);
    expect(identity(f.requests[1]!).turn_id).toBe(identity(f.requests[0]!).turn_id);
    f.release();
    while (!(await reader.read()).done) {}
  } finally { f.release(); await reader?.cancel().catch(() => {}); await f.stop(); }
});

test("DSH prompt_cache_key separates identical sessions and survives rewritten prefixes", async () => {
  const f = await fixture([answer]);
  try {
    const a = await f.post([user], { prompt_cache_key: "session-a" }); await a.text();
    const b = await f.post([user], { prompt_cache_key: "session-b" }); await b.text();
    const again = await f.post([{ ...user, content: "Rewritten history" }], { prompt_cache_key: "session-a" }); await again.text();
    expect(b.headers.get("x-ext-layer-conversation")).not.toBe(a.headers.get("x-ext-layer-conversation"));
    expect(again.headers.get("x-ext-layer-conversation")).toBe(a.headers.get("x-ext-layer-conversation"));
    expect(a.headers.get("x-ext-layer-conversation")).not.toContain("session-a");
  } finally { await f.stop(); }
});

test("tool arguments participate in history identity", () => {
  expect(canonicalItemDigest(call)).not.toBe(canonicalItemDigest({ ...call, arguments: '{"path":"b"}' }));
});

test("stable explicit session identity is available before any response is recorded", () => {
  const registry = new ConversationRegistry();
  // Cast only to let this regression test run against the original two-argument API.
  const resolve = registry.resolveConversation.bind(registry) as (input: unknown[], prev?: string, session?: string) => { threadId: string };
  expect(resolve([user], undefined, "s").threadId).toBe(resolve([user], undefined, "s").threadId);
  expect(resolve([user], undefined, "a").threadId).not.toBe(resolve([user], undefined, "b").threadId);
});


test("a trailing socket error after completed does not revoke a delivered native tool batch", async () => {
  const f = await fixture([call], false, true);
  try {
    const text = await (await f.post([user], { stream: true })).text();
    expect(text).toContain("response.completed");
    await (await f.post([user, call, output])).text();
    expect(identity(f.requests[1]!).turn_id).toBe(identity(f.requests[0]!).turn_id);
  } finally { await f.stop(); }
});
