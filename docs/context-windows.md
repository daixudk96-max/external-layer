# 上下文窗口契约与操作指南 (Context Window Contract & Operator Guide)

本文档详细说明 ChatGPT Web 外接层（external layer）与上游服务之间的上下文窗口（context window）契约、账号能力体系（account capabilities）以及客户端接入规范。同时指导运维人员与客户端开发者如何通过实时端点与自动化脚本获取真实上下文数据。

---

## 1. 上下文窗口数值来源与原则

### 1.1 唯一事实来源 (Single Source of Truth)
外接层中的模型上下文窗口数值**绝不使用任何静态硬编码表**，而是直接从上游（upstream）服务返回的实时模型目录中的 `chatgpt-web/<slug>` 行动态继承并汇总至统一目录（unified catalog）。

历史教训：过去在生产环境中曾同时存在三个互不一致的数字：
- 客户端在自身设置中硬编码了 333,579 (example / 历史示例)；
- 外接层旧代码曾错误地从 native 的 `codex-auto-review` 行继承了 context_window: 272,000 (example / 历史错误示例) 和 max_context_window: 872,000 (example / 历史错误示例)；
- 上游 ChatGPT Web 服务在不同配置下返回 333,579 / 285,000 (example / 示例) 或 111,193 / 95,000 (example / 示例)。

为了彻底杜绝此类数据腐化与版本脱节问题，契约规定：**外接层自身不保存任何权威数字，上游目录中的对应行是唯一权威**。

### 1.2 为什么禁止在文档与客户端配置中硬编码窗口数字
上下文窗口数字绝不是一个全局固定的常量。它由**账号形态（Account Shapes）**与**上游 3x 扩展开关**共同决定。在文档或客户端静态配置中冻结或写死一个数值，就是在为未来的版本更新制造潜在 bug。
真实的上下文窗口上限以及自动压缩阈值，必须实时通过查询外接层的 `GET /v1/context` 接口，或者使用下文介绍的辅助脚本 `scripts/show-context.cmd` 与 `scripts/dsh-models.cmd` 获取。

---

## 2. 档位（Per-tier）映射表与模型体系

外接层向标准客户端公开统一模型 `chatgpt-web/latest`，调用方通过 `reasoning_effort` 请求参数指定所需档位（per-tier）。各档位映射到上游的具体 slug 如下：

| 统一档位 (reasoning_effort) | 上游 Slug (`chatgpt-web/<slug>`) | 展示名称 (Display Name) | 说明 |
| :--- | :--- | :--- | :--- |
| `low` | `chatgpt-web/light` | ChatGPT Web — Light | 快速轻量对话档位 |
| `medium` | `chatgpt-web/medium` | ChatGPT Web — Medium | 均衡通用推理档位 |
| `high` | `chatgpt-web/high` | ChatGPT Web — High | 高性能深度推理档位 |
| `xhigh` (默认档) | `chatgpt-web/extra-high` | ChatGPT Web — Extra High | 默认档位，大上下文强推理 |
| `max` (需 Pro 权限) | `chatgpt-web/pro` | ChatGPT Web — Pro | ChatGPT Pro 旗舰档位，最高配额 |

### 逐档说明
- `chatgpt-web/light`：轻量档位，响应迅速，适合简短问答。
- `chatgpt-web/medium`：标准中档，平衡延迟与深度分析能力。
- `chatgpt-web/high`：高强度推理档位，适合复杂逻辑推导。
- `chatgpt-web/extra-high`：统一模型 `chatgpt-web/latest` 的默认档位（`latest_effort: "xhigh"`）。客户端若未在请求中显式传递 `reasoning_effort`，则自动映射到该档位。
- `chatgpt-web/pro`：仅在 Pro 账号形态下开放的旗舰档位，对应 `reasoning_effort: "max"`。

注意：每个档位（per-tier）的上下文窗口数值均由上游对应模型行独立提供与维护。

---

## 3. 账号形态与能力契约 (Account Capability Contract)

外接层根据上游环境的实际账号能力，动态裁剪暴露的模型行与可用档位，并通过 `/v1/context` 端点的 `account` 对象对外公开。

### 3.1 账号能力字段与来源
外接层启动与解析上游状态时，读取账号能力对象 `account`：
- `solAvailable` (boolean)：指示是否具备 Sol / Plus 付费层能力。
- `proAvailable` (boolean)：指示是否具备 ChatGPT Pro 顶级旗舰能力。
- `source` (string)：能力字段的事实来源，通常为 `"upstream-config"`（来自上游配置 `config.json` 的 `solAvailable` / `proAvailable` 项）或上游实时账号鉴权信息。

### 3.2 三种账号形态 (Account Shapes)
外接层明确区分以下三种账号形态，运维人员与客户端必须了解其差异：

