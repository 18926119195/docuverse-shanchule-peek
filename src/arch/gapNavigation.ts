/**
 * 台账空位检视（事实层）。
 * 「下一步调谁」由 auto_flow / 因果序写信台驱动，不再交意图 LLM 重复决策。
 *
 * 因果序（与自动流对齐）：
 * 复用前置（历史 queryKey→neighbour→norm）→ 新铸链（brief/prospect/infer/path/norm）
 * 冷启 brief 是材料前置，不是问线顶层分叉。
 */

import { useAttentionIo } from '../reasoning/attentionIoStore'
import { listAllSettledBriefs, mapBriefToBook } from '../reasoning/masterTableMap'
import { listSettledQueryEntries } from './deskEntryGate'

export type GapKind =
  | 'brief'
  | 'neighbour'
  | 'reuse'
  | 'prospect'
  | 'infer'
  | 'path'
  | 'norm'
  | 'done'

export interface QueryGap {
  kind: GapKind
  /** 给人看的空位说明 */
  reason: string
  briefKeys: string[]
  bookKeys: string[]
  pathKeys: string[]
  queryKey: string
}

function briefsForQuery(
  docId: string,
  queryKey: string,
  question: string,
): string[] {
  const s = useAttentionIo.getState()
  const fromQk = s.queryKeyToBriefKeys[queryKey] ?? []
  const fromQ = s.questionToBriefKeys[question] ?? []
  const merged = [...new Set([...fromQk, ...fromQ])]
  if (merged.length > 0) return merged
  return listAllSettledBriefs(docId).map((b) => b.briefKey)
}

/**
 * 按因果序找本问第一条空位（事实）。
 * 同问复用同一 queryKey 时：已齐的环跳过。
 */
export function inspectQueryGap(input: {
  docId: string
  queryKey: string
  question: string
}): QueryGap {
  const q = input.question.trim()
  const qk = input.queryKey.trim()
  const s = useAttentionIo.getState()

  const historicOthers = listSettledQueryEntries().filter(
    (e) => e.queryKey !== qk && e.qText.trim().length > 0,
  )
  const neighboursNow = s.neighbours.filter((n) => n.nowQueryKey === qk)
  const briefs = briefsForQuery(input.docId, qk, q)
  const prospects = s.prospects.filter((p) => p.queryKey === qk)
  const inferEdges = s.inferEdges.filter((e) => e.queryKey === qk)
  const paths = s.paths.filter((p) => p.queryKey === qk)
  const normsNow = s.listNormsForQueryKey(qk).filter((n) => n.text.trim())
  const reuseLinks = s.queryReuseLinks.filter((l) => l.fromQueryKey === qk)
  const pending = s.pendingPathMatch

  // —— 复用前置（有历史问线时优先）——
  if (historicOthers.length > 0) {
    if (neighboursNow.length === 0) {
      return {
        kind: 'neighbour',
        reason: `有历史问线×${historicOthers.length}，本问尚无 neighbour`,
        briefKeys: [],
        bookKeys: [],
        pathKeys: [],
        queryKey: qk,
      }
    }
    // 可复用材料 = neighbour 旧问上已有 norm 的 path（非仅有候选 path）
    const historicWithNorm = new Set<string>()
    for (const n of neighboursNow) {
      const hq = n.historicQueryKey
      for (const norm of s.listNormsForQueryKey(hq)) {
        if (!norm.text.trim()) continue
        historicWithNorm.add(norm.pathKey)
      }
    }
    if (historicWithNorm.size > 0 && reuseLinks.length === 0) {
      return {
        kind: 'reuse',
        reason: `neighbour 已指向含 normKey 的旧问，本问尚未 reuse`,
        briefKeys: [],
        bookKeys: [],
        pathKeys: [...historicWithNorm],
        queryKey: qk,
      }
    }
  }

  // —— 新铸链（材料 → 预测 → 推理 → path → norm）——
  if (briefs.length === 0) {
    return {
      kind: 'brief',
      reason: '材料前置：本问/库内尚无 brief（需冷启或热启）',
      briefKeys: [],
      bookKeys: [],
      pathKeys: [],
      queryKey: qk,
    }
  }

  if (prospects.length === 0) {
    const unread = s
      .listKeysUnread('decide', { queryKey: qk })
      .filter((k) => briefs.includes(k))
    const weak = s
      .listKeysNeedingMore('decide', { queryKey: qk })
      .filter((k) => briefs.includes(k))
    const target =
      unread.length > 0 ? unread : weak.length > 0 ? weak : briefs
    return {
      kind: 'prospect',
      reason: `brief×${briefs.length} 已有，本问尚无 prospect`,
      briefKeys: target,
      bookKeys: [],
      pathKeys: [],
      queryKey: qk,
    }
  }

  if (inferEdges.length === 0) {
    const bookKeys: string[] = []
    for (const p of prospects) {
      const hit = mapBriefToBook(input.docId, p.briefKey)
      if (hit?.bookKey && !bookKeys.includes(hit.bookKey)) {
        bookKeys.push(hit.bookKey)
      }
    }
    if (bookKeys.length === 0) {
      for (const bk of briefs) {
        const hit = mapBriefToBook(input.docId, bk)
        if (hit?.bookKey && !bookKeys.includes(hit.bookKey)) {
          bookKeys.push(hit.bookKey)
        }
      }
    }
    return {
      kind: 'infer',
      reason: `prospect×${prospects.length} 已有，本问尚无 infer`,
      briefKeys: prospects.map((p) => p.briefKey),
      bookKeys,
      pathKeys: [],
      queryKey: qk,
    }
  }

  if (paths.length === 0) {
    const pendingNote =
      pending && pending.queryKey === qk
        ? '（已挂 pending）'
        : '（需人手或跳过→监督）'
    return {
      kind: 'path',
      reason: `infer×${inferEdges.length} 与 prospect 已有，尚无 path ${pendingNote}`,
      briefKeys: prospects.map((p) => p.briefKey),
      bookKeys: inferEdges.flatMap((e) => e.bookKeys),
      pathKeys: [],
      queryKey: qk,
    }
  }

  // 有候选 path 但尚无 norm → 待 tick / 待监督（勿报 done）
  if (normsNow.length === 0 && reuseLinks.length === 0) {
    return {
      kind: 'norm',
      reason:
        `已有 path×${paths.length}，本问尚无 normKey（待确认 path 登记或跳过→监督铸）`,
      briefKeys: prospects.map((p) => p.briefKey),
      bookKeys: inferEdges.flatMap((e) => e.bookKeys),
      pathKeys: paths.map((p) => p.pathKey),
      queryKey: qk,
    }
  }

  return {
    kind: 'done',
    reason:
      `本问账已齐：prospect×${prospects.length} · infer×${inferEdges.length} · path×${paths.length}` +
      (normsNow.length ? ` · norm×${normsNow.length}` : '') +
      (reuseLinks.length ? ` · reuse×${reuseLinks.length}` : ''),
    briefKeys: prospects.map((p) => p.briefKey),
    bookKeys: inferEdges.flatMap((e) => e.bookKeys),
    pathKeys: paths.map((p) => p.pathKey),
    queryKey: qk,
  }
}
