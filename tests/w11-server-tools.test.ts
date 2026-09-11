/**
 * w11-server-tools :: canonical contract for SERVER-SIDE tool execution.
 *
 * Today the facade only passes `function_call` items through: the client executes the
 * tools. This wave adds an OPT-IN mode (`ExternalLayerConfig.serverTools`) in which the
 * layer executes the tool calls itself, appends a `function_call_output` item to the
 * native input, and re-issues the upstream turn until the model answers with plain text.
 *
 * ---------------------------------------------------------------------------
 * FROZEN CONTRACT SPELLINGS (the implementation must satisfy these verbatim)
 * ---------------------------------------------------------------------------
 * config:      `serverTools?: { enabled: boolean; workspaceRoots: string[];
 *               allowedTools?: string[]; approvals?: "auto" | "deny";
 *               auditPath?: string; maxRounds?: number }`
 * defaults:    `enabled` false, `allowedTools` ["read_file"], `approvals` "deny",
 *              `maxRounds` 8 (== maximum number of UPSTREAM turns in the loop)
 * native item: `{ type: "function_call_output", call_id: <id>, output: <payload> }`
 *              `output` may be the JSON *string* or the object itself; once parsed it
 *              must expose the payload fields below.
 * read_file:   payload `{ "content": "<utf-8 file text>" }`
 * path error:  payload `{ "error": "path_outside_workspace" }` (stable machine-readable
 *              code; the escaped file content must appear NOWHERE in the HTTP response)
 * run_command: payload `{ "exitCode": <number>, "stdout": <string>, "stderr": <string>,
 *              "timedOut": <boolean> }`, executed under `toolTimeouts.toolResultTimeoutMs`
 * round cap:   HTTP 502, JSON body `error.code == "tool_round_limit"`
 * audit JSONL: one object per line with `tool: string`, `outcome: "ok" | "error" |
 *              "delegated"`, `durationMs: number` (finite, >= 0) and, for failures,
 *              `error: "<code>"`
 * ---------------------------------------------------------------------------
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startExternalLayer } from "../src/external-layer";

const KEY = "sk-w11-server-tools-test-key";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- fixtures

const INSIDE_TEXT = "W11_INSIDE_FIXTURE_CONTENT";
const OUTSIDE_TEXT = "W11_OUTSIDE_SECRET_CONTENT";

/** Every fixture lives under the OS temp dir, never inside the repo. */
const workspaceRoot = mkdtempSync(join(tmpdir(), "w11-workspace-"));
const outsideRoot = mkdtempSync(join(tmpdir(), "w11-outside-"));
writeFileSync(join(workspaceRoot, "inside.txt"), INSIDE_TEXT, "utf-8");
writeFileSync(join(outsideRoot, "secret.txt"), OUTSIDE_TEXT, "utf-8");

/** A 5s sleeper for the run_command budget test; quoted so it also works via a shell. */
const sleepScriptPath = join(workspaceRoot, "sleep-5000.js");
writeFileSync(sleepScriptPath, "setTimeout(() => {}, 5000);\n", "utf-8");

const relativeEscape = join("..", basename(outsideRoot), "secret.txt");
const absoluteEscape = join(outsideRoot, "secret.txt");
const symlinkPath = join(workspaceRoot, "link-to-outside.txt");
let symlinkSupported = true;
try {
  symlinkSync(join(outsideRoot, "secret.txt"), symlinkPath);
} catch {
  // Windows without developer mode refuses symlink creation; the case is skipped below.
  symlinkSupported = false;
}

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

function quotePath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** No metacharacters: valid when run through a shell AND when argv-split by hand. */
const sleepCommand = `${quotePath(process.execPath)} ${quotePath(sleepScriptPath)}`;

// ------------------------------------------------- local config type extension

/** The feature does not exist in `src/` yet, so the config extension is declared locally
 * (never by editing `src/`) and asserted onto the current config type. */
