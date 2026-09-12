import { expect, test } from "bun:test";
import { startExternalLayer } from "../src/external-layer";
import {
  DEFAULT_STALL_TIMEOUT_SEC,
  MAX_STALL_TIMEOUT_SEC,
  resolveStallTimeoutSec,
} from "../src/stall-timeout";
import {
  CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS,
  DEFAULT_TOOL_GENERATION_TIMEOUT_MS,
  DEFAULT_TOOL_QUEUE_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUTS,
  jobTimeoutMsFor,
  resolveToolTimeouts,
} from "../src/tool-timeouts";

const KEY = "sk-w10-timeouts-test-key";

// ============================================================================
// A1: 契约函数断言
// ============================================================================
test("A1: resolveStallTimeoutSec contract matches expectations", () => {
  expect(DEFAULT_STALL_TIMEOUT_SEC).toBe(300);
  expect(MAX_STALL_TIMEOUT_SEC).toBe(3600);

  expect(resolveStallTimeoutSec(undefined)).toBe(300);
  expect(resolveStallTimeoutSec(0)).toBe(1);
  expect(resolveStallTimeoutSec(0.4)).toBe(1);
  expect(resolveStallTimeoutSec(3600)).toBe(3600);
  expect(resolveStallTimeoutSec(99999)).toBe(3600);
  expect(resolveStallTimeoutSec(NaN)).toBe(300);
  expect(resolveStallTimeoutSec(Infinity)).toBe(300);
});

// ============================================================================
// A2: 工具超时契约断言
// ============================================================================
test("A2: tool timeouts contract, derivation, and startup rejection", async () => {
  expect(DEFAULT_TOOL_TIMEOUTS.queueTimeoutMs).toBe(60_000);
  expect(DEFAULT_TOOL_TIMEOUTS.generationTimeoutMs).toBe(300_000);
  expect(DEFAULT_TOOL_TIMEOUTS.toolResultTimeoutMs).toBe(90_000);
  expect(DEFAULT_TOOL_QUEUE_TIMEOUT_MS).toBe(60_000);
  expect(DEFAULT_TOOL_GENERATION_TIMEOUT_MS).toBe(300_000);
  expect(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS).toBe(90_000);

  // resolveToolTimeouts undefined 返回默认
  const def = resolveToolTimeouts(undefined, "cfg");
  expect(def).toEqual(DEFAULT_TOOL_TIMEOUTS);

  // 部分覆盖只改该字段
  const partial = resolveToolTimeouts({ queueTimeoutMs: 12_345 }, "cfg");
  expect(partial.queueTimeoutMs).toBe(12_345);
  expect(partial.generationTimeoutMs).toBe(300_000);
  expect(partial.toolResultTimeoutMs).toBe(90_000);

  // 非整数或非法值抛错且 message 包含特定前缀
  expect(() => resolveToolTimeouts({ generationTimeoutMs: 1.5 }, "cfg")).toThrow(
    "Invalid toolTimeouts.generationTimeoutMs in cfg",
  );
  expect(() => resolveToolTimeouts("invalid" as any, "cfg")).toThrow(
    "Invalid toolTimeouts in cfg",
  );

  // jobTimeoutMsFor = toolResultTimeoutMs * 10
  expect(jobTimeoutMsFor(90_000)).toBe(900_000);

  // startExternalLayer 在启动时拒绝非法 toolTimeouts
  await expect(
    startExternalLayer({
      apiKey: KEY,
      upstreamBaseUrl: "http://127.0.0.1:1",
      tokenProvider: async () => "tok",
      toolTimeouts: { generationTimeoutMs: -1 },
    }),
  ).rejects.toThrow("Invalid toolTimeouts.generationTimeoutMs in external layer config");
});

// ============================================================================
// A3: 首字节停滞 → HTTP 504（耗时 < 3s）
// ============================================================================
test("A3: first byte stall surfaces as HTTP 504 with upstream_stall_timeout", async () => {
  const upstream = Bun.serve({
    port: 0,
    async fetch() {
      // 永远不返回响应头，挂住连接
      await new Promise(() => {});
      return new Response("unreachable");
    },
  });

  const layer = await startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    tokenProvider: async () => "tok",
    port: 0,
    firstByteTimeoutMs: 300,
    transientRetryLimit: 1,
    retrySleepMs: 1,
  });

  try {
    const started = Date.now();
    const res = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "chatgpt-web/latest", input: "hello" }),
    });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(504);
    const body = (await res.json()) as { code?: string; error?: { code?: string; message?: string } };
    expect(body.code ?? body.error?.code).toBe("upstream_stall_timeout");
    expect(body.error?.message).toContain("300ms");
    expect(elapsed).toBeLessThan(3000);
  } finally {
    await layer.stop();
    upstream.stop(true);
  }
});

