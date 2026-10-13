// zcode-metrics · 会话 → Gen UI 可视化目录 绑定（纯逻辑 + 注入依赖，可单测）
// 原理（2026-10-13 实测）：ZCode Desktop 在会话创建时同步创建 ~/.zcode/v2/visualizations/<hash>/，
// 目录 birthtime 与 tasks-index.sqlite 中该 task 的 created_at 偏差 ~150ms → 按 ±容差取 |Δ| 最小者。
// hash 不可由 session_id 推导（sha256/md5 均不符），birthtime join 是唯一稳定映射。
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const DEFAULT_VIZ_ROOT = path.join(process.env.HOME || "~", ".zcode", "v2", "visualizations");
export const DEFAULT_TASKS_INDEX = path.join(process.env.HOME || "~", ".zcode", "v2", "tasks-index.sqlite");
export const JOIN_TOLERANCE_MS = 10_000; // 出生时间连接容差（实测 Δ~150ms，留足余量）

/** 查 task 创建时间（tasks 主键是 (workspace_key, task_id)，同名 task 可跨工作区多行 → 取全部）。 */
function queryCreatedAt(tasksIndex, sessionId, exec) {
  const out = exec(tasksIndex, sessionId);
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * 解析 sessionId 对应的可视化目录。
 * @param deps.readdir(dir)->names  @param deps.stat(p)->{birthtimeMs}  @param deps.exec(db,sid)->rows
 * @returns {dir: string, dirName: string} | null（未命中：目录不存在/DB 不可查/无容差内目录）
 */
export function resolveVizDir(sessionId, { vizRoot, tasksIndex, toleranceMs = JOIN_TOLERANCE_MS, deps } = {}) {
  if (!sessionId || typeof sessionId !== "string") return null;
  const root = vizRoot || DEFAULT_VIZ_ROOT;
  const db = tasksIndex || DEFAULT_TASKS_INDEX;
  const rd = deps?.readdir || readdirSync;
  const st = deps?.stat || ((p) => statSync(p));
  const exec = deps?.exec || ((dbPath, sid) => {
    try {
      const r = spawnSync("sqlite3", ["-readonly", dbPath, `SELECT created_at FROM tasks WHERE task_id = '${String(sid).replace(/'/g, "''")}';`], { timeout: 2000, maxBuffer: 1 << 20 });
      if (r.error || r.status !== 0) return null;
      return r.stdout ? r.stdout.toString() : "";
    } catch {
      return null;
    }
  });

  let names;
  try {
    names = rd(root).filter((n) => /^[0-9a-f]{64}$/.test(n));
  } catch {
    return null; // viz 根目录不存在
  }
  if (!names.length) return null;
  const births = new Map();
  for (const n of names) {
    try {
      births.set(n, st(path.join(root, n)).birthtimeMs);
    } catch { /* 目录消失：跳过 */ }
  }
  const createds = queryCreatedAt(db, sessionId, exec);
  if (!createds.length) return null;
  let best = null;
  for (const [n, birth] of births) {
    for (const c of createds) {
      const delta = Math.abs(birth - c);
      if (delta < toleranceMs && (!best || delta < best.delta)) best = { delta, n };
    }
  }
  return best ? { dir: path.join(root, best.n), dirName: best.n } : null;
}

/* 解析失败重试：阶梯短退避（2s/5s/15s/60s）快速自愈"新会话首绑瞬态失败"
   （建会话时 task 行尚未落库 / 写入突发短暂锁库，实测首绑失败 → 卡片 5min 后才出现 →
   模型输出的 ::visualize 引用指向空目录 → 宿主报 ENOENT）；连续失败降入 VIZ_RETRY_MS
   常态退避（防对永远解析不了的会话按记录到达频率空转 sqlite3）。 */
export const VIZ_RETRY_LADDER_MS = [2_000, 5_000, 15_000, 60_000];
export const VIZ_RETRY_MS = 5 * 60_000;

/**
 * 绑定器：viz-map 缓存 + 失败阶梯退避。回合边界请求（force）绕过退避立即重试——
 * 每条消息仅一两次，sqlite3 单查 ~10ms，换取卡片随消息及时出现。
 * @param deps.resolve(sid)->absDir|null  @param deps.map {get,set}（createVizMap 实例兼容）  @param now ()->ms
 * @returns { bind(sid, {force}) -> absDir|null }
 */
export function createVizBinder({ resolve, map, now = Date.now }) {
  const fails = new Map(); // sid → { at, count }
  return {
    bind(sid, { force = false } = {}) {
      const cached = map.get(sid);
      if (cached) return cached;
      const prev = fails.get(sid);
      if (prev && !force) {
        const wait =
          prev.count <= VIZ_RETRY_LADDER_MS.length
            ? VIZ_RETRY_LADDER_MS[prev.count - 1]
            : VIZ_RETRY_MS;
        if (now() - prev.at < wait) return null;
      }
      const dir = resolve(sid);
      if (dir) {
        fails.delete(sid); // 成功清零：再次失败从阶梯第 1 级重新开始
        map.set(sid, dir);
        return dir;
      }
      fails.set(sid, { at: now(), count: (prev ? prev.count : 0) + 1 });
      return null;
    },
  };
}

/** 持久化缓存（sid → 绝对目录）。坏文件静默忽略；save 失败静默（缓存丢失只影响一次解析成本）。 */
export function createVizMap(mapFile, { readFileSyncImpl, writeFileSyncImpl, mkdirSyncImpl } = {}) {
  const rf = readFileSyncImpl || readFileSync;
  const wf = writeFileSyncImpl || writeFileSync;
  const mk = mkdirSyncImpl || mkdirSync;
  const map = new Map();
  try {
    const data = JSON.parse(rf(mapFile, "utf8"));
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) if (typeof v === "string" && path.isAbsolute(v)) map.set(k, v);
    }
  } catch { /* 首次/坏文件 */ }
  return {
    get: (sid) => map.get(sid) || null,
    set(sid, dir) {
      map.set(sid, dir);
      try {
        mk(path.dirname(mapFile), { recursive: true });
        wf(mapFile, JSON.stringify(Object.fromEntries(map), null, 1) + "\n");
      } catch { /* 持久化失败不影响内存绑定 */ }
    },
    size: () => map.size,
  };
}
