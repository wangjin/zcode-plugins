# research.md — 口径核实结论（R1）

实验脚本输出全文见同目录 `exp_raw.txt`（2026-09-20，本机 ~/.zcode，近 3 天 119 条精确记录 + 官方库 turn_usage）。

## 结论速览

| # | 问题 | 结论 | 依据 |
|---|------|------|------|
| A | rollout outputTokens 与官方 output_tokens 是否同口径 | **同口径**（双侧都有的 3 个 turn：2 个精确相等、1 个差 0.06% 且请求数差 1，为在途/截断差） | exp A2 |
| B1 | outputTokens 是否已含 reasoning tokens | **已含** | B5：reasoning 重组 text/out=0.066，(text+reasoning)/out=2.624 —— 若不含 reasoning，text/out 应≈chars/token(3~4)，实际仅 6.6% |
| B2 | outputTokens 是否已含 tool-call args | **已含** | B6：有文本记录 text/out 中位数 0.12；B9：finishReason 分布 tool-calls 105 / stop 3（工具调用是 output 大头） |
| C | durationMs 与 startedAt→completedAt 一致性 | **100% 一致**（119/119 偏差 ≤50ms）→ durationMs 即全请求时长；rollout **无 TTFT 字段**，"纯生成时长"分母不可实现 | exp C1 |
| D | model.role 判定 lite 是否生效 | **近 3 天 role 全为 None，从未命中**；有效区分字段是 querySource（main_turn 104 / subagent 15 / session_title 1） | B8 |

## 对实施的影响（已并入 design.md）

1. **speed 主公式不动**：分子无需加 reasoning（已含）；分母维持 durationMs（无 TTFT 可排除）。
2. **role 判定改为 querySource 优先**：`session_title` → lite（后台任务语义）；`main_turn` / `subagent` → main；querySource 缺失沿用 `model.role === "lite"` 旧规则（向后兼容）。
3. **估算路径全面低估，须重做**：现行 `text.length / 4` 只覆盖 output 的 ~12%（B6）。修订：
   - estimate 的分子改为**完整字符口径** chars = len(text) + len(reasoningText) + len(toolCalls args)；
   - 动态校准系数 k = 按模型分桶 median(chars / outputTokens)；实证默认值 **3.158**（B10，n=108）替代 4.0；
   - 校准只在"精确记录"上采样（有 usage 且 outputTokens>50）。
4. **Stop-hook 兜底（last_assistant_message/4）保留 ÷4**：纯文本响应的本地对照样本 n=0（B11：近 3 天无"无 toolCalls、无 reasoning、tlen>50"的精确记录），无法标定纯文本系数，不硬造。此路径本就极少触发（rollout 有记录时不用它）。

## 附：官方库覆盖 vs rollout（今日卡片数据源决策依据）

同刻对账（2026-09-20 ~14:40）：rollout 今日 input 11.76M/104 条 vs 官方 turn_usage 69.2M/32 轮 —— rollout 仅覆盖 ~17%（文件只保留近期会话）。已促成 today-usage-card 改为官方库直读（见该任务 PRD 修订）。
