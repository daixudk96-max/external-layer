import { createHash, randomUUID } from "node:crypto";
import { stableStringify } from "./conversation-registry";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function instructionDigest(items: readonly unknown[]): string | undefined {
  const userCount = items.filter(value => record(value)?.role === "user").length;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = record(items[i]);
    if (item?.role !== "user") continue;
    const content = item.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.map(p => record(p)?.text ?? "").join("\n") : "";
    if (/^\s*<(environment_context|subagent_notification)>[\s\S]*<\/(environment_context|subagent_notification)>\s*$/.test(text)) continue;
    // These are the fields in upstream's execution revision. Never use a textual call-id
    // heuristic as permission to attach a result to another user's task.
    return createHash("sha256").update(stableStringify({ content, id: item.id ?? null, userCount })).digest("hex");
  }
  return undefined;
}

export interface NativeRoundIdentity {
  threadId: string;
  turnId: string;
  route: string;
  instruction?: string;
  kind: "new-turn" | "tool-result" | "tool-replay";
}

interface PendingTurn {
  identity: NativeRoundIdentity;
  callIds: string[];
  responseId?: string;
  updatedAt: number;
}

/** An HTTP Responses round is NOT a Codex native turn. A tool suspension keeps the
 * original browser execution alive until the matching tool outputs are delivered. */
export class NativeTurnState {
  private readonly pending = new Map<string, PendingTurn>();

  choose(threadId: string, input: readonly unknown[], route: string, previousResponseId?: string): NativeRoundIdentity {
    const instruction = instructionDigest(input);
    const prior = this.pending.get(threadId);
    if (prior && Date.now() - prior.updatedAt > 30 * 60_000) this.pending.delete(threadId);
    else if (prior && prior.identity.route === route
      && (instruction === prior.identity.instruction
        || (instruction === undefined && previousResponseId === prior.responseId))) {
      const results = new Set(input.flatMap(value => {
        const item = record(value);
        return item && (item.type === "function_call_output" || item.type === "custom_tool_call_output")
          && typeof item.call_id === "string" ? [item.call_id] : [];
      }));
      // A reconnect without results must replay the pending batch, not create a new
      // browser turn. Upstream itself validates completeness of parallel result batches.
      return { ...prior.identity, kind: prior.callIds.some(id => results.has(id)) ? "tool-result" : "tool-replay" };
    }
    return { threadId, turnId: `prov-${randomUUID()}`, route, instruction, kind: "new-turn" };
  }

  observe(identity: NativeRoundIdentity, response: Record<string, unknown>): void {
    if (response.status !== "completed") { this.fail(identity); return; }
    const callIds = Array.isArray(response.output) ? response.output.flatMap(value => {
      const item = record(value);
      return item && (item.type === "function_call" || item.type === "custom_tool_call")
        && typeof item.call_id === "string" ? [item.call_id] : [];
    }) : [];
    if (callIds.length > 0 && response.end_turn !== true) {
      if (!this.pending.has(identity.threadId) && this.pending.size >= 256) {
        // A bounded registry must fail, not evict an in-flight tool owner and silently re-run it.
        throw new Error("native tool-turn registry is full; finish or cancel pending work");
      }
      this.pending.set(identity.threadId, { identity, callIds: [...new Set(callIds)],
        responseId: typeof response.id === "string" ? response.id : undefined, updatedAt: Date.now() });
    } else {
      this.pending.delete(identity.threadId);
    }
  }

  fail(identity: NativeRoundIdentity): void {
    const current = this.pending.get(identity.threadId);
    if (current?.identity.turnId === identity.turnId) this.pending.delete(identity.threadId);
  }
}

/** Serialize HTTP observers per thread, NOT entire browser lifetimes. Releasing on each
 * round's EOF lets the next tool-result request enter the still-running native execution.
 * Different sessions remain independent; there is no global browser mutex. */
export class NativeRoundGate {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(thread: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new DOMException("request aborted while queued", "AbortError");
    const before = this.tails.get(thread) ?? Promise.resolve();
    let unlock!: () => void;
    const owned = new Promise<void>(resolve => { unlock = resolve; });
    const tail = before.then(() => owned);
    this.tails.set(thread, tail);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      unlock();
      // A cancelled waiter must never release an earlier owner's lock.
      void tail.then(() => { if (this.tails.get(thread) === tail) this.tails.delete(thread); });
    };
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException("request aborted while queued", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { await Promise.race([before, aborted]); }
    catch (error) { release(); throw error; }
    finally { signal.removeEventListener("abort", onAbort); }
    if (signal.aborted) { release(); throw new DOMException("request aborted while queued", "AbortError"); }
    return release;
  }
}

export function releaseOnStreamEnd(source: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) { release(); controller.close(); break; }
          controller.enqueue(next.value);
        }
      } catch (error) { release(); try { controller.error(error); } catch {} }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } },
  });
}
