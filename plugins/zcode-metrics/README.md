# zcode-metrics

ZCode 插件：本地网页仪表盘，实时显示各会话的模型输出速度（tok/s）并支持多会话并行统计，保留近 7 天历史做趋势 / 模型对比 / 缓存命中分析（可按会话过滤）。

## 它做什么

- 安装启用后，插件通过 3 个 Hook（SessionStart / UserPromptSubmit / Stop）在后台拉起一个**零依赖 Node 收集器**（仅监听 `127.0.0.1:4521`，端口占用自动递增）。
- 收集器实时 tail `~/.zcode/cli/rollout/model-io-*.jsonl`（ZCode 内部模型 IO 日志），取每次请求的精确 `usage.outputTokens ÷ durationMs` 计算速度；经 SSE 推送到网页仪表盘。
- 每条记录去重后持久化到 `~/.zcode/plugin-data/zcode-metrics/history.jsonl`（滚动保留 7 天，超限自动修剪；首次启动一次性回填 rollout 目录里的近 7 天历史）。
- 仪表盘（`http://127.0.0.1:<port>/`，端口见数据目录 `port.json`）显示：
  - **会话总览列表**（多会话，v0.9.0 两行式行卡）：全部并行会话同屏并列，行内直接承载实时信息——首行 = 状态点 + 短 ID + 实时读数 + 最近活跃，次行 = 生成中的本轮进度（次数 / Σtokens / 已耗时）或空闲时的最近请求（模型 / tokens / 耗时 / 上一轮摘要）；点行聚焦，详见下节；
  - 近 20 次请求速度条形图（速度六档配色：0–40 绿 → 320+ 品红分档着色；lite 后台任务降饱和、估算值斜纹）；
  - **速度趋势**：近 24 小时（10 分钟粒度）/ 近 48 小时 / 近 7 天切换的吞吐加权折线，lite 后台任务汇总一列 + 窗口内请求数前 5 模型的单列曲线（v0.9.1 起不再绘制混合全模型的"主请求 avg"汇总线，单模型速度趋势更清晰）；图例即开关（点击隐藏/恢复单条曲线），悬停按时间列展示该时刻全部可见曲线读数；
  - **今日用量**：自然日（本地时区）聚合的 token 总量（input + output + cacheWrite，input 已含 cacheRead 命中，官方口径映射）、调用次数（主 / lite 分列）、吞吐加权平均速度；跟随聚焦口径（"全部" = 全局今日，聚焦会话 = 该会话今日）；
  - **速度六档配色**：0–40 绿 / 40–80 黄绿 / 80–160 黄 / 160–240 橙 / 240–320 红 / 320+ 品红（含下界不含上界），应用于实时读数、柱图、趋势悬停与模型对比，同数值同色；
  - **模型对比**：近 7 天各模型 × 角色的请求数、avg / p95 tok/s、Σoutput、缓存命中率；
  - **缓存分析**：全局 cacheRead ÷ input 命中率、ΣcacheRead / ΣcacheWrite / Σinput、平均输入每请求；
  - 趋势 / 模型对比 / 缓存分析三面板跟随聚焦口径："全部" = 全局，聚焦会话 = 仅该会话记录；
  - 会话与服务状态（pid、uptime、数据新鲜度）。
- **迷你速度窗**：仪表盘头部"迷你窗"按钮（或直接访问 `/mini`）打开 340×200 常驻小窗——大字实时速度（六档配色）+ 今日 tokens/轮数 + 会话切换 chips；跟随主页面聚焦口径（经 localStorage 同步），SSE 断线自动重连。
- **Gen UI 回复内嵌速度卡**（v0.11.0，v0.12.0 起默认关）：每回合回复末尾自动出现一张本会话速度卡——最近完成回合的合计 tok/s（六档配色大数字 + 口径注释）、本会话近 24 次模型响应的速度柱状图（悬停看明细）、今日输出与响应次数。详见下节。
- **置顶速度徽章**（v0.12.0）：会话启动时在 ZCode 窗口**输入框右下角**弹出置顶微型徽章，只显示实时速度读数（六档配色，`●`=生成中 / `○`=空闲）。详见「置顶速度徽章」一节。

## 置顶速度徽章（v0.12.0）

ZCode 3.15 的插件 API 没有 UI 注入点（plugin.json 无 UI 组件、无 statusline/输入区插槽、Gen UI 卡片只能渲染在对话流里），因此"输入框底部显示速度"用**原生置顶悬浮窗**实现（`bin/tsd-badge`，源码 `badge/badge.swift`，swiftc 编译，零第三方依赖，仅 macOS）：

