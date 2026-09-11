# w13 — 浏览器层等价性抽样验证（claim / probe / raw evidence）

> 本文件是**等价性抽样证据报告**。所有 `RAW` 块都是真机探针输出的逐字粘贴（只按长度截断，不改写任何字段）。
> 它同时被 `external-layer/tests/w13-equivalence.test.ts` 机器复核，因此下列文法是**契约**：

| 文法 | 用途 |
| --- | --- |
| `^CLAIM: C<d>.<n> \| 一句话断言 \| EVIDENCE: 证据出处` | 单条声明；每条都必须是**已证**状态 |
| `^TIER: <effort> => <slug>` | 档位阶梯，必须与 `src/models.ts` 的 `CHATGPT_WEB_UNIFIED_TIERS` 逐项一致 |
| `^ELAPSED_SECONDS: C<n> = <秒>` | 真机回合的实测耗时（数值，秒，保留 3 位小数） |
| `^RECORDED_MODEL: C<n> = <slug>` | 真机回合响应体里的 `model` 字段原值 |
| `resp_[0-9a-f]{16,}` / `call_[A-Za-z0-9_-]{20,}` | 真机响应 id / 真机工具调用 id |

**背景**：外接层刻意**没有**移植旧浏览器层特性（`browser-tab-pool.ts`、`chat-mode-guard.ts`、`family-effort-verifier.ts`、`prodex-slider-driver.ts`），理由是「上游已实现」。这一波的唯一任务，就是把「上游已实现」从一句断言变成**可复核、可重跑的现场证据**。
抽样策略：便宜且确定的契约探针全量跑（C4），昂贵的真机回合只做最小必要采样（C1 / C2 各 1 次），幂等回放单独验（C3，第二次不花浏览器回合）。

---

## 环境现场

- **date**：2026-09-11，探针窗口 `2026-09-11T15:08Z`–`2026-09-11T15:09Z`（本地 `2026-09-11 23:08`–`23:09`，UTC+8）。
- **17843 外接层（我们的代码）**：`healthz` HTTP 200，原始体 `{"status":"ok","requests":3}`；监听 `0.0.0.0:17843`，pid `29424`（`netstat -ano` 现场取证）。无 `last_error` 字段 ⇒ 未被降级。
- **17842 上游（逐字节原始 upstream）**：`healthz` HTTP 200，原始体见下；pid `35556`，版本 `5.0.6`，`mode":"full"`，`accepting_turns":true`，`active_http_turns":0`，`active_browser_turns":0`。
- **桌面壳 descriptor（浏览器宿主现场）**：`C:\Users\daixu\.codex-chatgpt-web-dev\runtime\launcher-browser.json`（**dev home** —— 见 `docs/dsh-endpoint-guide.md`，两条线共用一个浏览器宿主，descriptor 必须落在 dev home）。现场状态：`kind":"codex-web-gpt-launcher"`，`profile":"development"`，`pid":2720`，`surfaceId":"ZwvNai_NR3FDtWZU0XevQzbNqP8cDLBv"`，`partition":"persist:codex-web-gpt-dev-chatgpt"`，`createdAt":"2026-09-11T15:09:31.129Z"`；`control.token` 已脱敏，不入档。
- **API key**：仓库文档化的**本地默认 dev key**（`src/index.ts` 的 `EXT_LAYER_API_KEY` 缺省值，形如 `sk-dsh-web-cdfe…`）。仅本地环回可用；本文件不引入任何其他凭据。

RAW — 17842 `/healthz`（窗口内两次取值，字段一致，仅 `uptime` 递增）：
```
{"status":"ok","service":"codex-chatgpt-web","version":"5.0.6","mode":"full","pid":35556,"port":17842,"uptime":8574.614,"accepting_turns":true,"successful_model_catalog_requests":3,"last_successful_model_catalog_request_at":"2026-09-11T13:36:53.761Z","active_http_turns":0,"active_browser_turns":0}
{"status":"ok","service":"codex-chatgpt-web","version":"5.0.6","mode":"full","pid":35556,"port":17842,"uptime":8635.081,"accepting_turns":true,"successful_model_catalog_requests":4,"last_successful_model_catalog_request_at":"2026-09-11T15:07:51.189Z","active_http_turns":0,"active_browser_turns":0}
```

