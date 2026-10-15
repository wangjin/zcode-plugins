/* zcode-metrics · 状态条注入 loader v1（主进程）。
 * 由 patch_install.py 在 app.asar 入口尾部追加一行 dynamic import 引入。
 * 职责：
 *   1) 向每个 window 类型 webContents 注入 overlay.js（mtime 变化热更新，免重启）；
 *   2) 触发式拉取：fs.watch 监听 db 目录，db.sqlite/-wal 一有写入（去抖 300ms）就查询并
 *      推送。限频 config.activity_min_ms（默认 1500ms），限频到点自动补拉，最后一笔写入
 *      不漏；完全空闲时零进程零轮询，仅兜底心跳（config.heartbeat_ms，默认 30s）防文件
 *      事件丢失。任何失败只打日志，不影响客户端。
 *   3) 每窗口当前会话：渲染端经客户端自带 IPC 通道 "zcode:sync-active-task-session"
 *      （本机 asar /out/main/chunk-OW6EUS2G.js 实测）把焦点会话 id 推给主进程，这里追加
 *      监听记录 webContents.id → 会话 id；查询时把全部窗口的会话强制纳入快照，推送时给
 *      每个窗口注入 mine 字段——多窗口各自显示自己的会话。
 *   4) 查询走常驻 python（query.py serve，stdin/stdout 行协议），省每次解释器启动费；
 *      意外退出自动重启（30s 内连续 3 次判不稳定则回退一次性 spawn）；query.py mtime
 *      变化自动重启。机制移植自 ByteRax/zcode-token-usage-statusbar，命名空间 zcm。 */
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { app, webContents } = require("electron");

const HERE = __dirname;   // 被 asar 注入行按绝对 file:// URL import，__dirname 即运行时目录
const CONFIG = path.join(HERE, "config.json");
const OVERLAY = path.join(HERE, "overlay.js");
const QUERY = path.join(HERE, "query.py");
const LOG = (...a) => console.error("[zcm]", ...a);

/* config.json 内容缓存：热更新定时器每 2s stat mtime 判变化后才读文件 */
let cfgMtime = 0;
let cfgCache = null;
function readCfgCached() {
  let m = 0;
  try { m = fs.statSync(CONFIG).mtimeMs; } catch (e) { }
  if (!cfgCache || m !== cfgMtime) {
    cfgMtime = m;
    cfgCache = readCfg();
  }
  return cfgCache;
}
function readCfg() {
  const c = { python_path: "python3", resident: true };
  try { Object.assign(c, JSON.parse(fs.readFileSync(CONFIG, "utf8"))); } catch (e) { }
  return c;
}

/* overlay 注入源 + 热更新：mtime 变了就重注入（移除旧条 + 复位代际守卫）。
 * 载入前用 new Function 校验语法，避免把写到一半的文件载入页面。 */
let overlaySrc = "";
let overlayMtime = 0;
try {
  overlaySrc = fs.readFileSync(OVERLAY, "utf8");
  overlayMtime = fs.statSync(OVERLAY).mtimeMs;
} catch (e) { LOG("overlay.js missing:", e.message); }

function hotReloadIfChanged() {
  let m = 0, src = "";
  try {
    m = fs.statSync(OVERLAY).mtimeMs;
    src = fs.readFileSync(OVERLAY, "utf8");
  } catch (e) { return; }
  if (m === overlayMtime) return;
  try { new Function(src); } catch (e) { LOG("overlay.js syntax not ready, skip:", e.message); return; }
  overlayMtime = m;
  overlaySrc = src;
  LOG("overlay.js changed, hot-reloading");
  for (const wc of webContents.getAllWebContents()) {
    if (!isMainWindowState(wc) || wc.isDestroyed()) continue;
    wc.executeJavaScript(
      '(function(){var b=document.getElementById("zcm-bar");if(b)b.remove();var t=document.getElementById("zcm-tip");if(t)t.remove();window.__zcodeMetricsOverlay=false;})()', true
    ).catch(() => { });
    injectOverlay(wc);
  }
}

