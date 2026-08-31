// zcode-metrics · 历史记录持久化 store（纯逻辑，无 IO；文件读写由 server 侧薄层负责）
// 职责：去重、7 天窗口修剪、时间桶趋势、模型对比（avg/p95）、缓存命中聚合；history.jsonl 行编解码。
// 记录字段沿用 rollout.mjs 解析产物：{ id, sessionId, role, modelId, outputTokens, inputTokens,
//   cacheReadTokens, cacheWriteTokens, durationMs, tokPerSec, completedAtMs, source }

export const WINDOW_MS = 7 * 24 * 3600 * 1000; // R7/D2：7 天滚动窗口
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const P95_BUCKET = 5;          // 直方图桶宽（tok/s）：典型速度 10~500，桶宽 5 精度足够
const P95_BUCKETS = 2000;      // 覆盖 0..10000 tok/s，越界值归入末桶

/** 本地时区整点/日界（design：桶边界与用户直觉一致）。 */
function floorHour(ms) { const d = new Date(ms); d.setMinutes(0, 0, 0); return d.getTime(); }
function floorDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

function newAgg(modelId, role) {
  return {
    modelId, role, n: 0, sumOut: 0, sumDur: 0,
    sumInput: 0, sumRead: 0, sumWrite: 0, // 仅 source=rollout 参与（估算记录无 usage，R5/AC6）
    lastMs: 0, hist: null, maxV: 0,
  };
}

function aggObserve(a, r) {
  a.n += 1;
  a.sumOut += r.outputTokens || 0;
  a.sumDur += r.durationMs || 0;
  a.lastMs = Math.max(a.lastMs, r.completedAtMs || 0);
  if (r.source === "rollout") {
    a.sumInput += r.inputTokens || 0;
    a.sumRead += r.cacheReadTokens || 0;
    a.sumWrite += r.cacheWriteTokens || 0;
  }
  const v = r.tokPerSec;
  if (Number.isFinite(v) && v > 0) {
    if (!a.hist) a.hist = new Float64Array(P95_BUCKETS);
    a.hist[Math.min(P95_BUCKETS - 1, Math.floor(v / P95_BUCKET))] += 1;
    a.maxV = Math.max(a.maxV, v);
  }
}

/** 直方图求 p 分位：返回桶上界，并按观测最大值收敛（保守近似，展示用途）。 */
function aggPercentile(a, p) {
  if (!a.hist || !a.n) return null;
  const rank = Math.max(1, Math.ceil(p * a.n));
  let acc = 0;
  for (let i = 0; i < a.hist.length; i++) {
    acc += a.hist[i];
    if (acc >= rank) return Math.min((i + 1) * P95_BUCKET, a.maxV);
  }
  return a.maxV;
}

function aggView(a) {
  return {
    modelId: a.modelId, role: a.role, n: a.n,
    avg: a.sumDur > 0 ? (a.sumOut / a.sumDur) * 1000 : null, // 吞吐加权（design 决策）
    p95: aggPercentile(a, 0.95),
    sumOut: a.sumOut,
    cacheHit: a.sumInput > 0 ? a.sumRead / a.sumInput : null,
    lastMs: a.lastMs || null,
  };
}

