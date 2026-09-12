/**
 * Bridge upstream stall budget: seconds of silence (no adapter events) before the
 * Responses bridge emits `response.incomplete` / `upstream_stall_timeout`.
 *
 * Raised from 90s so long reasoning + large tool writes are not cut mid-turn.
 * Hung streams still die; they just get a more realistic window.
 */
export const DEFAULT_STALL_TIMEOUT_SEC = 300;

// Keep a malformed or accidentally enormous configuration within a practical recovery budget.
export const MAX_STALL_TIMEOUT_SEC = 3_600;

/**
 * Resolve the effective bridge stall deadline for a turn.
 * - unset / non-finite config → {@link DEFAULT_STALL_TIMEOUT_SEC}
 * - finite config → ceil, clamped to the practical [1, {@link MAX_STALL_TIMEOUT_SEC}] range
 */
export function resolveStallTimeoutSec(configuredSec: number | undefined): number {
  if (typeof configuredSec === "number" && Number.isFinite(configuredSec)) {
    return Math.min(MAX_STALL_TIMEOUT_SEC, Math.max(1, Math.ceil(configuredSec)));
  }
  return DEFAULT_STALL_TIMEOUT_SEC;
}

export const DEFAULT_PROGRESS_TIMEOUT_MS = 240_000;
export const MAX_PROGRESS_TIMEOUT_MS = 3_600_000;

/**
 * Resolve the effective progress timeout for a turn producing no content-bearing frame.
 * - non-finite or <= 0 -> DEFAULT_PROGRESS_TIMEOUT_MS
 * - otherwise clamped to min(configured, MAX_PROGRESS_TIMEOUT_MS)
 */
export function resolveProgressTimeoutMs(configured?: number): number {
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.min(configured, MAX_PROGRESS_TIMEOUT_MS);
  }
  return DEFAULT_PROGRESS_TIMEOUT_MS;
}

export type UpstreamStallKind = "first_byte" | "stream_stall" | "no_progress";

/**
 * 结构化上游停滞错误，用以区分「首字节超时（可重试）」与「流内静默超时（不可重试）」。
 */
export class UpstreamStallError extends Error {
  constructor(
    public readonly kind: UpstreamStallKind,
    public readonly budgetMs: number,
    message?: string,
  ) {
    super(message ?? `upstream stall timeout: kind=${kind} budget=${budgetMs}ms`);
    this.name = "UpstreamStallError";
  }
}
