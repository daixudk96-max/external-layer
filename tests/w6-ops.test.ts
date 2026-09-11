import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeHealth } from "../src/health";

test("health is ok after a clean start and degraded after a failure", () => {
  const clean = describeHealth({ upstreamBaseUrl: "http://127.0.0.1:17842", startedAt: Date.now() - 5_000, requests: 3 });
  expect(clean.status).toBe("ok");
  expect(clean.requests).toBe(3);
  const degraded = describeHealth({ upstreamBaseUrl: "http://127.0.0.1:17842", startedAt: Date.now() - 5_000, requests: 3, lastError: "upstream 502" });
  expect(degraded.status).toBe("degraded");
  expect(degraded.last_error).toContain("502");
});

test("the operational scripts exist and are idempotent-friendly cmd files", () => {
  const root = join(import.meta.dir, "..");
  const start = join(root, "scripts", "start-external-layer.cmd");
  const stop = join(root, "scripts", "stop-external-layer.cmd");
  expect(existsSync(start)).toBe(true);
  expect(existsSync(stop)).toBe(true);
  const startText = readFileSync(start, "utf8");
  expect(startText.toLowerCase()).toContain("already");
  expect(startText).toContain("17843");
});