1. **`Pro` 账号形态**：
   - 标识：`solAvailable: true` 且 `proAvailable: true`。
   - 暴露模型行：完整提供全部 5 个档位行，包括 `chatgpt-web/light`、`chatgpt-web/medium`、`chatgpt-web/high`、`chatgpt-web/extra-high` 以及 `chatgpt-web/pro`。
   - 统一模型：支持统一模型 `chatgpt-web/latest`，默认档位为 `xhigh`（即 `chatgpt-web/extra-high`）。
   - 允许请求 `reasoning_effort: "max"`，直通旗舰 `chatgpt-web/pro`。

2. **`Plus` 账号形态**：
   - 标识：`solAvailable: true` 且 `proAvailable: false`。
   - 暴露模型行：仅提供前 4 个档位行：`chatgpt-web/light`、`chatgpt-web/medium`、`chatgpt-web/high` 与 `chatgpt-web/extra-high`。模型列表中**不包含** `chatgpt-web/pro`。
   - 统一模型：支持统一模型 `chatgpt-web/latest`，默认档位同样为 `xhigh`（即 `chatgpt-web/extra-high`）。
   - 禁止请求 Pro 档：若在 Plus 账号下请求 `chatgpt-web/pro` 或指定 `reasoning_effort: "max"`，外接层将坚决拒绝。

3. **`Luna` 账号形态 (免费号)**：
   - 标识：`solAvailable: false` 且 `proAvailable: false`。
   - 暴露模型行：不暴露付费阶梯模型，也不支持统一模型体系（模型列表中**不包含** `chatgpt-web/latest`，也不包含任何 light/medium/high/extra-high/pro 档位）。
   - 目录模型：仅暴露原生的两行模型：`chatgpt-web/luna` 与 `chatgpt-web/think`。
   - 默认模型：默认为 `chatgpt-web/luna`。
   - 特别注意：Luna 免费账号走滚动 checkpoint 机制，**不支持** 3 倍上下文扩展开关（`experimentalBiggerContext` 必须为 `false`）。

---

## 4. 错误处理契约：拒绝不可用与冲突档位

为了防止错误参数被静默降级或穿透导致上游异常，外接层严格执行以下校验契约：

### 4.1 档位不可用 (`tier_unavailable`)
- 触发条件：客户端请求了当前账号形态不支持的档位。例如在 `Plus` 或 `Luna` 账号形态下请求 `model: "chatgpt-web/pro"`，或者对 `chatgpt-web/latest` 传递 `reasoning_effort: "max"`。
- 处理策略：外接层**绝不静默降级为其他档位**，而是立即拦截该请求，返回 HTTP 400 客户端错误，错误代码为 `tier_unavailable`。
- 上游防护：请求在外部层直接终止，绝不向上游发起无意义的 turn 调用。

### 4.2 模型与档位冲突 (`conflicting_tier`)
- 触发条件：调用方在请求体中同时指定了显式模型 slug 与互斥的 `reasoning_effort`。例如指定 `model: "chatgpt-web/high"` 但同时传递 `reasoning_effort: "max"`。
- 处理策略：外接层拒绝模糊语义，立即返回 HTTP 400 错误，错误代码为 `conflicting_tier`，同样不产生上游调用。

---

## 5. 3x 部署开关与配置机制

### 5.1 部署级开关
上游服务支持 3 倍上下文窗口扩展开关。该开关属于**部署期/运行时配置**，因此上下文窗口的大小并非固定不变，而是随开关状态而变：
- 标准上下文 (1x)：例如 xhigh 档位上下文窗口约为 111,193 tokens (example / 示例)，压缩阈值约为 95,000 tokens (example / 示例)；Pro 档位约为 112,193 tokens (example / 示例)。
- 扩展上下文 (3x)：开启 3x 扩展时，例如 xhigh 档位上下文窗口为 333,579 tokens (example / 示例)，压缩阈值为 285,000 tokens (example / 示例)；Pro 档位为 336,579 tokens (example / 示例)。

### 5.2 如何切换开关
1. **上游服务命令行参数**：
   - 启用 3 倍上下文：启动上游服务命令时传入 `--bigger-context`。
   - 恢复标准上下文：启动上游服务命令时传入 `--standard-context`。
2. **配置文件项**：
   - 上游配置文件（如 `config.json`）中的配置键 `experimentalBiggerContext`：
     - `"experimentalBiggerContext": true` 表示开启 3 倍上下文；
     - `"experimentalBiggerContext": false` 表示使用标准上下文。
3. **强制关闭规则**：
   - 当交互模式设定为人工交互（`manual`）或者启用零风险（Zero-Risk）交互安全模式时，系统规则**强制关闭 3x 开关**（forces it off），即使配置了 3x 扩展上下文开关也会自动降级回标准上下文大小，以确保稳定与低延迟。

---

## 6. `/v1/context` 端点规范

