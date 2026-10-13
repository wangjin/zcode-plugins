# Journal - wangjin (Part 1)

> AI development session journal
> Started: 2026-08-31

---



## Session 1: 仪表盘历史扩展收尾 + 琥珀磷光仪器风格 UI 重设计

**Date**: 2026-08-31
**Task**: 仪表盘历史扩展收尾 + 琥珀磷光仪器风格 UI 重设计
**Branch**: `main`

### Summary

完成 dashboard-history-expand 任务收尾：index.html 全面重设计为琥珀磷光仪器风格（等宽数据声部、示波器趋势线+悬停读数、LED 状态、斜纹估算柱、刻度缓存仪表尺），修复 SSE 重渲染冲掉 tooltip 的 bug 与 favicon 404；浏览器实测交互/响应式正常，单测 36/36 通过。归档任务并记录首个工作提交（含插件全部代码）。

### Git Commits

| Hash | Message |
|------|---------|
| `f0e2516` | (see git log) |

### Status

[OK] **Completed**


## Session 2: 添加仓库根 README

**Date**: 2026-08-31
**Task**: 添加仓库根 README
**Branch**: `main`

### Summary

为 zcode-local-dev 插件市场仓库新增根 README.md：仓库定位与目录结构、已收录插件（zcode-metrics v0.4.0）、本地市场安装步骤、开发约定（marketplace.json 登记、测试命令、数据清理）。已提交 cce3f63。

### Git Commits

| Hash | Message |
|------|---------|
| `cce3f63` | (see git log) |

### Status

[OK] **Completed**


## Session 3: 插件市场更名 zcode-toolbox

**Date**: 2026-08-31
**Task**: 插件市场更名 zcode-toolbox
**Branch**: `main`

### Summary

应用户讨论结果，将本地插件市场由 zcode-local-dev 更名为 zcode-toolbox：marketplace.json 的 name/description 与根 README 同步更新，提交 d063a97。注意事项已告知用户：客户端需移除旧市场源重新添加并重装插件（插件 ID 命名空间随市场名变化）；历史数据目录若按 <plugin>@<marketplace> 注入需手动迁移以保留 7 天 history。.trellis 历史记录中的旧名引用按惯例不改。

### Git Commits

| Hash | Message |
|------|---------|
| `d063a97` | (see git log) |

### Status

[OK] **Completed**


## Session 4: Trellis hooks 插件化：trellis-hooks 绕过工作区信任门

**Date**: 2026-08-31
**Task**: Trellis hooks 插件化：trellis-hooks 绕过工作区信任门
**Branch**: `main`

### Summary

诊断 UserPromptSubmit『工作区 已阻止』根因：ZCode 工作区 hook 信任门（config_project_hooks_pending_trust），信任记录存在但客户端重启后重新武装。将 3 个 Trellis hooks（SessionStart/UserPromptSubmit/PreToolUse）迁移为本地插件 trellis-hooks v0.1.0（type:process + ZCODE_PLUGIN_ROOT，不经过信任门），登记进 marketplace.json 并推送（27b3cfc），清空工作区 .zcode/config.json hooks，用户级启用 trellis-hooks@zcode-toolbox 并预置客户端缓存。三脚本从缓存目录实测 exit 0 输出正确。待办：重启客户端在插件管理确认启用；其他 Trellis 项目的工作区 hooks 需清空以免双重注入。

### Git Commits

| Hash | Message |
|------|---------|
| `27b3cfc` | (see git log) |

### Status

[OK] **Completed**


## Session 5: zcode-metrics v0.7.0/v0.8.0：速度趋势模型分列 + 近24小时粒度，悬停列读数与图例开关

**Date**: 2026-09-01
**Task**: zcode-metrics v0.7.0/v0.8.0：速度趋势模型分列 + 近24小时粒度，悬停列读数与图例开关
**Branch**: `main`

### Summary

速度趋势面板两项增强（v0.7.0）：store.trend 新增 m24 序列（144 个 10 分钟桶）与桶内前 5 模型分列数据 m（空桶不下发控体积）；前端新增近 24 小时默认档位、每模型配色曲线与动态图例。修复两个交互缺陷（v0.8.0）：悬停按 |dx| 吸附时汇总点恒先入池导致模型读数不可见，改为按时间列吸附一次展示该时刻全部可见曲线多行读数；图例改为开关可隐藏/恢复任意曲线（含汇总线），峰值纵轴随可见曲线重算，切换档位/口径重置隐藏状态。验证：单测 45/45；CDP 驱动无头 Chrome 交互验证（初始悬停多行、隐藏主请求后 tooltip 剩模型行、隐藏/恢复线数正确）；快照体积 ~32KB 满足 AC10。注意：无头 Chrome 截图与 SSE/virtual-time 存在时序坑，最终用 CDP 确定性验证。

### Git Commits

| Hash | Message |
|------|---------|
| `0585dca` | (see git log) |
| `b141746` | (see git log) |

### Status

[OK] **Completed**


## Session 6: zcode-metrics v0.9.0：移除 Readout 大数字卡，Sessions 两行式行卡承载实时信息

**Date**: 2026-09-01
**Task**: zcode-metrics v0.9.0：移除 Readout 大数字卡，Sessions 两行式行卡承载实时信息
**Branch**: `main`

### Summary

