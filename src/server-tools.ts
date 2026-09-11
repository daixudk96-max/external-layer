import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

export interface ServerToolsConfig {
  enabled: boolean;
  workspaceRoots: string[];
  allowedTools?: string[];
  approvals?: "auto" | "deny";
  auditPath?: string;
  maxRounds?: number;
}

export const DEFAULT_ALLOWED_TOOLS = ["read_file"];
export const DEFAULT_APPROVALS = "deny" as const;
export const DEFAULT_MAX_ROUNDS = 8;

export interface ToolExecutionResult {
  outcome: "ok" | "error" | "delegated";
  payload?: Record<string, unknown>;
  errorCode?: string;
  durationMs: number;
}

export function recordAudit(
  auditPath: string | undefined,
  entry: {
    tool: string;
    outcome: "ok" | "error" | "delegated";
    durationMs: number;
    error?: string;
  },
): void {
  if (!auditPath) return;
  try {
    const dir = dirname(auditPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const record = {
      ts: new Date().toISOString(),
      tool: entry.tool,
      outcome: entry.outcome,
      durationMs: Number.isFinite(entry.durationMs) && entry.durationMs >= 0 ? entry.durationMs : 0,
      ...(entry.error ? { error: entry.error } : {}),
    };
    appendFileSync(auditPath, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // 审计写入异常不阻塞主流程
  }
}

export function isSubpath(parent: string, child: string): boolean {
  let p = resolve(parent);
  let c = resolve(child);
  if (process.platform === "win32") {
    p = p.toLowerCase();
    c = c.toLowerCase();
  }
  const rel = relative(p, c);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function checkPathInRoots(candidatePath: string, roots: string[]): boolean {
  return roots.some(root => isSubpath(root, candidatePath));
}

function checkRealpathInRoots(realPath: string, roots: string[]): boolean {
  return roots.some(root => {
    try {
      const realRoot = realpathSync(root);
      return isSubpath(realRoot, realPath);
    } catch {
      return isSubpath(root, realPath);
    }
  });
}

function parseArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

export async function executeReadFile(
  rawArgs: unknown,
  workspaceRoots: string[],
): Promise<ToolExecutionResult> {
  const args = parseArgs(rawArgs);
  const targetPathStr = typeof args.path === "string" ? args.path : undefined;
  if (!targetPathStr) {
    return {
      outcome: "error",
      payload: { error: "file_not_found" },
      errorCode: "file_not_found",
      durationMs: 0,
    };
  }

  const primaryRoot = workspaceRoots[0] ? resolve(workspaceRoots[0]) : process.cwd();
  const candidatePath = isAbsolute(targetPathStr)
    ? resolve(targetPathStr)
    : resolve(primaryRoot, targetPathStr);

  // 1. 语法越界检查
  if (!checkPathInRoots(candidatePath, workspaceRoots)) {
    return {
      outcome: "error",
      payload: { error: "path_outside_workspace" },
      errorCode: "path_outside_workspace",
      durationMs: 0,
    };
  }

  // 2. 文件存在性检查
  if (!existsSync(candidatePath)) {
    return {
      outcome: "error",
      payload: { error: "file_not_found" },
      errorCode: "file_not_found",
      durationMs: 0,
    };
  }

  // 3. realpath 越界检查（符号链接逃逸保护）
  let realPath: string;
  try {
    realPath = realpathSync(candidatePath);
  } catch {
    return {
      outcome: "error",
      payload: { error: "file_not_found" },
      errorCode: "file_not_found",
      durationMs: 0,
    };
  }

  if (!checkRealpathInRoots(realPath, workspaceRoots)) {
    return {
      outcome: "error",
      payload: { error: "path_outside_workspace" },
      errorCode: "path_outside_workspace",
      durationMs: 0,
    };
  }

  // 4. 普通文件检查
  let stat;
  try {
    stat = statSync(realPath);
  } catch {
    return {
      outcome: "error",
      payload: { error: "file_not_found" },
      errorCode: "file_not_found",
      durationMs: 0,
    };
  }

  if (!stat.isFile()) {
    return {
      outcome: "error",
      payload: { error: "not_a_file" },
      errorCode: "not_a_file",
      durationMs: 0,
    };
  }

  // 5. 读取内容（保证错误时内容绝不泄露）
  try {
    const content = readFileSync(realPath, "utf-8");
    return {
      outcome: "ok",
      payload: { content },
      durationMs: 0,
    };
  } catch {
    return {
      outcome: "error",
      payload: { error: "file_not_found" },
      errorCode: "file_not_found",
      durationMs: 0,
    };
  }
}

export async function executeRunCommand(
  rawArgs: unknown,
  workspaceRoots: string[],
  timeoutMs: number,
): Promise<ToolExecutionResult> {
  const args = parseArgs(rawArgs);
  const command = typeof args.command === "string" ? args.command : undefined;
  if (!command) {
    return {
      outcome: "error",
      payload: { exitCode: 1, stdout: "", stderr: "missing command", timedOut: false },
      errorCode: "missing_command",
      durationMs: 0,
    };
  }

  const cwd = workspaceRoots[0] ? resolve(workspaceRoots[0]) : process.cwd();
  const isWin = process.platform === "win32";

  return new Promise<ToolExecutionResult>((resolvePromise) => {
    let child;
    if (isWin) {
      child = spawn("cmd.exe", ["/c", command], {
        cwd,
        windowsHide: true,
      });
    } else {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
      });
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout?.on("data", chunk => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString("utf-8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (isWin && child.pid) {
        try {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } catch {}
      }
      try {
        child.kill("SIGKILL");
      } catch {}

      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolvePromise({
            outcome: "ok",
            payload: {
              exitCode: child.exitCode ?? 1,
              stdout,
              stderr,
              timedOut: true,
            },
            durationMs: 0,
          });
        }
      }, 100);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolvePromise({
        outcome: "ok",
        payload: {
          exitCode: code ?? (timedOut ? 1 : 0),
          stdout,
          stderr,
          timedOut,
        },
        durationMs: 0,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolvePromise({
        outcome: "error",
        payload: {
          exitCode: 1,
          stdout,
          stderr: err.message,
          timedOut: false,
        },
        errorCode: err.message,
        durationMs: 0,
      });
    });
  });
}

