/**
 * decide 对 Q_now 的解问相关度（1–5）。
 * 专名撞词 ≠ 高分；仅点名/旁例应低分或根本不铸 prospect。
 */

/** ≥ 此分才计入早停可铸、并进入 infer 材料窗 */
export const MIN_PROSPECT_RELEVANCE = 3

/** 归一化 LLM 输出的 relevance；非法则 null */
export function normalizeRelevance(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n)) return null
  // 兼容 0–1 小数
  if (n > 0 && n <= 1) return Math.max(1, Math.min(5, Math.round(n * 5)))
  return Math.max(1, Math.min(5, Math.round(n)))
}

/**
 * 是否够进 infer。
 * 缺省分（旧输出未写）：按 3 计，避免整轮空窗；新契约应显式给分。
 */
export function relevanceAllowsInfer(
  relevance: number | null | undefined,
): boolean {
  const r = relevance == null ? MIN_PROSPECT_RELEVANCE : relevance
  return r >= MIN_PROSPECT_RELEVANCE
}
