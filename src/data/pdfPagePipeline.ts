/**
 * 扫描 PDF：页级流水线 = 渲一页 → 立刻 emit(layout+OCR) → 落账。
 *
 * 调度序（只影响何时开跑，不影响门牌）：
 *   1) 目录用页 = 书序头 8 ∥ 尾 8 —— **硬闸**：全部成功后立刻 onEdgesReady
 *      （调用方可开 toc_map / 选页）；中间尚未开始
 *   2) 中间页：后台滑动并行，可软失败；经 onPage 增量落账
 *
 * bookKey 身份 = (docId, strand/page, layoutK)，按书序坐标铸；
 * 完成先后乱序不改门牌。A1 组装时仍按 strand 排序。
 */

import type { PageDocument, ResolvedConnection } from '../zigzag/types'
import type { OcrPageResult } from './ocrService'
import { imageUrlToDataUri } from './ocrService'
import { openPdfDocument, renderPdfPageDocument } from './pdfImport'
import { stashPageImageDataUri } from './pageImageVault'
import { emitPageViaProtocol } from '../reasoning/emitClient'
import { runBatchesParallel } from '../arch/parallelLlmBatch'

/**
 * 智谱账户「速率限制」里 GLM-OCR 并发数（在途请求上限）。
 * 当前 Key 为 2；提额后改这里即可。超过会 1302。
 */
export const ZHIPU_GLM_OCR_CONCURRENCY = 2
/** 中间页并发帽（≤ GLM-OCR 账户并发） */
export const PDF_EMIT_CONCURRENCY = ZHIPU_GLM_OCR_CONCURRENCY
/**
 * 头尾波并发：必须 ≤ 账户 GLM-OCR 并发。
 * 池内滑动补位（成功一坑立刻塞下一页），不是成对等齐。
 */
export const PDF_EDGE_CONCURRENCY = ZHIPU_GLM_OCR_CONCURRENCY
/** 找目录优先：头/尾各固定页数（非百分比） */
export const INGEST_EDGE_PAGES = 8
/** 头尾最大重试轮次（每轮只打尚未成功的页；并发低时多留几轮） */
export const EDGE_EMIT_MAX_ATTEMPTS = 8

function capOcrConcurrency(want: number): number {
  return Math.max(1, Math.min(want, ZHIPU_GLM_OCR_CONCURRENCY))
}