function isMainWindowState(wc) {
  try { return wc.getType() === "window"; } catch (e) { return false; }
}

function pushOnce(wc, payload) {
  if (!isMainWindowState(wc) || wc.isDestroyed() || !payload || typeof payload !== "object") return;
  /* 按窗口注入 mine（本窗口焦点会话 id，空串 = 该窗口当前无会话）：overlay 收到 mine 就
   * 优先显示它。必须对象合并后整体序列化，禁止对 JSON 字符串做括号手术（参考项目实测翻车）。
   * U+2028/2029 转义：JSON.stringify 会输出裸字符，放进 executeJavaScript 字符串字面量有语法风险。 */
  const obj = activeSid.has(wc.id) ? Object.assign({}, payload, { mine: activeSid.get(wc.id) || "" }) : payload;
  const js = `window.__zcodeMetricsUpdate && window.__zcodeMetricsUpdate(${JSON.stringify(obj).replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"))})`;
  wc.executeJavaScript(js, true).catch(() => { });
}

/* 每窗口焦点会话：客户端渲染端把 activeTaskId 经此通道同步给主进程（CUA PiP 所用通道），
 * 追加监听器不影响原有处理。值为 "" = 窗口已同步但当前无会话；
 * 不在表里 = 该窗口从未同步（辅助窗口），推送时不带 mine。 */
const IPC_ACTIVE_SID = "zcode:sync-active-task-session";
const activeSid = new Map();   // webContents.id → 会话 id 或 ""
try {
  const { ipcMain } = require("electron");
  ipcMain.on(IPC_ACTIVE_SID, (e, sid) => {
    if (!e || !e.sender || e.sender.isDestroyed()) return;
    const s = typeof sid === "string" ? sid.trim() : "";
    const val = s && s.length <= 255 && /^[A-Za-z0-9_-]+$/.test(s) ? s : "";
    const prev = activeSid.get(e.sender.id);
    activeSid.set(e.sender.id, val);
    if (prev !== val) scheduleRetry(800);   // 会话切换：尽快按新会话拉一次（限频器仍生效）
  });
} catch (e) { LOG("ipc hook failed:", e.message); }

/* db 活动戳：db.sqlite / -wal / -shm 的最新 mtime。WAL 模式下写入主要落在 -wal。 */
let DB_DIR = null;
function dbDir() {
  if (!DB_DIR) DB_DIR = path.join(app.getPath("home"), ".zcode", "cli", "db");
  return DB_DIR;
}
function dbStamp() {
  let m = 0;
  const dir = dbDir();
  for (const f of ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"]) {
    try { m = Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs); } catch (e) { }
  }
  return m;
}

let busy = false;
let lastSpawn = 0;    // 上次发起查询时刻（限频用）
let lastStamp = 0;    // 上次拉取时的 db mtime（去重：无新写入不拉）
let lastWants = "";   // 上次查询用的会话 id 集合（变化即拉，防"会话切了但 db 没写入"滞留旧数据）

function handlePayload(payload) {
  if (!payload || typeof payload !== "object") return;
  for (const wc of webContents.getAllWebContents()) pushOnce(wc, payload);
}

/* ---------- 常驻查询进程：query.py serve，stdin 请求行 / stdout 响应行 ---------- */
let pyRes = null;        // { proc, buf, waiters: [], born }
let pyFail = 0;          // 启动 30s 内退出次数（>=3 判不稳定，回退一次性 spawn）
let pyBackoff = 1000;
let pyRestarting = false;

