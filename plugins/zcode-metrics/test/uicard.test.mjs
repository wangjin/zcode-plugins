// Gen UI 速度卡单测：TIERS 与 badge.swift 跨语言一致、片段契约（无脚本/无 fetch/根 id/柱数/档色）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TIERS, tierOf, renderSpeedCard } from "../dashboard/uicard.mjs";

const swift = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "badge", "badge.swift"),
  "utf8",
);

test("TIERS 与 badge.swift 的档色表一致（JS/Swift 双端单源，防漂移）", () => {
  const m = swift.match(/let tiers: \[\(min: Double, color: NSColor\)\] = \[([\s\S]*?)\]/);
  assert.ok(m, "badge.swift 缺 tiers 表");
  const pairs = [...m[1].matchAll(/\((\d+),\s*NSColor\(hex: 0x([0-9A-Fa-f]{6})\)\)/g)];
  assert.equal(pairs.length, TIERS.length, "badge.swift 与 uicard.mjs 档数一致");
  pairs.forEach((p, i) => {
    assert.equal(Number(p[1]), TIERS[i].min, `第 ${i} 档 min 一致`);
    assert.equal("#" + p[2].toUpperCase(), TIERS[i].color.toUpperCase(), `第 ${i} 档色值一致`);
  });
});

test("tierOf 档位边界（含下界不含上界）", () => {
  assert.equal(tierOf(0).color, TIERS[0].color);
  assert.equal(tierOf(39.9).i, 0);
  assert.equal(tierOf(40).i, 1);
  assert.equal(tierOf(320).i, 5);
  assert.equal(tierOf(-5).i, 0); // 非法值落第 1 档
});

const session = (over = {}) => ({
  sessionId: "sess_x",
  generating: false,
  turn: { startedAtMs: 0, elapsedMs: 0, tokens: 0, requests: 0, avgTokPerSec: null, sawStop: true },
  closed: { tokens: 424, requests: 3, durationSec: 12.4, avgTokPerSec: 34.2, estimated: false },
  last: null,
  ...over,
});
const rec = (tokPerSec, over = {}) => ({
  tokPerSec, outputTokens: 100, durationMs: 3000, modelId: "glm-x", role: "main", source: "rollout", completedAtMs: 0, ...over,
});

test("renderSpeedCard 片段契约：根 id / 无脚本 / 无网络调用 / 非整页文档", () => {
  const out = renderSpeedCard({ session: session(), records: [rec(30), rec(50)], today: null });
  assert.ok(out.includes('id="tsd-speed-card"'));
  assert.ok(!out.includes("<script"), "不得包含脚本（静态快照）");
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(out), "不得出现网络调用");
  assert.ok(!/<(!doctype|html|head|body)/i.test(out), "必须是片段而非整页文档");
  assert.ok(out.includes("Token 速度"), "缺标题");
});

test("大数字走 closed（上一回合）口径并按档色着色；柱数 = main 记录数（lite 过滤、封顶 24）", () => {
  const records = [
    rec(30, { role: "lite" }), // lite 过滤出柱图
    ...Array.from({ length: 30 }, (_, i) => rec(10 + i * 5)),
  ];
  const out = renderSpeedCard({
    session: session({ closed: { tokens: 424, requests: 3, durationSec: 12.4, avgTokPerSec: 34.2, estimated: false } }),
    records,
    today: { tokens: { output: 18200 }, calls: { main: 31, lite: 1 } },
  });
  assert.ok(out.includes("上一回合"), "closed 存在时用上一回合口径");
  assert.ok(out.includes(">34.2<"), "大数字为 closed.avgTokPerSec");
  assert.ok(out.includes(TIERS[0].color), "34.2 tok/s 应落第 1 档（深砖红）");
  assert.equal((out.match(/<rect /g) || []).length, 24, "柱数封顶 24");
  assert.ok(out.includes("今日输出"), "有今日输出块");
});

test("柱顶速度值标注：≤10 柱全标，>10 柱只标最新 + 最高；标签是 HTML 覆盖层不在 SVG 内", () => {
  const few = renderSpeedCard({ session: session(), records: [rec(30), rec(55.5), rec(48)], today: null });
  const fewLabels = [...few.matchAll(/class="tsd-sc-bl[^"]*"/g)];
  assert.equal(fewLabels.length, 3, "3 柱应全标");
  assert.ok(few.includes(">55.5</span>") && few.includes(">48.0</span>"), "标签内容为该柱速度值");
  assert.ok(!/<text/.test(few), "数值不用 SVG text（横向拉伸会变形）");

  const records = Array.from({ length: 20 }, (_, i) => rec(20 + i * 10)); // 升序：最高 = 最新
  const many = renderSpeedCard({ session: session(), records, today: null });
  const manyLabels = [...many.matchAll(/class="tsd-sc-bl[^"]*"/g)];
  assert.equal(manyLabels.length, 1, "最高柱即最新柱时只标 1 个，不重复");
  assert.ok(many.includes("tsd-sc-bl-new"), "最新柱标签右对齐防溢出");

  const vShape = [rec(90), ...Array.from({ length: 15 }, () => rec(30)), rec(40)]; // 最高在第 0 柱
  const vOut = renderSpeedCard({ session: session(), records: vShape, today: null });
  assert.equal((vOut.match(/class="tsd-sc-bl/g) || []).length, 2, "最高柱与最新柱分开时标 2 个");
  assert.ok(vOut.includes(">90.0</span>") && vOut.includes(">40.0</span>"));
});

test("closed 缺失时回退：生成中用 turn 口径，否则用 last；无数据显示等待文案", () => {
  const gen = renderSpeedCard({
    session: session({ generating: true, closed: null, turn: { startedAtMs: 0, elapsedMs: 8000, tokens: 260, requests: 2, avgTokPerSec: 32.5, sawStop: false } }),
    records: [rec(32.5)],
    today: null,
  });
  assert.ok(gen.includes("本回合平均") && gen.includes(">32.5<") && gen.includes("生成中"));

  const lastOnly = renderSpeedCard({
    session: session({ closed: null, last: { tokPerSec: 210, outputTokens: 500, source: "rollout" } }),
    records: [rec(210)],
    today: null,
  });
  assert.ok(lastOnly.includes("最近一次响应") && lastOnly.includes(TIERS[3].color), "210 tok/s 落第 4 档");

  const empty = renderSpeedCard({ session: session({ closed: null, last: null }), records: [], today: null });
  assert.ok(empty.includes("等待本会话第一条模型响应"));
});

test("转义与估算标注：modelId 含 HTML 特殊字符不逃逸；estimated 显示“估”", () => {
  const out = renderSpeedCard({
    session: session({ closed: { tokens: 10, requests: 1, durationSec: 2, avgTokPerSec: 5, estimated: true } }),
    records: [rec(5, { modelId: 'a"<b>' })],
    today: null,
  });
  assert.ok(out.includes("&lt;b&gt;"), "modelId 需转义");
  assert.ok(out.includes("上一回合") && /· 估/.test(out), "估算回合带“估”标注");
});
