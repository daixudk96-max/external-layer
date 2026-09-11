/**
 * w5-tools :: chat-completions compatibility surface.
 *
 * Two-way translation between the OpenAI /v1/chat/completions dialect and the
 * Responses dialect used by the external layer, so non-Responses clients keep
 * working: roles, text content, tool definitions, tool calls and tool outputs
 * all survive the round trip.
 */

import { randomUUID } from "node:crypto";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickString(source: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function pickNumber(source: JsonObject, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Render a Responses `arguments` field (string or object) as a JSON string. */
function normalizeArguments(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined || args === null) return "{}";
  try {
    return JSON.stringify(args) ?? "{}";
  } catch {
    return "{}";
  }
}

/** Render a chat message content value as a plain string (tool outputs). */
function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const rawPart of content) {
      const part = asObject(rawPart);
      if (!part) {
        if (typeof rawPart === "string") parts.push(rawPart);
        continue;
      }
      const text = asString(part.text);
      if (text !== undefined) parts.push(text);
    }
    return parts.join("");
  }
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return String(content);
  }
}

function mapUsage(usage: unknown): JsonObject | undefined {
  const source = asObject(usage);
  if (!source) return undefined;
  const prompt = pickNumber(source, "input_tokens", "prompt_tokens") ?? 0;
  const completion = pickNumber(source, "output_tokens", "completion_tokens") ?? 0;
  const total = pickNumber(source, "total_tokens") ?? prompt + completion;
  const mapped: JsonObject = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
  const promptDetails = source.input_tokens_details ?? source.prompt_tokens_details;
  if (promptDetails !== undefined) mapped.prompt_tokens_details = promptDetails;
  const completionDetails = source.output_tokens_details ?? source.completion_tokens_details;
  if (completionDetails !== undefined) mapped.completion_tokens_details = completionDetails;
  return mapped;
}

function finishReasonFor(status: string | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  if (status === "incomplete") return "length";
  if (status === "failed" || status === "cancelled") return "stop";
  return "stop";
}

