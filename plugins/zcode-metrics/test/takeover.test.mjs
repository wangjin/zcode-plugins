// takeover.test.mjs · 集成测试：hook 保活 + 版本比较 + 升级接管
// 运行：node --test test/takeover.test.mjs
// 隔离：每次用独立 tmp 数据目录 + 高位端口段（473x），不碰真实 4521~4524 实例。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(__dirname, "..");
const ENSURE = path.join(PLUGIN_ROOT, "hooks", "ensure.mjs");
const OWN_VERSION = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, ".zcode-plugin", "plugin.json"), "utf8")).version;

const BASE_PORT = 4731; // 与真实实例（4521~4524）隔离
let portCursor = 0;
const nextPort = () => BASE_PORT + portCursor++;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (port, p) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(2000) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const runEnsure = (env, args = ["session_start", "false"]) =>
  new Promise((resolve) => {
    execFile(process.execPath, [ENSURE, ...args], { env: { ...process.env, ...env }, timeout: 15000 },
      (err, stdout) => resolve({ err, stdout }));
  });
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid, ms) => { const d = Date.now() + ms; while (Date.now() < d) { if (!pidAlive(pid)) return true; await sleep(50); } return !pidAlive(pid); };
const waitAlive = async (pid, ms) => { const d = Date.now() + ms; while (Date.now() < d) { if (pidAlive(pid)) return true; await sleep(50); } return pidAlive(pid); };
// 等 hook 拉起的 server 在数据目录写下 port.json（冷启动会覆盖旧文件）
const waitPortFileFresh = async (dir, excludePid, ms = 8000) => {
  const f = path.join(dir, "port.json");
  const d = Date.now() + ms;
  while (Date.now() < d) {
    try {
      const pf = JSON.parse(readFileSync(f, "utf8"));
      if (pf.pid && pf.pid !== excludePid && pidAlive(pf.pid)) return pf;
    } catch {}
    await sleep(60);
  }
  return null;
};

