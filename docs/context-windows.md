# 上下文窗口契约与操作指南 (Context Window Contract & Operator Guide)

本文档说明 ChatGPT Web 外接层（external layer）与上游服务之间的上下文窗口（context window）契约，并指导运维人员（operator）如何通过实时端点获取当前环境的真实上下文数据。

---

## 1. 上下文窗口数值来源与派生机制

### 1.1 唯一事实来源 (Single Source of Truth)
外接层中的模型上下文窗口数值**绝不使用任何静态硬编码表**，而是直接从上游（upstream）服务返回的实时模型目录中的 `chatgpt-web/<slug>` 行动态继承并汇总至统一目录（unified catalog）。

历史教训：过去在生产环境中曾同时存在三个互不一致的数字：
- 客户端在自身设置中硬编码了 333,579 (example / 历史示例)；
- 外接层旧代码曾错误地从 native 的 `codex-auto-review` 行继承了 context_window: 272,000 (example / 历史错误示例) 和 max_context_window: 872,000 (example / 历史错误示例)；
- 上游 ChatGPT Web 服务在不同配置下返回 333,579 / 285,000 (example / 示例) 或 111,193 / 95,000 (example / 示例)。

为了彻底杜绝此类数据腐化与版本脱节问题，契约规定：**外接层自身不保存任何权威数字，上游目录中的对应行是唯一权威**。

### 1.2 档位（Per-tier）映射表
外接层向标准客户端公开统一模型 `chatgpt-web/latest`，调用方通过 `reasoning_effort` 请求参数指定所需档位（per-tier）。各档位映射到上游的具体行如下：

| 统一档位 (reasoning_effort) | 上游 Slug (`chatgpt-web/<slug>`) | 展示名称 (Display Name) | 上下文大小说明 |
| :--- | :--- | :--- | :--- |
| `low` | `chatgpt-web/light` | ChatGPT Web — Light | 较小上下文窗口，适用于轻量快速对话 |
| `medium` | `chatgpt-web/medium` | ChatGPT Web — Medium | 中等上下文窗口 |
| `high` | `chatgpt-web/high` | ChatGPT Web — High | 高性能推理上下文窗口 |
| `xhigh` (默认) | `chatgpt-web/extra-high` | ChatGPT Web — Extra High | 默认档位，大上下文窗口 |
| `max` (需 Pro 权限) | `chatgpt-web/pro` | ChatGPT Web — Pro | ChatGPT Pro 旗舰档位，最高上下文窗口 |

注意：每个档位（per-tier / each tier）的上下文窗口数值均独立维护并由上游分别提供。

---

## 2. 3x 部署开关与切换机制

### 2.1 部署级开关
上游服务支持 3 倍上下文窗口扩展开关。该开关属于**部署期/运行时配置**，因此上下文窗口的大小并非固定不变，而是随开关状态而变：
- 标准上下文 (1x)：例如 xhigh 档位上下文窗口约为 111,193 tokens (example / 示例)，压缩阈值约为 95,000 tokens (example / 示例)；Pro 档位约为 112,193 tokens (example / 示例)。
- 扩展上下文 (3x)：开启 3x 扩展时，例如 xhigh 档位上下文窗口为 333,579 tokens (example / 示例)，压缩阈值为 285,000 tokens (example / 示例)；Pro 档位为 336,579 tokens (example / 示例)。

### 2.2 如何切换开关
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

## 3. `/v1/context` 端点与返回字段说明

为避免运维人员再次陷入静态表格带来的认知偏差，外接层提供了实时端点 `/v1/context`。该端点支持“一键查询上游真实数据”。

### 3.1 鉴权
与所有其他 `/v1/*` 路由一致，访问 `/v1/context` 必须携带 `Authorization: Bearer <API_KEY>` 标头（默认本地 dev key 为 `sk-dsh-web-cdfedbd300cc0e0ac0b4cc0c4209cd2cadc5271e61f5c103`）。缺少或错误的凭据将返回 HTTP 401。

### 3.2 响应字段结构
端点返回的 JSON 载荷包含当前部署环境与各档位的实时信息：
- `object`: 固定为 `"context"`，标识对象类别。
- `model`: 固定为 `"chatgpt-web/latest"`，统一模型标识。
- `bigger_context`: 布尔值（`true` 或 `false`）或 `null`。指示上游 `experimentalBiggerContext` 开关的当前生效状态。如果无法读取配置文件则为 `null`，绝不凭空猜测。
- `latest_context_window`: 数值类型。当前默认档位（`xhigh`）的上下文窗口大小（以 token 为单位）。
- `latest_effort`: 固定为 `"xhigh"`，标明默认档位的推理努力程度。
- `source`: 上下文数据来源，通常为 `"upstream"`；若上游未提供有效数据则为 `"unavailable"`。
- `tiers`: 字典对象，键为各有效档位（`low`, `medium`, `high`, `xhigh`，若账号具备 Pro 权限则包含 `max`）。每个档位包含以下字段：
  - `slug`: 该档位对应的上游模型 slug，例如 `chatgpt-web/light` 或 `chatgpt-web/pro`。
  - `context_window`: 该档位的上下文窗口 token 容量上限。
  - `max_context_window`: 该档位允许的最大上下文窗口 token 上限。
  - `auto_compact_token_limit`: 触发上下文自动压缩（auto-compact）的 token 限制。
  - `effective_context_window_percent`: 有效上下文窗口使用百分比（通常为 85）。

---

## 4. `x-ext-layer-context-window` 响应头

在处理 `/v1/responses` 与 `/v1/chat/completions` 请求时，外接层会解析请求指定的档位（若未指定则默认为 `xhigh`），并在 HTTP 响应头中注入：
`x-ext-layer-context-window: <tokens>`

此标头直接反映该次 turn 实际所分配与生效的上下文窗口数值，使调用者在无需单独请求 `/v1/context` 的情况下即可观测到上下文配额。

---

## 5. `x_ext_layer_context_source: "unavailable"` 的含义

如果上游模型目录返回异常、连接超时，或者上游返回的目录中完全没有匹配的 `chatgpt-web/*` 档位行（例如仅包含 native 内部模板行）：
- 外接层**严禁**回退到 native 行继承数据（例如绝不可使用 native 行的数字）；
- 外接层**严禁**使用硬编码数据进行猜测；
- 此时外接层会将 `x_ext_layer_context_source` 标为 `"unavailable"`；
- 相应的 `context_window`、`max_context_window` 与 `auto_compact_token_limit` 字段在模型对象中保持 `undefined`（不出现在 JSON 响应中）；
- 若请求 `/v1/context` 时上游目录完全不可用，端点将返回 HTTP 502 并附带 `upstream_unreachable` 错误代码。

---

## 6. 数值仅为示例规则 (Illustrative Only Rule)

**重要规范**：本文档及任何附属说明中提及的具体数字（例如 111,193 或 333,579 等）**仅供理解概念之示例（illustrative examples only）**。生产运行时的真实数值随时可能因上游更新或部署开关的切换而发生变化。请务必以 `scripts/show-context.cmd` 脚本或 `/v1/context` 接口的实时返回为准。
