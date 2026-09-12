# Handoff 2026-09-12 — retained ChatGPT tab is reused for only ~7% of turns; every conversation-continuation re-opens a fresh Temporary Chat and re-pastes the full history

> 中文 TL;DR：外接层（本仓库）已经实现「同一客户端会话 → 复用上游保留的浏览器标签页（只贴增量）」的机制（真机验证过能命中 `tab_reused`），但今天实测 **~93% 的回合仍是全新 Temporary Chat + 全量重贴**。成功保留的 tab 也常常不被下一个回合复用（决定性时间线见 §6）。载荷 ≥ ~17k tokens 的回合几乎必败（页面 DOM ~500–630KB 后观测停滞 60s → 回合中止 → tab 不保留 → 下一步又要全量重贴 → 死循环）。本人已在 facade 侧修了一大批可靠性问题（见 §9），但「复用为什么 miss」仍未定位。**请定位根因，并只在 external-layer（本仓库）里修复——红线见 §3。**

## 1. What we need from you

1. The **root cause** of missed tab reuse (which condition in the matching chain actually fails, with evidence).
2. A **minimal patch confined to this repository** (`external-layer`), i.e. protocol/identity-level, with tests.
3. A short "how to verify" that we can run against the live stack (we run the real machine).

## 2. Topology and versions

```
DSH client (agent loop, full-resend)
   │  OpenAI Responses API, api:"openai-responses" (pi-ai)
   │  body: { model:"chatgpt-web/latest", input: <messages ARRAY>, stream:true,
   │          store:false, prompt_cache_key:<sessionId (stable per chat)> }
   ▼
external-layer (this repo)  http://127.0.0.1:17843/v1
   │  protocol translation: input[] + synthesized <environment_context> envelope,
   │  fresh prov-* turn_id per attempt, conversation registry (prefix match) for thread_id,
   │  retry/watchdog/breaker; upstream auth = ChatGPT OAuth bearer from ~/.codex/auth.json
   ▼
UNMODIFIED upstream codex-chatgpt-web v5.0.6  http://127.0.0.1:17842/v1   (repo: miuuyy/codex-chatgpt-web, install HEAD e85e369)
   ▼
desktop-shell launcher (Electron browser-host, dev home) + chatgpt.com temporary chat page
```

- **This repo**: `daixudk96-max/external-layer` (public, `docs/handoff/…` is this folder). TypeScript on Bun, **zero runtime dependencies** (devDep `bun-types` only). Gates: `bunx tsc --noEmit` + `bun test` (currently 189 pass / 2 skip / 0 fail).
- **Upstream**: `miuuyy/codex-chatgpt-web` v5.0.6 — we are **not allowed to modify it** (§3). Its relevant source is quoted in §5 so you can reason without cloning; cloning it is fine if you want more.

## 3. Hard constraints (violations = rejected patch)

1. **Zero modifications** to the upstream repo / installed upstream 5.0.6, its desktop-shell `launcher/`, or its home `config.json`.
2. No changes to the DSH client or `settings.yaml` (not our patch surface).
3. external-layer must keep **zero new runtime dependencies** and no `globalThis` mutation / module top-level side effects.
4. **Do not route traffic to the native Codex backend** (`https://chatgpt.com/backend-api/codex`, upstream `src/native-passthrough.ts:15`). The deployment sets `allowNativePassthrough:false`; billing red line — only the ChatGPT **web** surface may be used.
5. Never log or persist credentials/OAuth tokens.

## 4. Quantified symptom

From `logs/launcher-tab-lifecycle.jsonl` (recent ~1500 launcher events, all on 2026-09-12):

```
tab_created 104 | tab_reused 7 | tab_retained 23 | tab_released 80 (status aborted|error)
retained_tab_expired 12 | tab_navigation_failed 8 | cloudflare_challenge_detected 3
```

Payload vs outcome across 127 upstream turns (`browser turn <trace> opened (transport=inline, maxMessageChars=<chars>, estimatedInputTokens=<tok>, …)`):

