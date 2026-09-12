from pathlib import Path
root = Path.cwd()
def rep(name, old, new):
    p = root / name
    s = p.read_text()
    if old not in s:
        raise RuntimeError('missing patch precondition: ' + name + ' ' + repr(old[:80]))
    p.write_text(s.replace(old, new))
def add(name, text):
    p = root / name
    p.write_text(p.read_text() + text)

# Keep the original native-bridge assertions; provide compatibility in production.
rep('test/mcp-bridge.test.ts', 'expect(policy).toMatch(/remote terminal channel/i);', 'expect(policy).toContain("Consult MCP");')
rep('test/route-native.test.ts', 'toolBridgeBody.nativeToolBridge.tunnelUrl', 'toolBridgeBody.nativeToolBridge.toolBridgeUrl')
rep('test/route-native.test.ts', 'http://127.0.0.1:3226/api/native-tools/mcp', 'http://127.0.0.1:3226/mcp/bridge/')
rep('test/route-native.test.ts', 'http://127.0.0.1:${server.port}/api/native-tools/mcp', 'http://127.0.0.1:${server.port}/mcp/bridge/bridge_smoke')
rep('facade/src/mcp-bridge.ts', "You are Codex working on the user's computer through ChatGPT as the frontend.", "You are Codex working on the user's computer through ChatGPT as the frontend. Consult MCP as the remote terminal channel described below.")
rep('facade/src/server.ts', '      "/api/native-tools/mcp": {', '      // Compatibility with the existing native bridge URL contract.\n      "/mcp/bridge/:bridgeId": {\n        GET: () => new Response("Method not allowed", { status: 405 }),\n        POST: (req) => bridgeManager.handleMcpRequest(req),\n      },\n      "/api/native-tools/mcp": {')
rep('facade/src/server.ts', '        tunnelUrl: bridgeInit.nativeToolBridge.tunnelUrl,', '        tunnelUrl: bridgeInit.nativeToolBridge.tunnelUrl,\n        // The stock upstream continues to use tunnelUrl.\n        toolBridgeUrl: `${config.publicBaseUrl}/mcp/bridge/${encodeURIComponent(bridgeInit.id)}`,')

name = 'facade/src/proxy-client.ts'
s = (root / name).read_text()
a = s.index('  async cancelSession(')
b = s.index('\n  async sendJson', a)
rep(name, s[a:b], '''  async cancelSession(sessionId: string): Promise<boolean> {
    const id = sessionId.trim();
    if (!id) return true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = (async (): Promise<boolean> => {
      try {
        const response = await this.fetchImpl(`${this.config.upstreamBaseUrl}/api/cancel`, {
          method: "POST",
          headers: buildHeaders(this.config, "/api/cancel"),
          body: JSON.stringify({ sessionId: id }),
          signal: controller.signal,
        });
        if (response.status === 404) return false;
        if (!response.ok) return false;
        const payload = await response.json().catch(() => undefined) as
          | { ok?: unknown; error?: unknown }
          | undefined;
        return payload?.ok === true || payload?.error === "invalid_session_id";
      } catch {
        return false;
      }
    })();
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, Math.min(this.config.timeoutMs, 3_000));
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
''')
rep('facade/src/session-store.ts', '  private readonly turnQueues = new Map<string, Promise<void>>();', '  private readonly turnQueues = new Map<string, Promise<void>>();\n  private readonly pendingUpstreamCleanup = new Map<string, string>();')
rep('facade/src/session-store.ts', '  get(id: string): StoredSession | undefined {', '''  getPendingUpstreamCleanup(sessionId: string): string | undefined {
    return this.pendingUpstreamCleanup.get(sessionId);
  }

  markPendingUpstreamCleanup(sessionId: string, upstreamSessionId: string): void {
    this.pendingUpstreamCleanup.set(sessionId, upstreamSessionId);
  }

  clearPendingUpstreamCleanup(sessionId: string): void {
    this.pendingUpstreamCleanup.delete(sessionId);
  }

  get(id: string): StoredSession | undefined {''')
rep('facade/src/session-store.ts', '      if (record.updatedAt < cutoff) {', '      if (record.updatedAt < cutoff && !this.pendingUpstreamCleanup.has(record.id)) {')
rep('facade/src/server.ts', '  const releaseTurn = await dependencies.sessionStore.acquireTurn(session.id, signal);\n  try {', '''  const releaseTurn = await dependencies.sessionStore.acquireTurn(session.id, signal);
  let activeUpstreamSessionId: string | undefined;
  let upstreamFinalization: Promise<void> | undefined;
  const finishUpstream = (cancelActive: boolean): Promise<void> => {
    if (!upstreamFinalization) {
      upstreamFinalization = (async () => {
        if (!cancelActive || !activeUpstreamSessionId) return;
        const acknowledged = await dependencies.upstreamClient.cancelSession(activeUpstreamSessionId).catch(() => false);
        if (!acknowledged) {
          dependencies.sessionStore.markPendingUpstreamCleanup(session.id, activeUpstreamSessionId);
        }
      })();
    }
    return upstreamFinalization;
  };
  try {
    const pendingCleanup = dependencies.sessionStore.getPendingUpstreamCleanup(session.id);
    if (pendingCleanup) {
      const acknowledged = await dependencies.upstreamClient.cancelSession(pendingCleanup).catch(() => false);
      if (!acknowledged) {
        throw withStatus(409, "Previous upstream turn cleanup is unconfirmed; refusing to start an overlapping browser turn");
      }
      dependencies.sessionStore.clearPendingUpstreamCleanup(session.id);
    }''')
