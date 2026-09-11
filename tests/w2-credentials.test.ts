import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTokenProvider, resolveChatGptAccessToken } from "../src/credentials";

function jwtWithExp(expMs: number): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: Math.floor(expMs / 1000) })}.sig`;
}

function authFile(tokens: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "extlayer-auth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ auth_mode: "chatgpt", tokens, last_refresh: new Date().toISOString(), ...extra }));
  return path;
}

test("a fresh token is returned untouched", async () => {
  const path = authFile({ access_token: jwtWithExp(Date.now() + 3_600_000), refresh_token: "r1", account_id: "acc" });
  const result = await resolveChatGptAccessToken({ authJsonPath: path });
  expect(result.refreshed).toBe(false);
  expect(result.token.startsWith("eyJ")).toBe(true);
});

test("an expired token is refreshed and persisted", async () => {
  const path = authFile({ access_token: jwtWithExp(Date.now() - 60_000), refresh_token: "refresh-old", account_id: "acc" }, { keep_me: 7 });
  const fetchImpl = (async () => Response.json({ access_token: jwtWithExp(Date.now() + 3_600_000), refresh_token: "refresh-new" })) as unknown as typeof fetch;
  const result = await resolveChatGptAccessToken({ authJsonPath: path, fetchImpl });
  expect(result.refreshed).toBe(true);
  const persisted = JSON.parse(readFileSync(path, "utf8")) as { keep_me?: number; tokens?: { refresh_token?: string } };
  expect(persisted.keep_me).toBe(7);
  expect(persisted.tokens?.refresh_token).toBe("refresh-new");
});

test("a refresh failure throws instead of using a stale token", async () => {
  const path = authFile({ access_token: jwtWithExp(Date.now() - 60_000), refresh_token: "refresh-old", account_id: "acc" });
  const fetchImpl = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
  await expect(resolveChatGptAccessToken({ authJsonPath: path, fetchImpl })).rejects.toThrow();
});

test("the provider survives one 401 by refreshing once", async () => {
  const path = authFile({ access_token: jwtWithExp(Date.now() - 60_000), refresh_token: "r", account_id: "acc" });
  let refreshed = 0;
  const fetchImpl = (async () => { refreshed += 1; return Response.json({ access_token: jwtWithExp(Date.now() + 3_600_000), refresh_token: "r2" }); }) as unknown as typeof fetch;
  const token = await createTokenProvider({ authJsonPath: path, fetchImpl })();
  expect(typeof token).toBe("string");
  expect(refreshed).toBe(1);
});
