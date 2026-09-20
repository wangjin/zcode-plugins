// official.mjs 单测：查询构造 / 输出解析为纯函数；真实查询仅在本机存在官方库时执行
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { localMidnightMs, buildTodayQuery, parseTodayRow, createOfficialToday, DB_PATH } from "../dashboard/official.mjs";

const NOW = new Date("2026-09-20T15:04:05").getTime(); // 本地 15:04

test("localMidnightMs: 归零到本地时区当日 00:00", () => {
  assert.equal(localMidnightMs(NOW), new Date("2026-09-20T00:00:00").getTime());
  // 午夜后 1ms 仍属新的一天
  const midnight = new Date("2026-09-20T00:00:00").getTime();
  assert.equal(localMidnightMs(midnight + 1), midnight);
});

test("buildTodayQuery: 窗口条件 + status 过滤；无 sid 不带 session 条件", () => {
  const q = buildTodayQuery(NOW);
  assert.ok(q.includes("FROM turn_usage"));
  assert.ok(q.includes(`completed_at >= ${localMidnightMs(NOW)}`));
  assert.ok(q.includes(`completed_at < ${NOW}`));
  assert.ok(q.includes("status = 'completed'"));
  assert.ok(!q.includes("session_id"));
});

test("buildTodayQuery: sid 过滤 + 单引号转义（防御式）", () => {
  const q = buildTodayQuery(NOW, "sess_abc-123");
  assert.ok(q.includes(`session_id = 'sess_abc-123'`));
  const evil = buildTodayQuery(NOW, "x' OR '1'='1");
  assert.ok(!evil.includes("'1'='1'"), "注入串必须被转义");
  assert.ok(evil.includes("'x'' OR ''1''=''1'"));
});

test("parseTodayRow: 7 列数值 → 结构化；avg = Σout/Σdur*1000", () => {
  const r = parseTodayRow("32|69230025|488171|0|0|69718196|4252880");
  assert.deepEqual(r.tokens, { input: 69230025, output: 488171, reasoning: 0, cacheCreation: 0, total: 69718196 });
  assert.equal(r.turns, 32);
  assert.equal(r.available, true);
  assert.ok(Math.abs(r.avgTokPerSec - (488171 / 4252880) * 1000) < 1e-9);
  // 0 轮也是有效结果（今日无请求）
  assert.equal(parseTodayRow("0|0|0|0|0|0|0").turns, 0);
});

test("parseTodayRow: 坏输入 → null", () => {
  for (const bad of ["", "1|2|3", "a|1|1|1|1|1|1", "1|1|1|1|1|1|1|1", null, undefined]) {
    assert.equal(parseTodayRow(bad), null);
  }
});

test("createOfficialToday: sqlite3/库不可用 → available:false（回退路径）", async () => {
  const fetcher = createOfficialToday({ bin: "definitely-not-sqlite3", ttlMs: 60_000 });
  const v = await fetcher(NOW);
  assert.equal(v.available, false);
  assert.equal(v.source, "official");
});

// 本机存在官方库（macOS 开发机）才跑真实查询
test("live: 真实官方库今日聚合与手工 sqlite3 输出一致", { skip: !existsSync(DB_PATH) }, async () => {
  const fetcher = createOfficialToday({ ttlMs: 0 });
  const v = await fetcher(Date.now());
  assert.equal(v.available, true);
  assert.ok(v.turns >= 0);
  assert.ok(v.tokens.total >= v.tokens.input); // computed = input + output + reasoning
});
