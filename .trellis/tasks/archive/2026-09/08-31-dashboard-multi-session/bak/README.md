# token-speed-dashboard

ZCode 插件：本地网页仪表盘，实时显示当前会话的模型输出速度（tok/s），并保留近 7 天历史做趋势 / 模型对比 / 缓存命中分析。

## 它做什么

- 安装启用后，插件通过 3 个 Hook（SessionStart / UserPromptSubmit / Stop）在后台拉起一个**零依赖 Node 收集器**（仅监听 `127.0.0.1:4521`，端口占用自动递增）。
- 收集器实时 tail `~/.zcode/cli/rollout/model-io-*.jsonl`（ZCode 内部模型 IO 日志），取每次请求的精确 `usage.outputTokens ÷ durationMs` 计算速度；经 SSE 推送到网页仪表盘。
- 每条记录去重后持久化到 `~/.zcode/plugin-data/token-speed-dashboard/history.jsonl`（滚动保留 7 天，超限自动修剪；首次启动一次性回填 rollout 目录里的近 7 天历史）。
- 仪表盘（`http://127.0.0.1:<port>/`，端口见数据目录 `port.json`）显示：
  - 最近一次请求速度（tok/s 大数字）与"生成中 · 已耗时"实时脉冲；
  - 本轮累计（Σtokens、平均 tok/s、请求数）；
  - 近 20 次请求速度条形图（主请求 / lite 后台任务 / 估算值分色）；
  - **速度趋势**：近 48 小时 / 近 7 天切换的吞吐加权折线（main 与 lite 分列）；
  - **模型对比**：近 7 天各模型 × 角色的请求数、avg / p95 tok/s、Σoutput、缓存命中率；
  - **缓存分析**：全局 cacheRead ÷ input 命中率、ΣcacheRead / ΣcacheWrite / Σinput、平均输入每请求；
  - 会话与服务状态（pid、uptime、数据新鲜度）。

## 安装（本地市场）

1. 打开 ZCode **设置 → 插件**。
2. 右上角 **创建 → 添加插件市场**，选择本仓库根目录（含 `marketplace.json` 的目录）。
3. 在 **个人** 分段找到 `token-speed-dashboard`，点 **安装** 并启用。
4. **新建一个 session**（Hook 配置在 session 启动时快照，旧会话不生效），发一条消息——首次 SessionStart 会自动拉起收集器并打开仪表盘。

## 卸载与数据清理

- 停用/卸载插件后 Hook 不再触发；已在运行的收集器进程不会自动退出，可手动结束：
  ```bash
  kill $(python3 -c "import json;print(json.load(open('$HOME/.zcode/plugin-data/token-speed-dashboard/port.json'))['pid'])")
  ```
- 残留数据仅 `~/.zcode/plugin-data/token-speed-dashboard/`（port.json、server.log、history.jsonl），直接删除即可。对 ZCode 本体零侵入。

## 调试

- 服务日志：`~/.zcode/plugin-data/token-speed-dashboard/server.log`
- 健康检查：`curl http://127.0.0.1:4521/health`
- 全量状态：`curl http://127.0.0.1:4521/api/state | python3 -m json.tool`
- 单元测试：`node --test "test/*.test.mjs"`（在本插件目录下）

## 设计要点 / 已知限制

- **数据源**：rollout 日志是 ZCode 未公开的内部格式，字段缺失时自动退回 `last_assistant_message 字符数 ÷ 4` 估算，UI 以橙色条标注"估算值"。
- **历史与保留**：`history.jsonl` 仅落速度/usage 数值与模型 id，**不含任何消息内容、不落 sessionId**；append-only，滚动窗口 7 天（每日心跳自动修剪内存，启动恢复时过滤超窗旧行）。
- **缓存口径**：实测 rollout usage 中 `inputTokens` 已包含 `cacheReadTokens`，故命中率 = ΣcacheRead ÷ Σinput；估算记录（source=estimate）无 usage 字段，全部排除在缓存聚合外。
- **速度粒度**：每次模型请求**完成时**刷新（Hook 协议无流式事件）；请求进行中显示"生成中·已耗时"脉冲而非假数据。
- **多窗口**：仪表盘读的是"最近完成的请求"与"当前活跃 turn"，同机多 ZCode 会话时数值归属最后活跃 session。
- **安全**：仅监听 127.0.0.1；`Stop` 事件的助手消息只用于计数估算、不留存内容；所有 hook 返回空 JSON，不向模型注入任何上下文。
- 收集器被杀后，下一条用户消息即由 hook 自动复活（pid + /health 双探测）。

License: MIT
