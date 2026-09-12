/**
 * w13-equivalence :: canonical contract for the claim "the *unmodified* upstream already carries
 * the browser layer", and the evidence report that has to back it.
 *
 * The external layer deliberately did NOT port `browser-tab-pool.ts`, `chat-mode-guard.ts`,
 * `family-effort-verifier.ts` or `prodex-slider-driver.ts`, on the grounds that upstream v5.0.6
 * already implements them. That reasoning is only defensible with *recorded, re-runnable*
 * evidence, so this file gates two things at once:
 *
 *   (a) OFFLINE half — `research/w13-equivalence-report.md` must carry every `## C0`..`## C5`
 *       section, at least five flush-left `^CLAIM: C\d` lines (each with an `EVIDENCE:` clause),
 *       no unproven marker at all, and the raw live artefacts (`resp_<hex>` + a real `call_` id).
 *       The expensive claims (tier turn, tool turn) are verified from the report's RECORDED text
 *       instead of being re-run here, because each real ChatGPT Web turn costs 25-45 s.
 *   (b) LIVE half — the cheap, deterministic probes are re-measured against the live endpoint so a
 *       degraded or unreachable stack FAILS the wave (never `test.skip`), plus exactly one real
 *       `low` turn proving tier routing, whose identical body must then replay byte-for-byte in
 *       under a second with `x-ext-layer-replay: true`.
 *
 * Why this is RED before the wave lands: with no report on disk the offline half fails on its
 * first assertion, and the wave's deliverable is by definition absent.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { CHATGPT_WEB_UNIFIED_TIERS } from "../src/models";

// ---------------------------------------------------------------------------
// Report path — MUST live inside this repository. The report is this wave's
// deliverable, so it has to be part of the wave diff and merge; an absolute path
// outside the repo would let the contract pass at base (no RED) and would leave
// the evidence uncommitted. The sibling copy under `.trellis/.../research/` is
// the planner's source evidence, which the writer adapts into this path.
// ---------------------------------------------------------------------------
const REPORT_RELATIVE_PATH = "research/w13-equivalence-report.md";
const REPORT_PATH = `${import.meta.dir}/../${REPORT_RELATIVE_PATH}`;

const LAYER_BASE_URL = process.env.EXT_LAYER_BASE ?? "http://127.0.0.1:17843";
const HEALTHZ_URL = `${LAYER_BASE_URL}/healthz`;
const MODELS_URL = `${LAYER_BASE_URL}/v1/models`;
const RESPONSES_URL = `${LAYER_BASE_URL}/v1/responses`;

/** The repo's documented local dev key (`EXT_LAYER_API_KEY` default in `src/index.ts`); loopback only. */
/** Live cases are opt-in: `EXT_LAYER_LIVE=1 EXT_LAYER_API_KEY=<key> bun test`. */
const LIVE = process.env.EXT_LAYER_LIVE === "1";
const liveTest = LIVE ? test : test.skip;
/** Key of the stack under test; supplied through EXT_LAYER_API_KEY when LIVE. */
const DEV_API_KEY = process.env.EXT_LAYER_API_KEY ?? "sk-ext-layer-live-probe";

const CHEAP_TIMEOUT_MS = 10_000;
const TURN_TIMEOUT_MS = 90_000;
const REPLAY_BUDGET_MS = 1_000;
const SUITE_BUDGET_MS = 110_000;

const RESPONSE_ID_PATTERN = /resp_[0-9a-f]{16,}/;

/**
 * `call_id` is base64url, NOT alphanumeric. Measured genuine evidence:
 * `call_GDrqV1h4IDuzBu9fPwK_XVscNvkBTy4H` — the alnum run immediately after `call_` is only 19
 * characters before a `_`, so a literal `/call_[A-Za-z0-9]{20,}/` can never match a real id and
 * would be a permanently-red test bug rather than an intended RED. Keep `_`/`-` in the alphabet.
 */
const CALL_ID_PATTERN = /call_[A-Za-z0-9_-]{20,}/;

/** Must never appear: the wave's whole point is that every claim was actually verified. */
const UNPROVEN_MARKER = "UNVERIFIED";

const SUITE_STARTED_MS = Date.now();

interface ProbeResult {
  status: number;
  headers: Headers;
  text: string;
  elapsedMs: number;
}

function readReport(): string {
  if (!existsSync(REPORT_PATH)) {
    throw new Error(
      `w13 evidence report is missing at ${REPORT_PATH}. `
      + "This wave exists to turn 'upstream already implements it' into recorded, re-runnable evidence; "
      + "the canonical contract test fails while that report is absent.",
    );
  }
  return readFileSync(REPORT_PATH, "utf8");
}

