# ZCode Plugin Hooks 平台契约

> 2026-10-13 由 zcode-metrics v0.13.2 修复沉淀（根因诊断耗整场会话，此类坑必须提前可知）。
> 权威来源：zcode-guide 插件 0.3.0 `skills/diagnosing-hooks/SKILL.md` 与 `diagnosing-mcp/SKILL.md`。

## Hook 参数模板变量白名单

hooks.json 的 `command` / `args` 只展开环境类模板：

- `${ZCODE_PROJECT_DIR}` / `${CLAUDE_PROJECT_DIR}`
- `${ZCODE_SESSION_ID}` / `${CLAUDE_SESSION_ID}`
- `${ZCODE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`（插件 hook）

**`${user_config.*}` 不在 hook 展开**——ZCode 把它原样作为字面量字符串传给脚本。它只在**插件 MCP server 配置**（plugin.json 的 mcpServers env/args）里展开。技能目录变量在 hook 里无效且报错。

## 插件 hook 读用户配置的正确姿势

解析优先级（zcode-metrics `hooks/userflags.mjs` 的模式，可直接复用）：

1. 显式 `"true"` / `"false"` 参数直通（未来平台支持展开时自动升级，无需改代码）；
2. 读 ZCode 客户端配置 `~/.zcode/cli/config.json` → `plugins.options["<plugin>@<marketplace>"]`（键 = `ZCODE_PLUGIN_DATA` 目录名后缀，唯一事实源；env 缺失时用 `<plugin>` / `<plugin>@*` 前缀回退）；
3. 落 plugin.json `userConfig.*.default`（与代码内常量做同步门禁测试）。

值是 JSON boolean，非 boolean 一律忽略落默认。

## 调试要点（勿重蹈）

- **手动模拟真实调用必须传字面量**：`node hooks/ensure.mjs user_prompt_submit '${user_config.speedCard}' '${user_config.speedBadge}'`（单引号防 shell 展开）。只测 `true true` 会掩盖模板不展开问题——v0.13.1 的"已验证"正是这样被误导的。
- hook stdout 协议：`{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}`；UserPromptSubmit 注入是否生效看 rollout（`~/.zcode/cli/rollout/model-io-<sess>.jsonl`）请求体里的注入文本，不要凭 UI 现象推断。
- 系统提示里的技能描述会包含配置相关字样，grep 计数时用注入文本的独有短语（如"单独一行原样输出"），避免误判为已注入。
- 收集器 daemon 链路问题分层排查：hook 是否跑（server 端 lastUserMs 是否刷新）→ 参数展开（本文白名单）→ server 端逻辑（curl 直打 `/internal/event`）。
