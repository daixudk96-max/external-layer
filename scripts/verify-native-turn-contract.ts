/** Offline contract test against an UNMODIFIED e85e369 reference checkout.
 * Usage: CCW_REFERENCE_DIR=/path/to/readonly/checkout bun scripts/verify-native-turn-contract.ts
 * No browser, credential, network access, or upstream edits are needed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { toNativeRequest } from "../src/external-layer";
import { NativeTurnRegistry } from "../src/native-turn-registry";

const ref = process.env.CCW_REFERENCE_DIR;
if (!ref) throw new Error("Set CCW_REFERENCE_DIR to an unmodified e85e369 reference checkout (not a running installation)");
const path = resolve(ref, "src/adapters/chatgpt-web/turn-execution.ts");
const original = readFileSync(path);
const blob = createHash("sha1").update(`blob ${original.length}\0`).update(original).digest("hex");
assert.equal(blob, "8ed68d1eb3fabf26fdc3673c59eba1ddd8925016", "reference is not the reviewed e85e369 turn-execution.ts");
const upstream = await import(pathToFileURL(path).href);
const { chatGptConversationKey } = await import(pathToFileURL(resolve(ref, "src/adapters/chatgpt-web/conversation-key.ts")).href);
const { ChatGptExternalTurnProgress } = await import(pathToFileURL(resolve(ref, "src/adapters/chatgpt-web/turn-progress.ts")).href);
const {
  ChatGptTurnSessions, ChatGptTraceFeed, ChatGptTextFeed,
  chatGptTurnExecutionKey, chatGptThreadOwnershipKey, chatGptInstructionLineage,
} = upstream;
const sessions = new ChatGptTurnSessions();
const registry = new NativeTurnRegistry();
const user = { type: "message", role: "user", content: [{ type: "input_text", text: "Read the file" }] };
const call = { type: "function_call", call_id: "c1", name: "read", arguments: '{"path":"a"}' };
const result = { type: "function_call_output", call_id: "c1", output: "contents" };
const firstInput = [user];
const resultInput = [user, call, result];
const contract = { model: "chatgpt-web/high", reasoning: { effort: "high" } };
function parsed(turnId: string, input: unknown[]) {
  return { modelId: contract.model, options: { reasoning: "high" }, context: { messages: [] },
    _rawBody: toNativeRequest({ ...contract, input }, { identity: { threadId: "thread-1", turnId },
      defaultEnvironment: { cwd: "/contract-test", workspaceRoots: ["/contract-test"] } }) };
}
let browserDone!: (value: string) => void;
let physicalDone!: () => void;
let starts = 0;
const start = () => {
  starts++;
  return { mode: "tools", token: Promise.resolve("test-only-capability"), externalProgress: new ChatGptExternalTurnProgress(),
    browser: new Promise<string>(r => { browserDone = r; }),
    physicalSettlement: new Promise<void>(r => { physicalDone = r; }),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel: () => { browserDone("cancelled"); physicalDone(); } };
};
const lease = registry.begin("thread-1", firstInput, contract);
const first = parsed(lease.turnId, firstInput);
const open = (p: any, signal?: AbortSignal) => sessions.getOrCreateAfterOwnerRetirement(
  chatGptTurnExecutionKey(p), chatGptThreadOwnershipKey(p), start, "contract-test", signal,
  p._rawBody.client_metadata["x-codex-turn-metadata"].turn_id, "thread-1", chatGptInstructionLineage(p));
const active = await open(first);
active.setOutstanding([{ callId: "c1", wireName: "read", arguments: { path: "a" } }]);
try {
  const wrong = parsed("fresh-id-per-http-attempt", resultInput);
  assert.equal(chatGptConversationKey(first, "ns"), chatGptConversationKey(wrong, "ns"));
  assert.equal(chatGptThreadOwnershipKey(first), chatGptThreadOwnershipKey(wrong));
  assert.notEqual(chatGptTurnExecutionKey(first), chatGptTurnExecutionKey(wrong));
  await assert.rejects(open(wrong, AbortSignal.timeout(50)), { name: "AbortError" });
  assert.equal(starts, 1);
  assert.equal(active.hasOutstanding("c1"), true);

  registry.observe(lease, { status: "completed", end_turn: false, output: [call] });
  const followLease = registry.begin("thread-1", resultInput, contract);
  const follow = parsed(followLease.turnId, resultInput);
  assert.equal(chatGptTurnExecutionKey(follow), chatGptTurnExecutionKey(first));
  const resumed = await open(follow, AbortSignal.timeout(1000));
  assert.equal(resumed, active);
  resumed.markResultDelivered("c1");
  assert.equal(resumed.outstanding().length, 0);
  assert.equal(starts, 1);
  registry.observe(followLease, { status: "completed", end_turn: true, output: [] });
  const next = registry.begin("thread-1", [...resultInput, { ...user, content: [{ type: "input_text", text: "Next task" }] }], contract);
  assert.notEqual(next.turnId, lease.turnId);
  assert.deepEqual(readFileSync(path), original);
  console.log(JSON.stringify({ reference: "e85e3693fdb4e3e033348c08df0298c20fcdb612", original: {
    sameRetainedConversationKey: true, sameOwner: true, sameExecutionKey: false,
    blockedBeforeToolDelivery: true,
  }, patched: { sameExecutionKey: true, sameLiveSession: true, outstandingResultAccepted: true,
    additionalBrowserStarts: 0, nextUserTurnFresh: true }, referenceSourceUnchanged: true }, null, 2));
} finally {
  browserDone("finished"); physicalDone();
  await active.physicalSettlement;
}
