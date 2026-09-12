/**
 * W24 failure breaker: stop the big-conversation death spiral with an immediate, actionable error.
 *
 * Evidence (2026-09-12, live upstream-serve.log): 6 turns aborted, each preceded by a
 * `20-response-stalled-60s` checkpoint (1:1) — a fresh temporary conversation pasted with a
 * 40k-token history balloons the page DOM to ~630KB, generation stalls, and the turn is aborted;
 * every abort releases the retained tab, so the agent's next step re-pastes everything. Payload
 * vs outcome across 127 turns: <20k tokens completed 68/83 (~82%), >=20k tokens 1/44 (~2%).
 *
 * Policy: per-conversation consecutive-failure counter. A failure only QUALIFIES when the request
 * payload is at least `payloadCharsThreshold` chars (small transient blips must not poison a
 * conversation). After `failureThreshold` qualifying failures the conversation is refused with
 * HTTP 429 `conversation_too_large` for `cooldownMs`, then one attempt is allowed (half-open):
 * success closes, failure re-opens. The estimate is ~chars/2.5 tokens, calibrated on live data
 * (102,808 chars <-> 39,866 tokens).
 */
export interface FailureBreakerConfig {
  enabled?: boolean;
  /** consecutive qualifying failures before the conversation is refused; default 3 */
  failureThreshold?: number;
  /** a failure only counts when the request payload is at least this many chars; default 150_000 */
  payloadCharsThreshold?: number;
  /** refusal window after tripping; one attempt is allowed after it expires; default 300_000 */
  cooldownMs?: number;
  /** injectable clock (tests) */
  now?: () => number;
}

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_PAYLOAD_CHARS_THRESHOLD = 150_000;
export const DEFAULT_COOLDOWN_MS = 300_000;
/**
 * chars -> tokens, content-aware (2026-09-12: the flat 2.5 ratio overestimated ASCII-heavy
 * payloads by ~34% — real machine: 186,062 chars <-> 55,371 tokens = 3.36 chars/token for a
 * mostly-English/code payload, while the Chinese-mixed point 52,434 <-> 20,536 = 2.55 fits
 * ascii/3.6 + cjk/1.5 with a ~29% CJK share). Heuristic, not a tokenizer.
 */
const ASCII_CHARS_PER_TOKEN = 3.6;
const CJK_CHARS_PER_TOKEN = 1.5;
/** Han + kana + Hangul + fullwidth forms: the chars real tokenizers spend ~1 token on. */
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g;
const MAX_TRACKED_CONVERSATIONS = 512;

export interface BreakerVerdict {
  blocked: boolean;
  failures: number;
  estimatedTokens: number;
}

export interface FailureBreaker {
  check(threadId: string, payloadChars: number, cjkChars?: number): BreakerVerdict;
  recordFailure(threadId: string, payloadChars: number, cjkChars?: number): void;
  /**
   * W27: one qualifying big-payload failure is already enough evidence that this conversation
   * cannot pass the page as-is, so the NEXT oversized request should be nudged (a synthetic
   * completed response telling the agent to compact / start a new conversation) instead of
   * burning another doomed upstream turn. Never true below the payload threshold.
   */
  shouldNudge(
    threadId: string,
    payloadChars: number,
    cjkChars?: number,
  ): { nudge: boolean; failures: number; estimatedTokens: number };
  recordSuccess(threadId: string): void;
}

/** Deterministic payload size: serialized input items plus top-level instructions, with the
 *  CJK share counted separately so the token estimate can be content-aware. */
export function estimatePayloadSize(
  items: unknown[],
  instructions?: string,
): { chars: number; cjkChars: number } {
  let chars = typeof instructions === "string" ? instructions.length : 0;
  let cjkChars = typeof instructions === "string" ? countCjk(instructions) : 0;
  for (const item of items) {
    const serialized = JSON.stringify(item);
    chars += serialized.length;
    cjkChars += countCjk(serialized);
  }
  return { chars, cjkChars };
}

function countCjk(text: string): number {
  return text.match(CJK_CHAR_RE)?.length ?? 0;
}

/** Back-compat wrapper: the deterministic char size only. */
export function estimatePayloadChars(items: unknown[], instructions?: string): number {
  return estimatePayloadSize(items, instructions).chars;
}

export function estimateTokensFromChars(payloadChars: number, cjkChars = 0): number {
  const asciiChars = Math.max(0, payloadChars - cjkChars);
  return Math.round(asciiChars / ASCII_CHARS_PER_TOKEN + cjkChars / CJK_CHARS_PER_TOKEN);
}

interface ConversationState {
  failures: number;
  openedAt: number | null;
}

export function createFailureBreaker(rawConfig: FailureBreakerConfig = {}): FailureBreaker {
  const failureThreshold = rawConfig.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const payloadCharsThreshold = rawConfig.payloadCharsThreshold ?? DEFAULT_PAYLOAD_CHARS_THRESHOLD;
  const cooldownMs = rawConfig.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = rawConfig.now ?? Date.now;
  const states = new Map<string, ConversationState>();

  const stateOf = (threadId: string): ConversationState => {
    const existing = states.get(threadId);
    if (existing) return existing;
    const fresh: ConversationState = { failures: 0, openedAt: null };
    states.set(threadId, fresh);
    if (states.size > MAX_TRACKED_CONVERSATIONS) {
      const oldest = states.keys().next().value;
      if (oldest !== undefined) states.delete(oldest);
    }
    return fresh;
  };

  if (rawConfig.enabled === false) {
    return {
      check: () => ({ blocked: false, failures: 0, estimatedTokens: 0 }),
      shouldNudge: () => ({ nudge: false, failures: 0, estimatedTokens: 0 }),
      recordFailure: () => undefined,
      recordSuccess: () => undefined,
    };
  }

  return {
    check(threadId, payloadChars, cjkChars = 0) {
      const state = stateOf(threadId);
      const blocked = state.openedAt !== null && now() - state.openedAt < cooldownMs;
      return {
        blocked,
        failures: state.failures,
        estimatedTokens: estimateTokensFromChars(payloadChars, cjkChars),
      };
    },
    shouldNudge(threadId, payloadChars, cjkChars = 0) {
      const state = stateOf(threadId);
      return {
        nudge: state.failures >= 1 && payloadChars >= payloadCharsThreshold,
        failures: state.failures,
        estimatedTokens: estimateTokensFromChars(payloadChars, cjkChars),
      };
    },
    recordFailure(threadId, payloadChars) {
      if (payloadChars < payloadCharsThreshold) return;
      const state = stateOf(threadId);
      state.failures += 1;
      if (state.failures >= failureThreshold) state.openedAt = now();
    },
    recordSuccess(threadId) {
      const state = states.get(threadId);
      if (!state) return;
      state.failures = 0;
      state.openedAt = null;
    },
  };
}