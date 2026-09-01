# zcode-metrics

ZCode 插件：本地网页仪表盘，实时显示各会话的模型输出速度（tok/s）并支持多会话并行统计，保留近 7 天历史做趋势 / 模型对比 / 缓存命中分析（可按会话过滤）。

## 它做什么

- 安装启用后，插件通过 3 个 Hook（SessionStart / UserPromptSubmit / Stop）在后台拉起一个**零依赖 Node 收集器**（仅监听 `127.0.0.1:4521`，端口占用自动递增）。
- 收集器实时 tail `~/.zcode/cli/rollout/model-io-*.jsonl`（ZCode 内部模型 IO 日志），取每次请求的精确 `usage.outputTokens ÷ durationMs` 计算速度；经 SSE 推送到网页仪表盘。
- 每条记录去重后持久化到 `~/.zcode/plugin-data/zcode-metrics/history.jsonl`（滚动保留 7 天，超限自动修剪；首次启动一次性回填 rollout 目录里的近 7 天历史）。
- 仪表盘（`http://127.0.0.1:<port>/`，端口见数据目录 `port.json`）显示：
  - **会话总览列表**（多会话）：全部并行会话同屏并列（状态点 + 短 ID + 实时读数 + 最近活跃），点行聚焦，详见下节；
  - 最近一次请求速度（tok/s 大数字）与"生成中 · 已耗时"实时脉冲（所选会话）；
  - 本轮累计（Σtokens、平均 tok/s、请求数，按会话分桶，互不顶掉）；
  - 近 20 次请求速度条形图（主请求 / lite 后台任务 / 估算值分色，全局口径）；
  - **速度趋势**：近 24 小时（10 分钟粒度）/ 近 48 小时 / 近 7 天切换的吞吐加权折线，main 与 lite 汇总分列，另附窗口内请求数前 5 模型的单列曲线；图例即开关（点击隐藏/恢复单条曲线），悬停按时间列展示该时刻全部可见曲线读数；
  - **模型对比**：近 7 天各模型 × 角色的请求数、avg / p95 tok/s、Σoutput、缓存命中率；
  - **缓存分析**：全局 cacheRead ÷ input 命中率、ΣcacheRead / ΣcacheWrite / Σinput、平均输入每请求；
  - 趋势 / 模型对比 / 缓存分析三面板跟随聚焦口径："全部" = 全局，聚焦会话 = 仅该会话记录；
  - 会话与服务状态（pid、uptime、数据新鲜度）。

## 多会话（v0.3.0，v0.6.0 起总览列表）

多个 ZCode 会话并行时，各自的实时统计（当前速度、本轮累计、轮次收尾）分桶隔离、互不干扰：

- **总览列表语义**：Session 面板列出全部活跃会话，每行 = 状态点（橙闪 = 生成中，灰 = 超时等待，绿 = 空闲）+ 短 ID 前 13 位 + 实时读数（生成中显示平均 tok/s 与 Σtokens，空闲显示最近请求速度）+ 最近活跃时间。默认"全部"口径**自动跟随最近活跃会话**（读数卡展示它，对应行高亮）；点某一行**锁定聚焦**该会话，SSE 刷新不跳回；再点同一行或 "全部" 恢复自动跟随；被锁定的会话下线后自动回落。
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

- **数据源**：rollout 日志是 ZCode 未公开的内部格式，字段缺失时自动退回 `last_assistant_message 字符数 ÷ 4` 估算，UI 以橙色条标注"估算值"。
- **历史与保留**：`history.jsonl` 仅落速度/usage 数值与模型 id，**不含任何消息内容、不落 sessionId**；append-only，滚动窗口 7 天（每日心跳自动修剪内存，启动恢复时过滤超窗旧行）。
- **缓存口径**：实测 rollout usage 中 `inputTokens` 已包含 `cacheReadTokens`，故命中率 = ΣcacheRead ÷ Σinput；估算记录（source=estimate）无 usage 字段，全部排除在缓存聚合外。
- **速度粒度**：每次模型请求**完成时**刷新（Hook 协议无流式事件）；请求进行中显示"生成中·已耗时"脉冲而非假数据。
- **多会话**：turn / 本轮累计按 sessionId 分桶并行统计（见上节）；`/api/state` 顶层 `turn/closed/last/sessionId` 字段已移除，改为 `sessions[]`（≤5，按最近活跃降序，每项含实时态 + 该会话过滤聚合）。
- **安全**：仅监听 127.0.0.1；`Stop` 事件的助手消息只用于计数估算、不留存内容；所有 hook 返回空 JSON，不向模型注入任何上下文。
- 收集器被杀后，下一条用户消息即由 hook 自动复活（pid + /health 双探测）。

License: MIT
