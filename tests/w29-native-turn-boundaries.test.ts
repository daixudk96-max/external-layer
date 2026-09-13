import { expect, test } from "bun:test";
import { ConversationRegistry } from "../src/conversation-registry";
import { NativeTurnRegistry, ResponseTerminalObserver } from "../src/native-turn-registry";

const user = { type: "message", role: "user", id: "u1", content: [{ type: "input_text", text: "read" }] };
const call = { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a"}' };
const result = { type: "function_call_output", call_id: "c1", output: "ok" };
const contract = { model: "chatgpt-web/high", reasoning: { effort: "high" } };
const response = (calls = [call]) => ({ status: "completed", end_turn: false, output: calls });
function pending(calls = [call]) {
  const registry = new NativeTurnRegistry();
  const first = registry.begin("thread", [user], contract);
  registry.observe(first, response(calls));
  return { registry, first };
}

test("matching parallel batch stays on one native turn", () => {
  const c2 = { ...call, call_id: "c2", arguments: '{"path":"b"}' };
  const { registry, first } = pending([call, c2]);
  const next = registry.begin("thread", [user, call, c2, { ...result, call_id: "c2" }, result], contract);
  expect(next.resumed).toBe(true);
  expect(next.turnId).toBe(first.turnId);
});

for (const [label, suffix] of Object.entries({
  missing_result: [call],
  unknown_result: [call, { ...result, call_id: "alien" }],
  duplicate_result: [call, result, result],
  missing_call: [result],
  changed_arguments: [{ ...call, arguments: '{"path":"b"}' }, result],
  changed_tool_name: [{ ...call, name: "delete" }, result],
  new_instruction: [call, result, { ...user, id: "u2", content: "another task" }],
  compaction: [call, result, { type: "compaction", encrypted_content: "summary" }],
})) {
  test(`unproven continuation is never matched: ${label}`, () => {
    const { registry, first } = pending();
    expect(registry.begin("thread", [user, ...suffix], contract).turnId).not.toBe(first.turnId);
  });
}

test("missing result in a parallel batch is not accepted", () => {
  const c2 = { ...call, call_id: "c2" };
  const { registry, first } = pending([call, c2]);
  expect(registry.begin("thread", [user, call, c2, result], contract).turnId).not.toBe(first.turnId);
});

test("different thread, user item ID, model, or reasoning cannot reuse a live execution", () => {
  for (const variant of ["thread", "id", "model", "reasoning"]) {
    const { registry, first } = pending();
    const input = [{ ...user, id: variant === "id" ? "u2" : user.id }, call, result];
    const c = variant === "model" ? { ...contract, model: "chatgpt-web/pro" }
      : variant === "reasoning" ? { ...contract, reasoning: { effort: "max" } } : contract;
    expect(registry.begin(variant === "thread" ? "other" : "thread", input, c).turnId).not.toBe(first.turnId);
  }
});

test("identical result duplicates share native round identity, not a second browser execution", () => {
  const { registry, first } = pending();
  const a = registry.begin("thread", [user, call, result], contract);
  const b = registry.begin("thread", [user, call, result], contract);
  expect(a.turnId).toBe(first.turnId);
  expect(b.turnId).toBe(first.turnId);
  registry.observe(a, { status: "completed", end_turn: true, output: [] });
  expect(registry.isCurrent(b)).toBe(true);
});

test("multiple batches keep native turn identity; old EOF/failure cannot overwrite a later round", () => {
  const { registry, first } = pending();
  const input = [user, call, result];
  const second = registry.begin("thread", input, contract);
  const c2 = { ...call, call_id: "c2" };
  registry.observe(second, response([c2]));
  registry.observe(first, response());
  registry.fail(first);
  const third = registry.begin("thread", [...input, c2, { ...result, call_id: "c2" }], contract);
  expect(third.turnId).toBe(first.turnId);
  expect(third.resumed).toBe(true);
});

test("failures, explicit end_turn=true, opt-out and retries always start a fresh execution", () => {
  for (const mode of ["failed", "end", "retry", "optout"]) {
    const { registry, first } = pending();
    if (mode === "failed") registry.fail(first);
    if (mode === "end") registry.observe(first, { ...response(), end_turn: true });
    const next = registry.begin("thread", [user, call, result], contract, mode !== "retry" && mode !== "optout");
    expect(next.turnId).not.toBe(first.turnId);
  }
});

test("registry capacity is bounded, and evicted entries cannot resurrect an old tool turn", () => {
  const registry = new NativeTurnRegistry(1);
  const first = registry.begin("a", [user], contract);
  registry.observe(first, response());
  registry.begin("b", [user], contract);
  expect(registry.begin("a", [user, call, result], contract).resumed).toBe(false);
});

test("JSON argument reserialization does not break an otherwise exact batch", () => {
  const { registry } = pending();
  expect(registry.begin("thread", [user, { ...call, arguments: '{ "path" : "a" }' }, result], contract).resumed).toBe(true);
});

test("terminal observer handles fragmented UTF-8, CRLF, multiline JSON, and ignores DONE/heartbeats", () => {
  const seen: unknown[] = [];
  const observer = new ResponseTerminalObserver((type, value) => seen.push([type, value]));
  const terminal = { ...response(), id: "resp_unicode", output: [{ type: "message", role: "assistant", content: "\u4f60\u597d" }] };
  const text = ': heartbeat\r\ndata: {"type":"response.heartbeat"}\r\n\r\n'
    + 'event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":' + JSON.stringify(terminal) + '}\r\n\r\ndata: [DONE]\r\n\r\n';
  const decoder = new TextDecoder();
  for (const byte of new TextEncoder().encode(text)) observer.push(decoder.decode(new Uint8Array([byte]), { stream: true }));
  observer.push(decoder.decode());
  expect(seen).toEqual([["response.completed", terminal]]);
  expect(observer.seen).toBe(true);
});

test("failed terminal events never become completed tool batches", () => {
  const seen: string[] = [];
  const observer = new ResponseTerminalObserver(type => seen.push(type));
  observer.push('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n');
  observer.push('data: {"type":"response.completed","response":{}}\n\n');
  expect(seen).toEqual(["response.failed"]);
});

test("previous_response_id precedence remains intact and anonymous histories do not cross explicit sessions", () => {
  const registry = new ConversationRegistry();
  const a = registry.resolveConversation([user], undefined, "session-a");
  registry.recordTurn(a.threadId, [user], "resp-a");
  expect(registry.resolveConversation([user], "resp-a", "session-b").threadId).toBe(a.threadId);
  expect(registry.resolveConversation([user]).threadId).not.toBe(a.threadId);
});
