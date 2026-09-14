/**
 * 页划重点登记表：layout（机器）与 emphasize（人手）同级 peer。
 * 占块只指针；仅空白可铸；区域把手 = regionKey（combo 或单门）。
 */

import { create } from 'zustand'
import {
  makeEmphasizePageMark,
  makeLayoutPageMark,
  type PageMark,
  type PageNormBBox,
  type PageNormPoint,
} from '../arch/pageMark'
import type { BookIndex } from './pipelineA'

export type PendingEmphasizeConfirm = {
  emphasizeId: string
  docId: string
  page: number
  aabb: PageNormBBox
}

type PageMarkState = {
  byDoc: Record<string, PageMark[]>
  lastHitBookKeys: string[]
  lastHitDocId: string | null
  lastHitEmphasisId: string | null
  pendingEmphasizeConfirm: PendingEmphasizeConfirm | null

  syncLayoutFromBookIndex: (index: BookIndex) => void
  upsertEmphasizeMark: (input: {
    markId: string
    docId: string
    page: number
    aabb: PageNormBBox
    polygon?: PageNormPoint[]
    createdAt?: number
    bookKey?: string
    layoutK?: number
    regionKey?: string
    regionMemberKeys?: string[]
  }) => void
  /** 空白铸门后：挂 blank bookKey + layout mark */
  attachBookKeyToEmphasize: (input: {
    docId: string
    emphasizeId: string
    bookKey: string
    layoutK: number
    aabb: PageNormBBox
  }) => void
  /** 挂区域把手（指针 combo 或 指针∪空白 combo） */
  attachRegionToEmphasize: (input: {
    docId: string
    emphasizeId: string
    regionKey: string
    regionMemberKeys: string[]
  }) => void
  removeMark: (docId: string, markId: string) => void
  clearDoc: (docId: string) => void
  listMarks: (docId: string, kind?: PageMark['kind']) => PageMark[]
  setLastLayoutHits: (input: {
    docId: string
    emphasisId: string
    bookKeys: string[]
  }) => void
  clearLastHits: () => void
  setPendingEmphasizeConfirm: (p: PendingEmphasizeConfirm | null) => void
  clearPendingEmphasizeConfirm: () => void
}

export const usePageMarkStore = create<PageMarkState>((set, get) => ({
  byDoc: {},
  lastHitBookKeys: [],
  lastHitDocId: null,
  lastHitEmphasisId: null,
  pendingEmphasizeConfirm: null,

  syncLayoutFromBookIndex: (index) => {
    const layoutMarks = index.chunks.map((c) =>
      makeLayoutPageMark({
        docId: index.docId,
        page: c.page,
        layoutK: c.layoutK ?? c.slotK,
        aabb: c.bbox,
        bookKey: c.key,
        createdAt: index.builtAt,
      }),
    )
    set((s) => {
      const prev = s.byDoc[index.docId] ?? []
      const emphasize = prev.filter((m) => m.kind === 'emphasize')
      return {
        byDoc: {
          ...s.byDoc,
          [index.docId]: [...layoutMarks, ...emphasize],
        },
      }
    })
  },

  upsertEmphasizeMark: (input) => {
    const mark = makeEmphasizePageMark(input)
    set((s) => {
      const prev = s.byDoc[input.docId] ?? []
      const without = prev.filter((m) => m.markId !== mark.markId)
      return {
        byDoc: {
          ...s.byDoc,
          [input.docId]: [...without, mark],
        },
      }
    })
  },

  attachBookKeyToEmphasize: ({
    docId,
    emphasizeId,
    bookKey,
    layoutK,
    aabb,
  }) => {
    set((s) => {
      const prev = s.byDoc[docId] ?? []
      const next = prev.map((m) =>
        m.markId === emphasizeId && m.kind === 'emphasize'
          ? { ...m, bookKey, layoutK }
          : m,
      )
      const hasLayout = next.some(
        (m) => m.kind === 'layout' && m.bookKey === bookKey,
      )
      const withLayout = hasLayout
        ? next
        : [
            ...next,
            makeLayoutPageMark({
              docId,
              page:
                next.find((m) => m.markId === emphasizeId)?.page ??
                s.pendingEmphasizeConfirm?.page ??
                0,
              layoutK,
              aabb,
              bookKey,
            }),
          ]
      return {
        byDoc: { ...s.byDoc, [docId]: withLayout },
        lastHitDocId: docId,
        lastHitEmphasisId: emphasizeId,
        lastHitBookKeys: [bookKey],
        pendingEmphasizeConfirm: null,
      }
    })
  },

  attachRegionToEmphasize: ({
    docId,
    emphasizeId,
    regionKey,
    regionMemberKeys,
  }) => {
    set((s) => {
      const prev = s.byDoc[docId] ?? []
      const next = prev.map((m) =>
        m.markId === emphasizeId && m.kind === 'emphasize'
          ? { ...m, regionKey, regionMemberKeys }
          : m,
      )
      return {
        byDoc: { ...s.byDoc, [docId]: next },
        lastHitDocId: docId,
        lastHitEmphasisId: emphasizeId,
        lastHitBookKeys: regionMemberKeys,
      }
    })
  },

  removeMark: (docId, markId) => {
    set((s) => {
      const prev = s.byDoc[docId] ?? []
      return {
        byDoc: {
          ...s.byDoc,
          [docId]: prev.filter((m) => m.markId !== markId),
        },
        pendingEmphasizeConfirm:
          s.pendingEmphasizeConfirm?.emphasizeId === markId
            ? null
            : s.pendingEmphasizeConfirm,
      }
    })
  },

  clearDoc: (docId) => {
    set((s) => {
      const next = { ...s.byDoc }
      delete next[docId]
      return {
        byDoc: next,
        pendingEmphasizeConfirm:
          s.pendingEmphasizeConfirm?.docId === docId
            ? null
            : s.pendingEmphasizeConfirm,
      }
    })
  },

  listMarks: (docId, kind) => {
    const all = get().byDoc[docId] ?? []
    return kind ? all.filter((m) => m.kind === kind) : all
  },

  setLastLayoutHits: ({ docId, emphasisId, bookKeys }) => {
    set({
      lastHitDocId: docId,
      lastHitEmphasisId: emphasisId,
      lastHitBookKeys: bookKeys,
    })
  },

  clearLastHits: () => {
    set({
      lastHitBookKeys: [],
      lastHitDocId: null,
      lastHitEmphasisId: null,
    })
  },

  setPendingEmphasizeConfirm: (p) => set({ pendingEmphasizeConfirm: p }),
  clearPendingEmphasizeConfirm: () => set({ pendingEmphasizeConfirm: null }),
}))
