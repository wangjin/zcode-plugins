// zcode-metrics · Gen UI 速度卡渲染器（纯函数，无 IO，可单测）
// 产物是 ZCode 会话内联 HTML 片段（::visualize 引用渲染）：无 fetch/XHR/WebSocket（沙箱 CSP 禁止），
// 数据全部内联；不用任何脚本（静态快照卡，规避脚本运行时差异）；配色复用 index.html 的六档语义。
// 注意：TIERS 与 index.html 的 TIERS-SRC 标记块必须保持一致（test/uicard.test.mjs 双向校验）。

export const TIERS = [
  { min: 0, color: "#4E9C78" }, // 0–40    绿
  { min: 40, color: "#A9C548" }, // 40–80   黄绿
  { min: 80, color: "#E5C558" }, // 80–160  黄
  { min: 160, color: "#F2A64B" }, // 160–240 橙
  { min: 240, color: "#E06C5F" }, // 240–320 红
  { min: 320, color: "#E05FB0" }, // 320+    品红
];

export function tierOf(v) {
  let i = 0;
  for (let k = 0; k < TIERS.length; k++) if (Number(v) >= TIERS[k].min) i = k;
  return { i, color: TIERS[i].color };
}

const fmt1 = (n) => (Number.isFinite(n) ? (n >= 100 ? Math.round(n) : n.toFixed(1)) : "—");
const wan = (n) =>
  !Number.isFinite(n) ? "—" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SPARK_MAX = 24; // 柱数上限（近 24 次模型响应）

/** 近 SPARK_MAX 条 main 记录 → 柱状 sparkline SVG（旧→新，右端为最新）。
 *  每柱 fill 用该次速度的档色；悬停 title 给出明细。records 为升序。 */
function sparkline(records) {
  const rs = records.filter((r) => r.role === "main").slice(-SPARK_MAX);
  if (!rs.length) return "";
  const W = 240, H = 44, GAP = 2, BONUS = 4; // BONUS = 最新一柱右侧留白
  const bw = (W - BONUS - GAP * (rs.length - 1)) / rs.length;
  const max = Math.max(...rs.map((r) => r.tokPerSec), 1);
  let bars = "";
  rs.forEach((r, i) => {
    const h = Math.max(2, (r.tokPerSec / max) * (H - 2));
    const x = i * (bw + GAP);
    const newest = i === rs.length - 1;
    bars += `<rect x="${x.toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${tierOf(r.tokPerSec).color}" opacity="${newest ? 1 : 0.75}"><title>${esc(fmt1(r.tokPerSec) + " tok/s · " + wan(r.outputTokens) + " tok · " + (r.modelId || "?"))}</title></rect>`;
  });
  const lo = Math.min(...rs.map((r) => r.tokPerSec));
  const hi = Math.max(...rs.map((r) => r.tokPerSec));
  return `<svg class="tsd-sc-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="本会话最近 ${rs.length} 次模型响应速度柱状图，范围 ${fmt1(lo)} 至 ${fmt1(hi)} tok/s">${bars}</svg>`;
}

/** 大数字区块的主速度与口径说明。
 *  优先级：closed（上一回合合计）> turn 进行中平均 > last（最近一次响应）。 */
function hero(session) {
  if (session.closed && Number.isFinite(session.closed.avgTokPerSec)) {
    const c = session.closed;
    return {
      v: c.avgTokPerSec,
      note: `上一回合 · ${c.durationSec < 60 ? c.durationSec.toFixed(1) + "s" : (c.durationSec / 60).toFixed(1) + "min"} · ${wan(c.tokens)} tok · ${c.requests} 次响应${c.estimated ? " · 估" : ""}`,
    };
  }
  if (session.generating && Number.isFinite(session.turn.avgTokPerSec)) {
    const elapsed = session.turn.elapsedMs / 1000;
    return {
      v: session.turn.avgTokPerSec,
      note: `本回合进行中 · ${elapsed < 60 ? elapsed.toFixed(1) + "s" : (elapsed / 60).toFixed(1) + "min"} · ${wan(session.turn.tokens)} tok · ${session.turn.requests} 次响应`,
    };
  }
  if (session.last && Number.isFinite(session.last.tokPerSec)) {
    const l = session.last;
    return { v: l.tokPerSec, note: `最近一次响应 · ${wan(l.outputTokens)} tok${l.source === "estimate" ? " · 估" : ""}` };
  }
  return { v: null, note: "等待本会话第一条模型响应" };
}

/**
 * 渲染速度卡 HTML 片段。
 * @param opts.session  state.mjs sessionView() 形状的会话视图
 * @param opts.records  本会话记录（升序，含 role 字段；卡片自滤 main）
 * @param opts.today    store.today(now, sid) 形状（{tokens:{output,...}, calls:{main,lite}}）；可空
 */
export function renderSpeedCard({ session, records = [], today = null }) {
  if (!session || !session.sessionId) return "";
  const h = hero(session);
  const spark = sparkline(records);
  const mains = records.filter((r) => r.role === "main");
  const last24 = mains.slice(-SPARK_MAX);
  const tier = tierOf(h.v ?? 0);
  const todayOut = today && Number.isFinite(today.tokens?.output) ? wan(today.tokens.output) : null;
  const scope = last24.length
    ? `近 ${last24.length} 次响应 ${fmt1(Math.min(...last24.map((r) => r.tokPerSec)))}–${fmt1(Math.max(...last24.map((r) => r.tokPerSec)))} tok/s`
    : "暂无响应记录";
  return `<div id="tsd-speed-card">
  <style>
#tsd-speed-card{font:inherit;color:var(--foreground,inherit);max-width:560px}
#tsd-speed-card .tsd-sc-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
#tsd-speed-card .tsd-sc-title{font-size:12px;color:var(--muted-foreground,inherit)}
#tsd-speed-card .tsd-sc-live{font-size:11px;color:${tier.color};display:flex;align-items:center;gap:4px}
#tsd-speed-card .tsd-sc-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
#tsd-speed-card .tsd-sc-main{display:flex;align-items:baseline;gap:6px;margin:2px 0 6px}
#tsd-speed-card .tsd-sc-num{font-size:28px;font-weight:500;font-variant-numeric:tabular-nums;line-height:1.1;color:${tier.color}}
#tsd-speed-card .tsd-sc-unit{font-size:12px;color:var(--muted-foreground,inherit)}
#tsd-speed-card .tsd-sc-note{font-size:11px;color:var(--muted-foreground,inherit);margin-left:auto;text-align:right}
#tsd-speed-card .tsd-sc-spark{display:block;width:100%;height:44px}
#tsd-speed-card .tsd-sc-foot{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--muted-foreground,inherit);margin-top:4px}
  </style>
  <div class="tsd-sc-head">
    <span class="tsd-sc-title">Token 速度 · 本会话</span>
    ${session.generating ? '<span class="tsd-sc-live"><span class="tsd-sc-dot"></span>生成中</span>' : ""}
  </div>
  <div class="tsd-sc-main">
    <b class="tsd-sc-num">${fmt1(h.v)}</b><span class="tsd-sc-unit">tok/s</span>
    <span class="tsd-sc-note">${esc(h.note)}</span>
  </div>
  ${spark}
  <div class="tsd-sc-foot">
    <span>${esc(scope)}</span>
    ${todayOut != null ? `<span>今日输出 ${todayOut} tok · ${today.calls?.main ?? 0} 次响应</span>` : ""}
  </div>
</div>`;
}
