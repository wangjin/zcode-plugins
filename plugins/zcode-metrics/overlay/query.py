#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""zcode-metrics · 状态条查询器：读 ~/.zcode/cli/db/db.sqlite（只读）出状态条 payload。

模式：
  query.py json [sids]   一次性输出 payload JSON 后退出（sids 逗号分隔白名单，强制纳入快照）
  query.py serve         常驻：stdin 每行一个 sid 白名单（可空），stdout 每行一个 payload JSON

口径移植自 ByteRax/zcode-token-usage-statusbar 的 zusage.py（本任务 2026-10-15 已对照本机
schema 核实：model_usage / turn_usage / tool_usage / session 字段一致），全局命名 zcm。
任何失败只打 stderr，不影响客户端。
"""
import json
import os
import re
import sys
import time
from pathlib import Path

HOME = Path(os.environ.get("HOME", "~")).expanduser()
DB_PATH = Path(os.environ.get("ZCODE_CLI_DB") or (HOME / ".zcode" / "cli" / "db" / "db.sqlite"))
CATALOG_PATH = Path("/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json")

SESSION_TIMEOUT_MS = 90_000      # 会话"活跃"判定：最近 completed 请求距今 90s 内
SUB_ACTIVE_MS = 30_000           # 子代理"运行中"判定窗口

DEFAULT_CONFIG = {"context_window": 200_000, "activity_min_ms": 1500}
_SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_SUB_PREFIX_LEN = len("sess_subagent")

_EMPTY_TURN = {"requests": 0, "retries": 0, "tool_calls": 0, "tool_errors": 0, "input": 0,
               "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0,
               "total": 0, "duration_ms": 0, "ttft_ms": 0}

_CFG_CACHE = {}
_CTX_RULES_CACHE = {"at": 0.0, "rules": []}


def log(*a):
    print("[zcm-query]", *a, file=sys.stderr)


def read_config():
    cfg = dict(DEFAULT_CONFIG)
    path = Path(__file__).resolve().parent / "config.json"
    try:
        cfg.update(json.loads(path.read_text(encoding="utf-8")))
    except Exception:
        pass
    return cfg


def connect_ro():
    """只读连接优先；只读 URI 在 WAL 库上可能因 shm 不可用失败，退回普通连接（全程只 SELECT）。"""
    import sqlite3
    try:
        con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        con.execute("select 1")
        return con
    except Exception:
        con = sqlite3.connect(str(DB_PATH))
        con.row_factory = sqlite3.Row
        return con


def load_ctx_rules():
    """客户端模型目录的 contextWindow 规则表 [(compiled_regex, window)]。
    客户端按 modelRules 顺序匹配、后命中覆盖（cascade 语义），这里保持同序遍历。"""
    try:
        mtime = CATALOG_PATH.stat().st_mtime
    except OSError:
        return []
    if _CTX_RULES_CACHE["at"] == mtime and _CTX_RULES_CACHE["rules"]:
        return _CTX_RULES_CACHE["rules"]
    rules = []
    try:
        data = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        for rule in data["config"]["modelConfigRules"]["modelRules"]:
            window = rule.get("config", {}).get("properties", {}).get("contextWindow")
            if not window:
                continue
            try:
                rules.append((re.compile(rule["modelMatch"], re.IGNORECASE), int(window)))
            except (KeyError, re.error, TypeError, ValueError):
                continue
    except (OSError, ValueError, KeyError, TypeError) as e:
        log("catalog parse failed:", e)
    _CTX_RULES_CACHE["at"] = mtime
    _CTX_RULES_CACHE["rules"] = rules
    return rules


def lookup_context_window(model_id):
    want = (model_id or "").strip()
    if not want:
        return None
    result = None
    for pattern, window in load_ctx_rules():
        if pattern.fullmatch(want):
            result = window       # 后命中覆盖，与客户端 cascade 同序
    return result


def session_usage(con, sid):
    """会话累计（completed 请求）。ctx 取最近一次 completed 请求的 input_tokens
    （不能用 max：会话压缩后 input 骤降，峰值永远不回落）。"""
    r = con.execute(
        """select count(*), coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                  coalesce(sum(reasoning_tokens),0), coalesce(sum(cache_read_input_tokens),0),
                  coalesce(sum(cache_creation_input_tokens),0), coalesce(sum(computed_total_tokens),0),
                  coalesce(sum(tool_call_count),0),
                  (select m2.input_tokens from model_usage m2
                    where m2.session_id = m.session_id and m2.status = 'completed'
                    order by m2.completed_at desc, m2.id desc limit 1),
                  count(distinct turn_id), coalesce(sum(retry_count),0)
           from model_usage m where m.session_id=? and status='completed'""",
        (sid,),
    ).fetchone()
    return {
        "requests": r[0], "input": r[1], "output": r[2], "reasoning": r[3],
        "cache_read": r[4], "cache_write": r[5], "total": r[6], "tool_calls": r[7],
        "last_request_input": r[8] or 0, "turns": r[9], "retries": r[10],
    }


def hides_reasoning(model_id):
    """Claude 系列不单独上报思考 token（reasoning_tokens 恒 0 但 output 已含思考，
    且思考在 first_token_at 之前流出）：生成窗口须从 started_at 起算，否则速率虚高。"""
    return "claude" in (model_id or "").lower()


def latest_turn(con, sid, turn_id):
    """本轮数据 = turn_usage 的每轮完整聚合；进行中（无 completed 行）回退 model_usage 现场聚合。"""
    t = con.execute(
        """select coalesce(model_request_count,0), coalesce(model_retry_count,0),
                  coalesce(tool_call_count,0), coalesce(tool_error_count,0),
                  coalesce(input_tokens,0), coalesce(output_tokens,0), coalesce(reasoning_tokens,0),
                  coalesce(cache_read_input_tokens,0), coalesce(cache_creation_input_tokens,0),
                  coalesce(computed_total_tokens,0),
                  coalesce(duration_ms,0), coalesce(time_to_first_token_ms,0)
           from turn_usage where session_id=? and turn_id=? and status='completed'""",
        (sid, turn_id),
    ).fetchone()
    if t:
        return {"requests": t[0], "retries": t[1], "tool_calls": t[2], "tool_errors": t[3],
                "input": t[4], "output": t[5], "reasoning": t[6], "cache_read": t[7],
                "cache_write": t[8], "total": t[9], "duration_ms": t[10], "ttft_ms": t[11]}
    r = con.execute(
        """select count(*), coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                  coalesce(sum(computed_total_tokens),0), coalesce(sum(duration_ms),0),
                  coalesce(sum(cache_read_input_tokens),0), coalesce(sum(reasoning_tokens),0),
                  coalesce(sum(cache_creation_input_tokens),0)
           from model_usage where session_id=? and turn_id=? and status='completed'""",
        (sid, turn_id),
    ).fetchone()
    return {"requests": r[0], "retries": 0, "tool_calls": 0, "tool_errors": 0,
            "input": r[1], "output": r[2], "reasoning": r[6], "cache_read": r[5],
            "cache_write": r[7], "total": r[3], "duration_ms": r[4], "ttft_ms": 0}


def recent_tps(con, sid):
    """最近一次 completed 请求的生成速度：output ÷ 生成窗口。
    含思考段（reasoning>0 或 claude 系）窗口前移到 started_at；缺 first_token_at 退化 duration_ms。"""
    last = con.execute(
        """select duration_ms, coalesce(time_to_first_token_ms,0), completed_at, model_id,
                  output_tokens, first_token_at, started_at, reasoning_tokens
           from model_usage where session_id=? and status='completed'
           order by completed_at desc limit 1""",
        (sid,),
    ).fetchone()
    if not last:
        return 0, {"duration_ms": 0, "ttft_ms": 0, "model": "", "tps": 0}
    tps = 0
    if last["output_tokens"]:
        gen_ms = None
        if last["first_token_at"] and last["completed_at"] and last["completed_at"] > last["first_token_at"]:
            gen_ms = last["completed_at"] - last["first_token_at"]
            if ((last["reasoning_tokens"] or hides_reasoning(last["model_id"]))
                    and last["started_at"] and last["completed_at"] > last["started_at"]):
                gen_ms = last["completed_at"] - last["started_at"]
        elif last["duration_ms"]:
            gen_ms = last["duration_ms"]
        if gen_ms:
            tps = round(last["output_tokens"] / (gen_ms / 1000), 1)
    return tps, {"duration_ms": last["duration_ms"] or 0, "ttft_ms": last[1],
                 "model": last["model_id"] or "", "tps": tps}


def sub_agents(con, sid, now_ms):
    """子代理 = model_usage.query_source='subagent' 且子会话 parent_id=sid，按子会话聚合。"""
    rows = con.execute(
        """select m.session_id, coalesce(m.agent,''), coalesce(s2.title,''), count(*),
                  coalesce(sum(m.computed_total_tokens),0),
                  coalesce(sum(m.input_tokens),0), coalesce(sum(m.output_tokens),0),
                  coalesce(sum(m.cache_read_input_tokens),0), coalesce(sum(m.reasoning_tokens),0),
                  coalesce(sum(m.cache_creation_input_tokens),0), max(m.completed_at)
           from model_usage m join session s2 on m.session_id = s2.id
           where m.query_source='subagent' and s2.parent_id=? and m.status='completed'
           group by m.session_id order by max(m.completed_at) desc""",
        (sid,),
    ).fetchall()
    return {
        "requests": sum(r[3] for r in rows),
        "total": sum(r[4] for r in rows),
        "input": sum(r[5] for r in rows),
        "output": sum(r[6] for r in rows),
        "cache_read": sum(r[7] for r in rows),
        "reasoning": sum(r[8] for r in rows),
        "cache_write": sum(r[9] for r in rows),
        "active": any(r[10] and now_ms - r[10] < SUB_ACTIVE_MS for r in rows),
        "list": [
            {"sid": r[0], "agent": r[1], "title": r[2], "task": "",
             "requests": r[3], "total": r[4], "input": r[5], "output": r[6],
             "cache_read": r[7], "reasoning": r[8], "cache_write": r[9],
             "last": (r[10] or 0), "active": bool(r[10] and now_ms - r[10] < SUB_ACTIVE_MS)}
            for r in rows
        ],
    }


def tool_stats(con, sid):
    rows = con.execute(
        """select tool_name, count(*), coalesce(sum(duration_ms),0),
                  sum(case when status='error' then 1 else 0 end)
           from tool_usage where session_id=? and status in ('completed','error')
           group by tool_name order by count(*) desc, tool_name""",
        (sid,),
    ).fetchall()
    return {
        "total": sum(r[1] for r in rows),
        "errors": sum(r[3] or 0 for r in rows),
        "list": [{"name": r[0], "count": r[1], "duration_ms": r[2], "errors": r[3] or 0}
                 for r in rows],
    }


def session_snapshot(con, sid, cfg, now_ms):
    srow = con.execute("select title, summary_additions, summary_deletions, summary_files, parent_id from session where id=?", (sid,)).fetchone()
    u = session_usage(con, sid)
    tps, last = recent_tps(con, sid)
    lt = dict(_EMPTY_TURN)
    if last.get("model") or last.get("duration_ms"):
        turn_row = con.execute(
            """select turn_id from model_usage where session_id=? and status='completed'
               order by completed_at desc limit 1""",
            (sid,),
        ).fetchone()
        if turn_row and turn_row[0]:
            lt = latest_turn(con, sid, turn_row[0])
    lr = con.execute("select max(completed_at) from model_usage where session_id=?", (sid,)).fetchone()
    ctx_auto = lookup_context_window(last["model"]) if last.get("model") else None
    return {
        "sid": sid,
        "title": (srow["title"] if srow is not None else "") or "",
        "active": bool(lr[0] and now_ms - lr[0] < SESSION_TIMEOUT_MS),
        "turns": u["turns"], "requests": u["requests"], "input": u["input"],
        "output": u["output"], "reasoning": u["reasoning"], "cache_read": u["cache_read"],
        "cache_write": u["cache_write"], "total": u["total"], "tool_calls": u["tool_calls"],
        "retries": u["retries"], "ctx": u["last_request_input"],
        "updated": (time.strftime("%H:%M:%S", time.localtime(lr[0] / 1000)) if lr[0] else ""),
        "sub": sub_agents(con, sid, now_ms),
        "tools": tool_stats(con, sid),
        "last_turn": lt,
        "last": last,
        "code": {"add": (srow["summary_additions"] if srow is not None else None),
                 "del": (srow["summary_deletions"] if srow is not None else None),
                 "files": (srow["summary_files"] if srow is not None else None)},
        "ctx_exc": con.execute(
            """select coalesce(max(coalesce(completed_at, started_at)),0)
               from model_usage where session_id=? and context_exceeded=1""",
            (sid,),
        ).fetchone()[0],
        "context_window": ctx_auto or cfg["context_window"],
        "context_auto": ctx_auto is not None,
        "last_at": (lr[0] if lr[0] else 0),
        "is_sub": sid.startswith("sess_subagent"),
        "parent": (srow["parent_id"] if srow is not None else None),
    }


def today_usage(con, now_ms):
    day0 = time.strftime("%Y-%m-%dT00:00:00", time.localtime(now_ms / 1000))
    # 本地日界：sqlite 无时区感知，用本地零点的 epoch ms 比较
    import datetime
    d = datetime.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    start = int(d.timestamp() * 1000)
    r = con.execute(
        """select count(*), coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
                  coalesce(sum(cache_read_input_tokens),0), coalesce(sum(computed_total_tokens),0),
                  coalesce(sum(reasoning_tokens),0), coalesce(sum(retry_count),0),
                  coalesce(sum(cache_creation_input_tokens),0)
           from model_usage where status='completed' and completed_at between ? and ?""",
        (start, now_ms),
    ).fetchone()
    return {"requests": r[0], "input": r[1], "output": r[2], "cache_read": r[3],
            "total": r[4], "reasoning": r[5], "retries": r[6], "cache_write": r[7]}


def known_sid(con, sid):
    """会话是否真实存在（session 行或任一 usage 行）。"""
    if con.execute("select 1 from session where id=?", (sid,)).fetchone():
        return True
    return bool(con.execute("select 1 from model_usage where session_id=?", (sid,)).fetchone())


def build_payload(con, wants, cfg):
    now_ms = int(time.time() * 1000)
    known, recent, not_local = [], [], []
    for sid in wants:
        if not known_sid(con, sid):
            not_local.append(sid)
            continue
        known.append(sid)
        recent.append(session_snapshot(con, sid, cfg, now_ms))
    # 快照池兜底：白名单之外再带最近活跃会话（会话切换瞬间池里还没有目标会话时显示不空白）
    extra = con.execute(
        """select m.session_id, max(m.completed_at) as la from model_usage m
           join session s on m.session_id = s.id
           where m.status='completed' and s.parent_id is null
                 and substr(m.session_id,1,?)!='sess_subagent'
           group by m.session_id order by la desc limit 8""",
        (_SUB_PREFIX_LEN,),
    ).fetchall()
    seen = set(known)
    for r in extra:
        if r[0] not in seen:
            seen.add(r[0])
            recent.append(session_snapshot(con, r[0], cfg, now_ms))
    recent.sort(key=lambda x: x["last_at"], reverse=True)
    return {
        "recent": recent,
        "today": today_usage(con, now_ms),
        "not_local": not_local,
        "known_sids": known,
        "remote_enabled": False,
    }


def valid_sids(arg):
    out = []
    for s in (arg or "").split(","):
        s = s.strip()
        if s and _SID_RE.match(s) and s not in out:
            out.append(s)
    return out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "json"
    cfg = read_config()
    if mode == "serve":
        con = connect_ro()
        for line in sys.stdin:
            wants = valid_sids(line.strip())
            try:
                payload = build_payload(con, wants, cfg)
            except Exception as e:
                log("serve query failed:", e)
                payload = {"recent": [], "today": {}, "not_local": [], "known_sids": [], "remote_enabled": False}
            sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    else:
        wants = valid_sids(sys.argv[2] if len(sys.argv) > 2 else "")
        con = connect_ro()
        print(json.dumps(build_payload(con, wants, cfg), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        pass
    except Exception as e:
        log("fatal:", e)
        sys.exit(1)
