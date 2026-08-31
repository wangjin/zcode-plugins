// zcode-metrics · 内存状态机（多会话分桶，纯函数式，无 IO，可单测）
// 会话桶仅由 hook 事件创建（session_start/user_prompt_submit）；rollout 记录只路由不建桶（防启动回放复活旧会话）。

export const DEFAULTS = {
  HISTORY_CAP: 20,
  HISTORY_WINDOW_MS: 5 * 60 * 60 * 1000, // 仅保留近 5 小时记录
  STALE_AUTO_CLOSE_MS: 30 * 60 * 1000,   // active 但 30 分钟无任何事件 → 自动收尾（stop hook 丢失兜底）
  SESSION_IDLE_MS: 30 * 60 * 1000,       // 会话 30 分钟无事件 → 下线（无 session_end，靠 idle 超时推断）
  SESSION_CAP: 5,                        // 最多保留 5 个会话桶（超出挤掉最久未活跃）
};

export function newState() {
  return {
    version: "0.3.0",
    server: { pid: process.pid, port: null, startedAtMs: Date.now() },
    sessions: new Map(), // sid -> sess（多会话分桶；仅内存态，收集器重启后清空）
    lastLite: null,
    history: [],  // 近 N 条（main+lite），UI 条形图（全局）
    liteCount: 0,
    dataState: "waiting", // waiting | live | none（rollout 目录缺失）
    lastRecordMs: null,
  };
}

function newSession(sid, now) {
  return {
    sessionId: sid,
    firstSeenMs: now,
    lastEventMs: now,
    turn: {
      active: false,
      sessionId: sid,
      startedAtMs: null,
      lastEventMs: null,
      closedAtMs: null,
      sawStop: true,
    },
    turnAgg: { totalOutputTokens: 0, requestCount: 0, avgTokPerSec: null },
    closed: null, // 本轮收尾快照 {sessionId,tokens,requests,avgTokPerSec,durationSec,estimated}
    last: null,   // 该会话最近一次 main 完成记录（hero 用）
  };
}

/** 取/建会话桶；建桶前执行容量淘汰（新桶尚未插入，绝不挤掉自己）。 */
function ensureSession(s, sid, now) {
  let sess = s.sessions.get(sid);
  if (sess) return sess;
  while (s.sessions.size >= DEFAULTS.SESSION_CAP) {
    let oldest = null;
    for (const x of s.sessions.values()) if (!oldest || x.lastEventMs < oldest.lastEventMs) oldest = x;
    if (!oldest) break;
    s.sessions.delete(oldest.sessionId);
  }
  sess = newSession(sid, now);
  s.sessions.set(sid, sess);
  return sess;
}

/** 最近活跃会话桶（无 sid 记录的宽松归属目标）。 */
function mostActiveSession(s) {
  let best = null;
  for (const sess of s.sessions.values()) {
    if (!best || sess.lastEventMs > best.lastEventMs) best = sess;
  }
  return best;
}

function startTurn(sess, now) {
  sess.turn = {
    active: true,
    sessionId: sess.sessionId,
    startedAtMs: now,
    lastEventMs: now,
    closedAtMs: null,
    sawStop: false,
  };
  sess.turnAgg = { totalOutputTokens: 0, requestCount: 0, avgTokPerSec: null };
  sess.closed = null;
  sess.lastEventMs = now;
}