interface ServerToolsConfig {
  enabled: boolean;
  workspaceRoots: string[];
  allowedTools?: string[];
  approvals?: "auto" | "deny";
  auditPath?: string;
  maxRounds?: number;
}

type LayerConfig = Parameters<typeof startExternalLayer>[0];
type W11LayerConfig = LayerConfig & { serverTools?: ServerToolsConfig };

const BASE_CONFIG: Partial<W11LayerConfig> = {
  apiKey: KEY,
  tokenProvider: async () => "tok",
  port: 0,
  // Deterministic: no replay of an earlier identical body, no backoff sleeps, no retries.
  idempotencyTtlMs: 0,
  transientRetryLimit: 1,
  retrySleepMs: 1,
};

async function startLayer(config: Partial<W11LayerConfig> & { upstreamBaseUrl: string }) {
  return startExternalLayer({ ...BASE_CONFIG, ...config } as LayerConfig);
}

const ENVIRONMENT = {
  cwd: workspaceRoot,
  workspaceRoots: [workspaceRoot],
  sandboxMode: "danger-full-access",
};

// ------------------------------------------------------------------ helpers

function messageItem(text: string): Json {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function functionCallItem(name: string, callId: string, args: Json): Json {
  return { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args) };
}

function inputItems(body: Json): Json[] {
  return Array.isArray(body.input) ? (body.input as Json[]) : [];
}

function nativeToolOutputs(body: Json, callId?: string): Json[] {
  return inputItems(body).filter(
    item => item.type === "function_call_output" && (callId === undefined || item.call_id === callId),
  );
}

/** Contract: `function_call_output.output` is either the JSON string or the payload object;
 * parsed it must expose the fields frozen in the header of this file. */
function payloadOf(item: Json | undefined): Json {
  const raw = item?.output;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
    } catch {
      // not JSON: fall through to the plain-text form
    }
    return { content: raw };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Json;
  return {};
}

function assistantText(body: Json): string {
  const output = Array.isArray(body.output) ? (body.output as Json[]) : [];
  return output
    .map(item => {
      if (item.type !== "message") return "";
      const content = item.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return (content as Json[]).map(part => (typeof part.text === "string" ? part.text : "")).join("");
    })
    .join("\n");
}

function outputItems(body: Json): Json[] {
  return Array.isArray(body.output) ? (body.output as Json[]) : [];
}

interface UpstreamStats {
  calls: number;
  bodies: Json[];
  turnIds: string[];
  modelsCalls: number;
}

/** Mock upstream: fixed script, no real network, every native body captured. */
function mockUpstream(answer: (body: Json, call: number) => Response) {
  const stats: UpstreamStats = { calls: 0, bodies: [], turnIds: [], modelsCalls: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        stats.modelsCalls += 1;
        return Response.json({ models: [{ slug: "gpt-6-astra" }, { slug: "gpt-6-mini" }] });
      }
      stats.calls += 1;
      const call = stats.calls;
      const body = (await req.json().catch(() => ({}))) as Json;
      stats.bodies.push(body);
      const meta = (body.client_metadata ?? {}) as Json;
      const turn = (meta["x-codex-turn-metadata"] ?? {}) as Json;
      stats.turnIds.push(String(turn.turn_id ?? ""));
      return answer(body, call);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
    },
    stats,
  };
}

function jsonTurn(id: string, output: unknown[]): Response {
  return Response.json({ id, object: "response", status: "completed", output });
}

