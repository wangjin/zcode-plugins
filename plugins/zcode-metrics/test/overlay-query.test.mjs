// 状态条 query.py 口径测试：node --test test/overlay-query.test.mjs
// 用独立小 sqlite 库 + ZCODE_CLI_DB 路径注入（query.py 支持环境变量覆盖 DB 路径），
// 核对 query.py json 输出的会话累计/本轮/速度/上下文窗口/今日合计口径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const overlayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../overlay");
const QUERY = path.join(overlayDir, "query.py");

const SCHEMA = `
CREATE TABLE session (
  id text primary key, project_id text not null, workspace_id text, parent_id text,
  slug text not null, directory text not null, path text, title text not null, version text not null,
  share_url text, summary_additions integer, summary_deletions integer, summary_files integer,
  summary_diffs text, revert text, permission text, time_created integer not null, time_updated integer not null,
  time_compacting integer, time_archived integer
);
CREATE TABLE model_usage (
  id text primary key, logical_request_id text not null, attempt_index integer default 0,
  session_id text not null, turn_id text, trace_id text, span_id text, assistant_message_id text,
  parent_user_message_id text, query_source text not null, provider_id text not null, model_id text not null,
  variant text, agent text, mode text, task_type text, status text not null,
  started_at integer not null, first_token_at integer, completed_at integer, duration_ms integer,
  time_to_first_token_ms integer, finish_reason text, tool_call_count integer default 0,
  input_tokens integer default 0, output_tokens integer default 0, reasoning_tokens integer default 0,
  cache_creation_input_tokens integer default 0, cache_read_input_tokens integer default 0,
  provider_total_tokens integer, computed_total_tokens integer default 0, retry_count integer default 0,
  retryable integer default 0, cancelled_by_user integer default 0, context_exceeded integer default 0,
  error_type text, error_code text, error_message text, raw_usage_json text, provider_metadata_json text
);
CREATE TABLE turn_usage (
  session_id text not null, turn_id text not null, trace_id text, user_message_id text,
  status text not null, started_at integer not null, first_model_start_at integer, first_token_at integer,
  completed_at integer, duration_ms integer, time_to_first_token_ms integer,
  model_request_count integer default 0, model_retry_count integer default 0,
  tool_call_count integer default 0, tool_error_count integer default 0,
  input_tokens integer default 0, output_tokens integer default 0, reasoning_tokens integer default 0,
  cache_creation_input_tokens integer default 0, cache_read_input_tokens integer default 0,
  computed_total_tokens integer default 0, retryable integer default 0, cancelled_by_user integer default 0,
  context_exceeded integer default 0, error_type text, error_code text,
  primary key(session_id, turn_id)
);
CREATE TABLE tool_usage (
  id text primary key, session_id text not null, turn_id text, trace_id text, tool_call_id text not null,
  tool_name text not null, side_effect_scope text, read_only integer, destructive integer,
  approval_status text, status text not null, started_at integer not null, first_output_at integer,
  completed_at integer, duration_ms integer, time_to_first_output_ms integer, exit_code integer,
  output_bytes integer default 0, stdout_bytes integer default 0, stderr_bytes integer default 0,
  truncated integer default 0, retry_count integer default 0, retryable integer default 0,
  cancelled_by_user integer default 0
);
`;

const NOW = Date.now();
const SID = "sess_test_0001";
const SEED = `
INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES
  ('${SID}', 'p', 's', '/tmp/w', '测试会话', '1', ${NOW - 600000}, ${NOW - 1000});
INSERT INTO model_usage (id, logical_request_id, session_id, turn_id, query_source, provider_id, model_id, status, started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms, tool_call_count, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens, retry_count) VALUES
  ('m1', 'lr1', '${SID}', 't1', 'main_turn_msg', 'zai', 'GLM-5.3-Flash-S', 'completed', ${NOW - 50000}, ${NOW - 48000}, ${NOW - 44000}, 6000, 2000, 2, 1000, 600, 100, 50, 900, 2650, 1),
  ('m2', 'lr2', '${SID}', 't2', 'main_turn_msg', 'zai', 'GLM-5.3-Flash-S', 'completed', ${NOW - 10000}, ${NOW - 9000}, ${NOW - 4000}, 5000, 1000, 3, 2000, 400, 0, 0, 1800, 4200, 0),
  ('m3', 'lr3', '${SID}', 't2', 'main_turn_msg', 'zai', 'GLM-5.3-Flash-S', 'error', ${NOW - 9000}, NULL, ${NOW - 8900}, 100, 0, 0, 100, 0, 0, 0, 0, 100, 0);
INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at, duration_ms, time_to_first_token_ms, model_request_count, model_retry_count, tool_call_count, tool_error_count, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens) VALUES
  ('${SID}', 't2', 'completed', ${NOW - 10000}, ${NOW - 4000}, 6000, 1000, 1, 0, 3, 1, 2000, 400, 0, 0, 1800, 4200);
INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at, completed_at, duration_ms) VALUES
  ('x1', '${SID}', 'c1', 'Bash', 'completed', ${NOW - 5000}, ${NOW - 4900}, 100),
  ('x2', '${SID}', 'c2', 'Bash', 'error', ${NOW - 4800}, ${NOW - 4700}, 100),
  ('x3', '${SID}', 'c3', 'Read', 'completed', ${NOW - 4600}, ${NOW - 4500}, 100);
`;

