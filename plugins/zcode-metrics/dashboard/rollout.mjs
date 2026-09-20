// zcode-metrics · rollout 日志防御式解析与增量 tail
// 数据源：~/.zcode/cli/rollout/model-io-*.jsonl（ZCode 未公开的内部日志，字段缺失一律降级处理）
import { readdir, stat, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const ROLLOUT_DIR =
  process.env.ZCODE_ROLLOUT_DIR ||
  path.join(process.env.HOME || "~", ".zcode", "cli", "rollout");

const FILE_GLOB = /^model-io-.*\.jsonl$/;

/** 解析单行 JSON → 记录；任何异常返回 null（绝不抛出）。
 *  opts.estimate(chars, modelId)→tokens：usage 缺失时的估算钩子（动态校准系数，server 侧注入）；
 *  未注入则记录标记 needsEstimate=true、outputTokens=0，由调用方自行解析。 */
export function parseRolloutLine(line, opts = {}) {
  try {
    const d = JSON.parse(line);
    if (!d || typeof d !== "object") return null;
    if (d.type && d.type !== "model_io") return null;

    const durationMs = Number(d.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) return null;

    const model = d.model || {};
    // role：querySource 优先（model.role 实测近 3 天全 None，从未命中）——
    // session_title = 后台任务(lite)；main_turn/subagent = main；querySource 缺失沿用旧 role 规则
    const qs = typeof d.querySource === "string" ? d.querySource : "";
    const role = qs
      ? (qs === "session_title" ? "lite" : "main")
      : (model.role === "lite" ? "lite" : "main");

    const resp = d.response || {};
    const usage = resp.usage || {};
    // 完整字符口径（research B5/B6/B10：outputTokens 已含 reasoning 与 toolArgs，text 仅占 ~12%）
    const text = typeof resp.text === "string" ? resp.text : "";
    const reasoningText = typeof resp.reasoningText === "string" ? resp.reasoningText : "";
    let argsLen = 0;
    if (Array.isArray(resp.toolCalls)) {
      for (const t of resp.toolCalls) {
        if (!t || typeof t !== "object") continue;
        const a = t.arguments ?? t.input;
        if (typeof a === "string") argsLen += a.length;
        else if (a && typeof a === "object") argsLen += JSON.stringify(a).length;
      }
    }
    const chars = text.length + reasoningText.length + argsLen;

    let outputTokens = Number(usage.outputTokens);
    let source = "rollout";
    let needsEstimate = false;
    if (!Number.isFinite(outputTokens) || outputTokens < 0) {
      // 降级：usage 缺失 → 完整字符口径 ÷ 动态校准系数（旧 text÷4 实测低估 ~8 倍）
      source = "estimate";
      needsEstimate = true;
      if (chars > 0 && typeof opts.estimate === "function") {
        outputTokens = opts.estimate(chars, model.modelId || resp.modelId || "unknown");
      } else {
        outputTokens = 0;
        if (chars <= 0) return null; // 无 usage 且无任何文本 → 无法估算，丢弃
      }
    }
    // 0 token 完成（如空响应带 tool_calls）无速度意义，丢弃防止污染统计
    if (!(outputTokens > 0)) return null;

    const completedAt = Date.parse(d.completedAt || "");
    const startedAt = Date.parse(d.startedAt || "");
    const durSec = durationMs / 1000;
    return {
      id: d.requestId || `${d.sessionId || "-"}|${d.turnId || "-"}|${d.completedAt || ""}`,
      sessionId: d.sessionId || null,
      turnId: d.turnId || null,
      role,
      modelId: model.modelId || resp.modelId || "unknown",
      outputTokens,
      chars,
      inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : null,
      cacheReadTokens: Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null,
      cacheWriteTokens: Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : null,
      durationMs,
      tokPerSec: outputTokens / durSec,
      completedAtMs: Number.isFinite(completedAt) ? completedAt : Date.now(),
      startedAtMs: Number.isFinite(startedAt) ? startedAt : null,
      source,
      needsEstimate,
    };
  } catch {
    return null; // 半行/坏 JSON：交由 tail 层处理重试
  }
}

/**
 * 增量 tail：每文件记录 byte offset，只在遇到整行（\n）后推进 offset，
 * 半行留待下次。文件截断/轮转（size < offset）→ 归零并只接受比
 * lastCompletedAt 更晚的记录（去重回放）。
 * opts.fromStart=true → 首 poll 从 offset 0 全量读取（首启回填模式）；
 * 默认（false）保持原行为：首轮 seek 到 EOF 不回放历史。
 */
export class RolloutTail {
  constructor(dir = ROLLOUT_DIR, opts = {}) {
    this.dir = dir;
    this.opts = opts;
    this.offsets = new Map();   // file -> offset
    this.inited = false;        // 首轮把 offset 定位到 EOF（不回放历史）
    this.skipOlderThan = opts.skipOlderThan || 0; // 防截断回放：忽略早于此时刻的记录
    this.lastCompletedAtMs = 0;
    this.recentIds = new Set(); // 去重
    this.recentOrder = [];
  }

  async poll() {
    const records = [];
    let files = [];
    try {
      files = (await readdir(this.dir)).filter((f) => FILE_GLOB.test(f));
    } catch {
      return records; // 目录不存在 → 空结果（UI 显示等待态）
    }
    const fromStart = !!this.opts.fromStart;
    for (const f of files) {
      const fp = path.join(this.dir, f);
      try {
        const st = await stat(fp);
        let off = this.offsets.get(fp) ?? 0;
        if (!this.inited && !fromStart) { this.offsets.set(fp, st.size); continue; }
        if (st.size < off) { off = 0; }          // 截断/轮转
        if (st.size === off) continue;
        const fh = await open(fp, "r");
        try {
          const len = st.size - off;
          const buf = Buffer.allocUnsafe(len);
          const { bytesRead } = await fh.read(buf, 0, len, off);
          let consumed = 0, nl;
          const text = buf.subarray(0, bytesRead);
          while ((nl = text.indexOf(0x0a, consumed)) !== -1) {
            const line = text.subarray(consumed, nl).toString("utf8").trim();
            consumed = nl + 1;
            if (!line) continue;
            const rec = parseRolloutLine(line, this.opts);
            if (!rec) continue;
            if (this.recentIds.has(rec.id)) continue; // 轮转/重放去重（按 requestId / session|turn|completedAt）
            this.recentIds.add(rec.id);
            this.recentOrder.push(rec.id);
            if (this.recentOrder.length > 500) {
              this.recentIds.delete(this.recentOrder.shift());
            }
            this.lastCompletedAtMs = Math.max(this.lastCompletedAtMs, rec.completedAtMs);
            records.push(rec);
          }
          this.offsets.set(fp, off + consumed);
        } finally {
          await fh.close();
        }
      } catch { /* 单文件失败不影响其他 */ }
    }
    if (!this.inited) this.inited = true;
    return records;
  }
}
