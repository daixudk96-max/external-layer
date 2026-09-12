/** Offline verification against the UNMODIFIED upstream v5.0.6 source.
 * Usage: EXT_LAYER_UPSTREAM_SOURCE=/path/to/codex-chatgpt-web bun run scripts/verify-upstream-turn-contract.ts
 * No network, browser, account, credentials, or upstream writes are used. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { toNativeRequest } from "../src/external-layer";
import { NativeTurnState } from "../src/native-turn-state";

const root = process.env.EXT_LAYER_UPSTREAM_SOURCE;
if (!root) throw new Error("Set EXT_LAYER_UPSTREAM_SOURCE to a read-only v5.0.6 checkout");
const path = resolve(root, "src/adapters/chatgpt-web/turn-execution.ts");
const checksum = () => createHash("sha256").update(readFileSync(path)).digest("hex");
const before = checksum();
const upstream = await import(pathToFileURL(path).href);
const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Read one file" }] }];
const firstId = { threadId: "proof-thread", turnId: "proof-turn" };
const call = { type: "function_call", call_id: "proof-call", name: "read_file", arguments: "{}" };
const continuation = [...input, call, { type: "function_call_output", call_id: "proof-call", output: "file contents" }];
const parsed = (items: unknown[], id: { threadId: string; turnId: string }) => ({
  modelId: "gpt-5.6-sol", options: { reasoning: "high" },
  _rawBody: toNativeRequest({ model: "chatgpt-web/high", input: items }, { identity: id }),
});
const initial = parsed(input, firstId);
const oldContinuation = parsed(continuation, { ...firstId, turnId: "WRONG-new-http-request-id" });
const state = new NativeTurnState();
const selected = state.choose(firstId.threadId, input, "chatgpt-web/high");
const nativeFirst = parsed(input, selected);
state.observe(selected, { id: "resp_proof", status: "completed", end_turn: false, output: [call] });
const resumed = state.choose(firstId.threadId, continuation, "chatgpt-web/high");
const nativeNext = parsed(continuation, resumed);
const key1 = upstream.chatGptTurnExecutionKey(initial);
const key2 = upstream.chatGptTurnExecutionKey(oldContinuation);
assert.notEqual(key1, key2);
assert.equal(upstream.chatGptTurnExecutionKey(nativeFirst), upstream.chatGptTurnExecutionKey(nativeNext));
assert.notEqual(upstream.chatGptTurnRoundKey(nativeFirst), upstream.chatGptTurnRoundKey(nativeNext));

// Use the REAL upstream owner-retirement gate, with only its physical browser promise mocked.
let finish!: (answer: string) => void;
const browser = new Promise<string>(resolve => { finish = resolve; });
let starts = 0;
const runtime = () => {
  starts++;
  return { mode: "read-only", browser, physicalSettlement: browser.then(() => undefined),
    trace: new upstream.ChatGptTraceFeed(), text: new upstream.ChatGptTextFeed(), cancel: () => finish("cancelled") };
};
const sessions = new upstream.ChatGptTurnSessions();
const owner = upstream.chatGptThreadOwnershipKey(initial);
const lineage = upstream.chatGptInstructionLineage(initial);
const first = await sessions.getOrCreateAfterOwnerRetirement(key1, owner, runtime, "trace1", undefined, firstId.turnId, firstId.threadId, lineage);
const wrong = sessions.getOrCreateAfterOwnerRetirement(key2, owner, runtime, "trace2", undefined, "new-id", firstId.threadId, lineage);
assert.equal(await Promise.race([wrong.then(() => "unexpectedly-started"), Bun.sleep(30).then(() => "waiting-for-old-browser")]), "waiting-for-old-browser");
assert.equal(starts, 1);
const correct = await sessions.getOrCreateAfterOwnerRetirement(key1, owner, runtime, "trace1", undefined, firstId.turnId, firstId.threadId, lineage);
assert.equal(correct, first);
finish("offline cleanup");
await wrong;
assert.equal(checksum(), before);
console.log(JSON.stringify({
  upstream_source: path,
  upstream_sha256_before: before, upstream_sha256_after: checksum(),
  old_code_execution_key_changed: key1 !== key2,
  old_code_waits_for_undelivered_tool_result: true,
  fixed_code_same_execution_different_round: true,
  real_upstream_gate_returns_same_session: correct === first,
  network_calls: 0, upstream_files_modified: 0,
}, null, 2));