// ============================================================================
// A4: 首字节停滞可重试且换新身份
// ============================================================================
test("A4: first byte stall is retried with fresh prov-* turn identity and then succeeds", async () => {
  let calls = 0;
  const turnIds: string[] = [];

  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      calls += 1;
      const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, any>;
      const turnId = body.client_metadata?.["x-codex-turn-metadata"]?.turn_id;
      turnIds.push(String(turnId ?? ""));

      if (calls === 1) {
        // 第一次沉默超过 300ms 预算
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return Response.json({ ok: false }, { status: 500 });
      }

      // 第二次正常返回 200
      return Response.json({
        id: "resp_ok",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "SUCCESS_PONG" }],
          },
        ],
      });
    },
  });

  const layer = await startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    tokenProvider: async () => "tok",
    port: 0,
    firstByteTimeoutMs: 300,
    transientRetryLimit: 3,
    retrySleepMs: 1,
  });

  try {
    const res = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "chatgpt-web/latest", input: "say PONG" }),
    });

    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(turnIds.length).toBe(2);
    expect(turnIds[0]).not.toBe(turnIds[1]);
    expect(turnIds[0]?.startsWith("prov-")).toBe(true);
    expect(turnIds[1]?.startsWith("prov-")).toBe(true);
  } finally {
    await layer.stop();
    upstream.stop(true);
  }
});

// ============================================================================
// A5: 流内静默 → 不挂死且不入幂等
// ============================================================================
test("A5: mid-stream silence terminates without hanging and does not poison idempotency", async () => {
  let calls = 0;

  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      // AMENDED 2026-09-12 (wave w22-interrupt-on-stall): a stalled turn is now also cancelled
      // through the upstream admin route. That cancel is not a generation call, so it must not
      // be counted here — the assertions below are about generation attempts reaching upstream.
      if (new URL(req.url).pathname === "/admin/interrupt-turn") {
        return Response.json({ ok: true });
      }
      calls += 1;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(
            encoder.encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_mid","status":"in_progress"}}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"PARTIAL_DATA"}\n\n',
            ),
          );
          // 停止写入并保持连接挂住
          await new Promise(() => {});
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const layer = await startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    tokenProvider: async () => "tok",
    port: 0,
    stallTimeoutSec: 1,
    transientRetryLimit: 1,
    retrySleepMs: 1,
  });

  try {
    const started = Date.now();
    const res1 = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "chatgpt-web/latest", stream: true, input: "same body test" }),
    });

    expect(res1.status).toBe(200);
    const reader = res1.body?.getReader();
    expect(reader).toBeDefined();

    let text1 = "";
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader!.read();
      if (done) break;
      text1 += decoder.decode(value, { stream: true });
    }
    const elapsed = Date.now() - started;

    // 客户端在 < 4s 内读到终止，不挂死
    expect(elapsed).toBeLessThan(4000);
    expect(text1).toContain("PARTIAL_DATA");
    // 包含错误/incomplete帧或者[DONE]
    expect(text1).toContain("data: [DONE]");

    // 证明上一回合没有被当作成功回放：用同一 body 再次请求，上游必须被再次调用
    const res2 = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "chatgpt-web/latest", stream: true, input: "same body test" }),
    });

    // 验证第二次请求穿透到了上游
    expect(calls).toBe(2);
    // 取消第二次响应体流，避免资源挂住
    await res2.body?.cancel();
  } finally {
    await layer.stop();
    upstream.stop(true);
  }
});

// ============================================================================
// A6: 正常长回合不被误杀
// ============================================================================
test("A6: normal paced turn is not killed by stall watchdog", async () => {
  const frames = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_norm","status":"in_progress"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"A"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"B"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"C"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_norm","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ABC"}]}]}}\n\n',
    "data: [DONE]\n\n",
  ];

  const upstream = Bun.serve({
    port: 0,
    async fetch() {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          for (let i = 0; i < frames.length; i += 1) {
            if (i > 0) await new Promise((r) => setTimeout(r, 200));
            controller.enqueue(encoder.encode(frames[i]));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const layer = await startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    tokenProvider: async () => "tok",
    port: 0,
    stallTimeoutSec: 1, // 1s 预算，每 200ms 一帧，总 ~800ms
  });

  try {
    const res = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "chatgpt-web/latest", stream: true, input: "paced turn" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain('"delta":"A"');
    expect(text).toContain('"delta":"B"');
    expect(text).toContain('"delta":"C"');
    expect(text).toContain("response.completed");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(text).not.toContain('"type":"error"');
    expect(text).not.toContain("upstream_stall_timeout");
  } finally {
    await layer.stop();
    upstream.stop(true);
  }
});

// ============================================================================
// A7: 非流式回归
// ============================================================================
test("A7: standard non-streaming turn succeeds normally without stall", async () => {
  const upstream = Bun.serve({
    port: 0,
    async fetch() {
      return Response.json({
        id: "resp_non_stream",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "NON_STREAM_PONG" }],
          },
        ],
      });
    },
  });

  const layer = await startExternalLayer({
    apiKey: KEY,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    tokenProvider: async () => "tok",
    port: 0,
    firstByteTimeoutMs: 2000,
    stallTimeoutSec: 5,
  });

  try {
    const res = await fetch(`${layer.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "chatgpt-web/latest", input: "non-streaming request" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe("resp_non_stream");
    expect(body.status).toBe("completed");
    expect(body.output[0].content[0].text).toBe("NON_STREAM_PONG");
  } finally {
    await layer.stop();
    upstream.stop(true);
  }
});
