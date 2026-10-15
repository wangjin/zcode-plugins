# design · zcode-metrics 客户端注入式状态栏

## 1. 总体架构

```
~/.zcode/zcode-metrics-overlay/           运行时目录（插件安装时从插件目录复制）
├── inject-main.cjs        主进程 loader（被 asar 注入行 dynamic import）
├── overlay.js             渲染端状态条（loader 读文件注入各窗口）
├── query.py               查询器（serve 常驻 + json 一次性双模式）
└── config.json            {context_window, activity_min_ms, heartbeat_ms, ...}

plugins/plugins/zcode-metrics/overlay/    插件源（发布随插件分发，安装时复制到运行时目录）
├── inject-main.cjs
├── overlay.js
├── query.py
└── install/patch_install.py   安装器（用户手动执行，不进 hook）

app.asar /out/main/index.js               客户端入口尾部被追加一行：
;import("file://.../inject-main.cjs").then(() => null, (e) => console.error("[zcm] load failed", e));
```

数据流：db.sqlite 写入 → fs.watch(去抖 300ms) → 限频(1.5s) → 常驻 query.py serve（行协议）
→ payload JSON → 主进程按窗口注入 `mine` → `window.__zcodeMetricsUpdate(payload)` → overlay 渲染。

## 2. 关键决策（与参考项目的差异及理由）

| 决策 | 参考项目 | 本项目 | 理由 |
|---|---|---|---|
| 查询器语言 | Python 常驻进程 | 同（Python3） | sqlite3 标准库零依赖；node 原生 sqlite 未进 Electron 主进程稳定 API |
| 数据表 | model_usage 为主 + turn_usage | 同 | 本机 schema 已核对与参考项目口径一致 |
| 全局命名 | `__zusage*` / `zusage-` | `__zcodeMetrics*` / `zcm-` | 避免与参考项目同装冲突；两类注入行可共存 |
| 今日合计 | zusage.py 直查 | 同 | 不复用现有 node store（口径不同：store 是 rollout 流，overlay 要全库口径） |
| 上下文窗口 | 读 models_catalog_*.json | 读 `config/provider/zcode-builtin.json` | 本机实际路径（参考项目的 D:\ZCode 路径是 Windows）；正则 modelRules 最后命中生效 |
| 插件自动修复 | 新会话 hook 自动重装 | **不做**（用户手动重跑 install） | R5 非目标；默认关闭 + 手动安装降低误装风险 |
| 速度档色 | 70/40 固定 | 同 | 状态条单段瞬时值，不复用 v0.14.0 动态分档（那是回合均值口径） |

## 3. 各模块边界

### 3.1 patch_install.py（移植自参考项目，精简）
- 保留：asar 读写（read_header/repack/compute_integrity）、原子替换、.tmp 收尾、
  注入行正则（替换为 `inject-main\.cjs` + `[zcm] load failed` 标记）、check、语法自检。
- 精简：去掉 Windows 任务对象 breakaway、多语言、runtime_lock/publish_install（无插件更新通道）。
- 锁：`.zcm.lock` 文件锁（fcntl）串行化 install/remove。
- macOS 默认 asar 路径 + `--asar` 参数覆盖；运行时目录默认 `~/.zcode/zcode-metrics-overlay/`，
  `--runtime` 覆盖。安装 = 复制 overlay 四文件到运行时目录 + 重打包注入。
- client_running：`pgrep -x ZCode`（macOS）。

### 3.2 inject-main.cjs（移植，重命名）
- 入口指纹、overlay mtime 热更新（new Function 语法校验）、db watch、限频泵、心跳、
  常驻 query.py serve（早期崩溃 3 次退避回退一次性 spawn）、IPC `zcode:sync-active-task-session`
  监听（通道名常量写死，本机 asar chunk-OW6EUS2G.js 实测）、diag 诊断（可选保留简化版）。
- 推送函数名 `window.__zcodeMetricsUpdate`；`__zcodeMetricsWantSids` 回读。
- 全部 try/catch，日志前缀 `[zcm]`。

### 3.3 query.py（重写，口径照抄 zusage.py）
- 命令：`serve`（stdin 每行 = 逗号分隔 sid 白名单，stdout 每行一个 payload JSON）；
  `json [sids]`（一次性）；`--force` 语义并入白名单参数。
