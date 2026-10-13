// Gen UI 速度卡单测：TIERS 与 index.html 单源一致、片段契约（无脚本/无 fetch/根 id/柱数/档色）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TIERS, tierOf, renderSpeedCard } from "../dashboard/uicard.mjs";

const html = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "index.html"),
  "utf8",
);

test("uicard TIERS 与 index.html 的 TIERS-SRC 标记块一致（单源防漂移）", () => {
  const block = html.match(/TIERS-SRC-START[\s\S]*?TIERS-SRC-END/);
  assert.ok(block, "index.html 缺 TIERS-SRC 标记块");
  const uiTiersMatch = block[0].match(/const TIERS = (\[[\s\S]*?\]);/);
  assert.ok(uiTiersMatch, "标记块内缺 TIERS 表");
  assert.deepEqual(TIERS, eval(uiTiersMatch[1])); // eslint-disable-line no-eval
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
  assert.ok(out.includes(TIERS[0].color), "34.2 tok/s 应落第 1 档绿");
  assert.equal((out.match(/<rect /g) || []).length, 24, "柱数封顶 24");
  assert.ok(out.includes("今日输出"), "有今日输出块");
});

test("closed 缺失时回退：生成中用 turn 口径，否则用 last；无数据显示等待文案", () => {
  const gen = renderSpeedCard({
    session: session({ generating: true, closed: null, turn: { startedAtMs: 0, elapsedMs: 8000, tokens: 260, requests: 2, avgTokPerSec: 32.5, sawStop: false } }),
    records: [rec(32.5)],
    today: null,
  });
  assert.ok(gen.includes("本回合进行中") && gen.includes(">32.5<") && gen.includes("生成中"));

  const lastOnly = renderSpeedCard({
    session: session({ closed: null, last: { tokPerSec: 210, outputTokens: 500, source: "rollout" } }),
    records: [rec(210)],
    today: null,
  });
  assert.ok(lastOnly.includes("最近一次响应") && lastOnly.includes(TIERS[3].color), "210 tok/s 落第 4 档橙");

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
