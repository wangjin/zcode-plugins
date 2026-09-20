# 今日用量卡片（官方口径对齐）

## Goal

仪表盘顶部新增"今日用量"卡片：自然日（本地时区）聚合的调用次数、token 总量、平均速度，口径与 ZCode 官方统计对齐。对标 zcode-speed-panel 的"今日用量统计"。

## Requirements

> **2026-09-20 执行中修订**：实施时实测发现 rollout 日志对"今日用量"覆盖率仅 ~17%（rollout input 11.76M vs 官方 turn_usage 69.2M，同刻对账；rollout 只保留近期会话文件/部分请求类型）。仅靠 rollout 聚合无法达成"官方口径对齐"这一核心目标，故数据源修订为：**优先直读官方库 `~/.zcode/cli/db/db.sqlite` 的 `turn_usage` 表（经 `sqlite3` CLI 只读查询，macOS 自带；缺失/失败时回退 rollout 聚合并标注口径）**。总量 = 官方 `computed_total_tokens`；官方无 main/lite 概念，展示"轮（turn）"计数；聚焦会话时按 `session_id = <sid>` 过滤（id 格式与 rollout sessionId 同源）。

- **口径**：官方模式 total = `computed_total_tokens`（实测 = input + output）；回退模式 = ΣinputTokens + ΣoutputTokens + ΣcacheWriteTokens（rollout 映射口径）。
- **指标**（自然日，本地时区）：
  - token 总量（官方模式直读；回退模式聚合）
  - 计数：官方模式 = turn 轮数；回退模式 = 请求数（主 / lite 分列）
  - 平均速度 = ΣoutputTokens ÷ ΣdurationMs（两种模式同公式，吞吐加权）
- **聚焦联动**：跟随仪表盘现有聚焦口径——"全部" = 全局今日；聚焦某会话 = 该会话今日（官方模式按 session_id 过滤）。
- **已知限制（README 说明）**：官方库不可读（如无 sqlite3 CLI 的平台）自动回退 rollout 口径并降级标注；回退口径覆盖率受 rollout 保留策略限制。

## Acceptance Criteria

- [x] 卡片展示上述指标，跨 00:00 后新请求正确归入新的一天（自然日边界单测）
- [ ] 与官方库同刻对账：tokens 总量、轮数一致（executed 2026-09-20：官方 69.7M/32 轮 ↔ rollout 聚合 11.7M/104 条，促成数据源修订；改官方直读后需复验一致）
- [ ] 聚焦会话时数字切换为该会话今日口径，点"全部"恢复
- [ ] 今日无请求时显示 0，不报错、不显示 NaN；官方库不可读时回退不报错
- [x] 单测：自然日边界聚合、主/lite 分列、聚焦过滤（store 层）；official 查询构造与输出解析（纯函数层）
- [x] README "它做什么"补一段今日卡片说明

## Notes

- 涉及文件：`dashboard/official.mjs`（新）、`dashboard/store.mjs`（回退聚合）、`dashboard/server.mjs`（官方结果缓存并入 snapshot 外层）、`dashboard/index.html`（卡片 UI）、`test/store.test.mjs`、`test/official.test.mjs`（新）。
- 版本号随父任务集成时统一升，本子任务不动 plugin.json。
