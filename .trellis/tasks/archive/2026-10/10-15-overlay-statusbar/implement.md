# implement · zcode-metrics 客户端注入式状态栏

执行顺序自上而下；每步末尾的验证命令必须通过再进下一步。

## 步骤

### 1. 搭建 overlay/ 目录骨架
- [ ] `plugins/plugins/zcode-metrics/overlay/` 新建，从 `/tmp/zusage-ref/` 移植四件：
  `inject-main.cjs`（重命名 zusage→zcm 命名空间）、`overlay.js`（v1 重写）、
  `query.py`（重写）、`install/patch_install.py`（移植精简）。
- 验证：`node --check overlay/inject-main.cjs`；
  `python3 -c "import ast;ast.parse(open('overlay/query.py').read())"`。

### 2. query.py（口径优先，先 CLI 后 serve）
- [ ] 移植 session_usage / last_turn(turn_usage) / tps 窗口 / sub 聚合 / tools 分组 /
  today / ctx_exc / context window 正则解析（zcode-builtin.json）。
- [ ] serve 行协议 + json 一次性模式；sid 白名单。
- 验证：`python3 overlay/query.py json <本机活动sid>` 输出 JSON 与 sqlite 手工查询抽查一致
  （会话累计/本轮/tps/上下文窗口）。

### 3. overlay.js（渲染端）
- [ ] 骨架：代际守卫/协调器/实例工厂/主题跟随。
- [ ] 定位链：cardOf → ensureCardPad → track rAF；可见性三判 + 迟滞。
- [ ] 七个显示项 + tooltip + 设置面板 + 子代理面板。
- 验证：`node --check`；临时 HTML harness（模拟 composer + payload）手动核对渲染
  （浏览器打开，不走 ZCode）。

### 4. inject-main.cjs（主进程）
- [ ] 移植泵/常驻查询/热更新/IPC mine 注入；函数名换 `__zcodeMetrics*`。
- 验证：`node --check`。

### 5. patch_install.py（安装器）
- [ ] 移植 asar 读写/原子替换/.tmp 收尾/注入行正则/check/remove/finalize。
- [ ] 运行时目录复制逻辑（--runtime，默认 ~/.zcode/zcode-metrics-overlay/）。
- 验证：`python3 overlay/install/patch_install.py check`（未注入 → not injected）。

### 6. 真机安装与验收
- [ ] 备份提醒输出后执行 install；用户完全退出重启 ZCode。
- [ ] 按 prd.md 验收清单逐项过（数值抽查、开关持久化、分屏、弹窗收起、remove）。
- 验证：`python3 .../patch_install.py check` → injected + syntax ok。

### 7. 插件收尾
- [ ] plugin.json 增 statusbar 开关 + README「状态条」章节（代价/安装/卸载/更新重装）。
- [ ] 单测：query.py 口径用 sqlite 内存库固定夹具测（test/overlay-query.test.mjs 调 python3）；
  marketplace-sync 测试若校验字段需同步。
- 验证：`node --test test/` 全绿。

### 8. 质量检查 + 提交（trellis-check → commit）
- [ ] trellis-check 全量：lint/测试/跨层一致性。
- [ ] 提交：`feat(zcode-metrics): v0.15.0 客户端注入式状态条——输入框下方用量胶囊（参考 ByteRax 项目复刻）`。

## 回滚点

- 步骤 1-5 全部是新增文件，直接删除即回滚。
- 步骤 6 注入后异常 → `patch_install.py remove` + 重启 ZCode。
- 客户端异常（最坏）→ remove 后 asar 恢复为官方版本内容 + 注入行剥离。
