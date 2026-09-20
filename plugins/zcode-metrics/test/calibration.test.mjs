// calibration.mjs 单测：分桶、回退链、环形淘汰、median、serialize/restore 往返
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCalibration, CALIB_DEFAULT_K } from "../dashboard/calibration.mjs";

test("无样本 → 默认系数；estimateTokens 向上取整且 ≥1", () => {
  const c = createCalibration({ defaultK: 3.2 });
  assert.equal(c.k("glm"), 3.2);
  assert.equal(c.estimateTokens("glm", 320), 100); // 320/3.2
  assert.equal(c.estimateTokens("glm", 1), 1);     // 下限保护
  assert.equal(c.estimateTokens("glm", 0), 0);
});

test("observe 采样门槛：outputTokens ≤ 50 或 chars ≤ 0 不入桶", () => {
  const c = createCalibration({ modelMin: 1, globalMin: 1 });
  c.observe("m", 1000, 50);  // 恰好 50：不采（需 >50）
  c.observe("m", 0, 500);
  assert.equal(c.view().global.n, 0);
  c.observe("m", 1000, 51);  // 采
  assert.equal(c.view().global.n, 1);
});

test("回退链：模型桶 → 全局桶 → 预热桶 → 默认", () => {
  const c = createCalibration({ modelMin: 3, globalMin: 5, defaultK: 9 });
  // 3 条 m1：k = 2,4,6 → median 4（模型桶启用）
  for (const k of [2, 4, 6]) c.observe("m1", k * 100, 100);
  assert.equal(c.k("m1"), 4);
  // m2 只有 1 条（< modelMin）→ 落全局（此时全局 3 条 < globalMin=5）→ 默认 9
  c.observe("m2", 300, 100);
  assert.equal(c.k("m2"), 9);
  // 全局补到 5 条（k=2,4,6,3,3 → median 3）→ m2 用全局
  c.observe("m3", 300, 100);
  c.observe("m3", 300, 100);
  assert.equal(c.k("m2"), 3);
});

test("环形淘汰：超 cap 挤掉最旧，median 跟随新样本", () => {
  const c = createCalibration({ cap: 3, modelMin: 3, globalMin: 999 });
  for (const k of [1, 2, 3]) c.observe("m", k * 100, 100);   // {1,2,3} median 2
  assert.equal(c.k("m"), 2);
  c.observe("m", 1000, 100);                                  // {2,3,10} median 3
  assert.equal(c.k("m"), 3);
  assert.equal(c.view().buckets.m.n, 3);
});

test("serialize/restore 往返：预热中位数在 live 样本不足时生效", () => {
  const c1 = createCalibration({ modelMin: 20, globalMin: 50 });
  for (let i = 0; i < 25; i++) c1.observe("m1", 300, 100); // k 恒 3，n=25 ≥ 20 → 序列化含 m1
  const saved = c1.serialize();
  assert.deepEqual(saved.buckets.m1, { k: 3, n: 25 });

  const c2 = createCalibration({ modelMin: 20, globalMin: 50, defaultK: 9 });
  c2.restore(saved);
  assert.equal(c2.k("m1"), 3);            // 预热桶命中
  assert.equal(c2.k("unknown"), 9);       // 无预热也无 live → 默认
  c2.restore({ version: 2 });             // 坏版本 → 静默忽略
  c2.restore(null);
  assert.equal(c2.k("m1"), 3);            // 预热不被后续坏数据清除（防御式保持空态/原态）
});

test("serialize 只输出达到启用门槛的桶", () => {
  const c = createCalibration({ modelMin: 20, globalMin: 50 });
  c.observe("m", 300, 100);
  const s = c.serialize();
  assert.deepEqual(s.buckets, {});
  assert.equal(s.global, null);
});

test("实证默认系数存在且量级合理（research B10：3.158）", () => {
  assert.ok(CALIB_DEFAULT_K > 2 && CALIB_DEFAULT_K < 4);
});