export type PageEmitProgress = {
  done: number
  total: number
  strand: number
  phase: 'edges' | 'middle' | 'done'
  message: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

/**
 * 调度用 strand 列表（0-based）。
 * 去重、不重叠：先头、再尾、再中间。短书自动收缩。
 */
export function scheduleStrandsHeadTailThenMiddle(pageCount: number): {
  head: number[]
  tail: number[]
  middle: number[]
  /** 头∪尾（波 1，须全部成功） */
  edges: number[]
} {
  if (pageCount <= 0) {
    return { head: [], tail: [], middle: [], edges: [] }
  }
  if (pageCount <= 2) {
    const all = Array.from({ length: pageCount }, (_, i) => i)
    return { head: all, tail: [], middle: [], edges: all }
  }
  const n = Math.min(INGEST_EDGE_PAGES, Math.floor(pageCount / 2))
  const edgeN = Math.max(1, n)
  const head = Array.from({ length: edgeN }, (_, i) => i)
  const tailStart = Math.max(edgeN, pageCount - edgeN)
  const tail = Array.from(
    { length: pageCount - tailStart },
    (_, i) => tailStart + i,
  )
  const middle: number[] = []
  for (let s = edgeN; s < tailStart; s++) middle.push(s)
  return { head, tail, middle, edges: [...head, ...tail] }
}

export async function ingestScannedPdfParallel(input: {
  file: File
  docId: string
  concurrency?: number
  /** 头尾在途帽；缺省=账户 GLM-OCR 并发；不可超过账户额度 */
  edgeConcurrency?: number
  onProgress?: (p: PageEmitProgress) => void
  onPage?: (page: PageDocument, ocr: OcrPageResult) => void
  /**
   * 目录硬闸通过后立刻回调（中间尚未开始）。
   * 调用方可在此 finalizeIndex + 开 toc_map；中间页随后后台继续。
   */
  onEdgesReady?: (snap: {
    pages: PageDocument[]
    ocrByStrand: Record<number, OcrPageResult>
    label: string
    total: number
    edgeStrands: number[]
  }) => void | Promise<void>
}): Promise<{
  pages: PageDocument[]
  connections: ResolvedConnection[]
  label: string
  ocrByStrand: Record<number, OcrPageResult>
  done: number
  failed: number
  total: number
  /** 是否已在中间开始前触发过 onEdgesReady */
  edgesReadyFired: boolean
}> {
  const opened = await openPdfDocument(input.file, (msg) => {
    input.onProgress?.({
      done: 0,
      total: 0,
      strand: 0,
      phase: 'edges',
      message: msg,
    })
  })
  const { doc, total, label } = opened
  const midConcurrency = capOcrConcurrency(
    input.concurrency ?? PDF_EMIT_CONCURRENCY,
  )
  const bands = scheduleStrandsHeadTailThenMiddle(total)
  const edgeConcurrency = capOcrConcurrency(
    input.edgeConcurrency ?? PDF_EDGE_CONCURRENCY,
  )

  const pagesSlot: Array<PageDocument | undefined> = Array.from({
    length: total,
  })
  const ocrByStrand: Record<number, OcrPageResult> = {}
  let done = 0
  let failed = 0

  const report = (
    strand: number,
    phase: 'edges' | 'middle' | 'done',
    message: string,
  ) => {
    input.onProgress?.({
      done: Object.keys(ocrByStrand).length,
      total,
      strand,
      phase,
      message,
    })
  }

  const fillStub = (strand: number): PageDocument => ({
    strandIndex: strand,
    title: `${label} p.${strand + 1}（后台识别中）`,
    text: `${label}\nPage ${strand + 1}`,
    offsetMap: [],
    sourceDoc: 'upload',
    sourcePage: strand + 1,
    textChunks: [],
  })

  const materializePages = (): PageDocument[] => {
    for (let i = 0; i < total; i++) {
      if (!pagesSlot[i]) pagesSlot[i] = fillStub(i)
    }
    return pagesSlot as PageDocument[]
  }

  let edgesReadyFired = false

  const emitOne = async (strand: number): Promise<void> => {
    const pageNum = strand + 1
    const page = await renderPdfPageDocument({
      doc,
      pageNumber: pageNum,
      label,
      totalPages: total,
    })
    if (!page.imageUrl) {
      throw new Error(`页 ${pageNum} 无图像`)
    }
    const dataUri = await imageUrlToDataUri(page.imageUrl)
    // TOC/导出写穿：金库先于 blob 生命周期，避免目录齐后 imageUrl 丢失导致包无图
    stashPageImageDataUri(page.strandIndex, dataUri)
    const ocr = await emitPageViaProtocol({
      docId: input.docId,
      page: page.strandIndex,
      strandIndex: page.strandIndex,
      imageDataUri: dataUri,
    })
    pagesSlot[page.strandIndex] = page
    ocrByStrand[page.strandIndex] = ocr
    done += 1
    input.onPage?.(page, ocr)
  }

  /**
   * 目录硬闸：头∪尾滑动在途≤edgeConcurrency；失败只重试；
   * 全部落账前绝不返回（也就绝不开中间）。
   */
  const runEdgesUntilComplete = async (strands: number[]) => {
    if (strands.length === 0) return
    let pending = [...strands]
    let attempt = 0
    const lastError = new Map<number, string>()

    report(
      strands[0]!,
      'edges',
      `目录优先 · 头尾共 ${strands.length} 页须全部成功（在途≤${edgeConcurrency} 滑动补位）· 成功前不开中间`,
    )

    while (pending.length > 0) {
      attempt += 1
      if (attempt > EDGE_EMIT_MAX_ATTEMPTS) {
        const failList = pending
          .map((s) => `s${s}(${lastError.get(s) ?? 'unknown'})`)
          .join(', ')
        throw new Error(
          `目录用头尾页未能全部成功（已重试 ${EDGE_EMIT_MAX_ATTEMPTS} 轮）。失败：${failList}。未开始中间页。`,
        )
      }
      const wave = [...pending]
      if (attempt > 1) {
        const backoff = Math.min(8000, 800 * attempt * attempt)
        report(
          wave[0]!,
          'edges',
          `目录头尾重试 ${attempt}/${EDGE_EMIT_MAX_ATTEMPTS} · 剩 ${wave.length} 页 · 在途≤${edgeConcurrency} · 退避 ${backoff}ms…`,
        )
        await sleep(backoff)
      }

      pending = []
      const parallel = await runBatchesParallel({
        batches: wave,
        concurrency: edgeConcurrency,
        run: async (strand) => {
          await emitOne(strand)
          const edgeOk = strands.filter((s) => ocrByStrand[s]).length
          report(
            strand,
            'edges',
            `目录头尾 ${edgeOk}/${strands.length} · 全书 ${Object.keys(ocrByStrand).length}/${total} · s${strand}`,
          )
          return strand
        },
      })

      for (const r of parallel.results) {
        if (r.ok) continue
        const strand = wave[r.index] ?? r.index
        const note = r.aborted ? '已取消' : r.note
        lastError.set(strand, note)
        pending.push(strand)
        report(
          strand,
          'edges',
          `目录头尾失败 s${strand}：${note.slice(0, 80)} · 将重试（仍不开中间）`,
        )
      }
    }

    const missing = strands.filter((s) => !ocrByStrand[s])
    if (missing.length > 0) {
      throw new Error(
        `目录硬闸未通过：仍缺 s${missing.join(',s')}。未开始中间页。`,
      )
    }

    report(
      strands[strands.length - 1]!,
      'edges',
      `目录用头尾 ${strands.length} 页全部成功 · 开放目录向导；中间页转后台…`,
    )

    const snapPages = materializePages()
    edgesReadyFired = true
    await input.onEdgesReady?.({
      pages: snapPages,
      ocrByStrand: { ...ocrByStrand },
      label,
      total,
      edgeStrands: [...strands],
    })
  }

  /** 中间：仅在硬闸通过后调用；软失败不堵全书 */
  const runMiddleSoft = async (strands: number[]) => {
    if (strands.length === 0) return
    report(
      strands[0]!,
      'middle',
      `中间页开始 · ${strands.length} 页 · 在途≤${midConcurrency}（目录页已齐）`,
    )
    const parallel = await runBatchesParallel({
      batches: strands,
      concurrency: midConcurrency,
      run: async (strand) => {
        await emitOne(strand)
        report(
          strand,
          'middle',
          `中间页 · 成功 ${done} · 失败 ${failed} · 全书 ${Object.keys(ocrByStrand).length}/${total}`,
        )
        return strand
      },
    })
    for (const r of parallel.results) {
      if (r.ok) continue
      failed += 1
      const strand = strands[r.index] ?? r.index
      if (!pagesSlot[strand]) {
        pagesSlot[strand] = {
          strandIndex: strand,
          title: `${label} p.${strand + 1}（识别失败）`,
          text: `${label}\nPage ${strand + 1}\n(emit failed)`,
          offsetMap: [],
          sourceDoc: 'upload',
          sourcePage: strand + 1,
          textChunks: [],
        }
      }
      report(
        strand,
        'middle',
        `中间页失败 s${strand} · 成功 ${done} · 失败 ${failed}`,
      )
    }
  }

  try {
    // 硬序：edges 全部成功（或抛错）→ 才 middle。禁止并行开中间。
    await runEdgesUntilComplete(bands.edges)
    await runMiddleSoft(bands.middle)
  } finally {
    try {
      const closable = doc as { destroy?: () => Promise<void> }
      await closable.destroy?.()
    } catch {
      /* ignore */
    }
  }

  for (let i = 0; i < total; i++) {
    if (!pagesSlot[i]) pagesSlot[i] = fillStub(i)
    else if (
      !ocrByStrand[i] &&
      pagesSlot[i]!.title.includes('后台识别中')
    ) {
      pagesSlot[i] = {
        ...pagesSlot[i]!,
        title: `${label} p.${i + 1}（缺失）`,
      }
    }
  }

  input.onProgress?.({
    done: Object.keys(ocrByStrand).length,
    total,
    strand: Math.max(0, total - 1),
    phase: 'done',
    message: `全书处理完毕 · 成功 ${done}/${total} · 中间失败 ${failed}（门牌按书序）`,
  })

  return {
    pages: pagesSlot as PageDocument[],
    connections: [],
    label,
    ocrByStrand,
    done,
    failed,
    total,
    edgesReadyFired,
  }
}
