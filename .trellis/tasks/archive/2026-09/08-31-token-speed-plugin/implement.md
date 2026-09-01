# Implement: token-speed-dashboard 插件执行计划

## 产物目录结构（工作区即市场仓库）

```
/Users/wangjin/ZCodeProject/plugins/
├── marketplace.json                      # 本地市场清单（用户手动导入用）
└── plugins/
    └── token-speed-dashboard/
        ├── .zcode-plugin/
        │   └── plugin.json
        ├── hooks/
        │   ├── hooks.json
        │   └── ensure.mjs                # hook 子进程：保活 + 事件转发
        ├── dashboard/
        │   ├── server.mjs                # 常驻收集器：tail + 计算 + HTTP/SSE
        │   ├── rollout.mjs               # 防御式 parser（可单测）
        │   └── index.html                # 仪表盘单页（内联 CSS/JS，无构建）
        └── README.md                     # 安装/卸载/调试说明
```

## 实现顺序（每步后可独立验证）

### T1 骨架与清单
- `plugin.json`：`name: token-speed-dashboard`，version 0.1.0，description，`userConfig.openDashboard`（boolean，default true，"新会话自动打开浏览器仪表盘"）。
- `marketplace.json`：`name: zcode-local-dev`，`pluginRoot: plugins`，条目 source `./token-speed-dashboard`。
- `hooks/hooks.json`：
  - `SessionStart`（matcher `startup|clear|compact`）→ `type: command`, `async: true`, `command: "node \"${ZCODE_PLUGIN_ROOT}/hooks/ensure.mjs\" session_start"`，timeoutMs 5000；
  - `UserPromptSubmit` → `type: process`, `command: node`, `args: ["${ZCODE_PLUGIN_ROOT}/hooks/ensure.mjs", "user_prompt_submit"]`, `timeoutMs: 1500`；
  - `Stop` → 同 UserPromptSubmit 形式，第三参 `stop`。
- 验证：JSON 可 parse；`node --check` 各 mjs。

### T2 rollout parser（`dashboard/rollout.mjs`）
- 导出 `parseLine(json) -> Record | null`（字段：sessionId, turnId, role, modelId, startedAtMs, durationMs, outputTokens, source:"rollout"|"estimate"）与 `TailState`/`tailUpdate(dir, state, onRecord)`（offset 管理、半行回退、rotate 截断检测、glob `model-io-*.jsonl`）。
- 缺 `usage.outputTokens` → 用 `response.text.length/4` 估算并标 source；`durationMs<=0` → null 丢弃。
- 验证：用真实 rollout 样本 + 手工畸形样本跑断言脚本（`test/parser.test.mjs`，node 原生 `--test`，放插件 `test/` 下、不进运行时路径）。

### T3 常驻服务（`dashboard/server.mjs`）
- 启动：读本插件数据目录 → 端口探测 4521..4530 → 写 `port` 文件 `{port,pid,startedAt}`；`SIGTERM/SIGINT`/退出时清理。
- 状态机 = design.md 的 state 模型；SSE 广播（变化即推 + 1Hz 心跳）。
- HTTP 路由（仅 127.0.0.1）：
  - `GET /` → index.html；`GET /events` → SSE；`GET /health` → `{ok,pid,port,version}`；
  - `POST /internal/event` → `{kind: session_start|user_prompt_submit|stop, sessionId, ts, lastMessageChars?}`（user_prompt_submit 置 T₁/active；stop 关 active、触发估算降级记录；session_start 按 `openDashboard` 配置决定是否 `open`）。
- tail 循环：`fs.watch` + 2s 兜底轮询 → `tailUpdate` → 新 main Record：history/turn 聚合/current 卡 + SSE；lite Record 单列计数。启动时各文件 offset 定位到 EOF（不回放）。
- 验证：`node server.mjs` 手测 curl /health、/internal/event、SSE 首包；注入假 rollout 行看 history 更新。

