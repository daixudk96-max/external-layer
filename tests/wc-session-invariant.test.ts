/**
 * WC canonical contract — "one client conversation = one browser conversation", and the document
 * that teaches it.
 *
 * Why this contract exists: a ChatGPT Web turn is not a stateless API call, it is one retained
 * browser tab. Upstream keys that tab by
 * `sha256({namespace, threadId, modelId, reasoning, compactionEpoch})`
 * (`ccw-upstream/src/adapters/chatgpt-web/conversation-key.ts:29-43`), so the facade's job is to
 * inject a STABLE `thread_id` per client conversation and a FRESH `turn_id` per turn
 * (`src/external-layer.ts` — `toNativeRequest(..., { identity: { threadId, turnId } })`,
 * `client_metadata["x-codex-turn-metadata"]`). When the injected identity is stable, upstream
 * reuses the SAME ChatGPT temporary conversation; when it drifts, every step opens a new temporary
 * chat and re-pastes the whole transcript (measured root cause of the >20k-token death spiral:
 * <20k-token turns completed 68/83, >=20k-token turns 1/44).
 *
 * Frozen contract asserted here (mock upstream answers a normal completed `/v1/responses`):
 *  S1 Thread stability across steps — three sequential requests whose `input` grows by APPENDING
 *     one user message each time (history prefix preserved) must all carry the SAME `thread_id`,
 *     every `turn_id` must differ, and the client-visible `x-ext-layer-conversation` header must be
 *     identical across the three responses.
 *  S2 Failure does not break the conversation — with `transientRetryLimit: 1` a first failing turn
 *     (500, `{"error":{"message":"ChatGPT ended the turn with 'Something went wrong'. Retry the
 *     turn.","type":"server_error","code":"upstream_server_error"}}`) is passed straight through to
 *     the client, and a second request whose history CONTINUES that conversation must still carry
 *     the SAME `thread_id` as the failed attempt (a failure binds the thread, it never orphans it).
 *  S3 Distinct conversations stay distinct — a history sharing no prefix with the above must
 *     produce a DIFFERENT `thread_id`.
 *  S4 Escape hatch — with `continuation: false`, two identical sequential requests must NOT share a
 *     thread (`x-ext-layer-conversation` absent or different), documenting the opt-out.
 *  S5/S6 Documentation — `docs/session-invariant.md` (resolved from `import.meta.dir` as
 *     `${import.meta.dir}/../docs/session-invariant.md`) exists, is longer than 1500 characters,
 *     carries the frozen vocabulary (`nav_steps=0`, `RETAINED_TURN_TAB_TTL_MS`, `conversationKey`,
 *     `completed`, `/v1/responses`) and documents all four RESET OCCASIONS (turn `failure`, idle
 *     `TTL`, `effort` change, client `compaction`) each with at least one `path:line` anchor
 *     matching /[A-Za-z0-9_\-./]+\.(ts|cjs|mjs):\d+/.
 *
 * Exact machine rule used for S6 (so the doc can be written to satisfy it, not guessed at):
 *   1. The doc is partitioned into sections split at every markdown heading (`^#{1,6}\s`); a doc
 *      with no headings is partitioned into blank-line-separated paragraphs instead.
 *   2. For EACH of the four occasion keywords (`failure`, `TTL`, `effort`, `compaction`,
 *      case-insensitive) at least one section must contain BOTH that keyword AND an anchor.
 *   3. The doc as a whole must carry at least four DISTINCT anchors.
 * Locating an occasion and its code anchor in the same section is the point: a doc that lists the
 * four occasions in prose but cites the code once, elsewhere, does not survive a refactor.
 *
 * Red line unchanged: the facade never slices or rewrites client history — the suffix logic belongs
 * to upstream (`w23-continuation.test.ts` A10).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-test-key";
/** The documentation this contract machine-checks. */
const DOC_PATH = `${import.meta.dir}/../docs/session-invariant.md`;
/** `path:line` anchor, e.g. `src/conversation-registry.ts:129` or `ccw-upstream/src/config.ts:570`. */
const ANCHOR_SOURCE = "[A-Za-z0-9_\\-./]+\\.(ts|cjs|mjs):\\d+";
const ANCHOR = new RegExp(ANCHOR_SOURCE);
/** The four occasions that legitimately reset a retained ChatGPT Web conversation. */
const RESET_OCCASIONS = ["failure", "TTL", "effort", "compaction"];

