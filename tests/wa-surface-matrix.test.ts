/**
 * WA canonical contract — the upstream-request-SURFACE audit is machine-checkable, not prose.
 *
 * What this freezes: `docs/upstream-request-surface-audit.md`, a behaviour-level coverage audit of
 * how much of the ORIGINAL upstream's client-visible behaviour surface
 * (`E:/github/ccw-upstream/src/server.ts`) the external-layer facade reproduces. A coverage claim
 * nobody can verify is marketing; this test turns it into a grammar.
 *
 * Frozen document grammar (exact — write the document to satisfy THIS, do not guess):
 *
 *  1. Five literal section headings, in this order, each alone on its line:
 *       ## A. Routes
 *       ## B. Request fields
 *       ## C. Event frames
 *       ## D. Error families
 *       ## E. FOLLOWUP
 *     A section body ends at the next line starting with `## ` (or at EOF).
 *
 *  2. Sections A-D each hold a markdown table with at least 3 DATA rows; section A (routes)
 *     needs at least 4. A data row is a line starting with `|` that is neither the header row
 *     (first cell literally `id`, case-insensitive) nor a `|---|` separator row
 *     (`/^\|[\s\-:|]+\|\s*$/`).
 *
 *  3. Every data row starts with an id cell `| r-<id> |` where <id> is [A-Za-z0-9_-]+; ids are
 *     unique across A-D. Frozen row shape:
 *       | r-<id> | <surface item> | PORTED|MISSING|DROPPED | <evidence> | <note> |
 *     - exactly ONE verdict token per row (`PORTED`, `MISSING` or `DROPPED`) — two different
 *       tokens in one row is a fail;
 *     - evidence is either a `path:line` anchor matching /[A-Za-z0-9_\-./]+\.(ts|mjs|cjs|json):\d+/
 *       (forward slashes only — a Windows `\` path does NOT match) or a commit anchor
 *       matching /commit [0-9a-f]{7,}/.
 *
 *  4. Exactly one totals line, anywhere, matching
 *       /^TOTALS: (\d+) ported, (\d+) missing, (\d+) dropped$/m
 *     whose three numbers equal the rows actually counted in A-D.
 *
 *  5. No `UNKNOWN` / `TBD` (case-insensitive) / `待定` anywhere.
 *
 *  6. Every MISSING row is answered in section E by a line matching /^FOLLOWUP: /m that contains
 *     that row's id string verbatim; there must be at least as many `FOLLOWUP: ` lines as distinct
 *     MISSING ids. Frozen follow-up shape:
 *       FOLLOWUP: r-<id> | target: <what to do> | accept: <criterion>
 *
 *  7. The document names the three routes that exist upstream but are missing from the facade
 *     today — `/v1/responses/compact`, `/v1/alpha/search`, `GET /v1/responses` — and cites the
 *     upstream source path `E:/github/ccw-upstream/src/server.ts` at least once.
 *
 * RED by construction: the document does not exist yet, so every test here fails until it is
 * written. The test file itself compiles and RUNS (`bun test tests/wa-surface-matrix.test.ts`).
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

/** Resolved from this file's own location, so the test can be run from anywhere. */
const DOC = `${import.meta.dir}/../docs/upstream-request-surface-audit.md`;

/** Section headings (A-D are the audited surfaces, E is the follow-up log). */
const SECTION_A = "## A. Routes";
const SECTION_B = "## B. Request fields";
const SECTION_C = "## C. Event frames";
const SECTION_D = "## D. Error families";
const SECTION_E = "## E. FOLLOWUP";
const SECTIONS_A_D = [SECTION_A, SECTION_B, SECTION_C, SECTION_D];

