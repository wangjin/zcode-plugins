# Research — 仪表盘现状架构与多会话改造锚点

> 调研时间：2026-08-31。**改名记录（2026-08-31 晚）**：插件已由 `token-speed-dashboard` 更名 **`zcode-metrics`**（v0.3.0，功能扩展后原名过窄）。仓库路径现为 `plugins/zcode-metrics/`；下文旧路径均按此映射。改名涉及：目录名、plugin.json name、marketplace.json name+source、代码注释/日志前缀/数据目录回退路径、UI 标题。安装侧需客户端卸旧装新（插件 ID 变更），数据目录 `~/.zcode/cli/plugins/data/zcode-metrics@zcode-local-dev/` 由旧目录预迁移。
> 本文件是实现/检查子代理的必读上下文，所有 file:line 以 v0.2.0 现状为准。

## 1. 根因：单 turn 槽位如何被"顶掉"

`dashboard/state.mjs`（197 行）核心结构：

- `newState()`（state.mjs:9-30）：**全局唯一** `s.turn`（active/sessionId/startedAtMs/lastEventMs/closedAtMs/sawStop）+ `s.turnAgg`（totalOutputTokens/requestCount/avgTokPerSec）+ `s.closed`（收尾快照）。
- `applyEvent()`（state.mjs:33-54）：
  - `session_start` / `user_prompt_submit` → `startTurn(s, sid, now)`（state.mjs:56-67）**整体替换** `s.turn` 并清零 `s.turnAgg`/`s.closed` —— 任何会话的新事件都会顶掉当前正在统计的轮次。session_start 有 60s 同 sid 防抖（state.mjs:37），user_prompt_submit 无条件。
  - `stop`（state.mjs:44-51）**不校验 sessionId**：关掉的是"当前唯一 turn"，无论它属于哪个会话 → 跨会话串扰 bug。
- `applyRecord()`（state.mjs:96-114）：rollout 记录先进全局 `pushHistory`（近 20 条柱图）；main 记录仅当 `r.sessionId === s.turn.sessionId`（或任一侧为 null，state.mjs:106）才计入 turnAgg。
- `tick()`（state.mjs:133-139）：STALE_AUTO_CLOSE_MS=30min 的僵尸 turn 收尾，仅作用单一 turn。
- `snapshot(s, now, store)`（state.mjs:143-196）：顶层下发 `generating/stale/sessionId/turn/closed/last/lastLite/liteCount/history/dataState`；`store` 传入时附加 `trend/models/cache/store` 四块（store.view(now)，state.mjs:188-194）。

## 2. 数据源：sessionId 齐全，无需动数据层

- hook 事件：`hooks/ensure.mjs` POST `/internal/event`，body 含 `kind` 与 `sessionId`（ensure.mjs:104-106，取 `input.session_id || input.sessionId`）。事件种类只有 `session_start` / `user_prompt_submit` / `stop`。**没有 session_end**。
- rollout 记录：`dashboard/rollout.mjs` `parseRolloutLine()` 产出 `sessionId`（rollout.mjs:42）；实测 182/182 条带 sessionId（无 sid 是极小概率防御分支）。
- 持久层：`dashboard/store.mjs` 的 history.jsonl 行含 `sid` 短字段；`store.view(now)` 现只出全局聚合，无按 sid 过滤能力。

## 3. server.mjs 接线（改造时基本不动）

- `ingest(r)`（server.mjs:60-66）：`store.add` 成功 → append history.jsonl → `applyRecord(state, r)`。
- 事件入口 POST `/internal/event`（server.mjs:190-204）：`applyEvent(state, ev)` → `pollRollout()` → `broadcast()`。
- 广播/快照统一走 `snapshot(state, Date.now(), store)`（server.mjs:127,175,185）。
- 启动回放：`startupStore()` 第 3 步把 `store.recent(20)` 逐条 `applyRecord`（server.mjs:101）——多会话改造后这段**不应**复活旧会话（见 design 决策）。
- 心跳 `beatTimer`（server.mjs:114-123）：每秒 `tick(state)`；每日 `store.prune()`。

## 4. UI 消费点（index.html）

- `render(s)`（index.html:143 起）：
  - hero 大数字：`s.generating` + `s.turn`（elapsed/tokens/avg），否则 `s.last.tokPerSec`；
  - 本轮累计卡：`s.turn` / `s.closed`；
  - 近 20 次柱图：全局 `s.history`；
  - 详情卡：全局 `s.last`；状态卡：`s.sessionId.slice(0,13)` + `s.generating/s.stale` + `liteCount`；
  - 分析三面板：`renderTrend()`（读 `lastSnap.trend`，hour/day tab 前端切换）、`renderModels(s)`、`renderCache(s)`。
- SSE：`event: state` 全量快照推送，前端无回传通道（选中的 tab 是纯前端状态，服务端无感知）。

## 5. 既有约束与风格（必须延续）

- 零依赖：Node 内置 API + 原生 SVG/JS 字符串模板，无 npm、无构建。
- 防御式解析：坏输入静默跳过（rollout.mjs / store decodeRow 同风格）；state.mjs 纯函数、无 IO、可单测。
- 单测：`node:test`，`test/state.test.mjs`、`test/store.test.mjs`、`test/rollout.test.mjs`，风格为直接断言函数行为。
- 版本四处同步：`server.mjs` VERSION、`.zcode-plugin/plugin.json`、`newState()` 默认 version、**仓库根 `marketplace.json`**（0.3.0 部署时发现：本地市场 `zcode-local-dev` 的插件安装走 `~/.zcode/cli/plugins/cache/zcode-local-dev/token-speed-dashboard/<ver>/` 缓存，marketplace.json 版本不升则客户端重装永远拉旧版）。
- 部署链路：改仓库源码 ≠ 生效——需同步安装缓存（rsync 到 cache 目录）或客户端重装插件；收集器数据目录实际为 `~/.zcode/cli/plugins/data/token-speed-dashboard@zcode-local-dev/`（客户端经 `ZCODE_PLUGIN_DATA` 注入，非 server.mjs 的默认回退路径）；升级后需 kill 旧收集器进程（hook 自动重拉）并刷新浏览器页（旧页面缓存的是旧 index.html）。
- 隐私红线：持久化文件不含任何请求/响应内容；多会话新增字段仅 sid/数值。

## 6. 版本基线

v0.2.0（上一任务 dashboard-history-expand 已实现：7 天持久化 + 趋势/模型/缓存面板，测试全绿）。本任务基于其上，目标版本 0.3.0。
