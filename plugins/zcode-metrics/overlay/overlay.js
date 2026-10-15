/* zcode-metrics · token 用量状态条 v1（渲染进程注入，自包含 IIFE）。
 * 形态：输入框视觉卡片正下方的悬浮胶囊条——给卡片加 margin-bottom 让位，条 fixed 悬浮
 *       在卡片边框外，rAF 每帧跟随；左右两缘与卡片对齐（宽=卡片实测宽；超宽分级收缩）。
 *       （条不能放在输入框中心点所在矩形内：命中检测自遮挡 = 周期性闪烁，参考项目实测。）
 * 显示项（⚙ 面板逐项开关，localStorage 持久化）：生成速度 / 上下文环形进度 / 本轮 /
 *       会话累计 / 工具调用 / 今日合计 / 子代理（点击弹明细面板）。
 * 主题：配色全量跟随客户端主题——颜色一律 var(--color-*, 兜底值)；MutationObserver 观察
 *       <html> 的 .dark 类同步 .zcm-light（仅剩阴影/三档色程度性差异）。
 * 字体：var(--font-mono, 兜底) / var(--ui-font-size, 14px) 跟随客户端。
 * 数据：主进程泵推 window.__zcodeMetricsUpdate(payload)；mine（窗口焦点会话）优先，
 *       分屏按 composer 祖先链 data-session-id；池里没有就显示本会话零值，绝不串会话。
 * 机制移植自 ByteRax/zcode-token-usage-statusbar overlay.js（v69 机制，命名空间 zcm）：
 *       代际守卫 / 自绘 tooltip（空中走廊+越顶宽限）/ 面板互斥 / 幽灵子树与模态收口 /
 *       多实例协调器（data-pane-id 派发）。 */
