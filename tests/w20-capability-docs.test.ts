/**
 * W20 canonical contract — the account-capability documentation and the client's last-mile helper.
 *
 * Why: a window number printed in prose outlives the deployment that produced it. Three
 * disagreeing numbers already shipped at once (the client hard-coded 333579 in its own settings,
 * the facade advertised 272000 inherited from a native row, the upstream ChatGPT-web rows said
 * 333579/285000), and the number is BOTH account-dependent (Sol / Pro / Plus / Luna) and
 * 3x-switch-dependent (`experimentalBiggerContext`). So prose must stay number-free and point at
 * the live `GET /v1/context` instead — via `scripts/show-context.cmd` or `scripts/dsh-models.cmd`.
 *
 * What is frozen here:
 *  - E1 `docs/context-windows.md` documents the new account capability surface (per-tier table,
 *    `account: {solAvailable, proAvailable, source}`, the `upstream-config` source and the
 *    `tier_unavailable` / `conflicting_tier` failure modes) with no placeholder text.
 *  - E2 no hard-coded window number appears in prose unless that exact line is marked as an
 *    example (`example` / `示例` / `例如`).
 *  - E3 `scripts/dsh-models.cmd` exists as pure-ASCII CRLF, holds no baked-in window, and is
 *    honest enough to be pasted into a client config (it names `contextWindow`).
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** The external-layer repo root (this file lives in `tests/`). */
const ROOT = join(import.meta.dir, "..");
/** The shared workspace root (`external-layer/..`) that carries the operator-facing endpoint docs. */
const WORKSPACE = join(ROOT, "..");
const DOC_PATH = join(ROOT, "docs/context-windows.md");
/** In-repo copy wins; the shared workspace copy is the fallback, because the guide predates this repo. */
const GUIDE_CANDIDATES = [
  join(ROOT, "docs/dsh-endpoint-guide.md"),
  join(WORKSPACE, "docs/dsh-endpoint-guide.md"),
];
const CMD_CANDIDATES = [
  join(ROOT, "scripts/dsh-models.cmd"),
  join(WORKSPACE, "scripts/dsh-models.cmd"),
];

/** Windows that are account- and 3x-switch-dependent: freezing one into prose is the bug. */
const BANNED_WINDOWS = [
  "111193", "333579", "112193", "336579", "95000", "285000", "272000", "872000", "41000", "90000",
];
/** Accepts the `,` and `_` spellings of the same number (e.g. `333,579`, `333_579`, `333579`). */
const BANNED_WINDOW_SOURCE = `\\b(${BANNED_WINDOWS.map(n => `${n.slice(0, -3)}[_,]?${n.slice(-3)}`).join("|")})\\b`;
const EXAMPLE_MARKER = /example|示例|例如/i;
const PLACEHOLDERS = ["TODO", "TBD", "待定", "XXX"];

function readOrFail(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`expected ${path} to exist and be readable: ${String(error)}`);
  }
}

/** First existing candidate wins; nothing anywhere is a hard failure, never a skip. */
function readFirstOrFail(candidates: string[]): { path: string; text: string } {
  const path = candidates.find(candidate => existsSync(candidate));
  if (!path) throw new Error(`expected one of these paths to exist: ${candidates.join(", ")}`);
  return { path, text: readOrFail(path) };
}

/** Workspace-relative, forward-slashed path so an offender is greppable and unambiguous. */
function repoPath(path: string): string {
  return relative(WORKSPACE, path).replaceAll("\\", "/");
}

function windowHits(line: string): string[] {
  return line.match(new RegExp(BANNED_WINDOW_SOURCE, "g")) ?? [];
}

/** `"<path>:<line>: <trimmed line>"` for every banned window that is not an explicitly-marked example. */
function windowOffenders(path: string, text: string): string[] {
  const offenders: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (windowHits(line).length === 0) continue;
    if (EXAMPLE_MARKER.test(line)) continue;
    offenders.push(`${repoPath(path)}:${index + 1}: ${line.trim()}`);
  }
  return offenders;
}

test("E1 the capability doc covers the account surface, every tier, and every account shape", () => {
  const doc = readOrFail(DOC_PATH);
  expect(doc.length).toBeGreaterThan(1_200);
  for (const required of [
    "/v1/context",
    "account",
    "solAvailable",
    "proAvailable",
    "source",
    "upstream-config",
    "tier_unavailable",
    "conflicting_tier",
    "config.json",
  ]) {
    expect(doc).toContain(required);
  }
  // The per-tier difference and the account shapes are the two parts operators get wrong.
  expect(doc).toMatch(/chatgpt-web\/(light|medium|high|extra-high|pro)/);
  for (const tier of ["light", "medium", "high", "extra-high", "pro"]) {
    expect(doc).toContain(tier);
  }
  expect(doc).toMatch(/Pro|Plus|Luna/);
  for (const placeholder of PLACEHOLDERS) {
    expect(doc).not.toContain(placeholder);
  }
});

test("E2 no hard-coded window in prose unless the line is explicitly an example", () => {
  const offenders = windowOffenders(DOC_PATH, readOrFail(DOC_PATH));
  const guide = readFirstOrFail(GUIDE_CANDIDATES);
  offenders.push(...windowOffenders(guide.path, guide.text));
  expect(offenders).toEqual([]);
});

test("E3 scripts/dsh-models.cmd is the client's last mile and bakes in no window", () => {
  const resolved = readFirstOrFail(CMD_CANDIDATES);
  const cmd = resolved.text;
  // `.cmd` files must stay pure ASCII: a stray non-ASCII byte makes cmd.exe read the file in the
  // OEM code page and mangle the commands.
  expect(cmd).toMatch(/^[\x00-\x7F]*$/);
  expect(cmd).toContain("\r\n");
  expect(cmd).toContain("17843");
  expect(cmd).toContain("/v1/context");
  expect(cmd).toMatch(/EXT_LAYER_API_KEY/);
  // Honest for a user who must paste the value into a client config: it names the field it fills.
  expect(cmd).toContain("contextWindow");
  expect(windowOffenders(resolved.path, cmd)).toEqual([]);
  for (const placeholder of ["TODO", "TBD", "待定"]) {
    expect(cmd).not.toContain(placeholder);
  }
});