### T4 hook 子进程（`hooks/ensure.mjs`）
- argv[2]=kind；读 stdin 一行 JSON（容错：空/坏 JSON 也继续按 kind 处理）；提取 session_id、Stop 的 last_assistant_message 长度。
- `POST /internal/event`：port 文件 → fetch（AbortSignal 400ms）；失败/无文件 → `spawn detached node server.mjs`（stdio 重定向到数据目录 `server.log`）→ 轮询 /health ≤700ms → 补发一次事件（再失败则静默）。
- 全程 `try/catch` 包裹，stdout 只输出 `{}`，日志走 stderr。任何路径退出码 0（除非致命，致命也只是可恢复失败）。
- 验证：`echo '{"hook_event_name":"UserPromptSubmit","session_id":"x"}' | node ensure.mjs user_prompt_submit` 观察进程拉起、port 文件、事件到达。

### T5 仪表盘（`dashboard/index.html`）
- 单文件内联；深色简洁风；区块：
  1. 状态灯（connected/SSE 最后心跳、server pid/uptime、source: rollout/estimate/none）；
  2. 大数字卡：当前 tok/s（最近完成 main 请求）+ modelId + "生成中·已耗时 Xs"脉冲态；
  3. 本轮累计：Σtokens、平均 tok/s、请求数；
  4. history：近 20 次条形图（CSS flex bar，高度∝tok/s，main 蓝/lite 灰）；
  5. 后台任务计数（lite 请求）。
- EventSource 重连（指数退避 ≤5s）；`state` 全量渲染；无数据 → 空态引导"发消息后这里会出现速度"。
- 验证：`open http://127.0.0.1:4521` 手测 + 注入假数据看渲染。

### T6 文档与市场清单收尾
- `README.md`：本地安装步骤（设置→插件→创建→添加插件市场→选本仓库根目录→安装→启用→**新建 session**）、调试（`server.log`、kill 自愈演示）、卸载与残留清理、安全声明（零依赖/仅 127.0.0.1/hook 不注入上下文）。
- `plugin.json` 复核 name 正则 `^[a-z0-9][a-z0-9._-]{0,127}$` ✅ `token-speed-dashboard`。

### T7 端到端验收（对 PRD 验收标准逐条）
1. 安装启用 → 新 session 发消息 → 浏览器自动出仪表盘（AC1）。
2. 人工核对：仪表盘最近请求 tok/s ≡ rollout 日志 `outputTokens/(durationMs/1000)`（AC2）。
3. 多工具调用长任务：本轮累计卡实时递增（AC3）。
4. 生成长响应期间显示"生成中·已耗时"（AC4）。
5. `kill $(jq .pid port)` → 下一条消息后 /health 复活（AC5）。
6. 临时改数据目录指向空 HOME → UI 显示无数据空态、会话零影响（AC6）。
7. 设置→Hooks 可见 3 条只读；停用插件后新 session 不拉起（AC7）。
8. 模型回复上下文无插件痕迹（AC8）。

## 验证命令清单

```bash
cd plugins/token-speed-dashboard
node --test test/                          # parser 单测
node --check hooks/ensure.mjs dashboard/server.mjs dashboard/rollout.mjs
# 起服务手测
ZCODE_PLUGIN_DATA=/tmp/tsd node dashboard/server.mjs &
curl -s localhost:4521/health
printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"s1"}' | ZCODE_PLUGIN_DATA=/tmp/tsd node hooks/ensure.mjs user_prompt_submit
# 注入假 rollout
printf '{"type":"model_io","sessionId":"s1","turnId":"t1","model":{"role":"main","modelId":"fake"},"startedAt":"...","completedAt":"...","durationMs":2000,"response":{"usage":{"outputTokens":100},"text":"x"}}\n' >> ~/.zcode/cli/rollout/model-io-sess_s1.jsonl
```

## 风险点与回滚

- **回滚 = 卸载插件 + 删 `${ZCODE_PLUGIN_DATA}` + kill 残留进程**；对 ZCode 本体零侵入（README 附一键清理说明）。
- ensure.mjs 超时链（400ms fetch + 700ms 等待）必须 < timeoutMs 1500，留 300ms 余量——实现时在代码常量处注明。
- server 崩溃风暴防护：ensure 拉起失败连续 3 次后仅记 stderr 不再重试 spawn（由 hook 侧 port 文件缺失 + 进程检查自然限流）；server 自身启动即写 partial 文件防双拉。
- index.html 禁用任何外部 CDN/字体（离线 + 隐私）。
- 测试期 rollout 注入会污染真实日志文件 → 注入用专用 `model-io-sess_test_*.jsonl` 并在验收后删除。
