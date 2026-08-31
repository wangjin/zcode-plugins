// 状态机单测（多会话分桶）：node --test test/state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { newState, applyEvent, applyRecord, tick, snapshot } from "../dashboard/state.mjs";

const rec = (o = {}) => ({
  id: "r" + Math.random(), sessionId: "sess_1", turnId: "t1", role: "main",
  modelId: "glm", outputTokens: 100, inputTokens: 1000, durationMs: 2000,
  tokPerSec: 50, completedAtMs: Date.now(), source: "rollout", ...o,
});
const bucket = (s, sid) => s.sessions.get(sid);
const MIN = 60 * 1000;

test("newState：多会话结构 + 版本 0.3.0", () => {
  const s = newState();
  assert.ok(s.sessions instanceof Map);
  assert.equal(s.version, "0.3.0");
  assert.equal(s.turn, undefined);
  assert.deepEqual(s.history, []);
});

test("user_prompt_submit → 本会话 generating；快照 elapsed 递增", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 1000);
  assert.equal(bucket(s, "sess_1").turn.active, true);
  applyRecord(s, rec({ sessionId: "sess_1" }), 1500);
  const snap = snapshot(s, 3000);
  assert.equal(snap.generating, true); // 任一会话 active
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].turn.tokens, 100);
  assert.equal(snap.sessions[0].turn.requests, 1);
  // elapsed 从 T1=1000 到 now=3000 → 2000ms
  assert.equal(snap.sessions[0].turn.elapsedMs, 2000);
});

test("同一 turn 多次请求 → Σtokens 与平均速率", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 0);
  applyRecord(s, rec({ sessionId: "sess_1", completedAtMs: 2000, outputTokens: 100, durationMs: 2000, tokPerSec: 50 }), 2000);
  applyRecord(s, rec({ sessionId: "sess_1", completedAtMs: 4000, outputTokens: 200, durationMs: 2000, tokPerSec: 100, id: "r2" }), 4000);
  const a = bucket(s, "sess_1").turnAgg;
  assert.equal(a.totalOutputTokens, 300);
  assert.equal(a.requestCount, 2);
  // avg = 300 / (4000-0)/1000 = 75
  assert.equal(a.avgTokPerSec, 75);
});

test("未知 sid 记录 → 只进全局 history，不建桶、不并入本桶聚合（AC3/R2）", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "mine" }, 0);
  applyRecord(s, rec({ sessionId: "other" }), 1000);
  assert.equal(bucket(s, "mine").turnAgg.totalOutputTokens, 0);
  assert.equal(bucket(s, "mine").last, null);
  assert.equal(s.sessions.has("other"), false); // 记录不建桶
  assert.equal(s.history.length, 1);
});

test("stop → 关闭本会话 turn，closed 快照可见", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 0);
  applyRecord(s, rec({ sessionId: "sess_1", completedAtMs: 2000 }), 2000);
  applyEvent(s, { kind: "stop", sessionId: "sess_1" }, 5000);
  assert.equal(bucket(s, "sess_1").turn.active, false);
  const snap = snapshot(s, 6000);
  assert.equal(snap.generating, false);
  assert.equal(snap.sessions[0].closed.tokens, 100);
  assert.equal(snap.sessions[0].closed.requests, 1);
});

test("lite 记录不污染 main last（桶内 last / 全局 lastLite 分离）", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 0);
  applyRecord(s, rec({ sessionId: "sess_1", id: "m" }), 1000);
  applyRecord(s, rec({ sessionId: "sess_1", id: "l", role: "lite" }), 2000);
  assert.equal(bucket(s, "sess_1").last.id, "m");
  assert.equal(bucket(s, "sess_1").turnAgg.requestCount, 1); // lite 不计入 turn
  assert.equal(s.lastLite.id, "l");
  assert.equal(s.liteCount, 1);
});

test("无 rollout 记录但 Stop 带估算 → estimated closed", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 0);
  applyEvent(s, { kind: "stop", sessionId: "sess_1", estimatedOutputTokens: 50 }, 5000);
  assert.equal(bucket(s, "sess_1").closed.tokens, 50);
  assert.equal(bucket(s, "sess_1").closed.estimated, true);
});

