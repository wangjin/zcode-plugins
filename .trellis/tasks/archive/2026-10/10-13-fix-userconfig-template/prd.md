# zcode-metrics 修复 hook 开关不生效（user_config 模板不展开）

## Goal

修复 v0.13.0 起速度卡提醒不注入、徽章不自动拉起的缺陷：hooks.json 用 `${user_config.speedCard}` / `${user_config.speedBadge}` 传开关，但 ZCode **不在 hook args 展开 user_config**（仅 MCP server 配置展开），字面量传入 ensure.mjs 后被严格解析 `=== "true"` 判为关。

## Requirements

- 开关解析优先级：显式 `"true"` / `"false"` 参数 > ZCode 客户端配置文件（`~/.zcode/cli/config.json` 的 `plugins.options["zcode-metrics@zcode-toolbox"]`）> plugin.json 默认值（speedCard=true，speedBadge=false）。
- 配置键从 `ZCODE_PLUGIN_DATA` 目录名后缀推导（`zcode-metrics@zcode-toolbox`）；env 缺失时回退 `zcode-metrics` 前缀匹配。
- 解析逻辑抽为可单测的纯模块（依赖注入 configPath / dataDirName），不引第三方依赖，不改变 hook stdout 协议与超时预算（sync 读一个小 JSON 文件，开销可忽略）。
- 显式 true/false 直通语义保持不变（若未来 ZCode 支持展开，行为自动升级）。
- 版本 0.13.1 → 0.13.2，plugin.json 与 marketplace.json 同步（有提交门禁测试）。

## Acceptance Criteria

- [ ] 传字面量 `${user_config.speedCard}` 时：config.json 中 speedCard=true → 提醒注入；speedBadge=true → 徽章拉起。
- [ ] config.json 缺失/损坏/无对应键 → 落 plugin.json 默认值（speedCard 开、speedBadge 关）。
- [ ] 显式 `"true"`/`"false"` 参数行为与旧版一致。
- [ ] `node --test test/` 全绿（含新增 userflags 单测与 marketplace-sync 门禁）。
- [ ] 手动端到端验证：以字面量模板参数跑 ensure.mjs，stdout 输出速度卡提醒；server 端收到 speedBadge=true 并拉起徽章。

## Notes

- 诊断过程与本根因的完整证据链见 2026-10-13 会话；平台契约（hook 模板变量白名单）沉淀到 .trellis/spec。
- 用户更新插件后，字面量回退链路即生效；无需用户改任何配置。
