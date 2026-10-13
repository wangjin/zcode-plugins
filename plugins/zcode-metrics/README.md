# zcode-metrics

ZCode 插件：**应用内**显示各会话的模型输出速度（tok/s）。零依赖 Node 收集器（仅监听 `127.0.0.1`）tail `~/.zcode/cli/rollout/model-io-*.jsonl`（ZCode 内部模型 IO 日志），取每次请求的精确 `usage.outputTokens ÷ durationMs` 计算速度；7 天历史持久化 + 动态校准估算。

> v0.13.0：网页仪表盘（index/mini/SSE/自动打开浏览器）已按需求移除，只保留应用内展示；HTTP 仅剩 `/api/state` `/health` `/shutdown` `/internal/event` 内部端点。
> v0.13.1：速度卡柱状图柱顶直接标注速度值（不再依赖悬停）；大数字口径说明写明"平均"；配置文案按功能命名；修徽章三个失效场景——会话中途打开开关不生效（现在每条消息都携带开关，即时拉起）、恢复会话不触发（SessionStart matcher 补 resume）、收集器接管后徽章消失不补拉（改为徽章不在即补拉）；徽章文字垂直居中、0.5s 跟随 ZCode 窗口移动、自管 badge.pid 防重复弹。

## 两种展示形态（独立开关，可分别启停）

| 展示 | 开关（插件配置） | 形态 | 默认 |
|---|---|---|---|
| 速度卡 | `speedCard` | 回复末尾内嵌 Gen UI 卡片：上一回合平均 tok/s（六档配色大数字）+ 近 24 次响应柱状图（柱顶标速度值）+ 今日输出 | 开 |
| 速度徽章 | `speedBadge` | 置顶悬浮窗：ZCode 窗口输入框右下角，仅速度读数，1s 刷新 | 关 |

### 速度卡 · 回复内嵌（speedCard，默认开）

- 每回合回复末尾自动出现本会话速度卡；静态快照（Gen UI 沙箱禁 fetch，数据全内联）、无脚本，主题走宿主 CSS 变量。
- **速度口径**：大数字优先显示**上一回合平均**（回合内全部输出 token ÷ 回合总时长，含多次响应与响应间隙）；回合进行中显示**本回合至今平均**；两者皆无时显示最近一次响应自身的平均速度。柱状图每柱 = 一次模型响应的速度（该次 `outputTokens ÷ durationMs`），柱顶直接标注数值（≤10 柱全标，更多时标最新柱与最高柱，悬停可看每柱明细）。
- **目录绑定**：会话可视化目录 `~/.zcode/v2/visualizations/<hash>/` 的 hash 无法由 session_id 推导（sha256/md5 均不符）；实测目录 birthtime 与 `tasks-index.sqlite` 中 task 的 `created_at` 偏差约 150ms，收集器按 ±10s 容量 join 解析绑定，缓存到 `plugin-data/zcode-metrics/viz-map.json`（sqlite3 CLI 不可用时跳过，仅影响此功能）。
- **写卡时机**：回合边界（UserPromptSubmit / Stop 事件，强制写）+ 记录到达（2s 节流）。
- **引用提醒**：UserPromptSubmit hook 经 `hookSpecificOutput.additionalContext` 注入一行提醒（viz-map 命中时含精确路径），模型按 `skills/token-speed/SKILL.md` 在回复末尾输出 `::visualize` 引用。关闭开关后 hook 只返回 `{}`，不注入任何上下文。
- **边界**：回合结束瞬间渲染的卡片可能缺最后一段响应（rollout 落盘与消息渲染的竞态），下一回合引用同一文件即收敛；回合内逐秒实时请开启速度徽章。

### 速度徽章 · 置顶悬浮（speedBadge，默认关，仅 macOS）

