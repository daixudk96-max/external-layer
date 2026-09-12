# 上游请求行为面覆盖审计报告 (Upstream Request Surface Audit)

## 概述与审计基准

本报告对独立外接层（external-layer）与原版上游服务（codex-chatgpt-web）之间**客户端可见的行为面**逐条对照审计。
外接层的职责是在保证上游原样运行（零改动、可随时 `git pull`）的前提下，为外部客户端提供标准 Responses API 门面与 OpenAI 兼容接口，并承载会话连续性、统一模型档位映射、幂等回放、超时看门狗、失败熔断与导航级自愈重试。

审计以**真实代码行为**为唯一事实依据，审计纪律为「新机制禁令」：任何外接层自造机制，都必须先证明上游没有该能力或该能力不可用，才允许实现。

### 审计度量基准源

- 上游服务路由与分发中心：`E:/github/ccw-upstream/src/server.ts`
- 上游请求规范与模式定义：`E:/github/ccw-upstream/src/responses/schema.ts`
- 上游协议桥接与事件流生成器：`E:/github/ccw-upstream/src/bridge.ts`
- 上游错误分类与状态推导规则：`E:/github/ccw-upstream/src/lib/errors.ts`
- 上游适配层异常封装：`E:/github/ccw-upstream/src/adapters/chatgpt-web/adapter-error.ts`
- 上游适配层运行时状态与信任身份：`E:/github/ccw-upstream/src/adapters/chatgpt-web/index.ts`
- 外接层核心服务实现：`src/external-layer.ts`
- 外接层请求透传模块：`src/passthrough.ts`
- 外接层协议转译与流式封装：`src/chat-completions.ts`
- 外接层瞬态错误族与导航错误识别：`src/reliability.ts`

### 覆盖判定标准

每一项客户端可见行为面必须确切归入以下三个判定结论之一：

- `PORTED`：外接层已完整承接该项能力，提供等价或增强实现，并具备可定位代码证据。
- `MISSING`：上游具备、属客户端可见行为面、外接层当前版本尚未支持。
- `DROPPED`：上游存在但外接层经架构权衡后主动放弃，并在本报告给出决策依据。

TOTALS: 27 ported, 0 missing, 3 dropped

---

## A. Routes

路由层是面向网络客户端暴露的第一道表面。外接层作为协议门面，逐条承接上游路由：对话与模型目录路由完整代理，上游内部的进程控制路由（`/admin/*`）由外接层**内部**消费而不对外暴露。

