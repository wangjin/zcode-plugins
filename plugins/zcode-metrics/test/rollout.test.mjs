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

test("缺 usage：无估算钩子 → 丢弃；有钩子 → 完整字符口径估算（text+reasoning+toolArgs）", () => {
  const b = base();
  delete b.response.usage;
  b.response.text = "a".repeat(80);
  b.response.reasoningText = "r".repeat(40);
  b.response.toolCalls = [{ name: "Bash", arguments: { command: "ls -la" } }]; // JSON 长度计入 chars
  // 无钩子：usage 缺失且无法估算 → null（旧 ÷4 内联估算已移除，估算统一走校准钩子）
  assert.equal(parseRolloutLine(JSON.stringify(b)), null);
  // 有钩子：chars = 80 + 40 + argsLen，估算与 tokPerSec 均就绪
  let seenChars = 0, seenModel = "";
  const r = parseRolloutLine(JSON.stringify(b), {
    estimate: (chars, modelId) => { seenChars = chars; seenModel = modelId; return Math.round(chars / 3.2); },
  });
  assert.equal(seenModel, "glm-5.3");
  assert.equal(seenChars, 80 + 40 + JSON.stringify({ command: "ls -la" }).length);
  assert.equal(r.outputTokens, Math.round(seenChars / 3.2));
  assert.equal(r.source, "estimate");
  assert.equal(r.needsEstimate, true);       // 估算记录永不回喂校准
  assert.ok(r.tokPerSec > 0);
  // arguments 为字符串形态同样计入
  const b2 = base(); delete b2.response.usage;
  b2.response.text = ""; b2.response.toolCalls = [{ input: "x".repeat(30) }];
  const r2 = parseRolloutLine(JSON.stringify(b2), { estimate: (c) => Math.round(c / 3.2) });
  assert.equal(r2.chars, 30);
});

test("role：querySource 优先（session_title→lite；main_turn/subagent→main）；缺失沿用 model.role", () => {
  assert.equal(parseRolloutLine(JSON.stringify(base({ querySource: "session_title" }))).role, "lite");
  assert.equal(parseRolloutLine(JSON.stringify(base({ querySource: "main_turn" }))).role, "main");
  assert.equal(parseRolloutLine(JSON.stringify(base({ querySource: "subagent" }))).role, "main");
  // querySource 缺失 → 旧规则兜底（向后兼容）
  assert.equal(parseRolloutLine(JSON.stringify(base({ model: { role: "lite", modelId: "x" } }))).role, "lite");
  assert.equal(parseRolloutLine(JSON.stringify(base())).role, "main");
});

test("精确记录带 chars / startedAtMs / needsEstimate=false", () => {
  const r = parseRolloutLine(JSON.stringify(base({ startedAt: "2026-08-31T07:59:59.000Z" })));
  assert.equal(r.chars, 5); // "hello"
  assert.equal(r.needsEstimate, false);
  assert.equal(r.startedAtMs, Date.parse("2026-08-31T07:59:59.000Z"));
  const b3 = base(); delete b3.startedAt;
  assert.equal(parseRolloutLine(JSON.stringify(b3)).startedAtMs, null);
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

test("RolloutTail: fromStart=true → 首 poll 全量回放（回填模式）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tsd-bs-"));
  const file = path.join(dir, "model-io-sess_b.jsonl");
  await writeFile(file, JSON.stringify(base({ requestId: "b1" })) + "\n" + JSON.stringify(base({ requestId: "b2" })) + "\n");
  const tail = new RolloutTail(dir, { fromStart: true });
  const recs = await tail.poll();
  assert.deepEqual(recs.map(r => r.id), ["b1", "b2"]);
  assert.equal((await tail.poll()).length, 0); // 二次 poll 只收增量
  // cache 字段透传（store 缓存分析依赖）
  assert.equal(recs[0].cacheReadTokens, null); // base() 无 cache 字段 → null 而非 undefined
});
