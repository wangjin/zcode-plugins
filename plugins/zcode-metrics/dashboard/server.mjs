// zcode-metrics · 常驻收集器：tail rollout → store(7d 持久化+聚合) → 状态机 → HTTP/SSE 仪表盘
// 零依赖，仅监听 127.0.0.1。由 hooks/ensure.mjs 幂等拉起，不建议直接手动运行。
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { watch, mkdirSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RolloutTail, ROLLOUT_DIR } from "./rollout.mjs";
import { newState, applyEvent, applyRecord, tick, snapshot } from "./state.mjs";
import { createStore, encodeRow, decodeRow, WINDOW_MS } from "./store.mjs";
import { createOfficialToday } from "./official.mjs";
import { createCalibration } from "./calibration.mjs";
import { renderSpeedCard } from "./uicard.mjs";
import { resolveVizDir, createVizMap } from "./vizbind.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 版本以插件 manifest 为唯一事实源（避免硬编码常量与 plugin.json 漂移，误导 hook 的版本比较）
function readPluginVersion() {
  try {
    const m = JSON.parse(readFileSync(path.join(__dirname, "..", ".zcode-plugin", "plugin.json"), "utf8"));
    if (typeof m.version === "string" && m.version) return m.version;
  } catch { /* manifest 缺失/损坏 → 兜底 */ }
  return "0.0.0";
}
const VERSION = readPluginVersion();
// 接管凭据：hook 关闭旧实例时须带此 token（仅经本机 port.json 传递，进程每次启动随机生成）
const SHUTDOWN_TOKEN = randomUUID();
const BASE_PORT = Number(process.env.TSD_PORT || 4521);
const PORT_TRIES = 10;
const DATA_DIR =
  process.env.ZCODE_PLUGIN_DATA ||
  path.join(os.homedir(), ".zcode", "plugin-data", "zcode-metrics");
const PORT_FILE = path.join(DATA_DIR, "port.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.jsonl");
const CALIB_FILE = path.join(DATA_DIR, "calibration.json");
const VIZ_MAP_FILE = path.join(DATA_DIR, "viz-map.json");
const BADGE_BIN = path.join(__dirname, "..", "bin", "tsd-badge");
const BADGE_PID_FILE = path.join(DATA_DIR, "badge.pid");
const HTML_FILE = path.join(__dirname, "index.html");
const MINI_FILE = path.join(__dirname, "mini.html");

const state = newState();
state.version = VERSION;
const store = createStore();
// 字符→token 动态校准（estimate 路径 + 恢复预热；详见 calibration.mjs）
const calib = createCalibration();
const estimateFn = (chars, modelId) => calib.estimateTokens(modelId, chars);
const clients = new Set();
let htmlCache = null;
let miniCache = null;

/* 校准持久化：30s 防抖 + 每日修剪时兜底（只存 median/count，删文件即回退默认系数） */
let calibPersistTimer = null;
function scheduleCalibPersist() {
  if (calibPersistTimer) return;
  calibPersistTimer = setTimeout(() => {
    calibPersistTimer = null;
    if (!calib.isDirty()) return;
    writeFile(CALIB_FILE, JSON.stringify(calib.serialize()) + "\n")
      .then(() => calib.markPersisted())
      .catch((e) => console.error("[tsd] calibration persist failed:", e && e.message));
  }, 30_000);
  calibPersistTimer.unref?.();
}

/* ---------------- rollout tail（增量常态路径；启动恢复完成后激活） ---------------- */
let tail = null;
let polling = false;
async function pollRollout() {
  if (polling || !tail) return;
  polling = true;
  try {
    const recs = await tail.poll();
    let fresh = 0;
    for (const r of recs) if (ingest(r)) fresh++;
    if (fresh) { broadcast(); refreshCards(); }
  } catch (e) {
    console.error("[tsd] poll error:", e && e.message);
  } finally {
    polling = false;
  }
}
let watcher = null;
function ensureWatcher() {
  if (watcher) return;
  try {
    watcher = watch(ROLLOUT_DIR, { persistent: false }, (_e, f) => {
      if (!f || /^model-io-.*\.jsonl$/.test(f)) pollRollout();
    });
    watcher.on("error", () => { try { watcher.close(); } catch {} watcher = null; });
  } catch { watcher = null; } // 目录暂不存在 → 靠兜底轮询
}

/** 常态入库：store 去重成功才落盘 + 进入实时状态机。返回是否新记录。 */
function ingest(r) {
  if (!store.add(r)) return false;
  appendFile(HISTORY_FILE, encodeRow(r) + "\n")
    .catch((e) => console.error("[tsd] history append failed:", e && e.message));
  applyRecord(state, r);
  // 精确记录喂校准（chars 完整口径；采样条件在 observe 内部）
  if (!r.needsEstimate) {
    calib.observe(r.modelId, r.chars, r.outputTokens);
    scheduleCalibPersist();
  }
  return true;
}