RAW — 端口现场（`netstat -ano`，证明 17843 与 17842 是两个独立进程，且 17843 有一个到 17842 的 ESTABLISHED 连接）：
```
  TCP    0.0.0.0:17843          0.0.0.0:0              LISTENING       29424
  TCP    127.0.0.1:17842        0.0.0.0:0              LISTENING       35556
  TCP    127.0.0.1:17842        127.0.0.1:50066        ESTABLISHED     35556
  TCP    127.0.0.1:50066        127.0.0.1:17842        ESTABLISHED     29424
```

---

## C0 结构断言（可机器复核）

这一节把「外接层的档位阶梯」「上游现场」固化成机器可读行，供 `w13-equivalence.test.ts` 直接与 `src/models.ts` 对齐。

CLAIM: C0.1 | 档位阶梯是 `src/models.ts` 里 `CHATGPT_WEB_UNIFIED_TIERS` 的五档，且 `chatgpt-web/latest` 的 `reasoning_effort` 逐档映射到对应上游 slug | EVIDENCE: 下方 TIER 行 vs `src/models.ts:56-62`；live 目录 `supported_reasoning_levels` 五档与之一一对应（见 C4.2 RAW）。

TIER: low => chatgpt-web/light
TIER: medium => chatgpt-web/medium
TIER: high => chatgpt-web/high
TIER: xhigh => chatgpt-web/extra-high
TIER: max => chatgpt-web/pro

CLAIM: C0.2 | 统一目录只广告一行 `chatgpt-web/latest`，默认档是 `xhigh`，`max`（Pro）按能力过滤 | EVIDENCE: C4.2 RAW 的 `data[].id` 长度 1、`default_reasoning_level":"xhigh"`、`supported_reasoning_levels` 五档含 `max`。

CLAIM: C0.3 | 外接层与上游是**两个独立进程**，外接层经环回连接上游，未内联上游 | EVIDENCE: 上方 `netstat -ano` 原文（17843 pid 29424 → 17842 pid 35556）。

---

## C1 档位真的到达浏览器（low → chatgpt-web/light）

**claim**：标准 Responses 客户端用 `reasoning_effort:"low"` 请求 `chatgpt-web/latest`，档位**真的穿透到浏览器会话**——响应体的 `model` 字段被改写成该档位对应的上游 slug `chatgpt-web/light`，并且是一次真实、完整的浏览器回合（耗时为数十秒量级，`status:"completed"`，`output_text` 是模型真答）。

**probe command**（Windows Git Bash；真机回合 1/2）：
```bash
curl -s -m 150 -o resp1.json -D resp1.headers -w "HTTP:%{http_code} t=%{time_total}\n" \
  -X POST http://127.0.0.1:17843/v1/responses \
  -H "Authorization: Bearer <DEV_KEY>" -H "content-type: application/json" \
  -d '{"model":"chatgpt-web/latest","reasoning_effort":"low","input":"Reply with the single word PONG."}'
```

**RAW response excerpt**：
```
HTTP/1.1 200 OK
Content-Type: application/json;charset=utf-8
Date: Fri, 11 Sep 2026 15:08:23 GMT
Content-Length: 427
```
```json
{"id":"resp_063681f2d8e34f8c89415126b493614c","object":"response","created_at":1789139304,"status":"completed","model":"chatgpt-web/light","output":[{"type":"message","id":"msg_bb4cd9c6410c431c87e4b88f1bea5d86","role":"assistant","status":"completed","content":[{"type":"output_text","text":"PONG","annotations":[]}],"phase":"final_answer"}],"end_turn":true,"usage":{"input_tokens":8944,"output_tokens":18,"total_tokens":8962}}
```