test("session_start 桶内 60s 防抖；另一会话 startTurn 不动本桶（并行隔离基础）", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "sess_1" }, 0);
  // 同 session 且间隔 <60s 视为重复事件忽略（桶内判断）
  applyEvent(s, { kind: "session_start", sessionId: "sess_1" }, 10_000);
  assert.equal(bucket(s, "sess_1").turn.startedAtMs, 0);
  // 另一会话的新轮次：建新桶，A 桶原样保留
  applyEvent(s, { kind: "session_start", sessionId: "b" }, 120_000);
  assert.equal(bucket(s, "b").turn.startedAtMs, 120_000);
  assert.equal(bucket(s, "sess_1").turn.startedAtMs, 0);
  assert.equal(bucket(s, "sess_1").turn.active, true);
});

test("并行隔离：A/B 各自累计，互不清零（AC1）", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "A" }, 0);
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "B" }, 100);
  applyRecord(s, rec({ sessionId: "A", outputTokens: 100 }), 200);
  applyRecord(s, rec({ sessionId: "A", outputTokens: 150, id: "r2" }), 300);
  const A = bucket(s, "A"), B = bucket(s, "B");
  assert.equal(A.turnAgg.totalOutputTokens, 250);
  assert.equal(A.turnAgg.requestCount, 2);
  assert.equal(B.turnAgg.totalOutputTokens, 0); // B 不受 A 记录影响
  applyRecord(s, rec({ sessionId: "B", outputTokens: 500, id: "r3" }), 400);
  assert.equal(B.turnAgg.totalOutputTokens, 500);
  assert.equal(A.turnAgg.totalOutputTokens, 250); // A 不被 B 顶掉
  assert.equal(A.turn.active, true);
  assert.equal(B.turn.active, true);
  assert.equal(s.sessions.size, 2);
});

test("stop 路由：B 的 stop 不关 A；孤儿 stop 忽略（AC2）", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "A" }, 0);
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "B" }, 100);
  applyRecord(s, rec({ sessionId: "A", outputTokens: 120 }), 200);
  applyEvent(s, { kind: "stop", sessionId: "B" }, 500);      // B stop
  assert.equal(bucket(s, "A").turn.active, true);            // A 仍生成中
  assert.equal(bucket(s, "A").turnAgg.totalOutputTokens, 120);
  assert.equal(bucket(s, "B").turn.active, false);
  assert.ok(bucket(s, "B").closed);                          // B 正常收尾
  applyEvent(s, { kind: "stop", sessionId: "ghost" }, 600);  // 未知会话的孤儿 stop
  assert.equal(s.sessions.has("ghost"), false);              // 不建桶
  assert.equal(bucket(s, "A").turn.active, true);            // 也不刷新/干扰 A
  applyEvent(s, { kind: "stop", sessionId: "A" }, 700);
  assert.equal(bucket(s, "A").turn.active, false);
  assert.equal(bucket(s, "A").closed.tokens, 120);
});

test("无 sid 记录 → 宽松归属最近活跃桶；无任何会话时只进全局（AC3）", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "A" }, 0);
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "B" }, 100); // B 最近活跃
  applyRecord(s, rec({ sessionId: null, outputTokens: 70 }), 200);
  assert.equal(bucket(s, "B").turnAgg.totalOutputTokens, 70); // 归 B
  assert.equal(bucket(s, "A").turnAgg.totalOutputTokens, 0);
  // 无会话时：只进全局 history
  const s2 = newState();
  applyRecord(s2, rec({ sessionId: null, outputTokens: 70 }), 200);
  assert.equal(s2.history.length, 1);
  assert.equal(s2.sessions.size, 0);
});

test("僵尸轮：30min 无事件 tick 收尾；会话自收尾起再留 30min 后下线（AC4）", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "A" }, 0);
  tick(s, 31 * MIN); // T+31min：僵尸收尾
  const A = bucket(s, "A");
  assert.equal(A.turn.active, false);
  assert.ok(A.closed);
  assert.equal(A.turn.sawStop, false); // 收尾方式：tick 兜底而非 stop 事件
  assert.equal(A.lastEventMs, 31 * MIN); // 收尾刷新 lastEventMs
  tick(s, 45 * MIN); // 45-31=14min < 30min → 仍在列表（可回看收尾摘要）
  assert.ok(bucket(s, "A"));
  tick(s, 62 * MIN); // 62-31=31min > 30min → 下线
  assert.equal(s.sessions.has("A"), false);
});

