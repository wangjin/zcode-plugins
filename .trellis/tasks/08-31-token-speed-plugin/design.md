# Design: token-speed-dashboard 插件

## 架构总览

```
ZCode session
   │  (stdin JSON)                      ┌────────────────────────────────┐
   ├─ SessionStart(async) ──► ensure.mjs ─►│  常驻收集器 server.mjs (Node)   │
   ├─ UserPromptSubmit ─────► ensure.mjs   │  ┌──────────┐  ┌─────────────┐ │
   └─ Stop ─────────────────► ensure.mjs   │  │tail loop │─►│ state 内存   │ │
                                            │  │rollout/… │  │ ring buffer │ │
                                            │  └──────────┘  └──────┬──────┘ │
                                            │  ensure 事件(HTTP POST)│        │
                                            │  ◄────────────────────┤        │
                                            │  http://127.0.0.1:P   │        │
                                            │  ├─ GET /            ─┼─► index.html (SSE)
                                            │  ├─ GET /events      ─┼─► SSE 流(状态推送)
                                            │  ├─ GET /health      ─┼─► ok + pid + port
                                            │  └─ POST /internal/*  ◄─ ensure.mjs 保活/T₁
                                            └────────────────────────────────┘
```

三个进程角色：
1. **hook 子进程（ensure.mjs）**：一次性、同步或 async、极短生命周期。职责只有两件事——确保 server 活着、把 hook 事件（SessionStart/UserPromptSubmit/Stop + session_id）转发给 server。
2. **常驻收集器（server.mjs）**：tail rollout 日志 + 计算速度 + HTTP/SSE 服务。
3. **浏览器仪表盘（index.html）**：纯静态页 + EventSource，被 server 同源服务。

## 关键决策与理由

### D-0 UI 载体 = 独立本地网页（用户确认）
用户期望"显示在 ZCode 右下角"，但证据表明插件无法嵌入 ZCode UI：① 官方 Hooks/Plugin 文档中插件组件仅有 Skill/Command/Agent/MCP/Hook 五类，无任何 UI 注册点；② Hook 协议是纯 stdin/stdout JSON 子进程，无 status-line 通道；③ 解包 `/Applications/ZCode.app` 的 app.asar 全文检索 `statusline/status_line/tokenSpeed` 等无命中——当前版本不存在可注入的状态栏机制。曾评估 Swift 贴角浮窗 / 浏览器 --app 小窗 / macOS 菜单栏指示器三个替代载体，用户最终拍板：**只保留本地网页仪表盘**（零原生代码、实现面最小）。

### D-A 数据源 = rollout 日志（唯一精确 token 源）
Hook 协议无流式事件；`transcript_path` 是临时文件且不含 usage；`~/.zcode/cli/log/` 的 diagnostics 事件有 durationMs 但 usage 不完整。rollout `model-io-sess_*.jsonl` 同时具备 `durationMs`、`usage.outputTokens`、`model.role`、`sessionId`、`turnId` —— 是唯一能算精确 tok/s 的源。风险（未公开格式）由防御式 parser + 估算降级覆盖（PRD R1.5）。

### D-B 实时性 = tail + SSE，而非轮询
server 用 `fs.watch` + 增量 read（记录每文件 offset，处理 rotate/截断）监听 rollout 目录；新行解析出的请求完成事件立即更新内存状态并向所有 SSE 客户端推送。同时 1s 定时器推送"进行中"心跳（已耗时、T₁ 累计），让 UI 的耗时数字动起来。

### D-C hook → server 的带内通道 = HTTP POST 127.0.0.1
ensure.mjs 读 stdin JSON，POST 到 `${ZCODE_PLUGIN_DATA}/port` 记录的地址 `/internal/event`。server 不在则：spawn 之（detached + stdio ignore + 重定向日志到 plugin data），等待 /health ≤ 700ms，再补发事件。ensure.mjs 总预算 1s（timeoutMs=1500 留余量），超时就静默放弃——绝不能拖慢用户提交。

### D-D "进行中"状态判定
无法直接得知"流已开始但未结束"。近似：UserPromptSubmit 事件置 `turn.active=true, T₁=now`；每次收到完成的 main 请求事件视为该 turn 内一次请求完成；Stop hook 到达置 `turn.active=false`。SSE 心跳在 active 时显示"生成中 · 已耗时 Xs · 本轮已产出 N tokens / 平均 M tok/s"（N/M 来自该 turn 内已完成的请求；整段生成未结束时无增量，明示"本次响应完成后刷新"）。

