/**
 * Export cut-bound slots for labelling / dataset collection.
 */

import type { OcrPageResult } from '../data/ocrService'
import type { BookIndex } from './pipelineA'
import { isOpaqueHandle, shortHandle } from './ocrSlot'

export type SlotLabelRow = {
  /** experiment id you fill when saving */
  experimentId: string
  docId: string
  page: number
  k: number
  /** Sealed handle when available (never raw lockId). */
  slotId: string
  aabb: [number, number, number, number]
  T0: string
  T: string
  cutBound: boolean
  source: 'ocr' | 'a1' | 'ocr+a1'
  /** human labels — fill after visual audit */
  geom_ok: '' | 'yes' | 'no' | 'partial'
  t_ok: '' | 'yes' | 'no' | 'partial'
  notes: string
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Prefer OCR cut-bound blocks; fall back to A1 text atoms on that page. */
export function collectPageSlotRows(input: {
  experimentId: string
  docId: string
  page: number
  ocr?: OcrPageResult
  bookIndex?: BookIndex | null
}): SlotLabelRow[] {
  const { experimentId, docId, page, ocr, bookIndex } = input
  const rows: SlotLabelRow[] = []

  if (ocr && ocr.blocks.length > 0) {
    const blocks = [...ocr.blocks].sort((a, b) => a.index - b.index)
    for (const b of blocks) {
      const k = typeof b.slotK === 'number' ? b.slotK : b.index
      rows.push({
        experimentId,
        docId,
        page,
        k,
        slotId: isOpaqueHandle(b.id) ? b.id : shortHandle(b.id),
        aabb: b.bbox,
        T0: b.sourceContent,
        T: b.content,
        cutBound: b.cutBound === true,
        source: 'ocr',
        geom_ok: '',
        t_ok: '',
        notes: '',
      })
    }
    return rows
  }

  const chunks =
    bookIndex?.chunks.filter((c) => c.page === page && c.kind === 'text') ?? []
  for (const c of chunks) {
    rows.push({
      experimentId,
      docId,
      page,
      k: c.slotK,
      slotId: c.key,
      aabb: c.bbox,
      T0: c.faces.text?.content ?? c.content,
      T: c.faces.text?.content ?? c.content,
      cutBound: c.source === 'ocr',
      source: 'a1',
      geom_ok: '',
      t_ok: '',
      notes: '',
    })
  }
  return rows
}

export function exportPageSlotDataset(input: {
  experimentId: string
  docId: string
  page: number
  ocr?: OcrPageResult
  bookIndex?: BookIndex | null
  pageTitle?: string
}): number {
  const rows = collectPageSlotRows(input)
  const payload = {
    schema: 'docuverse.slot_label.v1',
    exportedAt: new Date().toISOString(),
    protocol: 'EXP-SLOT-01',
    pageTitle: input.pageTitle ?? '',
    howToLabel: {
      geom_ok: '绿框是否盖住该段墨迹（yes/no/partial）',
      t_ok: 'T0/T 是否就是框内文字（yes/no/partial）',
      notes: '可选：偏上/偏左/串邻段/漏字…',
    },
    rows,
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  downloadJson(
    `slot-exp_p${input.page}_${stamp}.json`,
    payload,
  )
  return rows.length
}