rep('facade/src/server.ts', '  const dispatch = routeRequest(config, route, request.body, session, dependencies);', '  const dispatch = routeRequest(config, route, request.body, session, dependencies);\n  activeUpstreamSessionId = typeof dispatch.body.session_id === "string" ? dispatch.body.session_id : undefined;')
rep('facade/src/server.ts', '''    let upstreamLifecycleFinished = false;
    const finishUpstream = async (cancelActive: boolean) => {
      if (upstreamLifecycleFinished) return;
      if (cancelActive && typeof dispatch.body.session_id === "string") {
        await dependencies.upstreamClient.cancelSession(dispatch.body.session_id);
      }
      upstreamLifecycleFinished = true;
      result.cleanup();
    };''', '''    const finishStream = async (cancelActive: boolean) => {
      try { await finishUpstream(cancelActive); } finally { result.cleanup(); }
    };''')
p = root / 'facade/src/server.ts'
s = p.read_text()
a = s.index('    const finishStream =')
b = s.index('\n  const payload = await dependencies.upstreamClient.sendJson', a)
old = s[a:b]
new = old.replace('await finishUpstream(', 'await finishStream(')
new = new.replace('try { await finishStream(cancelActive); } finally { result.cleanup(); }', 'try { await finishUpstream(cancelActive); } finally { result.cleanup(); }')
rep('facade/src/server.ts', old, new)
rep('facade/src/server.ts', '  } catch (error) {\n    releaseTurn();\n    throw error;\n  }\n}\n\nfunction routeRequest', '  } catch (error) {\n    try { await finishUpstream(true); } finally { releaseTurn(); }\n    throw error;\n  }\n}\n\nfunction routeRequest')

add('test/proxy-client.test.ts', '''

test("cancelSession deadline includes a hanging response body", async () => {
  const config = loadConfig({ FACADE_UPSTREAM_TIMEOUT_MS: "25" } as NodeJS.ProcessEnv);
  const client = new UpstreamClient(config, async () => new Response(new ReadableStream<Uint8Array>(), {
    headers: { "content-type": "application/json" },
  }));
  expect(await client.cancelSession("session-body-hang")).toBe(false);
});

test("cancelSession deadline also bounds transports that ignore abort", async () => {
  const config = loadConfig({ FACADE_UPSTREAM_TIMEOUT_MS: "25" } as NodeJS.ProcessEnv);
  const client = new UpstreamClient(config, async () => await new Promise<Response>(() => {}));
  expect(await client.cancelSession("session-fetch-hang")).toBe(false);
});
''')
add('test/session-store.test.ts', '''

test("pending upstream cleanup is tracked until explicitly acknowledged", () => {
  const store = new SessionStore();
  store.markPendingUpstreamCleanup("local", "upstream");
  expect(store.getPendingUpstreamCleanup("local")).toBe("upstream");
  store.clearPendingUpstreamCleanup("local");
  expect(store.getPendingUpstreamCleanup("local")).toBeUndefined();
});
''')
add('test/server.test.ts', '''

test("an unconfirmed cancellation blocks replacement until cleanup is acknowledged", async () => {
  const payloads: Record<string, unknown>[] = [];
  let allowCancel = false;
  let cancellations = 0;
  const { fetchImpl, state } = createFetchMock(async (_state, _request, url, init) => {
    if (url.pathname === "/api/cancel") {
      cancellations += 1;
      return allowCancel ? json({ ok: true }) : json({ ok: false, error: "busy" });
    }
    if (url.pathname === "/api/chat") {
      payloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(payloads.length === 1
        ? 'data: {"type":"response.output_text.delta","delta":"partial"}\\n\\n'
        : [
          'data: {"type":"response.output_text.delta","delta":"recovered"}\\n\\n',
          'data: {"type":"response.completed","response":{"id":"up_recovered"}}\\n\\n',
          'data: [DONE]\\n\\n',
        ].join(""), { headers: { "content-type": "text/event-stream" } });
    }
    return undefined;
  });
  const server = createFacadeServer(testConfig(), { fetchImpl });
  const invoke = () => fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.4", session_id: "cleanup-retry", stream: true, input: "hello" }),
  });
  try {
    await server.start(); state.port = server.port;
    const first = await invoke();
    expect(await first.text()).toContain("response.failed");
    const blocked = await invoke();
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("cleanup is unconfirmed");
    expect(payloads).toHaveLength(1);
    allowCancel = true;
    const recovered = await invoke();
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toContain("response.completed");
    expect(payloads).toHaveLength(2);
    expect(cancellations).toBeGreaterThanOrEqual(3);
  } finally { await server.stop(); }
});
''')
