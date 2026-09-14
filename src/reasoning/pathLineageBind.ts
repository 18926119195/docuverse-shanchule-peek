/**
 * path 血缘绑定（写信台，非 LLM）：
 * 解法 path：conclusion 总览下 steps 的 bookKeys 并集 ∩ prospect 父门 → 载荷挂载（不叉乘多 path）。
 * 旧：prospect → brief → book 与 infer.bookKeys 有交集 ⇒ 同窝候选对（一 ι × 一 prospect）。
 */

import type { InferEdge, ProspectRecord } from './attentionIoStore'
import { mapBriefToBook } from './masterTableMap'

export interface LineageDeskDelivery {
  job: string
  fromKeys: string[]
  toKey: string
}

export interface LineageBoundPair {
  inferKey: string
  prospectKey: string
  briefKey: string
  /** infer 与 prospect 谱系相交的 bookKeys */
  sharedBookKeys: string[]
  inferText: string
  prospectText: string
}

/** 解法级：一条 solution → 一个审计单位；prospect 成对搬入载荷 */
export interface SolutionLineageBind {
  solutionKey: string
  conclusion: string
  pathIndex: number
  steps: Array<{
    inferKey: string
    role: string
    bookKeys: string[]
    bookSlots?: number[]
    inferText: string
  }>
  /** 按 step 出现序去重后的整路 bookKey 序列 */
  bookKeysSequence: string[]
  prospects: Array<{
    prospectKey: string
    briefKey: string
    bookKey: string
    text: string
  }>
}

/**
 * 材料父键 → bookKey（实验：父键常已是 bookKey）：
 * 1) 门表 mapBriefToBook（旧 brief）
 * 2) peek 递送：from book → to briefKey
 * 3) 启发式：非 bh_/st_ 前缀则当作裸 bookKey
 * （decide 递送是 book→prospectKey，见 prospectBookKey）
 */
export function resolveBriefBookKey(
  docId: string,
  briefKey: string,
  deskDeliveries?: LineageDeskDelivery[],
): string | null {
  const bk = briefKey.trim()
  if (!bk) return null

  const hit = mapBriefToBook(docId, bk)?.bookKey?.trim()
  if (hit) return hit

  if (deskDeliveries?.length) {
    for (let i = deskDeliveries.length - 1; i >= 0; i--) {
      const d = deskDeliveries[i]!
      if (d.toKey === bk && d.fromKeys[0] && d.job === 'peek') {
        return d.fromKeys[0]!.trim() || null
      }
    }
  }

  // 实验：prospect.briefKey 字段直接存 bookKey
  if (!bk.startsWith('bh_') && !bk.startsWith('st_')) return bk
  return null
}

/** prospect → bookKey（实验：briefKey 字段常=book；递送兜底用 prospectKey） */
export function prospectBookKey(
  docId: string,
  prospect: Pick<ProspectRecord, 'briefKey' | 'prospectKey'>,
  deskDeliveries?: LineageDeskDelivery[],
): string | null {
  const viaBrief = resolveBriefBookKey(docId, prospect.briefKey, deskDeliveries)
  if (viaBrief) return viaBrief

  // decide 递送：from bookKeys → to prospectKey（与 resolveBriefBookKey 的 peek/brief 向不同）
  const pk = prospect.prospectKey?.trim()
  if (pk && deskDeliveries?.length) {
    for (let i = deskDeliveries.length - 1; i >= 0; i--) {
      const d = deskDeliveries[i]!
      if (d.job !== 'decide' || d.toKey !== pk) continue
      const book = d.fromKeys[0]?.trim()
      if (book) return book
    }
  }
  return null
}

/**
 * 台侧圈窝：每个 infer × 同基因 prospect（book 交集非空）。
 * 不唯一化、不贪心删边——一窝可多对；信效度由后续 LLM/人手判定。
 * @deprecated 解法级审计请用 bindSolutionsByBookLineage
 */