/** Verdict vocabulary. `PORTED` is a substring of nothing else here, so the scan is exact. */
const VERDICT_SOURCE = /PORTED|MISSING|DROPPED/g;
/** Evidence anchor: a `path:line` source anchor ... */
const PATH_ANCHOR = /[A-Za-z0-9_\-./]+\.(ts|mjs|cjs|json):\d+/;
/** ... or a commit anchor. */
const COMMIT_ANCHOR = /commit [0-9a-f]{7,}/;
/** A row's leading id cell. */
const ROW_ID = /^\|\s*(r-[A-Za-z0-9_\-]+)\s*\|/;
/** Header row: first cell is the literal column name `id`. */
const HEADER_ROW = /^\|\s*id\s*\|/i;
/** `|---|` separator row. */
const SEPARATOR_ROW = /^\|[\s\-:|]+\|\s*$/;
/** The one and only totals line. */
const TOTALS = /^TOTALS: (\d+) ported, (\d+) missing, (\d+) dropped$/m;
/** A follow-up line inside section E. */
const FOLLOWUP_LINE = /^FOLLOWUP: /m;
/** Words an audit may not hide behind. */
const BANNED = [/UNKNOWN/i, /TBD/i, /待定/];

/** The three upstream routes the facade does NOT serve today (the audit must name them). */
const MISSING_ROUTES = ["/v1/responses/compact", "/v1/alpha/search", "GET /v1/responses"];
/** The upstream source file the audit measures against. */
const UPSTREAM_SOURCE = "E:/github/ccw-upstream/src/server.ts";

/** Long enough that a stub cannot pass, short enough that a real audit clears it. */
const MIN_LENGTH = 4000;
/** Per-section data-row floors: A (routes) is checked harder. */
const MIN_ROWS_A = 4;
const MIN_ROWS_OTHER = 3;

/** Reads the document; the failure message names the exact path a writer must create. */
function readDoc(): string {
  try {
    return readFileSync(DOC, "utf8");
  } catch (error) {
    throw new Error(`expected ${DOC} to exist and be readable: ${String(error)}`);
  }
}

/** LF-normalised text so every line-anchored rule behaves identically on CRLF checkouts. */
function normalised(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/** Body of `heading`, up to the next `## ` heading (or EOF). */
function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`missing section heading ${JSON.stringify(heading)}`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Data rows of the table in a section body: no header row, no `|---|` separator row. */
function dataRows(sectionBody: string): string[] {
  const lines = sectionBody.split("\n");
  const rows: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!line.startsWith("|")) continue;
    if (SEPARATOR_ROW.test(line)) continue;
    if (HEADER_ROW.test(line)) continue;
    // A first table line immediately followed by a separator is the header row too.
    if (rows.length === 0 && SEPARATOR_ROW.test(lines[index + 1] ?? "")) continue;
    rows.push(line);
  }
  return rows;
}

/** All data rows of A-D, tagged with the section they came from. */
function auditedRows(text: string): Array<{ section: string; line: string }> {
  const out: Array<{ section: string; line: string }> = [];
  for (const section of SECTIONS_A_D) {
    for (const line of dataRows(sectionOf(text, section))) out.push({ section, line });
  }
  return out;
}

/** The single verdict token of a row, or `undefined` when the row has none or several. */
function verdictOf(line: string): string | undefined {
  const found = [...new Set(line.match(VERDICT_SOURCE) ?? [])];
  return found.length === 1 ? found[0] : undefined;
}

/** The leading `r-<id>` of a row, or `undefined` when the id cell is missing/malformed. */
function rowIdOf(line: string): string | undefined {
  return ROW_ID.exec(line)?.[1];
}

/** TOTALS numbers, or `undefined` when the line is absent. */
function totalsOf(text: string): { ported: number; missing: number; dropped: number } | undefined {
  const match = TOTALS.exec(normalised(text));
  if (!match) return undefined;
  return {
    ported: Number(match[1]),
    missing: Number(match[2]),
    dropped: Number(match[3]),
  };
}

test("wa1 the surface audit exists and is a real audit (>4000 chars)", () => {
  expect(existsSync(DOC)).toBe(true);
  const text = readDoc();
  expect(text.length).toBeGreaterThan(MIN_LENGTH);
}, 20000);

