# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

本仓库 backend 侧主要是 `plugins/zcode-metrics`（零依赖 Node 收集器 + 纯函数模块）与 `plugins/trellis-hooks`（Python hooks）。质量基线：`node --test "test/*.test.mjs"` 全绿；纯逻辑与 IO 薄层分离（store/state/calibration/official 均为纯逻辑模块，server.mjs 是唯一 IO 薄层）。

---

## Required Patterns

### zcode-metrics 数据源契约（2026-09-20 实测，改动解析/聚合前必读）

- **rollout 日志**（`~/.zcode/cli/rollout/model-io-*.jsonl`）：
  - `response.usage.outputTokens` **已包含 reasoning tokens 与 tool-call args**（text 仅占 ~12%）；与官方 `turn_usage.output_tokens` 同口径（对账精确一致）。
  - `inputTokens` 已含 `cacheReadTokens`（命中率 = ΣcacheRead ÷ Σinput）。
  - `durationMs` = `completedAt − startedAt`（全请求时长，100% 一致）；**无 TTFT/firstTokenAt 字段**。
  - `model.role` 恒为 None（lite 判定失效）——**role 必须用 `querySource` 判定**：`session_title`→lite，`main_turn`/`subagent`→main，缺失沿用 `model.role==="lite"`。
  - **完成时一次性落盘**（~260KB/条），生成期间无增量 → 不存在"进行中实时速度"信号（spike 结论，见 `.trellis/tasks/archive` realtime-speed-spike）。
  - 覆盖率：rollout 只保留近期会话文件，对"今日用量"覆盖率实测 ~17%。
- **官方用量库**（`~/.zcode/cli/db/db.sqlite` 表 `turn_usage`，turn 粒度）：`computed_total_tokens = input_tokens + output_tokens`；近 3 天 `reasoning_tokens`/`cache_creation` 恒 0。**今日用量等官方口径数据必须直读此库**（经 `sqlite3` CLI 只读子进程，`dashboard/official.mjs`），失败回退 rollout 聚合并降级标注；禁止引入 sqlite 驱动依赖。
- **字符→token 估算**：估算分子必须用完整字符口径 `len(text)+len(reasoningText)+len(toolCalls args)`；系数用 `dashboard/calibration.mjs` 动态分桶（实证默认 3.158），**禁止再写死 ÷4**（低估 ~8 倍）。唯一例外：Stop-hook 的 `last_assistant_message` 兜底保留 ÷4（纯文本系数无法本地标定，n=0）。

### 版本与分发

- `plugin.json` 是版本唯一事实源；`server.mjs` 启动时读取它，`/health` 报告；根 `marketplace.json` 的 version 必须同步（有 `marketplace-sync.test.mjs` 守护）。
- ZCode 从本地市场**复制**插件到 `~/.zcode/cli/plugins/cache/<market>/<plugin>/<version>/` 并从缓存运行 hook：仓库升版后需在 ZCode 设置里更新插件，否则旧 hook 会把收集器"接管"回旧版本。

---

## Testing Requirements

- 纯函数模块（store/state/rollout/calibration/official 查询构造与解析）必须有直接单测；涉及真实环境的外部资源（官方库）用 `{ skip: !existsSync(...) }` 门控 live 测试。
- 依赖真实 rollout 目录的行为测试用 `ZCODE_ROLLOUT_DIR` 指向临时目录隔离，禁止污染真实数据目录。
- HTML 内嵌纯函数（如六档配色 TIERS）用标记块提取方式单测，见 frontend 规范。

---

## Code Review Checklist

- 改 `parseRolloutLine` / 聚合口径时：先对照本文件"数据源契约"，必要时更新 `.trellis` 任务 research.md 的实证依据。
- 新增外部数据源读取：默认只读、超时、失败静默降级，不引入新依赖。
