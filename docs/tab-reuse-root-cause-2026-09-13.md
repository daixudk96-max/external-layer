# external-layer 标签页复用与工具续轮：独立排查及修复报告

日期：2026-09-13（UTC+8）
被审查基线：`daixudk96-max/external-layer@97ee01f17b3c56e8481be6e786a20f4fbea8423a`。
只读上游：`miuuyy/codex-chatgpt-web@e85e3693fdb4e3e033348c08df0298c20fcdb612`，v5.0.6。
实现分支：`fix/tab-reuse-audit-20260913`。本文中的“基线”行号指修复前版本；“修复后”指本代码包。

## 1. 结论与证据等级

**已经用代码及上游真实会话管理器复现的协议缺陷：external-layer 把“每个 HTTP Responses 请求”当成“一个新的 Codex native turn”。实际上，一个 native turn 可以暂停并跨越多次 HTTP 工具往返。只稳定 thread_id，没有稳定尚未完成的 native turn_id，不能实现正确的工具续轮。**

第二个可复现缺陷是对话身份解析：DSH 明确提供了每个会话稳定的 `prompt_cache_key`，基线却不用它认领会话，只匹配完整历史前缀。开发者/系统上下文重建可以造成认领失败；首轮尚未结束时也没有提前登记会话身份。修复同时解决显式会话认领和同一会话 HTTP 请求的竞争。

这两项分别经过回归测试；第一项还直接导入**未经修改的上游** `ChatGptTurnSessions`、execution-key 和 round-key 函数，复现旧行为并验证新行为。不是只用自编 mock 宣称上游正确。

**不能从这份材料确定的部分：某个具体成功 tab 为什么在下一次请求未命中，以及某次 ChatGPT 自身的 “Something went wrong” 的内部根因。** 已提交日志没有完整的 request → thread_id → native turn_id → conversationKey 关联，也缺少 README 提到的两份请求/结局日志。不能把下面的机制复现冒充对每条历史事件的逐一还原。

## 2. 首先纠正两个会误导定位的“证据”

### 2.1 500–630KB 的 bodyTextChars 不是本次输入撑爆 DOM 的证据

上游 `src/adapters/chatgpt-web/browser-worker.ts:1819` 的计算是：

```ts
bodyTextChars: document.body?.textContent?.length ?? 0
```

它不是可见对话正文长度，不是 DOM 节点数，也不是 renderer 内存指标。已提交快照给出的前后对照如下：

| trace / 检查点 | 时间 UTC | bodyTextChars | 输入框字符 |
|---|---|---:|---:|
| 失败 trace `229d2a3767d7` / 03-composer-ready | 15:38:10.661 | 503,853 | 0 |
| 同一 trace / 14-connector-selected | 15:38:13.389 | 503,872 | 19 |
| 同一 trace / 15-prompt-attachment-complete | 15:38:14.214 | 542,348 | 38,495 |
| 同一 trace / 18-send-accepted | 15:38:17.169 | 503,757 | 0 |
| 同一 trace / 20-response-stalled-60s | 15:39:17.616 | 542,354 | 0 |
| 成功 trace `5f225f240b14` / 03-composer-ready | 15:37:52.694 | 503,849 | 0 |
| 同一成功 trace / 20-turn-completed | 15:38:19.763 | 508,144 | 0 |

来源均为 `docs/handoff/2026-09-12-tab-reuse/diagnostics/<trace>-<hash>/` 对应 JSON，字段 `capturedAt`、`state.bodyTextChars`、`state.composer.textChars`。

失败样本在输入前已经约 50 万字符；成功样本同样如此。输入阶段 14→15 的两个快照相差约 0.825 秒，而且随后已确认发送被接受。这否定了“这个样本在粘贴 9K 时就已经把输入框卡死”的解释。它不排除后续的浏览器故障，只是不能用这个计数证明浏览器被输入体积撑爆。

### 2.2 response-stalled-60s 不等于“连续 60 秒毫无进展”

上游 `browser-worker.ts:4971–4980` 的条件是：

```ts
if (!loggedCompletionWait && Date.now() - sentAt >= 60_000) {
  // capture response-stalled-60s
}
```

这是发送后尚未完成的诊断标记，不是基于最后一次进展计算的 60 秒静默判死。该失败样本的快照能够读取页面、仍有 stop button 和 streaming status；快照没有 `captureErrors`。另一失败样本 `99fe08e84a9f` 在约 41 秒后已结束，连这一标记都没有。

因此“所有失败均为 DOM 窒息，且这个标记已经证明了窒息”不是材料支持的结论。

## 3. 确定的根因一：工具续轮身份错误

### 3.1 基线实际发送了什么

