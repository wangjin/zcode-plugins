# implement.md — 速度口径核实与动态校准系数

## 前置

- [ ] 阅读 `.trellis/spec/` 相关节点规范（backend/frontend index 中与 Node 收集器相关条目）
- [ ] `node --test "test/*.test.mjs"` 基线全绿

## 执行清单（按序）

### 阶段 1 · R1 核实（research.md 为交付物，不改生产代码）

- [ ] 实验 A：rollout per-turn outputTokens 求和 ↔ `turn_usage.output_tokens` 对账（近 3 天，`sqlite3` CLI 只读；对账脚本放本任务目录 `research/`）
- [ ] 实验 B：reasoningText 有/无两组的 chars÷outputTokens 回归对比
- [ ] 实验 C：durationMs ↔ (completedAt−startedAt) 偏差占比
- [ ] **评审门**：结论写入 `research.md`；若结论要求改 speed 主公式分子 → 停，回父任务调整（不擅改）
- 回滚点：纯脚本，无生产改动

### 阶段 2 · calibration.mjs（新纯函数模块）

- [ ] 实现：分桶、环形 buffer(200)、median、回退链（模型 ≥20 → 全局 ≥50 → 4.0）、serialize/deserialize
- [ ] 单测：`test/calibration.test.mjs`（design 测试策略全项）
- 回滚点：独立新文件，revert 零影响

### 阶段 3 · rollout.mjs 解析增强

- [ ] `parseRolloutLine` 增 `reasoningChars` / `querySource` / `startedAtMs`（可选字段）
- [ ] `role` 判定优先 `querySource`（`main_turn` → main；其余沿用 `model.role` 规则），补兼容用例
- [ ] 单测扩展：`test/rollout.test.mjs`
- 回滚点：字段可选，单独 revert 不破坏解析

### 阶段 4 · 接线 store.mjs / server.mjs

- [ ] estimate 路径：`outputTokens = round(chars ÷ k(modelId))`，k 来自 calibration 实例
- [ ] 每条精确记录喂桶；心跳 + 30s debounce 持久化 `calibration.json`
- [ ] 启动恢复：读 `calibration.json`（缺失/损坏 → 静默重建）
- [ ] 单测：`test/store.test.mjs` 增 estimate 用系数的用例（mock calibration）
- 回滚点：删除 `~/.zcode/plugin-data/zcode-metrics/calibration.json` 即运行时回退 ÷4

### 阶段 5 · 文档与收尾

- [ ] README"设计要点"：÷4 → 动态校准说明；口径段落补 research.md 结论一句话
- [ ] 版本号：随父任务集成统一升（本任务不动 plugin.json）

## 验证命令

```bash
cd plugins/zcode-metrics && node --test "test/*.test.mjs"
# 手动冒烟：发一条消息 → curl localhost:<port>/api/state | python3 -m json.tool | grep -i tokPerSec
# 校准文件：cat ~/.zcode/plugin-data/zcode-metrics/calibration.json
```

## 评审门汇总

1. 阶段 1 末：口径结论评审（可能触发父任务口径调整）
2. 阶段 4 末：trellis-check 全量检查（最后一次迭代按全scope跑）