/* ---------------- 启动：恢复 history.jsonl；缺失/为空 → 一次性回填 7 天 ---------------- */
async function startupStore() {
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  // 0) 恢复校准预热（坏文件静默忽略；恢复失败仅影响 estimate 精度，不影响精确统计）
  try { calib.restore(JSON.parse(readFileSync(CALIB_FILE, "utf8"))); } catch {}
  // 1) 恢复既有历史（坏行静默跳过；超窗旧行读时过滤，不重写文件）
  let loaded = 0;
  try {
    const raw = await readFile(HISTORY_FILE, "utf8");
    const cutoff = Date.now() - WINDOW_MS;
    for (const line of raw.split("\n")) {
      const r = decodeRow(line);
      if (r && r.completedAtMs >= cutoff && store.add(r)) loaded++;
    }
  } catch { /* 文件不存在 → 走回填 */ }
  // 2) 空历史 → 首启一次性回填（fromStart 全量读 rollout，过滤 7d，批量覆盖写 history.jsonl）
  if (!loaded) {
    store.setBackfilling(true);
    broadcast();
    try {
      const bt = new RolloutTail(ROLLOUT_DIR, { fromStart: true, estimate: estimateFn });
      const cutoff = Date.now() - WINDOW_MS;
      const recs = await bt.poll();
      let added = 0;
      for (const r of recs) {
        if (r.completedAtMs >= cutoff && store.add(r)) {
          added++;
          if (!r.needsEstimate) calib.observe(r.modelId, r.chars, r.outputTokens);
        }
      }
      if (added) {
        await writeFile(HISTORY_FILE, store.all().map(encodeRow).join("\n") + "\n");
        scheduleCalibPersist();
      }
      console.error(`[tsd] backfill done: ${added}/${recs.length} records within 7d`);
    } catch (e) {
      console.error("[tsd] backfill failed:", e && e.message); // 历史仍空 → 下次启动自动重试
    }
    store.setBackfilling(false);
  }
  // 3) 实时区回放近 20 条（重启后大数字/条形图/详情立即有上下文）
  for (const r of store.recent(20)) applyRecord(state, r);
  // 4) 常态 tail：默认 seek EOF（只收启动后新增；重叠由 store 去重兜底）
  tail = new RolloutTail(ROLLOUT_DIR, { skipOlderThan: Date.now(), estimate: estimateFn });
  ensureWatcher();
  broadcast();
}
const storeReady = startupStore().catch((e) => console.error("[tsd] startup error:", e && e.stack));

const pollTimer = setInterval(() => { ensureWatcher(); storeReady.then(pollRollout); }, 2000);
storeReady.then(pollRollout);

/* ---------------- 心跳：生成中每秒刷新 + 僵尸 turn 收尾 + 每日修剪 ---------------- */
let lastPruneDay = new Date().getDate();
const beatTimer = setInterval(() => {
  tick(state);
  const day = new Date().getDate();
  if (day !== lastPruneDay) {
    lastPruneDay = day;
    const dropped = store.prune(Date.now());
    if (dropped) console.error(`[tsd] pruned ${dropped} records older than 7d`); // append-only：不重写文件，读时过滤
    scheduleCalibPersist(); // 日界兜底持久化（防 30s 防抖 timer 被 unref 后进程静默退出场景）
  }
  if (state.sessions.size > 0 && [...state.sessions.values()].some((x) => x.turn.active)) { broadcast(); refreshCards(); }
}, 1000);

