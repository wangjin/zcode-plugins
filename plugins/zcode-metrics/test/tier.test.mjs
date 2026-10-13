// 六档速度配色单测：TIERS 单源在 dashboard/uicard.mjs（v0.13.0 网页仪表盘移除后）
import { test } from "node:test";
import assert from "node:assert/strict";
import { TIERS, tierOf } from "../dashboard/uicard.mjs";

const HEX = /^#[0-9A-Fa-f]{6}$/;

test("TIERS 表结构：6 档、min 严格递增、色值 #RRGGBB", () => {
  assert.equal(TIERS.length, 6);
  assert.deepEqual(TIERS.map((t) => t.min), [0, 40, 80, 160, 240, 320]);
  for (const t of TIERS) assert.match(t.color, HEX);
});

test("tierOf 边界：含下界不含上界", () => {
  const cases = [
    [0, 0], [39.9, 0], [40, 1], [79.9, 1], [80, 2], [159.9, 2],
    [160, 3], [239.9, 3], [240, 4], [319.9, 4], [320, 5], [500, 5],
  ];
  for (const [v, i] of cases) {
    const r = tierOf(v);
    assert.equal(r.i, i, `tierOf(${v}) 应为第 ${i} 档`);
    assert.equal(r.color, TIERS[i].color);
  }
});

test("tierOf 非法/负值落在第 1 档（防御：缺数据的读数不至于报错）", () => {
  for (const v of [null, undefined, -5, NaN, "abc"]) {
    assert.equal(tierOf(v).i, 0, `tierOf(${v}) 应为第 0 档`);
  }
  // 字符串数字可被 Number() 归一；Infinity 数值上确属最高档
  assert.equal(tierOf("100").i, 2);
  assert.equal(tierOf(Infinity).i, 5);
});
