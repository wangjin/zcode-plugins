// zcode-metrics · 字符→token 动态校准系数（纯逻辑，无 IO）
// 背景（research B5/B6/B10）：outputTokens 已含 reasoning 与 toolArgs，text 仅占 ~12%，
// 旧 ÷4 估算系统性低估 ~8 倍。校准口径：chars = text + reasoningText + toolArgs 长度，
// k = median(chars / outputTokens)，按模型分桶，实证默认 3.158（n=108）。

export const CALIB_DEFAULT_K = 3.158;
const BUCKET_CAP = 200;    // 环形样本上限（近 200 条，兼顾新鲜度与稳定性）
const MODEL_MIN = 20;      // 模型桶启用最小样本
const GLOBAL_MIN = 50;     // 全局桶启用最小样本
const MIN_OBS_OUT = 50;    // 只采样 outputTokens>50 的精确记录（防小输出噪声，与实验口径一致）

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function createCalibration(opts = {}) {
  const cap = opts.cap ?? BUCKET_CAP;
  const modelMin = opts.modelMin ?? MODEL_MIN;
  const globalMin = opts.globalMin ?? GLOBAL_MIN;
  const defaultK = opts.defaultK ?? CALIB_DEFAULT_K;
  const buckets = new Map(); // modelId -> 样本数组（环形：超 cap 挤掉最旧）
  const global = [];
  // 持久化恢复的预热中位数（live 样本不足时启用，避免重启回退默认值）
  let warmed = { buckets: new Map(), global: null };
  let dirty = false;

  function push(arr, k) {
    arr.push(k);
    if (arr.length > cap) arr.shift();
  }

  /** 喂一条精确记录（chars/outputTokens 同口径）；不满足采样条件静默跳过。 */
  function observe(modelId, chars, outputTokens) {
    if (!(outputTokens > MIN_OBS_OUT) || !(chars > 0)) return;
    const k = chars / outputTokens;
    if (!Number.isFinite(k) || k <= 0) return;
    let b = buckets.get(modelId);
    if (!b) { b = []; buckets.set(modelId, b); }
    push(b, k);
    push(global, k);
    dirty = true;
  }

  /** 回退链：live 模型桶 → live 全局 → 预热模型桶 → 预热全局 → 默认。 */
  function k(modelId) {
    const b = buckets.get(modelId);
    if (b && b.length >= modelMin) return median(b);
    if (global.length >= globalMin) return median(global);
    const wb = warmed.buckets.get(modelId);
    if (wb && wb.n >= modelMin) return wb.k;
    if (warmed.global && warmed.global.n >= globalMin) return warmed.global.k;
    return defaultK;
  }

  function estimateTokens(modelId, chars) {
    if (!(chars > 0)) return 0;
    return Math.max(1, Math.round(chars / k(modelId)));
  }

  /** 持久化视图（只存 median/count，不存样本）。 */
  function serialize() {
    const out = { version: 1, defaultK, buckets: {}, global: null };
    for (const [id, b] of buckets) {
      if (b.length >= modelMin) out.buckets[id] = { k: median(b), n: b.length };
    }
    if (global.length >= globalMin) out.global = { k: median(global), n: global.length };
    return out;
  }

  /** 恢复（坏数据静默忽略，保持空态）。 */
  function restore(data) {
    try {
      if (!data || data.version !== 1 || typeof data.buckets !== "object") return;
      const b = new Map();
      for (const [id, v] of Object.entries(data.buckets)) {
        if (v && Number.isFinite(v.k) && v.k > 0 && Number.isFinite(v.n)) b.set(id, { k: v.k, n: v.n });
      }
      let g = null;
      if (data.global && Number.isFinite(data.global.k) && data.global.k > 0) {
        g = { k: data.global.k, n: data.global.n };
      }
      warmed = { buckets: b, global: g };
      dirty = true;
    } catch { /* 坏数据 → 保持空态 */ }
  }

  function snapshotView() {
    return {
      defaultK,
      buckets: Object.fromEntries([...buckets.entries()].map(([id, b]) => [id, { n: b.length, k: b.length >= modelMin ? median(b) : null }])),
      global: { n: global.length, k: global.length >= globalMin ? median(global) : null },
    };
  }

  return {
    observe, k, estimateTokens, serialize, restore,
    markPersisted: () => { dirty = false; },
    isDirty: () => dirty,
    view: snapshotView,
  };
}
