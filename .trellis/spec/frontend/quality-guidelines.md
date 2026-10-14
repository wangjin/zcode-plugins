# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

前端即 `plugins/zcode-metrics/dashboard/` 的两个内联单文件页面：`index.html`（完整仪表盘）与 `mini.html`（迷你速度窗）。无构建链、无框架、无 CDN——所有 JS/CSS 内联，Node 收集器直接整文件下发并缓存（改 HTML 后需重启收集器）。

---

## Required Patterns

### TIERS 标记块单源模式（HTML 内嵌纯函数如何单测）

仪表盘速度六档配色（`TIERS` 表 + `tierOf`/`tierDesat`）内嵌在 `index.html` 的 `/* TIERS-SRC-START */ … /* TIERS-SRC-END */` 标记块内：

- **`mini.html` 内嵌同一标记块，必须逐字节一致**（`test/tier.test.mjs` 提取两侧断言相等，防两份档色漂移）。改动任何一侧 → 拷贝整块到另一侧。
- 测试经标记提取 + `new Function` 求值获得函数引用，不依赖 DOM。
- 新的"内嵌 HTML 又要单测"的纯函数都应沿用此模式。

### 配色语义（暗色主题，唯一主题）

- 速度读数按六档暖色亮度阶梯着色（0–40 深砖红 `#C13A2E` / 40–80 朱红 `#E05F35` / 80–160 橙 `#F08A3E` / 160–240 琥珀 `#F2B24E` / 240–320 黄 `#F3D96B` / 320+ 浅绿 `#B4E3A0`），慢深快浅、色系红→橙→黄→绿（2026-10-13 用户两轮指定，替换旧红绿灯语义色），**同数值同色**，任何展示速度的位置统一走 `tierOf()`。TIERS 单源在 `dashboard/uicard.mjs`，`badge/badge.swift` 与其跨语言同步（test 门禁）。
- 语义区分不得靠颜色单载：估算值=斜纹、lite 后台=降饱和档色（`tierOf().muted`，k=0.6 向灰）、生成中=状态点脉冲——同一页面内颜色语义不得复用冲突。
- 新增 UI 色一律走 `:root` CSS 变量或 TIERS 表；禁止散落硬编码色值。

### 聚焦口径语义（主页与迷你窗必须一致）

- `selectedSid == null` = "全部/自动跟随" → 分析面板用**全局**数据；锁定会话 → 该会话过滤数据。迷你窗经 `localStorage["tsdMiniFocus"]`（空串=全部）+ `storage` 事件跟随主页，主页聚焦变化时写入。

---

## Testing Requirements

- DOM 逻辑不写单测（无 jsdom），用"标记块提取纯函数单测 + Playwright 浏览器冒烟（DOM 计算样式断言）"两层覆盖。
- 浏览器冒烟必须用 `ZCODE_PLUGIN_DATA` + `TSD_PORT` + `ZCODE_ROLLOUT_DIR` 隔离实例，禁止对真实 4521 实例注入合成状态。

---

## Code Review Checklist

- 改了 TIERS 表或主题色：两个 HTML 是否同步？tier.test 是否仍绿？
- 新增速度读数展示位：是否走 `tierOf()`？估算/lite 语义是否仍可区分？
- 迷你窗与主页的聚焦/今日口径语义是否一致（自动跟随=全局，锁定=会话）？
