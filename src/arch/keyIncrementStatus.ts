/**
 * 各 LLM 对「输入 key → 其增量」的阅读/充分度三态。
 * 交给写信台，决定后续递送哪些 key。
 *
 * unread        — 未读 / 未处理到该输入
 * sufficient    — 对该输入的增量已充分（可递送下游）
 * insufficient  — 已读但增量不够（需补材料或换工种）
 */

import { extractJsonObject } from '../reasoning/inferPath'
import type { DeskJob } from '../reasoning/attentionIoStore'
import type { DeskDeliveryJob } from './deskDelivery'

export type IncrementReadStatus = 'unread' | 'sufficient' | 'insufficient'

export type StatusJob = DeskJob | 'reuse' | 'intent'

export interface KeyIncrementStatusRow {
  /** 输入侧对称 key（bookKey / briefKey / queryKey / pathKey / inferKey …） */
  key: string
  status: IncrementReadStatus
  job: StatusJob
  /**
   * 本条三态所属问线（方案 B queryKey）。
   * 旧问三态不得串入新问；调度须带 queryKey 过滤。
   */
  queryKey?: string
  /** 若本步已铸出增量门牌，可挂上（brief/prospect/infer/path/neighbour/reuse） */
  incrementKey?: string
  note?: string
  settleSeq: number
  createdAt: number
}

/** 三态查询范围：默认含本问族（自身+祖先），不含其它根问 */
export type KeyStatusScope = {
  queryKey?: string
  /** 默认 true：含 listQuerySelfAndAncestors；false 仅本 qk */
  includeFamily?: boolean
}

const STATUS_SET = new Set<IncrementReadStatus>([
  'unread',
  'sufficient',
  'insufficient',
])

/** 归一化 LLM 三态（中英均可） */
export function normalizeIncrementStatus(raw: unknown): IncrementReadStatus | null {
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  if (STATUS_SET.has(s as IncrementReadStatus)) return s as IncrementReadStatus
  if (
    /unread|未读|没读|未看|未处理|not\s*read|skipped|skip/.test(s)
  ) {
    return 'unread'
  }
  if (
    /sufficient|充分|够用|足够|到位|enough|ok|adequate|full/.test(s)
  ) {
    return 'sufficient'
  }
  if (
    /insufficient|不充分|不够|不足|缺|partial|weak/.test(s)
  ) {
    return 'insufficient'
  }
  return null
}

/**
 * 从 LLM JSON 抽 keyStatuses / status 行。
 * 接受：
 * - { keyStatuses:[{key,status,incrementKey?}] }
 * - { briefs|prospects|judgments|matches|neighbours 内嵌 status }
 */
export function parseKeyIncrementStatuses(
  llmText: string,
  fallbackJob: StatusJob,
): Array<{
  key: string
  status: IncrementReadStatus
  incrementKey?: string
  note?: string
}> {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return []
  const root = obj as Record<string, unknown>
  const out: Array<{
    key: string
    status: IncrementReadStatus
    incrementKey?: string
    note?: string
  }> = []
  const seen = new Set<string>()

  const push = (
    key: string,
    statusRaw: unknown,
    incrementKey?: string,
    note?: string,
  ) => {
    const keyT = key.trim()
    const status = normalizeIncrementStatus(statusRaw)
    if (!keyT || !status) return
    const id = `${keyT}\0${status}\0${incrementKey ?? ''}`
    if (seen.has(id)) return
    seen.add(id)
    out.push({
      key: keyT,
      status,
      incrementKey: incrementKey?.trim() || undefined,
      note: note?.trim() || undefined,
    })
  }

  const table = root.keyStatuses ?? root.keyStatus ?? root.statuses
  if (Array.isArray(table)) {
    for (const row of table) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      push(
        String(r.key ?? r.briefKey ?? r.bookKey ?? r.queryKey ?? r.pathKey ?? r.normKey ?? r.inferKey ?? ''),
        r.status ?? r.readStatus ?? r.incrementStatus,
        String(r.incrementKey ?? r.outKey ?? '').trim() || undefined,
        String(r.note ?? r.rationale ?? '').trim() || undefined,
      )
    }
  }

  // peek briefs：bookKey + status（一槽或 briefs[] 展开后仍记门级态）
  if (Array.isArray(root.briefs)) {
    for (const row of root.briefs) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      push(
        String(r.key ?? r.bookKey ?? ''),
        r.status ?? r.readStatus,
        undefined,
        String(r.brief ?? '').trim() || undefined,
      )
    }
  }

  // decide：prospects[] → briefKey + status
  if (Array.isArray(root.prospects)) {
    for (const row of root.prospects) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      push(
        String(r.briefKey ?? r.bookKey ?? r.key ?? ''),
        r.status ?? r.readStatus,
        undefined,
        String(r.rationale ?? r.note ?? r.prospect ?? '').trim() || undefined,
      )
    }
  }

  // reuse judgments：normKey / pathKey / inferKey + status（canSolve→充分）
  if (Array.isArray(root.judgments)) {
    for (const row of root.judgments) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const key = String(r.normKey ?? r.pathKey ?? r.inferKey ?? '').trim()
      if (r.status != null || r.readStatus != null) {
        push(key, r.status ?? r.readStatus)
      } else if (r.canSolve === true) {
        push(key, 'sufficient')
      } else if (r.canSolve === false) {
        push(key, 'insufficient')
      }
    }
  }

  // path matches / 信效度 judgments
  if (Array.isArray(root.matches) || Array.isArray(root.judgments)) {
    const rows = [
      ...(Array.isArray(root.matches) ? root.matches : []),
      ...(Array.isArray(root.judgments) ? root.judgments : []),
    ]
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const status = r.status ?? r.readStatus ?? 'sufficient'
      push(String(r.pathKey ?? ''), status)
      push(String(r.inferKey ?? ''), status)
      push(String(r.prospectKey ?? ''), status)
    }
  }

  // query neighbours：可带 degree
  if (Array.isArray(root.neighbours)) {
    for (const row of root.neighbours) {
      if (typeof row === 'string') {
        push(row, 'sufficient')
        continue
      }
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      push(
        String(r.queryKey ?? r.key ?? ''),
        r.status ?? r.readStatus ?? 'sufficient',
        undefined,
        String(r.degree ?? r.neighbour ?? '').trim() || undefined,
      )
    }
  }

  // 兼容旧 orderedQueryKeys
  if (Array.isArray(root.orderedQueryKeys)) {
    for (const row of root.orderedQueryKeys) {
      if (typeof row === 'string') {
        push(row, 'sufficient')
        continue
      }
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      push(
        String(r.queryKey ?? r.key ?? ''),
        r.status ?? r.readStatus ?? 'sufficient',
        undefined,
        String(r.degree ?? r.neighbour ?? '').trim() || undefined,
      )
    }
  }

  // mainInfer paths 内 bookKeys：若顶层有 materialStatus
  if (Array.isArray(root.materialStatus)) {
    for (const row of root.materialStatus) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      push(String(r.bookKey ?? r.key ?? ''), r.status ?? r.readStatus)
    }
  }

  void fallbackJob
  return out
}

