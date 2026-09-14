/**
 * 语料包：材料层（A1/OCR/页图/目录）+ 可选长期记忆（key 身份与母系血缘）。
 * 不导出写信台过程态（pending / packages / steps）。
 */

import type { PageDocument, PageTextChunk } from '../zigzag/types'
import type { OcrPageResult, OcrBlock } from './ocrService'
import { imageUrlToDataUri } from './ocrService'
import type { BookIndex, AChunk } from '../reasoning/pipelineA'
import type { BookSemanticIndex } from '../reasoning/semanticIndex'
import { downloadTextFile } from '../reasoning/a1DsExport'
import {
  clearPageImageVault,
  dataUriToObjectUrl,
  peekPageImageDataUri,
  stashPageImagesFromPack,
  vaultSize,
} from './pageImageVault'
import {
  emptyKeyLineage,
  hydrateKeyLineage,
  parseKeyLineageSnapshot,
  snapshotKeyLineage,
  type KeyLineageSnapshot,
} from '../reasoning/keyLineageMemory'

export const CORPUS_PACK_KIND = 'docuverse-corpus' as const
/** v2：可带 keyLineage 长期记忆 */
export const CORPUS_PACK_VERSION = 2 as const

export type CorpusPackPage = {
  strandIndex: number
  title: string
  text: string
  sourceDoc?: string
  sourcePage?: number
  textChunks?: PageTextChunk[]
  imageDataUri?: string
}

export type CorpusPack = {
  kind: typeof CORPUS_PACK_KIND
  version: 1 | typeof CORPUS_PACK_VERSION
  label: string
  docId: string
  exportedAt: number
  bookIndex: BookIndex
  ocrByStrand: Record<string, OcrPageResult>
  semanticIndex: BookSemanticIndex | null
  pages: CorpusPackPage[]
  /** 长期记忆：key + 母系；缺省=仅材料 */
  keyLineage?: KeyLineageSnapshot | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export { dataUriToObjectUrl } from './pageImageVault'

export type CorpusPackImageStats = {
  imagesPacked: number
  pagesTotal: number
  vaultSize: number
  ocrPages: number
}

export type CorpusPackBuildResult = {
  pack: CorpusPack
  imageStats: CorpusPackImageStats
}

export async function buildCorpusPack(input: {
  label: string
  docId: string
  bookIndex: BookIndex
  ocrByStrand: Record<number, OcrPageResult>
  semanticIndex: BookSemanticIndex | null
  pages: PageDocument[]
  includeImages?: boolean
  /** 默认 true：打入问线/门账母系 */
  includeKeyLineage?: boolean
}): Promise<CorpusPackBuildResult> {
  const includeImages = input.includeImages !== false
  const includeKeyLineage = input.includeKeyLineage !== false
  const pages: CorpusPackPage[] = []
  let imagesPacked = 0
  for (const p of input.pages) {
    let imageDataUri: string | undefined
    if (includeImages) {
      // 优先金库（TOC 后 blob 常已丢）；再回退内存 imageUrl
      const fromVault = peekPageImageDataUri(p.strandIndex)
      if (fromVault?.startsWith('data:')) {
        imageDataUri = fromVault
      } else if (p.imageUrl) {
        try {
          imageDataUri = await imageUrlToDataUri(p.imageUrl)
        } catch {
          imageDataUri = undefined
        }
      }
      if (imageDataUri?.startsWith('data:')) imagesPacked += 1
    }
    pages.push({
      strandIndex: p.strandIndex,
      title: p.title,
      text: p.text,
      sourceDoc: p.sourceDoc,
      sourcePage: p.sourcePage,
      textChunks: p.textChunks,
      imageDataUri,
    })
  }

  const ocrByStrand: Record<string, OcrPageResult> = {}
  for (const [k, v] of Object.entries(input.ocrByStrand)) {
    ocrByStrand[String(k)] = v
  }
  const ocrPages = Object.keys(ocrByStrand).length

  const keyLineage = includeKeyLineage
    ? snapshotKeyLineage(input.docId)
    : emptyKeyLineage(input.docId)

  const pack: CorpusPack = {
    kind: CORPUS_PACK_KIND,
    version: CORPUS_PACK_VERSION,
    label: input.label,
    docId: input.docId,
    exportedAt: Date.now(),
    bookIndex: input.bookIndex,
    ocrByStrand,
    semanticIndex: input.semanticIndex,
    pages,
    keyLineage,
  }

  return {
    pack,
    imageStats: {
      imagesPacked,
      pagesTotal: pages.length,
      vaultSize: vaultSize(),
      ocrPages,
    },
  }
}

export function downloadCorpusPack(pack: CorpusPack): void {
  const slug =
    pack.label.replace(/[^\w\u4e00-\u9fff\-]+/g, '_').slice(0, 48) || 'corpus'
  downloadTextFile(
    `docuverse_${slug}_${pack.exportedAt}.docuverse.json`,
    JSON.stringify(pack),
    'application/json;charset=utf-8',
  )
}

export function parseCorpusPack(raw: unknown): {
  ok: true
  pack: CorpusPack
} | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: '不是 JSON 对象' }
  if (raw.kind !== CORPUS_PACK_KIND) {
    return { ok: false, error: '不是 docuverse 语料包' }
  }
  const ver = raw.version
  if (ver !== 1 && ver !== CORPUS_PACK_VERSION) {
    return { ok: false, error: `不支持的语料包版本：${String(ver)}` }
  }
  if (typeof raw.label !== 'string' || typeof raw.docId !== 'string') {
    return { ok: false, error: '缺少 label/docId' }
  }
  if (!isRecord(raw.bookIndex) || !Array.isArray(raw.bookIndex.chunks)) {
    return { ok: false, error: '缺少有效 bookIndex' }
  }
  if (!Array.isArray(raw.pages)) {
    return { ok: false, error: '缺少 pages' }
  }
  return { ok: true, pack: raw as unknown as CorpusPack }
}