应用户判断移除 Readout·Last / Readout·Turn 两块大数字卡（Last 与 Detail 面板重复、Turn 锁死单会话），连同渲染逻辑与无用 CSS 清理。Sessions 面板升级为主行（全屏 8/12 列、列表上限 162→240px），行卡改两行式：首行状态灯+短 ID+实时读数+最近活跃；次行生成中显示本轮次数/Σtokens/已耗时/最近模型，空闲显示最近请求模型与 tokens/耗时+上一轮摘要，估算记录带'估'标。验证：合成 rollout 日志 + /internal/event 注入生成中/空闲双会话，CDP 驱动无头 Chrome 断言行文本、面板移除、栅格与列表高度并截图；单测 45/45。注：合成数据一次性灌入会使 turn 均值瞬时虚高，真实流量无此现象。

### Git Commits

| Hash | Message |
|------|---------|
| `c47d3ad` | (see git log) |

### Status

[OK] **Completed**

## Session 7: 搬移 zcode-speed-panel 精华到 zcode-metrics（v0.10.0）

**Date**: 2026-09-20
**Task**: 09-20-port-speed-panel-features（父）+ 5 子任务（speed-tier-color / today-usage-card / speed-accuracy-calibration / mini-speed-page / realtime-speed-spike）
**Branch**: `main`

### Summary

研究 Masterchiefm/zcode-speed-panel（Tauri 桌面速度面板）后按父子任务树搬移四个功能并完成一个可行性 spike。①六档速度配色（0–40 绿→320+ 品红，柱图/会话行/趋势悬停/模型对比同数值同色，lite 降饱和、估算斜纹，TIERS 标记块单源 + index/mini 同源断言测试）；②今日用量卡片——关键发现：rollout 对今日用量覆盖率实测仅 ~17%（11.76M vs 官方 69.2M），改为 sqlite3 CLI 只读直读官方 turn_usage（computed_total = input+output，与手工对账一致），失败回退 rollout 聚合并降级标注；③口径核实（research.md：outputTokens 已含 reasoning+toolArgs、durationMs=全时长无 TTFT、model.role 恒 None 改用 querySource 判 role）+ 动态校准替换 ÷4（完整字符口径 chars=text+reasoning+toolArgs，模型分桶 median，实证默认 3.158，calibration.json 持久化+预热恢复，端到端验证 3158→1000 精确命中）；④/mini 迷你速度窗（大字六档读数+今日官方口径+会话 chips，localStorage 跟随主页聚焦）。spike 结论：进行中实时速度在 Electron 架构下不可行（rollout 完成时一次性落盘 ~260KB/条、psutil 缺失且磁盘计数看不到网络流），现状轮内吞吐即回退形态，rollout 若改流式落盘则字节×校准路径复活。验证：70/70 单测；Playwright DOM 断言 + 视觉子代理两轮审查（绿/黄绿档距、图例阈值标注、降饱和消歧均按审查意见修正）；hook 接管冒烟 4521@0.10.0。教训：ZCode 本地市场插件从 cache/<ver>/ 运行 hook，仓库升版后需在设置里更新插件否则旧 hook 会把收集器接管回旧版。spec 沉淀：backend 数据源契约 + frontend 标记块单源/配色语义/口径语义。

### Git Commits

| Hash | Message |
|------|---------|
| `1543eb8` | feat(zcode-metrics): 搬移 speed-panel 精华：六档配色、今日用量官方口径、字符动态校准、迷你速度窗（v0.10.0） |
| `961c2b6` | docs(spec): 沉淀 zcode-metrics 数据源契约与前端配色/口径约定 |

### Status

[OK] **Completed**

## Session 8 · 2026-10-13 · 修复 v0.13.x 速度显示"时而显示时而不显示"

用户报"速度时而显示时而不显示"。诊断（全部实证，无猜测）：收集器健康、事件正常到达、curl 直打 /internal/event 带 speedBadge:true 徽章秒拉、手动 true true 提醒正常——唯独真实会话零注入零拉起。根因：ZCode **不在 hook args 展开 ${user_config.\*}**（仅 MCP server 配置展开，zcode-guide 文档白名单确证），字面量传入 ensure.mjs；0.12.0 宽松解析 !== "false"（字面量=开）掩盖了问题，**0.13.0 改严格 === "true"（字面量=关）立即翻车**——速度卡提醒从不注入、徽章从不自动拉起；11:33 更新触发接管 cleanup 杀掉手动徽章后彻底全灭。rollout 请求体取证：更新后会话提醒注入 0 次（注意系统提示里技能描述含同名字样，须用注入文本独有短语计数）。修复（10-13-fix-userconfig-template，v0.13.2，8e35813）：hooks/userflags.mjs 三级解析（显式 true/false > ~/.zcode/cli/config.json plugins.options[目录名后缀] > plugin.json 默认），8 项新单测全套 81/81，字面量参数端到端验收通过。教训：验证 hook 传参必须用字面量模板模拟真实调用，true true 手动路径会掩盖展开问题。spec 沉淀 backend/zcode-plugin-hooks.md。

### Git Commits

| Hash | Message |
|------|---------|
| `8e35813` | fix(zcode-metrics): v0.13.2 hook 开关失效修复——user_config 模板不在 hook args 展开，回退读客户端配置 |

### Status

[OK] **Completed**