function runQuery(args, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "zcm-q-"));
  const db = path.join(dir, "db.sqlite");
  writeFileSync(db + "-seed.sql", SCHEMA + SEED);
  const r1 = spawnSync("sqlite3", [db], { input: SCHEMA + SEED, encoding: "utf8" });
  if (r1.status !== 0) throw new Error("seed failed: " + r1.stderr);
  const r = spawnSync("python3", [QUERY, ...args], {
    encoding: "utf8",
    env: { ...process.env, ZCODE_CLI_DB: db, ...extraEnv },
    timeout: 20000,
  });
  if (r.status !== 0) throw new Error("query failed: " + r.stderr);
  return JSON.parse(r.stdout);
}

test("query.py：会话累计只计 completed，ctx 取最近 completed 请求的 input", () => {
  const payload = runQuery(["json", SID]);
  const s = payload.recent.find((x) => x.sid === SID);
  assert.ok(s, "会话快照存在");
  assert.equal(s.requests, 2);          // m3 error 不计入
  assert.equal(s.input, 3000);
  assert.equal(s.output, 1000);
  assert.equal(s.tool_calls, 5);        // 2 + 3（m1+m2 的 tool_call_count）
  assert.equal(s.retries, 1);
  assert.equal(s.ctx, 2000);            // 最近 completed = m2
});

test("query.py：last_turn 取 turn_usage 聚合；tps 按生成窗口", () => {
  const payload = runQuery(["json", SID]);
  const s = payload.recent.find((x) => x.sid === SID);
  assert.equal(s.last_turn.requests, 1);
  assert.equal(s.last_turn.output, 400);
  assert.equal(s.last_turn.tool_errors, 1);
  // m2：无思考（reasoning=0 且非 claude），窗口 = completed - first_token = 5000ms，400 token
  assert.equal(s.last.tps, 80);
  assert.equal(s.last.ttft_ms, 1000);
});

test("query.py：子代理按 parent_id + query_source 聚合", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zcm-q-"));
  const db = path.join(dir, "db.sqlite");
  const subSeed = SCHEMA + SEED + `
INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES
  ('sess_subagent_abc', 'p', 'sub', '/tmp/w', '子代理标题', '1', ${NOW - 300000}, ${NOW - 2000});
UPDATE session SET parent_id = '${SID}' WHERE id = 'sess_subagent_abc';
INSERT INTO model_usage (id, logical_request_id, session_id, turn_id, query_source, provider_id, model_id, status, started_at, completed_at, duration_ms, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens) VALUES
  ('s1', 'lrs1', 'sess_subagent_abc', 'st1', 'subagent', 'zai', 'GLM-5.3-Flash-S', 'completed', ${NOW - 60000}, ${NOW - 50000}, 10000, 500, 300, 0, 0, 400, 1200);
`;
  spawnSync("sqlite3", [db], { input: subSeed, encoding: "utf8" });
  const r = spawnSync("python3", [QUERY, "json", SID], {
    encoding: "utf8", env: { ...process.env, ZCODE_CLI_DB: db }, timeout: 20000,
  });
  const payload = JSON.parse(r.stdout);
  const s = payload.recent.find((x) => x.sid === SID);
  assert.equal(s.sub.requests, 1);
  assert.equal(s.sub.total, 1200);
  assert.equal(s.sub.list[0].agent, "");
  assert.ok(s.sub.list[0].sid.startsWith("sess_subagent_"));
});

test("query.py：sid 白名单拦截非法输入", () => {
  const payload = runQuery(["json", "bad;drop--"]);
  assert.deepEqual(payload.known_sids, []);
  assert.deepEqual(payload.not_local, []);
});

test.after?.(() => {
  for (const d of ["zcm-q-"]) { /* tmpdir 清理由系统负责 */ }
});
