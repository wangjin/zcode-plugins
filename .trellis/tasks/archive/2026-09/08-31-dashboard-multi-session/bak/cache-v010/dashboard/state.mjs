// token-speed-dashboard · 内存状态机（纯函数式，无 IO，可单测）

export const DEFAULTS = {
  HISTORY_CAP: 20,
  HISTORY_WINDOW_MS: 5 * 60 * 60 * 1000, // 仅保留近 5 小时记录
  STALE_AUTO_CLOSE_MS: 30 * 60 * 1000,   // active 但 30 分钟无任何事件 → 自动收尾（stop hook 丢失兜底）
};

export function newState() {
  return {
    version: "0.1.0",
    server: { pid: process.pid, port: null, startedAtMs: Date.now() },
    turn: {
      active: false,
      sessionId: null,
      startedAtMs: null,
      lastEventMs: null,
      closedAtMs: null,
      sawStop: true,
    },
    turnAgg: { totalOutputTokens: 0, requestCount: 0, avgTokPerSec: null },
    closed: null, // 本轮收尾快照 {tokens,requests,avg,durationSec}
    last: null,   // 最近一次 main 完成记录
    lastLite: null,
    history: [],  // 近 N 条（main+lite），UI 条形图
    liteCount: 0,
    dataState: "waiting", // waiting | live | none（rollout 目录缺失）
    lastRecordMs: null,
  };
}

/** 处理一条 hook 事件（ensure.mjs POST /internal/event）。 */
export function applyEvent(s, ev, now = Date.now()) {
  const sid = ev.sessionId || null;
  switch (ev.kind) {
    case "session_start":
      if (s.turn.active && s.turn.sessionId === sid && now - (s.turn.lastEventMs || 0) < 60_000) break;
      // 视为新一轮起点（SessionStart 也带 prompt 前置性）
      startTurn(s, sid, now);
      break;
    case "user_prompt_submit":
      startTurn(s, sid, now);
      break;
    case "stop":
      if (!s.turn.active) {
        // server 重启后的 Stop：不凭空造 turn，仅刷新 lastEvent
        s.turn.lastEventMs = now;
        break;
      }
      closeTurn(s, now, { sawStop: true, estTokens: Number.isFinite(ev.estimatedOutputTokens) ? ev.estimatedOutputTokens : null });
      break;
  }
  return s;
}

function startTurn(s, sid, now) {
  s.turn = {
    active: true,
    sessionId: sid,
    startedAtMs: now,
    lastEventMs: now,
    closedAtMs: null,
    sawStop: false,
  };
  s.turnAgg = { totalOutputTokens: 0, requestCount: 0, avgTokPerSec: null };
  s.closed = null;
}

function closeTurn(s, now, { sawStop, estTokens }) {
  const t = s.turn;
  t.active = false;
  t.closedAtMs = now;
  t.lastEventMs = now;
  t.sawStop = sawStop;
  const durSec = Math.max((now - (t.startedAtMs ?? now)) / 1000, 0.001);
  let tokens = s.turnAgg.totalOutputTokens;
  let avg = s.turnAgg.avgTokPerSec;
  let estimated = false;
  // 本轮没有任何 rollout 完成记录（如秒回/异常）→ 用 Stop 的 last_assistant_message 估算兜底
  if (s.turnAgg.requestCount === 0 && estTokens > 0) {
    tokens = estTokens;
    avg = estTokens / durSec;
    estimated = true;
  }
  s.closed = {
    sessionId: t.sessionId,
    tokens,
    requests: s.turnAgg.requestCount,
    avgTokPerSec: avg,
    durationSec: durSec,
    estimated,
  };
}

/** 处理一条 rollout 完成记录；sessionId 对齐本轮才计入 turn 聚合。 */
export function applyRecord(s, r, now = Date.now()) {
  s.lastRecordMs = now;
  s.dataState = "live";
  pushHistory(s, r);
  if (r.role === "lite") {
    s.liteCount += 1;
    s.lastLite = r;
    return s;
  }
  s.last = r;
  if (s.turn.active && (!r.sessionId || !s.turn.sessionId || r.sessionId === s.turn.sessionId)) {
    s.turnAgg.totalOutputTokens += r.outputTokens;
    s.turnAgg.requestCount += 1;
    // 用记录"到达时刻"（server 本地时钟）而非 rollout 的 completedAt（模型时钟可能偏差）
    const elapsed = Math.max(now - s.turn.startedAtMs, 1) / 1000;
    s.turnAgg.avgTokPerSec = s.turnAgg.totalOutputTokens / elapsed;
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

/** 心跳兜底：Stop 事件丢失（hook 未执行/session 被强杀）时自动收尾。 */
export function tick(s, now = Date.now()) {
  const ref = s.turn.lastEventMs ?? s.turn.startedAtMs;
  if (s.turn.active && ref != null && now - ref > DEFAULTS.STALE_AUTO_CLOSE_MS) {
    closeTurn(s, now, { sawStop: false, estTokens: null });
  }
  return s;
}

/** 给 UI/SSE 的完整快照（含实时派生字段）。 */
export function snapshot(s, now = Date.now()) {
  const t = s.turn;
  const generating = t.active;
  let turnElapsedMs = 0, turnAvg = null, closedView = null;
  if (generating) {
    turnElapsedMs = now - (t.startedAtMs || now);
    turnAvg = s.turnAgg.avgTokPerSec;
  } else if (t.closedAtMs) {
    turnElapsedMs = (t.closedAtMs || 0) - (t.startedAtMs || 0);
  }
  if (s.closed) {
    closedView = {
      tokens: s.closed.tokens,
      requests: s.closed.requests,
      durationSec: Math.max(turnElapsedMs, 1) / 1000,
      avgTokPerSec: s.closed.avgTokPerSec ?? s.turnAgg.avgTokPerSec,
      estimated: s.closed.estimated,
    };
  }
  const lastRecordAge = s.lastRecordMs ? now - s.lastRecordMs : null;
  const stale = generating && lastRecordAge !== null && lastRecordAge > 120_000;
  return {
    version: s.version,
    server: { pid: s.server.pid, port: s.server.port, startedAtMs: s.server.startedAtMs, uptimeSec: (now - s.server.startedAtMs) / 1000 },
    now,
    generating,
    stale,
    sessionId: t.sessionId,
    turn: {
      startedAtMs: t.startedAtMs,
      elapsedMs: generating ? turnElapsedMs : 0,
      tokens: s.turnAgg.totalOutputTokens,
      requests: s.turnAgg.requestCount,
      avgTokPerSec: generating ? turnAvg : (s.closed ? s.closed.avgTokPerSec : null),
      sawStop: t.sawStop,
    },
    closed: generating ? null : closedView,
    last: s.last,
    lastLite: s.lastLite,
    liteCount: s.liteCount,
    history: s.history,
    dataState: s.dataState === "live" && lastRecordAge !== null && lastRecordAge > 10 * 60 * 1000 && !generating ? "idle" : s.dataState,
    lastRecordAgeMs: lastRecordAge,
  };
}