function broadcast() {
  if (!clients.size) return;
  const payload = `event: state\ndata: ${JSON.stringify(buildSnapshot())}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

/* 无浏览器客户端时 broadcast 短路，卡片仍要随记录到达刷新（生成中的会话 mid-turn 更新） */
function refreshCards() {
  for (const sid of state.sessions.keys()) writeSpeedCard(sid);
}

/* ---------------- 官方用量库（今日卡片主数据源；异步刷新 + 同步读缓存） ----------------
   turn_usage 经 sqlite3 CLI 只读查询，60s 刷新（全局 + 各活跃会话）；快照构建保持纯同步，
   官方数据以缓存并入（慢变数据，60s 陈旧可接受）。失败/缺 CLI → available:false，UI 回退 rollout。 */
const officialToday = createOfficialToday();
const officialCache = { all: { source: "official", available: false }, perSid: new Map() };
function refreshOfficial() {
  officialToday().then((v) => { officialCache.all = v; broadcast(); }).catch(() => {});
  for (const sid of state.sessions.keys()) {
    officialToday(undefined, sid)
      .then((v) => officialCache.perSid.set(sid, v))
      .catch(() => {});
  }
  for (const sid of officialCache.perSid.keys()) {
    if (!state.sessions.has(sid)) officialCache.perSid.delete(sid);
  }
}
const officialTimer = setInterval(refreshOfficial, 60_000);
officialTimer.unref?.();
refreshOfficial();

/* ---------------- Gen UI 速度卡：会话 → 可视化目录绑定 + 片段写出 ----------------
   卡片是静态快照（Gen UI 沙箱禁 fetch，数据全内联）；写入时机 = 会话事件（回合边界，
   force）+ broadcast 搭车（记录到达，2s 节流）。任何失败只 stderr，不碰收集器主链路。 */
const vizMap = createVizMap(VIZ_MAP_FILE);
const vizResolveFail = new Map(); // sid → 上次解析失败时间（VIZ_RETRY_MS 内不重试，防每回合空转 sqlite3）
const cardLastWrite = new Map();  // sid → 上次写卡时间（broadcast 路径节流）
const CARD_MIN_INTERVAL_MS = 2_000;
const VIZ_RETRY_MS = 5 * 60_000;

function boundVizDir(sid) {
  const known = vizMap.get(sid);
  if (known) return known;
  const failedAt = vizResolveFail.get(sid);
  if (failedAt != null && Date.now() - failedAt < VIZ_RETRY_MS) return null;
  const hit = resolveVizDir(sid);
  if (hit) {
    vizMap.set(sid, hit.dir);
    return hit.dir;
  }
  vizResolveFail.set(sid, Date.now());
  return null;
}

function writeSpeedCard(sid, { force = false } = {}) {
  try {
    const dir = boundVizDir(sid);
    if (!dir) return;
    const now = Date.now();
    if (!force && now - (cardLastWrite.get(sid) || 0) < CARD_MIN_INTERVAL_MS) return;
    cardLastWrite.set(sid, now);
    const sv = snapshot(state, now, store).sessions.find((x) => x.sessionId === sid);
    if (!sv) return; // 无会话桶（server 刚重启）：不写，等下个 hook 事件建桶
    const records = store.all().filter((r) => r.sessionId === sid);
    const html = renderSpeedCard({ session: sv, records, today: store.today(now, sid) });
    if (html) writeFile(path.join(dir, "token-speed.html"), html).catch(() => {});
  } catch (e) {
    console.error("[tsd] speed card failed:", e && e.message);
  }
}

/** snapshot + 官方今日块（顶层 officialToday=全局；每会话项 officialToday=sid 过滤）+ 校准视图。 */
function buildSnapshot() {
  const snap = snapshot(state, Date.now(), store);
  snap.officialToday = officialCache.all;
  snap.calibration = calib.view();
  for (const item of snap.sessions || []) {
    item.officialToday = officialCache.perSid.get(item.sessionId) || { source: "official", available: false };
  }
  return snap;
}

/* ---------------- 浏览器自动打开（每 server 生命周期一次） ---------------- */
let openedOnce = false;
function maybeOpenDashboard() {
  if (openedOnce || !state.server.port) return;
  openedOnce = true;
  if (process.platform !== "darwin") return;
  try {
    const p = spawn("open", [`http://127.0.0.1:${state.server.port}/`], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch { /* 打不开就手动开 */ }
}

/* ---------------- 置顶速度徽章（macOS · bin/tsd-badge，输入框右下角实时速度） ----------------
   收集器每生命周期只拉起一次（badge.pid 存活即跳过）；窗口矩形经 osascript 查询（1.2s 预算，
   失败徽章自行落主屏右下角）；收集器退出时一并收掉（cleanup），徽章失联 15s 也会自杀。 */