### D-E 端口语义与单实例
默认 4521，EADDRINUSE 时 +1 重试 ≤10 次。端口 + pid 写 `${ZCODE_PLUGIN_DATA}/port`（`{"port":P,"pid":X,"startedAt":…}`）。ensure.mjs 健康检查：/health 200 且进程存活（`process.kill(pid,0)`）才算活；否则视为僵尸重拉。server 自身 `SIGTERM` 干净退出并删 port 文件。

### D-F 安全性
只绑定 127.0.0.1；`/internal/event` 校验 `Host: 127.0.0.1` 且拒绝非本机 remoteAddress；payload 只含事件元数据（session_id、事件名、时间戳），不含 prompt 内容。Stop 的 `last_assistant_message` 仅用于估算降级，截断 4KB、只在内存。

## 数据流与状态模型

```
state = {
  turn:   { sessionId, active, T1, lastEventAt },
  current: { sessionId, modelId, startedAt, durationMs, inputTokens, outputTokens,
             tokPerSec, role, finishedAt } | null,     // 最近一条 main 完成
  generating: { startedAt, sinceMs, turnTokens, turnAvg } | null,  // active 且未完成时的心口
  turn: { totalOutputTokens, requestCount, elapsedMs, avgTokPerSec },
  history: Ring(20) [ {tokPerSec, outputTokens, durationMs, modelId, finishedAt, role} ],
  lite:  { lastTokPerSec, count },       // 后台 lite 请求单列
  source: "rollout" | "estimate" | "none",
  server: { pid, port, startedAt, uptime }
}
```

SSE 事件：`state`（全量快照，变化即推）+ 心跳 1Hz（active 时带 sinceMs）。前端全量渲染，无增量 diff 复杂度。

## rollout parser 契约（防御式）

- 目录 `${HOME}/.zcode/cli/rollout/`，glob `model-io-*.jsonl`；启动时各文件 offset 初始化到文件末尾（只算新请求，不回放历史）。
- 每行 JSON.parse 失败 → 跳过（可能是半行，下次 poll 重试同一 offset 即可，因为只在整行 `\n` 后推进 offset）。
- 提取：`sessionId`、`turnId`、`model.role`、`model.modelId`、`startedAt`、`durationMs`、`response.usage.outputTokens`。字段缺失 → 尝试从 `response.text` 长度 ÷ 4 估算并标 `estimate`。
- 文件 rotate/截断（size < offset）→ offset 归零。目录不存在 → `source:"none"`，UI 显示等待空态。
- 新完成请求归属当前 session 才计入 turn 累计（sessionId 与 hook 上报的 session_id 对齐；对不上时仍显示"最近请求"但不并入 turn 卡）。
- tok/s = outputTokens ÷ (durationMs/1000)，durationMs≤0 防御为 null。

## 与 hook 契约的对照表

| PRD 概念 | ZCode 实现 |
| --- | --- |
| request_start（记录 T₁） | UserPromptSubmit hook（turn 级 T₁）+ rollout 行内 `startedAt`（请求级精确 T₁） |
| chunk_received | 无对应协议事件 → 由 SSE 1Hz 心跳呈现"进行中已耗时"近似替代 |
| response_stop | rollout 行落盘（请求级）+ Stop hook（turn 级兜底/估算降级触发） |

## 兼容与回滚

- 插件独立目录，卸载/停用即全停；残留仅 `${ZCODE_PLUGIN_DATA}`（port/pid/日志），无侵入。
- ZCode 升级改 rollout 格式 → parser 防御 + UI 明示"估算/无数据"，不崩溃不注入上下文。
- 全部文件零依赖纯 Node ESM（`.mjs`），`#!/usr/bin/env node` 不需要；hooks.json 用 `node ${ZCODE_PLUGIN_ROOT}/...`。

## 测试计划（实现阶段执行）

1. **单元**：parser 用真实 rollout 样本 + 畸形样本（半行、缺字段、rotate）。
2. **集成**：mock rollout 写入 → SSE 收到 state；起两个 server 验端口递增；kill server 后跑 ensure.mjs 验复活。
3. **端到端**：本地市场安装 → 新 session 对话 → 人工核对仪表盘 tok/s vs rollout 日志计算值；kill -9 收集器再发消息验自愈。
4. **回归红线**：设置→Hooks 页确认 3 条 hook 只读展示；会话中模型上下文不含插件注入文本（hook stdout 恒空）。
