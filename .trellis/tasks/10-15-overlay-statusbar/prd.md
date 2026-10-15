# zcode-metrics 客户端注入式状态栏——参考 ByteRax/zcode-token-usage-statusbar 复刻显示项

## Goal

在 ZCode 客户端输入框下方注入一条实时 token 用量状态条（overlay），复刻参考项目
ByteRax/zcode-token-usage-statusbar 的显示项与交互形态，数据源直接读本地
`~/.zcode/cli/db/db.sqlite`（只读），作为 zcode-metrics 插件的第三个显示开关
`statusbar`（与 speedCard 速度卡、speedBadge 徽章并列）。

## 背景（2026-10-15 调研结论）

参考项目机制（已研读其 overlay.js v69 / inject-main.cjs v11 / patch_install.py）：

1. **注入**：`patch_install.py` 重打包 `app.asar`，在入口 `out/main/index.js` 尾部追加一行
   dynamic import 加载 `inject-main.cjs`（入口是 ESM，`type:module`，必须 dynamic import +
   `.cjs` 后缀）。本机已验证：asar 入口 786KB、pickle 头正常、`EmbeddedAsarIntegrityValidation=0`
   （参考项目实测可正常加载）。
2. **渲染**：`overlay.js` 自包含 IIFE 注入每个主窗口，body 级 `position:fixed` 胶囊条，
   rAF 逐帧跟随输入框卡片矩形钉在卡片正下方；样式内联在条元素内（防 React 清 head）；
   z-index 50；不可进 React 布局流。
3. **数据泵**：主进程 fs.watch db 目录（去抖 300ms）触发拉取，限频 `activity_min_ms`(1500ms)
   + 30s 心跳兜底；常驻 Python 查询进程（stdin/stdout 行协议）算出 payload 推给各窗口
   `window.__zusageUpdate(payload)`。
4. **会话归属**：客户端渲染端经官方 IPC 通道 `zcode:sync-active-task-session`（本机 asar
   实测存在，常量表在 `/out/main/chunk-OW6EUS2G.js`）把焦点会话 id 上报主进程；主进程按窗口
   注入 `payload.mine`；分屏时 overlay 从 composer 祖先链读 `data-session-id`（本机 asar
   实测渲染端存在该属性）。
5. **上下文窗口容量**：读客户端模型目录
   `/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json` 的
   `modelConfigRules.modelRules[].config.properties.contextWindow`（正则 modelMatch 匹配模型 id）。

## Requirements

### R1 注入与安装（patch_install.py 移植）
- 重打包 asar：读 header → 替换 `/out/main/index.js` 尾部注入行 → 重算 integrity → 原子替换。
- 注入行指向运行时目录（`~/.zcode/zcode-metrics-overlay/`），幂等（同注入行跳过，旧目录行替换）。
- `remove`：按注入行正则剥离，不依赖备份，不影响其它工具注入行。
- `check`：报告注入状态 + 语法自检（用 ZCode 自身 ELECTRON_RUN_AS_NODE --check）。
- 客户端运行中替换失败时留 `.tmp` 待退出后收尾（`install --finalize`）。
- macOS 路径 `/Applications/ZCode.app/Contents/Resources/app.asar`；Windows 路径暂留接口。

### R2 主进程 loader（inject-main.cjs 移植）
- 每个 `window` 类型 webContents 的 `did-finish-load` 注入 overlay.js（mtime 热更新）。
- fs.watch db 目录触发式拉取 + 限频 + 心跳兜底；任何失败只打日志不影响客户端。
- 监听官方 IPC `zcode:sync-active-task-session` 记录窗口→会话映射，按窗口注入 `mine`。
- payload 推送 `window.__zcodeMetricsUpdate(payload)`（命名空间与参考项目区分）。

### R3 查询器（Python，读 db.sqlite）
复刻 zusage.py 口径（本机 schema 已核对一致：model_usage / turn_usage / tool_usage / session）：
- 会话累计：completed 请求聚合（input/output/reasoning/cache_read/cache_write/total/
  tool_calls/retries/turns），`ctx` = 最近一次 completed 请求的 input_tokens（非 max）。
