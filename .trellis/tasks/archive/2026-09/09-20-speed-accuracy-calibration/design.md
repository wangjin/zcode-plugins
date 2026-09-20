# design.md — 速度口径核实与动态校准系数

## 边界

```
rollout.mjs ──解析增强──▶ Record（新可选字段）
                              │
calibration.mjs（新，纯函数）◀─ 精确记录（source=rollout）
                              │
store.mjs ──estimate 路径用系数──▶ history.jsonl（可选新列）
server.mjs ──心跳时持久化 calibration.json──▶ ~/.zcode/plugin-data/zcode-metrics/
```

不改动：speed 主公式（tokPerSec = outputTokens ÷ durationMs）、SSE 协议既有字段、UI 布局（估算标注语义保留）。

## 预研事实（2026-09-20 实测，写死避免重复探索）

1. rollout 无 firstTokenAt / TTFT 字段；`durationMs` ≈ `completedAt − startedAt`（全请求时长）。
2. 官方库 `~/.zcode/cli/db/db.sqlite` 的 `turn_usage` 表**有** `reasoning_tokens`、`first_token_at`、`time_to_first_token_ms`、`cache_creation_input_tokens` 等字段（turn 粒度）。
3. 近 3 天官方数据：`reasoning_tokens` 全为 0、`cache_creation` 全为 0；`computed_total_tokens = input_tokens + output_tokens`（实测 1840856+13097=1853953 ✓）。
4. rollout `inputTokens` 已含 cacheRead（父 prd 记录）。

## 数据契约

- `Record` 新增**可选**字段：`reasoningChars?: number`、`querySource?: string`、`startedAtMs?: number`。旧行缺失按 undefined 处理，聚合层不得假设存在。
- `history.jsonl`：新字段为可选列，JSON 行级兼容（旧文件零迁移）。
- `calibration.json`：`{ version: 1, updatedAt, buckets: { [modelId]: { median: number, count: number, kFallback: 4.0 } } }`。删除该文件 = 回退 ÷4（回滚开关）。

## 校准算法（简单优先）

- 按 modelId 分桶。每条精确记录产出比值 `r = (text.length + reasoningText.length) ÷ outputTokens`（两个长度都来自 response 文本，不含消息内容落盘——只落长度）。
- 桶内维护环形样本 buffer（容量 200），median 取插入后排序的 P50。200 log 200 每记录一次，成本可忽略；不上 P²。
- 查询顺序：模型桶（count ≥ 20）→ 全局桶（count ≥ 50）→ 4.0。
- 持久化时机：心跳（复用每日修剪定时器）+ 变更后 30s debounce；只写 median/count，不写样本（重启续用中位数，无需冷启动重放）。

## R1 实验设计（结论已出，见 research/research.md）

实验已执行（2026-09-20）：A 对账同口径（3 turn 精确一致）；B5/B6 证明 outputTokens 已含 reasoning 与 toolArgs（text 仅占 12%）；C durationMs=全请求时长 100% 一致；B8 model.role 全 None（lite 判定从未生效）。**实施修订**：
- role 判定 querySource 优先：`session_title`→lite，`main_turn`/`subagent`→main，缺失沿用旧 `model.role` 规则。
- estimate 分子改完整字符口径 chars = text + reasoningText + toolArgs args 长度。
- 校准实证默认 k=3.158（n=108），替代 4.0。
- Stop-hook 兜底保留 ÷4（纯文本对照样本 n=0，无法标定）。

## 权衡与取舍

- **不引入 sqlite 驱动依赖**：官方库只经 `sqlite3` CLI 子进程只读查询（macOS 自带；`sqlite3` 不存在时实验脚本与运行时校准均优雅跳过）。收集器保持零依赖。
- **不做 TTFT 排除**：请求级无字段，turn 级数据不适用于请求级速度；把"若未来 rollout 补 firstTokenAt 再升级"记为备注。
- **estimate 精度预期**：chars÷k 的固有误差 ~±15%，动态校准消除的是跨模型系统性偏差（不同 tokenizer 的 k 差异可达 2–3 倍），不追求逐条准。

## 兼容与回滚

- 旧 history.jsonl：加载路径不校验新字段（可选列），零迁移。
- 回滚：单提交 git revert；运行时删除 `calibration.json` 即回退 ÷4；解析增强字段全部可选，revert 不留脏数据（history 中已落的新列被旧版本读取时被忽略）。

## 测试策略

- `calibration.mjs`：分桶、最小样本回退链、环形淘汰、median 正确性、persist/restore 往返。
- `rollout.mjs`：新字段解析（有/无 reasoningText、querySource 映射 role 的向后兼容）、旧行解析不回归。
- `store.mjs`：estimate 记录 tokPerSec 使用当前系数（mock calibration）。
