# Token速度仪表盘扩展：历史与模型对比

## Goal

现有仪表盘只有内存态的粗略实时数据（近 20 次条形图、5 小时窗口、收集器重启即清零）。本期把它扩展为：解析后的请求记录持久化保留 7 天，并在此之上新增三块分析视图——速度历史趋势、模型对比、缓存命中分析。

## Users & Value

- 用户：本机 ZCode 开发者（wangjin）。
- 价值：回答"最近一周速度怎么样""在哪个时段慢""不同模型/档位速度差多少""慢是不是缓存没命中"。

## Confirmed facts（证据）

- rollout 日志（`~/.zcode/cli/rollout/model-io-*.jsonl`）每条含 `sessionId/turnId/requestId/attempt/completedAt/durationMs/model.{modelId,role}/response.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens}`（字段实测齐全，182/182 条有 usage）。
- usage 语义实测：`totalTokens = input + output + cacheWrite`，即 **`inputTokens` 已包含 `cacheReadTokens`**（176/183 条吻合）。缓存命中率应算 `ΣcacheRead ÷ ΣinputTokens`。当前日志 cacheRead 占比很高（~14M cacheRead），分析有信号。
- 实测样本仅 1 个模型（qwen3.8-flash-next）、单日数据——模型对比表初期只有一行属预期，随使用自然填充。
- 现状：`RolloutTail` 首轮 seek 到 EOF 不回放（rollout.mjs:87）；history 仅内存 20 条/5h（state.mjs:4-5）；`skipOlderThan` 参数已预留未使用（rollout.mjs:68）；持久化落点惯例 `~/.zcode/plugin-data/token-speed-dashboard/`（server.mjs:17-20）。
- rollout 总量 45MB/182 行（大头是 request body）；解析后单条 ~200B，7 天 ~1-2 万条 ≈ 2-4MB，磁盘/内存占用可忽略。
- `usage` 缺失的降级估算记录（source=estimate）无缓存字段，缓存统计必须排除。

## Decisions（用户已确认）

- D1 范围：持久化（前提）+ 历史趋势 + 模型对比 + 缓存分析全做；会话（sessionId）维度排行**不在本期**，留待后续。
- D2 保留：按 `completedAtMs` 滚动 7 天，过期丢弃（启动加载与每日修剪）。

## Requirements

- R1 持久化：每条解析后的 rollout 记录（仅小字段，不含任何请求/响应内容）追加写入 `plugin-data/…/history.jsonl`；收集器重启后历史完整恢复；ZCode 清理 rollout 文件不影响已存历史。
- R2 首启回填：history 文件不存在或为空时，一次性从现有 rollout 文件读取 7 天内的历史记录入 store（此后增量 tail）；按 requestId 去重，回填与增量、多次重启之间不重复计数。
- R3 历史趋势视图：展示按小时（近 48h）与按天（近 7 天）聚合的平均输出速度（Σoutput ÷ Σduration，吞吐加权）曲线/柱图，含请求数 tooltip；主请求与 lite 可区分。
- R4 模型对比表：按 modelId × role 聚合——请求数、平均 tok/s、P95 tok/s、Σoutput、缓存命中率；当前样本只有一个模型时表只有一行属预期行为。
- R5 缓存分析：全局及分桶的 `ΣcacheRead ÷ ΣinputTokens` 命中率、cacheWrite 规模、输入 token 规模走势；仅统计 source=rollout 记录（估算记录无 usage，必须排除）。
- R6 现有实时功能（大数字卡、本轮累计、近 20 次条形图、状态区）行为不回退。
- R7 隐私与体积：持久化文件只含数值/ID/模型名，不含 prompt、响应文本、metadata；7 天滚动修剪 + 启动时修剪。
- R8 零依赖约束保持：Node 内置 API + 原生 SVG/JS，无 npm 包、无构建步骤。

## Acceptance Criteria

- [ ] AC1：kill 收集器进程并重启（hook 拉起）后，`/api/state` 中趋势/模型/缓存聚合仍包含重启前的记录（history.jsonl 恢复成功）。
- [ ] AC2：删除 history.jsonl 后重启收集器，7 天内的历史 rollout 记录被回填进聚合（`/api/state` 的模型统计 count 与 rollout 日志中 7 天内合法行数一致）；再重启一次不翻倍（去重生效）。
- [ ] AC3：history.jsonl 存在且非空时重启，不再重扫 rollout 大文件（日志无回填动作 / 启动即时）。
- [ ] AC4：`/api/state` 新增 `trend`（hour 桶 ≤48 个、day 桶 ≤7 个）、`models`（每行 modelId/role/count/avg/p95/Σoutput/cacheHit）、`cache`（ΣcacheRead/Σinput/命中率/cacheWrite）且数值可由 history.jsonl 手工核对。
- [ ] AC5：UI 出现三块新面板（趋势图、模型对比表、缓存分析），SVG 渲染，浏览器手工验收无 JS 报错；现有面板（大数字、本轮累计、20 条历史柱、状态）行为与截屏一致不回退。
- [ ] AC6：估算记录（source=estimate）不计入缓存统计；缓存命中率 ∈ [0,1]，按 total=input+output+cacheWrite 语义计算。
- [ ] AC7：超过 7 天的记录不出现在任何聚合与 history.jsonl 修剪后的文件中（可注入旧时间戳记录验证）。
- [ ] AC8：`node --test "test/*.test.mjs"` 全绿，含新增 store 单测（去重、修剪、聚合、p95、回填过滤、estimate 排除）。
- [ ] AC9：history.jsonl 单行不含 `prompt/text/messages/metadata` 等任何内容字段（grep 验证）；README 更新功能与数据文件说明。
- [ ] AC10：`/api/state` 快照体积在 7 天满量（~2 万条聚合）下仍 ≤ ~100KB（只下发聚合+近 20 条，不下发原始记录）。

## Out of Scope（本期不做）

- 会话（sessionId）维度排行/筛选——D1 明确留待下期。
- 导出 CSV/图片、跨设备同步、鉴权（仍只监听 127.0.0.1）。
- TTFT/排队时长（startedAt→首 token 不可得）、重试率展示（attempt 字段存在但本期不呈现）。
- 原始 request/response 内容留存（隐私红线）。

## Risks / Deferred

- rollout 为未公开内部格式：解析全部防御式，缺字段降级现已有；回填读 45MB 为一次性成本（首启数秒内，异步不阻塞服务）。
- 当前仅 1 模型/单日数据，模型对比与趋势初期"难看"属预期，验收以"结构正确"为准。
- 会话维度排行、导出：Deferred（见 Out of Scope）。

## Open Questions

（无——D1、D2 已确认，其余为技术决策见 design.md。）