test("idle 下线：仅淘汰超 30min 未活跃的会话；活跃会话保留（AC4）", () => {
  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "A" }, 0);
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "B" }, 0);
  applyEvent(s, { kind: "stop", sessionId: "B" }, 500);      // B 已收尾，此后纯 idle
  applyRecord(s, rec({ sessionId: "A", outputTokens: 10 }), 25 * MIN); // A 25min 前仍活跃
  tick(s, 31 * MIN); // B：31min 无事件 → 下线；A：僵尸轮先收尾（刷新 lastEventMs）→ 保留
  assert.equal(s.sessions.has("B"), false);
  assert.ok(s.sessions.has("A"));
  assert.equal(bucket(s, "A").turn.active, false); // A 的僵尸轮（turn 自身 31min 无事件）也被收尾
});

test("容量上限 5：第 6 个会话出现时挤掉最久未活跃（AC4）", () => {
  const s = newState();
  for (let i = 0; i < 5; i++) {
    applyEvent(s, { kind: "user_prompt_submit", sessionId: "s" + i }, i * 1000);
  }
  assert.equal(s.sessions.size, 5);
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "s5" }, 5000);
  assert.equal(s.sessions.size, 5);        // 不超上限
  assert.equal(s.sessions.has("s0"), false); // 最久未活跃者被挤掉
  assert.equal(s.sessions.has("s1"), true);
  assert.equal(s.sessions.has("s5"), true);  // 新桶本身保留
});

test("history 保留最近 20 条（全局不回退）", () => {
  const s = newState();
  for (let i = 0; i < 25; i++) applyRecord(s, rec({ id: "x" + i, completedAtMs: Date.now() }), Date.now());
  assert.equal(s.history.length, 20);
});

test("snapshot：sessions 排序/顶层旧字段移除/过滤聚合嵌入/store 缺省省略（AC7）", async () => {
  const { createStore } = await import("../dashboard/store.mjs");
  const store = createStore();
  const mk = (o) => rec({ modelId: "glm", inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 0, completedAtMs: Date.now(), ...o });
  store.add(mk({ id: "sa1", sessionId: "A", outputTokens: 100 }));
  store.add(mk({ id: "sa2", sessionId: "A", outputTokens: 100 }));
  store.add(mk({ id: "sb1", sessionId: "B", outputTokens: 100 }));
  store.add(mk({ id: "sn1", sessionId: null, outputTokens: 100 }));

  const s = newState();
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "A" }, 1000);
  applyRecord(s, rec({ sessionId: "A", outputTokens: 100 }), 1500);
  applyEvent(s, { kind: "user_prompt_submit", sessionId: "B" }, 2000);

  const snap = snapshot(s, 3000, store);
  // 顶层契约：旧字段移除，generating 保留
  assert.equal(snap.generating, true);
  for (const gone of ["turn", "closed", "last", "sessionId", "stale"]) {
    assert.equal(snap[gone], undefined, `顶层不应再有 ${gone}`);
  }
  // sessions 按 lastEventMs 降序：B(2000) → A(1500)
  assert.deepEqual(snap.sessions.map((x) => x.sessionId), ["B", "A"]);
  const B = snap.sessions[0], A = snap.sessions[1];
  assert.equal(A.turn.tokens, 100);
  assert.equal(A.generating, true);
  assert.equal(B.generating, true);
  // 每会话过滤聚合：A 只含 sa1/sa2，B 只含 sb1
  assert.equal(A.models[0].n, 2);
  assert.equal(A.cache.sumInput, 2000);
  assert.equal(B.models[0].n, 1);
  assert.ok(Array.isArray(A.trend.hour) && A.trend.hour.length === 48);
  // 全局块（"全部"口径）：4 条全算（含无 sid）
  assert.equal(snap.models[0].n, 4);
  assert.equal(snap.store.count, 4);
  assert.ok(Array.isArray(snap.trend.hour));

  // store 缺省：会话项与顶层聚合字段均省略（兼容单测调用形态）
  const plain = snapshot(s, 3000);
  assert.equal(plain.store, undefined);
  assert.equal(plain.trend, undefined);
  assert.equal(plain.sessions[0].trend, undefined);
  assert.equal(plain.sessions[0].models, undefined);
});