function closeTurn(sess, now, { sawStop, estTokens }) {
  const t = sess.turn;
  t.active = false;
  t.closedAtMs = now;
  t.lastEventMs = now;
  t.sawStop = sawStop;
  const durSec = Math.max((now - (t.startedAtMs ?? now)) / 1000, 0.001);
  let tokens = sess.turnAgg.totalOutputTokens;
  let avg = sess.turnAgg.avgTokPerSec;
  let estimated = false;
  // 本轮没有任何 rollout 完成记录（如秒回/异常）→ 用 Stop 的 last_assistant_message 估算兜底
  if (sess.turnAgg.requestCount === 0 && estTokens > 0) {
    tokens = estTokens;
    avg = estTokens / durSec;
    estimated = true;
  }
  sess.closed = {
    sessionId: t.sessionId,
    tokens,
    requests: sess.turnAgg.requestCount,
    avgTokPerSec: avg,
    durationSec: durSec,
    estimated,
  };
  sess.lastEventMs = now; // 收尾即"事件"：僵尸轮会话从收尾起再留 30min 供查看摘要
}

/** 处理一条 hook 事件（ensure.mjs POST /internal/event）。三事件均按 sessionId 路由到本会话桶。 */
export function applyEvent(s, ev, now = Date.now()) {
  const sid = ev.sessionId || null;
  switch (ev.kind) {
    case "session_start":
    case "user_prompt_submit": {
      if (sid == null) break; // 无 sid 无法建桶（hook 正常都带；防御分支）
      const sess = ensureSession(s, sid, now);
      // 桶内 60s 防抖：仅 session_start（视为重复事件，不重置轮次）；user_prompt_submit 无条件新轮
      if (ev.kind === "session_start" && sess.turn.active && now - (sess.turn.lastEventMs || 0) < 60_000) break;
      startTurn(sess, now);
      break;
    }
    case "stop": {
      // 只关本会话的活跃轮次：桶不存在（server 重启后的孤儿 Stop）或未在生成 → 忽略，不串扰其他会话
      const sess = sid != null ? s.sessions.get(sid) : null;
      if (!sess || !sess.turn.active) break;
      closeTurn(sess, now, {
        sawStop: true,
        estTokens: Number.isFinite(ev.estimatedOutputTokens) ? ev.estimatedOutputTokens : null,
      });
      break;
    }
  }
  return s;
}

/** 处理一条 rollout 完成记录。
 *  路由：已知 sid → 本桶；无 sid → 最近活跃桶（宽松归属）；未知 sid → 不建桶，只进全局 history。 */
export function applyRecord(s, r, now = Date.now()) {
  s.lastRecordMs = now;
  s.dataState = "live";
  pushHistory(s, r);
  if (r.role === "lite") {
    s.liteCount += 1;
    s.lastLite = r;
    return s;
  }
  const sess = r.sessionId ? s.sessions.get(r.sessionId) || null : mostActiveSession(s);
  if (!sess) return s;
  sess.last = r;
  sess.lastEventMs = now;
  if (sess.turn.active) {
    sess.turnAgg.totalOutputTokens += r.outputTokens;
    sess.turnAgg.requestCount += 1;
    // 用记录"到达时刻"（server 本地时钟）而非 rollout 的 completedAt（模型时钟可能偏差）
    const elapsed = Math.max(now - sess.turn.startedAtMs, 1) / 1000;
    sess.turnAgg.avgTokPerSec = sess.turnAgg.totalOutputTokens / elapsed;
  }
  return s;
}

function pushHistory(s, r) {
  s.history.push({
    tokPerSec: r.tokPerSec,
    outputTokens: r.outputTokens,
    durationMs: r.durationMs,
    modelId: r.modelId,
    role: r.role,
    source: r.source,
    completedAtMs: r.completedAtMs,
  });
  const cutoff = Date.now() - DEFAULTS.HISTORY_WINDOW_MS;
  while (s.history.length > DEFAULTS.HISTORY_CAP || (s.history[0] && s.history[0].completedAtMs < cutoff)) {
    s.history.shift();
  }
}