/**
 * @param lean 默认 true：页图进金库、不立刻解码。
 */
export function corpusPackToRuntime(
  pack: CorpusPack,
  opts?: { lean?: boolean },
): {
  label: string
  docId: string
  pages: PageDocument[]
  ocrByStrand: Record<number, OcrPageResult>
  bookIndex: BookIndex
  semanticIndex: BookSemanticIndex | null
  lean: boolean
  stashedImages: number
  keyLineage: KeyLineageSnapshot | null
} {
  const lean = opts?.lean !== false
  clearPageImageVault()
  const stashedImages = stashPageImagesFromPack(pack.pages)

  const pages: PageDocument[] = pack.pages.map((p) => {
    let imageUrl: string | undefined
    if (!lean && p.imageDataUri) {
      try {
        imageUrl = dataUriToObjectUrl(p.imageDataUri)
      } catch {
        imageUrl = undefined
      }
    }
    return {
      strandIndex: p.strandIndex,
      title: p.title,
      text: p.text,
      offsetMap: [],
      imageUrl,
      sourceDoc: p.sourceDoc ?? 'upload',
      sourcePage: p.sourcePage,
      textChunks: p.textChunks,
    }
  })

  const ocrByStrand: Record<number, OcrPageResult> = {}
  for (const [k, v] of Object.entries(pack.ocrByStrand ?? {})) {
    const n = Number(k)
    if (!Number.isFinite(n) || !v || !Array.isArray(v.blocks)) continue
    ocrByStrand[n] = v
  }

  let keyLineage: KeyLineageSnapshot | null = null
  if (pack.keyLineage) {
    const p = parseKeyLineageSnapshot(pack.keyLineage)
    keyLineage = p.ok ? p.snap : null
  }

  return {
    label: pack.label,
    docId: pack.docId,
    pages,
    ocrByStrand,
    bookIndex: pack.bookIndex as BookIndex,
    semanticIndex: pack.semanticIndex,
    lean,
    stashedImages,
    keyLineage,
  }
}

/** 载入后水合长期记忆（有则） */
export function applyCorpusKeyLineage(
  lineage: KeyLineageSnapshot | null | undefined,
): { ok: boolean; note: string } {
  if (!lineage) {
    return { ok: true, note: '无长期记忆（仅材料）' }
  }
  return hydrateKeyLineage(lineage)
}

export function assertOcrBlocksSane(blocks: OcrBlock[]): boolean {
  return blocks.every(
    (b) =>
      typeof b.id === 'string' &&
      Array.isArray(b.bbox) &&
      b.bbox.length === 4 &&
      typeof b.content === 'string',
  )
}

export function assertBookIndexSane(index: BookIndex): boolean {
  return (
    typeof index.docId === 'string' &&
    Array.isArray(index.chunks) &&
    index.chunks.every(
      (c: AChunk) =>
        typeof c.key === 'string' &&
        typeof c.page === 'number' &&
        Array.isArray(c.bbox),
    )
  )
}
