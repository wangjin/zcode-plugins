// zcode-metrics · 官方用量库只读查询（turn_usage 表，经 sqlite3 CLI 子进程，零依赖）
// 今日卡片的主数据源：rollout 对"今日用量"覆盖率实测仅 ~17%（2026-09-20 对账 11.76M vs 69.2M），
// 官方库是口径对齐的唯一可信源。sqlite3 CLI 缺失 / 查询失败 / 超时 → available:false，调用方回退 rollout 聚合。
import { execFile } from "node:child_process";
import path from "node:path";

export const DB_PATH =
  process.env.ZCODE_USAGE_DB ||
  path.join(process.env.HOME || "~", ".zcode", "cli", "db", "db.sqlite");

const QUERY_TIMEOUT_MS = 3000;

/** 本地时区自然日 00:00 的 epoch ms。 */
export function localMidnightMs(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** SQL 字符串字面量（sid 来自本插件内存态，转义是防御式双保险）。 */
function sqlString(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** 今日聚合查询（自然日 [start, now)，completed 口径）；sid 可选过滤单会话。 */
export function buildTodayQuery(now = Date.now(), sid) {
  const where = [`completed_at >= ${localMidnightMs(now)}`, `completed_at < ${Math.round(now)}`, `status = 'completed'`];
  if (sid != null) where.push(`session_id = ${sqlString(sid)}`);
  return (
    "SELECT count(*)," +
    " ifnull(sum(input_tokens),0), ifnull(sum(output_tokens),0)," +
    " ifnull(sum(reasoning_tokens),0), ifnull(sum(cache_creation_input_tokens),0)," +
    " ifnull(sum(computed_total_tokens),0), ifnull(sum(duration_ms),0)" +
    " FROM turn_usage WHERE " + where.join(" AND ")
  );
}

/** 解析 `sqlite3 -list` 首行（'|' 分隔 7 列）→ 结构化；坏输入 null。 */
export function parseTodayRow(line) {
  if (typeof line !== "string") return null;
  const parts = line.trim().split("|");
  if (parts.length !== 7) return null;
  const nums = parts.map((s) => Number(s));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [turns, input, output, reasoning, cacheCreation, total, durationMs] = nums;
  return {
    source: "official",
    available: true,
    turns,
    tokens: { input, output, reasoning, cacheCreation, total },
    avgTokPerSec: durationMs > 0 ? (output / durationMs) * 1000 : null,
  };
}

/** 进程内执行器：TTL 缓存 + 同 key in-flight 去重；失败返回 { source:"official", available:false }。 */
export function createOfficialToday({ bin = "sqlite3", dbPath = DB_PATH, ttlMs = 60_000 } = {}) {
  let cached = null; // { key, at, value }
  let inflight = null;
  function fetch(now = Date.now(), sid) {
    const key = sid == null ? "all" : String(sid);
    if (cached && cached.key === key && now - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (inflight && inflight.key === key) return inflight.promise;
    const promise = new Promise((resolve) => {
      execFile(
        bin,
        ["-readonly", "-noheader", "-list", dbPath, buildTodayQuery(now, sid)],
        { timeout: QUERY_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (inflight && inflight.promise === promise) inflight = null;
          if (err) { cached = null; return resolve({ source: "official", available: false }); }
          const value = parseTodayRow(String(stdout).split("\n")[0] || "") ||
            { source: "official", available: false };
          cached = { key, at: now, value };
          resolve(value);
        },
      );
    });
    inflight = { key, promise };
    return promise;
  }
  return fetch;
}
