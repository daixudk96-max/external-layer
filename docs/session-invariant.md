# 同会话不变量技术规范 (Session Invariant Specification)

## 1. 核心不变量：一个客户端会话 = 一个浏览器会话 (One Client Conversation = One Browser Session)

ChatGPT Web 外接层（external layer）向标准客户端暴露符合 OpenAI 标准的 `/v1/responses` 与 `/v1/chat/completions` 端点。在这一架构下，理解底层会话生命周期的第一性原理至关重要：

> **核心不变量**：在正常多轮对话递增过程中，**一个客户端会话始终对应且复用上游同一个长期保持的浏览器会话（One Client Conversation = One Retained Browser Session）**。

### 1.1 为什么 ChatGPT Web 不是无状态的纯 API
标准的 LLM API（如 OpenAI 官方 API）通常是无状态的，客户端每一轮请求都必须携带完整历史，服务端每次重新进行前缀预填充（Prompt Pre-filling）。
但 ChatGPT Web 架构底层依赖真实的 Chromium 浏览器实例。一个回合（turn）在物理上对应着一个已打开的网页临时对话标签页（retained browser tab）。如果在客户端连续交互的多轮对话中，每一个步骤（step）都像无状态请求那样重新打开一个临时网页，并将不断膨胀的完整对话历史从头到尾粘贴至网页输入框（composer）中，将导致严重的性能退化与交互故障。

生产环境实测数据证明了这一现象的严重性（即「>20k-token 死亡螺旋」）：
- 上下文 <20k tokens 时，独立导航会话成功率为 68/83；
- 上下文 >=20k tokens 时，若每轮重复粘贴全量历史，会话成功率急剧恶化至 1/44，网页端频繁触发输入阻塞、DOM 渲染卡死与 `upstream_server_error`。

### 1.2 外接层的协调职责
为了捍卫「一个客户端会话 = 一个浏览器会话」不变量，外接层与上游协同工作：
1. **稳定会话标识**：外接层根据请求历史前缀或响应关联，为同一次逻辑对话的所有递增请求分配并注入恒定不变的 `thread_id`，而为每个步骤注入全新的 `turn_id`（通过 `client_metadata["x-codex-turn-metadata"]` 传递给上游）。
2. **零导航成本复用**：当上游命中已有保留标签页时，无需重新执行页面初始化导航（即实现 `nav_steps=0`），浏览器直接复用已驻留的 DOM 上下文，仅将最新增量的消息尾部贴入输入框。
3. **客户端可见标识**：外接层通过 HTTP 响应头 `x-ext-layer-conversation` 向客户端反馈当前绑定的底层会话标识，确保客户端在多轮交互中能够验证会话连续性。
4. **历史只读纪律**：外接层绝不主动剪裁、切片或改写客户端提交的消息历史。历史的完整前缀由外接层原样透传，增量切片工作完全交给上游的尾段提取逻辑。

---

## 2. 上游标签页复用原理与 conversationKey

上游浏览器适配层通过精确的状态哈希决定是否复用后台已打开的标签页。

### 2.1 conversationKey 的构成
上游通过计算唯一的键值确定会话归属。源码锚点：`E:/github/ccw-upstream/src/adapters/chatgpt-web/conversation-key.ts:29-43`。
计算方式为对以下多元组生成稳定哈希：
```ts
sha256({
  namespace,
  threadId,
  modelId,
  reasoning,
  compactionEpoch
})
```
当且仅当该多元组完全一致时，系统才认定可以安全复用同一浏览器标签。

### 2.2 尾段增量截取 slice(lastAssistant + 1)
当命中复用时，上游标签页内已经存在过往所有轮次的渲染内容。为了避免重复输入，上游依据源码锚点 `E:/github/ccw-upstream/src/adapters/chatgpt-web/conversation-key.ts:45-55` 提取待发送内容：
系统搜索历史数组中最后一个 assistant 消息的位置 `lastAssistant`，通过 `slice(lastAssistant + 1)` 仅截取最新追加的用户消息或工具输出。这保证了在已有页面上只进行最小量 DOM 操作，极大提升交互响应速度。