interface CapturedCall {
  pathname: string;
  body: Record<string, unknown>;
  thread: string;
  turn: string;
  itemCount: number;
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

function mockUpstream(options: { failures?: number } = {}) {
  const calls: CapturedCall[] = [];
  let seq = 0;
  let failures = options.failures ?? 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/admin/")) return Response.json({ ok: true });
      if (url.pathname.endsWith("/models")) return Response.json({ models: [] });
      const body = (await req.json()) as Record<string, unknown>;
      const metadata = (body.client_metadata ?? {}) as Record<string, unknown>;
      const turnMetadata = (metadata["x-codex-turn-metadata"] ?? {}) as Record<string, unknown>;
      const input = Array.isArray(body.input) ? (body.input as unknown[]) : [];
      calls.push({
        pathname: url.pathname,
        body,
        thread: String(turnMetadata.thread_id ?? ""),
        turn: String(turnMetadata.turn_id ?? ""),
        itemCount: input.length,
      });
      if (failures > 0) {
        failures -= 1;
        return Response.json(
          {
            error: {
              message: "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
              type: "server_error",
              code: "upstream_server_error",
            },
          },
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
  const body = (await res.json()) as { output?: unknown[]; error?: { code?: string } };
  return {
    status: res.status,
    conversation: res.headers.get("x-ext-layer-conversation"),
    assistant: Array.isArray(body.output) ? body.output[0] : undefined,
    body,
  };
}

test("S1 three appending steps of one conversation share one thread, differ in turn, and report one conversation header", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const first = await turn(layer.baseUrl, [user("step one")]);
    expect(first.status).toBe(200);
    const second = await turn(layer.baseUrl, [user("step one"), first.assistant!, user("step two")]);
    expect(second.status).toBe(200);
    const third = await turn(layer.baseUrl, [
      user("step one"),
      first.assistant!,
      user("step two"),
      second.assistant!,
      user("step three"),
    ]);
    expect(third.status).toBe(200);
    expect(up.calls.length).toBe(3);

    // Same browser conversation: one stable thread_id on every upstream call.
    expect(up.calls[0]!.thread).not.toBe("");
    expect(up.calls[1]!.thread).toBe(up.calls[0]!.thread);
    expect(up.calls[2]!.thread).toBe(up.calls[0]!.thread);

    // One turn per step: turn_id and thread_id are distinct, no turn is replayed.
    for (const call of up.calls) expect(call.turn).not.toBe("");
    expect(new Set(up.calls.map(call => call.turn)).size).toBe(3);

    // Client-visible continuation marker is identical across the three responses.
    expect(first.conversation).not.toBeNull();
    expect(second.conversation).toBe(first.conversation);
    expect(third.conversation).toBe(first.conversation);
    expect(first.conversation).toBe(up.calls[0]!.thread);

    // The prefix is preserved verbatim: the history only ever grows (the facade never slices it).
    expect(up.calls.map(call => call.itemCount)).toEqual([1, 3, 5]);
    expect(up.calls.every(call => call.pathname === "/v1/responses")).toBe(true);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("S2 a passed-through failure still binds its conversation, so the continuing step reuses the same thread", async () => {
  const up = mockUpstream({ failures: 1 });
  // transientRetryLimit: 1 == one attempt: the 500 is handed to the client instead of being retried.
  const layer = await boot(up.baseUrl, { transientRetryLimit: 1 });
  try {
    const failed = await turn(layer.baseUrl, [user("step one fails")]);
    expect(failed.status).toBe(500);
    expect(failed.body.error?.code).toBe("upstream_server_error");
    expect(up.calls.length).toBe(1);

    // The client's next step continues that same conversation (history grew by one user message).
    const next = await turn(layer.baseUrl, [user("step one fails"), user("step two")]);
    expect(next.status).toBe(200);
    expect(up.calls.length).toBe(2);
    expect(up.calls[1]!.thread).toBe(up.calls[0]!.thread);
    expect(up.calls[1]!.turn).not.toBe(up.calls[0]!.turn);
    expect(next.conversation).toBe(failed.conversation);
    expect(next.conversation).toBe(up.calls[0]!.thread);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("S3 a history sharing no prefix gets its own thread", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl);
  try {
    const a = await turn(layer.baseUrl, [user("conversation A step one")]);
    const b = await turn(layer.baseUrl, [user("conversation B step one")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(up.calls.length).toBe(2);
    expect(up.calls[0]!.thread).not.toBe("");
    expect(up.calls[1]!.thread).not.toBe(up.calls[0]!.thread);
    expect(b.conversation).not.toBe(a.conversation);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

test("S4 continuation:false is the documented opt-out: identical sequential requests do not share a thread", async () => {
  const up = mockUpstream();
  const layer = await boot(up.baseUrl, { continuation: false });
  try {
    const first = await turn(layer.baseUrl, [user("opt out of continuation")]);
    const second = await turn(layer.baseUrl, [user("opt out of continuation")]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(up.calls.length).toBe(2);
    expect(up.calls[1]!.thread).not.toBe(up.calls[0]!.thread);
    expect(up.calls[1]!.turn).not.toBe(up.calls[0]!.turn);
    // The header is absent or different: either way the client must not read it as one conversation.
    const sharesThread =
      first.conversation !== null && second.conversation !== null && first.conversation === second.conversation;
    expect(sharesThread).toBe(false);
  } finally {
    await layer.stop();
    up.stop();
  }
}, 20000);

/** Heading-delimited sections; a heading-free doc degrades to blank-line paragraphs (see header rule 1). */
function docSections(doc: string): string[] {
  const chunks = doc.split(/\n(?=#{1,6}\s)/);
  return chunks.length > 1 ? chunks : doc.split(/\n\s*\n/);
}

test("S5 the session-invariant doc exists, is substantial, and speaks the frozen vocabulary", () => {
  let doc: string;
  try {
    doc = readFileSync(DOC_PATH, "utf8");
  } catch (error) {
    throw new Error(`expected ${DOC_PATH} to exist and be readable: ${String(error)}`);
  }
  expect(doc.length).toBeGreaterThan(1500);
  for (const literal of ["nav_steps=0", "RETAINED_TURN_TAB_TTL_MS", "conversationKey", "completed", "/v1/responses"]) {
    expect(doc).toContain(literal);
  }
}, 20000);

test("S6 the doc anchors each of the four reset occasions with a path:line reference", () => {
  let doc: string;
  try {
    doc = readFileSync(DOC_PATH, "utf8");
  } catch (error) {
    throw new Error(`expected ${DOC_PATH} to exist and be readable: ${String(error)}`);
  }
  const sections = docSections(doc);
  for (const occasion of RESET_OCCASIONS) {
    const keyword = new RegExp(occasion, "i");
    const anchored = sections.find(section => keyword.test(section) && ANCHOR.test(section));
    expect(
      anchored === undefined ? `no section documents "${occasion}" together with a path:line anchor` : "anchored",
    ).toBe("anchored");
  }
  const anchors = doc.match(new RegExp(ANCHOR_SOURCE, "g")) ?? [];
  expect(new Set(anchors).size).toBeGreaterThanOrEqual(4);
}, 20000);
