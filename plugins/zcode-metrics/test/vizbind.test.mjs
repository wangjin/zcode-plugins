// vizbind 单测：birthtime join 解析、容差、坏目录过滤、viz-map 缓存读写、绑定失败阶梯退避
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVizDir, createVizMap, createVizBinder, VIZ_RETRY_MS } from "../dashboard/vizbind.mjs";

function fakeDeps({ dirs, createds, sqliteOk = true }) {
  // dirs: { "64hex": birthtimeMs }；createds: [ms]（模拟 tasks 表多行）
  return {
    readdir: () => Object.keys(dirs),
    stat: (p) => {
      const name = p.split("/").pop();
      if (!(name in dirs)) throw new Error("ENOENT");
      return { birthtimeMs: dirs[name] };
    },
    exec: () => (sqliteOk ? createds.join("\n") + "\n" : null),
  };
}
const hex = (c) => c.repeat(64);

test("容差内取 |Δ| 最小者；非 64hex 目录与容差外目录不参与", () => {
  const t0 = 1_700_000_000_000;
  const near = hex("a"), nearer = hex("b"), far = hex("c"), illegal = "not-hex-dir";
  const deps = fakeDeps({
    dirs: { [near]: t0 + 3000, [nearer]: t0 + 150, [far]: t0 + 60_000, [illegal]: t0 + 100 },
    createds: [t0],
  });
  const hit = resolveVizDir("sess_x", { vizRoot: "/viz", tasksIndex: "/db", deps });
  assert.equal(hit.dirName, nearer);
  assert.equal(hit.dir, "/viz/" + nearer);
});

test("sqlite 不可用 / 无 DB 行 / viz 根不存在 / 空 sessionId → null（不抛）", () => {
  const t0 = 1_700_000_000_000;
  assert.equal(resolveVizDir("sess_x", { vizRoot: "/viz", tasksIndex: "/db", deps: fakeDeps({ dirs: { [hex("a")]: t0 }, createds: [], sqliteOk: false }) }), null);
  assert.equal(resolveVizDir("sess_x", { vizRoot: "/viz", tasksIndex: "/db", deps: fakeDeps({ dirs: { [hex("a")]: t0 }, createds: [] }) }), null);
  const gone = fakeDeps({ dirs: {}, createds: [t0] });
  gone.readdir = () => { throw new Error("ENOENT"); };
  assert.equal(resolveVizDir("sess_x", { vizRoot: "/viz", tasksIndex: "/db", deps: gone }), null);
  assert.equal(resolveVizDir("", { vizRoot: "/viz", tasksIndex: "/db", deps: fakeDeps({ dirs: {}, createds: [] }) }), null);
});

test("task 跨工作区多行 created_at：任一行命中即可", () => {
  const t0 = 1_700_000_000_000;
  const hit = resolveVizDir("sess_x", {
    vizRoot: "/viz",
    tasksIndex: "/db",
    deps: fakeDeps({ dirs: { [hex("a")]: t0 + 9_500 }, createds: [t0 - 99_000, t0] }),
  });
  assert.equal(hit.dirName, hex("a"));
});

test("viz-map：load 兼容坏文件，set 持久化并在重建后可读；非绝对路径条目被丢弃", () => {
  let files = {};
  const io = {
    readFileSyncImpl: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    writeFileSyncImpl: (p, s) => { files[p] = s; },
    mkdirSyncImpl: () => {},
  };
  files["/data/viz-map.json"] = "{ broken json";
  let m = createVizMap("/data/viz-map.json", io);
  assert.equal(m.size(), 0);
  m.set("sess_a", "/viz/aaa");
  m = createVizMap("/data/viz-map.json", io); // 重建读回
  assert.equal(m.get("sess_a"), "/viz/aaa");

  files["/data/viz-map.json"] = JSON.stringify({ sess_b: "relative/path", sess_c: "/viz/ccc" });
  m = createVizMap("/data/viz-map.json", io);
  assert.equal(m.get("sess_b"), null, "相对路径丢弃");
  assert.equal(m.get("sess_c"), "/viz/ccc");
});

// —— createVizBinder：失败阶梯退避 + force 绕过（修复"新会话首绑瞬态失败 → 卡片 5min 不出现"）——
const memMap = () => {
  const store = new Map();
  return { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v), delete: (k) => store.delete(k) };
};

test("binder：成功即缓存不再调 resolve；退避窗口内不重试，阶梯到期才重试", () => {
  let t = 1_700_000_000_000, calls = 0, ok = false;
  const b = createVizBinder({ map: memMap(), now: () => t, resolve: () => { calls++; return ok ? "/viz/a" : null; } });
  assert.equal(b.bind("a"), null); // 首试失败
  assert.equal(b.bind("a"), null, "2s 退避内不重试");
  assert.equal(calls, 1);
  t += 2_000; // 阶梯第 1 级到期
  ok = true;
  assert.equal(b.bind("a"), "/viz/a", "到期重试成功并缓存");
  assert.equal(b.bind("a"), "/viz/a", "命中缓存不再调 resolve");
  assert.equal(calls, 2);
});

test("binder：连续失败退避逐级拉长 2s/5s/15s/60s，之后固定 5min", () => {
  let t = 0, calls = 0, at = 0; // at = 上次失败时刻
  const b = createVizBinder({ map: memMap(), now: () => t, resolve: () => { calls++; return null; } });
  assert.equal(b.bind("a"), null); // 失败#1
  const ladder = [2_000, 5_000, 15_000, 60_000];
  for (let i = 0; i < ladder.length + 2; i++) {
    const w = i < ladder.length ? ladder[i] : VIZ_RETRY_MS;
    t = at + w - 1;
    assert.equal(b.bind("a"), null, `距上次失败 ${w - 1}ms 不重试`);
    assert.equal(calls, i + 1);
    at += w; t = at;
    assert.equal(b.bind("a"), null, `到期 ${w}ms 重试（仍失败）`);
    assert.equal(calls, i + 2);
  }
});

test("binder：force 绕过退避立即重试；成功后失败计数清零，再次失败从阶梯第 1 级开始", () => {
  let t = 0, calls = 0, ok = false;
  const map = memMap();
  const b = createVizBinder({ map, now: () => t, resolve: () => { calls++; return ok ? "/viz/a" : null; } });
  b.bind("a"); // 失败#1
  assert.equal(b.bind("a", { force: true }), null, "退避内 force 仍立即重试（失败#2）");
  assert.equal(calls, 2);
  t = 100;
  assert.equal(b.bind("a"), null, "非 force 仍受退避约束（count=2 → 等 5s）");
  ok = true;
  assert.equal(b.bind("a", { force: true }), "/viz/a", "force 重试成功");
  map.delete("a"); // 模拟缓存失效
  ok = false; t = 200;
  assert.equal(b.bind("a"), null, "失败#1'（计数已清零）");
  t = 200 + 2_000;
  assert.equal(b.bind("a"), null, "2s 到期即重试——若计数未清零会等 5min");
  assert.equal(calls, 5);
});
