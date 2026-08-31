# Design — Token速度仪表盘扩展

## 架构与边界

```
rollout/*.jsonl ──(首启一次性回填 scan / 增量 RolloutTail.poll)──▶ store (新增 dashboard/store.mjs)
                                                                      │ 追加 history.jsonl（纯持久化通道）
hook events ──▶ state.mjs（turn 实时逻辑，不动） ◀── records 同源来自 store
                                   │
                          snapshot(state) ──▶ /api/state + SSE ──▶ index.html（新增 3 面板 + SVG 图）
```

- **新增 `dashboard/store.mjs`**——纯逻辑 + 文件 IO 各一半：
  - `RecordStore`（纯内存可单测）：`add(rec)` 去重（`Map<id, rec>`，id 同现 rollout.mjs 的 requestId 回落规则）、7 天修剪、聚合查询（trend 桶 / models / cache）。
  - `openHistory(dir)`（薄 IO 层，不进单测核心）：`history.jsonl` 逐行 append（单条 <1KB，直接 `appendFile` 即可，量级 ~每秒 <1 条无需缓冲）；启动时整读恢复。
- **state.mjs 改动最小**：`newState()` 增加 `store` 引用；`applyRecord` 改为"store.add 成功（未去重掉）才 pushHistory/聚合"，turn 实时逻辑不变；`snapshot()` 增加 `trend/models/cache` 三块聚合，**不下发原始记录列表**（AC10 体积约束）。
- **server.mjs**：启动序列 →
  1. 读 `history.jsonl`；若有内容：直接灌入 store（增量 tail 照常 seek EOF——现有行为）。
  2. 若文件缺失/为空：首启回填模式——`new RolloutTail(dir, { skipOlderThan: now-7d })` 关闭"seek 到 EOF"短路（构造参数已有钩子位），一次性 poll 全部 rollout 文件，仅接受 `completedAt ≥ now-7d` 的记录入 store；完成后写 `history.jsonl`（含一条首行 meta 或文件存在即视为已回填）。回填 IO 与 HTTP listen 并发，先起服务后灌数据（UI 显示"回填中"由 dataState 复用即可，不新增状态机状态）。
  3. 之后恢复常态：增量 poll（seek EOF）→ store.add → append history.jsonl。
- **去重与重启幂等**：内存 `Map<id>` 是唯一去重点（进程生命周期内）。风险：增量 tail 读到与 history.jsonl 恢复重叠的行？不会——history 恢复的 id 全部进 Map，tail 再吐同 id 被 `add()` 拒绝且不重复写文件。追加写只在 `add()` 返回 true 时发生。

## 数据契约

### history.jsonl 行格式（每行一条解析后记录，无内容字段）

```json
{"id":"…","sid":"…","t":1725095938265,"m":"qwen3.8-flash-next","r":"main","s":"rollout",
 "ot":608,"it":73131,"cr":32000,"cw":0,"d":7695,"tps":79.0}
```
字段短名（`t`=completedAtMs，`d`=durationMs，`ot/it/cr/cw`=usage 四类 token，`tps`=tok/s，`s`=source，`r`=role）。坏行 JSON.parse 失败静默跳过（防御式原则同 rollout.mjs）。

### `/api/state` 新增块（snapshot 下发）

```jsonc
"trend": {
  "hour": [{"b": 1725062400000, "main":{"n":12,"sumOut":8400,"sumDur":92000,"avg":91.3}, "lite":{…}}, …≤48],
  "day":  [ 同上, ≤7 ]
},
"models": [{"modelId":"…","role":"main","n":182,"avg":79.2,"p95":120.4,"sumOut":…,
            "cacheHit":0.62, "lastMs":…}],
"cache":  {"sumRead":…,"sumInput":…,"hit":0.62,"sumWrite":…,"avgInput":…},
"store":  {"count":1234,"since":…,"backfilling":false}
```

聚合口径（全部吞吐加权，避免小响应拉偏均值）：
- 桶 avg = Σoutput ÷ Σduration×1000；p95 = 对该 model×role 的逐条 tokPerSec 排序取 0.95 位（7 天 ~2 万条，排序成本毫秒级可忽略）。
- `cacheHit = ΣcacheRead ÷ ΣinputTokens`（实测 input 含 cacheRead，见 PRD 证据）；**仅统计 source=rollout**。
- 桶边界：hour=本地整点（`new Date(y,m,d,h)` 毫秒起点），day=本地 0 点。时区用收集器进程本地，与用户一致。
- `store.backfilling`：回填未完成时为 true，UI 在趋势面板显示"回填历史中…"。

