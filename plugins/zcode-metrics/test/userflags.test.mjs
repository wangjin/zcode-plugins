// user_config 兜底解析测试：node --test test/userflags.test.mjs
// 覆盖：显式 true/false 直通、未展开模板回退读客户端配置、配置缺失/损坏落默认、
// dataDirName 命中与前缀回退、FLAG_DEFAULTS 与 plugin.json default 的同步门禁。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFlagResolver, readPluginOptions, FLAG_DEFAULTS } from "../hooks/userflags.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function withConfig(content, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "tsd-userflags-"));
  const p = path.join(dir, "config.json");
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  try {
    fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const KEY = "zcode-metrics@zcode-toolbox";
const cfgWith = (opts) => ({ plugins: { options: { [KEY]: opts } } });

test("显式 true/false 直通（不读配置文件）", () => {
  // configPath 指向不存在的文件，直通路径不应受影响
  const r = createFlagResolver({ configPath: "/nonexistent/config.json" });
  assert.equal(r("true", "speedCard"), true);
  assert.equal(r("false", "speedCard"), false);
  assert.equal(r("true", "speedBadge"), true);
  assert.equal(r("false", "speedBadge"), false);
});

test("未展开模板字面量 → 客户端配置值", () => {
  withConfig(cfgWith({ speedCard: true, speedBadge: true }), (p) => {
    const r = createFlagResolver({ configPath: p, dataDirName: KEY });
    assert.equal(r("${user_config.speedCard}", "speedCard"), true);
    assert.equal(r("${user_config.speedBadge}", "speedBadge"), true);
  });
  withConfig(cfgWith({ speedCard: false, speedBadge: false }), (p) => {
    const r = createFlagResolver({ configPath: p, dataDirName: KEY });
    assert.equal(r("${user_config.speedCard}", "speedCard"), false);
    assert.equal(r("${user_config.speedBadge}", "speedBadge"), false);
  });
});

test("未展开模板 + 配置缺失/损坏/无对应键 → plugin.json 默认值", () => {
  const missing = createFlagResolver({ configPath: "/nonexistent/config.json" });
  assert.equal(missing("${user_config.speedCard}", "speedCard"), FLAG_DEFAULTS.speedCard);
  assert.equal(missing("${user_config.speedBadge}", "speedBadge"), FLAG_DEFAULTS.speedBadge);
  withConfig("{broken json", (p) => {
    const r = createFlagResolver({ configPath: p, dataDirName: KEY });
    assert.equal(r("${user_config.speedCard}", "speedCard"), FLAG_DEFAULTS.speedCard);
  });
  withConfig({ plugins: { options: { "other@market": { speedCard: false } } } }, (p) => {
    const r = createFlagResolver({ configPath: p, dataDirName: KEY });
    assert.equal(r("${user_config.speedCard}", "speedCard"), FLAG_DEFAULTS.speedCard);
  });
});

test("dataDirName 未命中（env 缺失手动跑）→ zcode-metrics@* 前缀回退", () => {
  withConfig({ plugins: { options: { "zcode-metrics@another-market": { speedBadge: true } } } }, (p) => {
    const r = createFlagResolver({ configPath: p }); // 无 dataDirName
    assert.equal(r("${user_config.speedBadge}", "speedBadge"), true);
  });
});

test("空串参数（模板替换为空）→ 同未展开，回退配置", () => {
  withConfig(cfgWith({ speedCard: false, speedBadge: true }), (p) => {
    const r = createFlagResolver({ configPath: p, dataDirName: KEY });
    assert.equal(r("", "speedCard"), false);
    assert.equal(r("", "speedBadge"), true);
  });
});

test("配置值非 boolean（如字符串）→ 忽略，落默认", () => {
  withConfig(cfgWith({ speedCard: "true" }), (p) => {
    const r = createFlagResolver({ configPath: p, dataDirName: KEY });
    assert.equal(r("${user_config.speedCard}", "speedCard"), FLAG_DEFAULTS.speedCard);
  });
});

test("readPluginOptions：dataDirName 命中优先于前缀回退", () => {
  withConfig(
    { plugins: { options: { "zcode-metrics@zcode-toolbox": { speedBadge: false }, "zcode-metrics@other": { speedBadge: true } } } },
    (p) => {
      const hit = readPluginOptions({ configPath: p, dataDirName: "zcode-metrics@zcode-toolbox" });
      assert.equal(hit.speedBadge, false);
    },
  );
});

test("门禁：FLAG_DEFAULTS 与 plugin.json userConfig.default 一致", () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, "..", ".zcode-plugin", "plugin.json"), "utf8"));
  for (const [key, dflt] of Object.entries(FLAG_DEFAULTS)) {
    assert.equal(manifest.userConfig?.[key]?.default, dflt, `${key} 默认值与 plugin.json 漂移`);
  }
});