- 本轮（last_turn）：turn_usage 表按最后 turn_id 聚合；进行中回退 model_usage 现场聚合。
- 最近请求速度 tps：output ÷ 生成窗口；含思考段（reasoning_tokens>0 或 claude 系）窗口前移到
  started_at；无 first_token_at 退化 duration_ms。
- 子代理：`query_source='subagent'` + `session.parent_id=sid` 聚合 + 活跃判定(30s)。
- 工具：tool_usage 按工具分组（completed+error，错误计数）。
- 今日合计：本地日界聚合。
- 上下文窗口：zcode-builtin.json modelRules 正则匹配（最后一个命中规则生效，与客户端同序）。
- 超限：model_usage.context_exceeded=1 的最近时刻。
- 代码变更：session.summary_additions/deletions/files（当前为 NULL，有值才显示）。
- 形态：常驻 serve 模式（行协议）+ 一次性 json 模式（回退），`--force` 会话白名单防注入。

### R4 渲染端状态条（overlay.js 重写，显示项对齐参考项目 v69）
条面显示项（⚙ 面板可逐项开关，localStorage 持久化）：
1. 生成速度（最近一段 tps，⚡ 图标，三档色 70/40）
2. 上下文（环形进度 + 百分比，三档色 70/85，≥100 万窗口 40/60；超限亮红闪烁）
3. 本轮（tokens + 缓存命中率 + 请求次数 + 耗时 + 首字）
4. 会话累计（tokens + 命中率 + 轮数 + 请求数）
5. 工具调用（总数 + 错误徽标，悬停明细）
6. 今日合计（tokens，悬停明细）
7. 子代理（总数 + 呼吸灯，点击弹明细面板）
- 条定位：fixed 钉在输入框视觉卡片正下方，宽=卡片实测宽，rAF 逐帧跟随；卡片 margin-bottom
  24px 让位；不可盖输入框中心点（自遮挡闪烁）。
- 主题跟随：颜色一律 `var(--color-*, 兜底)`；MutationObserver 观察 `<html>.dark` 同步。
- 字体跟随：`var(--font-mono, 兜底)` / `var(--ui-font-size, 14px)`。
- 自绘 tooltip（向上弹、挂 body、空中走廊+越顶宽限）；⚙ 设置面板（向上展开）。
- 多实例（分屏按 data-pane-id 派发）+ 热更新代际守卫 `__zcodeMetricsGen`。
- 兼容性收口：幽灵子树检测（inert/opacity-0）、模态弹窗收起、可见性 400ms 迟滞。

### R5 插件集成
- plugin.json 增 `statusbar` userConfig 开关（default false——注入类功能默认关闭，需显式开启）。
- 安装/卸载入口：独立脚本（Python），供用户手动执行；README 写明"改客户端 asar、更新后需重装、
  完全退出重启 ZCode 生效"的代价与卸载步骤。
- 与现有 speedCard/speedBadge 互不干扰；不新增常驻 node 进程（查询泵在 ZCode 主进程内）。

## Acceptance Criteria

- [ ] `python3 patch_install.py check` 在未注入时报告 not injected，注入后报告 injected 且语法通过
- [ ] 安装后重启 ZCode：输入框下方出现状态条，随窗口缩放/新会话/切换会话正确跟随
- [ ] 速度/上下文/本轮/会话/工具/今日/子代理 七个显示项数值与 sqlite 手工查询一致（抽查）
- [ ] ⚙ 面板逐项开关立即生效且重启后保持；中文/英文文案正常
- [ ] 分屏时每 pane 一条且显示各自会话；弹窗（模型配置等）打开时条收起
- [ ] `python3 patch_install.py remove` 后重启 ZCode，条消失，客户端功能无异常
- [ ] 任何注入失败/查询失败不影响 ZCode 正常使用（客户端日志无 zcode-metrics 崩溃）

## 非目标

- 不复刻参考项目的：SSH 远程数据源、回复末尾速率行、插件自动更新通道、Web 版、MCP server。
- 不做 Windows/Linux 端实测适配（路径留接口，仅 macOS 实测）。
- 不改变 speedCard/speedBadge 既有行为。
