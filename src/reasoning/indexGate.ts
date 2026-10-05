/**
 * Post-upload gate: OCR → A1 build → ready for questions.
 * 扫描件：页级并行渲→emit；语料包可 hydrate 跳过重跑。
 * TOC wizard: 选目录页 → toc_map（strand 主坐标）→ confirm；可跳过。
 */

import { create } from 'zustand'
import { saveBookIndex } from './bookIndexStore'
import {
  buildBookIndex,
  patchAtomTextInBookIndex,
  rebuildPagesInBookIndex,
  type BookIndex,
} from './pipelineA'
import {
  buildSemanticFromTocEntries,
  buildSemanticIndex,
  emptySemanticIndex,
  reconcileTocMemberKeys,
  semanticTocReady,
  type BookSemanticIndex,
} from './semanticIndex'
import { saveSemanticIndex } from './semanticIndexStore'
import type { OcrPageResult } from '../data/ocrService'
import type { PageDocument } from '../zigzag/types'
import type { PageCalibration } from './pageCalibration'
import { normalizeCalibration } from './pageCalibration'
import type { TocEntryDraft } from './tocParse'
import { tocEntryHasStrand } from './tocParse'

export type IndexPhase =
  | 'idle'
  | 'importing'
  | 'ocr'
  | 'embedding'
  | 'ready'
  | 'error'

export type TocWizardStatus = 'idle' | 'pending' | 'confirmed' | 'skipped'

interface IndexGateState {
  phase: IndexPhase
  message: string
  ready: boolean
  bookIndex: BookIndex | null
  semanticIndex: BookSemanticIndex | null
  lastError: string | null
  /** TOC wizard lifecycle */
  tocStatus: TocWizardStatus
  tocWizardOpen: boolean
  /** 每次 openTocWizard 递增；隐去后点「打开向导」也能强制重显浮窗 */
  tocWizardRevealEpoch: number
  pageCalibration: PageCalibration | null

  reset: () => void
  setImporting: (msg?: string) => void
  finalizeIndex: (input: {
    docId: string
    pages: PageDocument[]
    ocrByStrand: Record<number, OcrPageResult>
  }) => Promise<BookIndex>
  syncPages: (input: {
    docId: string
    pages: PageDocument[]
    ocrByStrand: Record<number, OcrPageResult>
    pageIndices: number[]
  }) => Promise<BookIndex>
  syncAtomText: (input: {
    atomKey: string
    content: string
  }) => Promise<BookIndex | null>
  setError: (msg: string) => void
  setBookIndex: (index: BookIndex, ready?: boolean) => void

  openTocWizard: () => void
  closeTocWizard: () => void
  setPageCalibration: (cal: PageCalibration | null) => void
  /** Apply TOC entries → replace semantic sections; keep ready */
  confirmTocWizard: (entries: TocEntryDraft[]) => {
    ok: boolean
    error?: string
  }
  /** Skip formal TOC; clear heuristic sections — no fake one-page TOC */
  skipTocWizard: () => void
  /** 语料包恢复：直接挂已有 A1/目录，跳过 OCR 建库 */
  hydrateFromCorpusPack: (input: {
    bookIndex: BookIndex
    semanticIndex: BookSemanticIndex | null
  }) => void
}

