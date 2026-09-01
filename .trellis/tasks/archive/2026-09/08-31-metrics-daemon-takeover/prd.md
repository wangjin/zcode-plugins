# zcode-metrics 常驻服务升级接管（版本比较 + 顶替旧进程）

## Background

zcode-metrics 仪表盘是 hook 拉起的常驻 daemon（`server.mjs`），同机跨会话共用一个实例，靠 `port.json` + `/health` 探活复用。两个缺陷：

1. **升级不生效**：hook 探活只检查 pid 存活 + `/health` 200，不比较版本。插件升级后旧进程永远被复用，serve 旧代码/旧页面，且无报错。
2. **`/health` 版本撒谎**：`server.mjs` 硬编码 `const VERSION = "0.3.0"`，与 plugin.json（0.4.0）不同步，任何版本比较都会被它骗过。

> 历史背景：市场曾改名（zcode-local-dev → zcode-toolbox），port.json 换目录导致旧进程失联、端口从 4521 漂到 4524。今后市场名稳定，**端口发现机制本身不改**——port.json 仍按"插件@市场"数据目录存放、与版本无关。

## Requirements

- **R1** `server.mjs` 的 VERSION 不再硬编码：启动时读自身安装目录 `.zcode-plugin/plugin.json` 的 version，失败回退 `"0.0.0"`。
- **R2** 新增 `POST /shutdown`（仅 127.0.0.1 监听已天然满足）：校验请求头 `X-Shutdown-Token` 与进程启动时随机生成的 token 一致后，清理 port.json 并 `process.exit(0)`。token 写入 port.json（仅本机可读的数据目录），供 hook 使用。
- **R3** hook（`ensure.mjs`）探活成功（`/health` 200）后比较版本：
  - 相等 → 照旧复用，不重启（保证多会话共用一个 daemon 不变）。
  - 不等（旧版进程）→ 接管：带 token 请求旧进程 `/shutdown`，轮询等其退出（≤1.5s）；超时则 `process.kill(pid,'SIGTERM')` 兜底再等 ≤0.5s；随后 spawn 新版，沿用现有基准端口探测（4521 起）——接管后端口回到最低空闲位并保持稳定。
  - `/health` 无 version 字段（0.3.0 及更早的遗留进程）→ 视为不等走接管；接管老进程时若 port.json 无 token，跳过 /shutdown 直接走 SIGTERM 兜底。
- **R4** hook 总预算不变：`/shutdown` 等待 + 新进程就绪轮询都收在 hooks.json 的 timeoutMs 内；所有失败路径 exit 0、stdout 仍只输出 `{}`（不污染模型上下文）。
- **R5** 版本号升至 0.5.0（plugin.json + marketplace.json 同步）。

## Acceptance Criteria

- [ ] **A1** 同版本二次 hook 调用 → 不换进程（pid 不变）；模拟低版本进程 → 新进程接管、端口为基准起最低空闲位、旧 pid 消失。
- [ ] **A2** `/health` 返回的 version 与 plugin.json 一致（R1 生效的直接证明）。
- [ ] **A3** hook 冷启动 / 热复用 / 接管三条路径：exit 0、stdout 仅 `{}`、耗时 < timeoutMs。
- [ ] **A4** 清理本机遗留进程（4522 token-speed-dashboard、4523 zcode-metrics@旧版）后，仪表盘回到稳定端口且渲染 PC 全屏新布局。

## Non-Goals

- 不改端口文件存放路径（仍按"插件@市场"数据目录，与市场名稳定性绑定是已知取舍）。
- 不做多实例；同机单 daemon 模型不变。