`src/external-layer.ts` 基线约 `1204–1221` 和 `1571–1588` 的两个请求路径都给每次上游尝试生成：

```ts
identity: { threadId: resolvedThreadId, turnId: `prov-${randomUUID()}` }
```

这对于**新的用户任务**可以成立，但对正在暂停、等待工具结果的同一个用户任务不成立。

正确的身份层次应为：

```text
DSH 对话               → thread_id
同一次用户任务的浏览器执行 → native turn_id
一次模型调用/工具结果回传   → HTTP Responses round
```

### 3.2 上游要求的不是“只要 thread_id 一样即可”

上游 `src/adapters/chatgpt-web/turn-execution.ts:202–217` 的 execution key 包含：

```text
modelId + reasoning + threadId + turnId + current user revision + instruction id
```

`turn-execution.ts:535–580` 的 `getOrCreateAfterOwnerRetirement()`：

- 完全相同 execution key：直接返回原 session。
- 相同 thread owner、不同 execution key，且旧浏览器仍在工作：先等旧执行的 `physicalSettlement`。
- 识别到新的用户指令：走显式 supersession / retirement，不是把它当旧工具续轮。

工具结果投递发生在 `src/adapters/chatgpt-web/index.ts` 的 `currentToolResults()` / `broker.completeTool()` 路径；它在拿到正确 session **之后**执行。上游输出一次工具调用时会结束当前 HTTP response，但 `end_turn:false` 表明浏览器执行还没完成。

### 3.3 形成的闭环等待

```text
HTTP round 1:
thread=T, native turn=U1
浏览器请求工具 → facade 返回 function_call / end_turn:false
旧浏览器仍在等工具结果

DSH 执行工具后，发送 full-history 数组（没有 previous_response_id）

HTTP round 2，旧 facade:
thread=T, native turn=U2   ← 错误地生成新 ID
上游找不到原 execution key
→ 先等 U1 浏览器结束
→ 还没走到 broker.completeTool()
→ U1 又正在等 round 2 的工具结果
```

随后可能由上游工具/浏览器期限或 facade 看门狗终止；失败 tab 不保留，下次恢复只能重新打开页面。若 thread 本身也漂移，则不是等待同一个 owner，而可能启动另一个浏览器执行，旧执行继续等原工具结果。若请求被解释为新指令，则会表现为 superseded，而不是模型容量不足。

### 3.4 只读上游验证

运行：

```bash
EXT_LAYER_UPSTREAM_SOURCE=/path/to/codex-chatgpt-web \
  bun run scripts/verify-upstream-turn-contract.ts
```

此脚本只导入上游源码，用一个未结束的 Promise 替代物理浏览器；不发送模型请求，不使用凭证，不写上游。

已得到：

- 旧中间层的两个请求生成不同 execution key。
- 上游真实 owner-retirement gate 等待旧执行，第二个执行没有开始。
- 修复后两个工具往返的 execution key 相同，round key 不同。
- 相同 key 返回同一个上游 session。
- 上游 `turn-execution.ts` 验证前后 SHA-256 完全相同：
  `11bfc6dc81efb122424171ccf66b5ea16e800f994b97ab28740c37bceb8dd8e9`。

证据原文见代码包 `verification/upstream-contract-proof.json`。

## 4. 确定的根因二：有显式 session ID，却只认历史前缀

基线 `src/external-layer.ts:822–830` 没有把 `prompt_cache_key` 交给会话注册表。`src/conversation-registry.ts:140–196` 只支持 response-id 关联或完整 item digest 前缀；认领失败后生成随机 thread。`recordTurn()` 在结果返回时才登记。

因此两个问题都可以发生：

1. 同一 DSH 会话重新生成了 system/developer 包，即使普通对话仍连续，完整前缀已不同，旧 tab 的 conversationKey 永远不再被请求命中，只能等 TTL。
2. 第一请求尚未登记，另一个同会话请求已经进入，两者可能各自生成 thread；上游的一线程一执行约束无法约束两个不同的 thread。

本补丁在 DSH 的已知契约下优先使用每个会话稳定的 `prompt_cache_key`，仅保存其 hash，并在第一次 await 之前登记身份。会话 lineage 忽略易变的 system/developer 与 reasoning 包，但仍核验普通对话、工具参数和工具结果；真正的历史替换/压缩开启新 epoch，避免复用含有被客户端删除历史的旧页面。没有 key 的旧调用方式保留原有前缀逻辑。

注意：这里依赖用户已明确给出的 **DSH 的 prompt_cache_key 是 sessionId** 契约。其他把多个不相关会话共用一个 cache key 的客户端，不能把这个字段当作相同的会话身份。

## 5. 对七项现象逐项解释及限制