- **定位**：启动时经 osascript 读 ZCode 前台窗口矩形，落在窗口右下角内侧（输入框区域右侧）；查询失败落主屏右下角。可拖动，位置持久化到 `plugin-data/zcode-metrics/badge-pos.json`（换屏/改分辨率后越界自动回默认）。
- **口径**：每秒轮询收集器 `/api/state`，自动跟随**最近活跃会话**（与仪表盘自动跟随语义一致）；读数优先级 = 生成中本轮平均 → 上一回合合计 → 最近一次响应。
- **生命周期**：收集器每个生命周期只拉起一次（`badge.pid` 存活即跳过，升级接管不重复弹）；收集器退出时一并收掉，收集器失联 15 秒徽章自杀；**双击徽章退出**。
- **开关**：插件配置 `speedBadge`（默认开，仅 macOS；其他平台静默跳过）。重建二进制：`badge/build.sh`。

## Gen UI 速度卡（v0.11.0，v0.12.0 起默认关）

ZCode 3.15+ 的"UI 插件"形态是 **Gen UI 内联卡片**：assistant 回复中以 `::visualize{"path":"…"}` 引用会话可视化目录（`~/.zcode/v2/visualizations/<hash>/`）下的 HTML 片段，宿主渲染为内联卡片；沙箱 CSP 禁止 `fetch`/XHR/WebSocket，数据必须内联。本插件的实现：

- **目录绑定**：可视化目录的 hash 无法由 session_id 推导（sha256/md5 均不符）；实测目录 birthtime 与 `tasks-index.sqlite` 中 task 的 `created_at` 偏差约 150ms，收集器按 ±10s 容差做 birthtime join 解析绑定，结果缓存到 `plugin-data/zcode-metrics/viz-map.json`（sqlite3 CLI 不可用时跳过，仅影响此功能）。
- **写卡时机**：回合边界（UserPromptSubmit / Stop 事件，强制写）+ 记录到达（broadcast 搭车，2s 节流）。卡片是**静态快照、无脚本**，主题走宿主 CSS 变量（`--foreground` 等，带回退值）。
- **引用提醒**：UserPromptSubmit hook 经 `hookSpecificOutput.additionalContext` 注入一行提醒（含 viz-map 缓存命中的精确路径），模型按 `skills/token-speed/SKILL.md` 在回复末尾输出 `::visualize` 引用。首回合缓存未命中时给目录式提示（模型从自身 Desktop Context 取目录），第二回合起为精确路径。
- **能力边界**：回合内逐秒实时速度仍需浏览器小窗 `/mini`（SSE）；卡片大数字在回合结束瞬间渲染时可能不含最后一段响应（rollout 落盘与消息渲染的竞态），下一回合引用同一文件即收敛为终值。旧消息的卡片不会自动重渲染（宿主按消息渲染快照）。
- **开关**：插件配置 `speedCard`（v0.12.0 起默认关）。关闭后 hook 恢复只返回 `{}`，不向模型注入任何上下文。

## 多会话（v0.3.0，v0.6.0 起总览列表）

多个 ZCode 会话并行时，各自的实时统计（当前速度、本轮累计、轮次收尾）分桶隔离、互不干扰：

- **总览列表语义**：Session 面板列出全部活跃会话，两行式行卡 = 首行状态点（橙闪 = 生成中，灰 = 超时等待，绿 = 空闲）+ 短 ID 前 13 位 + 实时读数 + 最近活跃时间，次行为实时上下文（生成中：本轮次数 / Σtokens / 已耗时 / 最近模型；空闲：最近请求的模型与 tokens / 耗时、上一轮摘要）。默认"全部"口径**自动跟随最近活跃会话**（对应行高亮）；点某一行**锁定聚焦**该会话，SSE 刷新不跳回；再点同一行或 "全部" 恢复自动跟随；被锁定的会话下线后自动回落。
- **生命周期**：会话仅由 hook 事件创建（内存态，收集器重启后清空，下次事件自动重建）；**30 分钟**无任何事件自动下线（无 session_end 事件，纯靠 idle 超时推断）；最多保留 **5** 个会话，超出挤掉最久未活跃者。Stop 丢失的"僵尸轮"在 30 分钟后由心跳自动收尾，收尾摘要再保留 30 分钟供回看。
- **过滤口径**：聚焦某个会话时，趋势 / 模型对比 / 缓存分析只统计该会话的记录（覆盖 7 天 history 与回填数据）；"全部"口径维持全局。`history.jsonl` 不落 sessionId，重启恢复的记录无法归属会话，不参与过滤视图。
- **记录归属**：rollout 记录按 sessionId 路由到对应会话桶；**无 sessionId 的记录宽松归属最近活跃会话**（实测占比趋近 0）；未知 sessionId 的记录只进全局柱图、不建会话（防止启动回放近 20 条时"复活"旧会话）。
- **stop 路由**：Stop 事件只关闭本会话的活跃轮次，不再出现 A 会话的 Stop 关掉 B 会话轮次的串扰；会话不存在（如收集器重启后）的孤儿 Stop 直接忽略。