### 2.3 标签页匹配与导航旁路
宿主进程通过查找表管理活跃标签，源码锚点：`E:/github/ccw-upstream/launcher/electron/browser-host.cjs:2225-2232`。
当标签池中找到匹配的保留标签页时，浏览器工作进程执行旁路逻辑，源码锚点：`E:/github/ccw-upstream/src/adapters/chatgpt-web/browser-worker.ts:4289` 与 `E:/github/ccw-upstream/src/adapters/chatgpt-web/browser-worker.ts:4506-4508`。
此时直接跳过新建临时会话的浏览器页面导航，达成 `nav_steps=0` 的极速启动。

---

## 3. 外接层接续与认领契约 (Continuation Contract)

外接层内部通过 `ConversationRegistry` 模块跟踪对话树：
- **前缀认领**：当收到新的 `/v1/responses` 请求时，外接层提取消息数组各元素的规范摘要（canonical digest）。若当前请求的前缀与历史记录吻合，则立即认领已有的 `threadId`。
- **连续性保障**：即使上一轮请求在客户端与上游之间遭遇了服务端异常（如 500 错误透传），外接层依然将其绑定至原有的 `threadId`，使得随后的重试或继续对话能保持在同一会话中。
- **显式退出开关**：若客户端显式传递了 `continuation: false`，外接层将彻底停用接续认领，确保两次相同或连续请求各自获得全新的独立 thread。

---

## 4. 四个允许重置的时机 (The Four Legitimate Reset Occasions)

虽然「同会话不变量」是保障高成功率与低延迟的基石，但在特定工程边界与协议约束下，必须允许重置底层浏览器会话，开启新的临时对话标签页。契约严格界定了以下四个允许重置的时机：

### 4.1 回合失败与异常中断 (Turn failure and Interruption)
在对话推进过程中，若发生意外错误或上游状态异常（如 `failure` 场景）：
- **现象与处理**：当上游执行失败、ChatGPT 界面弹出 "Something went wrong" 阻断弹窗、网络连接中断或触发超时看门狗时，当前浏览器标签页的状态已可能被不可逆地污染或损坏。
- **保留条件契约**：根据上游工作线程的实现规则，源码锚点：`E:/github/ccw-upstream/src/adapters/chatgpt-web/browser-worker.ts:4246-4258`，系统明确要求**仅当终端状态为 `completed` 时（`terminal === "completed"`），工作进程才会将标签页标记为可保留（`retain: true`）**。
- **重置决策**：一旦回合以 `failure`、error 或非正常中断结束，上游将主动废弃或销毁该标签页，而不是将其保留回标签池。虽然外接层仍会将客户端的连续请求路由至相同的逻辑会话以保持状态关联，但上游底层在下一次执行时将重新启动一个干净的浏览器标签页，避免污染状态引发连锁故障。

### 4.2 空闲超时与生命周期淘汰 (Idle 30-Minute TTL Expiry)
保留在后台的浏览器标签页会持续消耗内存、CPU 与 WebSocket 保持连接资源，不能无限期驻留：
- **生命周期约束**：上游宿主设立了统一的空闲存活时限（TTL 机制），源码锚点：`E:/github/ccw-upstream/launcher/electron/browser-host.cjs:46`。该处定义了常量：
  ```javascript
  const RETAINED_TURN_TAB_TTL_MS = 30 * 60 * 1000;
  ```
  即保留标签页的最大空闲 TTL 窗口为整 30 分钟。
- **淘汰与回收**：宿主进程维护着标签页的淘汰定时器与清理通道，源码锚点：`E:/github/ccw-upstream/launcher/electron/browser-host.cjs:2325-2338`。当一个保留的标签页在 `RETAINED_TURN_TAB_TTL_MS` 时限内未收到任何新的回合请求，后台调度器将触发强制关闭与垃圾回收。若客户端在 30 分钟空闲 TTL 过期后再发送新请求，原标签页已被销毁，系统必须重置并重新建立全新的浏览器标签。

