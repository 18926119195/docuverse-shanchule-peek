import type { OcrBlock, OcrPageResult } from '../data/ocrService'
import { protocolEmitPage, type ServerEmittedSlot } from './protocolClient'

function slotsToOcrResult(
  strandIndex: number,
  slots: ServerEmittedSlot[],
  markdown: string,
  pageWidth?: number,
  pageHeight?: number,
): OcrPageResult {
  const blocks: OcrBlock[] = slots.map((s, i) => {
    if (!s.handle || !s.handle.startsWith('h1.')) {
      throw new Error('emit-page missing sealed handle')
    }
    const layoutK =
      typeof s.layoutK === 'number'
        ? s.layoutK
        : typeof s.slotK === 'number'
          ? s.slotK
          : i
    return {
      // Sealed bookKey = layout doorplate（改 T 不换）
      id: s.handle,
      index: layoutK,
      label: s.label,
      content: s.content,
      sourceContent: s.sourceContent,
      bbox: s.bbox,
      confirmed: false,
      cutBound: true,
      slotK: layoutK,
      layoutK,
    }
  })
  return {
    strandIndex,
    markdown,
    blocks,
    pageWidth: pageWidth ?? 0,
    pageHeight: pageHeight ?? 0,
    createdAt: Date.now(),
  }
}

/**
 * Layout cut → sealed bookKey via server（lockId never in browser）。
 */
export async function emitPageViaProtocol(input: {
  docId: string
  page: number
  strandIndex: number
  imageDataUri: string
}): Promise<OcrPageResult> {
  const res = await protocolEmitPage({
    docId: input.docId,
    page: input.page,
    imageDataUri: input.imageDataUri,
  })
  if (!res.ok) {
    throw new Error(res.error || 'emit-page failed')
  }
  return slotsToOcrResult(
    input.strandIndex,
    res.slots,
    res.markdown,
    res.pageWidth,
    res.pageHeight,
  )
}