## 安装（本地市场）

1. 打开 ZCode **设置 → 插件**。
2. 右上角 **创建 → 添加插件市场**，选择本仓库根目录（含 `marketplace.json` 的目录）。
3. 在 **个人** 分段找到 `zcode-metrics`，点 **安装** 并启用。
4. **新建一个 session**（Hook 配置在 session 启动时快照，旧会话不生效），发一条消息——首次 SessionStart 会自动拉起收集器并打开仪表盘。

## 升级接管与端口（v0.5.0）

常驻收集器是跨会话共用的单实例，靠数据目录 `port.json` + `/health` 探活复用。早期版本升级后旧进程不退出、且探活不看版本，导致"装了新版仍跑旧代码"、端口随每次重装递增漂移。v0.5.0 的修复：

- **版本同源**：`server.mjs` 的 VERSION 不再硬编码，启动时读自身安装目录 `.zcode-plugin/plugin.json`，`/health` 报的版本恒等于实际分发的插件版本（也是 hook 的比较基准）。
- **升级即接管**：每次 hook 探活成功后比较 `/health` 版本与自身：一致则复用既有 daemon（多会话共用一个进程不变）；不一致则接管——带 `X-Shutdown-Token`（来自 `port.json`，进程每次启动随机生成）请求旧实例协作 `POST /shutdown` 退出，无此端点/无 token 的老进程走 SIGTERM 兜底，随后新进程从基准端口 4521 重新绑定。接管后端口回到最低空闲位并保持稳定，浏览器书签不再每次升级失效。
- **前提**：市场名保持稳定。`port.json` 按"插件@市场"数据目录存放、与版本号无关；若市场改名，发现文件会换目录、旧实例失联，端口会重新漂移（已知取舍，不在本版解决）。

## 卸载与数据清理

- 停用/卸载插件后 Hook 不再触发；已在运行的收集器进程不会自动退出，可手动结束：
  ```bash
  kill $(python3 -c "import json;print(json.load(open('$HOME/.zcode/plugin-data/zcode-metrics/port.json'))['pid'])")
  ```
- 残留数据仅 `~/.zcode/plugin-data/zcode-metrics/`（port.json、server.log、history.jsonl），直接删除即可。对 ZCode 本体零侵入。

## 调试

- 服务日志：`~/.zcode/plugin-data/zcode-metrics/server.log`
- 健康检查：`curl http://127.0.0.1:4521/health`
- 全量状态：`curl http://127.0.0.1:4521/api/state | python3 -m json.tool`
- 单元测试：`node --test "test/*.test.mjs"`（在本插件目录下）

## 设计要点 / 已知限制

- **数据源**：rollout 日志是 ZCode 未公开的内部格式；usage 缺失时降级估算走**动态校准系数**（完整字符口径 chars = text + reasoning + tool-call args，按模型分桶 median(chars/outputTokens)，实证默认 3.158；`plugin-data/calibration.json` 持久化，删文件即回退默认值），UI 以斜纹条标注"估算值"。
- **历史与保留**：`history.jsonl` 仅落速度/usage 数值与模型 id，**不含任何消息内容、不落 sessionId**；append-only，滚动窗口 7 天（每日心跳自动修剪内存，启动恢复时过滤超窗旧行）。
- **缓存口径**：实测 rollout usage 中 `inputTokens` 已包含 `cacheReadTokens`，故命中率 = ΣcacheRead ÷ Σinput；估算记录（source=estimate）无 usage 字段，全部排除在缓存聚合外。
- **速度粒度**：每次模型请求**完成时**刷新（Hook 协议无流式事件）；请求进行中显示"生成中·已耗时"脉冲而非假数据。
- **多会话**：turn / 本轮累计按 sessionId 分桶并行统计（见上节）；`/api/state` 顶层 `turn/closed/last/sessionId` 字段已移除，改为 `sessions[]`（≤5，按最近活跃降序，每项含实时态 + 该会话过滤聚合）。
- **安全**：仅监听 127.0.0.1；`Stop` 事件的助手消息只用于计数估算、不留存内容；除速度卡引用提醒（`speedCard` 开启时 UserPromptSubmit 注入一行，可关）外，所有 hook 返回空 JSON，不向模型注入任何上下文。
- 收集器被杀后，下一条用户消息即由 hook 自动复活（pid + /health 双探测）。

License: MIT
