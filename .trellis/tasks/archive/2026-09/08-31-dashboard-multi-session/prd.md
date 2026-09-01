# 仪表盘多会话支持：并行会话实时统计

## Goal

多个 ZCode 会话并行时，各自的实时统计（当前速度、本轮累计、轮次收尾）互不干扰、均可查看；并支持把 7 天分析面板（趋势/模型/缓存）按会话过滤。现状：`state.mjs` 只有单一全局 turn 槽位，任何新会话的 `session_start`/`user_prompt_submit` 都会整体替换它，旧会话正在进行的统计被顶掉。

## Users & Value

- 用户：本机 ZCode 开发者（wangjin），日常同时开多个 ZCode 会话并行工作。
- 价值：并行会话互不干扰；每个会话的速度/累计/状态可见、可回看；能回答"这几个并行会话里哪个慢、哪个烧缓存"。

## Background（现状证据，详见 research-arch.md）

- 根因：单槽位 `s.turn` + `s.turnAgg`（state.mjs:9-30）被 `startTurn` 无差别替换（state.mjs:36-43, 56-67）。
- 伴生 bug：`stop` 事件不校验 sessionId（state.mjs:44-51），A 会话的 Stop 会关闭 B 会话的活跃轮次。
- 数据面无障碍：hook 事件（ensure.mjs:104-106）、rollout 记录（rollout.mjs:42）、history.jsonl（`sid` 字段）均带 sessionId；无 session_end 事件，会话结束只能靠 idle 超时推断。
- 全局态不受顶掉影响：近 20 次柱图、趋势/模型/缓存三面板（store 7 天聚合）、liteCount。
- 基线：v0.2.0（上一任务 dashboard-history-expand 已实现且测试全绿），本任务目标 0.3.0。

## Decisions（用户已确认）

- D1 UI 形态：**会话切换器**——tab 条 = "全部" + 各会话（短 ID + 活跃状态点）；实时区（大数字/本轮累计/详情/状态）展示所选会话；默认自动跟随最近活跃会话，用户点选后锁定，锁定的会话下线后回落自动跟随。
- D2 分析面板按会话过滤：**纳入本期**——选中会话 tab 时，趋势/模型/缓存三面板只统计该会话记录（store 聚合加可选 sessionId 过滤，覆盖 7 天历史/回填数据）；"全部"tab 维持全局口径。
- D3 会话生命周期：idle **30 分钟**下线；最多保留 **5** 个会话（超出挤掉最久未活跃）；仅内存态，收集器重启后清空，会话下次事件自动重建。

## Requirements

- R1 状态机多会话化：turn/turnAgg/closed 按 sessionId 分桶；`session_start`/`user_prompt_submit` 只作用于本会话桶；`stop` 只关闭本会话的活跃轮次（修复串扰）；rollout 记录按 sessionId 路由到对应会话桶。
- R2 会话生命周期（D3）：会话仅由 hook 事件创建；无 sid 记录宽松归属最近活跃会话（无会话则只进全局 history）；rollout 记录不自动建会话（防止启动回放近 20 条时复活旧会话）；tick 中 idle>30min 的会话下线，容量上限 5。
- R3 会话切换器（D1）：顶部 tab 条，"全部"+≤5 个会话 tab；实时区随选择切换；锁定与自动跟随语义如 D1。
- R4 分析面板过滤（D2）：store 聚合接口支持可选 sessionId；过滤视图排除无 sid 记录；全局口径与 v0.2.0 一致不回退。
- R5 兼容不回退：近 20 次柱图、liteCount、history.jsonl 格式与追加行为、SSE 事件名、hook POST 协议均不变；现有单会话使用路径行为等价。
- R6 约束延续：零依赖（Node 内置 + 原生 SVG/JS）；隐私红线（持久化不新增内容字段）；snapshot 体积可控（5 会话满载 + 全局 + 过滤聚合 ≤ ~100KB）。

## Acceptance Criteria

- [x] AC1 并行隔离：会话 A 生成中，会话 B 新开并提交 prompt —— `/api/state` 中 A 的 sessions 条目 tokens/requests 持续增长，不被清零；B 独立累计。（单测+curl 双会话冒烟实证）
- [x] AC2 stop 串扰修复：B 发 stop 后，A 的 turn 仍 active 且统计完好（单测注入事件序列覆盖）。
- [x] AC3 记录路由：A/B 的 rollout 记录各自只计入本会话 turnAgg；无 sid 记录计入最近活跃会话（单测覆盖）。
- [x] AC4 生命周期：lastEventMs 超前 31min 的会话在 tick 后下线；第 6 个会话出现时最久未活跃者被挤掉；均为单测可注入验证。
- [ ] AC5 切换器 UI：浏览器出现 "全部+会话" tab；点选会话后实时区切换且后续 SSE 刷新不跳回（锁定）；点 "全部" 恢复自动跟随；被锁会话下线后自动回落。（headless 已验逻辑无 JS 错误；真实浏览器双终端观感留用户手测）
- [x] AC6 过滤聚合：选中会话 tab 时趋势/模型/缓存数值与 rollout 数据中该 sid 子集核对一致（实现侧已实证：真实 sid 会话项 models Σn=156 与独立按 sid 解析计数一致）；"全部"tab 数值与 v0.2.0 全局口径一致。注：history.jsonl 行不含 sid（v0.2.0 契约即如此，R5 保持格式不变），跨重启的历史记录不参与会话过滤，README 已注明。
- [x] AC7 不回退：现有面板（柱图/lite/状态）行为不变；`node --test "test/*.test.mjs"` 全绿（36/36，含多会话与过滤聚合新单测）；check 代理对 bak/ 逐文件 diff 确认 store 编解码/去重/修剪、rollout、hooks 零改动。
- [x] AC8 体积：5 会话满载时 `/api/state` 响应 ≤ ~100KB。（实测 20-21KB）
- [x] AC9 版本与文档：版本 0.3.0 三处同步（server.mjs/plugin.json/newState）；README 增加多会话、生命周期、过滤口径说明。

## Out of Scope

- 会话友好名称/重命名/手动关闭 tab（仅短 ID + 自动生命周期）。
- 跨收集器重启的会话列表持久化（会话列表内存态）。
- 会话维度排行、导出 CSV/图片、跨设备同步、鉴权（延续上一任务边界）。

## Risks / Deferred

- 无 session_end 事件：结束判定纯靠 idle 超时，30min 内"暂停后回来"的会话仍在列表（符合预期）；僵尸 turn 收尾（30min）与下线（30min）叠加的时序细节见 design。
- 并行会话的真实验证依赖双终端手动冒烟；单测以注入事件序列为主。
- 每秒广播需计算 ≤6 份聚合（全局+5 会话），2 万条记录量级下为毫秒级，如实测超预算再做缓存（Deferred）。
