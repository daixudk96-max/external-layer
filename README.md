# external-layer

A standard **OpenAI Responses API** facade in front of a pristine [`codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web) upstream.

Point any OpenAI-compatible client (agent harness, SDK, IDE plugin) at this layer and it can drive ChatGPT Web through your own logged-in browser session — without ever patching the upstream project.

```text
  client (agent harness / OpenAI SDK / IDE plugin)
      |  standard Responses API + bearer key
      v
  [ external-layer :17843 ]        <- this repository: the only code we author
      |  Codex-native protocol + ChatGPT OAuth (auto-refreshed)
      v
  [ codex-chatgpt-web upstream :17842 ]   <- unmodified third-party project
      |  launcher / tunnel / connector
      v
  ChatGPT Web (your account, in the desktop shell's browser)
```

**Why a separate process instead of a fork?** The upstream project moves fast. Forking it means living 300+ commits behind and re-merging every enhancement forever. This layer keeps every enhancement we need (unified model, tier routing, retry/watchdog budgets, idempotent replay, contract-derived context windows, credential refresh) *outside* the upstream, so the upstream can be updated with a plain `git pull` and nothing breaks.

## What this layer actually does

| # | Capability | Why it matters |
|---|---|---|
| 1 | **Protocol translation** (standard Responses/chat → Codex-native, `turn_id`/`thread_id` identity, `<environment_context>` envelope, `previous_response_id` continuation) | Upstream speaks Codex-native, not the public API shape |
| 2 | **Bearer-key auth** (`timingSafeEqual`, everything else 401) | Loopback-only, but still not an open door |
| 3 | **One unified model id** (`chatgpt-web/latest`) + `reasoning_effort` | 档位在参数里选, not baked into the model name |
| 4 | **Per-tier catalog** (`light`/`medium`/`high`/`extra-high`/`pro`, plus `luna`/`think` on non-Sol accounts) | Clients that key their context budget off the model id get the real per-tier numbers |
| 5 | **Context windows derived from upstream** (`/v1/context`, `x_ext_layer_tier_windows`) | No hand-copied numbers: the layer reports exactly what upstream computed, so the deployment's `--bigger-context` switch (3×) is reflected automatically |
| 6 | **Bounded retry + progress watchdog** | The failure mode this exists for: a stalled browser turn that hangs forever. Now: one upstream attempt, a real-content progress budget, then a loud `504 upstream_no_progress` |
| 7 | **Turn interruption** on client abort or on giving up | A stalled turn must not keep occupying the browser while a retry opens a new one |
| 8 | **Idempotent replay** (explicit `Idempotency-Key` → byte-identical response, `x-ext-layer-replay: true`) | A client that knows a retry is a retry skips a second browser turn |
| 9 | **Empty-completion fail-closed** (`502 empty_turn_content`) | A "completed" turn with no content never poisons the client's history |
| 10 | **OAuth credential refresh** from your existing Codex login | Removes the `login expired` manual re-login loop |
| 11 | **Account capabilities read from upstream home** (`solAvailable`/`proAvailable`) | Free vs Plus vs Pro accounts get the rows they can actually use; unavailable tiers fail loudly (`400`) instead of being silently downgraded |
| 12 | **Observability** — per-request log line, `/healthz` counters, audit of every attempt | You can see what happened instead of guessing |

## Requirements

- **[Bun](https://bun.sh) ≥ 1.1** (the layer runs TypeScript directly; there is no build step).
- **A working upstream**: clone [`miuuyy/codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web) (v5.0.5+), run its own launcher/shell once and log in to ChatGPT, then run `bun run src/cli.ts serve` (default `127.0.0.1:17842`).
- **A ChatGPT account** that can use ChatGPT Web in that browser profile. The layer does not automate login: it reuses the session the upstream shell already established, and refreshes the OAuth access token from your local `auth.json`.

Zero runtime dependencies: `bun-types` is the only dev dependency.

## Quickstart

```bash
# 0. prerequisites: upstream is up on :17842 and logged in
curl -s http://127.0.0.1:17842/healthz

# 1. get this layer
git clone https://github.com/<you>/<this-repo>.git
cd <this-repo>

# 2. configure (optional, but a stable key avoids 401s across restarts)
cp .env.example .env.local
#   edit .env.local: EXT_LAYER_API_KEY=<your key>, EXT_LAYER_UPSTREAM_HOME=<your upstream home>
#   For auto-refresh of the ChatGPT token, also set EXT_LAYER_AUTH_JSON if your
#   login is not at ~/.codex/auth.json.

# 3. install dev deps (tests/typecheck only)
bun install

# 4. run
bun run src/index.ts
#   -> [external-layer] listening on http://127.0.0.1:17843/v1 (upstream http://127.0.0.1:17842)
#   -> [external-layer] api key: sk-ext-layer-...   (printed when you did not set one)

# 5. smoke test
curl -s http://127.0.0.1:17843/healthz
curl -s -H "Authorization: Bearer $EXT_LAYER_API_KEY" http://127.0.0.1:17843/v1/context
```

Windows users can use `scripts\start-external-layer.cmd` / `stop-external-layer.cmd`; POSIX users `scripts/start-external-layer.sh` / `stop-external-layer.sh`.

Then point a client at it:

```bash
curl -s http://127.0.0.1:17843/v1/responses \
  -H "Authorization: Bearer $EXT_LAYER_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"chatgpt-web/latest","reasoning_effort":"high","input":"Reply with the single word PONG."}'
```

## API surface

| Route | Auth | Notes |
|---|---|---|
| `GET /healthz` | none | `{status, requests, last_error?, progress_timeout_ms, retry_limit, active_requests}`; `degraded` clears on the next successful turn |
| `GET /v1/models` | bearer | Unified catalog. `data[].id` lists every tier row plus `chatgpt-web/latest`; `latest` carries the default tier's real window |
| `GET /v1/context` | bearer | The whole context-window contract: `latest_effort`, `bigger_context`, `latest_context_window`, per-tier `tiers{}`, `account{solAvailable,proAvailable,source}`, `source` |
| `POST /v1/responses` | bearer | Standard Responses API (streaming and non-streaming) |
| `POST /v1/chat/completions` | bearer | Chat Completions compatibility surface (streaming included) |

Error codes you will see (all `4xx`/`5xx` with a JSON `error.code`):

`invalid_api_key` · `invalid_reasoning_effort` · `tier_unavailable` · `conflicting_tier` · `empty_turn_content` · `upstream_unreachable` · `upstream_stall_timeout` · `upstream_no_progress` · `tool_round_limit` · `conversation_too_large`

## Model and effort contract

One model id, the tier in the parameter — `reasoning_effort`: `low | medium | high | xhigh | max`.

| effort | upstream tier | notes |
|---|---|---|
| `low` | `chatgpt-web/light` | |
| `medium` | `chatgpt-web/medium` | |
| `high` | `chatgpt-web/high` | default on non-Pro accounts |
| `xhigh` | `chatgpt-web/extra-high` | default on Pro accounts |
| `max` | `chatgpt-web/pro` | requires a Pro account |

The **context window is not a per-tier ladder on Pro accounts** — it is decided by your account type plus the deployment's `--bigger-context` switch. That is exactly why this layer never hardcodes it: ask `/v1/context` and you get whatever upstream computed (`source: "upstream"`), or `unavailable` when there is nothing trustworthy to report.

## Operational behavior

- **One upstream attempt per client request by default.** Retry multiplication (our retries × your client's retries) is what turns a transient browser hiccup into half an hour of spinning. Set `transientRetryLimit` only if your client does not retry.
- **Navigation blips retry on their own cheap budget.** A `page.goto` transport failure (`net::ERR_CONNECTION_CLOSED` at the temporary-chat URL, and siblings) kills the turn at second zero — no prompt attached, zero tokens spent — so retrying it is nearly free. The layer retries these up to `EXT_LAYER_NAV_RETRIES` times (default 2, `0` = off) with a fresh turn id on the same conversation. Generation-stage failures are NOT covered by this budget, and nav failures never count toward the failure breaker (a network blip must not be misdiagnosed as `conversation_too_large`).
- **Progress, not bytes.** Upstream emits a heartbeat every second while the model thinks, so "no bytes" is useless as a liveness signal. The watchdog counts only frames that carry real work (text deltas, tool calls, terminal events) and aborts with `504 upstream_no_progress` after `EXT_LAYER_PROGRESS_MS` (default 240 s) — then it cancels the abandoned browser turn before your retry opens a new one.
- **Break the death spiral.** A fresh ChatGPT conversation pasted with a huge history stalls its own page DOM and fails nearly every time (live data: <20k-token turns completed ~82%, ≥20k-token turns ~2%), and every failure releases the retained tab so the next step re-pastes everything. After ONE big-payload failure in a conversation, the next oversized request on `/v1/responses` gets a synthetic completed response telling the agent to compact the conversation or start a new one — so an agent can act on it (its own compaction tool) instead of burning another doomed turn; A failure counts when the payload clears either gate — `EXT_LAYER_BREAKER_CHARS` (default 150000) or the token cliff `EXT_LAYER_BREAKER_TOKENS` (default 20000 estimated tokens, content-aware) — and "big" means the ~20k-token cliff where the page becomes unreliable, not an absolute size. The refusal is marked with `x-ext-layer-nudge: conversation_too_large`. The `/v1/chat/completions` surface keeps the plain `429 conversation_too_large` refusal after 3 failures with a cooldown (tune with `EXT_LAYER_BREAKER_THRESHOLD` / `EXT_LAYER_BREAKER_CHARS` / `EXT_LAYER_BREAKER_COOLDOWN_MS`, disable with `EXT_LAYER_BREAKER=0`).
- **Idempotent replay is opt-in.** Only an explicit `Idempotency-Key` header (or the `/v1/chat/completions` surface) replays a stored response byte-for-byte with `x-ext-layer-replay: true`. A repeated body on `/v1/responses` runs again on purpose: the unmodified upstream has no such cache, a failed turn is never stored, and silently returning an older turn's text is worse than doing the work. Stored responses are 2xx only.
- **Conversation continuation.** The facade keeps one upstream `thread_id` per client conversation (matched by history prefix, or by `previous_response_id` when the client sends one) and rotates only `turn_id`. The upstream then reuses its retained ChatGPT tab and pastes just the suffix of the transcript instead of retyping the whole history on every step — that is what keeps a long agent run from degrading into 10-minute steps. Every reply carries `x-ext-layer-conversation`. Tune with `EXT_LAYER_CONVERSATION_LIMIT` / `EXT_LAYER_CONVERSATIONS`; `EXT_LAYER_CONTINUATION=0` restores one fresh conversation per step.
- **Client aborts propagate.** If your client disconnects, the browser turn is interrupted instead of running on.

## Tests

```bash
bun test              # offline: mock upstreams, no network, no credentials
bunx tsc --noEmit     # typecheck
```

The offline suite covers protocol translation, auth, tier/effort mapping, context derivation, retry and watchdog budgets, interruption, idempotency, streaming and docs/script contracts.

A handful of tests assert against a **live** stack (real ChatGPT Web turn, ~30 s each). They are opt-in so the default suite stays hermetic:

```bash
EXT_LAYER_LIVE=1 EXT_LAYER_BASE=http://127.0.0.1:17843 EXT_LAYER_API_KEY=<key> bun test tests/w13-equivalence.test.ts
```

## Security and disclaimer

- The layer binds loopback and requires a bearer key. **It ships no default key**: if `EXT_LAYER_API_KEY` is unset, a random per-install key is generated and printed at startup. Never expose the port to a network you do not control.
- Your ChatGPT session is the credential. The layer reuses the login the upstream shell established and refreshes the OAuth token from your local `auth.json`; nothing is sent anywhere except your upstream and OpenAI's own auth endpoint.
- `EXT_LAYER_AUTH_JSON` is read-only for us and never logged. Do not paste token contents into issues.
- Not affiliated with, endorsed by, or supported by OpenAI or the upstream project's authors. Automating the ChatGPT web UI may violate its terms of service — this is your call and your risk, on your own account.
- The contract tests are the specification. If you change behavior, change the contract first.

## Relationship to upstream

This repository contains **none** of the upstream code and none of its shell. The upstream project (MIT) is a dependency you install and run yourself; we only add the layer in front of it. Upstream is expected to be updated freely — the layer talks to it over HTTP only, and derives its context/model facts from that HTTP surface.

---

## 中文速览

**这是什么**：一个独立进程（默认 `127.0.0.1:17843`），对外是标准 OpenAI Responses API（带 apiKey 鉴权），对内把请求翻译成 Codex 原生协议，交给**未经任何修改**的 `codex-chatgpt-web` 上游（默认 `127.0.0.1:17842`）去操作 ChatGPT 网页。

**为什么这么设计**：不 fork 上游，就能一直 `git pull` 跟上游更新；我们所有增强（统一模型档位、重试与进度看门狗、幂等回放、上下文真值、凭证自动刷新、中断传播）都在这一层里，互不干扰。

**三步跑起来**：
1. 先起上游并登录。让官方桌面壳/launcher 登录好 ChatGPT，然后跑 `bun run src/cli.ts serve`（上游仓，默认 17842）。
2. `cp .env.example .env.local`，填 `EXT_LAYER_API_KEY`（不填会随机生成并打印）与 `EXT_LAYER_UPSTREAM_HOME`（你的上游 home 目录，含 `config.json`）。
3. `bun run src/index.ts`，然后把客户端指向 `http://127.0.0.1:17843/v1`，模型填 `chatgpt-web/latest`，档位用 `reasoning_effort`（`low/medium/high/xhigh/max`）。

**上下文窗口**：不要手抄数字。`GET /v1/context` 会返回上游算好的每档窗口（含 `--bigger-context` 的 3 倍开关与账号类型差异）；`/v1/models` 的 `chatgpt-web/latest` 行给出的就是默认档真值。

**排障**：`GET /healthz` 看计数与 `last_error`；日志里每次请求一行 `req=... model=... stream=...`，结束为 `done status=200 elapsed=...` 或 `failed code=... elapsed=...`。常见错误码见上文表格（`upstream_no_progress` = 上游在规定时间内没产出真内容，已被主动中止；`empty_turn_content` = 空回合，绝不入历史）。

**更多细节**：`docs/context-windows.md`（上下文数值怎么来）、`docs/dsh-endpoint-guide.md`（端点/密钥/档位接入全表）、`docs/upstream-gap-audit.md`（哪些能力由上游原样承担）。
