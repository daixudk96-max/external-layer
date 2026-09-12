/**
 * W26 stream peek — in-band streaming failure detection for the facade's relay.
 *
 * Real-machine evidence (2026-09-12, upstream traces b6cdd0fff829/dd8259c4974c): the
 * unmodified upstream emits `response.created` FIRST — `startStream()` runs inside the
 * ReadableStream `start()` (ccw-upstream/src/bridge.ts:737, wired at :824/:841) — then
 * heartbeats every 2s, and a turn failure arrives as an IN-BAND `response.failed` frame
 * (ccw-upstream/src/bridge.ts:659/:685) inside a 200 SSE stream. The HTTP-level nav retry
 * (w25) can never see it, so the facade must judge the stream's own frames.
 *
 * The peek holds the stream's first bytes and classifies complete SSE frames:
 *   - `response.created` / `response.heartbeat` never decide (transparent);
 *   - the first OTHER frame decides: content → relay head + remainder; a nav-class failure
 *     → throw (the outer nav budget retries the whole attempt invisibly); a non-nav failure
 *     → keep reading to the stream end and replay the original bytes verbatim (today's
 *     relay behavior, byte-identical);
 *   - a hard deadline bounds the hold so a pathological all-heartbeat stream still relays.
 *
 * The relayed bytes are untouched: whatever the head held is forwarded as-is (heartbeats
 * included), so w21/w22 timing semantics and the client-visible frame shapes are unchanged.
 */

/** The frames that never decide the peek. `response.created` is emitted synchronously when
 *  the upstream stream is constructed (bridge.ts:737); heartbeats are keep-alives (bridge.ts:202). */
import { isNavigationError } from "./reliability";

const TRANSPARENT_EVENTS: ReadonlySet<string> = new Set(["response.created", "response.heartbeat"]);

/** The facade's own synthesized error frames (`event: error` + `{"type":"error",...}`) never
 *  pass through the peek — this lives upstream of the relay transform — but an upstream
 *  "error" event is still a failure signal if one ever arrives. */
const FAILURE_EVENT_NAMES: ReadonlySet<string> = new Set([
  "response.failed",
  "response.incomplete",
  "error",
]);

interface FrameView {
  event: string;
  dataLine: string;
  parsed?: Record<string, unknown>;
}

