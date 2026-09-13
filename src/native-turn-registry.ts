import { createHash, randomUUID } from "node:crypto";
import { canonicalItemDigest, stableStringify } from "./conversation-registry";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): string => createHash("sha256").update(stableStringify(value)).digest("hex");

// User item IDs participate in upstream execution identity. Other transient item IDs do not.
function inputDigest(item: unknown): string {
  return hash([canonicalItemDigest(item), record(item) && item.role === "user" ? [item.id, item.content] : null]);
}
function callDigest(item: Record<string, unknown>): string {
  let args = item.arguments;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch {} }
  return hash([item.call_id, item.name, args]);
}

export interface NativeTurnLease {
  threadId: string;
  turnId: string;
  generation: number;
  resumed: boolean;
}
interface PendingBatch {
  prefix: string[];
  calls: Map<string, string>;
}
interface Entry {
  lease: NativeTurnLease;
  contract: string;
  input: string[];
  pending?: PendingBatch;
}

/** Volatile, bounded protocol state, NOT a response cache or a browser-tab registry.
 * A completed Responses tool batch with end_turn=false leaves the native browser execution
 * alive. Its matching tool-result round must retain turn_id; ordinary requests/retries must not.
 * Only digests and synthetic IDs are retained. No prompts, results, or credentials are stored.
 */
export class NativeTurnRegistry {
  private readonly entries = new Map<string, Entry>();
  private generation = 0;
  private readonly limit: number;
  constructor(limit = 64) { this.limit = Math.max(1, Math.floor(limit) || 64); }

  begin(threadId: string, items: unknown[], contract: unknown, allowResume = true): NativeTurnLease {
    const previous = this.entries.get(threadId);
    const fingerprint = hash(contract);
    const pending = previous?.pending;
    const resumed = Boolean(allowResume && previous && pending && previous.contract === fingerprint
      && this.matches(items, pending));
    const lease = { threadId, turnId: resumed ? previous!.lease.turnId : `prov-${randomUUID()}`,
      generation: ++this.generation, resumed };
    this.entries.delete(threadId);
    this.entries.set(threadId, { lease, contract: fingerprint, input: items.map(inputDigest),
      // Concurrent identical tool-result submissions may use upstream's native round journal.
      ...(resumed ? { pending } : {}) });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return lease;
  }

  private matches(items: unknown[], batch: PendingBatch): boolean {
    if (items.length <= batch.prefix.length) return false;
    if (batch.prefix.some((digest, index) => inputDigest(items[index]) !== digest)) return false;
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const item of items.slice(batch.prefix.length)) {
      if (!record(item)) return false;
      if (item.type === "function_call") {
        if (typeof item.call_id !== "string" || calls.has(item.call_id)
          || batch.calls.get(item.call_id) !== callDigest(item)) return false;
        calls.add(item.call_id);
      } else if (item.type === "function_call_output") {
        if (typeof item.call_id !== "string" || !batch.calls.has(item.call_id)
          || results.has(item.call_id) || !("output" in item)) return false;
        results.add(item.call_id);
      } else if (item.type !== "reasoning" && !(item.type === "message" && item.role === "assistant")) {
        // New instructions, compaction, unknown tools, or changed history are NOT a continuation.
        return false;
      }
    }
    return calls.size === batch.calls.size && results.size === batch.calls.size;
  }

  isCurrent(lease: NativeTurnLease): boolean {
    return this.entries.get(lease.threadId)?.lease.generation === lease.generation;
  }

  observe(lease: NativeTurnLease, response: unknown): void {
    if (!this.isCurrent(lease)) return;
    const entry = this.entries.get(lease.threadId)!;
    entry.pending = undefined;
    // v5.0.6 explicitly distinguishes provider-round completion from browser completion.
    if (!record(response) || response.status !== "completed" || response.end_turn !== false
      || !Array.isArray(response.output)) return;
    const calls = new Map<string, string>();
    for (const item of response.output) {
      if (!record(item)) return;
      if (item.type === "function_call") {
        if (typeof item.call_id !== "string" || !item.call_id || calls.has(item.call_id)
          || typeof item.name !== "string" || typeof item.arguments !== "string") return;
        calls.set(item.call_id, callDigest(item));
      } else if (item.type !== "reasoning" && !(item.type === "message" && item.role === "assistant")) return;
    }
    if (calls.size) entry.pending = { prefix: entry.input, calls };
  }

  fail(lease: NativeTurnLease): void {
    if (this.isCurrent(lease)) this.entries.delete(lease.threadId);
  }
}

/** Observe terminal SSE data before the corresponding bytes become client-visible.
 * UTF-8 decoding is owned by the existing stream tap. Fragmented lines and CRLF are supported;
 * the observer never edits, buffers for delivery, or synthesizes any client-visible bytes.
 */
export class ResponseTerminalObserver {
  private buffer = "";
  private data: string[] = [];
  seen = false;
  constructor(private readonly onTerminal: (type: string, response: unknown) => void) {}
  push(text: string): void {
    if (this.seen) return;
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (!line || line.startsWith("event:")) { this.data = []; continue; }
      if (!line.startsWith("data:")) continue;
      this.data.push(line.slice(5).trimStart());
      let event: unknown;
      try { event = JSON.parse(this.data.join("\n")); } catch { continue; }
      this.data = [];
      if (!record(event) || !["response.completed", "response.failed", "response.incomplete"].includes(String(event.type))) continue;
      this.seen = true;
      this.buffer = "";
      this.onTerminal(String(event.type), event.response);
      return;
    }
  }
}