为避免运维人员再次陷入静态表格带来的认知偏差，外接层提供了实时端点 `/v1/context`。该端点支持“一键查询上游真实数据”。

### 6.1 鉴权
与所有其他 `/v1/*` 路由一致，访问 `/v1/context` 必须携带 `Authorization: Bearer <API_KEY>` 标头（默认本地 dev key 为 `sk-dsh-web-cdfedbd300cc0e0ac0b4cc0c4209cd2cadc5271e61f5c103`，也可通过环境变量 `EXT_LAYER_API_KEY` 覆盖）。缺少或错误的凭据将返回 HTTP 401。

### 6.2 响应字段结构
端点返回的 JSON 载荷包含当前部署环境、账号形态与各档位的实时信息：
- `object`: 固定为 `"context"`，标识对象类别。
- `model`: 固定为 `"chatgpt-web/latest"`，统一模型标识。
- `account`: 对象类型，包含当前账号能力状态：
  - `solAvailable`: 布尔值，指示 Sol 能力可用性。
  - `proAvailable`: 布尔值，指示 Pro 能力可用性。
  - `source`: 能力来源，例如 `"upstream-config"`。
- `bigger_context`: 布尔值（`true` 或 `false`）或 `null`。指示上游 `experimentalBiggerContext` 开关的当前生效状态。如果无法读取配置文件则为 `null`，绝不凭空猜测。
- `latest_context_window`: 数值类型。当前默认档位（`xhigh`）的上下文窗口大小（以 token 为单位）。
- `latest_effort`: 固定为 `"xhigh"`，标明默认档位的推理努力程度。
- `source`: 上下文数据来源，通常为 `"upstream"`；若上游未提供有效数据则为 `"unavailable"`。
- `tiers`: 字典对象，键为当前账号形态下有效的各档位（`low`, `medium`, `high`, `xhigh`，若具备 Pro 权限则包含 `max`）。每个档位包含以下字段：
  - `slug`: 该档位对应的上游模型 slug，例如 `chatgpt-web/light` 或 `chatgpt-web/pro`。
  - `context_window`: 该档位的上下文窗口 token 容量上限。
  - `max_context_window`: 该档位允许的最大上下文窗口 token 上限。
  - `auto_compact_token_limit`: 触发上下文自动压缩（auto-compact）的 token 限制。
  - `effective_context_window_percent`: 有效上下文窗口使用百分比（通常为 85）。

---

## 7. 客户端最后一公里配置与辅助脚本

客户端（例如 DSH 客户端的 `settings.yaml`）需要配置模型的 `contextWindow`。由于窗口数值随账号形态与 3x 开关动态变化，外接层提供了配套脚本以实现一键更新：

1. **`scripts/show-context.cmd`**：
   快速查看当前外接层 `/v1/context` 端点返回的完整 JSON 上下文与账号状态。
2. **`scripts/dsh-models.cmd`**：
   读取 `/v1/context` 并格式化输出当前账号可用的所有模型档位及其真实 `contextWindow`，同时生成可直接复制粘贴到 `settings.yaml` 的 YAML 配置片段。

---

## 8. `x-ext-layer-context-window` 响应头

在处理 `/v1/responses` 与 `/v1/chat/completions` 请求时，外接层会解析请求指定的档位（若未指定则默认为 `xhigh`），并在 HTTP 响应头中注入：
`x-ext-layer-context-window: <tokens>`

此标头直接反映该次 turn 实际所分配与生效的上下文窗口数值，使调用者在无需单独请求 `/v1/context` 的情况下即可观测到上下文配额。

---

## 9. `x_ext_layer_context_source: "unavailable"` 的含义

如果上游模型目录返回异常、连接超时，或者上游返回的目录中完全没有匹配的 `chatgpt-web/*` 档位行（例如仅包含 native 内部模板行）：
- 外接层**严禁**回退到 native 行继承数据；
- 外接层**严禁**使用硬编码数据进行猜测；
- 此时外接层会将 `x_ext_layer_context_source` 标为 `"unavailable"`；
- 相应的 `context_window`、`max_context_window` 与 `auto_compact_token_limit` 字段在模型对象中保持 `undefined`（不出现在 JSON 响应中）；
- 若请求 `/v1/context` 时上游目录完全不可用，端点将返回 HTTP 502 并附带 `upstream_unreachable` 错误代码。

---

## 10. 数值仅为示例规则 (Illustrative Only Rule)

**重要规范**：本文档及任何附属说明中提及的具体数字（例如 111,193 或 333,579 等）**仅供理解概念之示例（illustrative examples only）**。生产运行时的真实数值随时可能因上游更新、账号形态更替或部署开关的切换而发生变化。请务必以 `scripts/show-context.cmd` 与 `scripts/dsh-models.cmd` 脚本或 `/v1/context` 接口的实时返回为准。
