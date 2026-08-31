// token-speed-dashboard · 常驻收集器：tail rollout → 状态机 → HTTP/SSE 仪表盘
// 零依赖，仅监听 127.0.0.1。由 hooks/ensure.mjs 幂等拉起，不建议直接手动运行。
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { watch, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { RolloutTail, ROLLOUT_DIR } from "./rollout.mjs";
import { newState, applyEvent, applyRecord, tick, snapshot } from "./state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "0.1.0";
const BASE_PORT = Number(process.env.TSD_PORT || 4521);
const PORT_TRIES = 10;
const DATA_DIR =
  process.env.ZCODE_PLUGIN_DATA ||
  path.join(os.homedir(), ".zcode", "plugin-data", "token-speed-dashboard");
const PORT_FILE = path.join(DATA_DIR, "port.json");
const HTML_FILE = path.join(__dirname, "index.html");

const state = newState();
state.version = VERSION;
const clients = new Set();
let htmlCache = null;

/* ---------------- rollout tail ---------------- */
const tail = new RolloutTail(ROLLOUT_DIR, { skipOlderThan: Date.now() });
let polling = false;
async function pollRollout() {
  if (polling) return;
  polling = true;
  try {
    const recs = await tail.poll();
    for (const r of recs) applyRecord(state, r);
    if (recs.length) broadcast();
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
ensureWatcher();
const pollTimer = setInterval(() => { ensureWatcher(); pollRollout(); }, 2000);
pollRollout();

/* ---------------- 心跳：生成中每秒刷新 + 僵尸 turn 收尾 ---------------- */
const beatTimer = setInterval(() => {
  tick(state);
  if (state.turn.active) broadcast();
}, 1000);

function broadcast() {
  if (!clients.size) return;
  const payload = `event: state\ndata: ${JSON.stringify(snapshot(state))}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
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
    if (req.method === "GET" && url.pathname === "/health") {
      return send(200, "application/json", JSON.stringify({ ok: true, pid: process.pid, port: state.server.port, version: VERSION }));
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return send(200, "application/json", JSON.stringify(snapshot(state)));
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      res.write(`event: state\ndata: ${JSON.stringify(snapshot(state))}\n\n`);
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
      if (ev.kind === "session_start" && ev.openDashboard !== false) maybeOpenDashboard();
      pollRollout(); // 提交后立即拉一次增量，不等 2s 轮询
      broadcast();
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
      await writeFile(PORT_FILE, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString(), version: VERSION }));
    } catch (e) {
      console.error("[tsd] port file write failed:", e && e.message);
    }
    console.error(`[token-speed-dashboard] listening http://127.0.0.1:${port} pid=${process.pid}`);
  })
  .catch((e) => {
    console.error("[token-speed-dashboard] bind failed:", e && e.message);
    process.exit(1);
  });

function cleanup() {
  try { unlinkSync(PORT_FILE); } catch {}
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
process.on("uncaughtException", (e) => console.error("[tsd] uncaught:", e && e.stack));
