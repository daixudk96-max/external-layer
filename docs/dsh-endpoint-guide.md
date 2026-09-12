# DSH ChatGPT Web 端点使用指南

> 更新时间：2026-09-11 · 当前账号：liuquantant（Pro）· 桌面壳/runtime 全套 5.0.6 · 模型体系：统一模型 `chatgpt-web/latest`

## 一、接入信息

| 项目 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:17843/v1`（外接层；老线 17841 已退役） |
| 对话端点 | `POST /v1/responses`（标准 Responses API）、`POST /v1/chat/completions` |
| 模型列表 | `GET /v1/models`（OpenAI 标准格式 `{"object":"list","data":[{"id":...}]}`） |
| API Key | `sk-dsh-web-cdfedbd300cc0e0ac0b4cc0c4209cd2cadc5271e61f5c103`（**以此为准**：真值来源 `external-layer/src/index.ts:5` 的 `EXT_LAYER_API_KEY` 缺省值。历史上多次抄错成 `...cde**fe**dbd3...`，多一个 `e` 就是 401 `Incorrect API key provided`） |
| 鉴权方式 | `Authorization: Bearer <key>`（timingSafeEqual 比对，长度不符即 401） |
| Key 配置位置 | 环境变量 `EXT_LAYER_API_KEY`（未设则用上面的缺省值）；老线的 key 在 `C:\Users\daixu\.codex-chatgpt-web-dev\config.json` 的 `apiKey` |
| 聊天客户端（DSH provider `codex-website`） | 需要环境变量 `CODEX_WEBSITE_API_KEY` = 上面同一个 key（已写入 User 作用域，**重启宿主后生效**） |

**架构（当前定案）**：客户端（标准 Responses + apiKey）→ **外接层 17843**（我们的全部代码：协议翻译 / 统一模型+五档 / 幂等回放 / 重试 / 工具面 / 看门狗）→ **原版 upstream 17842**（`E:\github\ccw-upstream` @ v5.0.6，**一行未改**，可 `git pull` 随更）→ 桌面壳 + 隧道 + 连接器（沿用老接线口，不新建）。

## 二、启动 / 停止

| 操作 | 文件 |
|---|---|
| 外接层端点 17843：启动 | `E:\github\chatgpt-web-2-api\external-layer\scripts\start-external-layer.cmd`（或 `bun run src/index.ts`，cwd = `external-layer`） |
| 外接层端点 17843：停止 | `E:\github\chatgpt-web-2-api\external-layer\scripts\stop-external-layer.cmd`（只杀监听 17843 的进程，不动上游） |
| 原版 upstream 17842：启动 | `E:\github\chatgpt-web-2-api\scripts\upstream-endpoint-start.cmd [nopause]` |
| 老线 17841（已退役，仅供对照） | `E:\github\chatgpt-web-2-api\scripts\dsh-endpoint-start.cmd [nopause]` / `dsh-endpoint-stop.cmd [nopause]` |

- 加 `nopause` 参数可无交互使用（脚本据此跳过 `pause`；不给参数时仍是双击即用的行为）。
- **`upstream-endpoint-start.cmd` 必须盯 DEV home 的 descriptor**：浏览器宿主是两线共用的一个，descriptor 落在 `C:\Users\daixu\.codex-chatgpt-web-dev\runtime\launcher-browser.json`（原因见 `scripts/upstream-dev-launcher.cmd` 顶部注释：5.0.6 壳拒绝用非 dev-harness 配置启动 DEV runtime）。脚本已按此修正（2026-09-11），此前盯着 upstream home 会必然报 `launcher descriptor did not appear`。
- 冷启动全自动约 35 秒；启动后每步状态可见，按键才关窗。
- 首个回合可能需要 60 秒（会话验证）。
- 改完 `external-layer/src/*` 后必须重启 17843 进程才会加载新代码（`bun run src/index.ts` 不做热重载）。

## 三、模型与档位（统一模型制）

**模型只有一个：`chatgpt-web/latest`**。档位通过请求参数 `reasoning_effort` 选择——和 ChatGPT 网页的档位选择器一一对应：

| reasoning_effort 值 | 网页档位 | 说明 |
|---|---|---|
| `low` | Light | 最快最轻 |
| `medium` | Medium | 均衡 |
| `high` | High | 标准强档 |
| `xhigh` | **Extra High（默认）** | 不传参数时走这档 |
| `max` | Pro | **根本不同的模型**（网页 Pro 档钮），最慢最强，需显式指定，永不作为默认 |

**档位参数的传法（2026-09-11 修复后）**：

- 两种写法都生效，**嵌套优先**：扁平 `{"model":"chatgpt-web/latest","reasoning_effort":"max"}` 或嵌套 `{"model":"chatgpt-web/latest","reasoning":{"effort":"max"}}`。
  （修复前只读嵌套，扁平写法被**静默忽略** → 你要 Pro 却拿到 Extra High。）
- 不传 = `xhigh`（Extra High）。
- **不认识的档位 → HTTP 400**，不再静默降级：
  `{"error":{"message":"unknown reasoning effort \"maxx\" for chatgpt-web/latest; supported values: low, medium, high, xhigh, max","type":"invalid_request_error","code":"invalid_reasoning_effort"}}`
- 真机实测（17843 → 17842 → 网页）：`low` → `chatgpt-web/light` 26.4s completed；`max` → `chatgpt-web/pro` 42.4s completed；`maxx` → 400。
- 别名：`minimal` 等价 `low`。Pro 档在无 Pro 账号上 clamp 回默认档（能力缺失，不是参数错误）。

- **为什么模型名统一**：ChatGPT 网页本来就不提供「选根本模型」的入口（如 5.6 vs 5.5）——它只有档位，根本模型由 OpenAI 服务端决定并随升级自动替换。`latest` 的语义 = 网页当前挂载的根本模型，OpenAI 升级时你的请求零改动。
- **免费号（Luna/Think）完全不变**：免费号下目录仍是 `chatgpt-web/luna` / `chatgpt-web/think` 两个模型名（不走统一制）。免费号没有 reasoning_effort 档位选择。
- 旧的按档位模型名（`chatgpt-web/high` 等五个 slug）**仍然可用**（兼容老集成），但不在模型目录里广告。

## 四、上下文窗口（Pro 账号实测，3 倍开关对比）

上下文数字由服务端按「账号档位 + 3 倍开关」动态计算，客户端不设置。当前 **3 倍上下文已开启**（`experimentalBiggerContext: true`）。

| reasoning_effort（档位） | 未开 3 倍 context / compact | 开 3 倍 context / compact |
|---|---|---|
| `low`（Light） | 111,193 / 95,000（示例 / example） | **333,579 / 285,000（示例 / example）** |
| `medium`（Medium） | 111,193 / 95,000（示例 / example） | **333,579 / 285,000（示例 / example）** |
| `high`（High） | 111,193 / 95,000（示例 / example） | **333,579 / 285,000（示例 / example）** |
| `xhigh`（Extra High，默认档） | 111,193 / 95,000（示例 / example） | **333,579 / 285,000（示例 / example）** |
| `max`（Pro） | 112,193 / 95,000（示例 / example） | **336,579 / 285,000（示例 / example）** |

### 客户端（DSH provider）该填哪个数字

**结论：不拆模型，一个 `chatgpt-web/latest` + `reasoning_effort` 就够；要填的是「客户端 `contextWindow`」这一个数，它跟着 3 倍开关走，不跟着档位走。**

- 本账号（Pro）在同一 3 倍状态下，`low`/`medium`/`high`/`xhigh` **四档同值**，只有 `max`（Pro 档）高 1,000（未开 3 倍）或 3,000（开 3 倍）——差异 ≤0.9%，方向是「`latest` 播报默认档（xhigh）的值」。
- 真正会让窗口变 3 倍的只有 `experimentalBiggerContext`（例如历史实测：**开 → 333,579；关 → 111,193 示例**）。所以「有时大有时小」的来源是这个开关，不是档位。真值请以 `GET /v1/context` 返回为准。
- DSH `settings.yaml` 的 `codex-website` 条目（`contextWindow`）：
  - 3 倍开（示例 / example）→ `333579`（历史实测示例：= xhigh 示例值；选 `max` 时历史示例真值 336,579，填 333,579 只会更早压缩；真值请以 `GET /v1/context` 为准）
  - 3 倍关（示例 / example）→ 改成 `111193`（例如 `max` 档历史示例 112,193；真值请以 `GET /v1/context` 为准）
  - **改开关时必须同步改这个数**：若开关关了而客户端还写 333,579（例如旧历史示例值），客户端会以为还有 3 倍空间、压缩太晚 ⇒ 上游会用自己的限额错误**响亮拒绝**（错误文本里带真实上限），不会静默截断。
- 想知道当前真值，两条命令：`curl -H "Authorization: Bearer <key>" http://127.0.0.1:17843/v1/context`，或直接跑 `external-layer\scripts\show-context.cmd`（它打印同样的东西）。
- 想要**按档位精确**的客户端（而非默认档）：`GET /v1/context` 的 `tiers` 里有五档各自的 `context_window` / `auto_compact_token_limit`；`GET /v1/models` 的 `chatgpt-web/latest` 行也带 `x_ext_layer_tier_windows` 与 `x_ext_layer_latest_effort`。旧的按档位模型名（`chatgpt-web/high` 等）仍可用但不广告。

### 权威契约文档与一键配置脚本

- **上下文窗口完整契约与账号能力指南**：详见 [docs/context-windows.md](context-windows.md)。该文档完整说明了 Pro / Plus / Luna 三种账号形态的模型行暴露规则、统一档位映射、`/v1/context` 端点字段、`tier_unavailable` 与 `conflicting_tier` 错误处理契约。
- **客户端一键配置生成脚本**：运行 `scripts/dsh-models.cmd`（或在 external-layer 目录下运行 `scripts\dsh-models.cmd`）。该脚本从本地运行的 `http://127.0.0.1:17843/v1/context` 端点拉取当前生效的真实上下文数据，打印各档位信息，并输出可直接复制粘贴到 DSH `settings.yaml` 的 YAML 代码片段（包含正确的 `contextWindow` 字段）。

### 3 倍上下文的支持范围

- **账号级开关，Pro/Sol 付费账号下全部档位生效**（不是只有 Pro 档支持）。
- 开关：`config.json` 的 `experimentalBiggerContext`（true/false，改完重启 serve 生效）。桌面壳 UI 的「3 倍上下文」开关写的也是这个键。
- **免费号（Luna/Think）不支持**——免费号走滚动 checkpoint 机制：逻辑窗口 1,050,000，单次浏览器请求硬预算 28,000 tokens。换回免费号时要把开关关掉（否则报 "Bigger Context is unavailable for Luna"）。

### 上下文数字怎么来的、存在哪

- 模型目录里的数字 = 服务端公式计算，不是配置写死的。源头在 `src/chatgpt-web-models.ts`；**外接层只是把上游对应 slug 行的四个字段照实搬过来**（`external-layer/src/models.ts` 的 `deriveTierWindows`），自己不乘系数、不猜：
  - 单条消息边界：`CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT = 103_000`（实测的网页单条消息上限）
  - 基线窗口 = 消息边界 + 平台保留量 + 1 → Pro 账号实测示例 111,193
  - 3 倍 = 基线 × `CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER = 3` → 333,579（计算示例）
  - `GET /v1/models` 的 `context_window` 字段就是计算结果；`GET /v1/context` 给五档全量 + 当前开关状态
- **对话历史：客户端是唯一写者**。provider 不替你存长历史，每回合按请求的 `input` + `previous_response_id` 链构建传输。
- **响应快照**（供 `previous_response_id` 回放）：`C:\Users\daixu\.codex-chatgpt-web-dev\responses-state.json`。
- **传输机制**：浏览器单段预算 28,000 tokens；开 3 倍后自动拆 multipart 3 段，**服务端全自动切分，Agent 端零改动**。
- **硬约束**：单条消息 ≤103K tokens（约 40 万字符）——服务端不切开单条消息。长历史拆多条消息或用 `previous_response_id` 链。
- 极限场景（单回合塞多条超大消息）需要 turn_id 绑定：每条 user 消息带 `internal_chat_message_metadata_passthrough.turn_id` + 请求级 `client_metadata["x-codex-turn-metadata"].turn_id`，两者一致，最后一条 user 消息加 `id`。参考脚本 `C:\Users\daixu\AppData\Local\Temp\t-treble.cjs`（228K tokens 实测通过）。

## 五、快速上手

### curl

```bash
curl http://127.0.0.1:17843/v1/responses \
  -H "Authorization: Bearer sk-dsh-web-cdfedbd300cc0e0ac0b4cc0c4209cd2cadc5271e61f5c103" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"chatgpt-web/latest\",\"input\":\"Reply with the single word PONG and nothing else.\",\"stream\":false}"
```

选档位（例如 Pro 档）：

```bash
-d "{\"model\":\"chatgpt-web/latest\",\"reasoning\":{\"effort\":\"max\"},\"input\":\"...\",\"stream\":false}"
```

（`reasoning.effort` 是标准 Responses API 字段；`low`/`medium`/`high`/`xhigh`/`max` 均可。）

### OpenAI SDK（Python）

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:17843/v1", api_key="sk-dsh-web-cdfedb...")
r = client.responses.create(model="chatgpt-web/latest", input="你好，介绍一下你自己")
print(r.output_text)

# 指定档位（Extra High）：
r = client.responses.create(model="chatgpt-web/latest",
    reasoning={"effort": "xhigh"}, input="复杂分析任务...")
```

### 链式对话（previous_response_id）

```python
r1 = client.responses.create(model="chatgpt-web/latest", input="记住暗号是菠萝")
r2 = client.responses.create(model="chatgpt-web/latest",
    previous_response_id=r1.id, input="暗号是什么？")
```

### 工具循环（Agent 用）

请求里声明标准 `tools`（function），模型发起 `function_call` → 客户端执行 → 以 `function_call_output` + `previous_response_id` 续回合，直到模型给出最终文本。服务端有自动重试预算兜底抽签拦截。

### turn_id 幂等（可选）

同一 `turn_id` 重发 → 毫秒级回放已存响应（不重复执行）。Agent 每个新任务用新 id，重试用同 id：

```json
{"model":"chatgpt-web/latest","input":"...","client_metadata":{"x-codex-turn-metadata":{"turn_id":"task-42"}}}
```

## 六、已知限制与运维

| 事项 | 说明 |
|---|---|
| 安全抽签拦截 | OpenAI 云端安全层对部分工具调用有非确定性误拦（官方已确认的 pre-MCP 误拦），端点侧已内置重试预算兜底；偶发失败重试即可 |
| max_output_tokens | **不需要设置**。参数会被接受但静默不生效（网页回合由模型自然结束 end_turn 决定输出长度，无硬上限）；客户端默认值不会截断长回复 |
| 瞬时错误自动重试 | 端点对 OpenAI 云端瞬时故障（Something went wrong / stopped responding / server_is_overloaded / 会话检查超时）**自动重试，默认 5 次**（退避 2s/4s/6s/8s/10s），流式与非流式均生效（流式仅在已输出正文/工具调用后停止重试）。预算：config `chatgptWeb.transientRetryLimit`（0-10，默认 5，改完重启 serve） |
| 换号流程 | ①双击 stop ②桌面壳登出新号 ③新账号下确认/重建连接器 `Codex Native2 DEV`（Tunnel/None/Allow all actions）④改 config 的 `solAvailable`/`proAvailable`（免费号再关 `experimentalBiggerContext`）⑤双击 start |
| 模型目录裁剪 | 免费号目录 = `chatgpt-web/luna`/`think`；Pro 号目录 = `chatgpt-web/latest` 一行；请求不存在的 slug 会报错 |
| 桌面壳两个窗口 | 带 Dev 按钮 = 端点专用宿主（别关）；不带 = 日常用，登录互不影响 |
| 端口冲突 | 17843 被占时 start 脚本会误报 already——用 `external-layer\scripts\stop-external-layer.cmd` 再 start；取 pid 用 `netstat -ano \| grep LISTEN \| grep ":17843" \| awk '{print $NF}'` |

## 七、文件位置速查

| 内容 | 路径 |
|---|---|
| 启动/停止脚本 | `E:\github\chatgpt-web-2-api\scripts\dsh-endpoint-{start,stop}.cmd` |
| 服务端配置（key/档位开关/3 倍开关） | `C:\Users\daixu\.codex-chatgpt-web-dev\config.json` |
| 响应快照（幂等回放） | `C:\Users\daixu\.codex-chatgpt-web-dev\responses-state.json` |
| serve 运行日志 | `C:\Users\daixu\AppData\Local\Temp\dsh-serve.log` |
| launcher 运行日志 | `C:\Users\daixu\AppData\Local\Temp\dsh-launcher.log` |
| provider 源码 | `E:\github\chatgpt-web-2-api\provider\codex-chatgpt-web`（bun 直接跑 TS） |
| 上下文数字计算源头 | `src/chatgpt-web-models.ts`（103,000 消息边界 ×3 = 333,579 的历史计算示例） |