| id | route | upstream | facade | verdict | evidence | rationale |
|---|---|---|---|---|---|---|
| r-route-post-responses | POST /v1/responses | E:/github/ccw-upstream/src/server.ts:987 | src/external-layer.ts:767 | PORTED | src/external-layer.ts:767 | 核心对话入口：请求解析、会话认领、断连中断广播、看门狗与重试兜底、流式/非流式双路径 |
| r-route-post-chat-completions | POST /v1/chat/completions | 无（外接层架构增强） | src/external-layer.ts:768 | PORTED | src/external-layer.ts:768 | 兼容经典 OpenAI 客户端生态的双向协议转换与流式事件重组门面 |
| r-route-get-models | GET /v1/models | E:/github/ccw-upstream/src/server.ts:946 | src/external-layer.ts:1904 | PORTED | src/external-layer.ts:1904 | 模型目录：账号能力、按档位拆行、上下文窗口真值全部由上游行派生 |
| r-route-get-context | GET /v1/context | 无（外接层架构增强） | src/external-layer.ts:1853 | PORTED | src/external-layer.ts:1853 | 档位阶梯、3 倍窗口开关、账号能力来源与载荷悬崖阈值的可查询元数据 |
| r-route-get-healthz | GET /healthz | E:/github/ccw-upstream/src/server.ts:807 | src/external-layer.ts:1936 | PORTED | src/external-layer.ts:1936 | 探活：请求计数、活跃请求、进度预算、重试上限与最近错误 |
| r-route-post-responses-compact | POST /v1/responses/compact | E:/github/ccw-upstream/src/server.ts:1001 | src/passthrough.ts:3 | PORTED | src/passthrough.ts:3 | 显式上下文压缩路由，逐字节透传请求体与响应体，不经幂等层 |
| r-route-get-responses | GET /v1/responses | E:/github/ccw-upstream/src/server.ts:981 | src/passthrough.ts:4 | PORTED | src/passthrough.ts:4 | WebSocket 升级提示路由，上游 426 与说明文本原样到达客户端 |
| r-route-post-alpha-search | POST /v1/alpha/search | E:/github/ccw-upstream/src/server.ts:1015 | src/passthrough.ts:5 | PORTED | src/passthrough.ts:5 | 原生搜索代理路由，请求与响应原样转发 |
| r-route-admin-interrupt | POST /admin/interrupt-turn | E:/github/ccw-upstream/src/server.ts:860 | src/external-layer.ts:174 | PORTED | src/external-layer.ts:174 | 回合中断由外接层内部消费（客户端断连、进度超时、上游失败三种触发），刻意不对客户端暴露运维面 |
| r-route-images-native | POST /v1/images/* 图像接口群 | E:/github/ccw-upstream/src/server.ts:1025 | 无 | DROPPED | E:/github/ccw-upstream/src/server.ts:1025 | 图像生成与编辑端点；外接层定位为文本与工具交互网关，不代理多媒体生成 |

### 路由分析与设计决策

1. `POST /v1/responses`：主对话入口，承担标准请求解析、`ConversationRegistry` 线程认领、断连时向 `/admin/interrupt-turn` 广播中止、流式内容进度看门狗与导航级重试。
2. `POST /v1/chat/completions`：外接层独有增强路由，内部双向转换为 Responses 契约，并为心跳帧补 SSE 注释保持连接活跃。
3. `GET /v1/models` 与 `GET /v1/context`：把上游账号能力与档位真值暴露给客户端，规避手填窗口数字导致的静默错配。
4. `src/passthrough.ts` 的三条路由：不做协议转换、不做幂等缓存、不铸造会话头，仅替换鉴权头后原样转发并回传上游状态与正文。

进程控制面（`/admin/drain`、`/admin/resume`、`/admin/shutdown`、`/admin/cancel-turn`、`/admin/cancel-turns`）与图像面不对外暴露；其中 `/admin/interrupt-turn` 是外接层维持「放弃的回合必须立即停止占页面」这一不变量所必需的内部依赖。

---

## B. Request fields

请求字段定义客户端调用 `POST /v1/responses` 时可传递的控制参数与载荷。上游在 `E:/github/ccw-upstream/src/responses/schema.ts` 中定义校验模式；外接层必须保证合法参数被正确理解、转换或透明传递。

| id | field | upstream schema | facade handling | verdict | evidence | rationale |
|---|---|---|---|---|---|---|
| r-field-model | model | E:/github/ccw-upstream/src/responses/schema.ts:147 | src/external-layer.ts:1055 | PORTED | src/external-layer.ts:1055 | 解析目标模型标识并映射为统一模型或对应档位 slug，开启上游回合前即完成校验 |
| r-field-input | input | E:/github/ccw-upstream/src/responses/schema.ts:148 | src/external-layer.ts:225 | PORTED | src/external-layer.ts:225 | 输入规范化：抽取用户消息、历史项与环境信封，供会话认领与原生请求构造使用 |
| r-field-stream | stream | E:/github/ccw-upstream/src/responses/schema.ts:156 | src/external-layer.ts:812 | PORTED | src/external-layer.ts:812 | 控制 SSE 流式事件下发或聚合响应返回，两条路径共用同一上游回合语义 |
| r-field-tools-and-choice | tools & tool_choice | E:/github/ccw-upstream/src/responses/schema.ts:150 | src/external-layer.ts:311 | PORTED | src/external-layer.ts:311 | 工具清单与调用策略遵循客户端主权原则原样打入原生请求，外接层不代执行工具 |
| r-field-previous-response-id | previous_response_id | E:/github/ccw-upstream/src/responses/schema.ts:159 | src/external-layer.ts:824 | PORTED | src/external-layer.ts:824 | 前置响应标识参与线程解析：优先按它定位会话线程，缺失时退回历史前缀认领 |
| r-field-reasoning | reasoning | E:/github/ccw-upstream/src/responses/schema.ts:157 | src/external-layer.ts:326 | PORTED | src/external-layer.ts:326 | 思考强度解析（嵌套 `reasoning.effort` 与扁平 `reasoning_effort` 同权），未知档位响亮拒绝而非静默降档 |
| r-field-store | store | E:/github/ccw-upstream/src/responses/schema.ts:158 | 无 | DROPPED | E:/github/ccw-upstream/src/responses/schema.ts:158 | 上游服务端持久化开关；外接层自带幂等存储与会话注册表，不依赖上游状态 |
| r-field-prompt-cache-key | prompt_cache_key | E:/github/ccw-upstream/src/responses/schema.ts:161 | 无 | DROPPED | E:/github/ccw-upstream/src/responses/schema.ts:161 | 上游底层调试缓存键；外接层按请求体或显式 `Idempotency-Key` 自主计算幂等键 |

### 请求字段处理机制

1. `model` 与 `reasoning`：统一模型体系（`chatgpt-web/latest` 等）把档位解构为上游 slug；非法档位返回 HTTP 400 `invalid_reasoning_effort`，账号能力不足的档位返回 400 `tier_unavailable`，模型 id 与档位参数冲突返回 400 `conflicting_tier` —— 三种情形都在开启上游回合之前短路。
2. `input` 与 `previous_response_id`：`ConversationRegistry` 按规范化摘要的历史前缀最长匹配认领线程，`previous_response_id` 命中时优先。
3. `tools` 与 `tool_choice`：完整透传，工具执行归客户端（Agent 自身的沙箱与审批）。
4. 主动舍弃的字段：`store` 与 `prompt_cache_key` 属上游实验性内部机制，外接层以自有幂等层替代。

---

## C. Event frames

上游在 `E:/github/ccw-upstream/src/bridge.ts` 构建 SSE 事件流。外接层必须准确识别、中继或重新生成这些帧以维持协议一致性。

| id | event | upstream bridge | facade handling | verdict | evidence | rationale |
|---|---|---|---|---|---|---|
| r-event-response-created | response.created | E:/github/ccw-upstream/src/bridge.ts:737 | src/external-layer.ts:1292 | PORTED | src/external-layer.ts:1292 | 首帧在流构造时同步发出；外接层在首帧探测阶段透明放行并原字节中继 |
| r-event-response-heartbeat | response.heartbeat | E:/github/ccw-upstream/src/bridge.ts:202 | src/chat-completions.ts:478 | PORTED | src/chat-completions.ts:478 | 思考期保活帧；Responses 面原样中继，chat 面转换为 SSE 注释行避免客户端解析未知事件，且不计入内容进度 |
| r-event-output-item-done | response.output_item.done | E:/github/ccw-upstream/src/bridge.ts:657 | src/external-layer.ts:1446 | PORTED | src/external-layer.ts:1446 | 文本块或工具调用项的闭合声明；外接层在中继流上按帧转发并据此判定回合已产出真实内容 |
| r-event-response-completed | response.completed | E:/github/ccw-upstream/src/bridge.ts:725 | src/external-layer.ts:1446 | PORTED | src/external-layer.ts:1446 | 正常终态事件；中继时记入幂等存储、清除最近错误并更新熔断成功计数 |
| r-event-response-failed | response.failed | E:/github/ccw-upstream/src/bridge.ts:659 | src/external-layer.ts:1500 | PORTED | src/external-layer.ts:1500 | 流内失败终态；外接层补发 `event: error` 与 `[DONE]` 收尾、计一次失败、并中断仍在挣扎的上游回合 |
| r-event-response-incomplete | response.incomplete | E:/github/ccw-upstream/src/bridge.ts:714 | src/external-layer.ts:463 | PORTED | src/external-layer.ts:463 | 上游提前断流事件；内容进度看门狗按「是否产出真实内容」判定，心跳不算进度 |

### 事件帧与生命周期控制

1. 真实透明中继：上游分块到达即推送，不做缓冲驻留；首帧探测只判定「是否导航类失败」，判定为内容帧后立刻转为直通中继。
2. 心跳兼容转换：`response.heartbeat` 在 chat 面转为 `: keep-alive`，既保活又不会让标准客户端因未知事件崩溃；心跳本身不重置内容进度计时器。
3. 严格终态闭环：`response.completed`、`response.failed`、`response.incomplete` 三种终态都确保流以规范标记结束，并正确驱动会话绑定与熔断计数。

---

## D. Error families

上游在 `E:/github/ccw-upstream/src/lib/errors.ts` 与适配器模块中识别错误类型。外接层把上游错误文本与网络断连收敛为标准 HTTP 响应。

| id | error family | upstream source | facade handling | verdict | evidence | rationale |
|---|---|---|---|---|---|---|
| r-err-rate-limit-error | rate_limit_error | E:/github/ccw-upstream/src/lib/errors.ts:119 | src/external-layer.ts:855 | PORTED | src/external-layer.ts:855 | 上游频控与会话过大统一映射为 HTTP 429，正文含估算 token 数与「压缩或新开会话」指引 |
| r-err-invalid-request-error | invalid_request_error | E:/github/ccw-upstream/src/lib/errors.ts:97 | src/external-layer.ts:1064 | PORTED | src/external-layer.ts:1064 | 请求畸变、非法档位、档位不可用与参数冲突统一映射为 HTTP 400 并给出可选档位清单 |
| r-err-authentication-error | authentication_error | E:/github/ccw-upstream/src/lib/errors.ts:205 | src/external-layer.ts:213 | PORTED | src/external-layer.ts:213 | 客户端 API Key 校验失败返回 401；上游凭证刷新失败返回 401 `credential_unavailable` |
| r-err-server-error | server_error | E:/github/ccw-upstream/src/lib/errors.ts:212 | src/external-layer.ts:1391 | PORTED | src/external-layer.ts:1391 | 上游不可达映射 502 `upstream_unreachable`；进度或首字节预算耗尽映射 504 `upstream_no_progress` |
| r-err-client-cancelled | client_cancelled | E:/github/ccw-upstream/src/adapters/chatgpt-web/adapter-error.ts:48 | src/external-layer.ts:1348 | PORTED | src/external-layer.ts:1348 | 客户端断连返回 499，并立即向 `/admin/interrupt-turn` 广播中止以释放浏览器标签页 |
| r-err-submitted-turn-failed | chatgpt_submitted_turn_failed | E:/github/ccw-upstream/src/adapters/chatgpt-web/index.ts:310 | src/reliability.ts:11 | PORTED | src/reliability.ts:11 | 页面「已提交未完成」家族被识别为瞬态族由客户端重试；导航类失败另享独立重试预算 |

### 错误捕获与自愈机制

1. 客户端原因错误（4xx）：参数错误、鉴权缺失、档位冲突与大载荷熔断均快速短路，避免占用浏览器渲染与推理配额。
2. 瞬时网络错误（5xx）：区分导航阶段（页面跳转失败，独立预算自动重试）与生成阶段（模型输出中途报错，默认单次尝试，把重试主权交回客户端），防止重复计费与副作用。
3. 连接打断（499）：检测到客户端断连即主动中止上游回合，避免已放弃的回合继续占用唯一浏览器标签页。
4. 放弃即中止：客户端断连、进度超时、上游失败三种情形都会触发中断，这是「重试风暴不再与旧回合抢页面」的机制前提。

---

## E. FOLLOWUP

本次逐项比对未发现仍待补齐的客户端可见行为面（`MISSING` 计数为 0）。以下三条为主动放弃项的未来重估条件：

FOLLOWUP: r-route-images-native | target: 仅当出现真实图像生成客户端需求时重新评估是否代理 /v1/images/* | accept: 存在一个客户端用例，且其图像链路可端到端验证
FOLLOWUP: r-field-store | target: 仅当上游把 store 变为语义必需时才重新评估 | accept: 上游 schema 将其标为必需字段
FOLLOWUP: r-field-prompt-cache-key | target: 仅当上游暴露按该键可观测的缓存收益证据时才重新评估 | accept: 上游文档给出可测量的缓存命中差异

审计结论：外接层在路由、请求字段、事件帧与错误族四个面上均已覆盖上游对客户端可见的行为面；外接层自造机制（会话认领、幂等回放、内容进度看门狗、失败熔断、导航级重试、载荷信号）均对应上游缺失或不可观测的能力，符合「新机制禁令」。
