# Implement — Token速度仪表盘扩展

插件目录：`plugins/token-speed-dashboard/`。零依赖、无构建。每步末尾的"验证"通过后再进入下一步。

## 前置

- [ ] 备份回滚点：`cp dashboard/{server,state,rollout}.mjs dashboard/index.html test/*.mjs README.md <task dir>/bak/`
- [ ] 读 `.trellis/spec/backend/index.md`、`frontend/index.md`（模板态，无硬约束；遵守既有代码风格：防御式解析、纯函数状态、零依赖）

## Step 1 — store.mjs（纯逻辑，可单测）

新建 `dashboard/store.mjs`：
- `createStore({ now, windowMs=7d })`：`Map<id, rec>` 保存；`add(rec) -> bool`（去重 + 超窗拒绝）。
- `loadRecords(list)`（启动恢复/回填灌入用，逐条走 add）。
- `prune(now)`：丢 `completedAtMs < now-7d`。
- 聚合：`trend(now)`（hour ≤48 / day ≤7，main/lite 分桶：n/sumOut/sumDur/avg=Σout÷Σdur×1000）、`models()`（avg/p95/Σout/cacheHit，n 降序）、`cache()`（仅 source=rollout：Σcr/Σit/hit/Σcw/avgInput）、`view()`（snapshot 用的 trend/models/cache/store 块，含 count/since/backfilling）。
- p95：排序取 `Math.min(len-1, Math.ceil(0.95*len)-1)`。
- 验证：`node -e "import('./dashboard/store.mjs').then(m=>console.log(typeof m.createStore))"`

## Step 2 — store 单测（先行于接线）

新建 `test/store.test.mjs`（node:test，风格对齐现有 test/*.test.mjs）：
- 去重（同 id add 两次只计一次）；7d 窗口拒收与 prune；
- trend 桶边界（本地整点/日界）、main/lite 分离、吞吐加权 avg 手算核对；
- models p95（n=20 手算）、cacheHit 仅 rollout（插 estimate 记录验证排除）；
- loadRecords 对坏行/缺字段容错。
- 验证：`node --test test/store.test.mjs`

## Step 3 — 持久化 IO + 回填（server.mjs）

- `HISTORY_FILE = DATA_DIR/history.jsonl`；短名行格式（见 design 契约），解析函数放 store.mjs（纯函数 `encodeRow/decodeRow`）以便单测。
- 启动序列改造：
  1. 若 HISTORY_FILE 存在且非空：逐行 decode → `store.loadRecords`（decode 失败静默跳过）；`backfilling=false`。
  2. 否则：`backfilling=true`；异步一次性回填——新建 `RolloutTail(ROLLOUT_DIR, {seekStart:true})`（给 rollout.mjs 加最小开关：构造参数已有 `skipOlderThan`，再加 `fromStart` 使 `!inited` 时不 seek EOF 而是 offset=0），poll 全量 → 仅 `completedAtMs ≥ now-7d` 入 store → `writeFile(HISTORY_FILE, rows)` 覆盖落盘 → `backfilling=false` → 重建常态 tail（seek EOF）。
  3. listen/health/port.json 先行，不等待回填。
- 常态落盘：`pollRollout` 中 `store.add(r)` 成功才 `appendFile(HISTORY_FILE, row)`（失败仅 console.error）+ 现有 `applyRecord`。
- 修剪：beatTimer 内每日一次 `store.prune()`（不重写文件）。
- rollout.mjs 改动：`fromStart` 选项一处（`if (!this.inited && !this.opts.fromStart) {…seek EOF…}` 语义），默认行为不变；补一条 rollout.test.mjs 用例证明默认仍 seek EOF。
- 验证：`node --test test/*.test.mjs`；手动冒烟：`ZCODE_PLUGIN_DATA=/tmp/tsd-smoke node dashboard/server.mjs &` → curl /api/state 看 `store.count/backfilling` → kill → 检查 /tmp/tsd-smoke/history.jsonl 有行 → 重启 count 保留、无翻倍。

## Step 4 — snapshot 接线（state.mjs）

- `newState()` 挂 store 引用（或 server 侧闭包注入 snapshot(state, now, storeView)——取后者，state.mjs 保持无 IO 纯函数与现有单测不破）。
- `snapshot()` 增 `trend/models/cache/store` 四块（来自传入的 storeView）。
- 现有 `history`（近20条）、turn 聚合、SSE 结构不动（R6）。
- state.test.mjs 补：snapshot 带 storeView 时新字段透传、无 storeView 时省略不报错（向后兼容）。

## Step 5 — UI（index.html）

- 三块新面板（位置与形态见 design §UI）：趋势 SVG 折线（hour/day tab）、模型对比 table、缓存分析大数卡。
- 渲染函数纯 JS 字符串模板拼 SVG（对齐现有 innerHTML 风格，无框架）。
- 空态：无数据显示 .empty 占位；`store.backfilling` 时趋势面板显示"回填历史中…"。
- 版本 badge：`state.version → 0.2.0`（server.mjs VERSION + .zcode-plugin/plugin.json + newState 默认三处同步）。
- 验证（手动浏览器）：打开 http://127.0.0.1:<port>/ ——console 无报错；现有四块面板行为与改动前截图一致；趋势/模型/缓存三块渲染出回填的 7 天数据；窄屏（≤640px）单列不破版。

## Step 6 — 收尾验证（全量）

- [ ] `node --test test/*.test.mjs` 全绿（含新 store.test、补强的 rollout/state 用例）
- [ ] AC 映射手测：AC1 kill+重启恢复 / AC2 删 history 回填去重（对比 rollout 行数）/ AC3 非空不重扫（server.log 无 backfill 行）/ AC4 curl /api/state 结构+手算核对 / AC6 estimate 排除 / AC7 注入 8 天前记录验证修剪 / AC9 `grep -iE '"(prompt|text|messages|metadata)"' history.jsonl` 无命中
- [ ] README：新增功能段（趋势/模型/缓存）、history.jsonl 数据文件说明、卸载清理路径更新
- [ ] 版本三处一致 0.2.0；备份 .bak 删除

## 风险文件 / 回滚点

- 触碰：`dashboard/store.mjs`（新增）、`dashboard/server.mjs`、`dashboard/state.mjs`、`dashboard/rollout.mjs`（仅 fromStart 开关）、`dashboard/index.html`、`test/*`、README、plugin.json。
- 回滚：Step 3 末与 Step 5 末是两个人工验证 gate；任一失败 → 从 task bak/ 目录整文件恢复。history.jsonl 删除即回到首启态，无迁移残留。
- 不动：hooks/（ensure.mjs 的 POST 协议不变）、port.json 机制、SSE 事件名。

## Validation commands 速查

```bash
cd plugins/token-speed-dashboard
node --test "test/*.test.mjs"
# 冒烟（隔离数据目录）
ZCODE_PLUGIN_DATA=/tmp/tsd-smoke ZCODE_ROLLOUT_DIR=$HOME/.zcode/cli/rollout node dashboard/server.mjs &
curl -s 127.0.0.1:4521/api/state | python3 -m json.tool | head -60
curl -s 127.0.0.1:4521/health
kill %1
```
