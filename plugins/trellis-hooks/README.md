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

三个脚本运行时从 hook 输入的 `cwd` 向上查找项目 `.trellis/`（不依赖插件自身路径），
因此**对所有 Trellis 项目通用**，非 Trellis 项目静默退出。

## 维护

- 脚本源头是 Trellis 各平台共用的 hook（本项目 `.zcode/hooks/` 与其他项目的同名文件内容一致）。
  升级 Trellis 后，把新版脚本拷贝进 `hooks/` 并**递增 plugin.json 的 version**，
  客户端才会刷新插件缓存（`~/.zcode/cli/plugins/cache/zcode-local-dev/trellis-hooks/`）。
- 临时跳过某轮注入：提示词中包含 `no-trellis`（可在 `.trellis/config.yaml` 的
  `prompt_injection.skip_keyword` 改名）。
