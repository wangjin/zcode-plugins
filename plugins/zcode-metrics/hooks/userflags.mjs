// zcode-metrics · user_config 开关解析兜底（纯逻辑 + 注入依赖，可单测）
// 背景（2026-10-13 实证，依据 zcode-guide diagnosing-hooks/diagnosing-mcp 文档）：
// ZCode 的 hook args 只展开 ${ZCODE_PLUGIN_ROOT}/${ZCODE_PROJECT_DIR}/${ZCODE_SESSION_ID}
// 等环境类模板；${user_config.*} 仅在插件 MCP server 配置里展开，hook 里原样传字面量。
// 因此开关解析优先级为：显式 "true"/"false" 参数（未来 ZCode 支持展开时直通）
// > ZCode 客户端配置文件 plugins.options["<plugin>@<marketplace>"] > plugin.json 默认值。
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// 须与 .zcode-plugin/plugin.json 的 userConfig.*.default 保持一致（test/userflags.test.mjs 门禁）
export const FLAG_DEFAULTS = { speedCard: true, speedBadge: false };

export function zcodeConfigPath(homedir = os.homedir()) {
  return path.join(homedir, ".zcode", "cli", "config.json");
}

/** 读 ZCode 客户端配置里本插件的 options；文件缺失/损坏/无命中返回 null（调用方落默认值）。
 *  配置键优先取 dataDirName（= ZCODE_PLUGIN_DATA 目录名，如 "zcode-metrics@zcode-toolbox"，
 *  唯一事实源）；env 缺失（手动跑 ensure.mjs）时退到 zcode-metrics / zcode-metrics@* 前缀匹配。 */
export function readPluginOptions({ configPath, dataDirName } = {}) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath || zcodeConfigPath(), "utf8"));
  } catch {
    return null;
  }
  const opts = cfg && cfg.plugins && cfg.plugins.options;
  if (!opts || typeof opts !== "object") return null;
  if (dataDirName && opts[dataDirName] && typeof opts[dataDirName] === "object") return opts[dataDirName];
  const alt = Object.keys(opts).find((k) => k === "zcode-metrics" || k.startsWith("zcode-metrics@"));
  return alt ? opts[alt] : null;
}

/** 建开关解析器（配置文件只读一次）。arg 为 hook 收到的原样参数，key 为 userConfig 键名。 */
export function createFlagResolver(deps = {}) {
  const opts = readPluginOptions(deps);
  return (arg, key) => {
    if (arg === "true" || arg === "false") return arg === "true";
    const v = opts ? opts[key] : undefined;
    if (typeof v === "boolean") return v;
    return FLAG_DEFAULTS[key] === true;
  };
}
