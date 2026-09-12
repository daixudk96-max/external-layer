/**
 * W23 canonical contract — conversation continuation: stable upstream `thread_id` per client
 * conversation, so the unmodified upstream REUSES one ChatGPT temporary conversation and pastes
 * only the suffix of the history instead of re-typing the whole transcript on every step.
 *
 * Why this contract exists (diagnosed + PROVEN 2026-09-12, task feat-09-12-conversation-continuation):
 *  - Upstream already implements continuation: `ccw-upstream/src/adapters/chatgpt-web/conversation-key.ts:29-43`
 *    keys a retained browser tab by `sha256({namespace, threadId, modelId, reasoning, compactionEpoch})`,
 *    gated by `mode.localTools && retainedLauncherDescriptor`
 *    (`ccw-upstream/src/adapters/chatgpt-web/index.ts:415-420`; `localTools` is
 *    `config.mode === "full"`, `ccw-upstream/src/config.ts:570`). On a hit the worker skips
 *    `temporary_chat_preparation` and pastes only `messages.slice(lastAssistant + 1)`
 *    (`conversation-key.ts:45-55`, `browser-worker.ts:4289`, `browser-worker.ts:4506-4508`).
 *  - Live proof: two requests with a stable thread_id produced `browser.tab_reused` in the launcher
 *    log (`C:\Users\<you>\.codex-chatgpt-web-dev\launcher\logs\launcher.jsonl`) and the reused
 *    turn's checkpoints had NO `02-temporary-chat-navigation-complete.json`
 *    (1-browser-page-acquired -> 2-effort-control-ready -> ... -> 12-turn-completed).
 *  - Our facade mints a FRESH thread_id every turn (`src/external-layer.ts:236-237`,
 *    `prov-${randomUUID()}`), so the key never matches: every step re-opened a temporary chat and
 *    re-typed the full transcript. That is the root cause of the "one step per 10 minutes / page
 *    rate-limits us" pain (payload: 68/83 turns under 20k tokens completed, 1/44 over 20k survived).
 *
 * Frozen contract:
 *  - New config: `continuation?: boolean` (default true), `conversationLimit?: number` (default 64,
 *    LRU bound), `conversationsPath?: string` (optional persistence across restarts).
 *  - Identity is resolved ONCE per client request — outside any retry loop. Every upstream attempt
 *    for that request carries the SAME `thread_id` and a FRESH `turn_id`.
 *  - Matching is by history prefix: the conversation whose recorded item list is a prefix of the
 *    incoming input continues (identical resend = same conversation; growth = same conversation).
 *    A genuinely new history allocates a new thread.
 *  - `previous_response_id` wins when present: a response id this facade issued maps back to its
 *    thread, so delta-only follow-ups continue the same conversation.
 *  - Responses carry `x-ext-layer-conversation: <threadId>` so operators can see continuation.
 *  - `continuation: false` restores the legacy behaviour (fresh thread per turn) for A/B testing.
 *  - The facade NEVER slices history itself: upstream owns the suffix logic, so the input items sent
 *    upstream stay byte-identical to today (A10).
 */
import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";

interface CapturedCall {
  thread: string;
  turn: string;
  itemCount: number;
  items: Array<{ role?: string; text?: string }>;
}

function itemText(item: unknown): string | undefined {
  const content = (item as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map(part => (typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : undefined))
      .filter((text): text is string => text !== undefined);
    return texts.length > 0 ? texts.join("") : undefined;
  }
  return undefined;
}

