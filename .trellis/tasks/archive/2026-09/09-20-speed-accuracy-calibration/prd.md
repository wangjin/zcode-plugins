# 速度口径核实与动态校准系数

## Goal

两件事：① 用实测数据核实 rollout 速度口径的两个疑点并把结论固化；② 用精确记录动态回归校准系数，替换估算路径的硬编码 ÷4。对标 zcode-speed-panel 的"实时校准机制"与"纯生成时长口径"中可落地的部分。

## Requirements

### R1 口径核实（先做，结论写入本目录 research.md）

1. **outputTokens 是否已含 reasoning tokens**：采样近 200 条含 `response.reasoningText` 的记录，回归 `reasoningText.length` 与 `outputTokens - text.length/系数` 的关系；对照官方 UI 今日总量抽查 2–3 天。产出：是/否/不可判定 + 依据。
2. **durationMs 与 startedAt→completedAt 差值一致性**：抽样校验，确认 durationMs 即全请求时长（含首 token 前等待）。
3. **TTFT 缺失决策记录**：rollout 无 firstTokenAt（父任务已实测），分母维持 durationMs；把"若未来日志补字段如何升级"写成一段备注，不做实现。

### R2 解析增强（parseRolloutLine）

- 新解析字段：`reasoningText` 长度（不落文本本身）、`querySource`、`startedAtMs`。
- `role` 判定优先用 `querySource`（`main_turn` → main，其余 → 现行 `model.role` 规则不变或映射 lite），保持向后兼容。
- `history.jsonl` 新增字段为可选列，旧文件无字段时正常加载（父任务集成验收项）。

### R3 动态校准系数（替换 ÷4）

- **校准对象**：estimate 路径（usage 缺失时用文本长度估 tokens）与"字符→token"换算。
- **机制**：按 modelId 分桶，滚动维护 charsPerToken = median((text.length + reasoningText.length) ÷ outputTokens)，样本取近 7 天该模型 source=rollout 的记录，样本数 ≥ 20 才启用，否则回退全局桶，再回退 4.0。
- **更新时机**：每条新精确记录入桶即更新（增量中位数可用 P² 或简单分桶近似；实现取简单方案即可）。
- **持久化**：系数随 history 心跳或独立小文件存 `~/.zcode/plugin-data/zcode-metrics/`，重启不冷启动。
- UI：估算记录仍标注"估算"语义，但估算本身更准；README"设计要点"更新 ÷4 描述。

## Acceptance Criteria

- [ ] research.md 含 R1 三项结论，附可复现命令或数据
- [ ] 校准系数生效路径有单测：分桶、最小样本回退、旧 history 兼容、estimate 记录使用当前系数
- [ ] 全量 `node --test "test/*.test.mjs"` 通过
- [ ] README 口径与估算段落更新（÷4 → 动态系数说明）

## Notes

- **复杂任务**：须先完成 `design.md` + `implement.md` 再 `task.py start`。
- 与 today-usage-card 的关系：其总量口径是否需加 reasoning 由 R1 结论决定，若 R1 判定"outputTokens 未含 reasoning"，回到父任务调整该子任务口径（父 prd 已留挂钩）。
- 不改 speed 计算主公式（tokPerSec = outputTokens ÷ durationMs），除非 R1 结论明确支持分子变化。