function startResident() {
  if (pyRes) return;
  const proc = spawn(readCfg().python_path, [path.join(HERE, "query.py"), "serve"], { windowsHide: true });
  const state = { proc, buf: "", waiters: [], born: Date.now() };
  pyRes = state;
  LOG("resident query.py starting");
  proc.stdout.on("data", (d) => {
    state.buf += d.toString("utf8");
    let i;
    while ((i = state.buf.indexOf("\n")) >= 0) {
      const line = state.buf.slice(0, i);
      state.buf = state.buf.slice(i + 1);
      const w = state.waiters.shift();
      if (!w) continue;
      let payload = null;
      try { payload = JSON.parse(line); } catch (e) { }
      w(payload);
    }
  });
  proc.stderr.on("data", () => { });
  proc.on("close", () => {
    if (pyRes === state) pyRes = null;
    const pending = state.waiters;
    state.waiters = [];
    pending.forEach((w) => w(null));   // 挂起请求失败收场，泵侧等下一笔写入/心跳补拉
    if (pyRestarting) { pyRestarting = false; startResident(); return; }
    if (Date.now() - state.born < 30000) {   // 早期崩溃：退避重启，3 次判不稳定
      pyFail++;
      if (pyFail >= 3) { LOG("resident unstable (3 early exits), fallback to one-shot spawn"); return; }
      setTimeout(startResident, pyBackoff);
      pyBackoff = Math.min(pyBackoff * 2, 30000);
    } else {   // 长跑后退出（升级/外部误杀）：立即重启，不计失败
      pyFail = 0;
      pyBackoff = 1000;
      startResident();
    }
  });
}

function killResidentForUpgrade() {
  if (!pyRes) return;
  pyRestarting = true;
  try { pyRes.proc.kill(); } catch (e) { }
}

/* 统一查询入口：resident 可用走行协议，否则一次性 spawn */
function runQuery(wants) {
  busy = true;
  const done = (payload) => {
    busy = false;
    if (payload) handlePayload(payload);
    // 失败不原地重试：下一笔 db 写入/心跳会再拉，最多滞后一个心跳
  };
  if (readCfgCached().resident !== false && pyFail < 3) {
    if (!pyRes) startResident();
    if (pyRes && pyRes.proc.stdin.writable) {
      const state = pyRes;
      const timer = setTimeout(() => {
        LOG("resident query timeout, restarting it");
        pyRestarting = true;
        try { state.proc.kill(); } catch (e) { }
        done(null);
      }, 15000);
      state.waiters.push((payload) => { clearTimeout(timer); done(payload); });
      try { state.proc.stdin.write((wants || "") + "\n"); } catch (e) { }
      return;
    }
  }
  legacySpawn(wants);
}

/* 回退路径（一次性 spawn） */
function legacySpawn(wants) {
  const args = [path.join(HERE, "query.py"), "json"];
  if (wants && /^[A-Za-z0-9_,-]{1,600}$/.test(wants)) args.push(wants);
  const py = spawn(readCfg().python_path, args, { windowsHide: true });
  let out = "";
  const killTimer = setTimeout(() => { LOG("query timeout, killing"); try { py.kill(); } catch (e) { } }, 15000);
  py.stdout.on("data", (d) => { out += d; });
  py.on("error", (e) => { busy = false; LOG("spawn failed:", e.message); });
  py.on("close", () => {
    clearTimeout(killTimer);
    busy = false;
    if (out.trim()) {
      let payload;
      try { payload = JSON.parse(out); } catch (e) { payload = null; }
      if (payload) handlePayload(payload);
    }
  });
}

/* 触发式拉取：db 有新写入（mtime 变化）才查询；限频不满足时安排补拉，
 * 保证限频窗口结束后最后一笔写入的数据一定被取到。 */
