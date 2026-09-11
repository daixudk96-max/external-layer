# Upstream Gap Audit 报告

## 1. 审查背景与架构决策

在将我们的增强能力迁移至独立外接层（external-layer）且保持上游（ccw-upstream）PRISTINE 运行的新架构下，对本地老线（provider/codex-chatgpt-web）独有模块进行逐项审查与定案。
通过对上游提交历史（HEAD e85e369）与本地实现的比对，形成以下机器可校验的审计矩阵。

## 2. 本地独有模块矩阵

| id | module | legacy path | verdict | evidence | residual risk | verification |
|---|---|---|---|---|---|---|
| btp-01 | browser-tab-pool | provider/codex-chatgpt-web/src/adapters/chatgpt-web/browser-tab-pool.ts | COVERED-BY-UPSTREAM | E:/github/ccw-upstream/src/adapters/chatgpt-web/browser-worker.ts:2131 | 上游仅提供静态并发上限，无请求排队调度能力 | 检查上游 browser-worker.ts 并发上限逻辑 |
| cmg-01 | chat-mode-guard | provider/codex-chatgpt-web/src/adapters/chatgpt-web/chat-mode-guard.ts | COVERED-BY-UPSTREAM | E:/github/ccw-upstream/src/chatgpt-session.ts:4 | 依赖网页端 temporary-chat URL 约束，若网页交互逻辑重大改版可能受影响 | 检查上游 chatgpt-session.ts 中 CHATGPT_TEMPORARY_CHAT_URL 与 composer 校验 |
| fev-01 | family-effort-verifier | provider/codex-chatgpt-web/src/adapters/chatgpt-web/family-effort-verifier.ts | COVERED-BY-UPSTREAM | E:/github/ccw-upstream/src/adapters/chatgpt-web/browser-worker.ts:2318 | 上游原生调节档位，未包含老线定制的审计三元组 | 检查上游 browser-worker.ts 中 selectModelAndEffort 实现 |
| psd-01 | prodex-slider-driver | provider/codex-chatgpt-web/src/adapters/chatgpt-web/prodex-slider-driver.ts | COVERED-BY-UPSTREAM | E:/github/ccw-upstream/src/adapters/chatgpt-web/browser-worker.ts:2414 | 上游依赖 ARIA slider 键盘导航，若网页端 DOM 改变则需跟进 | 检查上游 browser-worker.ts 中 sliderControl.press 按键步进逻辑 |
| cap-01 | capability-matrix | provider/codex-chatgpt-web/src/capability-matrix.ts | PORTED | src/models.ts:25 | 外接层维护统一模型目录，若上游模型名变更需透传更新 | 运行 tests/w3-models.test.ts 验证模型目录形状与能力映射 |
| cmp-01 | chat-completions | provider/codex-chatgpt-web/src/chat-completions.ts | PORTED | src/chat-completions.ts:29 | 流式转发与心跳保持需持续关注 Bun idleTimeout 限制 | 运行 tests/w9-tool-surface.test.ts 验证双向协议转换与流式输出 |
| rc-01 | run-coordinator | provider/codex-chatgpt-web/src/run-coordinator.ts | PORTED | src/idempotency.ts:28 | 幂等回放基于磁盘状态持久化，多实例并发写需文件锁保障 | 运行 tests/w8-idempotency.test.ts 验证同 turn_id 毫秒级回放 |
| sec-01 | security | provider/codex-chatgpt-web/src/security/index.ts | PORTED | src/server-tools.ts:64-77 | 残余风险：run_command 本身不是沙箱（workspaceRoots 仅约束 read_file，命令继承用户权限）；run_command 的 stdout/stderr 与 read_file 均无体积上限（只有 toolResult 时间预算托底，缺省 90s） | 运行 tests/w11-server-tools.test.ts（14 例：越界语法/符号链接 realpath 逃逸/审批缺省 deny/审计 JSONL/轮次熔断 502/default 白名单） |
| tj-01 | tool-jobs | provider/codex-chatgpt-web/src/tool-jobs.ts | DROPPED | provider/codex-chatgpt-web/src/tool-jobs.ts:30 | 放弃 provider 侧 start_job 虚拟长任务，客户端需直接管理长耗时任务生命周期 | 确认新架构中标准 Responses 客户端直接承载工具执行生命周期 |
| tr-01 | tool-relay | provider/codex-chatgpt-web/src/tool-relay.ts | DROPPED | provider/codex-chatgpt-web/src/tool-relay.ts:23 | 放弃 provider 侧 Ajv Schema 预检，上游或模型需自行保证入参结构合法性 | 确认 tools 由客户端通过外接层透明转发至上游原生工具通道 |
| tt-01 | tool-timeouts | provider/codex-chatgpt-web/src/tool-timeouts.ts | PORTED | src/tool-timeouts.ts:24 | 90s 本地 MCP 超时与看门狗首字节预算需随网络延迟实际分布动态校准 | 运行 tests/w10-timeouts.test.ts 验证停滞看门狗与超时中止机制 |

## 3. 上游提交与标识符扫描 (SWEEP)

SWEEP: swp-01 | ensureChatGptPersonalizedConnectorAccess | upstream-commit 509cfc9 | local: E:/github/chatgpt-web-2-api/provider/codex-chatgpt-web/src/adapters/chatgpt-web/browser-worker.ts | result: PRESENT | raw: research/w12-sweep.log#marker-personalization-509cfc9
SWEEP: swp-02 | CHATGPT_PROMPT_INSERT_CHUNK_CHARS | upstream-commit bda266b | local: E:/github/chatgpt-web-2-api/provider/codex-chatgpt-web/src/adapters/chatgpt-web/browser-worker.ts | result: ABSENT | raw: research/w12-sweep.log#marker-chunked-prompt-bda266b
SWEEP: swp-03 | streamCompletedBlocks | upstream-commit 4b1714d | local: E:/github/chatgpt-web-2-api/provider/codex-chatgpt-web/src/adapters/chatgpt-web/markdown.ts | result: ABSENT | raw: research/w12-sweep.log#marker-defer-answer-4b1714d

## 4. 后续移植追踪 (FOLLOWUP)

（无待移植项）原 sec-01 NEEDS-PORT 已由 W11 wave 落地：审批缺省 `src/server-tools.ts:14-16`、审计 JSONL `src/server-tools.ts:25-51`、路径边界 + realpath `src/server-tools.ts:64-77`，验收 `tests/w11-server-tools.test.ts`。

## 5. 缺口汇总 (GAPS)

GAPS: 3 unmatched identifiers, 0 need porting