function newCompletionId(): string {
  return `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Responses response -> chat-completions response.
 * Text parts become `message.content`; `function_call` items become
 * `message.tool_calls`; usage is remapped to prompt/completion vocabulary.
 */
export function responsesToChatCompletions(response: unknown, model: string): Record<string, unknown> {
  const source = asObject(response) ?? {};
  const output = asArray(source.output);

  const textParts: string[] = [];
  const toolCalls: JsonObject[] = [];
  let role = "assistant";
  let reasoningText = "";

  const pushTextItem = (value: unknown): void => {
    const text = asString(value);
    if (text !== undefined && text !== "") textParts.push(text);
  };

  const collectMessage = (item: JsonObject): void => {
    const itemRole = asString(item.role);
    if (itemRole) role = itemRole;
    const own = asString(source.output_text);
    if (own && output.length === 1) pushTextItem(own);
    if (typeof item.content === "string") {
      pushTextItem(item.content);
      return;
    }
    for (const rawPart of asArray(item.content)) {
      if (typeof rawPart === "string") {
        pushTextItem(rawPart);
        continue;
      }
      const part = asObject(rawPart);
      if (!part) continue;
      const partType = asString(part.type) ?? "";
      if (partType === "output_text" || partType === "input_text" || partType === "text") {
        pushTextItem(part.text);
      } else if (partType === "refusal") {
        pushTextItem(part.refusal);
      }
    }
  };

  const collectFunctionCall = (item: JsonObject): void => {
    const call: JsonObject = {
      id: pickString(item, "call_id", "id") ?? `call_${toolCalls.length}`,
      type: "function",
      function: {
        name: asString(item.name) ?? "",
        arguments: normalizeArguments(item.arguments ?? item.args),
      },
    };
    toolCalls.push(call);
  };

  const collectReasoning = (item: JsonObject): void => {
    for (const rawPart of asArray(item.summary)) {
      const part = asObject(rawPart);
      const text = part ? asString(part.text) : asString(rawPart);
      if (text) reasoningText += text;
    }
    const content = asString(item.content);
    if (content) reasoningText += content;
  };

  for (const rawItem of output) {
    const item = asObject(rawItem);
    if (!item) continue;
    const type = asString(item.type) ?? "";
    if (type === "message") collectMessage(item);
    else if (type === "function_call") collectFunctionCall(item);
    else if (type === "reasoning") collectReasoning(item);
  }

  // Convenience field some upstream responses expose at the top level.
  if (textParts.length === 0) pushTextItem(source.output_text);

  const message: JsonObject = { role, content: textParts.length > 0 ? textParts.join("") : null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoningText) message.reasoning_content = reasoningText;

  const status = asString(source.status);
  const created = pickNumber(source, "created_at", "created");
  const usage = mapUsage(source.usage);

  const chat: JsonObject = {
    id: pickString(source, "id") ?? newCompletionId(),
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model: pickString(source, "model") ?? model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReasonFor(status, toolCalls.length > 0),
        logprobs: null,
      },
    ],
  };
  if (usage) chat.usage = usage;
  return chat;
}

/** Responses `input` part for a chat role. */
function contentPartTypeFor(role: string): string {
  return role === "assistant" ? "output_text" : "input_text";
}

function normalizeChatContent(content: unknown, role: string): JsonObject[] {
  const partType = contentPartTypeFor(role);
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: partType, text: content }];
  }
  const parts: JsonObject[] = [];
  for (const rawPart of asArray(content)) {
    if (typeof rawPart === "string") {
      parts.push({ type: partType, text: rawPart });
      continue;
    }
    const part = asObject(rawPart);
    if (!part) continue;
    const type = asString(part.type) ?? "";
    if (type === "text" || type === "input_text" || type === "output_text") {
      parts.push({ type: partType, text: asString(part.text) ?? "" });
    } else if (type === "image_url") {
      const image = part.image_url;
      const url = asString(image) ?? asString(asObject(image)?.url) ?? "";
      parts.push({ type: "input_image", image_url: url });
    } else if (type === "input_image") {
      parts.push({ type: "input_image", image_url: part.image_url });
    }
  }
  return parts;
}

function convertTools(tools: unknown): JsonObject[] {
  const converted: JsonObject[] = [];
  for (const rawTool of asArray(tools)) {
    const tool = asObject(rawTool);
    if (!tool) continue;
    const type = asString(tool.type) ?? "function";
    if (type !== "function") {
      converted.push({ ...tool });
      continue;
    }
    const nested = asObject(tool.function);
    if (!nested) {
      // Already in Responses shape: { type: "function", name, parameters }.
      converted.push({ ...tool });
      continue;
    }
    const mapped: JsonObject = { type: "function", name: asString(nested.name) ?? "" };
    if (nested.description !== undefined) mapped.description = nested.description;
    mapped.parameters = nested.parameters ?? { type: "object", properties: {} };
    if (nested.strict !== undefined) mapped.strict = nested.strict;
    converted.push(mapped);
  }
  return converted;
}

function convertToolChoice(choice: unknown): unknown {
  if (typeof choice === "string") return choice;
  const source = asObject(choice);
  if (!source) return choice;
  const type = asString(source.type);
  if (type === "function") {
    const nested = asObject(source.function);
    const name = asString(nested?.name) ?? asString(source.name);
    return name ? { type: "function", name } : { type: "function" };
  }
  return { ...source };
}

/**
 * Chat-completions request body -> Responses request body.
 * `messages` become Responses `input` items (messages plus function_call /
 * function_call_output items), tools are flattened to the Responses shape, and
 * sampling knobs are renamed.
 */
export function chatCompletionsToResponses(body: unknown): Record<string, unknown> {
  const source = asObject(body) ?? {};
  const input: JsonObject[] = [];

  for (const rawMessage of asArray(source.messages)) {
    const message = asObject(rawMessage);
    if (!message) continue;
    const role = asString(message.role) ?? "user";

    if (role === "tool" || role === "function") {
      const callId = pickString(message, "tool_call_id", "call_id", "name") ?? "call_unknown";
      input.push({ type: "function_call_output", call_id: callId, output: stringifyContent(message.content) });
      continue;
    }

    const parts = normalizeChatContent(message.content, role);
    if (parts.length > 0) {
      const item: JsonObject = { type: "message", role, content: parts };
      if (role === "assistant") item.status = "completed";
      if (message.name !== undefined) item.name = message.name;
      input.push(item);
    }

    if (role === "assistant") {
      for (const rawCall of asArray(message.tool_calls)) {
        const call = asObject(rawCall);
        if (!call) continue;
        const nested = asObject(call.function);
        input.push({
          type: "function_call",
          call_id: pickString(call, "id", "call_id") ?? `call_${input.length}`,
          name: asString(nested?.name) ?? asString(call.name) ?? "",
          arguments: normalizeArguments(nested?.arguments ?? call.arguments ?? call.args),
        });
      }
    }
  }

  const result: JsonObject = { model: asString(source.model) ?? "", input };

  const instructions = asString(source.instructions);
  if (instructions !== undefined) result.instructions = instructions;

  if (source.tools !== undefined) result.tools = convertTools(source.tools);
  if (source.tool_choice !== undefined) result.tool_choice = convertToolChoice(source.tool_choice);
  if (source.parallel_tool_calls !== undefined) result.parallel_tool_calls = source.parallel_tool_calls;

  const maxOutput = pickNumber(source, "max_output_tokens", "max_completion_tokens", "max_tokens");
  if (maxOutput !== undefined) result.max_output_tokens = maxOutput;
  if (source.temperature !== undefined) result.temperature = source.temperature;
  if (source.top_p !== undefined) result.top_p = source.top_p;
  if (source.stream !== undefined) result.stream = source.stream;
  if (source.metadata !== undefined) result.metadata = source.metadata;
  if (source.user !== undefined) result.user = source.user;
  if (source.reasoning_effort !== undefined) result.reasoning = { effort: source.reasoning_effort };

  return result;
}

/**
 * Incrementally translate an upstream Responses SSE byte stream into
 * an OpenAI chat.completion.chunk SSE byte stream.
 */
export function transformResponsesStreamToChatStream(
  upstreamStream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const reader = upstreamStream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let hasToolCalls = false;
  let doneSent = false;
  let errorSent = false;

  function emitError(
    controller: ReadableStreamDefaultController<Uint8Array>,
    message: string,
  ) {
    if (errorSent) return;
    errorSent = true;
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`));
  }

  function emitChunk(
    controller: ReadableStreamDefaultController<Uint8Array>,
    choices: unknown[],
    usage?: unknown,
  ) {
    const chunk: Record<string, unknown> = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices,
    };
    if (usage) {
      chunk.usage = mapUsage(usage) ?? usage;
    }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }

  function handleData(controller: ReadableStreamDefaultController<Uint8Array>, dataStr: string) {
    const currentEvent = eventName;
    eventName = "";

    if (dataStr.trim() === "[DONE]") {
      if (!doneSent) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        doneSent = true;
      }
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      return;
    }

    const type = typeof parsed.type === "string" ? parsed.type : currentEvent;

    if (type === "response.created") {
      const resp = asObject(parsed.response);
      if (resp && typeof resp.id === "string") {
        completionId = `chatcmpl-${resp.id}`;
      }
      emitChunk(controller, [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        },
      ]);
    } else if (type === "response.output_text.delta") {
      const delta = typeof parsed.delta === "string" ? parsed.delta : "";
      emitChunk(controller, [
        {
          index: 0,
          delta: { content: delta },
          finish_reason: null,
        },
      ]);
    } else if (type === "response.output_item.added") {
      const item = asObject(parsed.item);
      if (item && item.type === "function_call") {
        hasToolCalls = true;
        const callId = String(item.call_id ?? item.id ?? "call_0");
        const name = String(item.name ?? "");
        const args = String(item.arguments ?? "");
        emitChunk(controller, [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: "function",
                  function: { name, arguments: args },
                },
              ],
            },
            finish_reason: null,
          },
        ]);
      }
    } else if (type === "response.function_call_arguments.delta") {
      hasToolCalls = true;
      const delta = String(parsed.delta ?? "");
      emitChunk(controller, [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: delta },
              },
            ],
          },
          finish_reason: null,
        },
      ]);
    } else if (type === "response.heartbeat") {
      // A heartbeat carries no payload, but it must still produce bytes: a chat stream that goes
      // silent for the server's idle window is closed mid-turn (observed at ~10s on the real
      // upstream, whose heartbeats arrive every ~1s while it thinks).
      controller.enqueue(encoder.encode(": keep-alive\n\n"));
    } else if (type === "response.failed" || type === "error" || type === "response.incomplete") {
      // The web turn can end in an upstream-side failure AFTER the stream has started.
      // Surface it as a chat error frame instead of closing the connection mid-flight.
      const resp = asObject(parsed.response);
      const failure = asObject(parsed.error) ?? asObject(resp?.error);
      const message = typeof failure?.message === "string"
        ? failure.message
        : typeof parsed.message === "string"
          ? parsed.message
          : `ChatGPT Web turn ended as ${type}`;
      emitError(controller, message);
    } else if (type === "response.completed") {
      const resp = asObject(parsed.response);
      const usage = resp?.usage;
      emitChunk(
        controller,
        [
          {
            index: 0,
            delta: {},
            finish_reason: hasToolCalls ? "tool_calls" : "stop",
          },
        ],
        usage,
      );
    }
  }

  function processLines(
    controller: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ) {
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (let line of lines) {
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.startsWith("event: ")) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        handleData(controller, line.slice(6));
      }
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.length > 0) {
              processLines(controller, "\n");
            }
            if (!doneSent) {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              doneSent = true;
            }
            controller.close();
            break;
          }
          if (value) {
            const chunkText = decoder.decode(value, { stream: true });
            processLines(controller, chunkText);
          }
        }
      } catch (err) {
        // The upstream connection died mid-stream. The status line is already committed, so a
        // stream that has NOT terminated yet ends with an explicit error frame plus the terminal
        // marker; a truncation a client cannot distinguish from a complete turn is the one
        // outcome worth avoiding. A break AFTER the upstream's own [DONE] is logged only —
        // the client already saw a terminated turn.
        const message = `ChatGPT Web upstream stream failed: ${err instanceof Error ? err.message : String(err)}`;
        console.warn(`[external-layer] ${message}`);
        if (!doneSent) {
          emitError(controller, message);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          doneSent = true;
        }
        controller.close();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

