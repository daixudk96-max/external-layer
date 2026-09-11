/**
 * W16 canonical contract — the context-window truth must be one command away, and no document
 * may hand-fill the numbers again.
 *
 * Why: today three disagreeing numbers coexist (the client hard-codes 333579 in its own settings,
 * the facade advertised 272000 inherited from a native row, the upstream ChatGPT-web rows said
 * 333579/285000). A doc that prints its own table recreates exactly that failure the next time the
 * deployment switch flips, so numbers may appear only as explicitly marked EXAMPLES and the
 * operator-facing answer must be "ask the facade".
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DOC_PATH = join(ROOT, "docs/context-windows.md");
const CMD_PATH = join(ROOT, "scripts/show-context.cmd");

function readOrFail(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`expected ${path} to exist and be readable: ${String(error)}`);
  }
}

/** Bare hand-filled windows (the ones that went stale in production). */
const HAND_FILLED = /\b(111[_,]?193|333[_,]?579|336[_,]?579|285[_,]?000|272[_,]?000|872[_,]?000|112[_,]?193|95[_,]?000)\b/g;

test("E1 the operator doc names the live sources of the numbers, not its own table", () => {
  const doc = readOrFail(DOC_PATH);
  expect(doc.length).toBeGreaterThan(1_200);
  for (const required of [
    "/v1/context",
    "experimentalBiggerContext",
    "--bigger-context",
    "--standard-context",
    "manual",
    "context_window",
    "max_context_window",
    "auto_compact_token_limit",
    "effective_context_window_percent",
  ]) {
    expect(doc).toContain(required);
  }
  // The per-tier difference is the part operators get wrong: the doc must say the windows differ
  // by tier, and point at the upstream rows as the authority.
  expect(doc).toMatch(/per[- ]tier|each tier|档位/);
  expect(doc).toMatch(/chatgpt-web\/(light|pro)/);
});

test("E2 every hard number in the doc is marked as an example, never presented as a constant", () => {
  const doc = readOrFail(DOC_PATH);
  const offenders: string[] = [];
  for (const line of doc.split(/\r?\n/)) {
    const hits = line.match(HAND_FILLED);
    if (!hits) continue;
    if (/example|示例|例如/i.test(line)) continue;
    offenders.push(line.trim());
  }
  expect(offenders).toEqual([]);
});

test("E3 the operator helper is a runnable Windows script with no baked-in window", () => {
  const cmd = readOrFail(CMD_PATH);
  // `.cmd` files must stay pure ASCII: a stray non-ASCII byte makes cmd.exe read the file in the
  // OEM code page and mangle the commands.
  expect(cmd).toMatch(/^[\x00-\x7F]*$/);
  expect(cmd).toContain("\r\n");
  expect(cmd).toContain("17843");
  expect(cmd).toContain("/v1/context");
  expect(cmd).toMatch(/EXT_LAYER_API_KEY|sk-dsh-web-/);
  expect(cmd.match(HAND_FILLED)).toBeNull();
});
