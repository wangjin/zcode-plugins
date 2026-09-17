# trellis-hooks

Trellis 工作流的 ZCode hooks，以**本地插件**形式分发。

## 为什么要做成插件

同样三个 hooks 之前注册在工作区 `.zcode/config.json` 里，受 ZCode「工作区 Hook 信任」门控：
应用重启 / 换窗口后信任状态可能重新变为 pending，hooks 被 `config_project_hooks_pending_trust`
拦截，UI 显示「UserPromptSubmit 工作区 … 已阻止」。**插件 hooks 不经过工作区信任门**，
与内置 hooks 一样直接运行，因此改为插件分发，一次启用长期生效。

## 注册的 hooks

| 事件 | matcher | 脚本 | 作用 |
| --- | --- | --- | --- |
| `SessionStart` | `startup\|clear\|compact` | `session-start.py` | 注入 Trellis 会话概览（任务状态、工作流摘要、spec 索引） |
| `UserPromptSubmit` | 全部 | `inject-workflow-state.py` | 每轮注入 `<workflow-state>` 面包屑 |
| `PreToolUse` | `Agent\|Task` | `inject-subagent-context.py` | 给 trellis-implement / trellis-check 子代理注入任务上下文 |
| `PreToolUse` | `Bash` | `inject-shell-session-context.py` | 待执行命令调用 `task.py start/current/finish` 时写 shell ticket，桥接宿主会话身份 |

脚本经 `${ZCODE_PLUGIN_ROOT}`（插件缓存绝对路径）定位，**不随 agent cwd 漂移**——这是
插件形态相对工作区 `.zcode/config.json` 注册（`${ZCODE_PROJECT_DIR}` 跟随 agent 实时目录，
cd 进子目录后路径失效）的核心优势。脚本运行时再从 hook 输入的 `cwd` 向上查找项目
`.trellis/`，因此**对所有 Trellis 项目通用**，非 Trellis 项目静默退出。

## 维护

- 脚本源头是 Trellis 各平台共用的 hook（trellis 包 `dist/templates/shared-hooks/`，
  各项目 `.zcode/hooks/` 下的同名文件由 trellis 写入）。升级 Trellis 后，把新版脚本拷贝进
  `hooks/` 并**递增 plugin.json 的 version**，客户端才会刷新插件缓存
  （`~/.zcode/cli/plugins/cache/zcode-toolbox/trellis-hooks/`）。
  注意：上游模板的 `session-start.py` 直接信任 `*_PROJECT_DIR`/cwd 推导项目根，ZCode 下
  compact/clear 时若 agent 已在子目录会 ModuleNotFoundError，re-vendor 后需重套 main() 里
  的 CWD-drift guard（向上探测 `.trellis/`，找不到静默退出）。
- 临时跳过某轮注入：提示词中包含 `no-trellis`（可在 `.trellis/config.yaml` 的
  `prompt_injection.skip_keyword` 改名）。