| per-turn payload | completed | failed |
|---|---|---|
| < 20k tokens | 68 | 15 (~82% ok) |
| ≥ 20k tokens | 1 | 43 (~2% ok) |

Failures carry `compactionTrimmedMessages=0` (upstream never trims) and end as one of:
- `ChatGPT web turn aborted` (33×; after `20-response-stalled-60s` = DOM went dark for 60s; DOM `bodyTextChars` 500–630KB; DOM probe errors: `ChatGPT browser DOM observation did not respond within 5000ms`),
- `ChatGPT ended the turn with 'Something went wrong'. Retry the turn.` (21×),
- `ChatGPT browser stage timed out: browser_page`, `locator.press/waiteFor: Timeout …ms exceeded` (few).

**Today the reliability cliff moved lower**: completed at `estimatedInputTokens` = 8,972 / 9,071; failed at 16,848 / 16,849 / 17,564 / 17,859 / 18,224 / 24,722 / 26,462 / 27,374 (historical cliff was ~20k). Suspicious in the same window: `tab_navigation_failed 8`, `cloudflare_challenge_detected 3`.

Consequence = the death spiral the user sees: (failed turn → no retain → next step must re-open a Temporary Chat and re-paste everything → fails again while history only grows).

## 5. The reuse machinery we rely on (upstream v5.0.6, verbatim)

- Conversation identity: `ccw-upstream/src/adapters/chatgpt-web/conversation-key.ts:29-43`
  ```ts
  createHash("sha256").update(JSON.stringify({
    namespace, threadId: identity.threadId, modelId: parsed.modelId,
    reasoning: parsed.options.reasoning, compaction: compactionEpoch(raw?.input),
  }))
  ```
- Namespace: `ccw-upstream/src/adapters/chatgpt-web/index.ts:195-198` — `sha256(JSON.stringify({ baseUrl: provider.baseUrl, chatgptWeb: provider.chatgptWeb ?? {} }))` → **constant** for our deployment ⇒ **not** the drift source.
- Continuation gate: `index.ts:415-421` — key is computed only when `!parsed._compactionRequest && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID && mode.localTools && retainedLauncherDescriptor`; suffix-only resume = `conversation-key.ts:45-55` (`messages.slice(lastAssistant + 1)`); reused turns must carry `prepareResume` (`browser-worker.ts:4222-4231` throws `"Launcher reused a ChatGPT conversation without a continuation prompt"` otherwise).
- Retain: only on `terminal === "completed"` — `browser-worker.ts:4246-4258` emits `{phase:"end", status, retain:true, connectorBound:true …}`; launcher `browser-host.cjs:2325-2338` keeps the tab only then (`browser.tab_retained`), otherwise releases.
- Matching: `browser-host.cjs:2225-2232` requires `tab.interactionMode==="automatic" && tab.status==="ready" && tab.conversationKey === conversationKey && tab.connectorIdentity === connectorIdentity && (tab.connectorBound === true)`; reuse chosen at `:2244-2246`; TTL `RETAINED_TURN_TAB_TTL_MS = 30*60*1000` (`:46`); when a tab is released, the next tab re-takes the lowest free ordinal + the same label `ChatGPT ${ordinal}` (`:523`) — which is why "the tab looks the same but the session is new".
- Also: with `browser.tab_reused === true` the worker *requires* `prepareResume` and skips `temporary_chat_preparation` entirely (`browser-worker.ts:4289`, `:4506-4508`).

Deployment facts (upstream home `config.json`, secrets redacted): `mode:"full"`, `browserInteractionMode:"automatic"`, `browserHost:"launcher"` + `browserHostDescriptorPath` set (dev home), `appName:"Codex Native2 DEV"`, `solAvailable:true`, `proAvailable:true`, `experimentalBiggerContext:true`, `allowNativePassthrough:false`, `port:17842`. The facade maps model+effort → tier slug `chatgpt-web/{light|medium|high|extra-high|pro}`.

