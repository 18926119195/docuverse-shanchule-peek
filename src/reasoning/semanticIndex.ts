/**
 * BookSemanticIndex: section tree + slot provenance (semantic map over A1).
 */

import type { BookIndex } from './pipelineA'
import { atomSearchText, bm25Rank, tokenizeQuery } from './hybridRetrieve'
import type { PageCalibration } from './pageCalibration'
import {
  maxPrintedForStrand,
  printedRangeToStrandRange,
} from './pageCalibration'
import type { TocEntryDraft } from './tocParse'
import { fillEndPrinted, fillEndStrand, tocEntryHasStrand } from './tocParse'

export type SectionSource = 'ocr_title' | 'page_header' | 'heuristic'

export interface SectionNode {
  nodeId: string
  docId: string
  page: number
  /** Inclusive page span for TOC shrink (pageRange ∩ A1 → memberKeys) */
  pageRange?: { startPage: number; endPage: number }
  /** Keys belonging to this corridor（pageRange ∩ A1；确认后随 sync/hydrate 回填） */
  memberKeys?: string[]
  title: string
  summary: string
  source: SectionSource
  probe?: number[]
  parentId?: string
  ord: number
}

export type SlotRole = 'body' | 'title' | 'caption' | 'figure'

export interface SlotProvenance {
  key: string
  primaryNodeId: string
  secondaryNodeIds?: string[]
  role: SlotRole
}

export interface BookSemanticIndex {
  docId: string
  sections: SectionNode[]
  provenance: SlotProvenance[]
  builtAt: number
  /** True after human TOC wizard confirms memberKeys */
  tocConfirmed?: boolean
  /** User skipped wizard — no TOC closed set (L0 skipped; BM25 whole-book) */
  tocSkipped?: boolean
  /** Printed ↔ strand calibration used for last confirm */
  pageCalibration?: PageCalibration
}

/** Empty semantic shell: A1 ready, no corridor for L0. */
export function emptySemanticIndex(docId: string): BookSemanticIndex {
  return {
    docId,
    sections: [],
    provenance: [],
    builtAt: Date.now(),
    tocConfirmed: false,
    tocSkipped: true,
  }
}

const TITLE_MAX_LEN = 96
const TITLE_TOP_Y = 220

function isTitleLike(text: string, bbox: [number, number, number, number]): boolean {
  const t = text.trim()
  if (!t || t.length > TITLE_MAX_LEN) return false
  if (bbox[1] > TITLE_TOP_Y) return false
  if (/^第\s*[0-9一二三四五六七八九十百千]+/.test(t)) return true
  if (/^(chapter|section|part)\s/i.test(t)) return true
  if (/^[0-9]+(\.[0-9]+)*\s+\S/.test(t)) return true
  if (t.length <= 40 && !/[。！？；，,.!?;]$/.test(t)) return true
  return false
}

function roleOfChunk(kind: string, isTitle: boolean): SlotRole {
  if (isTitle) return 'title'
  if (kind === 'fig') return 'figure'
  return 'body'
}

/**
 * Build semantic index from A1: one section per page + title heuristic + slot provenance.
 */
export function buildSemanticIndex(bookIndex: BookIndex): BookSemanticIndex {
  const docId = bookIndex.docId
  const byPage = new Map<number, typeof bookIndex.chunks>()
  for (const c of bookIndex.chunks) {
    const list = byPage.get(c.page) ?? []
    list.push(c)
    byPage.set(c.page, list)
  }

  const sections: SectionNode[] = []
  const provenance: SlotProvenance[] = []
  const pages = [...byPage.keys()].sort((a, b) => a - b)

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi]
    const chunks = [...(byPage.get(page) ?? [])].sort(
      (a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0],
    )

    let title = `第 ${page + 1} 页`
    let source: SectionSource = 'heuristic'
    for (const c of chunks) {
      const text = atomSearchText(c)
      if (isTitleLike(text, c.bbox)) {
        title = text.slice(0, TITLE_MAX_LEN)
        source = c.source === 'ocr' ? 'ocr_title' : 'page_header'
        break
      }
    }

    const summaryParts = chunks
      .slice(0, 4)
      .map((c) => atomSearchText(c).slice(0, 80))
      .filter(Boolean)
    const summary = summaryParts.join(' · ').slice(0, 240)

    const nodeId = `sec_${docId}_p${page}`
    const memberKeys = chunks.map((c) => c.key)
    sections.push({
      nodeId,
      docId,
      page,
      pageRange: { startPage: page, endPage: page },
      memberKeys,
      title,
      summary,
      source,
      ord: pi,
    })

    for (const c of chunks) {
      const text = atomSearchText(c)
      const isTitle = isTitleLike(text, c.bbox)
      provenance.push({
        key: c.key,
        primaryNodeId: nodeId,
        role: roleOfChunk(c.kind, isTitle),
      })
    }
  }

  return {
    docId,
    sections,
    provenance,
    builtAt: Date.now(),
    tocConfirmed: false,
  }
}

