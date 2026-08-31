// store 单测：node --test test/store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, encodeRow, decodeRow, WINDOW_MS } from "../dashboard/store.mjs";

const H = 3600 * 1000;
const NOW = new Date("2026-08-31T12:30:00").getTime(); // 本地 12:30，整点/日边界干净

const rec = (o = {}) => ({
  id: "r" + Math.random().toString(36).slice(2),
  sessionId: "s1", turnId: "t1", role: "main", modelId: "glm",
  outputTokens: 100, inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 0,
  durationMs: 2000, tokPerSec: 50, completedAtMs: NOW, source: "rollout", ...o,
});

test("add: 去重 + 非法拒绝", () => {
  const s = createStore();
  const r = rec({ id: "dup" });
  assert.equal(s.add(r), true);
  assert.equal(s.add(rec({ id: "dup" })), false);   // 同 id 拒绝
  assert.equal(s.add(null), false);
  assert.equal(s.add({ id: 1, completedAtMs: NaN }), false);
  assert.equal(s.size(), 1);
});

test("loadRecords 部分重复不翻倍", () => {
  const s = createStore();
  const list = [rec({ id: "a" }), rec({ id: "b" }), rec({ id: "a" })];
  assert.equal(s.loadRecords(list), 2);
  assert.equal(s.size(), 2);
});

test("prune: 丢超窗记录且聚合重建", () => {
  const s = createStore();
  s.add(rec({ id: "old", completedAtMs: NOW - WINDOW_MS - H, outputTokens: 500, durationMs: 5000 }));
  s.add(rec({ id: "new", outputTokens: 100, durationMs: 2000 }));
  assert.equal(s.size(), 2);
  assert.equal(s.prune(NOW), 1);
  assert.equal(s.size(), 1);
  const m = s.models()[0];
  assert.equal(m.n, 1);
  assert.equal(m.sumOut, 100); // 旧记录的 500 已从聚合中消失
});

test("trend: 小时桶边界 + 吞吐加权 + main/lite 分列 + 空桶 null", () => {
  const s = createStore();
  // 12:00 当小时：main 两条 sumOut=300 sumDur=6000 → avg=50；lite 一条
  s.add(rec({ id: "a", completedAtMs: NOW - 60_000, outputTokens: 200, durationMs: 4000 }));
  s.add(rec({ id: "b", completedAtMs: NOW - 30_000, outputTokens: 100, durationMs: 2000 }));
  s.add(rec({ id: "c", completedAtMs: NOW - 20_000, role: "lite", outputTokens: 40, durationMs: 1000 }));
  // 前一小时桶
  s.add(rec({ id: "d", completedAtMs: NOW - H + 1000, outputTokens: 90, durationMs: 900 }));
  const t = s.trend(NOW);
  assert.equal(t.hour.length, 48);
  const cur = t.hour[47];
  assert.equal(cur.b, NOW - 30 * 60_000); // 12:30 → 12:00 整点桶
  assert.deepEqual(cur.main, { n: 2, sumOut: 300, avg: 50 });       // 300/6000*1000
  assert.deepEqual(cur.lite, { n: 1, sumOut: 40, avg: 40 });
  assert.deepEqual(t.hour[46].main, { n: 1, sumOut: 90, avg: 100 });
  assert.equal(t.hour[0].main, null); // 空桶
  assert.equal(t.day.length, 7);
  // 当日 main 桶含 d（11:00 也在今天）：200+100+90=390 / (4000+2000+900)
  assert.deepEqual(t.day[6].main, { n: 3, sumOut: 390, avg: 390 / 6900 * 1000 });
  assert.deepEqual(t.day[6].lite, { n: 1, sumOut: 40, avg: 40 });
});