export function bindInferProspectByBookLineage(input: {
  docId: string
  inferEdges: InferEdge[]
  prospects: ProspectRecord[]
  deskDeliveries?: LineageDeskDelivery[]
}): LineageBoundPair[] {
  const docId = input.docId.trim()
  const dels = input.deskDeliveries
  const out: LineageBoundPair[] = []
  const seen = new Set<string>()

  for (const edge of input.inferEdges) {
    const ik = edge.inferKey.trim()
    if (!ik) continue
    const books = new Set(
      edge.bookKeys.map((k) => k.trim()).filter(Boolean),
    )
    if (books.size === 0) continue
    const inferText = (edge.infer || edge.rationale || '').trim()

    for (const p of input.prospects) {
      const pk = p.prospectKey.trim()
      if (!pk) continue
      const book = prospectBookKey(docId, p, dels)
      if (!book || !books.has(book)) continue
      const id = `${ik}::${pk}`
      if (seen.has(id)) continue
      seen.add(id)
      // 交集：prospect 父门 ∩ infer.bookKeys（prospect 单父，故至多一枚；多门 infer 各 prospect 各自成对）
      const shared = [...books].filter((b) => b === book)
      out.push({
        inferKey: ik,
        prospectKey: pk,
        briefKey: p.briefKey,
        sharedBookKeys: shared.length > 0 ? shared : [book],
        inferText,
        prospectText: p.text.trim(),
      })
    }
  }
  return out
}

/**
 * 解法级绑定：按 solutionKey（或缺省 pathIndex）分组；
 * 一条解法 → 一个绑定；整路 bookKeys 上的 decide 产出成对搬入（不叉乘多 path）。
 */
export function bindSolutionsByBookLineage(input: {
  docId: string
  inferEdges: InferEdge[]
  prospects: ProspectRecord[]
  deskDeliveries?: LineageDeskDelivery[]
}): SolutionLineageBind[] {
  const docId = input.docId.trim()
  const dels = input.deskDeliveries

  type Acc = {
    solutionKey: string
    conclusion: string
    pathIndex: number
    steps: SolutionLineageBind['steps']
  }
  const groups = new Map<string, Acc>()

  for (const edge of input.inferEdges) {
    const ik = edge.inferKey.trim()
    if (!ik) continue
    const books = edge.bookKeys.map((k) => k.trim()).filter(Boolean)
    if (books.length === 0) continue
    const sk =
      (edge.solutionKey ?? '').trim() ||
      `legacy_pi${edge.pathIndex}_ik${ik}`
    let g = groups.get(sk)
    if (!g) {
      g = {
        solutionKey: sk,
        conclusion: (edge.conclusion ?? '').trim(),
        pathIndex: edge.pathIndex,
        steps: [],
      }
      groups.set(sk, g)
    }
    if (!g.conclusion && edge.conclusion) {
      g.conclusion = edge.conclusion.trim()
    }
    g.steps.push({
      inferKey: ik,
      role: (edge.role ?? '').trim(),
      bookKeys: books,
      bookSlots:
        edge.bookSlots && edge.bookSlots.length === books.length
          ? [...edge.bookSlots]
          : undefined,
      inferText: (edge.infer || edge.rationale || '').trim(),
    })
  }

  const out: SolutionLineageBind[] = []
  for (const g of groups.values()) {
    if (g.steps.length === 0) continue
    const bookKeysSequence: string[] = []
    const seenBook = new Set<string>()
    for (const st of g.steps) {
      for (const bk of st.bookKeys) {
        if (seenBook.has(bk)) continue
        seenBook.add(bk)
        bookKeysSequence.push(bk)
      }
    }
    const bookSet = new Set(bookKeysSequence)
    const prospects: SolutionLineageBind['prospects'] = []
    const seenPr = new Set<string>()
    for (const p of input.prospects) {
      const pk = p.prospectKey.trim()
      if (!pk || seenPr.has(pk)) continue
      const book = prospectBookKey(docId, p, dels)
      if (!book || !bookSet.has(book)) continue
      seenPr.add(pk)
      prospects.push({
        prospectKey: pk,
        briefKey: p.briefKey,
        bookKey: book,
        text: p.text.trim(),
      })
    }
    const conclusion =
      g.conclusion ||
      g.steps
        .map((s) => s.inferText)
        .filter(Boolean)
        .join('；')
    if (!conclusion) continue
    out.push({
      solutionKey: g.solutionKey,
      conclusion,
      pathIndex: g.pathIndex,
      steps: g.steps,
      bookKeysSequence,
      prospects,
    })
  }

  out.sort((a, b) => a.pathIndex - b.pathIndex)
  return out
}

