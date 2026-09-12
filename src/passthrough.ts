export function isPassthroughRoute(method: string, pathname: string): boolean {
  return (
    (method === "POST" && pathname === "/v1/responses/compact") ||
    (method === "GET" && pathname === "/v1/responses") ||
    (method === "POST" && pathname === "/v1/alpha/search")
  );
}

export interface ForwardPassthroughOptions {
  req: Request;
  url: URL;
  apiKey: string;
  upstreamBaseUrl: string;
  tokenProvider: () => Promise<string>;
  onUpstreamError?: (detail: string) => void;
  bearerMatches: (header: string | null, apiKey: string) => boolean;
  unauthorized: () => Response;
}

export async function forwardPassthroughRequest(options: ForwardPassthroughOptions): Promise<Response> {
  const { req, url, apiKey, upstreamBaseUrl, tokenProvider, onUpstreamError, bearerMatches, unauthorized } = options;

  if (!bearerMatches(req.headers.get("authorization"), apiKey)) {
    return unauthorized();
  }

  let token: string;
  try {
    token = await tokenProvider();
  } catch {
    onUpstreamError?.("credential unavailable");
    return Response.json(
      { error: { message: "ChatGPT credential unavailable", type: "authentication_error", code: "credential_unavailable" } },
      { status: 401 },
    );
  }

  const rawBody = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();

  const forwardedHeaders = new Headers();
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "host" || lower === "content-length") {
      continue;
    }
    forwardedHeaders.set(key, value);
  }
  forwardedHeaders.set("authorization", `Bearer ${token}`);

  const upstreamBase = upstreamBaseUrl.replace(/\/+$/, "");
  const targetUrl = `${upstreamBase}${url.pathname}${url.search}`;

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: forwardedHeaders,
      body: rawBody,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "upstream unreachable";
    onUpstreamError?.(detail);
    return Response.json(
      {
        error: {
          message: `ChatGPT Web upstream is unreachable: ${detail}`,
          type: "server_error",
          code: "upstream_unreachable",
        },
      },
      { status: 502 },
    );
  }

  const upstreamBody = await upstreamRes.text();
  const responseHeaders = new Headers();
  for (const [key, value] of upstreamRes.headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === "content-encoding" ||
      lower === "content-length" ||
      lower === "transfer-encoding" ||
      lower === "x-ext-layer-replay" ||
      lower === "x-ext-layer-conversation"
    ) {
      continue;
    }
    responseHeaders.set(key, value);
  }

  return new Response(upstreamBody, {
    status: upstreamRes.status,
    headers: responseHeaders,
  });
}