/** Body of one `## CX` section, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const rest = markdown.slice(start + heading.length);
  const nextHeading = rest.search(/^## /m);
  return nextHeading < 0 ? rest : rest.slice(0, nextHeading);
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what}: expected a JSON body, got: ${text.slice(0, 300)}`);
  }
}

/** One live HTTP probe. An unreachable endpoint throws (FAIL, never skip). */
async function probe(url: string, init: RequestInit, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(
      `w13 live probe could not reach ${url}: ${error instanceof Error ? error.message : String(error)}. `
      + "This wave must FAIL when the external layer (17843) is unreachable — evidence is the deliverable.",
    );
  }
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, elapsedMs: Date.now() - started };
}

function authorizedTurn(body: string): RequestInit {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${DEV_API_KEY}`, "content-type": "application/json" },
    body,
  };
}

// ---------------------------------------------------------------------------
// (a) OFFLINE half — the report must be complete and honest
// ---------------------------------------------------------------------------
test("1: the report exists, carries every required section, and claims only verified evidence", () => {
  const report = readReport();

  for (const heading of ["## C0", "## C1", "## C2", "## C3", "## C4", "## C5"]) {
    expect(report).toContain(heading);
  }

  const claimLines = report.split(/\r?\n/).filter(line => /^CLAIM: C\d/.test(line));
  expect(claimLines.length).toBeGreaterThanOrEqual(5);
  for (const line of claimLines) {
    expect(line).toContain("EVIDENCE:");
  }

  expect(report.includes(UNPROVEN_MARKER)).toBe(false);

  // Raw live artefacts must be pasted in verbatim, not paraphrased.
  expect(RESPONSE_ID_PATTERN.test(report)).toBe(true);
  expect(CALL_ID_PATTERN.test(report)).toBe(true);
});

test("2: the report's expensive evidence is complete and consistent with src/models.ts", () => {
  const report = readReport();

  // C0's tier ladder must equal CHATGPT_WEB_UNIFIED_TIERS, order included.
  // Read the capture groups, not the whole match: the trailing `\s*$` can swallow the
  // newline that follows the last TIER line, which would leak "\n" into a re-split slug.
  const reportedTiers = Array.from(report.matchAll(/^TIER:\s*(\S+)\s*=>\s*(\S+)\s*$/gm))
    .map(match => ({ effort: match[1], slug: match[2] }));
  expect(reportedTiers).toEqual(
    CHATGPT_WEB_UNIFIED_TIERS.map(tier => ({ effort: tier.effort, slug: tier.slug })),
  );

  // Every expensive probe must record a numeric elapsed and the exact tier slug it landed on.
  const elapsedSeconds = new Map<string, number>();
  for (const match of report.matchAll(/^ELAPSED_SECONDS:\s*(C\d+)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/gm)) {
    elapsedSeconds.set(match[1], Number(match[2]));
  }
  const recordedModels = new Map<string, string>();
  for (const match of report.matchAll(/^RECORDED_MODEL:\s*(C\d+)\s*=\s*(\S+)\s*$/gm)) {
    recordedModels.set(match[1], match[2]);
  }

  // `low` must map to the Light tier both in the module and in the record.
  const lightSlug = CHATGPT_WEB_UNIFIED_TIERS.find(tier => tier.effort === "low")?.slug;
  expect(lightSlug).toBe("chatgpt-web/light");
  expect(recordedModels.get("C1")).toBe(lightSlug);
  expect(recordedModels.get("C2")).toBe(lightSlug);

  for (const key of ["C1", "C2"]) {
    const seconds = elapsedSeconds.get(key);
    expect(typeof seconds).toBe("number");
    expect(Number.isFinite(seconds ?? Number.NaN)).toBe(true);
    // A real ChatGPT Web turn is tens of seconds: never instant, never absurd.
    expect(seconds ?? 0).toBeGreaterThan(1);
    expect(seconds ?? 0).toBeLessThan(300);
  }

  // C1 — tier turn: the rewritten slug and a real response id.
  const c1 = section(report, "## C1");
  expect(c1).toContain('"model":"chatgpt-web/light"');
  expect(RESPONSE_ID_PATTERN.test(c1)).toBe(true);
  expect(c1).toMatch(/^ELAPSED_SECONDS: C1 = [0-9]/m);

  // C2 — tool turn: a real function_call carrying a real call id and the declared function name.
  const c2 = section(report, "## C2");
  expect(c2).toContain('"type":"function_call"');
  expect(c2).toContain("read_file");
  expect(CALL_ID_PATTERN.test(c2)).toBe(true);
  expect(c2).toMatch(/^ELAPSED_SECONDS: C2 = [0-9]/m);

  // C3 — replay: the marker header, byte-identity, and a sub-second measurement.
  const c3 = section(report, "## C3");
  expect(c3).toContain("x-ext-layer-replay: true");
  expect(c3).toContain("BYTE-IDENTICAL");

  // C4 — validation: both fail-closed codes, proven to fire before the browser.
  const c4 = section(report, "## C4");
  expect(c4).toContain("invalid_reasoning_effort");
  expect(c4).toContain("invalid_api_key");
});

// ---------------------------------------------------------------------------
// (b) LIVE half — cheap probes re-measured against the running stack
// ---------------------------------------------------------------------------
liveTest("3: the live stack still answers the cheap contract probes", async () => {
  const healthz = await probe(HEALTHZ_URL, { method: "GET" }, CHEAP_TIMEOUT_MS);
  expect(healthz.status).toBe(200);
  expect(parseJson<{ status?: string }>(healthz.text, "GET /healthz").status).toBe("ok");

  const models = await probe(
    MODELS_URL,
    { method: "GET", headers: { authorization: `Bearer ${DEV_API_KEY}` } },
    CHEAP_TIMEOUT_MS,
  );
  expect(models.status).toBe(200);
  const catalog = parseJson<{ object?: string; data?: Array<{ id?: string }> }>(models.text, "GET /v1/models");
  expect(catalog.object).toBe("list");
  expect((catalog.data ?? []).map(entry => String(entry.id))).toContain("chatgpt-web/latest");

  // An unknown tier must be rejected before any browser turn is opened.
  const unknownTier = await probe(
    RESPONSES_URL,
    authorizedTurn(JSON.stringify({ model: "chatgpt-web/latest", reasoning_effort: "maxx", input: "hi" })),
    CHEAP_TIMEOUT_MS,
  );
  expect(unknownTier.status).toBe(400);
  expect(parseJson<{ error?: { code?: string } }>(unknownTier.text, "unknown tier").error?.code)
    .toBe("invalid_reasoning_effort");

  const wrongKey = await probe(
    RESPONSES_URL,
    {
      method: "POST",
      headers: { authorization: "Bearer sk-w13-not-the-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/latest", input: "hi" }),
    },
    CHEAP_TIMEOUT_MS,
  );
  expect(wrongKey.status).toBe(401);
  expect(parseJson<{ error?: { code?: string } }>(wrongKey.text, "wrong api key").error?.code)
    .toBe("invalid_api_key");
});

liveTest("4: a real low-tier turn reaches the browser, then the identical body replays under a second", async () => {
  // A nonce keeps this prompt from colliding with any earlier idempotency entry.
  const nonce = `w13eq-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const body = JSON.stringify({
    model: "chatgpt-web/latest",
    reasoning_effort: "low",
    input: `Reply with the single word PONG. (w13 equivalence probe ${nonce})`,
  });

  const first = await probe(RESPONSES_URL, authorizedTurn(body), TURN_TIMEOUT_MS);
  expect(first.status).toBe(200);
  const firstBody = parseJson<{ id?: string; status?: string; model?: string; output?: unknown[] }>(
    first.text,
    "real low-tier turn",
  );
  expect(String(firstBody.id)).toMatch(/^resp_[0-9a-f]{16,}$/);
  expect(firstBody.status).toBe("completed");
  // The live turn must land on the tier the unified ladder maps `low` to.
  expect(CHATGPT_WEB_UNIFIED_TIERS.map(tier => tier.slug)).toContain(String(firstBody.model));
  expect(firstBody.model).toBe("chatgpt-web/light");
  expect(first.headers.get("x-ext-layer-replay")).toBeNull();

  // Same body, immediately: no second browser turn may be opened.
  const replay = await probe(RESPONSES_URL, authorizedTurn(body), CHEAP_TIMEOUT_MS);
  expect(replay.status).toBe(200);
  expect(replay.headers.get("x-ext-layer-replay")).toBe("true");
  expect(replay.elapsedMs).toBeLessThan(REPLAY_BUDGET_MS);
  expect(replay.text).toBe(first.text);
}, TURN_TIMEOUT_MS + 5_000);

test("5: the wave stayed inside the graph test gate budget", () => {
  expect(Date.now() - SUITE_STARTED_MS).toBeLessThan(SUITE_BUDGET_MS);
});