- 原生 Swift 二进制 `bin/tsd-badge`（源码 `badge/badge.swift`，`badge/build.sh` 重建）：无边框置顶面板，不抢焦点、跨 Space；六档配色只显示速度（`●`=生成中/`○`=空闲）；可拖动（位置持久化 `badge-pos.json`）、双击退出（临时退出，下一条消息自动补拉；彻底关闭请关 speedBadge 开关）、收集器失联 15s 自杀。
- 定位与跟随：初始位置优先恢复用户拖过的位置，否则取 ZCode 前台窗口右下角内侧（osascript 查询，失败落主屏右下角）；运行中每 0.5s 经 CGWindowList 跟随 ZCode 窗口移动/缩放（按右下角增量平移，bounds/owner 为公开信息，无需辅助功能权限）。徽章自管 `badge.pid`（启动写入/退出删除），收集器凭它避免重复弹、并在徽章不在时补拉。
- 口径：每秒轮询 `/api/state`，自动跟随**最近活跃会话**；读数 = 生成中本轮平均 → 上一回合合计 → 最近一次响应。
- 触发与自愈：speedBadge 开启时，session_start（startup/resume/clear/compact）与每条用户消息都会尝试拉起徽章（badge.pid 存活即跳过，pid 检查只读一个小文件）；收集器接管重启、徽章双击退出或失联自杀后，下一条消息自动补拉。收集器退出时联动收掉徽章。

## 架构

- **Hook（3 个）**：SessionStart / UserPromptSubmit / Stop → `hooks/ensure.mjs` 拉起/保活收集器并转发回合事件（多会话分桶、turn 起止）。
- **收集器 `dashboard/server.mjs`**：rollout tail（去重、增量、首启回填 7 天）→ 状态机（会话桶 ≤5、30min idle 下线、僵尸轮自动收尾）→ 写速度卡 / 供徽章轮询。升级接管：hook 探活比对 `/health` 版本，不一致则带 token 协作关旧进程后重启（端口回基准 4521）。
- **持久化**：`~/.zcode/plugin-data/zcode-metrics/`（`history.jsonl` 仅速度/usage 数值与模型 id，不含消息内容、不落 sessionId；`calibration.json` 动态校准系数，删文件回退默认）。

## 安装（本地市场）

1. 打开 ZCode **设置 → 插件**，右上角 **创建 → 添加插件市场**，选择本仓库根目录（含 `marketplace.json`）。
2. **个人** 分段找到 `zcode-metrics`，**安装** 并启用。
3. **新建一个 session**（hook 配置在 session 启动时快照，旧会话不生效）。

## 调试

- 服务日志：`~/.zcode/plugin-data/zcode-metrics/server.log`
- 健康检查：`curl http://127.0.0.1:4521/health`；全量状态：`curl http://127.0.0.1:4521/api/state`
- 单元测试：`node --test "test/*.test.mjs"`（在本插件目录下）
- 重建徽章：`badge/build.sh`（需 Xcode CLT 的 swiftc）

## 卸载与数据清理

- 停用/卸载插件后收集器不会自动退出：`kill $(python3 -c "import json;print(json.load(open('$HOME/.zcode/plugin-data/zcode-metrics/port.json'))['pid'])")`
- 残留数据仅 `~/.zcode/plugin-data/zcode-metrics/`，直接删除即可。对 ZCode 本体零侵入。

## 设计要点 / 已知限制

- **数据源**：rollout 日志是 ZCode 未公开的内部格式；usage 缺失时降级估算走**动态校准系数**（完整字符口径 chars = text + reasoning + tool-call args，按模型分桶 median(chars/outputTokens)，实证默认 3.158），估算值在卡上标注"估"。
- **多会话**：turn / 本轮累计按 sessionId 分桶并行统计；徽章自动跟随最近活跃会话，卡片按本会话。
- **安全**：仅监听 127.0.0.1；`Stop` 事件的助手消息只用于计数估算、不留存内容；除速度卡引用提醒（speedCard 开启时，每回合一行，可关）外，所有 hook 返回空 JSON。
- 收集器被杀后，下一条用户消息即由 hook 自动复活（pid + /health 双探测）。

License: MIT