test("wa2 the audit carries the five frozen section headings literally", () => {
  const text = readDoc();
  for (const heading of [...SECTIONS_A_D, SECTION_E]) {
    expect(text).toContain(heading);
  }
}, 20000);

test("wa3 every audited section A-D is a table with enough data rows (A routes needs 4)", () => {
  const text = readDoc();
  const counts = SECTIONS_A_D.map(section => ({
    section,
    rows: dataRows(sectionOf(text, section)).length,
  }));
  for (const { section, rows } of counts) {
    const floor = section === SECTION_A ? MIN_ROWS_A : MIN_ROWS_OTHER;
    expect({
      section,
      rows,
      floor,
      ok: rows >= floor,
    }).toEqual({
      section,
      rows,
      floor,
      ok: true,
    });
  }
}, 20000);

test("wa4 every audited row carries an r- id and exactly one verdict token", () => {
  const text = readDoc();
  const rows = auditedRows(text);
  const offenders: string[] = [];
  const ids = new Set<string>();
  for (const { line } of rows) {
    const id = rowIdOf(line);
    const verdict = verdictOf(line);
    if (!id) offenders.push(`no | r-<id> | id cell: ${line}`);
    if (!verdict) offenders.push(`not exactly one verdict token: ${line}`);
    if (id) {
      if (ids.has(id)) offenders.push(`duplicate row id ${id}: ${line}`);
      ids.add(id);
    }
  }
  expect(offenders).toEqual([]);
}, 20000);

test("wa5 every audited row carries a path:line or commit evidence anchor", () => {
  const text = readDoc();
  const offenders: string[] = [];
  for (const { line } of auditedRows(text)) {
    const anchored = PATH_ANCHOR.test(line) || COMMIT_ANCHOR.test(line);
    if (!anchored) offenders.push(`no evidence anchor: ${line}`);
  }
  expect(offenders).toEqual([]);
}, 20000);

test("wa6 the TOTALS line equals the rows actually counted in A-D", () => {
  const text = readDoc();
  const totals = totalsOf(text);
  const rows = auditedRows(text);
  const counted = {
    ported: rows.filter(({ line }) => verdictOf(line) === "PORTED").length,
    missing: rows.filter(({ line }) => verdictOf(line) === "MISSING").length,
    dropped: rows.filter(({ line }) => verdictOf(line) === "DROPPED").length,
  };
  expect(totals).toBeDefined();
  expect(totals).toEqual(counted);
}, 20000);

test("wa7 the audit contains no UNKNOWN / TBD / 待定 placeholder", () => {
  const text = readDoc();
  for (const banned of BANNED) {
    expect(text).not.toMatch(banned);
  }
}, 20000);

test("wa8 every MISSING row is answered by a FOLLOWUP line in section E", () => {
  const text = readDoc();
  const sectionE = sectionOf(text, SECTION_E);
  const missingIds = [
    ...new Set(
      auditedRows(text)
        .filter(({ line }) => verdictOf(line) === "MISSING")
        .map(({ line }) => rowIdOf(line))
        .filter((id): id is string => id !== undefined),
    ),
  ];
  expect(sectionE).toMatch(FOLLOWUP_LINE);
  const followupLines = normalised(sectionE).split("\n").filter(line => line.startsWith("FOLLOWUP: "));
  expect(followupLines.length).toBeGreaterThanOrEqual(missingIds.length);
  for (const id of missingIds) {
    expect(sectionE).toContain(id);
  }
}, 20000);

test("wa9 the three upstream-only routes are named literally", () => {
  const text = readDoc();
  for (const route of MISSING_ROUTES) {
    expect(text).toContain(route);
  }
}, 20000);

test("wa10 the audit cites the upstream source path it measures against", () => {
  const text = readDoc();
  expect(text).toContain(UPSTREAM_SOURCE);
}, 20000);