/**
 * decide 充分 brief / 已落 prospect → infer 用的 bookKeys（严格血缘）。
 * 只认：prospect.briefKey ∈ mintableBriefKeys → resolveBriefBookKey。
 * 调用方须先筛本问族 prospect；禁止「全部 peek 门」宽兜底。
 */
export function bookKeysForInferFromDecideLineage(input: {
  docId: string
  mintableBriefKeys: string[]
  /** 已筛到本问族、且 brief 属于本轮 mintable 的 prospect */
  prospects: Array<Pick<ProspectRecord, 'prospectKey' | 'briefKey'>>
  deskDeliveries?: LineageDeskDelivery[]
}): {
  bookKeys: string[]
  pairs: Array<{
    prospectKey: string
    briefKey: string
    bookKey: string
  }>
  unmappedBriefKeys: string[]
  orphanProspectKeys: string[]
} {
  const docId = input.docId.trim()
  const mintable = new Set(
    input.mintableBriefKeys.map((k) => k.trim()).filter(Boolean),
  )
  const pairs: Array<{
    prospectKey: string
    briefKey: string
    bookKey: string
  }> = []
  const bookKeys: string[] = []
  const seenBook = new Set<string>()
  const mappedBrief = new Set<string>()
  const orphanProspectKeys: string[] = []

  for (const p of input.prospects) {
    const briefKey = p.briefKey.trim()
    if (!mintable.has(briefKey)) continue
    const bookKey = resolveBriefBookKey(
      docId,
      briefKey,
      input.deskDeliveries,
    )
    if (!bookKey) {
      orphanProspectKeys.push(p.prospectKey.trim())
      continue
    }
    mappedBrief.add(briefKey)
    pairs.push({
      prospectKey: p.prospectKey.trim(),
      briefKey,
      bookKey,
    })
    if (!seenBook.has(bookKey)) {
      seenBook.add(bookKey)
      bookKeys.push(bookKey)
    }
  }

  const unmappedBriefKeys = [...mintable].filter((b) => !mappedBrief.has(b))
  return { bookKeys, pairs, unmappedBriefKeys, orphanProspectKeys }
}

/** 用户 tick：解法级默认正文 = conclusion + 分步 infer；可选附 prospect */
export function composeNormTextFromPath(input: {
  inferText: string
  prospectText: string
  conclusion?: string
  stepTexts?: string[]
  prospectTexts?: string[]
}): string {
  const conclusion = (input.conclusion ?? '').trim()
  const steps = (input.stepTexts ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
  const prospects = (input.prospectTexts ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
  if (conclusion || steps.length > 0) {
    const parts: string[] = []
    if (conclusion) parts.push(conclusion)
    if (steps.length > 0) {
      parts.push(
        steps.map((t, i) => `〔步骤${i + 1}〕${t}`).join('\n'),
      )
    }
    if (prospects.length > 0) {
      parts.push(
        `〔预测载荷〕${prospects.join('；')}`,
      )
    } else if (input.prospectText.trim()) {
      parts.push(`〔预测补全〕${input.prospectText.trim()}`)
    }
    return parts.join('\n\n')
  }
  const infer = input.inferText.trim()
  const prospect = input.prospectText.trim()
  if (infer && prospect) {
    return `${infer}\n\n〔预测补全〕${prospect}`
  }
  return infer || prospect
}
