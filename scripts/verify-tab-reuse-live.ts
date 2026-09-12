/** Opt-in, synthetic DSH-shaped live probe. Uses only the facade; executes no host tools.
 * EXT_LAYER_LIVE=1 EXT_LAYER_BASE=http://127.0.0.1:17843 EXT_LAYER_API_KEY=... bun run scripts/verify-tab-reuse-live.ts */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SseEvents } from "../src/sse-events";

if (process.env.EXT_LAYER_LIVE !== "1") throw new Error("Live probe is opt-in: set EXT_LAYER_LIVE=1");
const apiKey = process.env.EXT_LAYER_API_KEY;
if (!apiKey) throw new Error("Set EXT_LAYER_API_KEY in your local environment (never commit it)");
const base = (process.env.EXT_LAYER_BASE ?? "http://127.0.0.1:17843").replace(/\/+$/, "").replace(/\/v1$/, "");
const session = `audit-${randomUUID()}`;
const nonce = randomUUID();
const tools = [{ type: "function", name: "audit_echo", description: "Return a synthetic verification nonce unchanged. No files or commands.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }];
const history: unknown[] = [{ role: "user", content: `Call audit_echo exactly once with text ${nonce}. After its result arrives, answer that nonce only.` }];
let thread: string | null = null;
let toolTurn: string | null = null;
let sawTool = false;
let finished = false;

async function round(index: number, choice: string) {
  const started = Date.now();
  const res = await fetch(`${base}/v1/responses`, {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.EXT_LAYER_MODEL ?? "chatgpt-web/high", input: history,
      stream: true, store: false, prompt_cache_key: session, tools, tool_choice: choice }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Facade HTTP ${res.status}; inspect local request log for the error code`);
  if (res.headers.has("x-ext-layer-nudge")) throw new Error("This was a local breaker nudge, not a browser response");
  const owner = res.headers.get("x-ext-layer-conversation");
  assert.ok(owner, "missing conversation header");
  if (thread) assert.equal(owner, thread, "session identity drift");
  thread = owner;
  const nativeTurn = res.headers.get("x-ext-layer-native-turn");
  const reader = res.body!.getReader();
  const parser = new SseEvents();
  let terminal: Record<string, unknown> | undefined;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    for (const event of parser.push(next.value)) {
      if (["response.failed", "response.incomplete", "error"].includes(event.type)) throw new Error(`Probe failed: ${event.type}`);
      if (event.type === "response.completed") terminal = event.data?.response as Record<string, unknown>;
    }
  }
  assert.ok(terminal, "missing semantic completed event");
  console.log(JSON.stringify({ round: index, elapsed_ms: Date.now() - started, thread, native_turn: nativeTurn,
    response_id: terminal.id, end_turn: terminal.end_turn }));
  return { response: terminal, nativeTurn };
}

for (let i = 1; i <= 4; i++) {
  const { response, nativeTurn } = await round(i, sawTool ? "auto" : "required");
  const output = Array.isArray(response.output) ? response.output as Record<string, unknown>[] : [];
  const calls = output.filter(item => item.type === "function_call");
  if (toolTurn) assert.equal(nativeTurn, toolTurn, "tool-result round changed native execution");
  history.push(...output);
  if (!calls.length) { assert.ok(sawTool, "model never requested the probe tool"); finished = true; break; }
  sawTool = true;
  toolTurn = nativeTurn;
  for (const call of calls) {
    assert.equal(call.name, "audit_echo", "probe must not execute any other tool");
    const args = JSON.parse(String(call.arguments ?? "{}")) as { text?: unknown };
    assert.equal(args.text, nonce);
    history.push({ type: "function_call_output", call_id: call.call_id, output: nonce });
  }
}
assert.ok(finished, "tool loop did not finish within four HTTP rounds");
history.push({ role: "user", content: "What was the verification nonce? Return it only, with no tools." });
const final = await round(5, "none");
assert.notEqual(final.nativeTurn, toolTurn, "new human instruction must start a new native turn");
assert.ok(JSON.stringify(final.response.output).includes(nonce), "conversation memory check failed");
console.log("Protocol probe passed. Separately confirm launcher: one initial tab creation, no new tab for tool results, then one retained-tab reuse for the next human instruction.");
