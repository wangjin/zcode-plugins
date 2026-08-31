# Design — 仪表盘多会话支持

## 架构与边界

```
hook events (sessionId) ──▶ state.mjs：sessions Map<sid, sess>（turn/turnAgg/closed/last 分桶）
rollout records (sessionId) ──┘    │ 无 sid → 最近活跃会话（宽松归属）；未知 sid → 只进全局 history
                                   │
                            snapshot(s, now, store)
                                   │  sessions[]（每会话实时态 + 该会话过滤聚合 trend/models/cache）
                                   │  顶层：全局 history/liteCount/lastLite + 全局聚合
                            /api/state + SSE ──▶ index.html（tab 条 + 选择逻辑 + 实时区/分析区渲染）
```

- **state.mjs 重构为核心改动**（纯函数、无 IO 保持）：
  - `s.sessions = Map<sid, sess>`，`sess = { sessionId, firstSeenMs, lastEventMs, turn, turnAgg, closed, last }`。
  - 全局保留：`history`（近 20 条柱图）、`liteCount`、`lastLite`、`dataState`、`lastRecordMs`、`server`。
- **server.mjs 基本不动**：`applyEvent/applyRecord/tick/snapshot` 签名不变，仅 VERSION → 0.3.0。
- **store.mjs 小改**：`view(now, opts)` 增可选 `opts.sessionId` 过滤。
- **hooks/ensure.mjs / rollout.mjs / history.jsonl**：零改动。

## 事件与记录路由规则

| 输入 | 规则 |
|---|---|
| `session_start`(sid) | 会话桶存在且 turn active 且 lastEvent<60s → 忽略（既有防抖，改为桶内判断）；否则 `startTurn(sess)`（新建桶若不存在） |
| `user_prompt_submit`(sid) | 无条件 `startTurn(sess)`（新建桶若不存在） |
| `stop`(sid) | 桶存在且 turn active → `closeTurn(sess, sawStop=true, estTokens)`；桶不存在或未 active → 忽略（修复串扰；server 重启后的孤儿 Stop 不再刷新任何会话） |
| record(sid=已知桶) | `sess.last=r`(main)；turn active 时计入 `sess.turnAgg`；刷新 `sess.lastEventMs`；同时进全局 history/liteCount |
| record(sid=null) | 宽松归属 `lastEventMs` 最大的会话桶（同上计入）；无任何会话 → 跳过 turn 聚合，仅进全局 |
| record(sid=未知) | **不自动建桶**（防启动回放 `store.recent(20)` 复活旧会话，server.mjs:101）；仅进全局 history/liteCount |

- `startTurn` 时若 `sessions.size ≥ 5`：挤掉 `lastEventMs` 最小的桶（绝不挤正在 start 的这个）。
- `tick()` 每秒：先逐会话僵尸收尾（turn active 且 lastEvent>STALE_AUTO_CLOSE_MS=30min → closeTurn）；再淘汰 lastEvent>SESSION_IDLE_MS=30min 的桶。注意 closeTurn 会刷新 lastEventMs → 僵尸轮会话从"最后事件"起再留 30min 供查看收尾摘要，随后下线（时序：T+30min 收尾、T+60min 下线）。

## 数据契约

### `/api/state` / SSE snapshot（v0.3.0）

```jsonc
{
  version: "0.3.0", server: {…}, now,
  generating: true,            // 任一会话 active（连接徽标用）
  sessions: [                  // ≤5，按 lastEventMs 降序
    {
      sessionId, lastEventMs, generating, stale,
      turn: { startedAtMs, elapsedMs, tokens, requests, avgTokPerSec, sawStop },  // 形状同 v0.2.0 顶层 turn
      closed,                  // 形状同 v0.2.0 顶层 closed
      last,                    // 该会话最近 main 记录（hero 用）
      trend: {…}, models: […], cache: {…}   // 该 sid 过滤聚合（D2；store 传入时才有）
    }, …
  ],
  history: […], liteCount, lastLite, dataState, lastRecordAgeMs,   // 全局（不变）
  trend: {…}, models: […], cache: {…}, store: {…}                  // 全局聚合（"全部"tab；不变）
}
```

- **顶层 `turn`/`closed`/`sessionId`/`stale`/`last` 移除**（被 sessions[] 取代）；插件自包含（server+UI 同版本发布），无外部消费方，一次切换干净。顶层 `generating` 保留（= 任一会话 active）。
- 体积：每会话过滤聚合 ≈ 4KB（48+7 桶×2 角色 + 模型行 + cache），5 会话 + 全局 + 实时区 ≈ 25-30KB，AC8 预算内。