## 兼容与迁移

- 老 history.jsonl 不存在 = 首启回填路径；存在 = 直接恢复。**history 文件损坏/半行**：逐行 try-parse 跳过，不因坏行拒启。
- `state.version` 升 `0.2.0`，plugin.json version 同步。
- 卸载清理：README 数据目录说明补 `history.jsonl`；卸载命令不变。
- 隐私面：history.jsonl 新增 `it/cr/cw` 数值与 `sid`——均非内容；符合 R7。

## UI（index.html 原生 SVG，无依赖）

新增三块，插在现有"近 20 次条形图"之后、详情/状态行之前；移动端单列（沿用 .grid 断点）：

1. **速度趋势**：切换 小时(48)/天(7)（两个 tab 按钮，纯前端切换 snapshot 里已有的两块数据）。SVG 折线+面积：x=时间桶、y=avg tok/s（main 蓝主线，lite 灰虚线），hover tooltip 显示 n/Σout/avg。轴刻度 3 条水平网格线即可，不做全轴系。
2. **模型对比表**：原生 table，列=model、角色、请求数、avg、p95、Σout、缓存命中%。按 n 降序；单模型时一行为预期。
3. **缓存分析**：一行大数（7天命中率）+ cacheRead vs cacheWrite 两枚副数 + 输入规模 avg；小字注明口径"cacheRead ÷ input（input 含 cacheRead）"。
- 断数据表现：无记录时三面板显示占位文案（沿用 .empty 样式）；`backfilling` 时趋势面板显示"回填历史中…"。
- SSE 负载：snapshot 增 trend/models/cache/store，去掉原 history 内联？——**不去**，近 20 条仍是实时条形图数据源，保留原样（R6 不回退）。体积估算：48+7 桶 ×2 角色 + 模型数 ≤10 + 20 条明细 ≈ <20KB，满足 AC10。

## server.mjs 时序（回填不阻塞服务）

```
listen(port) → 写 port.json            ← 先可用
async: readHistoryFile()                → store.load(records)   // 若空文件 → 进入回填
       if (backfill) tailBackfill()     // 新建 RolloutTail，seek 到 0，poll() 全量，过滤 7d
                                        // 完成后 store.prune() + 全量落盘 history.jsonl（覆盖写）
       常态 poll 循环（既有 setInterval+watch）复用同一 tail 实例？——否：
       回填用独立 tail 实例（seek=0），完成后把 offsets 快照交给常态 tail（或干脆常态 tail 首次 poll 在回填完成后执行，seek EOF 时自然不重读——去重 Map 兜底）。
       选后者：回填完成后重建常态 tail（seek EOF），重叠靠 Map 去重。逻辑最简单。
```

- history 落盘：常态下 `store.add()` 成功即 `appendFile`（失败仅 console.error，内存不丢）；回填一次性覆盖写。
- 修剪：`store.prune()` 每日 tick（挂到现有 beatTimer，60s 一次判日期变更）修剪后**不重写文件**（append-only，旧行在下次回填级重建或启动恢复时按 7d 过滤丢弃）；启动恢复时同样过滤 → 文件膨胀上限 ≈ 14 天写入量 <10MB，可接受，不做原地重写以保持简单与断电安全。

## Trade-offs 记录

- 吞吐加权 avg（Σout/Σdur）vs 逐条算术平均：选前者——反映真实"这段时间产出速率"，小请求不拉偏；UI tooltip 里同时给条数。
- append-only + 读时过滤 vs 定期重写：选前者，实现最小、无并发重写风险；14 天上限体积可接受。
- 聚合放 server（snapshot 下发）vs 下发原始记录前端聚合：选 server 聚合——SSE 负载受控（AC10），前端零逻辑负担，且测试集中在 store.mjs 纯函数。
- hour/day 桶在本地时区：与用户直觉一致；跨年 day 桶用 Date 对象边界无字符串解析坑。

## Rollback

单文件级回滚：`store.mjs` 新增、`server.mjs/state.mjs/index.html` 改动集中；git 未初始化（detached 非 git 仓？）——本仓无 git，回滚点=实现前对 4 个文件做 `.bak` 副本，验收通过后删除。history.jsonl 删除即回到首启回填态，无害。
