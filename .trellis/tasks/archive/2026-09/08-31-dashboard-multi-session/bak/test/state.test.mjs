// 状态机单测：node --test test/state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { newState, applyEvent, applyRecord, tick, snapshot } from "../dashboard/state.mjs";

const rec = (o = {}) => ({
  id: "r" + Math.random(), sessionId: "sess_1", turnId: "t1", role: "main",
  modelId: "glm", outputTokens: 100, inputTokens: 1000, durationMs: 2000,
  tokPerSec: 50, completedAtMs: Date.now(), source: "rollout", ...o,
});

test("user_prompt_submit → generating；快照 elapsed 递增", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 1000);
  assert.equal(s.turn.active, true);
  applyRecord(s, rec(), 1500);
  const snap = snapshot(s, 3000);
  assert.equal(snap.generating, true);
  assert.equal(snap.turn.tokens, 100);
  assert.equal(snap.turn.requests, 1);
  // elapsed 从 T1=1000 到 now=3000 → 2000ms
  assert.equal(snap.turn.elapsedMs, 2000);
});

test("同一 turn 多次请求 → Σtokens 与平均速率", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 0);
  applyRecord(s, rec({ completedAtMs: 2000, outputTokens: 100, durationMs: 2000, tokPerSec: 50 }), 2000);
  applyRecord(s, rec({ completedAtMs: 4000, outputTokens: 200, durationMs: 2000, tokPerSec: 100, id: "r2" }), 4000);
  const snap = snapshot(s, 5000);
  assert.equal(snap.turn.tokens, 300);
  assert.equal(snap.turn.requests, 2);
  // avg = 300 / (4000-0)/1000 = 75
  assert.equal(snap.turn.avgTokPerSec, 75);
});

test("sessionId 不匹配 → 计入 last/history 但不并入 turn 聚合", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "mine" }, 0);
  applyRecord(s, rec({ sessionId: "other" }), 1000);
  assert.equal(s.turnAgg.totalOutputTokens, 0);
  assert.equal(s.last.sessionId, "other");
  assert.equal(s.history.length, 1);
});

test("stop → 关闭 turn，closed 快照可见", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 0);
  applyRecord(s, rec({ completedAtMs: 2000 }), 2000);
  applyEvent(s, { kind: "stop", sessionId: "sess_1" }, 5000);
  assert.equal(s.turn.active, false);
  const snap = snapshot(s, 6000);
  assert.equal(snap.generating, false);
  assert.equal(snap.closed.tokens, 100);
  assert.equal(snap.closed.requests, 1);
});

test("lite 记录不污染 main last", () => {
  const s = newState();
  applyRecord(s, rec({ id: "m" }), 1000);
  applyRecord(s, rec({ id: "l", role: "lite" }), 2000);
  assert.equal(s.last.id, "m");
  assert.equal(s.lastLite.id, "l");
  assert.equal(s.liteCount, 1);
});

test("无 rollout 记录但 Stop 带估算 → estimated closed", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 0);
  applyEvent(s, { kind: "stop", sessionId: "sess_1", estimatedOutputTokens: 50 }, 5000);
  assert.equal(s.closed.tokens, 50);
  assert.equal(s.closed.estimated, true);
});

test("僵尸 turn：无事件超 30min → tick 自动收尾", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 0);
  tick(s, 31 * 60 * 1000);
  assert.equal(s.turn.active, false);
});

test("stop 丢失后新 session_start → 重新开 turn", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 0);
  // 同 session 且间隔 <60s 视为重复事件忽略
  applyEvent(s, { kind: "session_start", sessionId: "sess_1" }, 10_000);
  assert.equal(s.turn.startedAtMs, 0);
  // 新一轮（>60s 或不同 session）重置 T₁
  applyEvent(s, { kind: "session_start", sessionId: "b" }, 120_000);
  assert.equal(s.turn.startedAtMs, 120_000);
  assert.equal(s.turn.sessionId, "b");
});

test("history 保留最近 20 条", () => {
  const s = newState();
  for (let i = 0; i < 25; i++) applyRecord(s, rec({ id: "x" + i, completedAtMs: Date.now() }), Date.now());
  assert.equal(s.history.length, 20);
});

test("snapshot 带 store：透传 trend/models/cache/store 四块；不带时省略（兼容）", async () => {
  const { createStore } = await import("../dashboard/store.mjs");
  const s = newState();
  const store = createStore();
  store.add(rec({ id: "st1", modelId: "glm", outputTokens: 100, durationMs: 1000 }));
  const withStore = snapshot(s, Date.now(), store);
  assert.ok(Array.isArray(withStore.trend.hour) && withStore.trend.hour.length === 48);
  assert.equal(withStore.models[0].modelId, "glm");
  assert.equal(withStore.store.count, 1);
  assert.equal(typeof withStore.cache.hit, "number");
  // 不带 store 的旧调用形态：无新字段，不报错
  const plain = snapshot(s, Date.now());
  assert.equal(plain.trend, undefined);
  assert.equal(plain.store, undefined);
});
