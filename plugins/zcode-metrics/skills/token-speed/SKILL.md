---
name: token-speed
description: Append the zcode-metrics token speed card to the current reply. Use when the UserPromptSubmit context contains a "[zcode-metrics] token 速度卡" reminder, or when the user asks for token speed, tok/s, 速度卡 or in-UI speed display.
---

# Token 速度卡（Gen UI 内联卡片）

zcode-metrics 收集器会在每回合把本会话的速度快照渲染成 HTML 片段
（`token-speed.html`）写入本会话的可视化目录。本技能只做一件事：
在回复末尾追加对这个片段的 `::visualize` 引用，让速度卡内联显示在回复下方。

## 输出规则

1. 路径以 hook 注入的提醒为准（形如
   `[zcode-metrics] token 速度卡：…输出 ::visualize{"path":"…"}`）。
   没有提醒时，用本会话 Desktop Context 提供的可视化目录拼
   `<可视化目录>/token-speed.html`。
2. 在**最终回复的末尾**，单独一行原样输出引用，不放进代码围栏，
   不加 Markdown 链接，前后各留一个空行：

   ```text
   ::visualize{"path":"/absolute/path/to/token-speed.html"}
   ```

3. 除这一行引用外不要输出其他与速度卡相关的说明文字；
   文件不存在时静默省略引用（不要输出指向不存在文件的引用）。
4. 该引用每回合都要重新输出（宿主按消息渲染，旧消息的卡片不会自动刷新）。

## 边界（回答用户疑问时用）

- 卡片是**回合级快照**：大数字为最近完成回合的合计速度，柱状图为本会话
  近 24 次模型响应；回合内的逐秒实时速度请用浏览器小窗 /mini（SSE 实时）。
- 卡片由收集器进程维护；收集器未运行（插件被禁用）时不会有提醒注入，
  此时不要输出引用。
