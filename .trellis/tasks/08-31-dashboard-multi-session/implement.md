# Implement — 仪表盘多会话支持

插件目录：`plugins/token-speed-dashboard/`（注意仓内双层 plugins）。零依赖、无构建。每步"验证"通过后再进下一步。设计细节与 file:line 锚点见本任务 `research-arch.md` 与 `design.md`。

## 前置

- [ ] 备份回滚点（v0.2.0 现状）到本任务 `bak/`：`dashboard/{state.mjs,store.mjs,server.mjs,index.html}`、`test/{state,store}.test.mjs`、`README.md`、`.zcode-plugin/plugin.json`
- [ ] 读 `research-arch.md`（根因与锚点）+ `design.md`（路由表/契约/权衡）

## Step 1 — store.mjs：view 按 sid 过滤

- `view(now, opts)` 增可选 `opts.sessionId`；trend/models/cache 聚合循环按 `r.sessionId === sid` 过滤；缺省=全局现行为。
- 过滤视图排除 `sessionId=null` 记录；encodeRow/decodeRow/去重/修剪零改动。
- 验证：`node --test test/store.test.mjs`（先补过滤用例，见 Step 2）

## Step 2 — store 单测补充

`test/store.test.mjs` 新增：
- `view(now,{sessionId})` 只统计该 sid（trend 桶值/models 行/cache 数值手算核对）；
- null-sid 记录不出现在过滤视图、但出现在全局视图；
- 缺省调用结果与 v0.2.0 全局口径一致。
- 验证：`node --test test/store.test.mjs`

## Step 3 — state.mjs 多会话重构（核心）

按 design 路由表重构：
- `newState()`：`sessions: new Map()` 替代 `turn/turnAgg/closed/sessionId`；`last` 移入会话桶；全局保留 history/liteCount/lastLite/dataState/lastRecordMs/server；默认 version → `0.3.0`。`DEFAULTS` 增 `SESSION_IDLE_MS: 30*60*1000`、`SESSION_CAP: 5`。
- `applyEvent`：三事件按 design 路由（start/prompt → 本会话 startTurn 含 60s 防抖桶内化；stop 仅关本会话；孤儿 stop 忽略）。
- `applyRecord`：按 design 三分支路由（已知桶/无 sid 宽松归属/未知 sid 只进全局）；turnAgg 计入条件简化为"桶存在且桶 turn active"。
- `tick`：先逐桶僵尸收尾（STALE_AUTO_CLOSE_MS）再逐桶下线淘汰（SESSION_IDLE_MS）；`startTurn` 建桶时执行容量淘汰。
- `snapshot(s, now, store)`：输出 design 契约——顶层去 turn/closed/last/sessionId/stale，保留 generating(任一 active)；`sessions[]` 按 lastEventMs 降序，每项含实时态 + `store` 传入时的 `trend/models/cache`（`store.view(now,{sessionId})`）；全局块不变；store 缺省时聚合字段省略（兼容单测）。
- 验证：`node -e "import('./dashboard/state.mjs').then(m=>console.log(typeof m.applyEvent, typeof m.snapshot))"`

## Step 4 — state 单测改造 + 新增

`test/state.test.mjs`：
- 既有单会话用例改事件驱动（applyEvent 建桶后断言桶内 turn/turnAgg/closed）；
- 新增：并行隔离 / stop 路由（AC2）/ 无 sid 归属 / 未知 sid 不建桶 / 僵尸收尾+下线+容量淘汰（注入时钟）/ snapshot 结构与排序（fake store 验证过滤聚合嵌入、顶层旧字段移除）。
- 验证：`node --test test/state.test.mjs`

## Step 5 — UI（index.html）

- Tab 条（hero 上方）：`全部` + 会话 tab（`sid.slice(0,13)`+状态点）；`selectedSid` 前端状态，点击锁定，失效回落 null=自动跟随 sessions[0]。
- render：实时区取值路径改所选会话对象（hero/本轮累计/详情/状态，模板不动）；无会话时等待态。
- `renderTrend/renderModels/renderCache` 参数化：选中会话用 `sess.trend/models/cache`，全部用顶层三块；面板标题显示口径。
- 版本徽标自动随 `state.version`（无需单独改）。
- 验证（手动浏览器）：双终端各开一个 ZCode 会话并发对话 → 两个 tab 均出现且互不顶掉；点选锁定后 SSE 刷新不跳回；"全部"恢复全局分析；窄屏单列不破版、console 无报错。

## Step 6 — 版本/文档/收尾

- [ ] `server.mjs` VERSION → `0.3.0`；`.zcode-plugin/plugin.json` → `0.3.0`（newState 默认已在 Step 3 同步）。
- [ ] README：多会话段（tab 语义、30min 下线/上限 5、过滤口径、无 sid 宽松归属）。
- [ ] `node --test "test/*.test.mjs"` 全绿。
- [ ] AC 手测映射：AC1/AC5 双终端+浏览器；AC6 选中 tab 数值 vs `grep sid history.jsonl` 子集核对；AC8 `curl -s /api/state | wc -c` 估体积。
- [ ] 验收通过后删 `bak/`。

## 风险文件 / 回滚点

- 触碰：`dashboard/state.mjs`（重构核心）、`dashboard/store.mjs`、`dashboard/index.html`、`dashboard/server.mjs`（仅 VERSION）、`test/{state,store}.test.mjs`、README、plugin.json。
- 回滚 gate：Step 4 末（状态机测试全绿）与 Step 5 末（浏览器验收）两个检查点；失败 → 从 `bak/` 整文件恢复回 v0.2.0。无数据迁移，零残留。
- 不动：`hooks/`、`rollout.mjs`、history.jsonl、port.json 机制、SSE 事件名。

## Validation commands 速查

```bash
cd plugins/token-speed-dashboard
node --test "test/*.test.mjs"
# 冒烟（隔离数据目录）
ZCODE_PLUGIN_DATA=/tmp/tsd-smoke ZCODE_ROLLOUT_DIR=$HOME/.zcode/cli/rollout node dashboard/server.mjs &
curl -s 127.0.0.1:4521/api/state | python3 -m json.tool | head -80   # 看 sessions[] 结构
curl -s 127.0.0.1:4521/api/state | wc -c                             # AC8 体积
kill %1
```
