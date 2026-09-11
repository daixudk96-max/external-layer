/**
 * T3.2 tool timeout contract: the three independent tool-phase budgets and their defaults.
 *
 * The three phases are deliberately separate knobs and must never collapse into one large
 * timeout (PRD hard requirement):
 * 1. queue (waiting to start in task queue)
 * 2. generation (waiting for web model to generate the turn/response)
 * 3. toolResult (waiting for client to execute tool and return tool result)
 *
 * Each waits on a completely different actor, so each gets its own independent budget
 * and override entry. They must NEVER collapse into a single monolithic timeout.
 *
 * The defaults are conservative placeholders. Production values must come from the measured
 * service-time distribution (T1.3 calibration); the configuration entry point shipped here is
 * the deliverable, not the numbers.
 */

/**
 * Single source of truth for the 90s local MCP invocation budget (migrated verbatim from
 * `adapters/chatgpt-web/mcp-server.ts`, which re-exports this constant). The OpenAI tunnel owns
 * a two-minute command-response deadline, so the local MCP server must settle first — an
 * abandoned native tool call is returned as an MCP error instead of letting the tunnel tear down
 * and poison its long-lived stdio transport.
 *
 * The same number is the default `toolResultTimeoutMs` of the provider-side timeout contract:
 * short tools must return inside the 90s MCP budget, and the provider-side wait for a client
 * tool result is bounded by the same budget unless explicitly overridden.
 */
export const CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 90_000;

/** Default budget for a new task waiting to start (T4.1 queue: semantic placeholder only). */
export const DEFAULT_TOOL_QUEUE_TIMEOUT_MS = 60_000;

/** Default budget for a web generation; mirrors the bridge watchdog's 300s stall default. */
export const DEFAULT_TOOL_GENERATION_TIMEOUT_MS = 300_000;

/** How long a client may take to deliver a started job's result, as a factor of toolResultTimeoutMs. */
export const TOOL_JOB_TIMEOUT_FACTOR = 10;

/** The validated, independent three-phase timeout configuration. */
export interface ToolTimeoutsConfig {
  /** New-task queueing budget (T4.1 placeholder: configuration and semantics only). */
  queueTimeoutMs: number;
  /** Web generation budget (explicit override entry for the bridge watchdog's stall default). */
  generationTimeoutMs: number;
  /** Client tool-result wait budget (aligns with the 90s MCP invocation budget by default). */
  toolResultTimeoutMs: number;
}

export const DEFAULT_TOOL_TIMEOUTS: ToolTimeoutsConfig = {
  queueTimeoutMs: DEFAULT_TOOL_QUEUE_TIMEOUT_MS,
  generationTimeoutMs: DEFAULT_TOOL_GENERATION_TIMEOUT_MS,
  toolResultTimeoutMs: CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS,
};

export function isPositiveTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

/**
 * Long-running job deadline: a job started through `start_job` may legitimately outlive the
 * short-tool budget, so its result wait is bounded by toolResultTimeoutMs × TOOL_JOB_TIMEOUT_FACTOR
 * instead. Derived, never configured separately, so the two budgets can never drift apart.
 */
export function jobTimeoutMsFor(toolResultTimeoutMs: number): number {
  return toolResultTimeoutMs * TOOL_JOB_TIMEOUT_FACTOR;
}

/**
 * Resolve the effective three-phase timeouts from a (possibly partial) raw configuration.
 * Missing fields fall back to their own defaults independently; a present field must be a
 * positive integer millisecond budget.
 */
export function resolveToolTimeouts(
  raw: Partial<Record<keyof ToolTimeoutsConfig, unknown>> | undefined,
  path: string,
): ToolTimeoutsConfig {
  if (raw === undefined) return { ...DEFAULT_TOOL_TIMEOUTS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid toolTimeouts in ${path}`);
  }
  const resolved = {} as ToolTimeoutsConfig;
  for (const key of ["queueTimeoutMs", "generationTimeoutMs", "toolResultTimeoutMs"] as const) {
    const value = raw[key];
    if (value === undefined) {
      resolved[key] = DEFAULT_TOOL_TIMEOUTS[key];
      continue;
    }
    if (!isPositiveTimeoutMs(value)) {
      throw new Error(`Invalid toolTimeouts.${key} in ${path}: must be a positive integer number of milliseconds`);
    }
    resolved[key] = value;
  }
  return resolved;
}