/** One upstream SSE turn: created | per-item events | completed | [DONE]. */
function sseTurn(id: string, output: Json[], deltas: string[]): Response {
  const frames: string[] = [];
  frames.push(
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } })}\n\n`,
  );
  output.forEach((item, index) => {
    if (item.type === "function_call") {
      frames.push(
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } })}\n\n`,
      );
      frames.push(
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: item.id, delta: item.arguments })}\n\n`,
      );
      frames.push(
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`,
      );
      return;
    }
    for (const delta of deltas) {
      frames.push(
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`,
      );
    }
  });
  frames.push(
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id, status: "completed", output } })}\n\n`,
  );
  frames.push("data: [DONE]\n\n");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Round 1 answers with the tool call; every later round (the native body already carries a
 * `function_call_output`) answers with the final assistant message. Mirrors whichever
 * upstream mode the layer picked: `stream: true` bodies get SSE, everything else gets JSON.
 */
function toolThenFinalUpstream(script: { name: string; callId: string; args: Json; finalText: string }) {
  return mockUpstream(body => {
    const finished = nativeToolOutputs(body).length > 0;
    const id = finished ? "resp_w11_final" : "resp_w11_tool";
    if (finished) {
      const output = [messageItem(script.finalText)];
      return body.stream === true ? sseTurn(id, output, [script.finalText]) : jsonTurn(id, output);
    }
    const output = [functionCallItem(script.name, script.callId, script.args)];
    return body.stream === true ? sseTurn(id, output, []) : jsonTurn(id, output);
  });
}

function post(layerUrl: string, body: Json = {}): Promise<Response> {
  return fetch(`${layerUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/latest", input: "w11 contract probe", ...body }),
  });
}

/** The audit log may be flushed just after the response; poll briefly instead of guessing.
 * A half-written trailing line is ignored while polling — the strict "every line parses"
 * assertion happens afterwards, on the settled file. */
async function readAuditEntries(path: string, minEntries: number): Promise<Json[]> {
  let entries: Json[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raw = existsSync(path) ? readFileSync(path, "utf-8") : "";
    entries = raw
      .split("\n")
      .filter(line => line.trim().length > 0)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as Json];
        } catch {
          return [];
        }
      });
    if (entries.length >= minEntries) return entries;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return entries;
}

function auditLines(path: string): string[] {
  const raw = existsSync(path) ? readFileSync(path, "utf-8") : "";
  return raw.split("\n").filter(line => line.trim().length > 0);
}

// ------------------------------------------------------------- 1. default off

test("1: with serverTools absent a function_call reaches the client unchanged and nothing runs locally", async () => {
  const marker = join(workspaceRoot, "w11-disabled-marker.txt");
  const readCall = functionCallItem("read_file", "call_w11_off_read", { path: "inside.txt" });
  const runCall = functionCallItem("run_command", "call_w11_off_run", { command: `echo w11 > ${quotePath(marker)}` });
  const up = mockUpstream(() => jsonTurn("resp_w11_off", [readCall, runCall]));
  const layer = await startLayer({ upstreamBaseUrl: up.url, defaultEnvironment: ENVIRONMENT });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(outputItems(body)).toEqual([readCall, runCall]);
    expect(up.stats.calls).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(body)).not.toContain(INSIDE_TEXT);
  } finally {
    await layer.stop();
    up.stop();
  }
});

// -------------------------------------------------- 2. enabled + auto executes

test("2: enabled with approvals auto executes read_file, feeds function_call_output back and loops on a fresh turn identity", async () => {
  const up = toolThenFinalUpstream({
    name: "read_file",
    callId: "call_w11_read",
    args: { path: "inside.txt" },
    finalText: "W11_READ_FINAL",
  });
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], allowedTools: ["read_file"], approvals: "auto" },
  });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;

    expect(up.stats.calls).toBe(2);
    expect(up.stats.turnIds[0]).not.toBe(up.stats.turnIds[1]);
    expect(String(up.stats.turnIds[0]).startsWith("prov-")).toBe(true);
    expect(String(up.stats.turnIds[1]).startsWith("prov-")).toBe(true);

    const roundTwo = nativeToolOutputs(up.stats.bodies[1] ?? {}, "call_w11_read");
    expect(roundTwo.length).toBe(1);
    expect(payloadOf(roundTwo[0]).content).toBe(INSIDE_TEXT);

    // The client only ever sees the final assistant message.
    expect(outputItems(body).some(item => item.type === "function_call")).toBe(false);
    expect(assistantText(body)).toContain("W11_READ_FINAL");
  } finally {
    await layer.stop();
    up.stop();
  }
});

// ------------------------------------------------------------- 3. default deny

test("3: enabled with the default approvals denies execution and hands the function_call back", async () => {
  const call = functionCallItem("read_file", "call_w11_deny", { path: "inside.txt" });
  const up = mockUpstream(() => jsonTurn("resp_w11_deny", [call]));
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], allowedTools: ["read_file"] },
  });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(up.stats.calls).toBe(1);
    expect(outputItems(body)).toEqual([call]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("function_call_output");
    expect(raw).not.toContain(INSIDE_TEXT);
  } finally {
    await layer.stop();
    up.stop();
  }
});

// ------------------------------------------------------- 4. allowedTools gate

test("4: a tool outside allowedTools is never executed, even with approvals auto", async () => {
  const marker = join(workspaceRoot, "w11-not-allowed-marker.txt");
  const call = functionCallItem("run_command", "call_w11_not_allowed", {
    command: `echo w11 > ${quotePath(marker)}`,
  });
  const up = mockUpstream(() => jsonTurn("resp_w11_not_allowed", [call]));
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], approvals: "auto" },
  });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(up.stats.calls).toBe(1);
    expect(outputItems(body)).toEqual([call]);
    expect(existsSync(marker)).toBe(false);
  } finally {
    await layer.stop();
    up.stop();
  }
});

// ------------------------------------------------------- 5. run_command result

test("5: an explicitly allowed run_command executes with exitCode/stdout/stderr/timedOut", async () => {
  const up = toolThenFinalUpstream({
    name: "run_command",
    callId: "call_w11_cmd",
    args: { command: "echo W11_STDOUT_MARKER" },
    finalText: "W11_CMD_FINAL",
  });
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: {
      enabled: true,
      workspaceRoots: [workspaceRoot],
      allowedTools: ["read_file", "run_command"],
      approvals: "auto",
    },
  });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(up.stats.calls).toBe(2);

    const payload = payloadOf(nativeToolOutputs(up.stats.bodies[1] ?? {}, "call_w11_cmd")[0]);
    expect(payload.exitCode).toBe(0);
    expect(String(payload.stdout)).toContain("W11_STDOUT_MARKER");
    expect(typeof payload.stderr).toBe("string");
    expect(payload.timedOut).toBe(false);
    expect(assistantText(body)).toContain("W11_CMD_FINAL");
  } finally {
    await layer.stop();
    up.stop();
  }
});

// ---------------------------------------------------- 6. run_command timeout

test("6: a run_command outliving the toolResult budget comes back timedOut true, fast", async () => {
  const up = toolThenFinalUpstream({
    name: "run_command",
    callId: "call_w11_sleep",
    args: { command: sleepCommand },
    finalText: "W11_TIMEOUT_FINAL",
  });
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    toolTimeouts: { toolResultTimeoutMs: 400 },
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], allowedTools: ["run_command"], approvals: "auto" },
  });
  try {
    const started = Date.now();
    const res = await post(layer.baseUrl);
    const body = (await res.json()) as Json;
    const elapsed = Date.now() - started;

    // The command itself sleeps 5000ms; the budget is 400ms.
    expect(elapsed).toBeLessThan(3000);
    expect(res.status).toBe(200);
    expect(up.stats.calls).toBe(2);
    const payload = payloadOf(nativeToolOutputs(up.stats.bodies[1] ?? {}, "call_w11_sleep")[0]);
    expect(payload.timedOut).toBe(true);
    expect(assistantText(body)).toContain("W11_TIMEOUT_FINAL");
  } finally {
    await layer.stop();
    up.stop();
  }
});

// ----------------------------------------------------- 7+8. workspace boundary

test("7: a relative or absolute read_file escaping workspaceRoots is not read, the model sees path_outside_workspace", async () => {
  const up = mockUpstream(body => {
    if (nativeToolOutputs(body).length > 0) {
      return jsonTurn("resp_w11_escape_final", [messageItem("W11_ESCAPE_FINAL")]);
    }
    const absolute = JSON.stringify(body.input ?? null).includes("w11-escaping-absolute");
    const callId = absolute ? "call_w11_abs" : "call_w11_rel";
    return jsonTurn(`resp_w11_${callId}`, [functionCallItem("read_file", callId, { path: absolute ? absoluteEscape : relativeEscape })]);
  });
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], allowedTools: ["read_file"], approvals: "auto" },
  });
  try {
    // (a) relative traversal ../../<outside-root>/secret.txt
    const relativeRes = await post(layer.baseUrl, { input: "w11-escaping-relative" });
    const relativeText = await relativeRes.text();
    expect(relativeRes.status).toBe(200);
    const relativePayload = payloadOf(nativeToolOutputs(up.stats.bodies[1] ?? {}, "call_w11_rel")[0]);
    expect(relativePayload.error).toBe("path_outside_workspace");
    expect(relativeText).not.toContain(OUTSIDE_TEXT);
    expect(relativeText).toContain("W11_ESCAPE_FINAL");

    // (b) absolute path outside the roots
    const absoluteRes = await post(layer.baseUrl, { input: "w11-escaping-absolute" });
    const absoluteText = await absoluteRes.text();
    expect(absoluteRes.status).toBe(200);
    const absolutePayload = payloadOf(nativeToolOutputs(up.stats.bodies[3] ?? {}, "call_w11_abs")[0]);
    expect(absolutePayload.error).toBe("path_outside_workspace");
    expect(absoluteText).not.toContain(OUTSIDE_TEXT);
    expect(absoluteText).toContain("W11_ESCAPE_FINAL");

    // A tool error is model-visible, never fatal: the loop ran to a final answer twice.
    expect(up.stats.calls).toBe(4);
  } finally {
    await layer.stop();
    up.stop();
  }
});

// ----------------------------------------------------------- 8. symlink escape

const symlinkTitle = "8: a symlink pointing outside the workspace is rejected by the realpath check";
if (symlinkSupported) {
  test(symlinkTitle, async () => {
    const up = toolThenFinalUpstream({
      name: "read_file",
      callId: "call_w11_symlink",
      args: { path: "link-to-outside.txt" },
      finalText: "W11_SYMLINK_FINAL",
    });
    const layer = await startLayer({
      upstreamBaseUrl: up.url,
      defaultEnvironment: ENVIRONMENT,
      serverTools: { enabled: true, workspaceRoots: [workspaceRoot], allowedTools: ["read_file"], approvals: "auto" },
    });
    try {
      const res = await post(layer.baseUrl);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(up.stats.calls).toBe(2);
      const payload = payloadOf(nativeToolOutputs(up.stats.bodies[1] ?? {}, "call_w11_symlink")[0]);
      expect(payload.error).toBe("path_outside_workspace");
      expect(text).not.toContain(OUTSIDE_TEXT);
      expect(text).toContain("W11_SYMLINK_FINAL");
    } finally {
      await layer.stop();
      up.stop();
    }
  });
} else {
  test.skip(`${symlinkTitle} (skipped: symlink creation unavailable on this platform)`, () => {});
}

// --------------------------------------------------------------- 9. round cap

test("9: a runaway loop stops after maxRounds upstream turns with HTTP 502 tool_round_limit", async () => {
  const call = functionCallItem("read_file", "call_w11_runaway", { path: "inside.txt" });
  const up = mockUpstream(() => jsonTurn("resp_w11_runaway", [call]));
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    transientRetryLimit: 1,
    serverTools: {
      enabled: true,
      workspaceRoots: [workspaceRoot],
      allowedTools: ["read_file"],
      approvals: "auto",
      maxRounds: 2,
    },
  });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code?: string; error?: { code?: string } };
    expect(body.code ?? body.error?.code).toBe("tool_round_limit");
    expect(up.stats.calls).toBe(2);
  } finally {
    await layer.stop();
    up.stop();
  }
});

// ------------------------------------------------------------- 10. audit JSONL

test("10: auditPath gets one JSON line per execution and per delegated call", async () => {
  const auditPath = join(workspaceRoot, "w11-audit.jsonl");

  // (a) executed successfully -> outcome "ok"
  const okUp = toolThenFinalUpstream({
    name: "read_file",
    callId: "call_w11_audit_ok",
    args: { path: "inside.txt" },
    finalText: "W11_AUDIT_OK_FINAL",
  });
  const okLayer = await startLayer({
    upstreamBaseUrl: okUp.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: {
      enabled: true,
      workspaceRoots: [workspaceRoot],
      allowedTools: ["read_file"],
      approvals: "auto",
      auditPath,
    },
  });
  try {
    const res = await post(okLayer.baseUrl);
    expect(res.status).toBe(200);
  } finally {
    await okLayer.stop();
    okUp.stop();
  }

  // (b) workspace violation -> outcome "error"
  const errUp = toolThenFinalUpstream({
    name: "read_file",
    callId: "call_w11_audit_err",
    args: { path: relativeEscape },
    finalText: "W11_AUDIT_ERR_FINAL",
  });
  const errLayer = await startLayer({
    upstreamBaseUrl: errUp.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: {
      enabled: true,
      workspaceRoots: [workspaceRoot],
      allowedTools: ["read_file"],
      approvals: "auto",
      auditPath,
    },
  });
  try {
    const res = await post(errLayer.baseUrl);
    expect(res.status).toBe(200);
  } finally {
    await errLayer.stop();
    errUp.stop();
  }

  // (c) handed back to the client -> outcome "delegated"
  const delegatedCall = functionCallItem("read_file", "call_w11_audit_delegated", { path: "inside.txt" });
  const delegatedUp = mockUpstream(() => jsonTurn("resp_w11_audit_delegated", [delegatedCall]));
  const delegatedLayer = await startLayer({
    upstreamBaseUrl: delegatedUp.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], allowedTools: ["read_file"], auditPath },
  });
  try {
    const res = await post(delegatedLayer.baseUrl);
    expect(res.status).toBe(200);
  } finally {
    await delegatedLayer.stop();
    delegatedUp.stop();
  }

  const entries = await readAuditEntries(auditPath, 3);
  expect(entries.length).toBeGreaterThanOrEqual(3);

  const lines = auditLines(auditPath);
  expect(lines.length).toBe(entries.length);
  for (const line of lines) {
    expect(() => JSON.parse(line)).not.toThrow();
  }

  const ok = entries.find(entry => entry.outcome === "ok");
  expect(ok?.tool).toBe("read_file");
  expect(typeof ok?.durationMs).toBe("number");
  expect(Number.isFinite(ok?.durationMs)).toBe(true);
  expect(ok?.durationMs as number).toBeGreaterThanOrEqual(0);

  const error = entries.find(entry => entry.outcome === "error");
  expect(error?.tool).toBe("read_file");
  expect(error?.error).toBe("path_outside_workspace");
  expect(typeof error?.durationMs).toBe("number");

  const delegated = entries.find(entry => entry.outcome === "delegated");
  expect(delegated?.tool).toBe("read_file");
  expect(typeof delegated?.durationMs).toBe("number");
});

// -------------------------------------------------------------- 11. streaming

test("11: streaming with serverTools enabled still yields a well-formed SSE ending with the final text and [DONE]", async () => {
  const up = toolThenFinalUpstream({
    name: "read_file",
    callId: "call_w11_stream",
    args: { path: "inside.txt" },
    finalText: "W11_STREAM_FINAL",
  });
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], allowedTools: ["read_file"], approvals: "auto" },
  });
  try {
    const res = await post(layer.baseUrl, { stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("W11_STREAM_FINAL");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

    expect(up.stats.calls).toBe(2);
    const payload = payloadOf(nativeToolOutputs(up.stats.bodies[1] ?? {}, "call_w11_stream")[0]);
    expect(payload.content).toBe(INSIDE_TEXT);
  } finally {
    await layer.stop();
    up.stop();
  }
});

// --------------------------------------------------- 12. no globalThis patching

test("12: the server-side loop does not patch globalThis", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const namesBefore = Object.getOwnPropertyNames(globalThis);
  const fetchBefore = globals.fetch;
  const processBefore = globals.process;
  const bunBefore = globals.Bun;

  const up = toolThenFinalUpstream({
    name: "read_file",
    callId: "call_w11_globals",
    args: { path: "inside.txt" },
    finalText: "W11_GLOBALS_FINAL",
  });
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], allowedTools: ["read_file"], approvals: "auto" },
  });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(200);
    expect(up.stats.calls).toBe(2);

    expect(globals.fetch).toBe(fetchBefore);
    expect(globals.process).toBe(processBefore);
    expect(globals.Bun).toBe(bunBefore);

    const added = Object.getOwnPropertyNames(globalThis).filter(name => !namesBefore.includes(name));
    expect(added.filter(name => /tool|server|workspace|audit|exec|read_file|command/i.test(name))).toEqual([]);
  } finally {
    await layer.stop();
    up.stop();
  }
});

// -------------------------------------------------------------- 13. /v1/models

test("13: /v1/models is byte-identical with and without serverTools", async () => {
  const plainUp = mockUpstream(() => jsonTurn("resp_w11_models", [messageItem("unused")]));
  const plainLayer = await startLayer({ upstreamBaseUrl: plainUp.url, defaultEnvironment: ENVIRONMENT });
  const toolsUp = mockUpstream(() => jsonTurn("resp_w11_models", [messageItem("unused")]));
  const toolsLayer = await startLayer({
    upstreamBaseUrl: toolsUp.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], allowedTools: ["read_file"], approvals: "auto" },
  });
  const headers = { authorization: `Bearer ${KEY}` };
  try {
    const plainRes = await fetch(`${plainLayer.baseUrl}/v1/models`, { headers });
    const toolsRes = await fetch(`${toolsLayer.baseUrl}/v1/models`, { headers });
    expect(plainRes.status).toBe(200);
    expect(toolsRes.status).toBe(200);

    const plainBody = (await plainRes.json()) as Json;
    const toolsBody = (await toolsRes.json()) as Json;
    expect(toolsBody).toEqual(plainBody);
    expect(JSON.stringify(toolsBody)).toBe(JSON.stringify(plainBody));

    const data = toolsBody.data as Array<{ id: string }>;
    expect(data[0]?.id).toBe("chatgpt-web/latest");
    expect((toolsBody.models as Array<{ slug: string }>)[0]?.slug).toBe("chatgpt-web/latest");
    expect(plainUp.stats.modelsCalls).toBe(1);
    expect(toolsUp.stats.modelsCalls).toBe(1);
  } finally {
    await plainLayer.stop();
    plainUp.stop();
    await toolsLayer.stop();
    toolsUp.stop();
  }
});

// ------------------------------------- 14. the documented defaults are pinned
//
// Mutation gate finding (run-c1d8z7b8): replacing DEFAULT_ALLOWED_TOOLS ["read_file"] with []
// SURVIVED, because every read_file-executing case above passes `allowedTools` explicitly.
// The frozen contract documents the default as ["read_file"], so it must be pinned here too.

test("14: with allowedTools omitted the documented default still executes read_file under approvals auto", async () => {
  const up = toolThenFinalUpstream({
    name: "read_file",
    callId: "call_w11_default_allow",
    args: { path: "inside.txt" },
    finalText: "W11_DEFAULT_ALLOW_FINAL",
  });
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    // No `allowedTools` key on purpose: the default is part of the contract.
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], approvals: "auto" },
  });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;

    // The model got the real file content instead of the call being handed back to the client.
    expect(up.stats.calls).toBe(2);
    const roundTwo = nativeToolOutputs(up.stats.bodies[1] ?? {}, "call_w11_default_allow");
    expect(roundTwo.length).toBe(1);
    expect(payloadOf(roundTwo[0]).content).toBe(INSIDE_TEXT);
    expect(payloadOf(roundTwo[0]).error).toBeUndefined();
    expect(assistantText(body)).toContain("W11_DEFAULT_ALLOW_FINAL");
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("15: the follow-up round carries the function_call item before its function_call_output", async () => {
  const up = toolThenFinalUpstream({
    name: "read_file",
    callId: "call_w11_chain",
    args: { path: "inside.txt" },
    finalText: "W11_CHAIN_FINAL",
  });
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], allowedTools: ["read_file"], approvals: "auto" },
  });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(200);
    expect(up.stats.calls).toBe(2);

    // Real-machine contract (w11 probe 2026-09-11): the upstream pairs a tool result with the
    // browser turn that produced the call THROUGH THE CALL CHAIN in the input. Sending only the
    // function_call_output leaves the parked browser turn unmatched, so the follow-up round never
    // completes. The function_call item must therefore precede its own function_call_output,
    // exactly as the proven leg-2 payload does.
    const items = inputItems(up.stats.bodies[1] ?? {});
    const callIndex = items.findIndex(item => item.type === "function_call" && item.call_id === "call_w11_chain");
    const outputIndex = items.findIndex(item => item.type === "function_call_output" && item.call_id === "call_w11_chain");

    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(outputIndex).toBeGreaterThan(callIndex);
    expect(items[callIndex]?.name).toBe("read_file");
    expect(JSON.parse(String(items[callIndex]?.arguments))).toEqual({ path: "inside.txt" });
    expect(payloadOf(items[outputIndex]).content).toBe(INSIDE_TEXT);
  } finally {
    await layer.stop();
    up.stop();
  }
});

test("16: the follow-up round closes with an authoritative tool-result turn that forbids another call", async () => {
  const up = toolThenFinalUpstream({
    name: "read_file",
    callId: "call_w11_nudge",
    args: { path: "inside.txt" },
    finalText: "W11_NUDGE_FINAL",
  });
  const layer = await startLayer({
    upstreamBaseUrl: up.url,
    defaultEnvironment: ENVIRONMENT,
    serverTools: { enabled: true, workspaceRoots: [workspaceRoot], allowedTools: ["read_file"], approvals: "auto" },
  });
  try {
    const res = await post(layer.baseUrl);
    expect(res.status).toBe(200);
    expect(up.stats.calls).toBe(2);

    // Real-machine contract (w11 probe 2026-09-11): the follow-up round opens a FRESH browser turn
    // that still carries the original "call the tool first" instruction, so without a closing
    // user turn the model re-calls the tool, the page parks and the turn is aborted. The chain must
    // therefore end with the authoritative-result nudge.
    const items = inputItems(up.stats.bodies[1] ?? {});
    const last = items[items.length - 1];
    expect(last?.type).toBe("message");
    expect(last?.role).toBe("user");
    const text = JSON.stringify(last?.content ?? "");
    expect(text).toContain("authoritative");
    expect(text.toLowerCase()).toContain("do not call the tool again");
    expect(items.findIndex(item => item.type === "function_call_output")).toBeLessThan(items.length - 1);
  } finally {
    await layer.stop();
    up.stop();
  }
});