function makeTmpData() {
  const dir = mkdtempSync(path.join(tmpdir(), "zm-test-"));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

test("冷启动：ensure 拉起新 server，port.json 版本与 plugin.json 一致", async () => {
  const { dir, cleanup } = makeTmpData();
  const port = nextPort();
  try {
    const r = await runEnsure({ ZCODE_PLUGIN_DATA: dir, TSD_PORT: String(port) });
    assert.equal(r.err, null, `ensure 退出异常: ${r.err && r.err.message}`);
    assert.equal(r.stdout.trim(), "{}", "stdout 只允许 {}");
    const pf = JSON.parse(readFileSync(path.join(dir, "port.json"), "utf8"));
    assert.equal(pf.version, OWN_VERSION);
    const h = await getJson(pf.port, "/health");
    assert.equal(h.body.version, OWN_VERSION, "/health 版本必须来自 plugin.json");
    process.kill(pf.pid, "SIGTERM");
    assert.ok(await waitGone(pf.pid, 3000));
  } finally { cleanup(); }
});

test("同版本复用：二次 ensure 不重启（pid 不变）", async () => {
  const { dir, cleanup } = makeTmpData();
  const port = nextPort();
  const env = { ZCODE_PLUGIN_DATA: dir, TSD_PORT: String(port) };
  try {
    await runEnsure(env);
    const pf1 = JSON.parse(readFileSync(path.join(dir, "port.json"), "utf8"));
    const r2 = await runEnsure(env);
    assert.equal(r2.stdout.trim(), "{}");
    const pf2 = JSON.parse(readFileSync(path.join(dir, "port.json"), "utf8"));
    assert.equal(pf2.pid, pf1.pid, "同版本必须复用既有 daemon，不得重启");
    process.kill(pf1.pid, "SIGTERM");
    assert.ok(await waitGone(pf1.pid, 3000));
  } finally { cleanup(); }
});

test("接管带 token 的旧实例：/shutdown 协作退出 → 新实例占用同一端口", async () => {
  const { dir, cleanup } = makeTmpData();
  const port = nextPort();
  try {
    // 伪造一个"旧版"实例：版本不同 + 带 shutdownToken（走 /shutdown 协作路径）
    const fake = `
      import http from "node:http";
      import { writeFileSync, unlinkSync } from "node:fs";
      const s = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") { res.setHeader("Content-Type","application/json"); return res.end(JSON.stringify({ ok: true, pid: process.pid, version: "9.9.9-OLD" })); }
        if (req.method === "POST" && req.url === "/shutdown") {
          if (req.headers["x-shutdown-token"] !== "test-token") { res.statusCode = 403; return res.end('{"ok":false}'); }
          res.end('{"ok":true}');
          setTimeout(() => { try { unlinkSync(process.env.PF); } catch {} process.exit(0); }, 30);
        }
        res.statusCode = 404; res.end();
      });
      s.listen(Number(process.env.FAKE_PORT), "127.0.0.1", () => {
        writeFileSync(process.env.PF, JSON.stringify({ port: Number(process.env.FAKE_PORT), pid: process.pid, version: "9.9.9-OLD", shutdownToken: "test-token" }));
      });
    `;
    const fakeFile = path.join(dir, "fake-old-server.mjs");
    writeFileSync(fakeFile, fake);
    const { spawn } = await import("node:child_process");
    const oldProc = spawn(process.execPath, [fakeFile], {
      env: { ...process.env, FAKE_PORT: String(port), PF: path.join(dir, "port.json") },
      stdio: "ignore",
    });
    assert.ok(await waitAlive(oldProc.pid, 4000), "伪造旧实例启动失败");
    // 等它把 port.json 写好
    for (let i = 0; i < 50; i++) { try { JSON.parse(readFileSync(path.join(dir, "port.json"), "utf8")); break; } catch { await sleep(60); } }

    const r = await runEnsure({ ZCODE_PLUGIN_DATA: dir, TSD_PORT: String(port) });
    assert.equal(r.stdout.trim(), "{}");
    assert.ok(await waitGone(oldProc.pid, 5000), "带 token 的旧实例应经 /shutdown 协作退出");
    const pf = await waitPortFileFresh(dir, oldProc.pid);
    assert.ok(pf, "接管后应出现新实例的 port.json");
    assert.equal(pf.port, port, "接管后端口应回到基准端口（不被旧实例占位漂移）");
    assert.equal(pf.version, OWN_VERSION);
    process.kill(pf.pid, "SIGTERM");
    assert.ok(await waitGone(pf.pid, 3000));
  } finally { cleanup(); }
});

test("接管无 token 的老实例：/shutdown 缺席 → SIGTERM 兜底", async () => {
  const { dir, cleanup } = makeTmpData();
  const port = nextPort();
  try {
    const fake = `
      import http from "node:http";
      import { writeFileSync } from "node:fs";
      const s = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") { res.setHeader("Content-Type","application/json"); return res.end(JSON.stringify({ ok: true, pid: process.pid, version: "0.3.0" })); }
        res.statusCode = 404; res.end(); // 无 /shutdown：模拟 0.4.0 及更早版本
      });
      s.listen(Number(process.env.FAKE_PORT), "127.0.0.1", () => {
        writeFileSync(process.env.PF, JSON.stringify({ port: Number(process.env.FAKE_PORT), pid: process.pid, version: "0.3.0" }));
      });
    `;
    const fakeFile = path.join(dir, "fake-legacy-server.mjs");
    writeFileSync(fakeFile, fake);
    const { spawn } = await import("node:child_process");
    const oldProc = spawn(process.execPath, [fakeFile], {
      env: { ...process.env, FAKE_PORT: String(port), PF: path.join(dir, "port.json") },
      stdio: "ignore",
    });
    assert.ok(await waitAlive(oldProc.pid, 4000), "伪造老实例启动失败");
    for (let i = 0; i < 50; i++) { try { JSON.parse(readFileSync(path.join(dir, "port.json"), "utf8")); break; } catch { await sleep(60); } }

    const r = await runEnsure({ ZCODE_PLUGIN_DATA: dir, TSD_PORT: String(port) });
    assert.equal(r.stdout.trim(), "{}");
    assert.ok(await waitGone(oldProc.pid, 5000), "无 token 老实例应被 SIGTERM 兜底终止");
    const pf = await waitPortFileFresh(dir, oldProc.pid);
    assert.ok(pf, "接管后应出现新实例的 port.json");
    assert.equal(pf.version, OWN_VERSION);
    process.kill(pf.pid, "SIGTERM");
    assert.ok(await waitGone(pf.pid, 3000));
  } finally { cleanup(); }
});

test("/health 版本一致性：server 报的版本 === plugin.json === hook 比较基准", async () => {
  const { dir, cleanup } = makeTmpData();
  const port = nextPort();
  try {
    await runEnsure({ ZCODE_PLUGIN_DATA: dir, TSD_PORT: String(port) });
    const pf = JSON.parse(readFileSync(path.join(dir, "port.json"), "utf8"));
    const h = await getJson(pf.port, "/health");
    assert.equal(h.body.version, OWN_VERSION, "回归 R1：/health 不再是硬编码 0.3.0");
    assert.equal(h.body.pid, pf.pid);
    process.kill(pf.pid, "SIGTERM");
    assert.ok(await waitGone(pf.pid, 3000));
  } finally { cleanup(); }
});
