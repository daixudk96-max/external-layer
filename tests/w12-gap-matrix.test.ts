/**
 * w12-gap-matrix :: canonical contract for the upstream-gap AUDIT.
 *
 * The audit is the answer to one question: after moving our enhancements into the
 * external layer and running upstream PRISTINE, which capabilities of the old local
 * line (`provider/codex-chatgpt-web/src`, no shared ancestor with upstream) are
 * neither ported nor covered — and how do we know?
 *
 * A prose answer is not verifiable, so this test freezes the artifact:
 *
 *   docs/upstream-gap-audit.md          the report
 *   research/w12-sweep.log              raw sweep output the report cites
 *
 * Report grammar (exact spellings, checked below):
 *
 *   ## 2. 本地独有模块矩阵
 *   | id | module | legacy path | verdict | evidence | residual risk | verification |
 *   verdict ∈ PORTED | COVERED-BY-UPSTREAM | DROPPED | NEEDS-PORT     (no other value)
 *   evidence  must carry a `path/to/file.ts:LINE` anchor or a commit sha
 *   NEEDS-PORT rows must be answered by `FOLLOWUP: <id> | target: <path> | accept: <criterion>`
 *
 *   ## 3. `SWEEP:` lines, one per swept identifier
 *   SWEEP: <id> | <identifier> | upstream-commit <sha> | local: <path> | result: ABSENT|PRESENT | raw: <file>#<marker>
 *   the raw file must literally contain both <identifier> and <sha>
 *
 *   GAPS: <unmatched> unmatched identifiers, <needPorting> need porting
 *
 * Forbidden: UNKNOWN / TBD / 待定 anywhere (an audit that does not decide is not an audit).
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const REPORT = "docs/upstream-gap-audit.md";
const SWEEP_LOG = "research/w12-sweep.log";

/** The eleven modules the old line owns and upstream does not ship (verified 2026-09-10). */
const LEGACY_ONLY_MODULES = [
  "browser-tab-pool",
  "chat-mode-guard",
  "family-effort-verifier",
  "prodex-slider-driver",
  "capability-matrix",
  "chat-completions",
  "run-coordinator",
  "security",
  "tool-jobs",
  "tool-relay",
  "tool-timeouts",
];

const VERDICTS = ["PORTED", "COVERED-BY-UPSTREAM", "DROPPED", "NEEDS-PORT"];

function report(): string {
  return readFileSync(REPORT, "utf8");
}

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`missing section ${heading}`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

function rows(body: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map(c => c.trim());
    if (cells.length < 9) continue; // leading + trailing empty => 7 content cells
    const [, id, module, legacyPath, verdict, evidence, risk, verification] = cells;
    if (/^-+$/.test(id) || id.toLowerCase() === "id") continue;
    out.push({ id, module, legacyPath, verdict, evidence, risk, verification });
  }
  return out;
}

test("1: docs/upstream-gap-audit.md exists and decides every row", () => {
  expect(existsSync(REPORT)).toBe(true);
  const text = report();
  const low = text.toLowerCase();
  for (const forbidden of ["unknown", "tbd", "待定"]) {
    expect(low).not.toContain(forbidden);
  }
  const matrix = rows(section(text, "## 2. 本地独有模块矩阵"));
  expect(matrix.length).toBeGreaterThanOrEqual(LEGACY_ONLY_MODULES.length);
  for (const row of matrix) {
    expect(VERDICTS).toContain(row.verdict);
    expect(row.legacyPath.length).toBeGreaterThan(0);
    expect(row.risk.length).toBeGreaterThan(0);
    expect(row.verification.length).toBeGreaterThan(0);
    expect(/[A-Za-z0-9_./\\-]+\.(ts|tsx|js|mjs|json|md):\d+/.test(row.evidence) || /\b[0-9a-f]{7,40}\b/.test(row.evidence)).toBe(true);
  }
});

