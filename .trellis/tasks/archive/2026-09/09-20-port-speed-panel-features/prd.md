# 搬移 zcode-speed-panel 精华功能到 zcode-metrics

## Goal

把 [zcode-speed-panel](https://github.com/Masterchiefm/zcode-speed-panel)（Tauri 2 + Rust 桌面常驻工具）中与 zcode-metrics 定位契合的能力，以网页插件形态搬移过来。本任务为父任务，持有需求源、任务地图与跨子验收，不承载直接实现。

## 需求源（对方仓库研究结论，2026-09-20）

对方核心能力与本插件的对照：

| 对方能力 | 我方现状 | 处置 |
|---|---|---|
| 今日用量统计（官方口径 input+output+reasoning+cache_creation，调用次数、平均速度） | 只有"近 24h 滚动窗口"，无自然日视角 | 子任务 today-usage-card |
| 速度六档配色（0–40 绿 → 320+ 品红） | 速度读数无分档着色 | 子任务 speed-tier-color |
| 纯生成时长口径 + 字节→token 动态校准 | 分母=全时长 durationMs；估算硬编码 ÷4 | 子任务 speed-accuracy-calibration |
| 进程 IO 字节流实测秒级实时速度 | 请求完成才刷新，进行中只有脉冲 | 子任务 realtime-speed-spike（先研究可行性） |
| 速度胶囊/迷你悬浮窗形态 | 仅完整仪表盘 | 子任务 mini-speed-page |
| 网速监控 / TCP 归属 / 快照防护 / 应用内更新 | — | 不搬（定位不符；快照防护若做应独立插件） |

### 实测约束（已核实，写死避免子任务重复探索）

- rollout 日志（`~/.zcode/cli/rollout/model-io-*.jsonl`）每记录字段：`startedAt` / `completedAt` / `durationMs` / `response.usage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens}` / `response.text` / `response.reasoningText` / `querySource`（如 `main_turn`）/ `model.role`。**无 firstTokenAt / TTFT 字段**，对方"纯生成时长"分母无法直接照搬。
- `inputTokens` 已含 `cacheReadTokens`（provider 侧 input_tokens 2869 + cache_read 68800 = 71669，实测吻合）。
- `reasoningText` 存在但 usage 无独立 reasoningTokens 字段，outputTokens 是否已含 reasoning 需子任务 C 核实。
- **官方库 `~/.zcode/cli/db/db.sqlite` 的 `turn_usage` 表**（speed-panel 的数据源，turn 粒度）：有 `reasoning_tokens` / `first_token_at` / `time_to_first_token_ms` / `cache_creation_input_tokens` 字段；近 3 天实测 `reasoning_tokens` 与 `cache_creation` 恒为 0，`computed_total_tokens = input_tokens + output_tokens`。**rollout 对今日用量覆盖率实测仅 ~17%**（2026-09-20 对账：rollout input 11.76M/104 条 vs 官方 69.2M/32 轮），故今日用量卡片以官方库直读为主（`sqlite3` CLI 只读，缺失回退 rollout 聚合）；核实/对账类查询同样走此路径，不引入驱动依赖、趋势/模型对比等其余面板仍以 rollout 为主数据源。

## 任务地图与排序

```
09-20-port-speed-panel-features（父，只管地图与集成验收）
├─ 09-20-speed-tier-color          #1 ✅ 纯 UI，零数据改动，先行
├─ 09-20-today-usage-card          #2 ✅ 数据源修订：官方库直读 + rollout 回退（覆盖率 17% 实证促成）
├─ 09-20-speed-accuracy-calibration #3 ✅ R1 实验结论落 research.md；动态校准替换 ÷4
├─ 09-20-mini-speed-page           #4 ✅ /mini + 小窗 + localStorage 聚焦同步
└─ 09-20-realtime-speed-spike      # ✅ 结论：当前架构不可行（rollout 完成时才落盘、进程磁盘计数看不到网络流）；
                                     采用回退形态（现状即回退），不立实施子任务；若 rollout 改流式落盘则路径复活
```

## 跨子验收（父任务集成门槛）

- [x] 五个子任务全部完成，各自验收标准通过（详见各任务目录）
- [x] 集成回归：`node --test "test/*.test.mjs"` 全绿（70/70）；插件真实安装路径手动冒烟（hook 接管 → 4521@0.10.0，/ 与 /mini 200，官方口径/校准/历史恢复正常）
- [x] 版本发布：`plugin.json` 0.9.1 → 0.10.0，根 `marketplace.json` 同步；README 新功能段落更新
- [x] 数据兼容：老 `history.jsonl`（无 ch 字段）正常加载；`calibration.json` 缺失/损坏静默回退默认系数

## Notes

- 每个子任务独立可验证、独立归档；父任务不阻塞子任务启动。
- spike 若结论为"可行"，另立实施子任务挂到本父任务下（届时更新本文件任务地图）。