function mockUpstream(options: { failures?: number; catalog?: boolean } = {}) {
  const calls: CapturedCall[] = [];
  let seq = 0;
  let failures = options.failures ?? 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/admin/")) return Response.json({ ok: true });
      if (url.pathname.endsWith("/models")) {
        return Response.json({ models: [] });
      }
      const body = (await req.json()) as Record<string, unknown>;
      const metadata = (body.client_metadata ?? {}) as Record<string, unknown>;
      const turnMetadata = (metadata["x-codex-turn-metadata"] ?? {}) as Record<string, unknown>;
      const input = Array.isArray(body.input) ? (body.input as unknown[]) : [];
      calls.push({
        thread: String(turnMetadata.thread_id ?? ""),
        turn: String(turnMetadata.turn_id ?? ""),
        itemCount: input.length,
        items: input.map(item => ({
          ...((item as { role?: string }).role !== undefined ? { role: (item as { role: string }).role } : {}),
          ...(itemText(item) !== undefined ? { text: itemText(item)! } : {}),
        })),
      });
      if (failures > 0) {
        failures -= 1;
        return Response.json(
          { error: { message: "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.", code: "upstream_server_error" } },
          { status: 500 },
        );
      }
      seq += 1;
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
  return { baseUrl: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

interface LayerOverrides {
  continuation?: boolean;
  conversationLimit?: number;
  conversationsPath?: string;
  transientRetryLimit?: number;
  retrySleepMs?: number;
  defaultEnvironment?: { cwd: string; workspaceRoots: string[]; sandboxMode: string };
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

const user = (text: string) => ({ type: "message", role: "user", content: text });

async function turn(baseUrl: string, input: unknown[], extra: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/high", input, stream: false, ...extra }),
  });
  const body = (await res.json()) as { output?: unknown[] };
  return {
    status: res.status,
    conversation: res.headers.get("x-ext-layer-conversation"),
    assistant: Array.isArray(body.output) ? body.output[0] : undefined,
    body,
  };
}

test("A1 one conversation keeps one upstream thread across turns", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const first = await turn(layer.baseUrl, [user("step one")]);
    expect(first.status).toBe(200);
    const second = await turn(layer.baseUrl, [user("step one"), first.assistant!, user("step two")]);
    expect(second.status).toBe(200);
    expect(up.calls.length).toBe(2);
    expect(up.calls[0]!.thread).not.toBe("");
    expect(up.calls[1]!.thread).toBe(up.calls[0]!.thread);
    expect(up.calls[1]!.turn).not.toBe(up.calls[0]!.turn);
    expect(first.conversation).toBe(up.calls[0]!.thread);
    expect(second.conversation).toBe(up.calls[0]!.thread);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A2 a different conversation gets its own thread", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const a = await turn(layer.baseUrl, [user("conversation A")]);
    const b = await turn(layer.baseUrl, [user("conversation B")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(up.calls[1]!.thread).not.toBe(up.calls[0]!.thread);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A3 identical openings diverge once the histories differ", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const opening = [user("same opening line")];
    const one = await turn(layer.baseUrl, opening);
    const two = await turn(layer.baseUrl, opening);
    // Both single-turn histories are identical, so the first two calls share one thread; once each
    // conversation grows differently the second step must NOT be folded into the other's thread.
    const grewOne = await turn(layer.baseUrl, [...opening, one.assistant!, user("branch one")]);
    const grewTwo = await turn(layer.baseUrl, [...opening, two.assistant!, user("branch two")]);
    expect(grewOne.status).toBe(200);
    expect(grewTwo.status).toBe(200);
    const threads = new Set(up.calls.map(call => call.thread));
    expect(threads.size).toBeGreaterThanOrEqual(2);
    expect(up.calls[3]!.thread).not.toBe(up.calls[2]!.thread);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A4 a client retry of the identical body continues the same thread with a new turn", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const input = [user("retry me")];
    await turn(layer.baseUrl, input);
    await turn(layer.baseUrl, input);
    expect(up.calls.length).toBe(2);
    expect(up.calls[1]!.thread).toBe(up.calls[0]!.thread);
    expect(up.calls[1]!.turn).not.toBe(up.calls[0]!.turn);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A5 facade-level retries keep the thread and change only the turn", async () => {
  const up = mockUpstream({ failures: 1 });
  const layer = await boot(up.baseUrl, { transientRetryLimit: 2 });
  try {
    const res = await turn(layer.baseUrl, [user("transient then fine")]);
    expect(res.status).toBe(200);
    expect(up.calls.length).toBe(2);
    expect(up.calls[1]!.thread).toBe(up.calls[0]!.thread);
    expect(up.calls[1]!.turn).not.toBe(up.calls[0]!.turn);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A6 previous_response_id continues the thread even with a chopped history", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const first = await turn(layer.baseUrl, [user("start a chain")]);
    const firstId = (first.body as { id?: string }).id;
    expect(typeof firstId).toBe("string");
    const second = await turn(layer.baseUrl, [user("delta only")], { previous_response_id: firstId });
    expect(second.status).toBe(200);
    expect(up.calls[1]!.thread).toBe(up.calls[0]!.thread);
    expect(second.conversation).toBe(up.calls[0]!.thread);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A7 continuation:false restores one fresh thread per turn", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl, { continuation: false });
  try {
    const first = await turn(layer.baseUrl, [user("legacy one")]);
    const second = await turn(layer.baseUrl, [user("legacy one"), first.assistant!, user("legacy two")]);
    expect(second.status).toBe(200);
    expect(up.calls[1]!.thread).not.toBe(up.calls[0]!.thread);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A8 the conversation registry is bounded", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl, { conversationLimit: 1 });
  try {
    const a1 = await turn(layer.baseUrl, [user("conversation one")]);
    await turn(layer.baseUrl, [user("conversation two")]);
    const a2 = await turn(layer.baseUrl, [user("conversation one"), a1.assistant!, user("more")]);
    expect(a2.status).toBe(200);
    // conversation one was evicted by conversation two, so its thread must not be silently reused.
    expect(up.calls[2]!.thread).not.toBe(up.calls[0]!.thread);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A9 the facade adds no global side effects", async () => {
  const up = mockUpstream();
  const fetchBefore = globalThis.fetch;
  const serveBefore = globalThis.Bun?.serve;
  const layer = await boot(up.baseUrl);
  try {
    await turn(layer.baseUrl, [user("no globals")]);
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(globalThis.Bun?.serve).toBe(serveBefore);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A10 the facade never slices history itself", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const first = await turn(layer.baseUrl, [user("head")]);
    const history = [user("head"), first.assistant!, user("tail")];
    await turn(layer.baseUrl, history);
    // Nothing is dropped and nothing is rewritten: the three client items go out as they came in
    // (without defaultEnvironment there is no envelope item either — measured, not assumed).
    expect(up.calls[1]!.itemCount).toBe(3);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("A11 the synthesized environment envelope stays a separate item, and history is still whole", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl, {
    defaultEnvironment: { cwd: "E:/tmp/ws", workspaceRoots: ["E:/tmp/ws"], sandboxMode: "workspace-write" },
  } as LayerOverrides);
  try {
    const first = await turn(layer.baseUrl, [user("head")]);
    const second = await turn(layer.baseUrl, [user("head"), first.assistant!, user("tail")]);
    expect(second.status).toBe(200);
    expect(up.calls[1]!.itemCount).toBe(4);
    const items = up.calls[1]!.items as Array<{ role?: string; text?: string }>;
    expect(items.filter(item => item.text?.includes("<environment_context>")).length).toBe(1);
    expect(items.filter(item => item.text === "tail").length).toBe(1);
    expect(items.filter(item => item.role === "assistant").length).toBe(1);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);