/** 契约提示片段：所有工种共用 */
export function keyStatusContractHint(inputKeyName: string): string {
  return (
    `对窗内每个输入 ${inputKeyName}，必须报告三态之一（与增量一一对应）：\n` +
    `- unread：未读/未处理到该 key\n` +
    `- sufficient：对该 key 的增量已充分，可交写信台递送下游\n` +
    `- insufficient：已读但增量不充分，需补材料或换工种\n` +
    `请在 JSON 中给出 "keyStatuses":[{ "key":"…", "status":"unread|sufficient|insufficient" }]` +
    `（也可在各条 briefs/prospects/judgments 上带 "status" 字段）。`
  )
}

/**
 * 曾报 unread 的 key 再进窗：禁止再次 unread。
 * insufficient 只报 status（禁 rationale）；sufficient 须短 rationale。
 */
export function unreadForceCommitInstruction(
  keys: string[],
  inputKeyName: string,
): string {
  const uniq = [...new Set(keys.map((k) => k.trim()).filter(Boolean))]
  if (uniq.length === 0) return ''
  return (
    `【写信台·unread 强制读完】下列 ${inputKeyName} 已报过 unread；本轮禁止再标 unread。\n` +
    `必须逐一阅读正文，只输出 sufficient 或 insufficient。\n` +
    `insufficient：只报 status，禁止写 rationale。\n` +
    `sufficient：须附短 rationale（为何充分）。\n` +
    `漏报或仍报 unread → 台记 insufficient，避免续滚死循环。\n` +
    uniq.map((k) => `- \`${k}\``).join('\n')
  )
}

export function deliveryJobsForStatus(
  status: IncrementReadStatus,
): DeskDeliveryJob[] | 'any' {
  if (status === 'sufficient') return 'any'
  return []
}

/** 筛选写信台应优先递送的 key（充分） */
export function keysReadyToDeliver(
  rows: KeyIncrementStatusRow[],
  opts?: { job?: StatusJob; onlyLatest?: boolean },
): string[] {
  let list = rows.filter((r) => r.status === 'sufficient')
  if (opts?.job) list = list.filter((r) => r.job === opts.job)
  if (opts?.onlyLatest) {
    const byKey = new Map<string, KeyIncrementStatusRow>()
    for (const r of list) byKey.set(r.key, r)
    return [...byKey.keys()]
  }
  return [...new Set(list.map((r) => r.key))]
}

/** 不充分 → 需补递 / 扩搜 */
export function keysNeedingMore(
  rows: KeyIncrementStatusRow[],
  opts?: { job?: StatusJob },
): string[] {
  let list = rows.filter((r) => r.status === 'insufficient')
  if (opts?.job) list = list.filter((r) => r.job === opts.job)
  return [...new Set(list.map((r) => r.key))]
}

/** 未读 → 尚须压入窗 */
export function keysUnread(
  rows: KeyIncrementStatusRow[],
  opts?: { job?: StatusJob },
): string[] {
  let list = rows.filter((r) => r.status === 'unread')
  if (opts?.job) list = list.filter((r) => r.job === opts.job)
  return [...new Set(list.map((r) => r.key))]
}