ELAPSED_SECONDS: C1 = 28.721
RECORDED_MODEL: C1 = chatgpt-web/light

CLAIM: C1.1 | `reasoning_effort:"low"` 被映射到上游 slug `chatgpt-web/light`，并真实产出一个 completed 的浏览器回合 | EVIDENCE: 上方 RAW —— 响应体 `"model":"chatgpt-web/light"`（`chatgpt-web/latest` 这个 id 在上游并不存在，出现 light 只能来自档位映射）、`"status":"completed"`、`output_text` = `PONG`。

CLAIM: C1.2 | 该回合是**真浏览器回合**而非本地伪造/短路：实测耗时 28.721 s（数量级与真机聊天一致），且产出了真实的 usage 与消息 id | EVIDENCE: 上方 `t=28.720811`、`msg_bb4cd9c6410c431c87e4b88f1bea5d86`、`usage.input_tokens=8944`。

CLAIM: C1.3 | 档位驱动（旧 `family-effort-verifier.ts` / `prodex-slider-driver.ts` 的职责）在未移植的前提下由上游完整承担 | EVIDENCE: C1.1 的 slug 改写 + C0.1 的阶梯一致 + 上游 17842 在窗口内 `active_browser_turns` 归零前确实承接了回合（C1.1 的 28.721 s）。

---

## C2 工具声明仍能换回 function_call（connector + tunnel 链路完好）

**claim**：客户端在请求里声明一个 `read_file` function 工具并指示模型必须调用，外接层原样转发 `tools` / `tool_choice` 后，**上游确实从浏览器会话换回了真正的 `function_call` item**，带真实 `call_…` id 与函数名——即 connector + tunnel（工具声明 → 浏览器 → 工具调用回流）整条链路未被移植工作破坏。

**probe command**（真机回合 2/2）：
```bash
curl -s -m 150 -o resp3.json -D resp3.headers -w "HTTP:%{http_code} t=%{time_total}\n" \
  -X POST http://127.0.0.1:17843/v1/responses \
  -H "Authorization: Bearer <DEV_KEY>" -H "content-type: application/json" -d @body2.json
# body2.json:
# {"model":"chatgpt-web/latest","reasoning_effort":"low",
#  "input":"You MUST call the read_file tool. Do not reply with text. Call read_file exactly once with path \"E:/github/chatgpt-web-2-api/external-layer/package.json\".",
#  "tools":[{"type":"function","name":"read_file","description":"Read a UTF-8 text file from disk.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}],
#  "tool_choice":"required"}
```

**RAW response excerpt**：
```
HTTP/1.1 200 OK
Content-Type: application/json;charset=utf-8
Date: Fri, 11 Sep 2026 15:08:57 GMT
Content-Length: 479
```
```json
{"id":"resp_2d983d569bc14c22b72841ff16aedc80","object":"response","created_at":1789139337,"status":"completed","model":"chatgpt-web/light","output":[{"type":"function_call","id":"fc_90074b09fc2b462dbf0bdce9ee7df248","call_id":"call_GDrqV1h4IDuzBu9fPwK_XVscNvkBTy4H","name":"read_file","arguments":"{\"path\":\"E:/github/chatgpt-web-2-api/external-layer/package.json\"}","status":"completed"}],"end_turn":false,"usage":{"input_tokens":8975,"output_tokens":70,"total_tokens":9045}}
```

ELAPSED_SECONDS: C2 = 17.293
RECORDED_MODEL: C2 = chatgpt-web/light

CLAIM: C2.1 | 声明 `read_file` 工具后，响应体含 `type:"function_call"` 的 output item，`call_id` 是真实的上游工具调用 id | EVIDENCE: 上方 RAW `"call_id":"call_GDrqV1h4IDuzBu9fPwK_XVscNvkBTy4H"`（32 字符 base64url，`call_` 前缀由上游生成，外接层不铸造）。