export function provenanceByKey(
  index: BookSemanticIndex,
): Map<string, SlotProvenance> {
  return new Map(index.provenance.map((p) => [p.key, p]))
}

export function sectionById(
  index: BookSemanticIndex,
  nodeId: string,
): SectionNode | undefined {
  return index.sections.find((s) => s.nodeId === nodeId)
}

/** Section-level hit: BM25 on title + summary */
export function rankSections(
  index: BookSemanticIndex,
  question: string,
  topK = 5,
): Array<{ node: SectionNode; score: number }> {
  const q = question.trim()
  if (!q) return []
  const docs = index.sections.map((node) => `${node.title} ${node.summary}`)
  const ranked = bm25Rank(q, docs, index.sections.length)
  return ranked
    .filter((h) => h.score > 0.01)
    .slice(0, topK)
    .map((h) => ({ node: index.sections[h.index], score: h.score }))
}

/** Restrict draft keys to those belonging to hit sections */
export function keysInSections(
  index: BookSemanticIndex,
  sectionIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>()
  for (const sec of index.sections) {
    if (!sectionIds.has(sec.nodeId)) continue
    if (sec.memberKeys?.length) {
      for (const k of sec.memberKeys) out.add(k)
    }
  }
  if (out.size > 0) return out
  for (const p of index.provenance) {
    if (sectionIds.has(p.primaryNodeId)) out.add(p.key)
  }
  return out
}

/**
 * Soft ready for wizard preview (heuristic sections exist).
 * Confirmed TOC is required for L0 corridor shrink — see tocConfirmed.
 */
export function semanticTocReady(index: BookSemanticIndex | null): boolean {
  if (!index) return false
  if (index.tocSkipped) return true
  if (index.tocConfirmed) {
    return index.sections.some(
      (s) => (s.memberKeys?.length ?? 0) > 0 || Boolean(s.pageRange),
    )
  }
  return index.sections.some(
    (s) => (s.memberKeys?.length ?? 0) > 0 || Boolean(s.pageRange),
  )
}

/** True only when human confirmed real TOC (closed set for L0). */
export function hasConfirmedToc(index: BookSemanticIndex | null): boolean {
  return Boolean(
    index?.tocConfirmed &&
      index.sections.some((s) => (s.memberKeys?.length ?? 0) > 0),
  )
}

/**
 * Confirm / patch TOC: set pageRange and recompute memberKeys via page ∩ A1.
 * Does not write task briefs into the directory.
 */
export function confirmTocSections(
  index: BookSemanticIndex,
  bookIndex: BookIndex,
  patches: ReadonlyArray<{
    nodeId: string
    title?: string
    pageRange?: { startPage: number; endPage: number }
  }>,
): BookSemanticIndex {
  const byPage = new Map<number, string[]>()
  for (const c of bookIndex.chunks) {
    const list = byPage.get(c.page) ?? []
    list.push(c.key)
    byPage.set(c.page, list)
  }

  const sections = index.sections.map((sec) => {
    const patch = patches.find((p) => p.nodeId === sec.nodeId)
    if (!patch) return sec
    const pageRange = patch.pageRange ??
      sec.pageRange ?? { startPage: sec.page, endPage: sec.page }
    const memberKeys: string[] = []
    for (let p = pageRange.startPage; p <= pageRange.endPage; p++) {
      for (const k of byPage.get(p) ?? []) memberKeys.push(k)
    }
    return {
      ...sec,
      title: patch.title ?? sec.title,
      pageRange,
      memberKeys: [...new Set(memberKeys)],
    }
  })

  const provenance = index.provenance.map((p) => {
    const owner = sections.find((s) => s.memberKeys?.includes(p.key))
    return owner ? { ...p, primaryNodeId: owner.nodeId } : p
  })

  return {
    ...index,
    sections,
    provenance,
    tocConfirmed: true,
    tocSkipped: false,
    builtAt: Date.now(),
  }
}