function frameViewOf(frameText: string): FrameView {
  const eventMatch = /event:\s*(.*)/.exec(frameText);
  const dataMatch = /data:\s*(.*)/.exec(frameText);
  const dataLine = (dataMatch?.[1] ?? "").trim();
  let parsed: Record<string, unknown> | undefined;
  if (dataLine && dataLine !== "[DONE]") {
    try {
      parsed = JSON.parse(dataLine) as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
  }
  return { event: (eventMatch?.[1] ?? "").trim(), dataLine, parsed };
}

function failureMessageOf(view: FrameView): string | undefined {
  const response = (view.parsed?.response ?? {}) as {
    error?: { message?: string };
    incomplete_details?: { reason?: string; message?: string };
  };
  if (response.error?.message) return response.error.message;
  if (response.incomplete_details?.message) return response.incomplete_details.message;
  if (response.incomplete_details?.reason) return `upstream stall: ${response.incomplete_details.reason}`;
  return undefined;
}

interface HeadVerdict {
  kind: "pending" | "content" | "failure";
  message?: string;
}

/** One classified SSE event: transparent frames never decide the peek; a failure frame stops
 *  it; any other decidable frame (delta, completed, [DONE]) means the turn is producing. */
function classifyEvent(view: FrameView): HeadVerdict {
  if (TRANSPARENT_EVENTS.has(view.event)) return { kind: "pending" };
  let type = "";
  if (view.parsed && typeof view.parsed.type === "string") type = view.parsed.type;
  if (TRANSPARENT_EVENTS.has(type)) return { kind: "pending" };
  const failureEvent =
    FAILURE_EVENT_NAMES.has(view.event) ||
    FAILURE_EVENT_NAMES.has(type) ||
    type === "response.incomplete";
  if (failureEvent) {
    const fallback = view.dataLine || view.event || "upstream stream failed";
    return { kind: "failure", message: failureMessageOf(view) ?? fallback };
  }
  // Any other decidable frame (output_item.added, deltas, [DONE], ...) means the turn is
  // producing: relay from the head.
  return { kind: "content" };
}

/** Classify the buffered head: does a decidable event already decide? An event is decidable
 *  once BOTH its event line and its data line arrived — the blank-line terminator is not
 *  required, because test mocks and some relays separate frames with a single newline. */
export function classifySseHead(buffer: string): HeadVerdict {
  // A trailing line without its terminating newline is STILL ARRIVING: its JSON is incomplete,
  // so deciding on it would misclassify a failure as content or relay a nav failure un-retried
  // (real machine 2026-09-12 20:59, trace d75de6825145: `page.goto: net::ERR_SSL_PROTOCOL_ERROR`
  // relayed after a single attempt because the failed data line was split mid-JSON).
  const complete = buffer.endsWith("\n") ? buffer : buffer.slice(0, buffer.lastIndexOf("\n") + 1);
  const lines = complete.split("\n");
  let pendingEvent = "";
  for (const line of lines) {
    if (line.startsWith("event:")) {
      pendingEvent = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const view = frameViewOf(`${pendingEvent}\n${line}`);
    const verdict = classifyEvent(view);
    if (verdict.kind !== "pending") return verdict;
    pendingEvent = "";
  }
  return { kind: "pending" };
}

/** Scan a COMPLETED relay text for an upstream-originated failure frame. Used by the relay
 *  tap so an in-band failure is accounted like a failed turn (w24) instead of a success.
 *  The facade's own synthesized frames (`type: "error"`) are deliberately NOT matched: the
 *  watchdog path already notes those failures in onStreamError, and double counting would
 *  let one stall count twice. */
export function upstreamStreamFailureOf(fullText: string): string | undefined {
  const match = /event: (response\.failed|response\.incomplete)\ndata: ([^\n]*)\n/.exec(fullText);
  if (!match) return undefined;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(match[2]) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  const message = failureMessageOf({ event: match[1], dataLine: match[2], parsed });
  return message ?? "upstream stream failed";
}

/** Thrown when the peek finds a nav-class failure before any content: the outer nav budget
 *  (w25 withNavigationRetry) retries the whole attempt; when the budget is exhausted the
 *  ORIGINAL bytes are replayed verbatim to the client (today's relay behavior). */
export class UpstreamStreamNavFailure extends Error {
  readonly navMessage: string;
  readonly contentType: string;
  private readonly chunks: readonly Uint8Array[];

  constructor(navMessage: string, chunks: readonly Uint8Array[], contentType: string) {
    super(navMessage);
    this.name = "UpstreamStreamNavFailure";
    this.navMessage = navMessage;
    this.chunks = chunks;
    this.contentType = contentType;
  }

  /** The original attempt's bytes, verbatim. */
  replayStream(): ReadableStream<Uint8Array> {
    return replayOf(this.chunks);
  }
}

function replayOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** head bytes first, then the live remainder of the upstream stream. The pump respects the
 *  controller's desiredSize (the same push-driven pattern the unmodified upstream uses for
 *  Bun on Windows, ccw-upstream/src/bridge.ts:834 waitForCapacity) so the relay keeps the
 *  upstream's own chunk pacing instead of buffering everything into the stream queue. */
function combinedOf(head: Uint8Array[], reader: { read(): Promise<IteratorResult<Uint8Array>>; cancel(): Promise<void> }): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const waitForCapacity = async () => {
        while ((controller.desiredSize ?? 1) <= 0) {
          await Bun.sleep(5);
        }
      };
      for (const chunk of head) {
        await waitForCapacity();
        try {
          controller.enqueue(chunk);
        } catch {
          return;
        }
      }
      for (;;) {
        await waitForCapacity();
        let read: IteratorResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (error) {
          // The upstream connection broke mid-stream: the downstream terminateOnStreamFailure
          // contract (w9/w22) needs the ERROR, not a clean close, to synthesize the error frame.
          try {
            controller.error(error);
          } catch {}
          return;
        }
        if (read.done) {
          try {
            controller.close();
          } catch {}
          return;
        }
        try {
          controller.enqueue(read.value);
        } catch {
          return;
        }
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
}

/**
 * Hold the upstream SSE stream until its first meaningful frame decides:
 *   content → relay head + remainder; nav failure → throw (retry invisibly);
 *   non-nav failure → drain to the end and relay the original bytes verbatim;
 *   deadline/empty → relay whatever was held.
 * `deadlineMs` bounds the hold; the facade passes its first-byte budget (capped), so a
 * stream that only ever sends heartbeats still relays and the downstream watchdog takes over.
 */
export async function peekUpstreamSse(
  upstreamBody: ReadableStream<Uint8Array>,
  contentType: string,
  deadlineMs: number,
): Promise<ReadableStream<Uint8Array>> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const head: Uint8Array[] = [];
  let buffer = "";
  const deadline = Date.now() + Math.max(1_000, deadlineMs);
  for (;;) {
    if (Date.now() >= deadline) return combinedOf(head, reader);
    let read: IteratorResult<Uint8Array>;
    try {
      read = await reader.read();
    } catch {
      if (head.length > 0) return replayOf(head);
      throw new Error("upstream stream ended before its first frame");
    }
    if (read.done) return combinedOf(head, reader);
    if (read.value && read.value.length > 0) {
      head.push(read.value);
      buffer += decoder.decode(read.value, { stream: true });
    }
    const verdict = classifySseHead(buffer);
    if (verdict.kind === "content") return combinedOf(head, reader);
    if (verdict.kind === "failure") {
      // Keep reading to the stream end so an exhausted retry can replay the ORIGINAL bytes
      // verbatim (the unmodified upstream closes right after the terminal frame + [DONE]).
      for (;;) {
        try {
          const rest = await reader.read();
          if (rest.done) break;
          if (rest.value && rest.value.length > 0) head.push(rest.value);
        } catch {
          break;
        }
      }
      if (isNavigationError(verdict.message!)) {
        throw new UpstreamStreamNavFailure(verdict.message!, head, contentType);
      }
      return replayOf(head);
    }
  }
}