## 6. Decisive timeline (2026-09-12, UTC; full file: `logs/launcher-timeline-decisive.txt`)

Two conversations interleaved (tabCount stays 3):

- **A (small, ~9k)**: `9e3877a60a06` completed (est. 8,972 tok) → `tab_retained` (tabId `Cn_YF_m51GVAUSyJ`). Its apparent next turn `5f225f240b14` (est. 9,071 tok ≈ +100 tokens, completed) was **tab_created, NOT reused**, ~23 min later (well inside TTL); both retained tabs later die by `retained_tab_expired` (e.g. `bZjM3EgoZu4hAdOX` expired at `16:08:20.026Z`).
- **B (agent loop, growing)**: `0b4125d18234` (16,848 tok) failed(`locator.waitFor: Timeout 10000ms …`)→released; **before** the parallel small turn `5f225f240b14` completed, its retry `229d2a3767d7` (16,849) had already `tab_created` → aborted → released; then `625197c66d63` (17,564) → aborted; `b9d8b02c40ab` (17,859) → aborted; `99fe08e84a9f` (18,224) → failed `Something went wrong` (`turn_ended` at `15:45:10.981Z`). Upstream stage logs show each of these did the **full** nav path (`stage=temporary_chat_preparation completed …`).

Ordered launcher events for the window (subset; `at` timestamps in the full file):

```
tab_created {tabId:"bZjM3EgoZu4hAdOX", traceId:"5f225f240b14"}   (tabCount 3)
turn_started   5f225f240b14
tab_created {tabId:"lxlpAp2a7QiMKuO1", traceId:"0b4125d18234"}
turn_started   0b4125d18234
tab_released {…0b4125d18234, status:"error"}
turn_ended   0b4125d18234 status=failed
tab_created {tabId:"LamMd_8oNK915Iy_", traceId:"229d2a3767d7"}   ← next request arrives BEFORE prior turn ends
turn_started   229d2a3767d7
tab_retained {tabId:"bZjM3EgoZu4hAdOX", traceId:"5f225f240b14"}
turn_ended   5f225f240b14 status=completed
tab_released {…229d2a3767d7, status:"aborted"}
turn_ended   229d2a3767d7 status=aborted
… 625197c66d63 / b9d8b02c40ab / 99fe08e84a9f …
retained_tab_expired {tabId:"bZjM3EgoZu4hAdOX", traceId:"5f225f240b14"}   (16:08:20.026Z)
```

