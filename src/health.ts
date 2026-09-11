/** Operational health for the external layer facade. */
export interface ExternalLayerHealthState {
  upstreamBaseUrl: string;
  lastError?: string;
  startedAt: number;
  requests: number;
}

export interface ExternalLayerHealth {
  status: "ok" | "degraded";
  upstream: string;
  uptime_ms: number;
  requests: number;
  last_error?: string;
}

/** A recent request failure degrades the facade; credentials never appear in the payload. */
export function describeHealth(state: ExternalLayerHealthState): ExternalLayerHealth {
  return {
    status: state.lastError ? "degraded" : "ok",
    upstream: state.upstreamBaseUrl,
    uptime_ms: Math.max(0, Date.now() - state.startedAt),
    requests: state.requests,
    ...(state.lastError ? { last_error: state.lastError } : {}),
  };
}