/**
 * 同 strand 闭区间的连续节：标题并入上一节，去掉空壳
 * （避免先到先得抢走 key 后后节 memberKeys=0）。
 */
export function collapseSectionsSharingPageRange(
  sections: ReadonlyArray<SectionNode>,
): SectionNode[] {
  const ordered = [...sections].sort((a, b) => a.ord - b.ord)
  const out: SectionNode[] = []
  for (const sec of ordered) {
    const lo = sec.pageRange?.startPage ?? sec.page
    const hi = sec.pageRange?.endPage ?? lo
    const last = out[out.length - 1]
    if (last) {
      const plo = last.pageRange?.startPage ?? last.page
      const phi = last.pageRange?.endPage ?? plo
      if (plo === lo && phi === hi) {
        const add = (sec.title || '').trim()
        const base = (last.title || '').trim()
        const title =
          add && base && !base.includes(add)
            ? `${base} · ${add}`.slice(0, 240)
            : base || add
        const members = [
          ...new Set([
            ...(last.memberKeys ?? []),
            ...(sec.memberKeys ?? []),
          ]),
        ]
        last.title = title
        last.memberKeys = members
        last.summary = `strand ${plo}–${phi} · 机器牌 ${plo + 1}–${phi + 1} · ${members.length} keys`
        continue
      }
    }
    out.push({
      ...sec,
      pageRange: { startPage: Math.min(lo, hi), endPage: Math.max(lo, hi) },
      memberKeys: [...(sec.memberKeys ?? [])],
    })
  }
  return out.map((s, i) => ({
    ...s,
    ord: i,
    page: s.pageRange?.startPage ?? s.page,
  }))
}

function provenanceFromSections(
  sections: ReadonlyArray<SectionNode>,
): SlotProvenance[] {
  const provenance: SlotProvenance[] = []
  for (const sec of sections) {
    for (const k of sec.memberKeys ?? []) {
      provenance.push({
        key: k,
        primaryNodeId: sec.nodeId,
        role: 'body',
      })
    }
  }
  return provenance
}

/**
 * 已确认 TOC：用各节 pageRange ∩ 当前 A1 重算 memberKeys。
 * 同页界连续节合并标题；hydrate / sync 时也会跑。
 */
export function reconcileTocMemberKeys(
  semantic: BookSemanticIndex,
  bookIndex: BookIndex,
): BookSemanticIndex {
  if (
    !semantic.tocConfirmed ||
    semantic.tocSkipped ||
    semantic.docId !== bookIndex.docId ||
    semantic.sections.length === 0
  ) {
    return semantic
  }

  const byPage = new Map<number, string[]>()
  for (const c of bookIndex.chunks) {
    const list = byPage.get(c.page) ?? []
    list.push(c.key)
    byPage.set(c.page, list)
  }

  const claimed = new Set<string>()
  const memberByNode = new Map<string, string[]>()
  const ordered = [...semantic.sections].sort((a, b) => a.ord - b.ord)
  for (const sec of ordered) {
    const pageRange = sec.pageRange ?? {
      startPage: sec.page,
      endPage: sec.page,
    }
    const startPage = Math.min(pageRange.startPage, pageRange.endPage)
    const endPage = Math.max(pageRange.startPage, pageRange.endPage)
    const memberKeys: string[] = []
    for (let p = startPage; p <= endPage; p++) {
      for (const k of byPage.get(p) ?? []) {
        if (claimed.has(k)) continue
        claimed.add(k)
        memberKeys.push(k)
      }
    }
    memberByNode.set(sec.nodeId, memberKeys)
  }

  const sectionsRaw = semantic.sections.map((sec) => {
    const pageRange = sec.pageRange ?? {
      startPage: sec.page,
      endPage: sec.page,
    }
    const startPage = Math.min(pageRange.startPage, pageRange.endPage)
    const endPage = Math.max(pageRange.startPage, pageRange.endPage)
    const memberKeys = memberByNode.get(sec.nodeId) ?? []
    return {
      ...sec,
      pageRange: { startPage, endPage },
      memberKeys,
      summary: `strand ${startPage}–${endPage} · 机器牌 ${startPage + 1}–${endPage + 1} · ${memberKeys.length} keys`,
    }
  })
  const sections = collapseSectionsSharingPageRange(sectionsRaw)

  return {
    ...semantic,
    sections,
    provenance: provenanceFromSections(sections),
    tocConfirmed: true,
    tocSkipped: false,
    builtAt: Date.now(),
  }
}

