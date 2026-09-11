import { randomUUID, timingSafeEqual } from "node:crypto";
import { unifiedCatalog } from "./models";

/** External layer: a standard Responses API facade in front of the original codex-chatgpt-web upstream.
 * The upstream expects Codex-native requests authenticated with a ChatGPT OAuth bearer; this layer
 * owns the client-facing apiKey contract, the synthetic turn identity, and the response relay. */
export interface ExternalLayerConfig {
  apiKey: string;
  upstreamBaseUrl: string;
  tokenProvider: () => Promise<string>;
  port?: number;
  /** Account capability flags used to fold the upstream catalog into the unified model. */
  solAvailable?: boolean;
  proAvailable?: boolean;
}

export interface ExternalLayerHandle {
  baseUrl: string;
  stop: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unauthorized(): Response {
  return Response.json(
    { error: { message: "Incorrect API key provided", type: "authentication_error", code: "invalid_api_key" } },
    { status: 401 },
  );
}

function bearerMatches(header: string | null, apiKey: string): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${apiKey}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Canonicalize the standard Responses `input` into Codex-native message items. */
function normalizeInput(input: unknown): Record<string, unknown>[] {
  if (Array.isArray(input)) {
    return input.map(item => {
      if (!isRecord(item)) {
        return { type: "message", role: "user", content: [{ type: "input_text", text: String(item ?? "") }] };
      }
      // Standard clients may legally omit `type`; a role-carrying item is a message.
      if (item.type === "message" || (item.type === undefined && typeof item.role === "string")) {
        const content = typeof item.content === "string"
          ? [{ type: "input_text", text: item.content }]
          : Array.isArray(item.content) ? item.content : [];
        return { ...item, type: "message", content };
      }
      return item;
    });
  }
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: typeof input === "string" ? input : JSON.stringify(input ?? "") }],
  }];
}

/** Translate a standard request into the upstream's Codex-native shape, minting a synthetic identity. */
export function toNativeRequest(standard: Record<string, unknown>): Record<string, unknown> {
  const turnId = `prov-${randomUUID()}`;
  const threadId = `prov-${randomUUID()}`;
  const items = normalizeInput(standard.input);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.role !== "user") continue;
    const existing = isRecord(item.internal_chat_message_metadata_passthrough)
      ? item.internal_chat_message_metadata_passthrough
      : {};
    item.internal_chat_message_metadata_passthrough = { ...existing, thread_id: threadId, turn_id: turnId };
    break;
  }
  const metadata = isRecord(standard.client_metadata) ? standard.client_metadata : {};
  const turnMetadata = isRecord(metadata["x-codex-turn-metadata"]) ? metadata["x-codex-turn-metadata"] : {};
  return {
    ...standard,
    input: items,
    client_metadata: {
      ...metadata,
      "x-codex-turn-metadata": { ...turnMetadata, thread_id: threadId, turn_id: turnId },
    },
  };
}

export async function startExternalLayer(config: ExternalLayerConfig): Promise<ExternalLayerHandle> {
  let requests = 0;
  let lastError: string | undefined;
  const upstreamBase = config.upstreamBaseUrl.replace(/\/+$/, "");
  const server = Bun.serve({
    port: config.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (!bearerMatches(req.headers.get("authorization"), config.apiKey)) return unauthorized();
        requests += 1;
        let standard: Record<string, unknown>;
        try {
          standard = await req.json() as Record<string, unknown>;
        } catch {
          return Response.json({ error: { message: "ChatGPT Web facade requires a JSON request body" } }, { status: 400 });
        }
        let token: string;
        try {
          token = await config.tokenProvider();
        } catch {
          lastError = "credential unavailable";
          return Response.json(
            { error: { message: "ChatGPT credential unavailable", type: "authentication_error", code: "credential_unavailable" } },
            { status: 401 },
          );
        }
        const native = toNativeRequest(standard);
        let upstream: Response;
        try {
          upstream = await fetch(`${upstreamBase}/v1/responses`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": req.headers.get("content-type") ?? "application/json",
            },
            body: JSON.stringify(native),
          });
        } catch (error) {
          lastError = error instanceof Error ? error.message : "upstream unreachable";
          return Response.json(
            { error: { message: `ChatGPT Web upstream is unreachable: ${lastError}`, type: "server_error", code: "upstream_unreachable" } },
            { status: 502 },
          );
        }
        const body = await upstream.text();
        const contentType = upstream.headers.get("content-type") ?? "application/json";
        if (!upstream.ok) {
          // Fail closed: the upstream's own failure is surfaced verbatim, never reshaped into success.
          lastError = `upstream ${upstream.status}`;
          return new Response(body, { status: upstream.status, headers: { "content-type": contentType } });
        }
        return new Response(body, { status: upstream.status, headers: { "content-type": contentType } });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (!bearerMatches(req.headers.get("authorization"), config.apiKey)) return unauthorized();
        let token: string;
        try {
          token = await config.tokenProvider();
        } catch {
          lastError = "credential unavailable";
          return Response.json(
            { error: { message: "ChatGPT credential unavailable", type: "authentication_error", code: "credential_unavailable" } },
            { status: 401 },
          );
        }
        const upstream = await fetch(`${upstreamBase}/v1/models?client_version=0.0.0`, {
          headers: { authorization: `Bearer ${token}` },
        }).catch(() => undefined);
        if (!upstream || !upstream.ok) {
          lastError = `upstream models ${upstream?.status ?? "unreachable"}`;
          return Response.json(
            { error: { message: `ChatGPT Web model catalog is unavailable (${lastError})`, type: "server_error", code: "upstream_unreachable" } },
            { status: 502 },
          );
        }
        const upstreamCatalog = await upstream.json().catch(() => undefined);
        const catalog = unifiedCatalog(upstreamCatalog, {
          solAvailable: config.solAvailable ?? true,
          proAvailable: config.proAvailable ?? true,
        });
        return Response.json(catalog);
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ status: lastError ? "degraded" : "ok", requests, ...(lastError ? { last_error: lastError } : {}) });
      }
      return Response.json({ error: { message: `Unsupported route: ${req.method} ${url.pathname}` } }, { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      server.stop(true);
    },
  };
}