export const useIndexGate = create<IndexGateState>((set, get) => ({
  phase: 'idle',
  message: '尚未导入文献',
  ready: false,
  bookIndex: null,
  semanticIndex: null,
  lastError: null,
  tocStatus: 'idle',
  tocWizardOpen: false,
  tocWizardRevealEpoch: 0,
  pageCalibration: null,

  reset: () =>
    set({
      phase: 'idle',
      message: '尚未导入文献',
      ready: false,
      bookIndex: null,
      semanticIndex: null,
      lastError: null,
      tocStatus: 'idle',
      tocWizardOpen: false,
      pageCalibration: null,
    }),

  setImporting: (msg) =>
    set({
      phase: 'importing',
      message: msg ?? '正在导入…',
      ready: false,
      lastError: null,
      tocStatus: 'idle',
      tocWizardOpen: false,
      pageCalibration: null,
    }),

  setError: (msg) =>
    set({
      phase: 'error',
      message: msg,
      ready: false,
      lastError: msg,
    }),

  setBookIndex: (index, ready = true) => {
    saveBookIndex(index)
    const semantic = buildSemanticIndex(index)
    saveSemanticIndex(semantic)
    const tocOk = semanticTocReady(semantic)
    // layout 划重点 ↔ bookKey 同步进共享基底
    void import('./pageMarkStore').then(({ usePageMarkStore }) => {
      usePageMarkStore.getState().syncLayoutFromBookIndex(index)
    })
    set({
      bookIndex: index,
      semanticIndex: semantic,
      ready: ready && tocOk,
      phase: ready && tocOk ? 'ready' : ready ? 'embedding' : 'embedding',
      message:
        ready && tocOk
          ? `文献就绪 · ${index.chunks.length} 段 · ${semantic.sections.length} 节（启发式目录·请确认或跳过）`
          : ready
            ? '文献已建库，目录归 key 未完成'
            : '文献整理中…',
      lastError: null,
      tocStatus: ready && tocOk ? 'pending' : get().tocStatus,
      tocWizardOpen: ready && tocOk,
    })
  },

  finalizeIndex: async (input) => {
    set({
      phase: 'embedding',
      message: '正在整理文献…',
      ready: false,
      lastError: null,
    })
    try {
      const raw = await buildBookIndex(input)
      saveBookIndex(raw)
      const semantic = buildSemanticIndex(raw)
      saveSemanticIndex(semantic)
      const tocOk = semanticTocReady(semantic)
      void import('./pageMarkStore').then(({ usePageMarkStore }) => {
        usePageMarkStore.getState().syncLayoutFromBookIndex(raw)
      })
      set({
        bookIndex: raw,
        semanticIndex: semantic,
        ready: tocOk,
        phase: tocOk ? 'ready' : 'embedding',
        message: tocOk
          ? `文献就绪 · ${raw.chunks.length} 段 · ${semantic.sections.length} 节（启发式目录·请确认 TOC 或跳过）`
          : `建库完成但目录未就绪 · ${raw.chunks.length} 段`,
        lastError: null,
        tocStatus: tocOk ? 'pending' : 'idle',
        tocWizardOpen: tocOk,
        pageCalibration: null,
      })
      return raw
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        phase: 'error',
        message: msg,
        ready: false,
        lastError: msg,
      })
      throw e
    }
  },

  syncPages: async (input) => {
    const pagesLabel = [...input.pageIndices]
      .sort((a, b) => a - b)
      .map((p) => `s${p}`)
      .join(',')
    const prevReady = get().ready
    const prevToc = get().tocStatus
    const prevPhase = get().phase
    const prevMessage = get().message
    const prevWizardOpen = get().tocWizardOpen
    /** 目录向导已开 / 已确认时：后台增量同步，不打断选页与 toc_map */
    const bg =
      prevWizardOpen ||
      prevToc === 'pending' ||
      prevToc === 'confirmed' ||
      prevToc === 'skipped'
    if (!bg) {
      set({
        phase: 'embedding',
        message: `正在同步索引（${pagesLabel || '页'}）…`,
        lastError: null,
      })
    }
    try {
      const existing =
        get().bookIndex && get().bookIndex!.docId === input.docId
          ? get().bookIndex
          : null
      const { index } = await rebuildPagesInBookIndex({
        existing,
        docId: input.docId,
        pages: input.pages,
        ocrByStrand: input.ocrByStrand,
        pageIndices: input.pageIndices,
      })
      saveBookIndex(index)
      void import('./pageMarkStore').then(({ usePageMarkStore }) => {
        usePageMarkStore.getState().syncLayoutFromBookIndex(index)
      })
      // 后台新页 → 仅当本问仍 insufficient 时补给热启饲料（不冲三态闸）
      {
        const prevKeys = new Set((existing?.chunks ?? []).map((c) => c.key))
        const newBookKeys = index.chunks
          .map((c) => c.key)
          .filter((k) => !prevKeys.has(k))
        if (newBookKeys.length > 0) {
          void import('./ingestLlmFeed').then(({ noteBookIndexAugmented }) => {
            noteBookIndexAugmented({
              docId: input.docId,
              bookIndex: index,
              newBookKeys,
            })
          })
        }
      }
      // Keep confirmed TOC（回填 pageRange∩A1）；keep empty skip shell；else rebuild heuristic for wizard only
      let semantic = get().semanticIndex
      if (semantic?.tocSkipped && semantic.docId === index.docId) {
        semantic = emptySemanticIndex(index.docId)
      } else if (semantic?.tocConfirmed && semantic.docId === index.docId) {
        semantic = reconcileTocMemberKeys(semantic, index)
      } else if (
        !(prevToc === 'pending' && prevWizardOpen) &&
        (!semantic ||
          semantic.docId !== index.docId ||
          !semantic.tocConfirmed)
      ) {
        semantic = buildSemanticIndex(index)
      }
      if (semantic) saveSemanticIndex(semantic)
      const tocOk = semantic ? semanticTocReady(semantic) : false
      const memberN =
        semantic?.tocConfirmed === true
          ? semantic.sections.reduce(
              (n, s) => n + (s.memberKeys?.length ?? 0),
              0,
            )
          : 0
      set({
        bookIndex: index,
        semanticIndex: semantic,
        ready: bg ? prevReady || tocOk : tocOk,
        phase: bg ? prevPhase : tocOk ? 'ready' : 'embedding',
        message: bg
          ? semantic?.tocConfirmed
            ? `目录已确认 · 归属随页回填 · ${index.chunks.length} 段 · memberKeys×${memberN}`
            : prevMessage
          : tocOk
            ? `文献就绪 · ${index.chunks.length} 段 · ${semantic?.sections.length ?? 0} 节（已同步 ${pagesLabel}）`
            : `同步完成但目录未就绪 · ${pagesLabel}`,
        lastError: null,
        tocStatus: prevToc === 'confirmed' ? 'confirmed' : prevToc,
        tocWizardOpen: prevWizardOpen,
      })
      return index
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        phase: prevReady ? 'ready' : bg ? prevPhase : 'error',
        ready: prevReady,
        message: prevReady || bg
          ? `${prevMessage} · 同步失败: ${msg}`
          : msg,
        lastError: msg,
        tocWizardOpen: prevWizardOpen,
        tocStatus: prevToc,
      })
      throw e
    }
  },

  syncAtomText: async (input) => {
    const existing = get().bookIndex
    if (!existing) return null
    try {
      const { index, patched } = await patchAtomTextInBookIndex(
        existing,
        input.atomKey,
        input.content,
      )
      if (!patched) return existing
      saveBookIndex(index)
      const prev = get().semanticIndex
      const semantic =
        prev?.tocSkipped && prev.docId === index.docId
          ? emptySemanticIndex(index.docId)
          : prev?.tocConfirmed && prev.docId === index.docId
            ? reconcileTocMemberKeys(prev, index)
            : buildSemanticIndex(index)
      saveSemanticIndex(semantic)
      set({
        bookIndex: index,
        semanticIndex: semantic,
        ready: true,
        phase: 'ready',
        message: `文献就绪 · ${index.chunks.length} 段 · ${semantic.sections.length} 节（已更新 T）`,
        lastError: null,
      })
      return index
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ lastError: msg })
      throw e
    }
  },

  openTocWizard: () =>
    set((s) => ({
      tocWizardOpen: true,
      tocWizardRevealEpoch: s.tocWizardRevealEpoch + 1,
    })),
  closeTocWizard: () => set({ tocWizardOpen: false }),
  setPageCalibration: (cal) =>
    set({ pageCalibration: cal ? normalizeCalibration(cal) : null }),

  confirmTocWizard: (entries) => {
    const bookIndex = get().bookIndex
    const cal = get().pageCalibration
    if (!bookIndex) return { ok: false, error: '尚无 A1 索引' }
    if (entries.length === 0) return { ok: false, error: '目录条目为空' }

    const allStrand = entries.every((e) => tocEntryHasStrand(e))
    if (!allStrand && !cal) {
      return {
        ok: false,
        error: '条目缺少 strand 界：请先跑 toc_map，或完成印码校准',
      }
    }

    const maxStrand = Math.max(0, ...bookIndex.chunks.map((c) => c.page))
    const semantic = buildSemanticFromTocEntries({
      bookIndex,
      entries,
      calibration: cal,
      lastStrandFallback: maxStrand,
    })
    const empty = semantic.sections.filter(
      (s) => (s.memberKeys?.length ?? 0) === 0,
    )
    if (empty.length === semantic.sections.length) {
      return {
        ok: false,
        error: '所有章节 key 数为 0：请检查 strand 范围是否超出已导入页',
      }
    }
    saveSemanticIndex(semantic)
    set({
      semanticIndex: semantic,
      tocStatus: 'confirmed',
      tocWizardOpen: false,
      ready: true,
      phase: 'ready',
      message: `目录已确认 · ${semantic.sections.length} 章 · ${bookIndex.chunks.length} 段可检索`,
      lastError: null,
    })
    return { ok: true }
  },

  hydrateFromCorpusPack: (input) => {
    const { bookIndex, semanticIndex } = input
    saveBookIndex(bookIndex)
    let semantic =
      semanticIndex && semanticIndex.docId === bookIndex.docId
        ? semanticIndex
        : buildSemanticIndex(bookIndex)
    if (semantic.tocConfirmed && !semantic.tocSkipped) {
      semantic = reconcileTocMemberKeys(semantic, bookIndex)
    }
    saveSemanticIndex(semantic)
    void import('./pageMarkStore').then(({ usePageMarkStore }) => {
      usePageMarkStore.getState().syncLayoutFromBookIndex(bookIndex)
    })
    const confirmed = semantic.tocConfirmed === true
    const skipped = semantic.tocSkipped === true
    const tocOk = semanticTocReady(semantic)
    const memberN = confirmed
      ? semantic.sections.reduce((n, s) => n + (s.memberKeys?.length ?? 0), 0)
      : 0
    set({
      bookIndex,
      semanticIndex: semantic,
      ready: true,
      phase: 'ready',
      message: confirmed
        ? `语料包已载入 · ${bookIndex.chunks.length} 段 · 目录已确认 · 归属回填 memberKeys×${memberN}`
        : skipped
          ? `语料包已载入 · ${bookIndex.chunks.length} 段 · 目录曾跳过`
          : tocOk
            ? `语料包已载入 · ${bookIndex.chunks.length} 段 · 请确认或跳过目录`
            : `语料包已载入 · ${bookIndex.chunks.length} 段`,
      lastError: null,
      tocStatus: confirmed ? 'confirmed' : skipped ? 'skipped' : tocOk ? 'pending' : 'idle',
      tocWizardOpen: !confirmed && !skipped && tocOk,
      pageCalibration: semantic.pageCalibration
        ? normalizeCalibration(semantic.pageCalibration)
        : null,
    })
  },

  skipTocWizard: () => {
    const bookIndex = get().bookIndex
    const empty = emptySemanticIndex(bookIndex?.docId ?? 'unknown')
    saveSemanticIndex(empty)
    set({
      semanticIndex: empty,
      tocStatus: 'skipped',
      tocWizardOpen: false,
      ready: Boolean(bookIndex),
      phase: 'ready',
      message: bookIndex
        ? `已跳过目录 · 无 TOC 闭集 · ${bookIndex.chunks.length} 段可提问（全书 BM25；缩域较弱）`
        : get().message,
      lastError: null,
    })
  },
}))