(function () {
  if (window.__zcodeMetricsOverlay) return;
  window.__zcodeMetricsOverlay = true;
  /* 代际守卫：热更新后旧实例（interval/rAF 闭包无法外部清除）发现代号落后即永久罢工 */
  var MY_GEN = (window.__zcodeMetricsGen = (window.__zcodeMetricsGen || 0) + 1);
  function stale() { return MY_GEN !== window.__zcodeMetricsGen; }
  try {
    document.querySelectorAll(".zcm-root,.zcm-tip-root,.zcm-panel-host").forEach(function (el) { el.remove(); });
  } catch (e) { }

  var FATAL = (window.__zcodeMetricsDiag = {});
  var LS = { show: "zcm1.show", ctxOv: "zcm1.ctxOv", lang: "zcm1.lang" };
  var state = {
    show: { tps: 1, ctx: 1, turn: 1, win: 1, tools: 1, today: 1, sub: 1 },
    ctxOv: "", data: null, lang: "zh",
  };
  function L(zh, en) { return state.lang === "en" ? en : zh; }
  function ls(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  try {
    var s0 = JSON.parse(ls(LS.show, "null"));
    if (s0 && typeof s0 === "object") for (var k0 in state.show) if (k0 in s0) state.show[k0] = s0[k0] ? 1 : 0;
    state.ctxOv = ls(LS.ctxOv, "");
    if (ls(LS.lang, "") === "en") state.lang = "en";
  } catch (e) { }
  function persist() {
    lsSet(LS.show, JSON.stringify(state.show));
    lsSet(LS.ctxOv, state.ctxOv);
    lsSet(LS.lang, state.lang);
  }

  /* ---------- 多实例注册表：每个分屏 pane 一个条实例 ---------- */
  var instances = [];
  var nextSlot = 0;   // 0 号保留兼容 id（#zcm-bar，泵热更新按它清理）
  function renderAll(rebuildPanels) {
    for (var i = 0; i < instances.length; i++) {
      if (rebuildPanels) instances[i].rebuild();
      if (state.data) instances[i].render(state.data);
    }
  }
  window.__zcodeMetricsUpdate = function (d) {
    if (stale()) return;
    state.data = d;
    for (var i = 0; i < instances.length; i++) {
      try { instances[i].render(d); } catch (e) { FATAL.updateErr = String((e && e.stack) || e); }
    }
  };
  function refreshWants() {
    /* 各 pane 会话 id 汇总给泵：泵把它并入查询白名单强制拉取 */
    try {
      var arr = [];
      for (var i = 0; i < instances.length; i++) {
        var s1 = instances[i].getSid();
        if (s1 && arr.indexOf(s1) < 0) arr.push(s1);
      }
      window.__zcodeMetricsWantSids = arr;
    } catch (e) { }
  }

  setTimeout(function () {
    try { coordinator(); } catch (e) {
      FATAL.fatal = String((e && e.stack) || e);
      var b = document.getElementById("zcm-bar");
      if (b) b.style.cssText = "position:fixed;right:16px;bottom:16px;font:12px monospace;color:#ff7a59;" +
        "background:#1a0f0d;border:1px solid #ff7a59;border-radius:6px;padding:4px 10px;z-index:2147483647";
    }
  }, 0);

  function coordinator() {
    /* 协调器：扫描主文档里全部下半屏可见输入框，按 pane 键（data-pane-id，无属性回退
     * "auto"）分组派发；一个 pane 一条，pane 消失对应条自藏。 */
    function paneKeyOf(el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        if (p.hasAttribute && p.hasAttribute("data-pane-id")) return p.getAttribute("data-pane-id") || "auto";
      }
      return "auto";
    }
    function sessIdOf(el) {
      for (var p = el; p && p !== document.body; p = p.parentElement) {
        if (p.hasAttribute && p.hasAttribute("data-session-id")) return p.getAttribute("data-session-id") || "";
      }
      return "";
    }
    var SEL = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';
    function tick() {
      if (stale()) return;
      try {
        var best = {};
        document.querySelectorAll(SEL).forEach(function (el) {
          if (el.closest && el.closest('[role="dialog"]')) return;   // 弹窗内的编辑框不是聊天输入框
          var r = el.getBoundingClientRect();
          if (!(r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < innerHeight)) return;
          if (r.top < innerHeight * 0.45) return;   // 聊天输入框特征：视口下半部
          var k = paneKeyOf(el);
          if (!best[k] || r.top > best[k].top) best[k] = { el: el, top: r.top };
        });
        var keys = Object.keys(best);
        if (!keys.length && !instances.length) best["auto"] = { el: null, top: 0 };   // 主文档找不到 → 0 号走 deepFind 兜底
        keys.forEach(function (k) {
          var inst = null;
          for (var i = 0; i < instances.length; i++) if (instances[i].pid === k) { inst = instances[i]; break; }
          if (!inst && instances.length < 4) inst = spawnInstance(k, nextSlot++);
          if (inst) inst.attach(best[k].el, sessIdOf(best[k].el));
        });
        instances.forEach(function (inst) {
          if (keys.indexOf(inst.pid) < 0) inst.attach(null, "");
        });
      } catch (e) { FATAL.coordErr = String((e && e.stack) || e); }
    }
    tick();
    setInterval(tick, 600);
  }

  /* ---------- 实例工厂：一个 pane 一套 条/面板/tooltip/定位循环 ---------- */
  function spawnInstance(pid, slot) {
    var VERSION = "v1";
    /* ---------- 状态 ---------- */
    var excOn = false, excGone = false,
      lastSub = null, instSid = "", pendingSid = "", wantedEl = null,
      shrink = 0, fadeOn = false;

    /* ---------- DOM ---------- */
    /* 样式表挂在 bar 内部而非 head：React 可能清理 head 里的外来 style，
     * CSS 一旦失效条就退化成 static 占位元素（参考项目"输入框下方空白"的根因）。 */
    var style = document.createElement("style");
    style.textContent =
      ".zcm-root{position:fixed;box-sizing:border-box;" +
      "font-family:var(--font-mono,Consolas,'Cascadia Mono',Menlo,'Microsoft YaHei UI','Microsoft YaHei',monospace);" +
      "font-size:var(--ui-font-size,14px);line-height:1.3;" +
      "font-variant-numeric:tabular-nums;color:var(--color-foreground-subtle,#8791a3);" +
      "background:rgba(15,18,25,.86);background:color-mix(in srgb,var(--color-background,#0f1219) 86%,transparent);" +
      "backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);" +
      "border:1px solid var(--color-border,rgba(255,255,255,.07));border-radius:9px;padding:2px 6px;user-select:none;" +
      "box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 4px 14px rgba(0,0,0,.38),0 1px 3px rgba(0,0,0,.28);" +
      "display:flex;align-items:center;gap:2px;white-space:nowrap;" +
      /* 条不能 overflow:hidden：设置面板是条的子元素、展开在条外上方（裁剪会吞面板）；
       * 超宽截断由 .zcm-main 自己负责。 */
      "z-index:50}" +
      ".zcm-main{overflow:hidden;min-width:0;flex:1 1 auto;display:flex;align-items:center;gap:1px;justify-content:space-between}" +
      ".zcm-main.zcm-clip{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 26px),transparent);" +
      "mask-image:linear-gradient(90deg,#000 calc(100% - 26px),transparent)}" +
      ".it{display:flex;align-items:center;gap:4px;padding:2px 6px;border-radius:6px;" +
      "transition:background-color .12s ease-out}" +
      ".it:hover{background:var(--color-hover,rgba(255,255,255,.06))}" +
      ".sep{width:1px;height:15px;background:var(--color-border,rgba(255,255,255,.09));flex:0 0 auto;margin:0 1px}" +
      ".v{color:var(--color-foreground,#e9edf4);font-weight:600}" +
      ".pct{font-weight:700}.dim{color:var(--color-foreground-subtle,#667082)}" +
      /* 三档状态色刻意不走客户端变量：terminal-bright-* 是语法高亮色板，绿档在条面小字号上发白 */
      ".ok{color:#3ecf8e}.warm{color:#f5b944}.hot{color:#ff6b57}" +
      "@keyframes zcmexc{0%,100%{opacity:1}50%{opacity:.4}}" +
      ".exc{color:var(--color-destructive,#ff2d55);text-shadow:0 0 8px rgba(255,45,85,.5);animation:zcmexc 1.1s ease-in-out infinite}" +
      ".btn{cursor:pointer;padding:2px 6px;border-radius:6px;color:var(--color-foreground-subtle,#7e8899);" +
      "transition:background-color .12s ease-out,color .12s ease-out}" +
      ".btn:hover{color:var(--color-foreground,#e9edf4);background:var(--color-hover,rgba(255,255,255,.07))}" +
      ".btn:active{transform:scale(.96)}" +
      ".zcm-gear{flex:0 0 auto;font-size:calc(var(--ui-font-size,14px) + 3px);border-radius:6px}" +
      ".ico{width:12px;height:12px;flex:0 0 auto;color:var(--color-foreground-subtle,#7e8899);opacity:.85}" +
      ".eb{background:rgba(255,107,87,.14);background:color-mix(in srgb,var(--color-destructive,#ff6b57) 14%,transparent);" +
      "color:var(--color-destructive,#ff8a73);border-radius:999px;padding:0 6px;line-height:16px;font-weight:600;display:inline-flex;align-items:center;gap:2px}" +
      ".eb .ico{color:inherit}" +
      ".cbar{display:block;width:calc(var(--ui-font-size,14px) + 2px);height:calc(var(--ui-font-size,14px) + 2px);flex:0 0 auto;fill:none;stroke-width:3}" +
      ".cbar-track{stroke:var(--color-hover,rgba(255,255,255,.1))}" +
      ".cbar-value{stroke:currentColor}" +
      "@keyframes zcmpulse{0%,100%{opacity:1}50%{opacity:.2}}" +
      ".dot{animation:zcmpulse 1.6s ease-in-out infinite;font-size:var(--ui-font-size,14px);line-height:1}" +
      ".panel{position:absolute;bottom:calc(100% + 10px);left:0;background:rgba(19,22,30,.97);" +
      "background:color-mix(in srgb,var(--color-card,#13161e) 96%,transparent);" +
      "backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);" +
      "border:1px solid var(--color-border,rgba(255,255,255,.09));border-radius:12px;padding:12px 14px;display:none;" +
      "flex-direction:column;gap:4px;" +
      "font-family:var(--font-mono,Consolas,Menlo,'Microsoft YaHei UI',monospace);" +
      "font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.6;color:var(--color-foreground,#c6cdd9);" +
      "box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 12px 32px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.35);" +
      "min-width:280px;max-width:480px;max-height:72vh;overflow:auto;white-space:normal;z-index:2147483647;" +
      "scrollbar-width:thin;scrollbar-color:var(--color-border,rgba(255,255,255,.14)) transparent}" +
      ".panel.open{display:flex}" +
      ".panel label{display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:5px 8px;margin:0 -8px;" +
      "border-radius:8px;transition:background-color .12s ease-out}" +
      ".panel .cap{color:var(--color-foreground-subtlest,#6b7484);margin:4px 0 2px;font-size:calc(var(--ui-font-size,14px) - 2px);letter-spacing:.08em}" +
      ".panel .phead{font-weight:700;color:var(--color-foreground,#eef2f8);font-size:calc(var(--ui-font-size,14px) + 2px);margin-bottom:5px;display:flex;align-items:center;gap:8px}" +
      ".panel .pver{color:var(--color-brand,#57c7ff);font-weight:400;font-size:calc(var(--ui-font-size,14px) - 2px);background:rgba(87,199,255,.12);border-radius:999px;padding:1px 8px}" +
      ".panel label em{font-style:normal;color:var(--color-foreground-subtle,#6f7989);display:block}" +
      ".panel input[type=checkbox]{accent-color:var(--color-brand,#57c7ff);margin-top:3px}" +
      ".panel input[type=text]{width:110px;background:var(--color-input,rgba(0,0,0,.3));border:1px solid var(--color-border,rgba(255,255,255,.14));" +
      "color:var(--color-foreground,#e9edf4);border-radius:6px;padding:2px 7px;font:inherit;outline:none}" +
      ".panel .hr{border-top:1px solid var(--color-border,rgba(255,255,255,.08));margin:5px 0}" +
      ".panel .pnote{line-height:1.6;color:var(--color-foreground-subtle,#6f7989);margin-top:3px}" +
      ".zcm-sub{cursor:pointer}" +
      ".zcm-sub:hover .v{color:var(--color-foreground,#fff)}" +
      ".panel.subp{width:420px;max-width:60vw;gap:8px}" +
      ".subrow{padding:8px 10px;background:var(--color-surface,rgba(255,255,255,.03));border:1px solid var(--color-border,rgba(255,255,255,.06));border-radius:8px}" +
      ".subname{font-weight:600;color:var(--color-foreground,#e9edf4);font-size:var(--ui-font-size,14px);overflow-wrap:anywhere}" +
      ".substat{color:var(--color-foreground-subtle,#8791a3);margin-top:2px}" +
      ".sublive{color:#3ecf8e;font-size:calc(var(--ui-font-size,14px) - 2px);font-weight:400;background:rgba(62,207,142,.12);border-radius:999px;padding:0 7px;margin-left:7px}" +
      /* 自绘 tooltip：fixed 挂 body（挂 bar 内会被消息流的层叠上下文盖住） */
      ".tip{position:fixed;background:rgba(19,22,30,.98);background:color-mix(in srgb,var(--color-background,#13161e) 98%,transparent);" +
      "backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);" +
      "border:1px solid var(--color-border,rgba(255,255,255,.1));border-radius:10px;padding:8px 12px;" +
      "font-family:var(--font-mono,Consolas,'Microsoft YaHei UI',monospace);" +
      "font-size:calc(var(--ui-font-size,14px) - 1px);line-height:1.6;color:var(--color-foreground,#c6cdd9);" +
      "box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 10px 28px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.3);" +
      "white-space:pre-line;z-index:2147483646;max-width:560px;display:none;scrollbar-width:thin}" +
      ".tip .rt-h{font-weight:600;color:var(--color-foreground,#e9edf4);margin:0 0 6px}" +
      ".tip .rt-row{display:flex;gap:10px;margin:3px 0}" +
      ".tip .rt-row b{flex:0 0 auto;min-width:86px;color:var(--color-foreground,#e9edf4);font-weight:600}" +
      ".tip .rt-row span{color:var(--color-foreground-subtle,#8791a3)}" +
      ".tip .rt-note{margin-top:7px;padding-top:6px;border-top:1px solid var(--color-border,rgba(255,255,255,.1));color:var(--color-foreground-subtle,#8791a3)}" +
      ".ttabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:7px}" +
      ".ttab{cursor:pointer;padding:2px 10px;border-radius:999px;background:var(--color-hover,rgba(255,255,255,.06));" +
      "color:var(--color-foreground-subtle,#8791a3);white-space:nowrap;font-size:calc(var(--ui-font-size,14px) - 1px);}" +
      ".ttab.on{background:rgba(87,199,255,.16);color:var(--color-brand,#5ac8ff)}" +
      ".tbody{max-height:60vh;overflow:auto;scrollbar-width:thin}" +
      /* 浅色主题程度性覆盖：颜色已全量走客户端变量随 .dark 自动翻转，这里只兜两类 */
      ".zcm-root.zcm-light{box-shadow:inset 0 1px 0 rgba(255,255,255,.85),0 4px 14px rgba(15,23,42,.12),0 1px 3px rgba(15,23,42,.08)}" +
      ".zcm-light .panel{box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 12px 32px rgba(15,23,42,.14)}" +
      ".tip.zcm-light{box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 10px 28px rgba(15,23,42,.16)}" +
      ".zcm-light .exc{text-shadow:none}" +
      ".zcm-light .ok{color:#0f9d6c}.zcm-light .warm{color:#b6791a}.zcm-light .hot{color:#d8482f}" +
      ".zcm-light .sublive{color:#0c8a63;background:rgba(15,140,102,.12)}" +
      "@media (prefers-reduced-motion:reduce){.exc,.dot{animation:none}.it,.btn,.ttab{transition:none}}";

    var bar = document.createElement("div");
    bar.className = "zcm-root";
    if (slot === 0) bar.id = "zcm-bar";
    bar.style.display = "none";
    bar.innerHTML = '<span class="zcm-main">…</span><span class="btn zcm-gear">⚙</span>';
    var panel = document.createElement("div");
    panel.className = "panel zcm-settings";
    function settingRow(input, title, note) {
      return "<label>" + input + "<span>" + title + "<em>" + note + "</em></span></label>";
    }
    function buildPanel() {
      panel.innerHTML =
        '<div class="phead">' + L("状态条设置", "Status bar settings") + '<span class="pver">' + VERSION + "</span></div>" +
        '<div class="cap">' + L("显示项", "Display items") + "</div>" +
        settingRow('<input type="checkbox" data-k="tps">', L("生成速度", "Generation speed"), L("最近一段的输出速率（tok/s），三档色", "Latest segment output rate (tok/s), three color bands")) +
        settingRow('<input type="checkbox" data-k="ctx">', L("上下文", "Context"), L("环形进度与占用比例，超限亮红闪烁", "Ring progress and usage; flashing red when over limit")) +
        settingRow('<input type="checkbox" data-k="turn">', L("本轮", "Current turn"), L("tokens、请求次数、耗时与首字延迟", "Tokens, requests, duration and first-token latency")) +
        settingRow('<input type="checkbox" data-k="win">', L("会话累计", "Session total"), L("当前会话的 tokens、轮数与请求次数", "Tokens, turns and requests in this session")) +
        settingRow('<input type="checkbox" data-k="tools">', L("工具调用", "Tool calls"), L("悬停查看各工具明细与错误", "Hover for per-tool details and errors")) +
        settingRow('<input type="checkbox" data-k="today">', L("今日合计", "Today's total"), L("今天所有会话的消耗", "Usage across all sessions today")) +
        settingRow('<input type="checkbox" data-k="sub">', L("子代理", "Sub-agents"), L("点击状态条上的子代理查看明细", "Click the bar item for sub-agent details")) +
        '<div class="hr"></div>' +
        settingRow('<input type="text" class="zcm-ctxov" inputmode="numeric" placeholder="' + L("自动（按模型）", "Auto (model)") + '">', L("上下文窗口", "Context window"), L("留空自动识别（读客户端模型目录），优先使用客户端数值", "Leave empty to detect automatically from the client model catalog")) +
        '<div class="hr"></div>' +
        '<div class="zcm-langs"><label><input type="radio" name="zcm-lang" value="zh"><span>中文</span></label>' +
        '<label><input type="radio" name="zcm-lang" value="en"><span>English</span></label></div>' +
        '<div class="pnote">' + L("数据源 ~/.zcode/cli/db/db.sqlite（只读），请求完成后才落库。卸载运行安装目录下的 patch_install.py remove。",
          "Data source ~/.zcode/cli/db/db.sqlite (read-only); data lands after requests complete. Uninstall via patch_install.py remove in the install directory.") + "</div>";
      panel.querySelectorAll('input[name=zcm-lang]').forEach(function (r) { r.checked = state.lang === r.value; });
      panel.querySelectorAll("input[type=checkbox][data-k]").forEach(function (cb) {
        cb.checked = !!state.show[cb.dataset.k];
      });
      var ovInput = panel.querySelector(".zcm-ctxov");
      if (ovInput) ovInput.value = state.ctxOv;
    }
    buildPanel();
    bar.appendChild(panel);
    /* 子代理明细面板：与设置面板同款 .panel 机制，点击条目开关，互斥打开 */
    var subPanel = document.createElement("div");
    subPanel.className = "panel subp";
    bar.appendChild(subPanel);
    /* 自绘 tooltip：fixed 挂 body */
    var tip = document.createElement("div");
    tip.className = "tip zcm-tip-root";
    if (slot === 0) tip.id = "zcm-tip";
    tip.style.display = "none";
    document.body.appendChild(tip);
    bar.appendChild(style);           // 样式随条走，不进 head（防清理）
    /* z-index 50：压得过聊天列表/输入框外层容器（Tailwind z-20），不盖权限菜单等弹层 */
    bar.style.position = "fixed";
    bar.style.zIndex = "50";
    document.body.appendChild(bar);

    /* ---------- 主题跟随：深浅由客户端根元素 .dark 类驱动 ---------- */
    var rootEl = document.documentElement;
    function themeIsDark() {
      try { return rootEl.classList.contains("dark"); } catch (e) { return true; }
    }
    var themeDark = themeIsDark();
    function applyTheme() {
      bar.classList.toggle("zcm-light", !themeDark);
      tip.classList.toggle("zcm-light", !themeDark);
    }
    try {
      new MutationObserver(function () {
        var d = themeIsDark();
        if (d !== themeDark) { themeDark = d; applyTheme(); }
      }).observe(rootEl, { attributes: true, attributeFilter: ["class"] });
    } catch (e) { }
    applyTheme();

    var main = bar.querySelector(".zcm-main"), gear = bar.querySelector(".zcm-gear");

    /* ---------- 渲染 ---------- */
    function fmt(n) {
      n = n || 0;
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(n);
    }
    function sec(ms) { return ms ? (ms / 1000).toFixed(1) + "s" : "–"; }

    /* 超限判定：最近一次"上下文超限被拒"晚于最近成功请求 = 仍处于超限状态 */
    function excActive(s) {
      return !!(s && s.ctx_exc > 0 && s.ctx_exc >= (s.last_at || 0));
    }
    function cachePct(cache, input) {
      return input > 0 ? '<span class="dim">' + Math.round(cache / input * 100) + "%</span>" : "";
    }
    function fmtTime(ms) {
      var d = ms ? new Date(ms) : null;
      return d ? (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" +
        (d.getMinutes() < 10 ? "0" : "") + d.getMinutes() + ":" +
        (d.getSeconds() < 10 ? "0" : "") + d.getSeconds() : "?";
    }
    function ioc(inp, out, cache, rea, cw) {
      return L("输入 ", "Input ") + fmt(inp) + L(" / 输出 ", " / Output ") + fmt(out) + L(" / 缓存命中 ", " / Cache read ") + fmt(cache) +
        (cw > 0 ? L(" / 缓存写入 ", " / Cache write ") + fmt(cw) : "") +
        (rea > 0 ? L(" / 思考 ", " / Thinking ") + fmt(rea) : "");
    }
    function ttEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function ttH(t) { return '<div class="rt-h">' + ttEsc(t) + "</div>"; }
    function ttRow(k, v) { return '<div class="rt-row"><b>' + ttEsc(k) + '</b><span>' + ttEsc(v) + "</span></div>"; }
    function ttNote(v) { return '<div class="rt-note">' + ttEsc(v) + "</div>"; }
    function ico(paths) {
      return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
    }
    var ICO_TPS = '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>';
    var ICO_TURN = '<path d="M23 4v6h-6"/><path d="M20.49 15A9 9 0 1 1 18.36 5.64L23 10"/>';
    var ICO_GEN = '<path d="M6 3h12M6 21h12M8 3v3.5L12 11l4-4.5V3M8 21v-3.5L12 13l4 4.5V21"/>';
    var ICO_TTFT = '<path d="M5 20v-5M12 20v-9M19 20V5"/>';
    var ICO_SESS = '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';
    var ICO_TOOL = '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>';
    var ICO_ERR = '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>';
    var ICO_DAY = '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>';
    var ICO_SUB = '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>';
    var ICO_WARN = '<circle cx="12" cy="12" r="9"/><path d="M12 16h.01"/><path d="M12 8h.01"/>';

    function html(d) {
      var sess = d.session || {}, lt = d.last_turn || {}, today = d.today || {}, last = d.last || {};
      var tls = d.tools || { total: 0, errors: 0, list: [] };
      var items = [], tips = [];
      function it(inner, tipStr, cls) { items.push('<span class="it' + (cls ? " " + cls : "") + '">' + inner + "</span>"); tips.push(tipStr || null); }
      if (d.not_local) {
        it(ico(ICO_WARN) + '<span class="dim">' + L("不在本地库", "not in local db") + "</span>",
          L("这个会话不在本地数据库（~/.zcode/cli/db/db.sqlite）里，各项显示 0——不是插件坏了。",
            "This session is not in the local database (~/.zcode/cli/db/db.sqlite), so every item reads 0 — the bar is not broken."));
      }
      if (last.tps && state.show.tps) {   // 最近一段生成速度，三档变色
        var tpsCls = last.tps >= 70 ? "ok" : last.tps >= 40 ? "warm" : "hot";
        it(ico(ICO_TPS) + '<span class="' + tpsCls + '">' + last.tps + '</span><span class="dim">t/s</span>',
          "\x01" +
          ttH(L("生成速度 · 最近一段", "Generation speed · latest segment")) +
          ttRow(L("口径", "Basis"), L("输出 tokens（含思考）÷ 生成耗时", "output tokens (thinking incl.) ÷ generation time")) +
          ttRow(L("档位", "Bands"), L("≥70 绿 · 40–70 黄 · <40 红", "≥70 green · 40–70 yellow · <40 red")) +
          ttNote(L("每段完成即刷新；生成窗口含思考段（从 started_at 起算），工具等待不计入。",
            "Refreshes as each segment completes; thinking segments count from started_at, tool waits excluded.")));
      }
      if (state.show.ctx) {
        var cw = parseInt(state.ctxOv, 10) || d.native_ctx || d.context_window || 0;
        var pct = cw ? sess.ctx / cw * 100 : 0;
        var exc = excActive(sess);
        var big = cw >= 1000000;   // 百万窗口提前预警：40/60，其余 70/85
        var cls = exc ? "exc" : pct >= (big ? 60 : 85) ? "hot" : pct >= (big ? 40 : 70) ? "warm" : "ok";
        var ring = cw ? '<svg class="cbar" viewBox="0 0 24 24" aria-hidden="true"><circle class="cbar-track" cx="12" cy="12" r="9"/>' +
          '<circle class="cbar-value ' + cls + '" cx="12" cy="12" r="9" pathLength="100" stroke-dasharray="' +
          Math.max(0, Math.min(100, pct)).toFixed(1) + ' 100" transform="rotate(-90 12 12)"/></svg>' : "";
        it(ring + (cw ? '<span class="pct ' + cls + '">' + pct.toFixed(1) + "%</span>"
          : '<span class="v' + (exc ? " exc" : "") + '">' + fmt(sess.ctx) + "</span>"),
          "\x01" +
          ttH(L("上下文容量", "Context capacity")) +
          (cw ? ttRow(L("已用 / 窗口", "Used / window"), fmt(sess.ctx) + " / " + fmt(cw))
            : ttRow(L("已用", "Used"), fmt(sess.ctx) + L("（窗口容量未知）", " (window capacity unknown)"))) +
          ttRow(L("颜色档位", "Color bands"),
            (big ? L("≤40% 绿 · 40–60% 黄 · ≥60% 红", "≤40% green · 40–60% yellow · ≥60% red")
              : L("<70% 绿 · 70–85% 黄 · ≥85% 红", "<70% green · 70–85% yellow · ≥85% red")) +
            L(" · 超限=亮红闪烁", " · over-limit = flashing red")) +
          (exc ? ttNote(L("⚠ 上下文超限：最近一次请求被拒（" + fmtTime(d.ctx_exc) + "），需压缩会话或新开会话",
            "⚠ Over limit: the latest request was rejected (" + fmtTime(d.ctx_exc) + ") — compress or restart the session")) : ""));
      }
      if (state.show.turn) {
        it(ico(ICO_TURN) +
          '<span class="v">' + fmt(lt.total) + "</span>" +
          (shrink ? "" : cachePct(lt.cache_read, lt.input)) +
          '<span class="dim">' + (lt.requests || 0) + L("次", " req") + "</span>" +
          ico(ICO_GEN) + '<span class="dim">' + sec(last.duration_ms) + "</span>" +
          ico(ICO_TTFT) + '<span class="dim">' + sec(last.ttft_ms) + "</span>",
          "\x01" +
          ttH(state.lang === "en" ? "Latest turn · " + (lt.requests || 0) + " requests" : "本轮 · " + (lt.requests || 0) + " 次请求") +
          ttRow(L("输入", "Input"), fmt(lt.input) +
            (lt.input > 0 && lt.cache_read > 0 ? L("（命中 " + Math.round(lt.cache_read / lt.input * 100) + "%）", " (" + Math.round(lt.cache_read / lt.input * 100) + "% cached)") : "")) +
          ttRow(L("输出", "Output"), fmt(lt.output) +
            (lt.reasoning > 0 ? L("（含思考 " + fmt(lt.reasoning) + "）", " (incl. " + fmt(lt.reasoning) + " thinking)") : "")) +
          (lt.cache_write > 0 ? ttRow(L("缓存写入", "Cache write"), fmt(lt.cache_write)) : "") +
          ttRow(L("耗时", "Time"), L("单次 ", "request ") + sec(last.duration_ms) + L(" · 首字 ", " · TTFT ") + sec(last.ttft_ms) + L(" · 轮总 ", " · turn ") + sec(lt.duration_ms)) +
          ((lt.tool_calls || lt.retries || lt.tool_errors)
            ? ttRow(L("工具", "Tools"), (lt.tool_calls ? lt.tool_calls + L(" 次调用", " calls") : "") +
              (lt.retries ? L(" · 重试 ", " · retries ") + lt.retries : "") +
              (lt.tool_errors ? L(" · 错误 ", " · errors ") + lt.tool_errors : "")) : ""));
      }
      if (state.show.win) {
        it(ico(ICO_SESS) +
          '<span class="v">' + fmt(sess.total) + "</span>" +
          (shrink ? "" : cachePct(sess.cache_read, sess.input)) +
          '<span class="dim">' + (sess.turns || 0) + L("轮 ", " turns · ") + (sess.requests || 0) + L("次", " req") + "</span>",
          "\x01" +
          ttH(L("会话累计 · 全部请求", "Session total · all requests")) +
          ttRow(L("输入", "Input"), fmt(sess.input) +
            (sess.input > 0 && sess.cache_read > 0 ? L("（命中 " + Math.round(sess.cache_read / sess.input * 100) + "%）", " (" + Math.round(sess.cache_read / sess.input * 100) + "% cached)") : "")) +
          ttRow(L("输出", "Output"), fmt(sess.output) +
            (sess.reasoning > 0 ? L("（含思考 " + fmt(sess.reasoning) + "）", " (incl. " + fmt(sess.reasoning) + " thinking)") : "")) +
          (sess.cache_write > 0 ? ttRow(L("缓存写入", "Cache write"), fmt(sess.cache_write)) : "") +
          ttRow(L("规模", "Scale"), (sess.turns || 0) + L(" 轮 · ", " turns · ") + (sess.requests || 0) + L(" 次请求", " requests") +
            (sess.tool_calls ? L(" · 工具 ", " · tools ") + sess.tool_calls : "") +
            (sess.retries ? L(" · 重试 ", " · retries ") + sess.retries : "")) +
          (d.code && (d.code.add || d.code.del)
            ? ttRow(L("代码变更", "Code changes"), "+" + (d.code.add || 0) + " / -" + (d.code.del || 0) +
              (d.code.files ? L("（" + d.code.files + " 文件）", " (" + d.code.files + " files)") : "")) : ""));
      }
      if (state.show.tools) {
        var toolRows = (tls.list || []).map(function (t1) {
          return ttRow(t1.name, t1.count + L(" 次 · ", " calls · ") + sec(t1.duration_ms) +
            (t1.errors ? L(" · 错误 ", " · errors ") + t1.errors : ""));
        }).join("");
        it(ico(ICO_TOOL) + '<span class="v">' + (tls.total || 0) + "</span>" +
          (tls.errors ? '<span class="eb">' + ico(ICO_ERR) + tls.errors + "</span>" : ""),
          "\x01" +
          ttH(state.lang === "en"
            ? "Tool calls · " + (tls.total || 0) + " total" + (tls.errors ? ", " + tls.errors + " errors" : "")
            : "工具调用 · 共 " + (tls.total || 0) + " 次" + (tls.errors ? " · 错误 " + tls.errors : "")) +
          (toolRows || ttNote(L("无工具调用记录", "No tool calls recorded"))));
      }
      if (state.show.today) {
        it(ico(ICO_DAY) + '<span class="v">' + fmt(today.total) + "</span>",
          "\x01" +
          ttH(L("今日合计 · 今天所有会话", "Today · all sessions")) +
          ttRow(L("输入", "Input"), fmt(today.input) +
            (today.input > 0 && today.cache_read > 0 ? L("（命中 " + Math.round(today.cache_read / today.input * 100) + "%）", " (" + Math.round(today.cache_read / today.input * 100) + "% cached)") : "")) +
          ttRow(L("输出", "Output"), fmt(today.output) +
            (today.reasoning > 0 ? L("（含思考 " + fmt(today.reasoning) + "）", " (incl. " + fmt(today.reasoning) + " thinking)") : "")) +
          ttRow(L("请求", "Requests"), (today.requests || 0) +
            (today.retries ? L(" 次请求 · 重试 ", " requests · retries ") + today.retries : L(" 次", " requests"))));
      }
      if (state.show.sub && d.sub && (d.sub.total || d.sub.active)) {
        it(ico(ICO_SUB) + '<span class="v">' + fmt(d.sub.total) + "</span>" +
          (d.sub.active ? '<span class="ok dot">●</span>' : ""),
          L("子代理：当前会话的后台子代理消耗（独立统计，不计入会话累计）。点击条目查看明细。",
            "Sub-agents: background sub-agent usage (tracked separately, not in the session total). Click for details."),
          "zcm-sub");
      }
      return { s: items.join('<span class="sep"></span>') || '<span class="dim">' + L("全部显示项已关闭", "All display items are off") + "</span>", tips: tips };
    }

    /* 当前会话识别：instSid（分屏 data-session-id）> mine（泵按窗口注入）> 零值 stub。
     * 池里没有就显示本会话零值——绝不回退到别的会话的数字。 */
    function stubFor(sid) {
      return { sid: String(sid || ""), title: "", active: false, turns: 0, requests: 0,
        input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0,
        tool_calls: 0, retries: 0, ctx: 0, updated: "", last_at: 0, ctx_exc: 0,
        last_turn: { requests: 0, retries: 0, tool_calls: 0, tool_errors: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, total: 0, duration_ms: 0, ttft_ms: 0 },
        last: { duration_ms: 0, ttft_ms: 0, model: "", tps: 0 },
        code: { add: null, del: null, files: null },
        tools: { total: 0, errors: 0, list: [] },
        sub: { requests: 0, total: 0, input: 0, output: 0, cache_read: 0, reasoning: 0, cache_write: 0, active: false, list: [] },
        context_window: 0, context_auto: false };
    }
    var pickedSid = "", lastHtml = "";
    function render(d) {
      state.data = d;
      var p = null;
      if (instSid) {
        pickedSid = instSid;
        var rec = d.recent || [];
        for (var i = 0; i < rec.length; i++) if (rec[i].sid === instSid) { p = rec[i]; break; }
        if (!p) p = stubFor(instSid);
      } else {
        var mine = d.mine;
        if (typeof mine === "string") {
          pickedSid = mine;
          if (mine) {
            var rec2 = d.recent || [];
            for (var j = 0; j < rec2.length; j++) if (rec2[j].sid === mine) { p = rec2[j]; break; }
            if (!p) p = stubFor(mine);
          } else {
            p = stubFor("");
          }
        } else {
          /* 泵无该窗口信息（辅助窗口/旧泵）：取池里最近活跃会话 */
          var rec3 = d.recent || [];
          p = rec3.length ? rec3[0] : stubFor("");
          pickedSid = p.sid || "";
        }
      }
      excOn = excActive(p);
      var view = {
        session: p, last_turn: p.last_turn || {}, last: p.last || {},
        today: d.today || {},
        native_ctx: 0, context_window: p.context_window, context_auto: p.context_auto,
        code: p.code, ctx_exc: p.ctx_exc, tools: p.tools,
        not_local: (d.not_local || []).indexOf(p.sid) >= 0,
        sub: p.sub || { requests: 0, total: 0, input: 0, output: 0, cache_read: 0, active: false, list: [] },
      };
      lastSub = view.sub;
      refreshWants();
      var h = html(view);
      /* 内容没变不重建 DOM：无条件 innerHTML 会重启呼吸灯动画 + 触发 tooltip 重画 = 闪烁 */
      if (h.s !== lastHtml) {
        lastHtml = h.s;
        main.innerHTML = h.s;
      }
      var els = main.querySelectorAll(".it");
      for (var k = 0; k < els.length; k++) els[k].__tip = h.tips[k] || null;
      /* 数据刷新时正在悬停：接管同位置的新元素继续显示，只调位置不重画 */
      if (tipFor) {
        var nu = null;
        if (tipFor === main) nu = main;
        else if (tipFor.__n === els.length) nu = els[tipFor.__idx];
        if (nu && nu.__tip) { tipFor = nu; positionTip(nu, true); } else hideTip(false, "render-orphan");
      }
      if (subPanel.classList.contains("open")) buildSubPanel(view.sub);
    }

    /* ---------- 自绘 tooltip ---------- */
    var tipFor = null, lastMoveAt = 0, tipSig = "";
    var mouseInBar = false;
    var tipGraceTimer = 0;
    function hideTip(force, cause) {
      if (!force && mouseInBar) return;
      if (tipGraceTimer) { clearTimeout(tipGraceTimer); tipGraceTimer = 0; }
      if (tip.style.display !== "none") tip.style.display = "none";
      tipFor = null;
      tipSig = "";
    }
    function positionTip(el, keepTop) {
      var tr = tip.getBoundingClientRect(), ar = el.getBoundingClientRect();
      var left = ar.left + ar.width / 2 - tr.width / 2;
      left = Math.max(8, Math.min(left, Math.max(8, innerWidth - tr.width - 8)));
      var top = (keepTop && tip.style.top) ? parseFloat(tip.style.top) : 0;
      if (!isFinite(top) || top < 8) top = Math.max(8, ar.top - tr.height - 8);
      tip.style.left = Math.round(left) + "px";
      tip.style.top = Math.round(top) + "px";
    }
    function drawTip(el, keepTop) {
      var t = el && el.__tip;
      if (!t) { tip.style.display = "none"; tipFor = null; return; }
      if (t === tipSig && tip.style.display === "block") { positionTip(el, true); return; }
      tipSig = t;
      tip.innerHTML = '<div class="tbody"></div>';
      if (t.charCodeAt(0) === 1) tip.firstChild.innerHTML = t.slice(1);
      else tip.firstChild.textContent = t;
      tip.style.display = "block";
      positionTip(el, keepTop);
    }
    function showTipFor(el) {
      tipFor = el;
      var its = main.querySelectorAll(".it");
      el.__idx = el === main ? -1 : Array.prototype.indexOf.call(its, el);
      el.__n = its.length;
      drawTip(el, false);
    }
    document.addEventListener("mousemove", function (e) {
      if (stale()) return;
      if (Date.now() - lastMoveAt < 150) return;
      lastMoveAt = Date.now();
      var t = e.target;
      if (!t || !t.closest) return;
      if (tip.contains(t)) { mouseInBar = true; cancelTipGrace(); return; }
      if (t.closest(".panel")) {
        mouseInBar = true;
        if (tipFor) hideTip(true, "panel-hover");
        return;
      }
      if (!bar.contains(t)) {
        if (tipFor && inTipCorridor(e.clientX, e.clientY)) { mouseInBar = true; cancelTipGrace(); return; }
        if (tipFor && inTipColumn(e.clientX, e.clientY)) {
          mouseInBar = true;
          if (!tipGraceTimer) tipGraceTimer = setTimeout(function () { tipGraceTimer = 0; hideTip(true, "grace-expire"); }, 300);
          return;
        }
        mouseInBar = false;
        if (tipFor) hideTip(true, "left-bar");
        return;
      }
      mouseInBar = true;
      cancelTipGrace();
      if (panel.classList.contains("open")) return;
      var el = t.closest(".it");
      if (el) { if (el !== tipFor) showTipFor(el); }
      /* 条面内非条目区：保持当前 tooltip 不动（切换内容/隐藏 = 闪烁） */
    }, true);
    window.addEventListener("blur", function () { mouseInBar = false; if (tipFor) hideTip(true, "win-leave"); }, true);
    function tipBoundaryHide(e) {
      if (stale() || !tipFor) return;
      var x = e.clientX, y = e.clientY;
      if (x <= 1 || x >= innerWidth - 2 || y <= 1 || y >= innerHeight - 2) {
        mouseInBar = false; hideTip(true, "win-leave"); return;
      }
      var r = tip.getBoundingClientRect();
      if (x >= r.left - 30 && x <= r.right + 30) {
        mouseInBar = true;
        cancelTipGrace();
        tipGraceTimer = setTimeout(function () { tipGraceTimer = 0; hideTip(true, "grace-expire"); }, 400);
      } else {
        mouseInBar = false;
        hideTip(true, "left-bar");
      }
    }
    document.documentElement.addEventListener("mouseleave", tipBoundaryHide, true);
    tip.addEventListener("mouseleave", tipBoundaryHide, true);
    tip.addEventListener("mouseenter", function () { cancelTipGrace(); }, true);
    function inTipCorridor(x, y) {
      var r = tip.getBoundingClientRect();
      return x >= r.left - 4 && x <= r.right + 4 && y >= r.top && y <= r.bottom + 12;
    }
    function inTipColumn(x, y) {
      var r = tip.getBoundingClientRect();
      return x >= r.left - 30 && x <= r.right + 30 && y >= r.top - 80 && y < r.top;
    }
    function cancelTipGrace() {
      if (tipGraceTimer) { clearTimeout(tipGraceTimer); tipGraceTimer = 0; }
    }

    /* ---------- 设置面板事件 ---------- */
    function syncPanel() {
      panel.querySelectorAll("input[type=checkbox][data-k]").forEach(function (cb) {
        cb.checked = !!state.show[cb.dataset.k];
      });
      panel.querySelector(".zcm-ctxov").value = state.ctxOv;
    }
    gear.addEventListener("click", function (e) {
      e.stopPropagation();
      syncPanel();
      var opening = !panel.classList.contains("open");
      panel.classList.toggle("open");
      if (opening) {
        positionPanel(panel);
        subPanel.classList.remove("open");
        hideTip(true, "gear-open");
      }
    });
    panel.addEventListener("keydown", function (e) { if (e.key === "Escape") panel.classList.remove("open"); });
    panel.addEventListener("change", function (e) {
      var t2 = e.target;
      if (t2.name === "zcm-lang") {
        state.lang = t2.value;
        persist();
        buildPanel();
        syncPanel();
        renderAll(true);
        return;
      }
      if (t2.type === "checkbox") {
        state.show[t2.dataset.k] = t2.checked ? 1 : 0;
        persist();
      } else if (t2.classList.contains("zcm-ctxov")) {
        state.ctxOv = t2.value.trim();
        persist();
      }
      renderAll(false);
    });
    document.addEventListener("mousedown", function (e) {
      if (panel.classList.contains("open") && !bar.contains(e.target)) panel.classList.remove("open");
      if (subPanel.classList.contains("open") && !bar.contains(e.target)) subPanel.classList.remove("open");
    });
    function positionPanel(p) {
      if (!p.classList.contains("open")) return;
      var br = bar.getBoundingClientRect();
      p.style.left = -bar.clientLeft + "px";
      p.style.width = br.width + "px";
    }

    /* ---------- 子代理明细面板 ---------- */
    var subPanelTab = 0;
    function buildSubPanel(sub) {
      var list = (sub && sub.list) || [];
      if (subPanelTab > list.length) subPanelTab = 0;
      subPanel.innerHTML = "";
      var head = document.createElement("div");
      head.className = "phead";
      head.textContent = L("子代理明细", "Sub-agent details");
      var ver = document.createElement("span");
      ver.className = "pver";
      ver.textContent = L("独立统计 · 不计入会话累计", "Tracked separately · not in session total");
      head.appendChild(ver);
      subPanel.appendChild(head);
      if (!sub || (!sub.total && !sub.active)) {
        var empty = document.createElement("div");
        empty.className = "pnote";
        empty.textContent = L("当前会话没有子代理记录", "No sub-agent records in the current session");
        subPanel.appendChild(empty);
        return;
      }
      var tabsRow = document.createElement("div");
      tabsRow.className = "ttabs";
      var labels = [L("汇总", "Summary")];
      list.forEach(function (s1) {
        var nm = String(s1.title || "").trim() || String(s1.agent || "sub").replace(/^zcode-/, "") + "…" + String(s1.sid).slice(-4);
        labels.push(nm.length > 12 ? nm.slice(0, 11) + "…" : nm);
      });
      labels.forEach(function (lb, i) {
        var tb = document.createElement("span");
        tb.className = "ttab" + (i === subPanelTab ? " on" : "");
        tb.setAttribute("data-i", String(i));
        tb.textContent = lb;
        tabsRow.appendChild(tb);
      });
      subPanel.appendChild(tabsRow);
      var body = document.createElement("div");
      body.className = "tbody";
      subPanel.appendChild(body);
      function fillRow(row, s1) {
        var nm = String(s1.title || "").trim() || String(s1.agent || "sub").replace(/^zcode-/, "") + " …" + String(s1.sid).slice(-4);
        var n = document.createElement("div");
        n.className = "subname";
        n.textContent = nm + L("（", " (") + String(s1.agent || "subagent").replace(/^zcode-/, "") + " …" + String(s1.sid).slice(-4) + L("）", ")");
        if (s1.active) {
          var live = document.createElement("span");
          live.className = "sublive";
          live.textContent = L("运行中", "running");
          n.appendChild(live);
        }
        var st = document.createElement("div");
        st.className = "substat";
        st.textContent = L("总消耗 ", "Total ") + fmt(s1.total) + L(" · ", " · ") + (s1.requests || 0) +
          L(" 次请求", " requests") + (s1.last ? L(" · 最后活动 ", " · last activity ") + fmtTime(s1.last) : "");
        var br = document.createElement("div");
        br.className = "substat dim";
        br.textContent = ioc(s1.input, s1.output, s1.cache_read, s1.reasoning, s1.cache_write);
        row.appendChild(n); row.appendChild(st); row.appendChild(br);
      }
      if (subPanelTab === 0) {
        var p1 = document.createElement("div");
        p1.className = "pnote";
        p1.textContent = ioc(sub.input, sub.output, sub.cache_read, sub.reasoning, sub.cache_write) +
          L("，共 ", ", ") + (sub.requests || 0) + L(" 次", " requests in total") +
          (sub.active ? L(" · 有子代理运行中", " · sub-agent running") : "");
        body.appendChild(p1);
      } else {
        var row = document.createElement("div");
        row.className = "subrow";
        fillRow(row, list[subPanelTab - 1]);
        body.appendChild(row);
      }
    }
    bar.addEventListener("click", function (e) {
      if (stale()) return;
      if (e.target && e.target.closest && e.target.closest(".zcm-sub")) {
        e.stopPropagation();
        toggleSubPanel();
      }
    });
    subPanel.addEventListener("click", function (e) {
      if (stale()) return;
      var b = e.target && e.target.closest ? e.target.closest(".ttab") : null;
      if (!b) return;
      subPanelTab = +b.getAttribute("data-i") || 0;
      buildSubPanel(lastSub);
    });
    function toggleSubPanel() {
      var opening = !subPanel.classList.contains("open");
      subPanel.classList.toggle("open", opening);
      if (opening) {
        panel.classList.remove("open");
        buildSubPanel(lastSub);
        positionSubPanel();
        hideTip(true, "sub-open");
      }
    }
    function positionSubPanel() {
      if (!subPanel.classList.contains("open")) return;
      var item = bar.querySelector(".zcm-sub");
      if (!item) return;
      var br = bar.getBoundingClientRect(), ir = item.getBoundingClientRect();
      var width = subPanel.offsetWidth;
      var left = ir.left + ir.width / 2 - width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      subPanel.style.left = Math.round(left - br.left - bar.clientLeft) + "px";
    }

    /* ---------- 输入框查找（穿透 open shadow / 同源 iframe，兜底路径） ---------- */
    var COMPOSER_SEL = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';
    var deepCache = { el: null, at: 0 };
    function visible(el) {
      var r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < innerHeight;
    }
    function deepFind() {
      if (deepCache.el && deepCache.el.isConnected && reallyVisible(deepCache.el)) return deepCache.el;
      if (Date.now() - deepCache.at < 1000) return null;
      deepCache.at = Date.now();
      var found = null;
      function scan(doc, depth) {
        if (found || !doc || depth > 8) return;
        try {
          doc.querySelectorAll(COMPOSER_SEL).forEach(function (el) {
            if (el.closest && el.closest('[role="dialog"]')) return;
            if (!found && visible(el) && el.getBoundingClientRect().top > innerHeight * 0.45) found = el;
            else if (found && el.getBoundingClientRect().top > found.getBoundingClientRect().top && visible(el)) found = el;
          });
        } catch (e) { }
        if (found) return;
        try {
          doc.querySelectorAll("*").forEach(function (el) {
            if (!found && el.shadowRoot) scan(el.shadowRoot, depth + 1);
          });
        } catch (e) { }
        try {
          doc.querySelectorAll("iframe").forEach(function (fr) {
            if (!found) { try { if (fr.contentDocument) scan(fr.contentDocument, depth + 1); } catch (e) { } }
          });
        } catch (e) { }
      }
      scan(document, 0);
      if (found) deepCache.el = found;
      return found;
    }
    function isOwnOverlay(el) {
      try { return !!(el && el.closest && el.closest(".zcm-tip-root,.panel,.zcm-root")); } catch (e) { return false; }
    }
    /* 幽灵子树检测：设置页等"保持挂载但视觉已隐藏"（opacity-0/inert）的祖先链 */
    function inGhostSubtree(el) {
      try {
        for (var p = el; p && p !== document.body; p = p.parentElement) {
          if (p.inert) return true;
          var cs = getComputedStyle(p);
          if (cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) return true;
        }
      } catch (e) { }
      return false;
    }
    /* 模态弹窗打开判定：Radix Dialog 的 body 直挂全屏遮罩打开时条整体收起 */
    function modalOpen() {
      try {
        if (!document.querySelector('[role="dialog"]')) return false;
        var kids = document.body.children;
        for (var i = 0; i < kids.length; i++) {
          var el = kids[i];
          var cls = String(el.getAttribute && el.getAttribute("class") || "");
          if (el.id === "zcm-bar" || /(^|\s)zcm-(root|tip-root)(\s|$)/.test(cls)) continue;
          var cs = getComputedStyle(el);
          if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
          if (parseFloat(cs.opacity || "1") < 0.05) continue;
          if (!(parseInt(cs.zIndex, 10) >= 10)) continue;
          var r = el.getBoundingClientRect();
          if (r.width < innerWidth * 0.9 || r.height < innerHeight * 0.9) continue;
          var bg = cs.backgroundColor;
          if (!bg || bg === "transparent" || bg === "rgba(0, 0, 0, 0)") continue;
          return true;
        }
      } catch (e) { }
      return false;
    }
    function reallyVisible(el, ownOK) {
      if (!visible(el)) return false;
      if (inGhostSubtree(el)) return false;
      var r = el.getBoundingClientRect();
      var hit;
      try { hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); } catch (e) { return true; }
      if (!hit) return false;
      if (hit === document.body || hit === document.documentElement) return true;
      if (hit === el || hit.contains(el) || el.contains(hit)) return true;
      /* 部分遮挡（未整体罩住）仍判可见：非模态浮层压住输入框中心时条不该消失 */
      var hr = hit.getBoundingClientRect();
      if (hr.left > r.left || hr.top > r.top || hr.right < r.right || hr.bottom < r.bottom) return true;
      if (ownOK && isOwnOverlay(hit)) return true;
      return false;
    }
    function findComposer() {
      var best = null;
      document.querySelectorAll("textarea").forEach(function (ta) {
        if (ta.closest && ta.closest('[role="dialog"]')) return;
        if (!reallyVisible(ta)) return;
        var r = ta.getBoundingClientRect();
        if (r.top < innerHeight * 0.45) return;
        if (!best || r.top > best.getBoundingClientRect().top) best = ta;
      });
      return best || deepFind();
    }

    /* 卡片下移让位：给视觉卡片加 margin-bottom 空出悬浮带。React 重渲染会重置内联样式，
     * track() 逐帧对比补回。 */
    var CARD_MARGIN = "24px";
    function ensureCardPad() {
      if (!cardCache) return;
      try {
        if (cardCache.dataset.zcmCardPad === undefined) cardCache.dataset.zcmCardPad = cardCache.style.marginBottom || "";
        if (cardCache.style.marginBottom !== CARD_MARGIN) cardCache.style.marginBottom = CARD_MARGIN;
      } catch (e) { }
    }
    function releasePads() {
      try {
        document.querySelectorAll("[data-zcm-card-pad]").forEach(function (el) {
          el.style.marginBottom = el.dataset.zcmCardPad || "";
          delete el.dataset.zcmCardPad;
        });
      } catch (e) { }
    }
    try { releasePads(); } catch (e) { }

    /* 从输入框向上找视觉卡片容器（有可见边框或背景的最近祖先） */
    function isVisualBox(el) {
      try {
        var cs = getComputedStyle(el);
        return cs.borderTopWidth !== "0px" || cs.backgroundColor !== "rgba(0, 0, 0, 0)";
      } catch (e) { return false; }
    }
    function cardOf(el) {
      var cr = el.getBoundingClientRect();
      var p = el.parentElement, last = el, i = 0;
      for (; p && p !== document.body && i < 8; p = p.parentElement, i++) {
        var r = p.getBoundingClientRect();
        if (r.height > cr.height * 8 + 80) break;
        if (isVisualBox(p)) return p;
        last = p;
      }
      return last;
    }

    /* ---------- 定位：重活低频（找输入框/找卡片），逐帧只做矩形跟随 ---------- */
    var composer = null, cardCache = null, hideSince = 0;
    var curDisplay = "none", lastPos = [-1, -1];

    function setComposer(el) {
      releasePads();
      composer = el;
      cardCache = null;
      if (composer) {
        var c = cardOf(composer);
        if (c && c !== document.body) cardCache = c;
      }
      if (cardCache) ensureCardPad();
    }
    function heavy() {
      if (stale()) return;
      if (pid === "auto") {
        var el = findComposer();
        if (el && el !== composer) setComposer(el);
        else if (!el && composer && !composer.isConnected) setComposer(null);
      } else {
        if (wantedEl && wantedEl.isConnected) {
          if (wantedEl !== composer) setComposer(wantedEl);
        } else if (composer) {
          setComposer(null);
        }
        if (pendingSid !== instSid) {
          instSid = pendingSid;
          if (state.data) render(state.data);
        }
      }
      if (composer) {
        if (!cardCache || !cardCache.isConnected) {
          var c = cardOf(composer);
          cardCache = c && c !== document.body ? c : null;
        }
        if (cardCache) ensureCardPad();
      }
      if (state.data && pid === "auto") {
        var msid = typeof state.data.mine === "string" ? state.data.mine : null;
        var pSid;
        if (msid !== null) pSid = msid;
        else {
          var rec = (state.data.recent || [])[0];
          pSid = rec ? rec.sid : "";
        }
        if (pSid !== pickedSid) render(state.data);
      }
    }
    function hideBar() {
      if (curDisplay !== "none") { bar.style.display = "none"; curDisplay = "none"; }
      hideTip(true, "bar-hidden");
    }
    function track() {
      if (stale()) return;
      try {
        if (!composer || !composer.isConnected) { hideSince = 0; hideBar(); return; }
        if (cardCache && cardCache.style.marginBottom !== CARD_MARGIN) ensureCardPad();
        var r = composer.getBoundingClientRect();
        var on = r.width > 60 && r.height > 14 && r.bottom > 0 && r.top < innerHeight &&
          !inGhostSubtree(composer) &&
          !modalOpen() &&
          (reallyVisible(composer, true));
        if (!on) {
          /* 迟滞：连续 400ms 判定不可见才隐藏，瞬时失败（流式装饰层等）不闪 */
          if (!hideSince) hideSince = Date.now();
          if (Date.now() - hideSince > 400) hideBar();
          return;
        }
        hideSince = 0;
        if (curDisplay !== "flex") { bar.style.display = "flex"; curDisplay = "flex"; }
        /* 悬浮在输入框视觉卡片正下方：水平与卡片左缘对齐，条底落进原生底部留白 */
        var anchor = cardCache || composer;
        var ar = anchor.getBoundingClientRect();
        var left = Math.round(ar.left);
        var top = Math.max(8, Math.min(Math.round(ar.bottom + 4), innerHeight - bar.offsetHeight - 2));
        if (left !== lastPos[0] || top !== lastPos[1]) {
          bar.style.left = left + "px"; bar.style.top = top + "px";
          lastPos = [left, top];
        }
        /* 宽度锁死卡片：内容超宽分级收缩（先藏命中率，仍装不下右缘渐隐），
         * 迟滞 +12px/-120px 防数值刷新在阈值附近来回闪 */
        var minW = Math.max(60, Math.round(ar.width));
        if (bar.style.minWidth !== minW + "px") bar.style.minWidth = minW + "px";
        if (bar.style.maxWidth !== minW + "px") bar.style.maxWidth = minW + "px";
        var ov = main.scrollWidth - main.clientWidth;
        var ns = shrink;
        if (!shrink && ov > 12) ns = 1;
        else if (shrink && ov < -120) ns = 0;
        if (ns !== shrink) { shrink = ns; render(state.data || { session: {}, last_turn: {}, today: {}, context_window: 0 }); }
        var clip = main.scrollWidth > main.clientWidth + 1;
        if (clip !== fadeOn) { fadeOn = clip; main.classList.toggle("zcm-clip", clip); }
        positionPanel(panel);
        positionSubPanel();
      } catch (e) {
        FATAL.trackErr = String((e && e.stack) || e);
      } finally {
        requestAnimationFrame(track);   // 自调度：异常绝不能杀死循环
      }
    }

    setInterval(heavy, 600);
    heavy();
    requestAnimationFrame(track);

    syncPanel();
    if (state.data) render(state.data);
    else render({ session: {}, last_turn: {}, today: {}, context_window: 0, not_local: [] });

    var api = {
      pid: pid, slot: slot,
      attach: function (el, sid) {
        wantedEl = el;
        pendingSid = sid || "";
        heavy();
      },
      render: render,
      rebuild: function () { buildPanel(); syncPanel(); },
      getSid: function () { return pickedSid || ""; },
    };
    instances.push(api);
    refreshWants();
    return api;
  }
})();
