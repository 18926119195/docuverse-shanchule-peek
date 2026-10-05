/**
 * Browser-side PDF → page image cards (works for scanned PDFs).
 * Uses pdf.js *legacy* build so older Chromium/Safari without
 * Map.getOrInsertComputed still work (worker included).
 *
 * 全书可导入（不再硬截 80）。扫描路径请走 pdfPagePipeline：
 * 渲一页 → 立刻 emit，多页并行；勿先整本预渲再串行 OCR。
 */

import { ensurePdfRuntimePolyfills } from './pdfPolyfills'

ensurePdfRuntimePolyfills()

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorker from './pdfWorkerBootstrap?worker&url'
import type { PageDocument, ResolvedConnection } from '../zigzag/types'
import { extractPdfTextChunks } from './pdfTextLayer'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker

export type PdfjsDocument = Awaited<
  ReturnType<typeof pdfjs.getDocument>['promise']
>

export interface OpenedPdf {
  doc: PdfjsDocument
  total: number
  label: string
  fileName: string
}

export interface PdfImportProgress {
  phase: 'loading' | 'rendering' | 'done' | 'error'
  current: number
  total: number
  message: string
}

function canvasToObjectUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('无法导出页面图像'))
          return
        }
        resolve(URL.createObjectURL(blob))
      },
      'image/jpeg',
      0.82,
    )
  })
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

export async function openPdfDocument(
  file: File,
  onMessage?: (msg: string) => void,
): Promise<OpenedPdf> {
  const label = file.name.replace(/\.pdf$/i, '') || 'Uploaded PDF'
  onMessage?.(`读取 ${file.name}…`)
  const data = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjs.getDocument({
    data,
    wasmUrl: '/pdfjs-wasm/',
    useSystemFonts: true,
    disableFontFace: true,
  }).promise
  const total = doc.numPages
  if (total < 1) {
    throw new Error('PDF 没有可渲染的页面')
  }
  return { doc, total, label, fileName: file.name }
}

/** 单页渲染（原分辨率策略：短边目标宽约 960） */
export async function renderPdfPageDocument(input: {
  doc: PdfjsDocument
  /** 1-based pdf.js page number */
  pageNumber: number
  label: string
  totalPages: number
}): Promise<PageDocument> {
  const { doc, pageNumber, label, totalPages } = input
  const i = pageNumber
  await yieldToUi()

  const page = await doc.getPage(i)
  const base = page.getViewport({ scale: 1 })
  const targetW = 960
  const scale = Math.min(1.8, targetW / base.width)
  const viewport = page.getViewport({ scale })

  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas 不可用')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const task = page.render({
    canvas,
    canvasContext: ctx,
    viewport,
    background: '#ffffff',
  })
  try {
    await task.promise
  } catch (err) {
    console.warn(`PDF page ${i} render failed`, err)
    canvas.width = 0
    canvas.height = 0
    return {
      strandIndex: i - 1,
      title: `${label} p.${i}（渲染失败）`,
      text: `${label}\nPage ${i} of ${totalPages}\n(render failed)`,
      offsetMap: [],
      sourceDoc: 'upload',
      sourcePage: i,
      textChunks: [],
    }
  }

  const imageUrl = await canvasToObjectUrl(canvas)
  canvas.width = 0
  canvas.height = 0

  const textChunks = await extractPdfTextChunks(page, viewport, i - 1)
  const extracted = textChunks
    .map((c) => c.content)
    .filter((t) => t.length > 0)
    .join('\n\n')

  return {
    strandIndex: i - 1,
    title: `${label} p.${i}`,
    text: extracted || `${label}\nPage ${i} of ${totalPages}`,
    offsetMap: [],
    imageUrl,
    sourceDoc: 'upload',
    sourcePage: i,
    textChunks,
  }
}

/**
 * 文字层路径：顺序渲完全书（保留图供球显示）。
 * 扫描 OCR 请用 ingestScannedPdfParallel，勿先走本函数再串行 OCR。
 */
export async function importPdfFile(
  file: File,
  onProgress?: (p: PdfImportProgress) => void,
): Promise<{
  pages: PageDocument[]
  connections: ResolvedConnection[]
  label: string
}> {
  const opened = await openPdfDocument(file, (message) => {
    onProgress?.({
      phase: 'loading',
      current: 0,
      total: 0,
      message,
    })
  })
  const { doc, total, label } = opened

  const pages: PageDocument[] = []
  for (let i = 1; i <= total; i++) {
    onProgress?.({
      phase: 'rendering',
      current: i,
      total,
      message: `渲染第 ${i}/${total} 页…`,
    })
    pages.push(
      await renderPdfPageDocument({
        doc,
        pageNumber: i,
        label,
        totalPages: total,
      }),
    )
  }

  try {
    const closable = doc as { destroy?: () => Promise<void> }
    await closable.destroy?.()
  } catch {
    /* ignore */
  }

  onProgress?.({
    phase: 'done',
    current: total,
    total,
    message: `已导入 ${total} 页`,
  })

  return { pages, connections: [], label }
}