### 4.3 推理档位切换 (Reasoning effort Switch)
外接层向客户端提供统一模型（如 `chatgpt-web/latest`），并通过 `reasoning_effort` 参数控制深度思考档位（low、medium、high、xhigh、max）：
- **网页端界面限制**：在 ChatGPT Web 界面中，模型的推理力度（reasoning `effort`）通过网页初始状态的 ARIA Slider 或特定选择器设定。一旦一个临时会话页面已初始化并开始对话，网页端不支持在会话中途无缝切换思考档位。
- **Key 分歧与重置**：根据上游键值生成算法，源码锚点：`E:/github/ccw-upstream/src/adapters/chatgpt-web/conversation-key.ts:29-43`，`conversationKey` 的哈希计算显式包含了当前的 reasoning `effort` 参数。
- **重置决策**：当调用方在后续轮次中变更了 `reasoning_effort` 时，生成的 `conversationKey` 与正在保留标签页的键值产生分歧。宿主在进行标签匹配时（源码锚点：`E:/github/ccw-upstream/launcher/electron/browser-host.cjs:2225-2232`）将无法命中旧标签，从而自动触发重置，在新的浏览器标签中应用新档位配置。

### 4.4 客户端上下文压缩 (Client Context compaction)
随着多轮交互产生大量历史，客户端或代理层通常会触发上下文压缩或摘要（即 client `compaction`）：
- **历史前缀截断风险**：在未发生压缩时，对话历史单调递增，上游通过增量切片 `slice(lastAssistant + 1)` 只需要往现有输入框追加尾巴（源码锚点：`E:/github/ccw-upstream/src/adapters/chatgpt-web/conversation-key.ts:45-55`），此时页面跳过导航，达成 `nav_steps=0`（源码锚点：`E:/github/ccw-upstream/src/adapters/chatgpt-web/browser-worker.ts:4289` 与 `E:/github/ccw-upstream/src/adapters/chatgpt-web/browser-worker.ts:4506-4508`）。
- **截断引发的不一致**：如果客户端执行了上下文 `compaction`（例如裁剪最早的若干轮消息或将前序消息归纳为一段摘要），则历史的前缀序列发生根本性突变。如果强行复用旧标签页追加消息，网页 DOM 中依然包含着已被客户端删除的原始消息，造成模型上下文视图与客户端请求视图的严重脱节。
- **重置决策**：发生 `compaction` 时，前缀校验不通过（或伴随 `compactionEpoch` 递增），系统主动重置底层会话，在新的浏览器标签页中全量灌入压缩后的紧凑历史，确保两端上下文一致性。

---

## 5. 验收与校验总结

同会话不变量规范由权威自动化契约测试 `tests/wc-session-invariant.test.ts` 进行机械化校验：
1. **S1 (稳定性与头部递增)**：三步历史追加请求共用单一稳定的 `thread_id`，各步 `turn_id` 互不相同，响应头携带一致的 `x-ext-layer-conversation`。
2. **S2 (失败绑定延续)**：上游 500 `failure` 透传给客户端后，后继步骤依然复用该会话 thread。
3. **S3 (独立会话隔离)**：不共享前缀的不同会话各自分配独立 thread。
4. **S4 (退出开关生效)**：设置 `continuation: false` 后，即使连续请求内容相同也不共享会话。
5. **S5 (规范词汇检验)**：验证本文档存在且字数大于 1500，准确包含 `nav_steps=0`、`RETAINED_TURN_TAB_TTL_MS`、`conversationKey`、`completed`、`/v1/responses` 等冻结词汇。
6. **S6 (重置时机代码锚点)**：验证本文档各个重置章节准确覆盖 `failure`、`TTL`、`effort`、`compaction` 四大时机，且每个时机均具备规范的代码行路径锚点引用。
