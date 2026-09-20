# 进行中实时速度可行性 spike

## Goal

回答一个问题：**Node 收集器能否秒级感知"生成中"的输出速率**，替代现状"请求完成才刷新、进行中只有脉冲"？对标 zcode-speed-panel 的进程 IO 字节流实测（30s 滑窗折算 t/s）。本任务为研究型 spike，不改生产代码。

## 背景与已知

- 对方实现：直接读 CLI 进程写盘字节计数（Windows `GetProcessIoCounters` / macOS `proc_pid_rusage`），30s 滑窗 ÷ 校准系数 → 秒级 t/s。
- 我方约束：Node 无原生进程 IO API；macOS 无 `/proc`；收集器为零依赖 Node，引入重依赖需充分理由。
- 关联：speed-accuracy-calibration 的动态校准系数是任何"字节→token"路径的地基。

## 候选路径（按调研优先级）

1. **文件观测**：实测生成期间 `~/.zcode/cli/` 下哪些文件在持续增长（SSE 流缓冲、stream 日志、db.sqlite-wal 等）。方法：发起一次长生成，每 500ms `stat` 扫描候选目录，记录增长曲线；若存在稳定增长的文件，评估增长字节与最终 outputTokens 的相关性。
2. **进程 IO 计数**：macOS `proc_pidrusage` 取 `ri_bytes_written`。评估：a) `python3 + psutil`（非标准库，需 pip 装或 vendored）；b) 自编译小 helper（引入构建链，重）；c) `dtrace`/`powermetrics`（权限问题）。给出成本/侵入性结论即可，不必全部实现。
3. **回退设计**：若 1、2 均不可行——设计"进行中显示近 10 分钟已完成请求的真实均值 + 已耗时"折中（对方"管道静默回退"同思路），产出该方案的 UI/数据改动清单，供父任务决策是否立实施子任务。

## Acceptance Criteria

- [ ] research.md 写明三条路径各自的实测/调研结论，含数据或可复现命令
- [ ] 路径 1 必须有真实实验数据（一次长生成期间的文件增长曲线），不得只凭推断
- [ ] 最终结论：可行（走哪条路 + 预估成本）/ 不可行（采用回退设计）二选一，附依据
- [ ] 生产代码零改动；实验脚本放本任务目录下（不进插件分发目录）

## Notes

- 研究型任务，PRD-only；工作量上限约半天，超出即止损写结论。
- 若结论为"可行"，回父任务更新任务地图并另立实施子任务。
