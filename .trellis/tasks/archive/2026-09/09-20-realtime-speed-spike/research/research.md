# research.md — 进行中实时速度可行性 spike

日期：2026-09-20 · 实验环境：macOS (darwin 27 arm64) · ZCode 3.14.0（Electron）· 生产代码零改动

## 结论：**不可行（当前架构）**——采用回退形态（现状已基本是回退形态），不立实施子任务

秒级"生成中实时速度"需要一条**在请求进行期间持续产生增量信号**的数据通道。三条候选路径全部排除：

### 路径 1 · 文件观测（有实测数据，排除）

实验：45s 后台扫描（0.4s 粒度 stat）`~/.zcode/cli/`、`rollout/`、`db/` 全部文件，扫描期间本会话持续进行真实生成（≈5 次请求完成）。原始数据：

```
scan rounds=112 dur=45.0s
rollout/model-io-sess_76b0c6d9….jsonl  total_delta=+1244253B  events=5
  t+6.1s +259130B · t+17.8s +266888B · t+24.3s +265450B · t+33.5s +186516B · t+41.6s +266269B
（db.sqlite / db.sqlite-wal / 其余全部文件：0 增长）
```

判读：5 个事件 = 5 次请求完成，每次一次性追加 ~260KB（含全量请求上下文的完整日志行）；**请求进行期间无任何文件平滑增长**。rollout 是"完成时落盘"而非"流式落盘"——speed-panel 的字节流实测前提（CLI 进程边收边写盘）在 Electron 架构下不成立。复现：上述扫描脚本（~20 行 python，glob+stat 轮询）。

### 路径 2 · 进程 IO 计数（调研排除，未实现）

- `python3 -c "import psutil"` → **ModuleNotFoundError**：psutil 非系统自带，需 pip 安装（引入用户级依赖 + 网络前提，违背收集器零依赖原则）。
- `proc_pidrusage` 的 `ri_bytes_written` 是**磁盘写计数**，而本架构下生成流经**网络**到达 Electron 主进程/NetworkService（实测进程表：生成流量分散在 ZCode Helper×N + zcode-cli），磁盘计数器看不到；网络字节归属需 TCP 连接表 × 进程交叉（speed-panel 的做法，需要 Rust 级系统调用，Node 无原生 API）。
- dtrace/powermetrics 路径有 SIP 权限问题，不评估。

### 路径 3 · 回退设计（采用，且大部分已内建）

现状仪表盘在"生成中"已展示：本轮请求数 / Σtokens / 已耗时 / **轮内吞吐均值**（每次请求完成即刷新，avgTokPerSec = Σtokens ÷ 已耗时）+ 状态点脉冲。这即 speed-panel"管道静默回退"（无增量 → 显示近期真实速度）的等价形态。

**可选小增强**（建议后续版本顺手做，不值得立任务）：生成中的会话行/迷你窗追加显示"该模型近 10 分钟 avg"作参考读数（数据已有：store.trend m24 桶），让长生成期间也有可参照的速度锚点。

## 若未来前提变化

- rollout 若改为流式追加（每 SSE chunk 落盘）→ 路径 1 立即复活：tail 字节增量 × 动态校准系数（speed-accuracy-calibration 已就绪）即得秒级 t/s。
- ZCode Hook 协议若增加流式事件 → 直接精确统计，无需本 spike 任何路径。