let badgeTried = false;
function badgePidAlive() {
  try {
    const { pid } = JSON.parse(readFileSync(BADGE_PID_FILE, "utf8"));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function zcodeWindowRect(cb) {
  if (process.platform !== "darwin") return cb(null);
  const osa = spawn("osascript", [
    "-e",
    'tell application "System Events" to tell (first process whose name is "ZCode") to get {position, size} of front window',
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const t = setTimeout(() => { try { osa.kill(); } catch {} }, 1200);
  t.unref?.();
  let out = "";
  osa.stdout.on("data", (c) => { out += c; });
  osa.on("error", () => { clearTimeout(t); cb(null); });
  osa.on("close", (code) => {
    clearTimeout(t);
    const m = code === 0 ? out.trim().match(/^(-?\d+), (-?\d+), (\d+), (\d+)$/) : null;
    cb(m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null);
  });
}
function maybeSpawnBadge() {
  if (badgeTried || state.server.port == null) return;
  badgeTried = true;
  if (process.platform !== "darwin") return; // 徽章目前仅 macOS（badge/badge.swift）
  if (!existsSync(BADGE_BIN)) {
    console.error("[tsd] badge binary missing: bin/tsd-badge（badge/build.sh 可重建）");
    return;
  }
  if (badgePidAlive()) return; // 旧收集器退出/接管期间徽章仍活着：不重复弹
  zcodeWindowRect((rect) => {
    try {
      const child = spawn(BADGE_BIN, [String(state.server.port), DATA_DIR, ...(rect || [])], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (e) => console.error("[tsd] badge spawn failed:", e && e.message));
      child.unref();
      writeFile(BADGE_PID_FILE, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }))
        .catch(() => {});
    } catch (e) {
      console.error("[tsd] badge spawn error:", e && e.message);
    }
  });
}

/* ---------------- HTTP ---------------- */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const send = (code, type, body) => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  };
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (htmlCache === null) {
        htmlCache = await readFile(HTML_FILE, "utf8").catch(() => "");
      }
      if (!htmlCache) return send(500, "text/plain; charset=utf-8", "index.html missing");
      return send(200, "text/html; charset=utf-8", htmlCache);
    }
    if (req.method === "GET" && url.pathname === "/mini") {
      if (miniCache === null) {
        miniCache = await readFile(MINI_FILE, "utf8").catch(() => "");
      }
      if (!miniCache) return send(500, "text/plain; charset=utf-8", "mini.html missing");
      return send(200, "text/html; charset=utf-8", miniCache);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return send(200, "application/json", JSON.stringify({ ok: true, pid: process.pid, port: state.server.port, version: VERSION }));
    }
    if (req.method === "POST" && url.pathname === "/shutdown") {
      // 仅接受持有本机 port.json token 的调用方（hook 升级接管）；token 每次进程启动随机
      const token = req.headers["x-shutdown-token"];
      if (!token || token !== SHUTDOWN_TOKEN) return send(403, "application/json", '{"ok":false,"error":"bad token"}');
      send(200, "application/json", '{"ok":true}');
      setTimeout(cleanup, 50); // 让响应先 flush
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return send(200, "application/json", JSON.stringify(buildSnapshot()));
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      res.write(`event: state\ndata: ${JSON.stringify(buildSnapshot())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/internal/event") {
      const raw = await readBody(req);
      let ev = null;
      try { ev = JSON.parse(raw); } catch {}
      if (!ev || typeof ev.kind !== "string") return send(400, "application/json", '{"ok":false}');
      // Stop 的 last_assistant_message 只取长度用于估算降级，绝不留存内容
      if (ev.kind === "stop" && typeof ev.lastAssistantMessage === "string") {
        ev.estimatedOutputTokens = Math.round(ev.lastAssistantMessage.length / 4);
      }
      applyEvent(state, ev);
      if (ev.kind === "session_start") {
        if (ev.openDashboard !== false) maybeOpenDashboard();
        if (ev.speedBadge !== false) maybeSpawnBadge();
      }
      pollRollout(); // 提交后立即拉一次增量，不等 2s 轮询
      broadcast();
      if (ev.sessionId) writeSpeedCard(ev.sessionId, { force: true }); // 回合边界：立即落卡（Stop 后卡片即终值）
      return send(200, "application/json", '{"ok":true}');
    }
    send(404, "application/json", '{"error":"not found"}');
  } catch (e) {
    try { send(500, "application/json", JSON.stringify({ error: String((e && e.message) || e) })); } catch {}
  }
});

/* ---------------- 端口绑定 + portfile ---------------- */
function listenWithRetry(tryIdx = 0) {
  const port = BASE_PORT + tryIdx;
  return new Promise((resolve, reject) => {
    const onOk = () => { httpServer.removeListener("error", onError); resolve(port); };
    const onError = (e) => {
      httpServer.removeListener("listening", onOk);
      if (e && e.code === "EADDRINUSE" && tryIdx + 1 < PORT_TRIES) resolve(listenWithRetry(tryIdx + 1));
      else reject(e);
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onOk);
    httpServer.listen(port, "127.0.0.1");
  });
}

listenWithRetry()
  .then(async (port) => {
    state.server.port = port;
    try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}
    try {
      await writeFile(PORT_FILE, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString(), version: VERSION, shutdownToken: SHUTDOWN_TOKEN }));
    } catch (e) {
      console.error("[tsd] port file write failed:", e && e.message);
    }
    console.error(`[zcode-metrics] listening http://127.0.0.1:${port} pid=${process.pid}`);
  })
  .catch((e) => {
    console.error("[zcode-metrics] bind failed:", e && e.message);
    process.exit(1);
  });

function cleanup() {
  try { unlinkSync(PORT_FILE); } catch {}
  try {
    const { pid } = JSON.parse(readFileSync(BADGE_PID_FILE, "utf8"));
    if (pid) process.kill(pid, "SIGTERM");
  } catch {}
  try { unlinkSync(BADGE_PID_FILE); } catch {}
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
process.on("uncaughtException", (e) => console.error("[tsd] uncaught:", e && e.stack));
