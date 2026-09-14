/**
 * 实验：decide toc_nav —— 走廊表（标题 + 校准后 strand）→ LLM 只吐 strand 起止
 * → 台侧 strand ∩ A1 拼 bookKey → 正文 decide。
 * 非 toc_map（出目录）；本轮不解决 memberKeys、不喂 bookKey 端点。
 */

import type { BookIndex } from '../reasoning/pipelineA'
import type { BookSemanticIndex, SectionNode } from '../reasoning/semanticIndex'
import { extractJsonObject } from '../reasoning/inferPath'
import {
  expandStrandRangesToBookKeys,
  type SeedRange,
  type StrandRange,
} from './seedRange'

export type TocCorridor = {
  index: number
  nodeId: string
  title: string
  /** 校准后机器牌 strand（闭区间）；语义同 A1.chunk.page */
  startStrand: number
  endStrand: number
}

function strandOfSection(sec: SectionNode): {
  startStrand: number
  endStrand: number
} | null {
  const start = sec.pageRange?.startPage ?? sec.page
  const end = sec.pageRange?.endPage ?? start
  if (start == null || !Number.isFinite(start)) return null
  const a = Math.max(0, Math.floor(Number(start)))
  const b = Math.max(0, Math.floor(Number(end ?? start)))
  return a <= b
    ? { startStrand: a, endStrand: b }
    : { startStrand: b, endStrand: a }
}

/** 有标题 + strand 界的走廊（不要求 memberKeys 已挂） */
export function listTocCorridors(
  semantic: BookSemanticIndex | null | undefined,
  _bookIndex?: BookIndex,
): TocCorridor[] {
  const sections = (semantic?.sections ?? []).filter(
    (s) => (s.title || '').trim().length > 0,
  )
  if (sections.length === 0) return []
  const out: TocCorridor[] = []
  let index = 0
  for (const sec of sections) {
    const st = strandOfSection(sec)
    if (!st) continue
    out.push({
      index,
      nodeId: sec.nodeId,
      title: sec.title.trim().slice(0, 120),
      startStrand: st.startStrand,
      endStrand: st.endStrand,
    })
    index++
  }
  return out
}

/**
 * 紧凑目录：⟦n⟧ 槽 + 标题 + 校准后 strand；禁止把 bookKey / members 塞进模型。
 */
export function formatTocCatalogForDecide(corridors: TocCorridor[]): string {
  if (corridors.length === 0) return ''
  const lines = [
    '【目录框架 · toc_nav】章节走廊（勿读正文、勿铸 prospect）。',
    '每条走廊以 ⟦n⟧ 独占行标槽；strand 已是校准后的机器牌。',
    '请只根据 Q_now 与标题选读界。',
    '输出 seedRanges:[{ "fromStrand": N, "toStrand": M }, …]；stopReason:"expand"。',
    '禁止输出 bookKey、印码、memberKeys、走廊 ⟦n⟧ 当地址；勿用单条巨跨度盖全书。',
    '',
  ]
  for (const c of corridors) {
    const slot = `⟦${c.index + 1}⟧`
    lines.push(slot)
    lines.push(`${c.title} · strand ${c.startStrand}–${c.endStrand}`)
    lines.push('')
  }
  return lines.join('\n')
}

function asInt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw)
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim())
    if (Number.isFinite(n)) return Math.floor(n)
  }
  return null
}

function pushStrand(
  drafts: StrandRange[],
  from: number | null,
  to: number | null,
) {
  if (from == null || to == null) return
  const a = Math.max(0, from)
  const b = Math.max(0, to)
  drafts.push(
    a <= b
      ? { fromStrand: a, toStrand: b }
      : { fromStrand: b, toStrand: a },
  )
}

/**
 * 解析 toc_nav：优先 fromStrand/toStrand（或 startStrand/endStrand）。
 * sectionIndex 仅作兜底 → 映射为该章校准 strand（仍由台展开，不经 memberKeys）。
 */
export function parseTocNavStrandRanges(
  llmText: string,
  corridors: TocCorridor[],
): StrandRange[] {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return []
  const root = obj as Record<string, unknown>
  const drafts: StrandRange[] = []
  const byIndex = new Map(corridors.map((c) => [c.index, c]))
  const byNode = new Map(corridors.map((c) => [c.nodeId, c]))

  const ingestRow = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const r = raw as Record<string, unknown>

    const fromS =
      asInt(r.fromStrand) ??
      asInt(r.startStrand) ??
      asInt(r.strandFrom) ??
      asInt(r.loStrand)
    const toS =
      asInt(r.toStrand) ??
      asInt(r.endStrand) ??
      asInt(r.strandTo) ??
      asInt(r.hiStrand)
    if (fromS != null && toS != null) {
      pushStrand(drafts, fromS, toS)
      return
    }

    // 数值 from/to（非 bookKey 串）→ 当 strand
    const fromN = asInt(r.from)
    const toN = asInt(r.to)
    if (
      fromN != null &&
      toN != null &&
      typeof r.from !== 'string' &&
      typeof r.to !== 'string'
    ) {
      pushStrand(drafts, fromN, toN)
      return
    }
    if (
      fromN != null &&
      toN != null &&
      typeof r.from === 'string' &&
      typeof r.to === 'string' &&
      !String(r.from).includes('h1.') &&
      !String(r.to).includes('h1.') &&
      /^\d+$/.test(String(r.from).trim()) &&
      /^\d+$/.test(String(r.to).trim())
    ) {
      pushStrand(drafts, fromN, toN)
      return
    }

    if (typeof r.sectionIndex === 'number' || typeof r.i === 'number') {
      const c = byIndex.get(
        typeof r.sectionIndex === 'number' ? r.sectionIndex : (r.i as number),
      )
      if (c) pushStrand(drafts, c.startStrand, c.endStrand)
      return
    }
    const nodeId = String(r.nodeId ?? '').trim()
    if (nodeId && byNode.has(nodeId)) {
      const c = byNode.get(nodeId)!
      pushStrand(drafts, c.startStrand, c.endStrand)
    }
  }

  if (Array.isArray(root.seedRanges) && root.seedRanges.length > 0) {
    for (const row of root.seedRanges) ingestRow(row)
    return drafts
  }
  ingestRow(root.seedRange)
  return drafts
}

/** @deprecated 用 parseTocNavStrandRanges；保留名给旧 import */
export function parseTocNavSeedDrafts(
  llmText: string,
  corridors: TocCorridor[],
): StrandRange[] {
  return parseTocNavStrandRanges(llmText, corridors)
}

/** strand 闭集 → bookKey 闭集（每段取书序首尾门牌，供后续 expand 锚点） */
export function closedBookSeedsFromStrandRanges(
  bookIndex: BookIndex,
  ranges: StrandRange[],
): SeedRange[] {
  const expanded = expandStrandRangesToBookKeys({
    bookIndex,
    ranges,
    maxKeys: Number.MAX_SAFE_INTEGER,
  })
  return expanded.usedClosed
}

export function closedFromTocDrafts(drafts: StrandRange[]): StrandRange[] {
  const out: StrandRange[] = []
  const seen = new Set<string>()
  for (const d of drafts) {
    const id = `${d.fromStrand}\0${d.toStrand}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(d)
  }
  return out
}

/** 旧 API：端点 bookKey 集；strand 路径不再用于 toc_nav 组窗 */
export function tocEndpointKeySet(_corridors: TocCorridor[]): Set<string> {
  return new Set()
}