CLAIM: C2.2 | 函数名与参数由模型经浏览器链路正确回填，未在外接层被改写 | EVIDENCE: 上方 RAW `"name":"read_file"`、`"arguments":"{\"path\":\"E:/github/chatgpt-web-2-api/external-layer/package.json\"}"`，与 C2 probe 的声明逐字一致。

CLAIM: C2.3 | 工具回合并未被伪装成文本答复：`end_turn:false` 且 output 只有 function_call 一项（无 message item） | EVIDENCE: 上方 RAW `"end_turn":false`、`output` 数组长度 1 且 `type:"function_call"`。

---

## C3 幂等回放（同 body 第二次毫秒级 + 逐字节一致）

**claim**：**完全相同**的请求体第二次发送时，外接层不新开浏览器回合，而是直接回放首次缓存：带 `x-ext-layer-replay: true` 响应头、毫秒级返回、**响应体与首次逐字节一致**。幂等键 = `sha256(stableStringify(标准请求体))`（`src/idempotency.ts` 的 `deriveIdempotencyKey`），因此不需要 `Idempotency-Key` 头也能命中。

**probe command**：
```bash
# 1) 首次：见 C1（耗时 28.721 s，无 x-ext-layer-replay 头）
# 2) 立刻重复同一个 body1.json：
curl -s -m 20 -o resp2.json -D resp2.headers -w "HTTP:%{http_code} t=%{time_total}\n" \
  -X POST http://127.0.0.1:17843/v1/responses \
  -H "Authorization: Bearer <DEV_KEY>" -H "content-type: application/json" -d @body1.json
cmp resp1.json resp2.json
```

**RAW response excerpt（回放）**：
```
HTTP/1.1 200 OK
Content-Type: application/json;charset=utf-8
x-ext-layer-replay: true
Date: Fri, 11 Sep 2026 15:08:29 GMT
Content-Length: 427
```
```
$ cmp resp1.json resp2.json && echo BYTE-IDENTICAL
BYTE-IDENTICAL
$ ls -l resp1.json resp2.json
-rw-r--r-- 1 daixu 197609 427 Sep 11 23:08 resp1.json
-rw-r--r-- 1 daixu 197609 427 Sep 11 23:08 resp2.json
```

CLAIM: C3.1 | 同 body 第二次请求返回 200 且带响应头 `x-ext-layer-replay: true` | EVIDENCE: 上方 RAW headers 原文。

CLAIM: C3.2 | 回放耗时 0.002914 s（< 1 s，即未触达浏览器），相对首次 28.721 s | EVIDENCE: 上方 `t=0.002914` vs C1 的 `t=28.720811`。

CLAIM: C3.3 | 回放体与首答体逐字节一致（427 B = 427 B，`cmp` 静默通过） | EVIDENCE: 上方 `cmp` 输出 `BYTE-IDENTICAL` 与两份 `ls -l` 的 427 字节。

---

## C4 输入校验在触达浏览器前生效（未知档位 400、错误 apiKey 401）

**claim**：所有廉价校验都在**打开上游回合之前**返回，因此既不花钱也不占用浏览器：未知档位 → HTTP 400 `invalid_reasoning_effort`；错误 apiKey → HTTP 401 `invalid_api_key`。两者耗时均为毫秒级，反证「未触达浏览器」。

**probe command**：
```bash
curl -s -m 10 -w "\nHTTP:%{http_code} t=%{time_total}\n" http://127.0.0.1:17843/healthz
curl -s -m 10 -w "\nHTTP:%{http_code} t=%{time_total}\n" -H "Authorization: Bearer <DEV_KEY>" http://127.0.0.1:17843/v1/models
curl -s -m 10 -w "\nHTTP:%{http_code} t=%{time_total}\n" -X POST http://127.0.0.1:17843/v1/responses \
  -H "Authorization: Bearer <DEV_KEY>" -H "content-type: application/json" \
  -d '{"model":"chatgpt-web/latest","reasoning_effort":"maxx","input":"hi"}'
curl -s -m 10 -w "\nHTTP:%{http_code} t=%{time_total}\n" -X POST http://127.0.0.1:17843/v1/responses \
  -H "Authorization: Bearer sk-wrong" -H "content-type: application/json" \
  -d '{"model":"chatgpt-web/latest","input":"hi"}'
curl -s -m 10 -w "\nHTTP:%{http_code} t=%{time_total}\n" -H "Authorization: Bearer sk-wrong" http://127.0.0.1:17843/v1/models
```