### store.view 过滤语义

- `view(now, { sessionId })`：trend/models/cache 只统计 `r.sessionId === sessionId` 的记录；`sessionId` 缺省 → 全局（现行为）。
- 过滤视图排除 `sessionId=null` 记录（无法归属）；cache 块的 estimate 排除规则不变。
- history.jsonl、encodeRow/decodeRow、去重、修剪逻辑零改动。

## UI（index.html）

- **Tab 条**（hero 区上方）：`全部` + 各会话（`sid.slice(0,13)` + 状态点：🟠 生成中 / 🟢 空闲）。点击 → `selectedSid`；`selectedSid=null` 为自动跟随（取 sessions[0]，即最近活跃）。渲染前校验 `selectedSid` 仍在 sessions 中，不在则回落 null。
- **实时区**（hero/本轮累计/详情/状态）：数据源从顶层字段改为所选会话对象；模板不变，仅取值路径调整（`s.turn` → `sess.turn`、`s.last` → `sess.last`、会话行显示 sess.sessionId；"全部"tab 跟随时状态区会话行 = 跟随中的会话）。无会话时整块为等待态（现行为）。
- **分析三面板**：`renderTrend/renderModels/renderCache` 改为接收数据块参数；选中会话 → `sess.trend/models/cache`，"全部" → 顶层三块。面板标题追加当前口径（"全部会话"/`sid 前 13 位`）。
- SSE 渲染流程不变（`event: state` → render）。

## 兼容与迁移

- 单会话用户路径等价：一个会话时 tab 条 = `全部` + 1 tab，实时区自动跟随，与 v0.2.0 观感一致。
- v0.2.0 → v0.3.0 无持久化迁移（会话列表内存态；history.jsonl 不变）。
- 版本：server.mjs `VERSION`、`.zcode-plugin/plugin.json`、`newState()` 默认 → `0.3.0`。
- README：新增"多会话"段（tab 语义、30min 下线/上限 5、过滤口径、无 sid 记录的宽松归属说明）。

## 测试设计

- `test/state.test.mjs`：
  - 并行隔离：A startTurn → B startTurn → A 记录 ×2 → A.turnAgg 增长、B 不受影响；B 记录只进 B。
  - stop 路由：A active 时 B stop → A 仍 active；A stop → A closed、B 不变。
  - 无 sid 记录归属最近活跃桶；未知 sid 记录不建桶。
  - 生命周期：注入时钟验证 30min 僵尸收尾、30min 下线、第 6 会话挤掉最久未活跃。
  - snapshot：sessions[] 结构/排序/过滤聚合嵌入（传 fake store）；顶层无 turn/closed/last/sessionId；store 缺省时省略聚合（向后兼容单测风格）。
  - 既有单会话用例改写为"事件驱动"（经 applyEvent 建桶后断言 sess 内字段）。
- `test/store.test.mjs`：`view(now,{sessionId})` 过滤正确性；null-sid 排除；缺省=全局不变。
- 手动冒烟（AC1/AC5/AC6）：双终端并发两会话 + 浏览器 tab 切换 + history.jsonl sid 子集核对。

## Trade-offs 记录

- 每会话聚合进 snapshot（而非独立查询接口）vs 按需 `/api/session/<sid>`：选前者——SSE 无回传通道，前端选中态服务端不可知；体积实测预算内，且多浏览器 tab 打开时各客户端独立选择无需服务端状态。
- 无 sid 记录宽松归属 vs 全部跳过：选宽松归属——延续 v0.2.0 "任一侧 null 则计入"的宽松语义（state.mjs:106），实测无 sid 记录占比趋近 0，两种口径几乎无差。
- 未知 sid 记录不建桶 vs 自动建桶：选不建桶——建桶会让启动回放近 20 条复活几天前的会话 tab，违背 D3 生命周期直觉。
- 顶层旧字段移除 vs 保留投影：选移除——自包含插件无外部消费方，双份下发徒增体积与歧义。

## Rollback

- 实现前将 `dashboard/{state,store,server,index.html}` 与 `test/{state,store}*.mjs`、README、plugin.json 备份至本任务 `bak/`；验收失败整文件恢复即回 v0.2.0。
- 无数据迁移（history.jsonl 不动），回滚零残留。
