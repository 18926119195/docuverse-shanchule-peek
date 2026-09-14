/**
 * A1 place atoms from server-emitted layout slots.
 * 1 layout cut = 1 bookKey；OCR 字是脸上的 T，不是门牌。
 */
import { makeSlotKey } from './keys.js'
import type { EmittedSlot, PageBBox } from './emitPage.js'

export interface ProtocolAtom {
  lockId: string
  /** layout 步序（bookKey 时间分量） */
  layoutK: number
  /** @deprecated 同 layoutK */
  slotK: number
  page: number
  bbox: PageBBox
  content: string
  /** 读数来源标签；身份仍是 layout lockId */
  source: 'ocr'
  kind: 'text' | 'fig'
  faces: {
    text?: { start: number; end: number; content: string }
    fig?: { figId: string; note: string }
  }
}

const FIG_LABEL_RE =
  /^(figure|fig|image|img|picture|photo|chart|diagram|graphic|illustration|table|公式|图片|插图|图表|表格|图)$/i

export function isFigLayoutLabel(label: string): boolean {
  const t = label.trim()
  if (!t) return false
  if (FIG_LABEL_RE.test(t)) return true
  return /图|表|插画|照片/.test(t) && !/标题|页眉|页脚|正文|段落/.test(t)
}

export function atomsFromEmittedSlots(
  docId: string,
  slots: EmittedSlot[],
): ProtocolAtom[] {
  const atoms: ProtocolAtom[] = []
  let cursor = 0
  for (const s of slots) {
    const layoutK = s.layoutK ?? s.slotK
    const isFig = isFigLayoutLabel(s.label)
    const content = s.content.trim()
    const lockId = s.lockId || makeSlotKey(docId, s.page, layoutK)
    if (isFig) {
      atoms.push({
        lockId,
        layoutK,
        slotK: layoutK,
        page: s.page,
        bbox: s.bbox,
        content: content || s.label,
        source: 'ocr',
        kind: 'fig',
        faces: {
          fig: {
            figId: `fig_p${s.page}_k${layoutK}`,
            note: content || s.label,
          },
          ...(content
            ? {
                text: {
                  start: cursor,
                  end: cursor + content.length,
                  content,
                },
              }
            : {}),
        },
      })
    } else if (content.length > 0) {
      const start = cursor
      const end = cursor + content.length
      cursor = end + 2
      atoms.push({
        lockId,
        layoutK,
        slotK: layoutK,
        page: s.page,
        bbox: s.bbox,
        content,
        source: 'ocr',
        kind: 'text',
        faces: {
          text: { start, end, content },
        },
      })
    }
  }
  return atoms
}
