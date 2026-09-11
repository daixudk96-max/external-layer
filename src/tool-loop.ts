/**
 * w5-tools :: tool loop driver.
 *
 * Drives the Responses-style function-call loop:
 *   model -> function_call(s) -> execute tool -> function_call_output -> next round
 * until the model answers with plain text (no function calls) or the hard
 * `maxRounds` ceiling is reached. The ceiling always wins, so a model that keeps
 * emitting function calls can never spin forever; whatever text was produced on
 * the way is preserved in the returned outcome.
 */

export interface ToolLoopFunctionCall {
  callId: string;
  name: string;
  args: unknown;
}

export interface ToolLoopModelResult {
  functionCalls: Array<{ callId: string; name: string; args: unknown }>;
  text?: string;
  rawResponse: unknown;
}

export interface ToolLoopRequest {
  input: unknown;
  tools?: unknown[];
  maxRounds?: number;
}

export interface ToolLoopDeps {
  callModel: (
    round: number,
    previous: unknown,
  ) => Promise<{ functionCalls: Array<{ callId: string; name: string; args: unknown }>; text?: string; rawResponse: unknown }>;
  executeTool: (name: string, args: unknown) => Promise<unknown>;
}

export interface ToolLoopToolResult {
  callId: string;
  output: unknown;
}

export interface ToolLoopOutcome {
  rounds: number;
  text: string;
  toolResults: Array<{ callId: string; output: unknown }>;
}

/** Fallback ceiling when the caller does not supply a usable `maxRounds`. */
export const DEFAULT_MAX_ROUNDS = 8;

function normalizeMaxRounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_ROUNDS;
  const floored = Math.floor(value);
  if (floored < 1) return DEFAULT_MAX_ROUNDS;
  return floored;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyArgs(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined || args === null) return "{}";
  try {
    return JSON.stringify(args) ?? "{}";
  } catch {
    return "{}";
  }
}

function coerceFunctionCall(raw: unknown, index: number): ToolLoopFunctionCall | undefined {
  if (!isRecord(raw)) return undefined;
  const callId = typeof raw.callId === "string" ? raw.callId : typeof raw.id === "string" ? raw.id : `call_${index}`;
  const name = typeof raw.name === "string" ? raw.name : "";
  if (name === "") return undefined;
  return { callId, name, args: raw.args };
}

/**
 * Seed transcript for `previous`: an array input is reused as-is, anything else
 * is wrapped in a single user message so downstream models always get a list.
 */
function seedHistory(input: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(input)) return [...(input as Array<Record<string, unknown>>)];
  return [{ role: "user", content: input }];
}

export async function runToolLoop(
  request: { input: unknown; tools?: unknown[]; maxRounds?: number },
  deps: {
    callModel: (
      round: number,
      previous: unknown,
    ) => Promise<{ functionCalls: Array<{ callId: string; name: string; args: unknown }>; text?: string; rawResponse: unknown }>;
    executeTool: (name: string, args: unknown) => Promise<unknown>;
  },
): Promise<{ rounds: number; text: string; toolResults: Array<{ callId: string; output: unknown }> }> {
  const maxRounds = normalizeMaxRounds(request?.maxRounds);
  const history = seedHistory(request?.input);
  const toolResults: ToolLoopToolResult[] = [];
  let text = "";
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round;
    const previous: unknown = round === 1 ? request?.input : [...history];

    const result = await deps.callModel(round, previous);

    // Preserve the newest non-empty text so a later bare tool round cannot erase it.
    if (result && typeof result.text === "string" && result.text.length > 0) text = result.text;

    const rawCalls = result && Array.isArray(result.functionCalls) ? result.functionCalls : [];
    const functionCalls: ToolLoopFunctionCall[] = [];
    for (let i = 0; i < rawCalls.length; i += 1) {
      const call = coerceFunctionCall(rawCalls[i], i);
      if (call) functionCalls.push(call);
    }

    if (functionCalls.length === 0) {
      // Plain-text answer: the loop is finished.
      return { rounds, text, toolResults };
    }

    for (const call of functionCalls) {
      history.push({
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: stringifyArgs(call.args),
      });
    }

    for (const call of functionCalls) {
      let output: unknown;
      try {
        output = await deps.executeTool(call.name, call.args);
      } catch (error) {
        output = { error: error instanceof Error ? error.message : String(error) };
      }
      toolResults.push({ callId: call.callId, output });
      history.push({ type: "function_call_output", call_id: call.callId, output });
    }
  }

  // maxRounds exhausted: stop, keeping whatever text/results were accumulated.
  return { rounds, text, toolResults };
}
