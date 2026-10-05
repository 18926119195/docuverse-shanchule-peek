/**
 * 写信台微动作铸键（方案 B）：
 * 身份锁在「单次落账 settle」，不锁在正文哈希。
 * 一次 LLM 批调用只算草稿；每个输出槽各自 settle → 各自 instanceKey。
 *
 * 硬规则「一槽一 key」：
 * - 禁止用正文指纹 / 父门牌 去重合并多个输出槽
 * - 本应两枚 key 的内容必须分属两个 JSON 槽（或数组元素），台各铸一次
 * - 正文指纹 fp_* 仅副索引，不当门牌、不参与 reuse
 */

export type SettleJob =
  | 'peek'
  | 'decide'
  | 'infer'
  | 'path'
  | 'reuse'
  | 'query'
  | 'neighbour'
  | 'supervise'
  | 'solution'

export type InstanceKind =
  | 'brief'
  | 'prospect'
  | 'infer'
  | 'path'
  | 'query'
  | 'reuse'
  | 'neighbour'
  | 'norm'
  | 'solution'

const KIND_PREFIX: Record<InstanceKind, string> = {
  brief: 'bh',
  prospect: 'pk',
  infer: 'ik',
  path: 'ph',
  query: 'qk',
  reuse: 'ru',
  neighbour: 'nb',
  norm: 'nk',
  solution: 'sk',
}

/** 同毫秒连铸时防撞 */
let settleClock = 0
let llmCallClock = 0

/**
 * 一次写信台 LLM 往返 id（集合面板 / 进度边主键）。
 * 与 settleActionId 不同：同一次调用的多槽共享本 id。
 */
export function newLlmCallId(job: SettleJob | 'path'): string {
  llmCallClock = (llmCallClock + 1) >>> 0
  return `lc_${job}_${Date.now().toString(36)}_${llmCallClock.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 一次落账微动作 id（全局唯一） */
export function newSettleActionId(job: SettleJob): string {
  settleClock = (settleClock + 1) >>> 0
  return `st_${job}_${Date.now().toString(36)}_${settleClock.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 由落账动作铸出的实例门牌（主键） */
export function mintInstanceKey(
  kind: InstanceKind,
  settleActionId: string,
): string {
  const body = settleActionId.replace(/^st_/, '')
  return `${KIND_PREFIX[kind]}_${body}`
}

/** 副索引：正文指纹（仅「像不像」；不当门牌、不喂 reuse） */
export function contentFingerprint(raw: string): string {
  const t = raw.trim()
  let h = 2166136261
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `fp_${(h >>> 0).toString(36)}`
}

export function settleOnce(
  kind: InstanceKind,
  job: SettleJob,
): { settleActionId: string; instanceKey: string } {
  const settleActionId = newSettleActionId(job)
  return {
    settleActionId,
    instanceKey: mintInstanceKey(kind, settleActionId),
  }
}

/**
 * 把「单字段或数组」展开为槽位正文列表。
 * 空串丢弃；不按内容去重（同文两槽 → 两枚 key）。
 * 数组元素可为 string，或 { brief|prospect|text, status?, relevance? }。
 */
export function expandIncrementSlots(
  single: unknown,
  many: unknown,
): Array<{ text: string; statusRaw?: unknown; relevance?: unknown }> {
  const out: Array<{ text: string; statusRaw?: unknown; relevance?: unknown }> =
    []
  if (Array.isArray(many)) {
    for (const x of many) {
      if (typeof x === 'string') {
        const t = x.trim()
        if (t) out.push({ text: t })
        continue
      }
      if (!x || typeof x !== 'object') continue
      const r = x as Record<string, unknown>
      const t = String(r.brief ?? r.prospect ?? r.text ?? '').trim()
      if (!t) continue
      out.push({
        text: t,
        statusRaw: r.status ?? r.readStatus,
        relevance: r.relevance ?? r.score ?? r.rel ?? r.相关度,
      })
    }
    if (out.length > 0) return out
  }
  const one = String(single ?? '').trim()
  if (one) out.push({ text: one })
  return out
}

/** 仅充分可铸键；有正文但未报态 → 视为充分（兼容旧输出） */
export function statusAllowsMint(status: string | null | undefined): boolean {
  if (status === 'insufficient' || status === 'unread') return false
  return status === 'sufficient' || status == null || status === ''
}