/** 心跳兜底：先逐桶僵尸收尾（Stop 丢失时自动收尾，刷新 lastEventMs），再淘汰 idle 超时会话。 */
export function tick(s, now = Date.now()) {
  for (const sess of s.sessions.values()) {
    const ref = sess.turn.lastEventMs ?? sess.turn.startedAtMs;
    if (sess.turn.active && ref != null && now - ref > DEFAULTS.STALE_AUTO_CLOSE_MS) {
      closeTurn(sess, now, { sawStop: false, estTokens: null });
    }
  }
  for (const [sid, sess] of s.sessions) {
    if (now - sess.lastEventMs > DEFAULTS.SESSION_IDLE_MS) s.sessions.delete(sid);
  }
  return s;
}

/** 单会话实时态（形状对齐 v0.2.0 顶层 turn/closed）。 */
function sessionView(sess, now) {
  const t = sess.turn;
  const generating = t.active;
  let turnElapsedMs = 0, turnAvg = null, closedView = null;
  if (generating) {
    turnElapsedMs = now - (t.startedAtMs || now);
    turnAvg = sess.turnAgg.avgTokPerSec;
  } else if (t.closedAtMs) {
    turnElapsedMs = (t.closedAtMs || 0) - (t.startedAtMs || 0);
  }
  if (sess.closed) {
    closedView = {
      tokens: sess.closed.tokens,
      requests: sess.closed.requests,
      durationSec: Math.max(turnElapsedMs, 1) / 1000,
      avgTokPerSec: sess.closed.avgTokPerSec ?? sess.turnAgg.avgTokPerSec,
      estimated: sess.closed.estimated,
    };
  }
  return {
    sessionId: sess.sessionId,
    lastEventMs: sess.lastEventMs,
    generating,
    stale: generating && now - sess.lastEventMs > 120_000,
    turn: {
      startedAtMs: t.startedAtMs,
      elapsedMs: generating ? turnElapsedMs : 0,
      tokens: sess.turnAgg.totalOutputTokens,
      requests: sess.turnAgg.requestCount,
      avgTokPerSec: generating ? turnAvg : (sess.closed ? sess.closed.avgTokPerSec : null),
      sawStop: t.sawStop,
    },
    closed: generating ? null : closedView,
    last: sess.last,
  };
}

/** 给 UI/SSE 的完整快照（含实时派生字段 + 7 天历史聚合视图）。
 *  顶层不再有 turn/closed/last/sessionId/stale（被 sessions[] 取代）；generating = 任一会话 active。
 *  store（可选）为 store.mjs 的 createStore 实例：传入时全局附带 trend/models/cache/store 四块，
 *  且每个会话项附带该 sid 过滤的 trend/models/cache 三块；缺省时聚合字段省略（兼容单测）。 */
export function snapshot(s, now = Date.now(), store = null) {
  const list = [...s.sessions.values()].sort((a, b) => b.lastEventMs - a.lastEventMs);
  const generating = list.some((x) => x.turn.active);
  const lastRecordAge = s.lastRecordMs ? now - s.lastRecordMs : null;
  const hasStore = !!(store && typeof store.view === "function");
  const sessions = list.map((sess) => {
    const item = sessionView(sess, now);
    if (hasStore) {
      const v = store.view(now, { sessionId: sess.sessionId });
      item.trend = v.trend;
      item.models = v.models;
      item.cache = v.cache;
    }
    return item;
  });
  const out = {
    version: s.version,
    server: { pid: s.server.pid, port: s.server.port, startedAtMs: s.server.startedAtMs, uptimeSec: (now - s.server.startedAtMs) / 1000 },
    now,
    generating,
    sessions,
    lastLite: s.lastLite,
    liteCount: s.liteCount,
    history: s.history,
    dataState: s.dataState === "live" && lastRecordAge !== null && lastRecordAge > 10 * 60 * 1000 && !generating ? "idle" : s.dataState,
    lastRecordAgeMs: lastRecordAge,
  };
  // 全局 7 天聚合（"全部"口径，与 v0.2.0 一致）
  if (hasStore) {
    const v = store.view(now);
    out.trend = v.trend;
    out.models = v.models;
    out.cache = v.cache;
    out.store = v.store;
  }
  return out;
}