/**
 * Replace heuristic sections with TOC chapters.
 * 主路径：entries 带印码，校准后写入 startStrand/endStrand；
 * 确认时以 strand 闭集挂 memberKeys。
 */
export function buildSemanticFromTocEntries(input: {
  bookIndex: BookIndex
  entries: ReadonlyArray<TocEntryDraft>
  /** 有 strand 时可缺；仅印码路径需要 */
  calibration?: PageCalibration | null
  /** Max printed page for last chapter end fill（印码路径） */
  lastPrintedFallback?: number
  /** Max strand for last chapter（strand 路径） */
  lastStrandFallback?: number
}): BookSemanticIndex {
  const { bookIndex } = input
  const maxStrand = Math.max(
    0,
    input.lastStrandFallback ?? 0,
    ...bookIndex.chunks.map((c) => c.page),
  )
  const allHaveStrand = input.entries.every(tocEntryHasStrand)
  const entries = allHaveStrand
    ? fillEndStrand([...input.entries], maxStrand)
    : fillEndPrinted(
        [...input.entries],
        input.lastPrintedFallback ??
          (input.calibration
            ? maxPrintedForStrand(maxStrand, input.calibration)
            : undefined),
      )

  const byPage = new Map<number, string[]>()
  for (const c of bookIndex.chunks) {
    const list = byPage.get(c.page) ?? []
    list.push(c.key)
    byPage.set(c.page, list)
  }

  const sections: SectionNode[] = []
  const claimed = new Set<string>()

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    let startPage: number
    let endPage: number
    if (tocEntryHasStrand(e)) {
      startPage = Math.max(0, Math.min(maxStrand, e.startStrand!))
      endPage = Math.max(0, Math.min(maxStrand, e.endStrand!))
    } else if (input.calibration) {
      const range = printedRangeToStrandRange(
        e.startPrinted,
        e.endPrinted,
        input.calibration,
      )
      startPage = Math.max(0, range.startPage)
      endPage = Math.min(maxStrand, range.endPage)
    } else {
      continue
    }
    if (endPage < startPage) [startPage, endPage] = [endPage, startPage]

    const memberKeys: string[] = []
    for (let p = startPage; p <= endPage; p++) {
      for (const k of byPage.get(p) ?? []) {
        if (!claimed.has(k)) {
          memberKeys.push(k)
          claimed.add(k)
        }
      }
    }
    const nodeId = `sec_${bookIndex.docId}_toc_${i}`
    const summary = `strand ${startPage}–${endPage} · 机器牌 ${startPage + 1}–${endPage + 1} · ${memberKeys.length} keys`
    sections.push({
      nodeId,
      docId: bookIndex.docId,
      page: startPage,
      pageRange: { startPage, endPage },
      memberKeys,
      title: e.title,
      summary,
      source: 'heuristic',
      ord: i,
    })
  }

  const collapsed = collapseSectionsSharingPageRange(sections)

  return {
    docId: bookIndex.docId,
    sections: collapsed,
    provenance: provenanceFromSections(collapsed),
    builtAt: Date.now(),
    tocConfirmed: true,
    tocSkipped: false,
    pageCalibration: input.calibration ?? undefined,
  }
}

export function sectionHitNote(
  hits: Array<{ node: SectionNode; score: number }>,
): string {
  if (hits.length === 0) return ''
  return hits
    .slice(0, 3)
    .map((h) => `${h.node.title}(p${h.node.page + 1}:${h.score.toFixed(2)})`)
    .join(' · ')
}

export function tokenOverlapSectionScore(question: string, node: SectionNode): number {
  const qt = new Set(tokenizeQuery(question))
  const st = new Set(tokenizeQuery(`${node.title} ${node.summary}`))
  if (qt.size === 0 || st.size === 0) return 0
  let inter = 0
  for (const t of qt) if (st.has(t)) inter += 1
  return inter / Math.sqrt(qt.size * st.size)
}