let retryTimer = 0;
function scheduleRetry(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(maybeSpawn, ms);
}
function maybeSpawn() {
  if (busy) { scheduleRetry(300); return; }
  const st = dbStamp();
  const wait = Math.max(300, readCfgCached().activity_min_ms | 0 || 1500);
  /* 汇总全部窗口的当前会话 id：主进程 IPC 映射（应用自己上报的焦点会话）优先，
   * overlay 从 localStorage/pane 读回的 __zcodeMetricsWantSids 兜底；无窗口时直接短路
   * （空闲零进程的设计意图）。executeJavaScript 挂 1s 超时防渲染进程卡死。 */
  const wcs = webContents.getAllWebContents().filter((wc) => isMainWindowState(wc) && !wc.isDestroyed());
  if (!wcs.length) return;
  const readWantsJs = "(function(){var a=window.__zcodeMetricsWantSids;return JSON.stringify(Array.isArray(a)?a:[])})()";
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r("[]"), ms))]);
  Promise.all(wcs.map((wc) => withTimeout(wc.executeJavaScript(readWantsJs, true).catch(() => "[]"), 1000)))
    .then((vals) => {
      const wants = [];
      const push = (sid) => { if (sid && /^[A-Za-z0-9_-]{1,80}$/.test(sid) && !wants.includes(sid)) wants.push(sid); };
      wcs.forEach((wc, i) => {
        if (activeSid.has(wc.id)) push(activeSid.get(wc.id) || "");
        let arr = [];
        try { arr = JSON.parse(vals[i] || "[]"); } catch (e) { }
        if (Array.isArray(arr)) arr.forEach(push);
      });
      const key = wants.join(",");
      if (key === lastWants && st && st === lastStamp) return;   // 会话与数据都没变：零进程
      const now = Date.now();
      if (now - lastSpawn < wait) { scheduleRetry(wait - (now - lastSpawn) + 50); return; }
      lastWants = key;
      if (st) lastStamp = st;
      lastSpawn = now;
      runQuery(key);
    })
    .catch(() => { });
}

/* 监听 db 目录：WAL/主库一有写入立刻（去抖 300ms）触发拉取；完全空闲时零进程零轮询 */
let debounceTimer = 0;
let dbWatcher = null;
function watchDb() {
  if (dbWatcher) return;
  try {
    dbWatcher = fs.watch(dbDir(), (ev, f) => {
      if (f && !/db\.sqlite/.test(f)) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(maybeSpawn, 300);
    });
    dbWatcher.on("error", () => {
      LOG("db watcher error, re-arm in 5s");
      try { dbWatcher.close(); } catch (e) { }
      dbWatcher = null;
      setTimeout(watchDb, 5000);
    });
    LOG("watching", dbDir());
  } catch (e) {
    LOG("fs.watch failed, retry in 5s:", e.message);
    setTimeout(watchDb, 5000);
  }
}

/* overlay / query.py 热更新检查（stat mtime）；config.hot_reload=false 可关闭。
 * query.py 变化时重启常驻进程；顺带 stat config mtime。 */
let overlayMtimeKnown = false;
let queryMtime = 0;
setInterval(() => {
  const cfg = readCfgCached();
  if (cfg.hot_reload === false) return;
  hotReloadIfChanged();
  try {
    const m = fs.statSync(QUERY).mtimeMs;
    if (overlayMtimeKnown && m !== queryMtime && pyRes) {
      LOG("query.py changed, restarting resident python");
      killResidentForUpgrade();
    }
    queryMtime = m;
    overlayMtimeKnown = true;
  } catch (e) { }
}, 2000);
setInterval(maybeSpawn, Math.max(10000, readCfg().heartbeat_ms | 0 || 30000));   // 兜底心跳
watchDb();
maybeSpawn();   // 启动先拉一次

function injectOverlay(wc) {
  if (!overlaySrc || !isMainWindowState(wc)) return;
  wc.executeJavaScript(overlaySrc, true).catch(() => { });
}

const hook = (wc) => {
  if (!isMainWindowState(wc)) return;
  wc.on("did-finish-load", () => injectOverlay(wc));
  if (wc.isLoading()) return;
  injectOverlay(wc);
};
app.on("web-contents-created", (e, wc) => hook(wc));
for (const wc of webContents.getAllWebContents()) hook(wc);

LOG("zcode-metrics statusbar injected v1 (resident query mode, per-window mine, overlay hot reload)");