export async function executeServerTool(
  toolName: string,
  rawArgs: unknown,
  config: {
    workspaceRoots: string[];
    toolResultTimeoutMs: number;
    auditPath?: string;
  },
): Promise<ToolExecutionResult> {
  const started = Date.now();
  let result: ToolExecutionResult;

  if (toolName === "read_file") {
    result = await executeReadFile(rawArgs, config.workspaceRoots);
  } else if (toolName === "run_command") {
    result = await executeRunCommand(rawArgs, config.workspaceRoots, config.toolResultTimeoutMs);
  } else {
    result = {
      outcome: "error",
      payload: { error: "unsupported_tool" },
      errorCode: "unsupported_tool",
      durationMs: 0,
    };
  }

  const durationMs = Math.max(0, Date.now() - started);
  result.durationMs = durationMs;

  recordAudit(config.auditPath, {
    tool: toolName,
    outcome: result.outcome,
    durationMs,
    error: result.errorCode,
  });

  return result;
}

export interface ParsedSseResult {
  functionCalls: Array<{ callId: string; name: string; args: unknown }>;
  finalText: string;
  rawText: string;
}

export async function parseSseStream(stream: ReadableStream<Uint8Array>): Promise<ParsedSseResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let rawText = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      rawText += decoder.decode(value, { stream: true });
    }
  }
  rawText += decoder.decode();

  const functionCalls: Array<{ callId: string; name: string; args: unknown }> = [];
  let finalText = "";

  const lines = rawText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (dataStr === "[DONE]") continue;

    try {
      const data = JSON.parse(dataStr);
      if (!data || typeof data !== "object") continue;

      if (data.type === "response.completed" && data.response && Array.isArray(data.response.output)) {
        for (const item of data.response.output) {
          if (item && item.type === "function_call") {
            const callId = item.call_id ?? item.id;
            const name = item.name;
            const args = item.arguments;
            if (callId && name && !functionCalls.some(fc => fc.callId === callId)) {
              functionCalls.push({ callId, name, args });
            }
          }
        }
      } else if (data.type === "response.output_item.done" && data.item && data.item.type === "function_call") {
        const item = data.item;
        const callId = item.call_id ?? item.id;
        const name = item.name;
        const args = item.arguments;
        if (callId && name && !functionCalls.some(fc => fc.callId === callId)) {
          functionCalls.push({ callId, name, args });
        }
      } else if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
        finalText += data.delta;
      }
    } catch {
      // 忽略
    }
  }

  return { functionCalls, finalText, rawText };
}