**RAW response excerpt**：
```
=== healthz ===
{"status":"ok","requests":3}
HTTP:200 t=0.001964
=== unknown tier ===
{"error":{"message":"unknown reasoning effort \"maxx\" for chatgpt-web/latest; supported values: low, medium, high, xhigh, max","type":"invalid_request_error","code":"invalid_reasoning_effort"}}
HTTP:400 t=0.002997
=== bad key ===
{"error":{"message":"Incorrect API key provided","type":"authentication_error","code":"invalid_api_key"}}
HTTP:401 t=0.002534
=== bad key /v1/models ===
{"error":{"message":"Incorrect API key provided","type":"authentication_error","code":"invalid_api_key"}}
HTTP:401 t=0.001536
```

`GET /v1/models` 200 的 `data[]`（完整 `models[]` 行很长，这里保留判定所需的头部字段）：
```json
{"object":"list","data":[{"id":"chatgpt-web/latest","object":"model"}],"models":[{"slug":"chatgpt-web/latest","prefer_websockets":true,"support_verbosity":true,"default_verbosity":"low","apply_patch_tool_type":"freeform","web_search_tool_type":"text_and_image","input_modalities":["text","image"],"supports_image_detail_original":true,"truncation_policy":{"mode":"tokens","limit":10000},"supports_parallel_tool_calls":true,"tool_mode":null,"multi_agent_version":"v1","multi_agent_reasoning_effort":"xhigh","use_responses_lite":true,"include_skills_usage_instructions":false,"include_apps_usage_instructions":false,"include_plugin_usage_instructions":false,"guardian":null,"node_repl_auto_review_required":true,"node_repl_disabled":false,"requires_sandboxed_review":false,"auto_review_model_override":null,"model_specialty":null,"context_window":272000,"max_context_window":872000,"auto_compact_token_limit":null,"comp_hash":"3000","default_reasoning_summary":"none","display_name":"ChatGPT Web — Latest","description":"Unified ChatGPT Web model. Pick the tier via reasoning_effort: low=Light, medium=Medium, high=High, xhigh=Extra High (default), max=Pro.","default_reasoning_level":"xhigh","supported_reasoning_levels":[{"effort":"low","description":"ChatGPT Web — Light"},{"effort":"medium","description":"ChatGPT Web — Medium"},{"effort":"high","description":"ChatGPT Web — High"},{"effort":"xhigh","description":"ChatGPT Web — Extra High"},{"effort":"max","description":"ChatGPT Web — Pro"}],"shell_type":"shell_command","visibility":"list","minimal_client_version":"0.153.0","supported_in_api":true,…
```

CLAIM: C4.1 | `GET /healthz` 返回 200 且 `status:"ok"`（无 `last_error` ⇒ 未降级） | EVIDENCE: 上方 `{"status":"ok","requests":3}` + `HTTP:200 t=0.001964`。

CLAIM: C4.2 | `GET /v1/models`（正确 bearer）返回 200，`data[].id` 恰为 `["chatgpt-web/latest"]`，且上行能力（`context_window:272000` 等）继承自上游 live 目录 | EVIDENCE: 上方 models RAW 的 `data` 与 `default_reasoning_level:"xhigh"`。

CLAIM: C4.3 | 未知档位 `"maxx"` 返回 **HTTP 400**、`code:"invalid_reasoning_effort"`，且错误消息列出五档合法值；耗时 0.002997 s ⇒ 未触达浏览器 | EVIDENCE: 上方 unknown tier RAW。

