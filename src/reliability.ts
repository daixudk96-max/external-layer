/**
 * W4 可靠性层：瞬时错误识别、带退避的重试、空回合判定。
 *
 * 设计红线（与 wave-brief 一致）：
 * - 只对瞬时错误族重试；非瞬时错误立即抛出，绝不吞掉。
 * - 重试预算耗尽后抛出「最后一次」错误（原对象原样抛出），绝不伪造成功。
 * - completed 但没有任何输出的回合必须可被判定为 empty，供上层转成可重试错误。
 */

/** 瞬时错误族：上游（codex-chatgpt-web / ChatGPT 后端）可安全重试的错误文本特征。 */
const TRANSIENT_ERROR_PATTERNS: readonly string[] = [
  "something went wrong",
  "stopped responding",
  "server_is_overloaded",
  "session inspection timed out",
];

/** 退避基数：2s * attempt（attempt 为 1 基的第几次尝试）。 */
const BACKOFF_BASE_MS = 2000;

/** 默认 sleep：真实等待（测试可注入）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 从任意抛出物中抽取可读文本（message 可能是 string / Error / 嵌套对象）。 */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    const nested = record.error;
    if (nested !== null && typeof nested === "object") {
      const nestedMessage = (nested as Record<string, unknown>).message;
      if (typeof nestedMessage === "string") return nestedMessage;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * 判定一条错误消息是否属于瞬时错误族（大小写不敏感的子串匹配）。
 *
 * 覆盖：'Something went wrong' / 'stopped responding' / 'server_is_overloaded' /
 * 'session inspection timed out'。
 */
export function isTransientError(message: string): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  const haystack = message.toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => haystack.includes(pattern));
}

export interface TransientRetryOptions {
  /** 总尝试次数（>=1）；attempt 从 1 开始计数。 */
  limit: number;
  /** 注入式 sleep，默认真实 setTimeout；每次重试前以 2000 * attempt 毫秒调用。 */
  sleep?: (ms: number) => Promise<void>;
  /** 每次决定重试时回调（attempt = 失败的那次尝试，message = 错误文本，error = 原始抛出错误）。 */
  onRetry?: (attempt: number, message: string, error?: unknown) => void;
  /** 额外的可重试判定：返回 true 即视为可重试（与瞬时错误族取并集）。 */
  isRetryable?: (error: unknown) => boolean;
}

/**
 * 按 attempt=1..limit 调用 task，仅对可重试错误（瞬时错误族，或 isRetryable 判定为 true）
 * 进行退避重试；不可重试错误立即抛出；预算耗尽则抛出最后一次错误。
 */
export async function withTransientRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: TransientRetryOptions,
): Promise<T> {
  const rawLimit = options.limit;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 1;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      const message = errorText(error);
      const retryable = isTransientError(message) || options.isRetryable?.(error) === true;
      const exhausted = attempt >= limit;
      if (!retryable || exhausted) {
        // 非瞬时错误立即抛出；预算耗尽抛出最后一次错误（绝不伪造成功）。
        throw error;
      }
      options.onRetry?.(attempt, message, error);
      await sleep(BACKOFF_BASE_MS * attempt);
    }
  }
  /* istanbul ignore next -- limit>=1 时循环必然返回或抛出；仅为类型完备保留。 */
  throw lastError;
}

export interface EmptyCompletionVerdict {
  /** true 表示「看起来已完成、但实际什么都没产出」的回合，上层必须转成可重试错误。 */
  empty: boolean;
  /** 判定依据（便于日志与上层构造错误消息）。 */
  reason?: string;
}

/** 会把 turn 变成「有工具调用」的 output 项类型。 */
const TOOL_CALL_TYPES: readonly string[] = [
  "function_call",
  "tool_call",
  "custom_tool_call",
  "local_shell_call",
  "computer_call",
  "mcp_call",
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 从 output 项里抽取助手可见文本。 */
function textFromItem(item: Record<string, unknown>): string {
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "output_text" || type === "text") {
    return typeof item.text === "string" ? item.text : "";
  }
  if (type === "message" || type === "assistant_message") {
    const content = item.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          const record = asRecord(part);
          if (record === undefined) return "";
          const partType = typeof record.type === "string" ? record.type : "";
          if (partType === "output_text" || partType === "text" || partType === "input_text") {
            return typeof record.text === "string" ? record.text : "";
          }
          return typeof record.text === "string" ? record.text : "";
        })
        .join("");
    }
    return typeof item.text === "string" ? item.text : "";
  }
  return typeof item.text === "string" ? item.text : "";
}

function isToolCallItem(item: Record<string, unknown>): boolean {
  const type = typeof item.type === "string" ? item.type : "";
  if (TOOL_CALL_TYPES.includes(type)) return true;
  if (type.includes("call") && type !== "call") return true;
  return false;
}

/**
 * 判定一个上游响应是否是「completed 但空输出」的回合：
 * status=completed 且 output 为空且没有工具调用 → empty=true。
 *
 * 非 completed 状态、或无法识别的形状 → empty=false（交由上层按其自身状态处理），
 * 判定结果绝不允许被当作成功回给客户端。
 */
export function classifyEmptyCompletion(response: unknown): EmptyCompletionVerdict {
  let root = asRecord(response);
  if (root === undefined) {
    return { empty: false, reason: "response is not an object; nothing to classify" };
  }
  // 兼容 { response: { status, output } } 这种外层包裹形状。
  if (typeof root.status !== "string") {
    const nested = asRecord(root.response);
    if (nested !== undefined && typeof nested.status === "string") {
      root = nested;
    }
  }

  const status = typeof root.status === "string" ? root.status.trim().toLowerCase() : undefined;
  if (status !== "completed") {
    return {
      empty: false,
      reason: status === undefined ? "response has no status field" : `status is '${status}', not completed`,
    };
  }

  const output = root.output;
  const items: unknown[] = Array.isArray(output) ? output : output === undefined || output === null ? [] : [output];

  let text = "";
  let toolCalls = 0;
  for (const item of items) {
    const record = asRecord(item);
    if (record === undefined) {
      if (typeof item === "string") text += item;
      continue;
    }
    if (isToolCallItem(record)) {
      toolCalls += 1;
      continue;
    }
    text += textFromItem(record);
  }

  if (text.trim().length === 0 && typeof root.output_text === "string") {
    text = root.output_text;
  }

  if (toolCalls > 0) {
    return { empty: false, reason: "completed turn requested tool calls" };
  }
  if (text.trim().length > 0) {
    return { empty: false, reason: "completed turn produced assistant output" };
  }
  return {
    empty: true,
    reason: "completed turn produced no output and no tool calls",
  };
}
