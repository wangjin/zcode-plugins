// vizbind 单测：birthtime join 解析、容差、坏目录过滤、viz-map 缓存读写
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVizDir, createVizMap } from "../dashboard/vizbind.mjs";

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
