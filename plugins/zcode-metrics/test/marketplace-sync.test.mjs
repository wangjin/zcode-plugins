// 市场清单版本同步测试：node --test test/marketplace-sync.test.mjs
// marketplace.json 每个插件条目的 version 必须与该插件 manifest 一致——
// 已两次发生只改一边导致市场显示旧版本的漂移，此测试作为提交门禁。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const market = JSON.parse(readFileSync(path.join(repoRoot, "marketplace.json"), "utf8"));

for (const entry of market.plugins) {
  test(`marketplace.json：${entry.name} 版本与插件 manifest 一致`, () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, entry.source, ".zcode-plugin/plugin.json"), "utf8"),
    );
    assert.equal(entry.version, manifest.version);
  });
}