| 现象 | 机制与证据 | 能确定到什么程度 |
|---|---|---|
| 1. 受控实验可复用，日常复用少 | 普通 user→assistant→新 user 测试不经过暂停中的工具执行；日常 agent 需要同 native turn 的工具回传。纯前缀认领还会丢失显式会话归属 | 两种差异均有可复现代码路径；事件比例不能独自归因 |
| 2. 成功保留，短时间后未复用，最终 TTL 到期 | 旧 tab 保留不等于新请求一定携带相同 conversationKey；身份漂移可以产生这一结果，而且不要求 TTL 先到期 | 原始日志缺 thread/key，不能证明具体两条 trace 同会话；已修认领缺陷并增加关联日志 |
| 3. 两个浏览器执行重叠 | 不同会话并发本来允许；同一 DSH 会话被拆成不同 thread 也会绕过 owner gate。只锁 HTTP header 接收不能覆盖整个 round | 日志证明并发，不能证明一定是同会话竞争；新补丁只串行化同会话 HTTP round，保留跨会话并发 |
| 4. 9k 可成功，大一点常失败，但 38.5k 有成功 | 上游估计含固定 8192 reserve；历史越长常伴随更多工具往返、重试与全量恢复。字节/Token 相关性不是产品硬限制 | 不能从这些样本推导“17k/20k 硬上限”；不改上游上下文窗口，也不制造容量限制 |
| 5. 响应可见、60s 标记、大 body、随后中止 | 工具结果未交回可以让浏览器持续等待；但 body/60s 两个指标被误读。一般平台错误还有别的来源 | 快照证实已发送，未证实 renderer 崩溃；不能把所有 Something went wrong 归因同一缺陷 |
| 6. 失败后新页面、全量恢复、载荷增长 | 上游 `browser-worker.ts:4246–4258` 仅 completed 时 retain。工具身份错误或独立页面错误导致失败后，恢复必然回到 cold start | 这是确认的上游行为；本层应修失败诱因，而非把失败页面强行保留 |
| 7. 已做稳定身份但改善不大 | thread_id 稳定只解决对话归属，没有解决 native turn 与 HTTP round 的生命周期；既有测试主要覆盖普通追加对话 | 新的工具往返回归与真实上游 gate 验证覆盖原来遗漏的边界 |

### 关于第 2、3 项的时间线，必须特别说明

`logs/launcher-tab-lifecycle.jsonl:2098–2103`：

```text
15:38:19.782  5f225f240b14 retained
15:40:03.983  229d2a3767d7 aborted / ended
15:40:04.170  625197c66d63 created
```

约 1 分 45 秒是从成功的小任务 `5f225f` 算起；但新 `625197` 同时紧跟失败任务 `229d2a` 的结束。交接文档也将它们分为 A/B 两条交错对话。**单凭时间接近，不能证明 625197 本该接管 5f225f 的 tab。**

`9e3877` 和 `5f225f` 两个小任务相隔约 23 分钟，前者 tab 确实仍未 TTL 到期，但同样没有会话关联字段证明二者属于同一个客户端会话。不能用缺失字段得出“ready gate 一定有竞争”的结论。

## 6. 修复内容与最小边界

核心代码：

| 文件（修复后） | 修改 |
|---|---|
| `src/conversation-registry.ts:143–182` | 显式 DSH session key 优先、提前登记、普通历史 continuity 校验与 reset |
| `src/native-turn-state.ts:44–86` | 记录 pending 工具调用；工具结果及 pending-batch reconnect 复用 native turn；新用户任务才分配新 turn |
| `src/native-turn-state.ts:91–137` | 按 thread 串行 HTTP round；在整个流结束/取消时释放，不把浏览器全生命周期锁住 |
| `src/external-layer.ts:1023`、`:1204`、`:1446`、`:1592` | 接入以上状态机；terminal 帧转发前记录工具暂停，避免下一请求抢先进入 |
| `src/sse-events.ts` | 增量、按完整事件观测 SSE，不把过去的 delta 字符串反复当作新进展 |
| `src/stream-peek.ts:232–298` | 真正限制 pending read 的窥探期限，交接尚未完成的 read 时不丢字节；保留断流错误 |
| `src/external-layer.ts:1457–1507` | 流内 failed 不再以 HTTP 200 为依据写成功重放缓存；区分语义失败和普通 HTTP 完成 |

此外绑定地址明确为 loopback。只有 TypeScript 被补入**开发依赖**，运行时依赖仍为零。

本补丁不增加数据库，不执行客户端工具，不缩减 full history，不写上游源码/配置，不改 DSH，不发 native Codex backend 请求，也不通过扩大 timeout 隐藏协议错误。

## 7. 验证结果，以及原有基线本身的问题