Checkpoint anchors (diagnostics dirs, shipped): `5f225f240b14-ee492bd4/08-effort-selected.json` `capturedAt 2026-09-12T15:37:54.292Z`; `229d2a3767d7-67a80951/…` `15:38:11.703Z` (i.e. the retry turn was already at effort-selection while the small conversation's turn had not yet completed) ⇒ **≥2 upstream turns were concurrently in flight**.

## 7. Already ruled out (with evidence)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| TTL expiry | ✅ out | reuse misses at 1–23 min gaps vs 30 min TTL; expired tabs only after ≥30 min |
| `interactionMode` isn't automatic | ✅ out (config), but log can't prove per-tab value | `browserInteractionMode:"automatic"` in config.json; yet worth re-checking per tab |
| Namespace drift | ✅ out | namespace = sha256({baseUrl, chatgptWeb:{}}) → constant per deployment (`index.ts:195-198`) |
| Client aborts (60/90s) kill first turns | ✅ out | facade log: zero `client_aborted`, turns of 119/132/143 s all finished `done status=200`; DSH stream idle timeout is 300 s (`dsh/packages/llm/llm-pi-ai/src/config.ts:44 DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`) and upstream heartbeats are relayed |
| Registry only binds array inputs (string gate) | ✅ real code smell, **not our symptom** | facade `src/external-layer.ts:825/:965/:1454/:1803` gate on `Array.isArray(standard.input)`; but DSH sends arrays and never `previous_response_id` (`dsh/…/pi-ai/dist/api/openai-responses.js:228 const params = { model, input: messages, stream:true, prompt_cache_key, store:false }`); mock `tests/wc-session-invariant.test.ts` S1 + real-machine 2-turn same-thread + observed `browser.tab_reused` prove the array path works |
| Reuse path broken generally | ✅ out | 7 `browser.tab_reused` today proves the machinery fires when conditions hold |

## 8. Open hypotheses + how to check each

- **H1 (foremost): readiness/source race** — reuse requires a *ready* retained tab at match time (`status==="ready"`, i.e. retained from a completed prior turn). Retry storms (DSH retries ×5 on codes `SERVER/TIMEOUT/RATE_LIMIT/TRANSPORT`, initial 500 ms) and interleaved conversations mean the matching request often arrives **before** the previous turn completes, or belongs to a different thread than the only ready tab. Verify: in the facade (only place allowed), log per request `{resolved threadId, tier slug, reasoning/effort, count of in-flight upstream turns, whether a retained-but-not-matched tab existed}`; correlate with `browser.tab_created/tab_reused` pairs.
- **H2 conversationKey drift** via `parsed.modelId` / `parsed.options.reasoning` / `compactionEpoch` between consecutive client steps. Verify: log the same fields per request; or diff consecutive traces' `08-effort-selected` (we compared 3 of them: identical — but they are **new conversation** traces, so this is weak evidence).
- **H3 identity sanity**: our thread assignment rotates when history prefixes don't match (e.g. DSH tool/function_call items, reasoning items, or any request-shape variation between steps). Better identity exists and is unused: DSH already sends a **stable `prompt_cache_key` = sessionId**; upstream's own dev client maps it to the thread (`ccw-upstream/src/dev-chat/driver.ts:204 prompt_cache_key: state.threadId`). Candidate fix: prefer `prompt_cache_key` as the explicit conversation identity, fall back to prefix match. Verify: live 3-step history with growing items incl. tool outputs through 17843, assert `x-ext-layer-conversation` header stable, then compare `thread_id` (from `client_metadata["x-codex-turn-metadata"]`) recorded by a mock upstream.
- **H4 registry digest mismatch** for tool-bearing histories: `src/conversation-registry.ts` `canonicalItemDigest` covers `type/role/call_id/output/name/content`; DSH histories include assistant `function_call` + client `function_call_output` items and possibly reasoning items; a mismatch between what we record and what arrives next would force a new thread. Adds a test with growing tool-history.
- **H5 connector bound mismatch** (`connectorIdentity`/`connectorBound`): retention flags are not logged by the launcher (grep `connectorBound` in launcher.jsonl = 0 hits), so this needs code-level reasoning or temporary facade-side capture of the request shape that yields `connectorIdentity: this.config.appName` (`browser-worker.ts:4175-4192`).
- **H6 (why cliff sits at ~9–17k despite composer limits)**: the page suffocates at DOM 500–630KB with `20-response-stalled-60s` — treat as environmental (browser throttling / Cloudflare) vs intrinsic. The same payload through the *native* door ran in 7.4 s (138,697 chars ⇒ input_tokens 37,436) — proving size is not the ask; web-surface robustness is. (= "拆 2/3 片" multipart is upstream's own answer for oversized prompts: `adapters/chatgpt-web/prompt.ts:44 CHATGPT_BIGGER_CONTEXT_PARTS=3`, `usage.ts:113 biggerContextPartCount()`, attaches stage-bounded parts with `<codex_multipart_stage>` records.) If the root cause of the suffocation is the re-paste stress itself (Nav→attach full history), fixing reuse (§8-H1..H3) also flattens this.

## 9. Already shipped in this repo (do not re-implement)

`src/conversation-registry.ts` (prefix-match registry, LRU 64, optional persistence, `x-ext-layer-conversation` header on every response), per-request thread resolution kept stable across in-request attempts (`src/external-layer.ts` — thread resolved once outside the retry loop, each attempt gets a new `turn_id`), failure-path recording (`noteTurnFailure` binds failed turns to the thread), failure breaker (`src/failure-breaker.ts`, thresholds `DEFAULT_PAYLOAD_CHARS_THRESHOLD = 150_000` / `DEFAULT_PAYLOAD_TOKEN_THRESHOLD = 20_000`, cooldown 300 s, compact-nudge 200-response with `x-ext-layer-nudge: conversation_too_large`), progress watchdog (heartbeat ≠ progress, default 240 s → `504 upstream_no_progress`, always-interrupt policy `POST /admin/interrupt-turn` on client abort / stall / upstream failure / in-stream failure — `tests/w22-interrupt-on-stall.test.ts`, `tests/w26-stream-nav-retry.test.ts`), SSE stream-peek invisibly retrying nav-class stream failures (`src/stream-peek.ts`), content-aware payload estimator (`estimateTokensFromChars = ascii/3.6 + cjk/1.5`), per-request log lines + `/healthz` observability, `GET /v1/context` (upstream-derived per-tier windows, `payload_cliff_tokens/chars`), passthrough routes (`POST /v1/responses/compact`, `GET /v1/responses` 426, `POST /v1/alpha/search`).

## 10. Artifacts in this folder (sanitized: usernames → `you`; no secrets)

| file | content |
|---|---|
| `logs/launcher-tab-lifecycle.jsonl` | full tab/turn/challenge event stream (2,115 events) behind §4 stats |
| `logs/launcher-timeline-decisive.txt` | timestamps of the §6 window for traces `5f225f240b14 / 229d2a3767d7 / 625197c66d63 / b9d8b02c40ab / 99fe08e84a9f / 0b4125d18234 / 9e3877a60a06` |
| `logs/upstream-turn-outcomes.log` | 70 per-turn `opened (… estimatedInputTokens=…)/completed/failed` lines (payload ↔ outcome) — no timestamps; correlate by trace id with the launcher file |
| `logs/facade-requests.log` | our facade's own request log (note: in-stream failures currently still print `done status=200`; known observability gap) |
| `diagnostics/<trace>-<hash>/…` | 3 full checkpoint folders (01…20/21) incl. `08-effort-selected.json`, `20-response-stalled-60s.json`, `21-turn-failed.json` |

Local (operator machine, not shipped): upstream log `C:\Users\<you>\AppData\Local\Temp\upstream-serve.log`; launcher log `C:\Users\<you>\.codex-chatgpt-web-dev\launcher\logs\launcher.jsonl`; diagnostics root `C:\Users\<you>\.codex-chatgpt-web-upstream\diagnostics\browser-turns\`; facade log `C:\Users\<you>\AppData\Local\Temp\external-layer.log`.

## 11. Remote repro (needs your own ChatGPT account; we cannot ship credentials)

1. Run upstream: `bun run src/cli.ts serve` with a config like `§5` (ports 17842, launcher host on). Run facade: `bun run src/index.ts` (17843; `EXT_LAYER_UPSTREAM=http://127.0.0.1:17842`).
2. Send a growing-history conversation as DSH would (array `input`, `stream:true`, `store:false`, stable session token); watch `x-ext-layer-conversation` (should be constant) and `logs/launcher-tab-lifecycle.jsonl`.
3. Single-turn body ≈ 9k tokens (system baseline) should complete and `tab_retained`; the immediately-following same-history turn should `tab_reused` with `nav_steps=0` (no `02-temporary-chat-navigation-complete.json`). Under concurrency/retry pressure, characterize when it doesn't.

## 12. Notes for the maintainer (not for the external reviewer)

The git history before tag `v0.1.0` contains a real (now-legacy) API key; HEAD is clean. Rotation pending operator decision. `Bun.serve` currently lacks an explicit `hostname` (binds `0.0.0.0`, docs say loopback) — queued.
