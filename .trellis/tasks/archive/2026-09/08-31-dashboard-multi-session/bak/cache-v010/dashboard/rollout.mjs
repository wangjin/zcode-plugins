// token-speed-dashboard · rollout 日志防御式解析与增量 tail
// 数据源：~/.zcode/cli/rollout/model-io-*.jsonl（ZCode 未公开的内部日志，字段缺失一律降级处理）
import { readdir, stat, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const ROLLOUT_DIR =
  process.env.ZCODE_ROLLOUT_DIR ||
  path.join(process.env.HOME || "~", ".zcode", "cli", "rollout");

const FILE_GLOB = /^model-io-.*\.jsonl$/;

/** 解析单行 JSON → 记录；任何异常返回 null（绝不抛出）。 */
export function parseRolloutLine(line) {
  try {
    const d = JSON.parse(line);
    if (!d || typeof d !== "object") return null;
    if (d.type && d.type !== "model_io") return null;

    const durationMs = Number(d.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) return null;

    const model = d.model || {};
    const role = model.role === "lite" ? "lite" : "main";
    const resp = d.response || {};
    const usage = resp.usage || {};
    let outputTokens = Number(usage.outputTokens);
    let source = "rollout";
    if (!Number.isFinite(outputTokens) || outputTokens < 0) {
      // 降级：用文本长度估算（÷4 经验系数）
      const text = typeof resp.text === "string" ? resp.text : "";
      outputTokens = Math.round(text.length / 4);
      source = "estimate";
    }
    // 0 token 完成（如空响应带 tool_calls）无速度意义，丢弃防止污染统计
    if (!(outputTokens > 0)) return null;

    const completedAt = Date.parse(d.completedAt || "");
    const durSec = durationMs / 1000;
    return {
      id: d.requestId || `${d.sessionId || "-"}|${d.turnId || "-"}|${d.completedAt || ""}`,
      sessionId: d.sessionId || null,
      turnId: d.turnId || null,
      role,
      modelId: model.modelId || resp.modelId || "unknown",
      outputTokens,
      inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : null,
      durationMs,
      tokPerSec: outputTokens / durSec,
      completedAtMs: Number.isFinite(completedAt) ? completedAt : Date.now(),
      source,
    };
  } catch {
    return null; // 半行/坏 JSON：交由 tail 层处理重试
  }
}

/**
 * 增量 tail：每文件记录 byte offset，只在遇到整行（\n）后推进 offset，
 * 半行留待下次。文件截断/轮转（size < offset）→ 归零并只接受比
 * lastCompletedAt 更晚的记录（去重回放）。
 */
export class RolloutTail {
  constructor(dir = ROLLOUT_DIR, opts = {}) {
    this.dir = dir;
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
    for (const f of files) {
      const fp = path.join(this.dir, f);
      try {
        const st = await stat(fp);
        let off = this.offsets.get(fp) ?? 0;
        if (!this.inited) { this.offsets.set(fp, st.size); continue; }
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
            const rec = parseRolloutLine(line);
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
