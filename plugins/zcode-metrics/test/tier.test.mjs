// 速度档色单测：色表单源 dashboard/uicard.mjs（v0.13.0 网页仪表盘移除后）
// v0.14.0 起分档边界动态（deriveTierBounds：会话近 24 次 main 的 min→max 六等分），
// TIERS 的 min 仅作读数不足时的绝对阶梯兜底。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TIERS, TIER_COLORS, tierOf, deriveTierBounds } from "../dashboard/uicard.mjs";

const HEX = /^#[0-9A-Fa-f]{6}$/;

test("色表结构：6 色、#RRGGBB、TIERS 是 TIER_COLORS 的绝对阶梯包装", () => {
  assert.equal(TIER_COLORS.length, 6);
  assert.deepEqual(TIERS.map((t) => t.color), TIER_COLORS);
  assert.deepEqual(TIERS.map((t) => t.min), [0, 40, 80, 160, 240, 320]);
  for (const c of TIER_COLORS) assert.match(c, HEX);
});

test("deriveTierBounds：min→max 区间均匀六等分，不限定绝对速度范围（慢深快浅铺满色档）", () => {
  // 实际速度 8–12 tok/s（旧绝对阶梯下全部挤最深一档）→ 动态界把区间均匀铺到六个色档
  const vs = [8, 9, 10, 11, 12];
  const b = deriveTierBounds(vs);
  const lo = 8, hi = 12, d = hi - lo;
  assert.equal(b.length, 6);
  assert.equal(b[0], 0);
  for (let k = 1; k <= 5; k++) assert.ok(Math.abs(b[k] - (lo + (d * k) / 6)) < 1e-9, `界 ${k} 线性等分`);
  // 最慢读数落最深档（第 0 档），最快落最亮档（第 5 档）；中位读数落中档
  assert.equal(tierOf(lo, b).i, 0);
  assert.equal(tierOf(hi, b).i, 5);
  assert.equal(tierOf(lo + d / 2, b).i, 3); // 恰在界上的中点归上界所在档（含下界不含上界）
  assert.equal(tierOf(lo + d / 2 - 1e-6, b).i, 2);
  assert.equal(tierOf(hi + 100, b).i, 5); // 超出 max 仍落最亮档
});

test("deriveTierBounds 回退：读数 <2 个 / 全部相同（区间退化）→ 绝对阶梯；非法值被过滤后照常动态", () => {
  const abs = [0, 40, 80, 160, 240, 320];
  assert.deepEqual(deriveTierBounds([]), abs);
  assert.deepEqual(deriveTierBounds([50]), abs);
  assert.deepEqual(deriveTierBounds([50, 50, 50]), abs); // hi == lo 无相对差异
  assert.deepEqual(deriveTierBounds(null), abs);
  // 非法值剔除后剩余 ≥2 个有效读数 → 仍动态分档（而非整体回退）
  const b = deriveTierBounds([50, NaN, 60, "x"]);
  assert.ok(Math.abs(b[1] - (50 + 10 / 6)) < 1e-9, "动态界取自剩余有效读数 50–60");
  assert.deepEqual(deriveTierBounds([NaN, "x"]), abs); // 全非法 → 回退
});

test("tierOf 边界：含下界不含上界；bounds 缺省 = 绝对阶梯（兼容）", () => {
  const cases = [
    [0, 0], [39.9, 0], [40, 1], [79.9, 1], [80, 2], [159.9, 2],
    [160, 3], [239.9, 3], [240, 4], [319.9, 4], [320, 5], [500, 5],
  ];
  for (const [v, i] of cases) {
    const r = tierOf(v);
    assert.equal(r.i, i, `tierOf(${v}) 应为第 ${i} 档`);
    assert.equal(r.color, TIER_COLORS[i]);
  }
});

test("tierOf 非法/负值落在最深一档（防御：缺数据的读数不至于报错）", () => {
  for (const v of [null, undefined, -5, NaN, "abc"]) {
    assert.equal(tierOf(v).i, 0, `tierOf(${v}) 应为第 0 档`);
  }
  assert.equal(tierOf("100").i, 2);
  assert.equal(tierOf(Infinity).i, 5);
});

test("tierOf 动态界下非法值仍落最深档、界越界安全（i 截到最后一档）", () => {
  const b = deriveTierBounds([8, 12]);
  assert.equal(tierOf(NaN, b).i, 0);
  assert.equal(tierOf(1e9, b).i, 5);
  assert.equal(tierOf(12.1, b).color, TIER_COLORS[5]);
});