干净 CI 基线原先是：`216 pass / 2 skip / 4 fail`；typecheck 成功。

四项失败中：

- 两项是已有断流错误被吞掉的问题，修复实现后原断言通过。
- `w3-models` 的档位测试期待 Pro 能力，却未提供模拟账号能力，隐含读取作者本机配置；现在只在测试夹具显式声明 Pro/Sol，所有原期望值保持原样。
- `w12-gap-matrix` 的审计文档把 `local:` 指向作者 `E:/...` 私有工作目录；现在分发只读上游函数参考片段，并在文档清楚区分它与历史 legacy 扫描记录。原始扫描日志保留不改，测试断言不删、不 skip。没有伪造那个未提供的 legacy checkout。

本地最终执行：

```text
bunx tsc --noEmit
exit 0

bun test
230 pass
2 skip
0 fail
1724 expect() calls
232 tests / 30 files
```

新增的 10 项回归覆盖：动态开发者上下文、相同开场的不同会话隔离、native 工具续轮、新用户任务、同会话并发、失败流缓存、历史压缩 reset、pending 工具重连、看门狗、pending-read handoff、分块/CRLF SSE 等。

两个 skip 是仓库原有的 opt-in 真实账号测试，本次没有开启，也没有把新失败改为 skip。**上述通过不等同于真实 ChatGPT 浏览器端到端已经验证。**

## 8. 真实机器验收

只切换并重启 external-layer；保持上游 v5.0.6、其 config.json、launcher 和 DSH 配置不变。先保留现有 `.env.local` 与账号配置，不上传它们。

```bash
git fetch origin
git switch fix/tab-reuse-audit-20260913
bun install
bunx tsc --noEmit
bun test
```

按原方式重启 facade。独立的只读上游协议复现：

```bash
EXT_LAYER_UPSTREAM_SOURCE=/path/to/ccw-upstream \
  bun run scripts/verify-upstream-turn-contract.ts
```

可选择执行已随包提供的合成 live probe；它只调用 facade，并只在测试客户端本地回显 nonce，不读写业务文件：

```bash
EXT_LAYER_LIVE=1 \
EXT_LAYER_BASE=http://127.0.0.1:17843 \
EXT_LAYER_API_KEY='<本机密钥，不要提交>' \
  bun run scripts/verify-tab-reuse-live.ts
```

Windows PowerShell 使用 `$env:EXT_LAYER_LIVE="1"` 等设置同名环境变量，再执行同一条 `bun run` 命令。

预期物理行为要分清：

```text
第一 HTTP 请求：创建一个浏览器执行 → 返回 function_call
第二 HTTP 请求：交回工具结果 → 同 thread / 同 native turn
                不新建 tab，也不是“复用一个已经完成的 tab”
任务最终完成：上游保留 tab
下一条新用户指令：同 thread / 新 native turn → tab_reused
```

新增日志包含 `req / thread / turn / round / model / identity`，Responses 流响应头还包括 `x-ext-layer-native-turn`。日志不包含原始 prompt_cache_key、请求正文或凭证。

验收不能只看 HTTP 200、健康检查或 thread 相等；必须结合 SSE 的语义终态和 launcher 的 create/reuse/release。DSH 连续多工具任务应不再每次工具结果都创建新的 native turn。纯首个 HTTP 请求、尚未返回任何工具调用就遇到的真实页面/网络错误，仍须按其原错误证据独立定位。

## 9. 仍在允许层之外及证据不足的部分

- ChatGPT 自身的限流、验证挑战、网络失败、renderer 内部故障及上游页面完成判定，不可能由“保持正确 turn_id”全部消除。本补丁没有规避这些约束。
- 上游只在成功结束时保留 tab 的策略未改；不应把失败但可能已执行工具的页面盲目重复发送。
- 交接 README 提到的 `logs/upstream-turn-outcomes.log` 与 `logs/facade-requests.log` 在该基线树中不存在。目录只有 `launcher-tab-lifecycle.jsonl` 和 `launcher-timeline-decisive.txt`。
- 交付的完整 lifecycle 文件覆盖 9 月 8–12 日，不只是所述近期窗口。9 月 12 日全日可数到 created=186、retained=56、reused=7；与文档“104/23/7”使用不同窗口。这不是擅改历史统计，而是不能把不同分母混用。
- 缺少每个历史请求的身份关联，所以不能负责任地宣称“已经证明七条现象全部由一个原因造成”，或“保证任意 33K 首轮从此都成功”。

**可交付结论是：已定位、复现并修复允许层内的对话身份与 native 工具续轮缺陷，以及会妨碍诊断/恢复的流处理缺陷；真实平台剩余错误不被伪装成已经修复。**