- payload 结构（与 overlay 对齐，字段名沿用参考项目便于核对）：
  ```json
  { "recent": [ {sid, title, active, turns, requests, input, output, reasoning, cache_read,
      cache_write, total, tool_calls, retries, ctx, updated, last_turn{...}, last{tps,ttft_ms,
      duration_ms,model}, code{add,del,files}, ctx_exc, context_window, context_auto, last_at,
      is_sub, sub{...}, tools{...}} ], "today": {...}, "not_local": [], "known_sids": [...] }
  ```
- 上下文窗口解析：`zcode-builtin.json` → `config.modelConfigRules.modelRules[]` 顺序遍历，
  `re.fullmatch(modelMatch, model_id, IGNORECASE)` 命中即更新（后命中覆盖，与客户端 cascade 同序）；
  `properties.contextWindow` 为 null/缺失跳过。
- 白名单 sid：`^[A-Za-z0-9_-]{1,80}$` 逐个校验（防注入）。
- 只读连接：`file:...?mode=ro`；WAL 下 shm 不可用退回普通连接。

### 3.4 overlay.js（重写，v1）
- 形态：IIFE；代际守卫 `__zcodeMetricsGen`；多实例协调器（600ms 扫描 composer，
  pane key = `data-pane-id` 回退 `auto`，`data-session-id` 定会话）。
- DOM：`div.zcm-root`（0 号 id `zcm-bar`）+ `.zcm-main` + ⚙；样式 `<style>` 挂条内；
  tooltip 挂 body；设置面板/子代理面板 `.panel` 机制互斥。
- CSS 变量引用 `--color-*` / `--font-mono` / `--ui-font-size`（本机 asar styles chunk 实测
  存在这批 token）；`.zcm-light` 仅程度性覆盖（阴影/三档色加深）。
- 定位：`cardOf(composer)` 向上找视觉卡片 → `ensureCardPad` margin-bottom 24px →
  `track()` rAF 逐帧 `left=card.left, top=card.bottom+4`；宽锁 min=max=card.width；
  超宽分级收缩（隐藏命中率 → `.zcm-clip` 渐隐）。
- 可见性：`inGhostSubtree`（inert/opacity<0.1/visibility）+ `modalOpen`（body 直挂
  fixed 全屏 z≥10 带底色遮罩 + `role=dialog` 存在）+ `reallyVisible`（elementFromPoint
  中心命中 + 部分遮挡豁免 + 自有浮层豁免）+ 400ms 迟滞。
- 显示项渲染顺序与参考项目 html() 一致：远端/不在本地库徽标（本项目仅"不在本地库"）→
  tps → 上下文 → 本轮 → 会话 → 工具 → 今日 → 子代理。
- tooltip：结构化 `\x01` 前缀 HTML（ttEsc 转义），150ms 节流 mousemove 捕获挂 document，
  空中走廊 + 越顶宽限 + window blur 收起。
- 设置面板：显示项开关（ctx/turn/win/tools/today/sub）、上下文窗口覆盖输入、zh/en 语言。
  不做：自动更新区、速率行开关。

## 4. 与现有插件的关系

- `plugin.json` 增 `userConfig.statusbar`（boolean，default false，描述注明"需执行安装脚本
  修改客户端 asar"）。开关仅作说明性配置（安装状态由 asar 实际注入决定），hook 不读它。
- `overlay/` 目录随插件市场分发；`hooks/` 不变；现有 dashboard/hook 零改动。

## 5. 风险与回退

- asar 重打包损坏 → 安装前 `--check` 语法自检 + .tmp 收尾机制；最坏 `remove` 剥离注入行。
- 客户端升级覆盖 asar → 注入消失，条不再出现；用户重跑 install（README 写明）。
- EmbeddedAsarIntegrityValidation 若未来开启 → 注入行加载失败，客户端控制台 `[zcm] load failed`，
  客户端本身不受影响（dynamic import 的 rejection 只打 console.error）。
- React 重建 composer → 600ms 协调器 + heavy() 对账兜底。
- 查询器崩溃 → loader 早期退避重启，3 次后回退一次性 spawn；最坏显示零值。
