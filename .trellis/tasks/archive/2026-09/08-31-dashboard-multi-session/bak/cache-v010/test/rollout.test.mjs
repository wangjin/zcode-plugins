// rollout parser + RolloutTail 单测：node --test test/rollout.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRolloutLine, RolloutTail } from "../dashboard/rollout.mjs";

const base = (o = {}) => ({
  type: "model_io",
  sessionId: "sess_1",
  turnId: "turn_1",
  model: { role: "main", modelId: "glm-5.3" },
  startedAt: "2026-08-31T08:00:00.000Z",
  completedAt: "2026-08-31T08:00:02.000Z",
  durationMs: 2000,
  requestId: "req_1",
  response: { usage: { outputTokens: 100, inputTokens: 5000 }, text: "hello" },
  ...o,
});

test("parseRolloutLine: 正常行 → tok/s = 100/2 = 50", () => {
  const r = parseRolloutLine(JSON.stringify(base()));
  assert.ok(r);
  assert.equal(r.outputTokens, 100);
  assert.equal(r.tokPerSec, 50);
  assert.equal(r.role, "main");
  assert.equal(r.source, "rollout");
});

test("lite role 保留", () => {
  const r = parseRolloutLine(JSON.stringify(base({ model: { role: "lite", modelId: "x" } })));
  assert.equal(r.role, "lite");
});

test("缺 usage → 用 text 长度/4 估算并标 estimate", () => {
  const b = base(); delete b.response.usage; b.response.text = "a".repeat(80); // 80/4=20
  const r = parseRolloutLine(JSON.stringify(b));
  assert.equal(r.outputTokens, 20);
  assert.equal(r.source, "estimate");
});

test("非法/空/缺 duration 行 → null", () => {
  assert.equal(parseRolloutLine(""), null);
  assert.equal(parseRolloutLine("{坏 json"), null);
  const b0 = base(); b0.durationMs = 0;
  assert.equal(parseRolloutLine(JSON.stringify(b0)), null);
  const bn = base(); delete bn.response.usage; bn.response.text = "";
  assert.equal(parseRolloutLine(JSON.stringify(bn)), null); // 0 token 丢弃
});

test("非 model_io type → null", () => {
  assert.equal(parseRolloutLine(JSON.stringify(base({ type: "other" }))), null);
});

test("RolloutTail: 增量读取、半行回退、rotate、去重", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tsd-"));
  const file = path.join(dir, "model-io-sess_x.jsonl");
  // 先建一个已有内容的文件
  await writeFile(file, JSON.stringify(base({ requestId: "old" })) + "\n");

  const tail = new RolloutTail(dir, { skipOlderThan: 0 });
  // 首 poll 只定位 EOF，不回放历史
  assert.equal((await tail.poll()).length, 0);

  // 追加半行
  await appendFile(file, JSON.stringify(base({ requestId: "r2" })).slice(0, 20));
  assert.equal((await tail.poll()).length, 0); // 半行不产出

  // 补全该行 + 再加一行
  await appendFile(file, JSON.stringify(base({ requestId: "r2" })).slice(20) + "\n" + JSON.stringify(base({ requestId: "r3" })) + "\n");
  const recs = await tail.poll();
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map(r => r.id), ["r2", "r3"]);

  // 去重：再 poll 无新增
  assert.equal((await tail.poll()).length, 0);

  // rotate/截断：清空重写
  await writeFile(file, JSON.stringify(base({ requestId: "after-rotate" })) + "\n");
  const rr = await tail.poll();
  assert.equal(rr.length, 1);
  assert.equal(rr[0].id, "after-rotate");
});
