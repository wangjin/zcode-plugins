# PRD: ZCode Token 速度实时显示插件（token-speed-dashboard）

## Goal / 用户价值

在本地网页仪表盘上实时显示 ZCode 当前会话的模型输出速度（tokens/s），让用户直观看到"AI 现在打字有多快"，并保留近期请求的速度历史。

## Confirmed Facts（已验证证据）

- **Hook 事件全集只有 7 个**：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`。不存在 `request_start` / `chunk_received` / `response_stop` 等流式事件（ZCode Hooks 官方文档确认）。原始需求中的 T₁ 记录点映射为 `UserPromptSubmit`，流结束点映射为 `Stop`。
- **Hook 是一次性子进程**：stdin 一行 JSON → stdout 一行 JSON + 退出码。Hook 自身无法"每隔几秒"持续计算；持续计算必须由常驻进程完成。`command` 类型 hook 支持 `async: true`（fire-and-forget），适合幂等拉起常驻进程。
- **精确 token 数据源存在**：`~/.zcode/cli/rollout/model-io-sess_<sessionId>.jsonl`，每个完成的模型请求写一行，实测字段包括：
  - `startedAt` / `completedAt` / `durationMs`
  - `model.role`（`main` / `lite`）、`model.modelId`、`sessionId`、`turnId`
  - `response.usage.outputTokens` / `inputTokens` / `totalTokens`（精确值，无需字符估算）
  - 日志仅在**请求完成时**落盘 → 速度计算的天然粒度 = 每次模型请求结束。
- **辅助事件源**：`~/.zcode/cli/log/zcode-<date>.jsonl` 有 `model.request.completed`、`model.sdk.stream.completed`（含 durationMs、sessionId、turnId），可做交叉校验。
- **Hook 输入契约**含 `session_id`、`transcript_path`（临时，勿长期依赖）、`hook_event_name`、`Stop` 事件带 `last_assistant_message`。持久数据应写 `${ZCODE_PLUGIN_DATA}`。
- **插件结构**：`.zcode-plugin/plugin.json` + `hooks/hooks.json`（标准位置自动发现）；模板变量 `${ZCODE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_DATA}`。本地测试：设置→插件→创建→添加插件市场（本地目录）。
- 运行环境：node v24.19.0 可用；macOS。
- **ZCode Hook 协议无 UI/status-line 通道**，"显示"必须借外部载体；用户已选定 **本地网页仪表盘**。

## Requirements

### R1 数据管道（常驻收集器）
- R1.1 `SessionStart` hook（`type: command`, `async: true`）以幂等方式拉起常驻 Node 收集器进程（健康检查 + pidfile，端口占用自动递增重试；进程已活则秒退）。
- R1.2 `UserPromptSubmit` hook（同步、短超时）仅做：确保收集器存活 + 记录本轮起点 T₁ 与 session 映射；stdout 返回空，不注入任何模型上下文。
- R1.3 收集器 tail `~/.zcode/cli/rollout/model-io-*.jsonl`（增量读、容忍半行），解析每个完成请求的 `startedAt/completedAt/durationMs/usage.outputTokens/model.role/sessionId/turnId`；仅 `role=main` 计为"回答速度"，`lite` 单独标记为后台任务。
- R1.4 速度公式：单次请求 `tok/s = outputTokens ÷ durationSec`；本轮累计 `turnTok/s = Σ outputTokens ÷ (now − T₁)`。流式响应完成前拿不到增量 token（协议限制），此时仪表盘展示"进行中 + 已耗时 + 上一请求速度"，完成瞬间刷新。
- R1.5 降级路径：rollout 文件缺失/字段变化时，退回估算（`last_assistant_message` 字符数 ÷ 4 ÷ durationMs，Stop hook 兜底），并在 UI 标注"估算值"。

### R2 展示层（本地网页仪表盘）
- R2.1 收集器内置零依赖 HTTP 服务（Node 原生 http），静态仪表盘 + SSE 实时推送；默认端口 `4521`，占用自动 +1 递增（最多 10 次），实际端口写入 `${ZCODE_PLUGIN_DATA}/port`。
- R2.2 仪表盘内容（单页，中文）：
  - 当前状态卡：活跃时显示"生成中…（已耗时 Xs）"或最近一次速度 `N tok/s`、modelId、输入/输出 tokens、请求耗时；
  - 本轮累计：T₁ 至今总输出 tokens 与平均 tok/s；
  - 近 20 次请求速度条形图 + 迷你趋势线；
  - `main` 与 `lite` 请求区分显示；
  - SSE 断线自动重连 + 最后心跳时间。
- R2.3 打开方式：`SessionStart`（source=startup）时 `open http://127.0.0.1:<port>` 自动打开浏览器；`clear/compact` 不重复打开。提供 `userConfig` 布尔项关闭自动打开。
- R2.4 仅监听 `127.0.0.1`；无鉴权（本机个人数据）。