export function createStore(opts = {}) {
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const byId = new Map();       // 去重权威（回填/增量/重启共用）
  const aggs = new Map();       // `${modelId}|${role}` -> agg（增量维护）
  let since = null;
  let backfilling = false;

  function aggOf(r) {
    const key = `${r.modelId}|${r.role}`;
    let a = aggs.get(key);
    if (!a) { a = newAgg(r.modelId, r.role); aggs.set(key, a); }
    return a;
  }

  /** 入库一条记录；重复 id / 非法记录返回 false（调用方据此跳过落盘与展示更新）。 */
  function add(r) {
    if (!r || typeof r.id !== "string" || !Number.isFinite(r.completedAtMs)) return false;
    if (byId.has(r.id)) return false;
    byId.set(r.id, r);
    if (since === null || r.completedAtMs < since) since = r.completedAtMs;
    aggObserve(aggOf(r), r);
    return true;
  }

  function loadRecords(list) {
    let loaded = 0;
    for (const r of list || []) if (add(r)) loaded++;
    return loaded;
  }

  /** 修剪超过窗口的记录（不重写文件；append-only，旧行在启动恢复时过滤）。 */
  function prune(now) {
    const cutoff = now - windowMs;
    let dropped = 0;
    for (const [id, r] of byId) {
      if (r.completedAtMs < cutoff) { byId.delete(id); dropped++; }
    }
    if (dropped) {
      aggs.clear();
      since = null;
      for (const r of byId.values()) {
        aggObserve(aggOf(r), r);
        if (since === null || r.completedAtMs < since) since = r.completedAtMs;
      }
    }
    return dropped;
  }

  /** 趋势：近 48 小时桶 / 近 7 天桶；吞吐加权 avg；main/lite 分列；无数据桶为 null。
   *  sid（可选）：只统计 r.sessionId === sid 的记录（多会话过滤口径，无 sid 记录天然排除）。 */
  function trend(now, sid) {
    return { hour: trendSeries(now, HOUR, 48, floorHour, sid), day: trendSeries(now, DAY, 7, floorDay, sid) };
  }

  function trendSeries(now, step, count, floor, sid) {
    const start = floor(now) - (count - 1) * step;
    const cells = new Map();
    for (const r of byId.values()) {
      if (sid !== undefined && r.sessionId !== sid) continue;
      const t = r.completedAtMs;
      if (t < start) continue;
      const key = floor(t);
      if (key < start) continue;
      let c = cells.get(key);
      if (!c) { c = { main: { n: 0, so: 0, sd: 0 }, lite: { n: 0, so: 0, sd: 0 } }; cells.set(key, c); }
      const cell = r.role === "lite" ? c.lite : c.main;
      cell.n += 1; cell.so += r.outputTokens || 0; cell.sd += r.durationMs || 0;
    }
    const out = [];
    for (let i = 0; i < count; i++) {
      const b = start + i * step;
      const c = cells.get(b);
      out.push({ b, main: c ? cellView(c.main) : null, lite: c ? cellView(c.lite) : null });
    }
    return out;
  }
  function cellView(c) {
    return { n: c.n, sumOut: c.so, avg: c.sd > 0 ? (c.so / c.sd) * 1000 : null };
  }

  /** 模型对比：modelId × role，按请求数降序，上限 25 行（payload 体积约束 AC10）。
   *  sid（可选）：从 byId 现算（过滤视图走低频路径，量级毫秒级）。 */
  function models(sid) {
    const list = [];
    if (sid === undefined) {
      for (const a of aggs.values()) if (a.n > 0) list.push(aggView(a));
    } else {
      const m = new Map();
      for (const r of byId.values()) {
        if (r.sessionId !== sid) continue;
        const key = `${r.modelId}|${r.role}`;
        let a = m.get(key);
        if (!a) { a = newAgg(r.modelId, r.role); m.set(key, a); }
        aggObserve(a, r);
      }
      for (const a of m.values()) if (a.n > 0) list.push(aggView(a));
    }
    list.sort((x, y) => y.n - x.n || String(x.modelId).localeCompare(String(y.modelId)));
    return list.slice(0, 25);
  }

  /** 全局缓存分析（估算记录无 usage，aggObserve 已按 source 排除）。 */
  function cache(sid) {
    let sumInput = 0, sumRead = 0, sumWrite = 0, n = 0;
    if (sid === undefined) {
      for (const a of aggs.values()) { sumInput += a.sumInput; sumRead += a.sumRead; sumWrite += a.sumWrite; }
      n = byId.size;
    } else {
      for (const r of byId.values()) {
        if (r.sessionId !== sid) continue;
        n += 1;
        if (r.source === "rollout") {
          sumInput += r.inputTokens || 0;
          sumRead += r.cacheReadTokens || 0;
          sumWrite += r.cacheWriteTokens || 0;
        }
      }
    }
    return {
      sumInput, sumCacheRead: sumRead, sumCacheWrite: sumWrite,
      hit: sumInput > 0 ? sumRead / sumInput : null,
      avgInput: n > 0 ? Math.round(sumInput / n) : null,
    };
  }

  /** snapshot 下发块（不含原始记录，AC10 体积约束）。
   *  opts.sessionId（可选）：trend/models/cache 只统计该会话记录；缺省 = 全局（v0.2.0 口径不变）。 */
  function view(now = Date.now(), opts) {
    const sid = opts && opts.sessionId != null ? opts.sessionId : undefined;
    const t = trend(now, sid);
    return {
      trend: { hour: t.hour, day: t.day },
      models: models(sid),
      cache: cache(sid),
      store: { count: byId.size, since, backfilling, windowMs },
    };
  }

  function setBackfilling(v) { backfilling = !!v; }

  /** 按完成时间升序取最近 n 条（启动回放实时区用）。 */
  function recent(n = 20) {
    const list = [...byId.values()];
    list.sort((a, b) => a.completedAtMs - b.completedAtMs);
    return list.slice(-n);
  }

  /** 全部记录（回填批量落盘覆盖写用），按完成时间升序。 */
  function all() {
    return [...byId.values()].sort((a, b) => a.completedAtMs - b.completedAtMs);
  }

  return { add, loadRecords, prune, view, trend, models, cache, setBackfilling, recent, all, size: () => byId.size };
}

/* ---------------- history.jsonl 行编解码（短字段名契约见 design.md） ---------------- */

export function encodeRow(r) {
  return JSON.stringify({
    v: 1, id: r.id, t: Math.round(r.completedAtMs), m: r.modelId || "unknown",
    r: r.role === "lite" ? "l" : "m", s: r.source === "estimate" ? "e" : "r",
    ot: r.outputTokens, it: r.inputTokens ?? null, cr: r.cacheReadTokens ?? null,
    cw: r.cacheWriteTokens ?? null, d: Math.round(r.durationMs), tps: Math.round(r.tokPerSec * 100) / 100,
  });
}

/** 坏行返回 null（启动恢复逐行 try，防御式原则同 rollout.mjs）。不落盘 sessionId/任何内容字段（R7）。 */
export function decodeRow(line) {
  try {
    const d = JSON.parse(line);
    if (!d || typeof d !== "object" || typeof d.id !== "string" || !Number.isFinite(d.t)) return null;
    if (!(d.ot > 0) || !(d.d > 0)) return null;
    return {
      id: d.id,
      sessionId: null,
      role: d.r === "l" ? "lite" : "main",
      modelId: d.m || "unknown",
      outputTokens: d.ot,
      inputTokens: Number.isFinite(d.it) ? d.it : null,
      cacheReadTokens: Number.isFinite(d.cr) ? d.cr : null,
      cacheWriteTokens: Number.isFinite(d.cw) ? d.cw : null,
      durationMs: d.d,
      tokPerSec: Number.isFinite(d.tps) ? d.tps : d.ot / (d.d / 1000),
      completedAtMs: d.t,
      source: d.s === "e" ? "estimate" : "rollout",
    };
  } catch {
    return null;
  }
}