CLAIM: C4.4 | 错误 apiKey 在 `/v1/responses` 与 `/v1/models` 上均返回 **HTTP 401**、`code:"invalid_api_key"`，耗时毫秒级 | EVIDENCE: 上方两条 bad key RAW。

CLAIM: C4.5 | 校验是**fail-closed**的：档位解析发生在任何上游 `fetch` 之前（`src/external-layer.ts:462-477` 先 `mapRequestModel` 抛 `UnknownEffortError` 再返回），因此错误请求不可能被静默降级成别的档位 | EVIDENCE: C4.3 的 400 + C1.1 的 slug 改写路径；代码位置 `src/external-layer.ts:462-477`。

---

## C5 结论与残余风险（哪些等价性已证、哪些未证、下一步）

### 已证等价（本次抽样覆盖）

| 旧浏览器层特性 | 未移植 | 等价性证据 |
| --- | --- | --- |
| `prodex-slider-driver.ts`（档位驱动） | 是 | C1.1/C1.2：`reasoning_effort:"low"` → 上游 slug `chatgpt-web/light`，真实 completed 回合 28.721 s |
| `family-effort-verifier.ts`（档位校验） | 是 | C0.1 阶梯一致 + C4.3 未知档位 400 fail-closed |
| `chat-mode-guard.ts`（模式护栏） | 是 | C2：`tools` + `tool_choice:"required"` 原样转发后仍换回真 `function_call` |
| `browser-tab-pool.ts`（浏览器池/connector） | 是 | C2 的 `call_…` id 与 C0.3 的 17843→17842 独立进程链路 |
| （外接层自有）幂等回放 | — | C3：0.002914 s 回放 + `x-ext-layer-replay: true` + 逐字节一致 |

### 本波次**未**证明的等价性（残余风险，按风险从高到低）

1. **档位阶梯只采样了 `low` 一档**。`medium` / `high` / `xhigh` / `max` 四档本次**没有任何真机回合**（每次真机回合 25–45 s，本轮预算上限 2 次，已全部用掉）。因此「五档全部真的到达浏览器且互不相同」是一个**推断**：C0.1 只证明了映射表与目录一致，`max`（Pro）档是否真的走**不同的 root model**、以及各档之间是否真的产生**可观测的质量/耗时差异**，均未被观测。
2. **`tool_choice` 只验了 `"required"`**。`"auto"` / `"none"` 与**并行工具调用**（目录自称 `supports_parallel_tool_calls:true`）未采样。
3. **工具回路只走了「第一次 function_call」**。`function_call_output` 回填后的**第二轮续跑**（tool result → 模型继续）未在同一现场验证；`tests/w9-tool-surface.test.ts` 覆盖的是一侧 mock 的上游，不是真浏览器。
4. **回放只验了非流式 `/v1/responses`**。`/v1/chat/completions` 的非流式与流式回放分支（`src/external-layer.ts:413-441`）本次未现场取证。
5. **失败面完全未抽样**：浏览器掉线 / tunnel 断开 / 凭据过期的现场行为，本波次没有任何证据（这正是 `w10` 停滞与重试波次的地盘）。
6. **采样是单次快照**：30 秒级耗时与毫秒级回放都是单次观测，未做重复测量，不能当作时延 SLA。

### 下一步（建议）

- 若要把风险 1 关掉：用 `w13-probe.py` 那类脚本在**独立波次**里逐档各跑 1 次真机回合，把每档的 `RECORDED_MODEL` 与耗时追加进 C1/C0，然后重跑 `bun test tests/w13-equivalence.test.ts` 复核。
- 风险 3 建议在 `w9` 的真机探针族（`research/w9-tool-*.py`）里补一轮「function_call → function_call_output → 续跑」。
- 本文件的 claim 一旦被扩写，必须保持 `^CLAIM: C\d` 行式与**无未证标记**，否则 `w13-equivalence.test.ts` 会立刻转红——这是刻意的：该测试就是本报告完整性的门。