### R3 插件工程
- R3.1 目录：插件 `token-speed-dashboard/`（`.zcode-plugin/plugin.json`、`hooks/hooks.json`、`hooks/ensure.mjs`、`dashboard/server.mjs`、`dashboard/index.html`）+ 市场根 `marketplace.json`（本地安装测试用）。
- R3.2 hooks.json 事件映射（ZCode 无 request_start/chunk/response_stop，按语义映射）：
  - `SessionStart` → `command`, `async: true`：拉起收集器 + 按配置开浏览器；
  - `UserPromptSubmit` → `process`（node ensure.mjs，`timeoutMs: 1500`）：保活 + 上报本轮起点 T₁；
  - `Stop` → 同保活调用（兜底进程被杀场景，并触发估算降级记录）。
- R3.3 持久数据全部写 `${ZCODE_PLUGIN_DATA}`（pidfile、port、状态快照）；不写回插件安装目录。
- R3.4 零第三方依赖（纯 Node 内置模块）；node 缺失/异常时 hook 静默失败（非零退出码 = 可恢复失败，不阻断会话）。

## 已定决策（用户确认）

- **D-展示通道 = 本地网页仪表盘**。用户曾期望直接嵌入 ZCode 界面（如右下角），但经评估：ZCode 插件协议（7 个 Hook 事件 + stdin/stdout JSON）不存在任何 UI/status-line 通道，官方 bundle 内也无相关机制，插件无法嵌入 ZCode 窗口。候选替代形态（Swift 贴角浮窗 / 浏览器 app 小窗 / 菜单栏指示器）中，用户明确选择**只要网页仪表盘**：插件内置一个零依赖本地 Node 服务（仅监听 127.0.0.1），SessionStart 时自动拉起并（可配置）自动打开浏览器。
- 速度数据源采用 rollout 日志的精确 usage.outputTokens（而非用户最初设想的字符估算）；`request_start/chunk_received/response_stop` 不存在，按语义映射为 UserPromptSubmit（T₁）/ rollout 落盘 + Stop（T₂），详见 design.md。

## Out of Scope

- 不做 ZCode 界面内的原生状态栏嵌入（协议无此通道）。
- 不做流式 chunk 级速度曲线（Hook 协议与日志均无增量数据源）。
- 不统计 input token 速度、成本、缓存命中率（展示卡仅顺带显示数值）。
- 不做多机/远程工作区支持；不做历史数据长期存储（内存 + 最近 20 条快照）。
- 不拦截/修改任何工具调用与会话行为（hook 输出恒为空）。

## Acceptance Criteria

1. 本地目录添加为插件市场并安装启用后，新建 session 提交一条消息，浏览器出现仪表盘（或手动打开 port 文件所指地址后可见）。
2. 模型每次回答完成后 ≤1 秒内，仪表盘"最近请求"卡显示正确 `tok/s = outputTokens ÷ durationMs`（与 rollout 日志人工核对一致），条形图追加一条。
3. 一轮含多次工具调用的任务中，"本轮累计"卡持续按 `Σtokens ÷ (now − T₁)` 递增刷新。
4. 响应进行中仪表盘显示"生成中 + 已耗时"，无假数据。
5. kill 掉收集器进程后，下一条用户消息即自动复活（UserPromptSubmit 保活生效），仪表盘重新可连。
6. rollout 缺失/字段变化/node 异常等场景：会话不受任何影响（hook 可恢复失败），仪表盘按降级路径工作或明确提示无数据。
7. 插件详情页 Hooks 区可见 3 条 hook 配置；停用插件后新 session 不再拉起进程。
8. Hook stdout 恒为空 JSON/空输出——模型上下文中不出现本插件注入的任何文字。

## Technical Notes（风险与缓解）

- **rollout 日志是未公开内部实现**，ZCode 升级可能改路径/字段 → 解析全部防御式（缺字段→估算降级；文件不存在→"等待数据"空态）；集中单一 parser 便于修复。
- Hook 配置在 session 启动时快照，改插件后需新建 session 验证（文档明示）。
- 项目级 hooks 不执行（安全策略）→ 插件分发是正确路径。
- 单实例保障：pidfile + `/health` 探测双保险；SessionStart async hook 幂等。
- stdout 协议纪律：`process` 型 hook 只输出一行合法 JSON 或空，诊断走 stderr。