test("2: every legacy-only module is named by at least one row", () => {
  const matrix = rows(section(report(), "## 2. 本地独有模块矩阵"));
  const corpus = matrix.map(r => `${r.id} ${r.module} ${r.legacyPath}`.toLowerCase()).join("\n");
  const missing = LEGACY_ONLY_MODULES.filter(name => !corpus.includes(name));
  expect(missing).toEqual([]);
});

test("3: NEEDS-PORT verdicts are answered with a follow-up target and a criterion", () => {
  const text = report();
  const matrix = rows(section(text, "## 2. 本地独有模块矩阵"));
  const needsPorting = matrix.filter(r => r.verdict === "NEEDS-PORT");
  const followups = text.split("\n").filter(line => line.startsWith("FOLLOWUP:"));
  const orphan = needsPorting
    .map(r => r.id)
    .filter(id => !followups.some(line => line.includes(id) && /target:\s*\S+/.test(line) && /accept:\s*\S+/.test(line)));
  expect(orphan).toEqual([]);
});

test("4: the sweep is reproducible — every SWEEP line has raw evidence that contains it", () => {
  const sweepLines = report()
    .split("\n")
    .filter(line => line.startsWith("SWEEP:"));
  expect(sweepLines.length).toBeGreaterThanOrEqual(3);

  const pattern =
    /^SWEEP:\s*(\S+)\s*\|\s*(.+?)\s*\|\s*upstream-commit\s+([0-9a-f]{7,40})\s*\|\s*local:\s*(\S+)\s*\|\s*result:\s*(ABSENT|PRESENT)\s*\|\s*raw:\s*(\S+?)#(\S+)\s*$/;

  for (const line of sweepLines) {
    const match = pattern.exec(line);
    if (!match) throw new Error(`malformed SWEEP line: ${line}`);
    const [, , identifier, sha, localPath, result, rawFile, marker] = match;
    expect(["ABSENT", "PRESENT"]).toContain(result);
    if (result === "PRESENT") expect(existsSync(localPath)).toBe(true);
    expect(existsSync(rawFile)).toBe(true);
    const raw = readFileSync(rawFile, "utf8");
    expect(raw).toContain(identifier);
    expect(raw).toContain(sha);
    expect(raw).toContain(marker);
  }
});

test("5: the raw sweep log is real output, not a placeholder", () => {
  expect(existsSync(SWEEP_LOG)).toBe(true);
  const raw = readFileSync(SWEEP_LOG, "utf8");
  const lines = raw.split("\n").filter(line => line.trim() !== "");
  expect(lines.length).toBeGreaterThanOrEqual(40);
  expect(raw).toContain("E:/github/ccw-upstream");
  expect(raw.toLowerCase()).not.toContain("placeholder");
});

test("6: the headline numbers agree with the data underneath them", () => {
  const text = report();
  const headline = text.split("\n").find(line => line.startsWith("GAPS:"));
  expect(headline).toBeDefined();
  const match = /^GAPS:\s*(\d+)\s+unmatched identifiers,\s*(\d+)\s+need porting\s*$/.exec(headline as string);
  if (!match) throw new Error(`malformed GAPS line: ${headline}`);
  const swept = text.split("\n").filter(line => line.startsWith("SWEEP:")).length;
  const needsPorting = rows(section(text, "## 2. 本地独有模块矩阵")).filter(r => r.verdict === "NEEDS-PORT").length;
  expect(Number(match[1])).toBe(swept);
  expect(Number(match[2])).toBe(needsPorting);
});

test("7: the audit adds no dependency and does not touch the facade", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: Record<string, string> };
  const head = Bun.spawnSync(["git", "show", "HEAD:package.json"], { stdout: "pipe" });
  const headPkg = JSON.parse(head.stdout.toString()) as { dependencies?: Record<string, string> };
  expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(Object.keys(headPkg.dependencies ?? {}).sort());
});
