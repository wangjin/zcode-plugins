// 六档速度配色单测：从 dashboard/index.html 的 TIERS-SRC 标记块提取求值（单源，防 UI 与测试漂移）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const html = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "index.html"),
  "utf8",
);
const block = html.match(/\/\* TIERS-SRC-START[\s\S]*?TIERS-SRC-END \*\//);
assert.ok(block, "index.html 必须包含 TIERS-SRC-START/END 标记块（供本测试提取）");
// 迷你页内嵌同一标记块，必须与主页逐字节一致（防两份档色表漂移）
const miniHtml = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "mini.html"),
  "utf8",
);
const miniBlock = miniHtml.match(/\/\* TIERS-SRC-START[\s\S]*?TIERS-SRC-END \*\//);
assert.ok(miniBlock, "mini.html 必须包含 TIERS-SRC-START/END 标记块");
assert.equal(miniBlock[0], block[0], "mini.html 与 index.html 的 TIERS 档色表必须完全一致");
const { TIERS, tierOf, tierDesat } = new Function(`${block[0]}\nreturn { TIERS, tierOf, tierDesat };`)();

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

test("tierOf.muted：合法 hex、与原色不同（本档非灰）、确定性", () => {
  for (const t of TIERS) {
    const r = tierOf(t.min);
    assert.match(r.muted, HEX);
    assert.notEqual(r.muted, r.color);
    assert.equal(tierOf(t.min).muted, r.muted); // 纯函数：两次调用一致
  }
});

test("tierDesat：k=0 返回原色，k 递增单调向灰度靠拢", () => {
  const c = "#63B58F";
  assert.equal(tierDesat(c, 0), c);
  const g = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return Math.abs((n >> 16 & 255) - (n & 255)); // r-b 通道差作为饱和度代理
  };
  assert.ok(g(tierDesat(c, 0.45)) < g(c), "k=0.45 的饱和度应低于原色");
});
