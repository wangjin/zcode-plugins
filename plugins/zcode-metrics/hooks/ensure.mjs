// zcode-metrics · Hook 子进程：幂等保活收集器 + 转发 hook 事件 + 升级接管
// 用法：node ensure.mjs <kind> [openDashboard]   （stdin: hook JSON 一行）
// 预算：fetch 400ms + spawn 后等待 ≤700ms；接管路径额外 ≤(1500+500)ms，总时长 < hooks.json timeoutMs(1500/3000)。
// 纪律：stdout 只输出一行 "{}"（不向模型注入任何内容），诊断走 stderr，任何异常退出码 0。
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { openSync, mkdirSync, closeSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "dashboard", "server.mjs");
const DATA_DIR =
  process.env.ZCODE_PLUGIN_DATA ||
  path.join(os.homedir(), ".zcode", "plugin-data", "zcode-metrics");
const PORT_FILE = path.join(DATA_DIR, "port.json");

// 本 hook 随插件分发：版本以 plugin.json 为唯一事实源，与 server /health 同源可比
function ownVersion() {
  try {
    const m = JSON.parse(readFileSync(path.join(__dirname, "..", ".zcode-plugin", "plugin.json"), "utf8"));
    if (typeof m.version === "string" && m.version) return m.version;
  } catch { /* ignore */ }
  return "0.0.0";
}
const OWN_VERSION = ownVersion();

const kind = process.argv[2] || "user_prompt_submit";
// 第三个参数来自 hooks.json 的 ${user_config.openDashboard} 模板替换
const openDashboard = (process.argv[3] || "true") !== "false";

async function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { raw += c; if (raw.length > 2 * 1024 * 1024) process.stdin.destroy(); });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", () => resolve(raw));
    setTimeout(() => resolve(raw), 350).unref(); // stdin 可能空/挂起，兜底
  });
}

async function fetchJson(url, opts, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function portFile() {
  return readFile(PORT_FILE, "utf8").then((s) => JSON.parse(s)).catch(() => null);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(60);
  }
  return !pidAlive(pid);
}

// 探活 + 取版本：返回 { port, version }（version 可能为 ""，即老版本无 /health version 字段）；不健康返回 null
async function probeServer() {
  const pf = await portFile();
  if (!pf || !pf.port) return null;
  if (!pidAlive(pf.pid)) return null; // pid 死了直接重拉
  try {
    const res = await fetchJson(`http://127.0.0.1:${pf.port}/health`, {}, 400);
    if (res.ok) {
      const h = await res.json().catch(() => ({}));
      return { port: pf.port, version: typeof h.version === "string" ? h.version : "" };
    }
  } catch { /* fallthrough */ }
  return null;
}

// 升级接管：请旧实例退出。优先带 token 走 /shutdown（协作式，自清 port.json）；
// 旧版本无此端点/无 token/超时 → SIGTERM 兜底。全程有硬预算，超时不阻塞 hook。
async function shutdownOldInstance(pf) {
  if (pf.shutdownToken && pf.port) {
    try {
      await fetchJson(
        `http://127.0.0.1:${pf.port}/shutdown`,
        { method: "POST", headers: { "X-Shutdown-Token": pf.shutdownToken } },
        400
      );
    } catch { /* 旧版无端点：直接走 SIGTERM */ }
    if (await waitPidGone(pf.pid, 600)) return;
  }
  try { process.kill(pf.pid, "SIGTERM"); } catch { /* 已退出 */ }
  await waitPidGone(pf.pid, 400);
}

let spawned = false;
function serverLogFd() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    return openSync(path.join(DATA_DIR, "server.log"), "a");
  } catch {
    return "ignore";
  }
}
function spawnServer() {
  if (spawned) return;
  spawned = true;
  try {
    const fd = serverLogFd();
    const child = spawn(process.execPath, [SERVER], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, ZCODE_PLUGIN_DATA: DATA_DIR },
    });
    child.on("error", () => {});
    child.unref();
    if (typeof fd === "number") { try { closeSync(fd); } catch {} }
  } catch { /* node 缺失等极端情况：静默失败，会话不受影响 */ }
}

async function postEvent(port, payload) {
  try {
    await fetchJson(
      `http://127.0.0.1:${port}/internal/event`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      400
    );
    return true;
  } catch {
    return false;
  }
}

async function ensureUpToDate() {
  // 返回可用端口；探活命中且版本一致 → 复用；版本落后（含老进程无 version 字段）→ 接管后重开
  const probe = await probeServer();
  if (!probe) return null; // 不健康：交给冷启动 spawn
  if (probe.version === OWN_VERSION) return probe.port; // 版本一致：复用，不重启（多会话共用同一 daemon）
  // 版本不符：旧进程 serve 的是旧代码/旧页面，接管（关旧 → 起新，端口回到基准最低空闲位）
  const pf = await portFile();
  if (pf && pf.pid) await shutdownOldInstance(pf);
  return null; // 触发冷启动 spawn
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch {}

  const payload = {
    kind,
    openDashboard,
    sessionId: input.session_id || input.sessionId || null,
    ts: Date.now(),
  };
  // Stop 事件带最后一条助手消息：仅透传内容给 server 计数（server 端只取长度估算，不留存）
  if (kind === "stop" && typeof input.last_assistant_message === "string") {
    payload.lastAssistantMessage = input.last_assistant_message;
  }

  let port = await ensureUpToDate();
  if (!port) {
    spawnServer();
    // 等待就绪：≤700ms 轮询 port 文件 + /health
    const deadline = Date.now() + 700;
    while (Date.now() < deadline) {
      await sleep(80);
      const probe = await probeServer();
      if (probe && probe.version === OWN_VERSION) { port = probe.port; break; }
    }
    if (!port) return; // server 起不来：静默退出（exit 0 = 会话无感知）
  }
  await postEvent(port, payload);
}

main().catch((e) => {
  try { process.stderr.write(`[tsd-ensure] ${e && e.message}\n`); } catch {}
}).finally(() => {
  // stdout 协议纪律：process 型 hook 必须给出合法 JSON 或空输出。
  // 返回空对象 = 无权限决策、无 additionalContext，绝不污染模型上下文。
  try { process.stdout.write("{}"); } catch {}
  process.exit(0);
});