test("models: 聚合、n 降序、cacheHit 排除 estimate", () => {
  const s = createStore();
  s.add(rec({ id: "1", modelId: "a", outputTokens: 100, durationMs: 1000, inputTokens: 1000, cacheReadTokens: 500 }));
  s.add(rec({ id: "2", modelId: "a", outputTokens: 50, durationMs: 500, inputTokens: 1000, cacheReadTokens: 0 }));
  s.add(rec({ id: "3", modelId: "b", outputTokens: 10, durationMs: 100, inputTokens: null, cacheReadTokens: null }));
  // estimate 记录：无 usage，不得进入缓存分母
  s.add(rec({ id: "4", modelId: "b", source: "estimate", inputTokens: null, cacheReadTokens: null, outputTokens: 20, durationMs: 200 }));
  const m = s.models();
  assert.deepEqual(m.map(x => x.modelId), ["a", "b"]); // n 降序（a:2, b:2 → tie 按名称）
  const ma = m[0];
  assert.equal(ma.n, 2);
  assert.equal(ma.avg, 150 / 1500 * 1000);
  assert.equal(ma.cacheHit, 500 / 2000);
  const mb = m[1];
  assert.equal(mb.n, 2);
  assert.equal(mb.cacheHit, null); // 纯 estimate 模型无缓存数据
});

test("p95 单调且不超过观测最大值", () => {
  const s = createStore();
  for (let i = 1; i <= 20; i++) s.add(rec({ id: "p" + i, tokPerSec: i * 10, outputTokens: 10, durationMs: 1 }));
  const m = s.models()[0];
  assert.ok(m.p95 >= 190 - 5 && m.p95 <= 200, `p95=${m.p95}`);
});

test("cache: 全局聚合排除 estimate", () => {
  const s = createStore();
  s.add(rec({ id: "1", inputTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 40 }));
  s.add(rec({ id: "2", source: "estimate", inputTokens: null, cacheReadTokens: null }));
  const c = s.cache();
  assert.equal(c.sumInput, 1000);
  assert.equal(c.hit, 0.6);
  assert.equal(c.sumCacheWrite, 40);
});

test("view(): 结构完整 + store 元信息", () => {
  const s = createStore();
  s.setBackfilling(true);
  s.add(rec({ id: "v1" }));
  const v = s.view(NOW);
  assert.equal(v.store.count, 1);
  assert.equal(v.store.backfilling, true);
  assert.ok(Array.isArray(v.trend.hour) && v.trend.hour.length === 48);
  assert.ok(Array.isArray(v.trend.day) && v.trend.day.length === 7);
  assert.equal(v.models.length, 1);
  assert.equal(v.store.since, NOW);
});

test("encodeRow/decodeRow 往返 + 坏行容错 + 隐私字段不落盘", () => {
  const r = rec({ id: "e1", role: "lite", source: "estimate", inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, tokPerSec: 33.333 });
  const line = encodeRow(r);
  // 隐私红线：任何内容字段名不得出现（AC9）
  for (const bad of ["prompt", "messages", "metadata", "text", "session", "turn"]) {
    assert.ok(!line.toLowerCase().includes(`"${bad}"`), `line contains ${bad}`);
  }
  const d = decodeRow(line);
  assert.equal(d.id, "e1");
  assert.equal(d.role, "lite");
  assert.equal(d.source, "estimate");
  assert.equal(d.inputTokens, null);
  assert.equal(d.tokPerSec, 33.33);
  assert.equal(decodeRow("{坏 json"), null);
  assert.equal(decodeRow(JSON.stringify({ id: "x" })), null);          // 缺 t
  assert.equal(decodeRow(JSON.stringify({ id: "x", t: 1, ot: 0, d: 1 })), null); // ot<=0
});

test("prune 后 since 重算", () => {
  const s = createStore();
  s.add(rec({ id: "1", completedAtMs: NOW - WINDOW_MS - 60_000 }));
  s.add(rec({ id: "2", completedAtMs: NOW - H }));
  s.prune(NOW);
  const v = s.view(NOW);
  assert.equal(v.store.count, 1);
  assert.equal(v.store.since, NOW - H);
});
