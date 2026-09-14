/**
 * Layer-0 A1: layout 划重点铸 bookKey（before any circle）。
 * 强调笔：占块指针(+rel) + 仅空白可铸；区域 = combo(指针∪空白门)。
 */

import type { EmphasisEdge, PagePoint, RegionSelector } from '../data/emphasis'
import {
  decomposeEmphasizeAabbAgainstLayout,
  decompositionToRegionBinding,
  type EmphasizeAabbDecomposition,
  type EmphasizeRegionBinding,
  type EmphasizeReuseMember,
} from '../arch/pageMark'
import type { OcrPageResult } from '../data/ocrService'
import type { PageDocument, PageTextChunk } from '../zigzag/types'
import { facesToReadout } from './intrinsicKey'
import { recallCandidatesByBm25 } from './retrieveBm25'
import { fullSlotMember, isOpaqueHandle, type SlotMemberRef } from './ocrSlot'
import { protocolMintKey } from './protocolClient'
import { structureChunkBlocks } from './structureChunk'
import type {
  AChunkSource,
  IntrinsicCoordinate,
  PlaceFaces,
  PlaceKind,
} from './types'

export interface AChunk {
  ord: number
  id: string
  page: number
  /** Registered AABB at emission — restore geometry (page_norm 0–1000). */
  bbox: [number, number, number, number]
  /** Constituent boxes when structure-merged; highlight may use these. */
  inkBoxes?: Array<[number, number, number, number]>
  start: number
  end: number
  source: AChunkSource
  kind: PlaceKind
  /** Opaque sealed bookKey（layout 坐标封印）；改 T 不换此键 */
  key: string
  /**
   * 页内 layout 步序（bookKey 身份分量）。
   * 历史字段名 slotK；语义 = layoutK，≠ OCR 步。
   */
  slotK: number
  /** 与 slotK 同值；新代码优先读这个 */
  layoutK?: number
  faces: PlaceFaces
  /** 当前 T（OCR 初读或人手改）；脸上的字，不是门牌 */
  content: string
  figId?: string
  /** CPU lightweight embedding ↔ key* (spec V_book) */
  vBook: number[]
}

export interface BookIndex {
  docId: string
  stream: string
  chunks: AChunk[]
  builtAt: number
}

const SEP = '\n\n'

const FIG_LABEL_RE =
  /^(figure|fig|image|img|picture|photo|chart|diagram|graphic|illustration|table|公式|图片|插图|图表|表格|图)$/i

export function isFigLayoutLabel(label: string): boolean {
  const t = label.trim()
  if (!t) return false
  if (FIG_LABEL_RE.test(t)) return true
  return /图|表|插画|照片/.test(t) && !/标题|页眉|页脚|正文|段落/.test(t)
}

function sortByReadingOrder<T extends { bbox: [number, number, number, number] }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const dy = a.bbox[1] - b.bbox[1]
    if (Math.abs(dy) > 12) return dy
    return a.bbox[0] - b.bbox[0]
  })
}

function aabbArea(b: [number, number, number, number]): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
}

function aabbOverlapArea(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const x0 = Math.max(a[0], b[0])
  const y0 = Math.max(a[1], b[1])
  const x1 = Math.min(a[2], b[2])
  const y1 = Math.min(a[3], b[3])
  if (x1 <= x0 || y1 <= y0) return 0
  return (x1 - x0) * (y1 - y0)
}

/** Intersection over union — used to merge co-referent text∪fig on same territory */
export function aabbIoU(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const inter = aabbOverlapArea(a, b)
  if (inter <= 0) return 0
  const uni = aabbArea(a) + aabbArea(b) - inter
  return uni > 0 ? inter / uni : 0
}

function paragraphsAsChunks(page: PageDocument): PageTextChunk[] {
  const paras = page.text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const parts = paras.length > 0 ? paras : page.text.trim() ? [page.text.trim()] : []
  if (parts.length === 0) return []
  const pad = 48
  const usable = 1000 - pad * 2
  const weights = parts.map((p) => Math.max(24, p.length))
  const sum = weights.reduce((a, b) => a + b, 0)
  let y = pad
  return parts.map((content, i) => {
    const h = (weights[i] / sum) * usable
    const bbox: [number, number, number, number] = [pad, y, 1000 - pad, y + h]
    y += h
    return { id: `page_s${page.strandIndex}_p${i}`, content, bbox }
  })
}

function splitOcrBlocks(ocr: OcrPageResult): {
  text: PageTextChunk[]
  figs: Array<PageTextChunk & { label: string }>
} {
  const text: PageTextChunk[] = []
  const figs: Array<PageTextChunk & { label: string }> = []
  const blocks = [...ocr.blocks].sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index
    const dy = a.bbox[1] - b.bbox[1]
    if (Math.abs(dy) > 8) return dy
    return a.bbox[0] - b.bbox[0]
  })
  for (const b of blocks) {
    if (isFigLayoutLabel(b.label)) {
      figs.push({
        id: b.id,
        content: b.content.trim(),
        bbox: b.bbox,
        label: b.label,
      })
      continue
    }
    if (b.content.trim().length > 0) {
      text.push({
        id: b.id,
        content: b.content.trim(),
        bbox: b.bbox,
      })
    }
  }
  return { text, figs }
}

type TextAtomChunk = PageTextChunk & {
  inkBoxes?: Array<[number, number, number, number]>
}

type PageAtoms =
  | {
      mode: 'dual'
      source: AChunkSource
      text: TextAtomChunk[]
      /** layout figs not yet merged into text */
      figs: Array<PageTextChunk & { label?: string }>
    }
  | { mode: 'fig_only'; figs: Array<PageTextChunk & { label?: string }> }
  | null

/**
 * Emit layout units with registered AABB only — no text→bbox rebind.
 * Structure merge creates new units (union + inkBoxes); geom never rematched from T.
 */
function pageAtoms(
  page: PageDocument,
  ocr: OcrPageResult | undefined,
): PageAtoms {
  const hasPageImage = Boolean(page.imageUrl)

  if (ocr && ocr.blocks.length > 0) {
    const { text, figs } = splitOcrBlocks(ocr)
    if (text.length > 0 || figs.length > 0) {
      // Cut-bound OCR slots: 1 block = 1 slot. Do NOT structureChunk (would break cut↔T).
      return {
        mode: 'dual',
        source: 'ocr',
        text,
        figs,
      }
    }
  }

  if (page.textChunks && page.textChunks.length > 0) {
    const text = sortByReadingOrder(
      page.textChunks.filter((c) => c.content.trim().length > 0),
    ).map((c) => ({
      id: c.id,
      content: c.content.trim(),
      bbox: c.bbox,
      inkBoxes: c.inkBoxes,
    }))
    if (text.length > 0) {
      // PDF glyph boxes are already cut-bound by the extractor; keep 1:1.
      return {
        mode: 'dual',
        source: 'pdf_text',
        text,
        figs: [],
      }
    }
  }

  // Weak-path convergence: image page without text blocks → fig only (no fake paragraph boxes)
  if (hasPageImage) {
    return {
      mode: 'fig_only',
      figs: [
        {
          id: `full_p${page.strandIndex}`,
          content: '',
          bbox: [0, 0, 1000, 1000],
          label: 'page',
        },
      ],
    }
  }

  // 后台 stub（无图、无 OCR）：禁止铸假门，等 syncPages 真 OCR 再入账
  if (
    !ocr &&
    !hasPageImage &&
    (page.title.includes('后台识别中') || page.title.includes('缺失'))
  ) {
    return null
  }

  const weak = paragraphsAsChunks(page)
  const derived = structureChunkBlocks(weak)
  if (derived.length === 0) return null
  return { mode: 'dual', source: 'page_text', text: derived, figs: [] }
}

/** Merge layout figs into overlapping text atoms (两面一体); leftover figs stay fig-primary. */
function mergeFigsIntoText(
  text: PageTextChunk[],
  figs: Array<PageTextChunk & { label?: string }>,
  iouThreshold = 0.25,
): {
  textFigIds: Map<string, string>
  orphanFigs: Array<PageTextChunk & { label?: string }>
} {
  const textFigIds = new Map<string, string>()
  const orphanFigs: Array<PageTextChunk & { label?: string }> = []
  const usedText = new Set<string>()

  for (const fig of figs) {
    let bestId: string | null = null
    let bestIoU = 0
    for (const t of text) {
      if (usedText.has(t.id)) continue
      const iou = aabbIoU(fig.bbox, t.bbox)
      // also accept high coverage of fig by text (fig inside text block)
      const figArea = Math.max(1, aabbArea(fig.bbox))
      const cov = aabbOverlapArea(fig.bbox, t.bbox) / figArea
      const score = Math.max(iou, cov >= 0.5 ? cov : 0)
      if (score > bestIoU) {
        bestIoU = score
        bestId = t.id
      }
    }
    if (bestId && bestIoU >= iouThreshold) {
      textFigIds.set(bestId, `layout:${fig.id}`)
      usedText.add(bestId)
    } else {
      orphanFigs.push(fig)
    }
  }
  return { textFigIds, orphanFigs }
}

function probeForFaces(_faces: PlaceFaces): number[] {
  return []
}

function pushTextAtom(
  _docId: string,
  state: { stream: string; chunks: AChunk[]; ord: number },
  page: number,
  slotK: number,
  atom: TextAtomChunk,
  source: AChunkSource,
  pageImageUrl: string | undefined,
  layoutFigId: string | undefined,
): void {
  if (state.stream.length > 0) state.stream += SEP
  const start = state.stream.length
  state.stream += atom.content
  const end = state.stream.length
  // Require sealed server handle — never mint doorplates in browser
  if (!isOpaqueHandle(atom.id)) {
    throw new Error(
      `A1 atom missing sealed handle. Re-run emit-page / buildBookIndex (got ${atom.id.slice(0, 48)}).`,
    )
  }
  const key = atom.id
  const faces: PlaceFaces = {
    text: { start, end, content: atom.content },
  }
  // 两面一体: page image ⇒ always attach fig face on text lock
  if (pageImageUrl || layoutFigId) {
    const figId = layoutFigId ?? `crop:${atom.id}`
    faces.fig = {
      figId,
      note: layoutFigId
        ? `与文字同区的版面 figure（防 OCR 漂移审计）`
        : `与文字脸同框的页图像裁剪区`,
      imageRef: pageImageUrl,
    }
  }
  const inkBoxes =
    atom.inkBoxes && atom.inkBoxes.length > 0
      ? atom.inkBoxes
      : undefined
  state.chunks.push({
    ord: state.ord,
    id: atom.id,
    page,
    bbox: atom.bbox,
    inkBoxes,
    start,
    end,
    source,
    kind: 'text',
    key,
    slotK,
    layoutK: slotK,
    faces,
    content: atom.content,
    figId: faces.fig?.figId,
    vBook: probeForFaces(faces),
  })
  state.ord += 1
}

function pushFigAtom(
  _docId: string,
  state: { stream: string; chunks: AChunk[]; ord: number },
  page: number,
  slotK: number,
  fig: PageTextChunk & { label?: string },
  pageImageUrl: string | undefined,
  pageTitle: string,
): void {
  const isFullPage =
    fig.bbox[0] <= 1 &&
    fig.bbox[1] <= 1 &&
    fig.bbox[2] >= 999 &&
    fig.bbox[3] >= 999
  const figId = isFullPage ? `p${page}:full` : `p${page}:layout:${fig.id}`

  const caption = fig.content.trim()
  const titleBit = pageTitle.trim() || `strand ${page}`
  // Page-specific note so V_book differs across full-page figs (lexical probe stand-in).
  // Real semantic retrieval still needs OCR/caption or a true embedding API.
  const note = caption
    ? `图脸 · ${titleBit} · ${fig.label ?? 'figure'} · ${caption}`
    : `图脸 · ${titleBit} · 无文字层/未OCR；仅全页图像锚点。请依据可见版面回答；勿编造未提供的文字。`
  const placeholder = caption
    ? `[FIG:${figId}] ${caption}`
    : `[FIG:${figId}] ${titleBit}`
  if (state.stream.length > 0) state.stream += SEP
  const start = state.stream.length
  state.stream += placeholder
  const end = state.stream.length
  // Prefer server-minted sealed handle on fig.id
  if (!isOpaqueHandle(fig.id)) {
    throw new Error(
      `A1 fig missing sealed handle (got ${fig.id.slice(0, 40)}). Re-run protocol emit-page.`,
    )
  }
  const key = fig.id
  const faces: PlaceFaces = {
    fig: {
      figId,
      note,
      imageRef: pageImageUrl,
    },
  }
  if (caption) {
    faces.text = { start, end, content: caption }
  }
  state.chunks.push({
    ord: state.ord,
    id: `fig_${figId.replace(/[^a-zA-Z0-9_:-]/g, '_')}`,
    page,
    bbox: fig.bbox,
    start,
    end,
    source: 'layout_fig',
    kind: 'fig',
    key,
    slotK,
    layoutK: slotK,
    faces,
    content: placeholder,
    figId,
    vBook: probeForFaces(faces),
  })
  state.ord += 1
}

/**
 * A1 index: layout 切槽铸 bookKey；OCR/PDF 字写入脸上的 T。
 * chunk.key = sealed bookKey（layout 坐标）；改 T 走 patchAtomText，不重铸。
 */
export async function buildBookIndex(input: {
  docId: string
  pages: PageDocument[]
  ocrByStrand: Record<number, OcrPageResult>
}): Promise<BookIndex> {
  const state = { stream: '', chunks: [] as AChunk[], ord: 0 }
  const pages = [...input.pages].sort((a, b) => a.strandIndex - b.strandIndex)

  for (const page of pages) {
    const pageImageUrl = page.imageUrl
    const atoms = pageAtoms(page, input.ocrByStrand[page.strandIndex])
    if (!atoms) continue
    let pageK = 0

    if (atoms.mode === 'fig_only') {
      for (const fig of atoms.figs) {
        const id = isOpaqueHandle(fig.id)
          ? fig.id
          : (
              await protocolMintKey({
                kind: 'slot',
                docId: input.docId,
                page: page.strandIndex,
                k: pageK,
              })
            ).handle
        pushFigAtom(
          input.docId,
          state,
          page.strandIndex,
          pageK,
          { ...fig, id },
          pageImageUrl,
          page.title,
        )
        pageK += 1
      }
      continue
    }

    const { textFigIds, orphanFigs } = mergeFigsIntoText(atoms.text, atoms.figs)
    for (const atom of atoms.text) {
      const id = isOpaqueHandle(atom.id)
        ? atom.id
        : (
            await protocolMintKey({
              kind: 'slot',
              docId: input.docId,
              page: page.strandIndex,
              k: pageK,
            })
          ).handle
      pushTextAtom(
        input.docId,
        state,
        page.strandIndex,
        pageK,
        { ...atom, id },
        atoms.source,
        pageImageUrl,
        textFigIds.get(atom.id),
      )
      pageK += 1
    }
    for (const fig of orphanFigs) {
      const id = isOpaqueHandle(fig.id)
        ? fig.id
        : (
            await protocolMintKey({
              kind: 'slot',
              docId: input.docId,
              page: page.strandIndex,
              k: pageK,
            })
          ).handle
      pushFigAtom(
        input.docId,
        state,
        page.strandIndex,
        pageK,
        { ...fig, id },
        pageImageUrl,
        page.title,
      )
      pageK += 1
    }
  }

  return {
    docId: input.docId,
    stream: state.stream,
    chunks: state.chunks,
    builtAt: Date.now(),
  }
}

const STREAM_SEP = '\n\n'

/** Rebuild contiguous stream + start/end after chunk splice. */
function recomputeBookStream(chunks: AChunk[]): {
  stream: string
  chunks: AChunk[]
} {
  let stream = ''
  const out: AChunk[] = []
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    if (stream.length > 0) stream += STREAM_SEP
    const start = stream.length
    stream += c.content
    const end = stream.length
    const faces: PlaceFaces = { ...c.faces }
    if (faces.text) {
      faces.text = {
        ...faces.text,
        start,
        end,
        content: faces.text.content,
      }
    }
    out.push({
      ...c,
      ord: i,
      start,
      end,
      faces,
    })
  }
  return { stream, chunks: out }
}

/**
 * Replace A1 atoms for selected pages, re-embed only those pages' chunks.
 * Other pages keep existing vectors / handles.
 */
export async function rebuildPagesInBookIndex(input: {
  existing: BookIndex | null
  docId: string
  pages: PageDocument[]
  ocrByStrand: Record<number, OcrPageResult>
  pageIndices: number[]
}): Promise<{ index: BookIndex; usedApi: boolean }> {
  const pageSet = new Set(input.pageIndices)
  if (pageSet.size === 0) {
    return {
      index:
        input.existing ?? {
          docId: input.docId,
          stream: '',
          chunks: [],
          builtAt: Date.now(),
        },
      usedApi: false,
    }
  }

  const subsetPages = input.pages.filter((p) => pageSet.has(p.strandIndex))
  const subsetOcr: Record<number, OcrPageResult> = {}
  for (const p of subsetPages) {
    const ocr = input.ocrByStrand[p.strandIndex]
    if (ocr) subsetOcr[p.strandIndex] = ocr
  }

  const pageBuilt = await buildBookIndex({
    docId: input.docId,
    pages: subsetPages,
    ocrByStrand: subsetOcr,
  })

  const kept = (input.existing?.chunks ?? []).filter((c) => !pageSet.has(c.page))
  const merged = [...kept, ...pageBuilt.chunks].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page
    return a.slotK - b.slotK || a.ord - b.ord
  })
  const recomputed = recomputeBookStream(merged)
  return {
    index: {
      docId: input.docId,
      stream: recomputed.stream,
      chunks: recomputed.chunks,
      builtAt: Date.now(),
    },
    usedApi: false,
  }
}

/**
 * 同槽改 T：只刷新读数与 V_book；不重切 geom、不换 bookKey handle。
 * （bookKey = layout 坐标；OCR/改字不是开门）
 */
export async function patchAtomTextInBookIndex(
  index: BookIndex,
  atomKey: string,
  content: string,
): Promise<{ index: BookIndex; usedApi: boolean; patched: boolean }> {
  const idx = index.chunks.findIndex(
    (c) => c.key === atomKey || c.id === atomKey,
  )
  if (idx < 0) {
    return { index, usedApi: false, patched: false }
  }
  const prev = index.chunks[idx]
  const nextContent = content.trim()
  const faces: PlaceFaces = {
    ...prev.faces,
    text: {
      start: prev.faces.text?.start ?? prev.start,
      end: prev.faces.text?.end ?? prev.end,
      content: nextContent,
    },
  }
  const draft = [...index.chunks]
  draft[idx] = {
    ...prev,
    content: nextContent,
    faces,
  }
  const recomputed = recomputeBookStream(draft)
  return {
    index: {
      ...index,
      stream: recomputed.stream,
      chunks: recomputed.chunks.map((c) => ({ ...c, vBook: [] })),
      builtAt: Date.now(),
    },
    usedApi: false,
    patched: true,
  }
}

/** 本页下一个可用 layoutK（强调笔确认铸门时用） */
export function nextLayoutKOnPage(index: BookIndex, page: number): number {
  let max = -1
  for (const c of index.chunks) {
    if (c.page !== page) continue
    max = Math.max(max, c.layoutK ?? c.slotK)
  }
  return max + 1
}

/**
 * 用户确认：强调笔未覆盖区 → 按 layout 同公式铸 bookKey，写入 A1。
 * 与机器 layout 同级：都是「划重点提案 → 铸门」；此处默信改为人手确认。
 */
export async function appendConfirmedLayoutSlotFromEmphasize(input: {
  index: BookIndex
  edge: EmphasisEdge
  /** 确认时的 T；缺省占位，可后再 patchAtomText */
  content?: string
  /**
   * 铸门几何：纯空白=整圈；mixed=blankUnionAabb（多出来的空白）。
   * 缺省回退 edge.region.aabb。
   */
  mintAabb?: [number, number, number, number]
}): Promise<{
  index: BookIndex
  bookKey: string
  layoutK: number
  note: string
}> {
  const page = input.edge.strandIndex
  if (input.edge.docId && input.edge.docId !== input.index.docId) {
    throw new Error(
      `强调笔 docId 与索引不一致：${input.edge.docId} ≠ ${input.index.docId}`,
    )
  }
  const mintAabb = (input.mintAabb ?? input.edge.region.aabb) as [
    number,
    number,
    number,
    number,
  ]
  const layoutK = nextLayoutKOnPage(input.index, page)
  const minted = await protocolMintKey({
    kind: 'slot',
    docId: input.index.docId,
    page,
    layoutK,
    k: layoutK,
  })
  const bookKey = minted.handle
  const content =
    (input.content ?? '').trim() ||
    `[EMPH_CONFIRM:p${page}:k${layoutK}] 用户确认划重点；待补 T`
  const chunk: AChunk = {
    ord: input.index.chunks.length,
    id: bookKey,
    page,
    bbox: [...mintAabb],
    start: 0,
    end: content.length,
    source: 'page_text',
    kind: 'text',
    key: bookKey,
    slotK: layoutK,
    layoutK,
    faces: {
      text: { start: 0, end: content.length, content },
    },
    content,
    vBook: [],
  }
  const merged = [...input.index.chunks, chunk].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page
    return (a.layoutK ?? a.slotK) - (b.layoutK ?? b.slotK) || a.ord - b.ord
  })
  const recomputed = recomputeBookStream(merged)
  return {
    index: {
      docId: input.index.docId,
      stream: recomputed.stream,
      chunks: recomputed.chunks,
      builtAt: Date.now(),
    },
    bookKey,
    layoutK,
    note: `强调笔确认铸空白门 · layoutK=${layoutK} · aabb=${mintAabb.map((n) => n.toFixed(1)).join(',')} · bookKey 已 seal`,
  }
}

export function pointInPolygon(
  x: number,
  y: number,
  polygon: PagePoint[],
): boolean {
  const n = polygon.length
  if (n < 3) return false
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yj === yi) continue
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export function chunkHitScore(
  bbox: [number, number, number, number],
  region: RegionSelector,
): { hit: boolean; score: number } {
  const [x0, y0, x1, y1] = bbox
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const inPoly =
    region.polygon.length >= 3 ? pointInPolygon(cx, cy, region.polygon) : false
  const chunkArea = Math.max(1, (x1 - x0) * (y1 - y0))
  const coverage = aabbOverlapArea(bbox, region.aabb) / chunkArea
  const pageFig =
    x0 <= 1 && y0 <= 1 && x1 >= 999 && y1 >= 999
      ? aabbOverlapArea(bbox, region.aabb) > 0 || inPoly
      : false
  // Small layout figs: lower coverage bar so circle can lock them
  const covNeed = chunkArea < 80_000 ? 0.18 : 0.35
  const hit = inPoly || coverage >= covNeed || pageFig
  const score = inPoly
    ? Math.max(0.7, coverage)
    : pageFig
      ? 0.55
      : coverage
  return { hit, score }
}

export interface CircleCandidate {
  R: IntrinsicCoordinate
  excerpt: string
  score: number
  chunkIds: string[]
  /** Restore boxes = registered slot AABB(s); never text-rematched. */
  boxes: Array<{ page: number; bbox: [number, number, number, number] }>
  /** Preselect / circle members with read-range pct for audit旁注 */
  members: SlotMemberRef[]
}

export type CircleResolveResult =
  | {
      ok: true
      chosen: CircleCandidate
      candidates: CircleCandidate[]
      source: AChunkSource
      coverage: 'hit_existing' | 'mixed_hit_and_uncovered'
      decomposition: EmphasizeAabbDecomposition
      /** 指针∪空白草稿；无待确认空白时 regionKey 已齐 */
      regionBinding: EmphasizeRegionBinding
      pendingConfirm?: {
        emphasizeId: string
        docId: string
        page: number
        aabb: [number, number, number, number]
      }
    }
  | {
      ok: false
      reason: 'no_chunks' | 'no_hit' | 'uncovered_needs_confirm'
      message: string
      decomposition?: EmphasizeAabbDecomposition
      regionBinding?: EmphasizeRegionBinding
      pendingConfirm?: {
        emphasizeId: string
        docId: string
        page: number
        aabb: [number, number, number, number]
      }
    }

export async function atomToCandidate(
  docId: string,
  run: Array<AChunk & { score: number }>,
  emphasisId: string,
): Promise<CircleCandidate> {
  const first = run[0]
  const last = run[run.length - 1]
  const score = run.reduce((s, c) => s + c.score, 0)

  const members: SlotMemberRef[] = run.map((c) =>
    fullSlotMember({
      slotId: c.key,
      page: c.page,
      bbox: c.bbox,
    }),
  )
  const memberKeys = members.map((m) => m.slotId)

  const boxes = run.flatMap((c) =>
    c.inkBoxes && c.inkBoxes.length > 0
      ? c.inkBoxes.map((bbox) => ({ page: c.page, bbox }))
      : [{ page: c.page, bbox: c.bbox }],
  )

  if (run.length === 1) {
    const faces = first.faces
    return {
      R: {
        docId,
        kind: first.kind,
        key: first.key,
        start: first.start,
        end: first.end,
        figId: first.figId,
        page: first.page,
        slotK: first.slotK,
        memberKeys,
        members,
        emphasisId,
        chunkIds: [first.id],
        source: first.source,
        faces,
      },
      excerpt: facesToReadout(faces),
      score,
      chunkIds: [first.id],
      boxes,
      members,
    }
  }

  // Cross-slot combo — mint sealed handle on server (never local makeComboKey)
  const { handle: key } = await protocolMintKey({
    kind: 'combo',
    docId,
    memberHandles: memberKeys,
  })
  const content = run.map((c) => c.faces.text?.content ?? c.content).join('\n\n')
  const faces: PlaceFaces = {
    text: { start: first.start, end: last.end, content },
  }
  if (first.faces.fig) {
    faces.fig = first.faces.fig
  } else {
    const withFig = run.find((c) => c.faces.fig)
    if (withFig?.faces.fig) faces.fig = withFig.faces.fig
  }

  const pctNotes = members
    .map((m) => `${m.pctStart.toFixed(0)}%–${m.pctEnd.toFixed(0)}%`)
    .join(' · ')

  return {
    R: {
      docId,
      kind: first.kind === 'fig' && run.every((c) => c.kind === 'fig') ? 'fig' : 'text',
      key,
      start: first.start,
      end: last.end,
      figId: faces.fig?.figId,
      page: first.page,
      memberKeys,
      members,
      emphasisId,
      chunkIds: run.map((c) => c.id),
      source: first.source,
      faces,
    },
    excerpt: `【跨槽组合 ${members.length} · ${pctNotes}】\n${facesToReadout(faces)}`,
    score,
    chunkIds: run.map((c) => c.id),
    boxes,
    members,
  }
}

/**
 * 从占块指针建候选：boxes = pieceAabb（非整门）；
 * 多门 → combo；单门 → 复用该 bookKey（带门内 rel）。
 */
export async function candidateFromReusePieces(input: {
  docId: string
  page: number
  emphasisId: string
  reuse: EmphasizeReuseMember[]
  chunksByKey: Map<string, AChunk>
}): Promise<CircleCandidate | null> {
  const { docId, page, emphasisId, reuse, chunksByKey } = input
  if (reuse.length === 0) return null

  const scored: Array<AChunk & { score: number; piece: EmphasizeReuseMember }> =
    []
  for (const piece of reuse) {
    const chunk = chunksByKey.get(piece.bookKey)
    if (!chunk) continue
    scored.push({
      ...chunk,
      score: Math.max(0.25, aabbArea(piece.pieceAabb) / Math.max(1e-6, aabbArea(piece.bookKeyAabb))),
      piece,
    })
  }
  if (scored.length === 0) return null

  const members: SlotMemberRef[] = scored.map((c) =>
    fullSlotMember({
      slotId: c.key,
      page: c.page,
      bbox: [...c.piece.pieceAabb] as [number, number, number, number],
      bookKeyAabb: [...c.piece.bookKeyAabb] as [number, number, number, number],
      rel: c.piece.rel,
    }),
  )
  const memberKeys = members.map((m) => m.slotId)
  const boxes = scored.map((c) => ({
    page: c.page,
    bbox: [...c.piece.pieceAabb] as [number, number, number, number],
  }))
  const score = scored.reduce((s, c) => s + c.score, 0)
  const first = scored[0]
  const last = scored[scored.length - 1]
  const content = scored
    .map((c) => c.faces.text?.content ?? c.content)
    .join('\n\n')
  const faces: PlaceFaces = {
    text: { start: first.start, end: last.end, content },
  }
  const withFig = scored.find((c) => c.faces.fig)
  if (withFig?.faces.fig) faces.fig = withFig.faces.fig

  if (memberKeys.length === 1) {
    return {
      R: {
        docId,
        kind: first.kind,
        key: first.key,
        start: first.start,
        end: first.end,
        figId: first.figId,
        page,
        slotK: first.slotK,
        layoutK: first.layoutK ?? first.slotK,
        memberKeys,
        members,
        emphasisId,
        chunkIds: [first.id],
        source: first.source,
        faces,
      },
      excerpt: facesToReadout(faces),
      score,
      chunkIds: [first.id],
      boxes,
      members,
    }
  }

  const { handle: key } = await protocolMintKey({
    kind: 'combo',
    docId,
    memberHandles: memberKeys,
  })
  return {
    R: {
      docId,
      kind:
        first.kind === 'fig' && scored.every((c) => c.kind === 'fig')
          ? 'fig'
          : 'text',
      key,
      start: first.start,
      end: last.end,
      figId: faces.fig?.figId,
      page,
      memberKeys,
      members,
      emphasisId,
      chunkIds: scored.map((c) => c.id),
      source: first.source,
      faces,
    },
    excerpt: `【强调区域组合 ${members.length}（指针·门内块）】\n${facesToReadout(faces)}`,
    score,
    chunkIds: scored.map((c) => c.id),
    boxes,
    members,
  }
}

/**
 * 封强调笔区域把手：指针门 ∪ 空白新门 → 单门或 combo。
 */
export async function sealEmphasizeRegionKey(input: {
  docId: string
  reuseBookKeys: string[]
  blankBookKey?: string
}): Promise<{ regionKey: string; regionMemberKeys: string[] }> {
  const regionMemberKeys = [
    ...input.reuseBookKeys,
    ...(input.blankBookKey ? [input.blankBookKey] : []),
  ]
  const uniq = [...new Set(regionMemberKeys)]
  if (uniq.length === 0) {
    throw new Error('sealEmphasizeRegionKey: 无成员门')
  }
  if (uniq.length === 1) {
    return { regionKey: uniq[0], regionMemberKeys: uniq }
  }
  const { handle } = await protocolMintKey({
    kind: 'combo',
    docId: input.docId,
    memberHandles: uniq,
  })
  return { regionKey: handle, regionMemberKeys: uniq }
}

/**
 * 强调笔相对本页 bookKey 的 AABB 分解：
 *   E = ⋃_i (E ∩ B_i)  ∪  blank
 */
export function decomposeEmphasizeAgainstLayout(
  index: BookIndex,
  edge: EmphasisEdge,
): EmphasizeAabbDecomposition {
  const pageChunks = index.chunks.filter((c) => c.page === edge.strandIndex)
  return decomposeEmphasizeAabbAgainstLayout(
    edge.region.aabb,
    pageChunks.map((c) => ({
      bookKey: c.key,
      aabb: c.bbox,
      layoutK: c.layoutK ?? c.slotK,
    })),
  )
}

/**
 * 强调笔 ∩ layout（含分解）：占块复用门；空白须确认铸门。
 */
export function intersectEmphasizeWithLayout(
  index: BookIndex,
  edge: EmphasisEdge,
): {
  textHits: Array<AChunk & { score: number }>
  figHits: Array<AChunk & { score: number }>
  bookKeys: string[]
  coverage: EmphasizeAabbDecomposition['coverage']
  decomposition: EmphasizeAabbDecomposition
} {
  const decomposition = decomposeEmphasizeAgainstLayout(index, edge)
  const pieceKeys = new Set(decomposition.onBookKeys.map((p) => p.bookKey))

  const pageChunks = index.chunks.filter((c) => c.page === edge.strandIndex)
  const textHits: Array<AChunk & { score: number }> = []
  const figHits: Array<AChunk & { score: number }> = []
  for (const chunk of pageChunks) {
    if (!pieceKeys.has(chunk.key)) continue
    const piece = decomposition.onBookKeys.find((p) => p.bookKey === chunk.key)
    const score = piece?.fracOfEmphasize ?? 0
    const { hit, score: hitScore } = chunkHitScore(chunk.bbox, edge.region)
    const s = hit ? Math.max(score, hitScore) : score
    if (chunk.kind === 'text') textHits.push({ ...chunk, score: s })
    else figHits.push({ ...chunk, score: s })
  }
  return {
    textHits,
    figHits,
    bookKeys: decomposition.onBookKeys.map((p) => p.bookKey),
    coverage: decomposition.coverage,
    decomposition,
  }
}

/**
 * 圈选 → 区域绑定：
 * - 占块 → 指针（pieceAabb + rel），不铸
 * - 空白 → 仅此可铸（须确认）
 * - 区域把手 = combo(指针∪空白新门) 或单门；无空白时立刻 seal 指针 combo
 */
export async function resolveCircleToR(
  edge: EmphasisEdge,
  index: BookIndex,
): Promise<CircleResolveResult> {
  if (edge.docId && edge.docId !== index.docId) {
    return {
      ok: false,
      reason: 'no_chunks',
      message: `强调笔 docId=${edge.docId} 与书索引 ${index.docId} 不一致（须同一份 PDF）。`,
    }
  }

  const docId = index.docId
  const decomposition = decomposeEmphasizeAgainstLayout(index, edge)
  let regionBinding = decompositionToRegionBinding(decomposition)

  const blankPending = regionBinding.blank
    ? {
        emphasizeId: edge.id,
        docId,
        page: edge.strandIndex,
        aabb: [...regionBinding.blank.aabb] as [
          number,
          number,
          number,
          number,
        ],
      }
    : null

  if (decomposition.coverage === 'uncovered_needs_confirm') {
    try {
      const { usePageMarkStore } = await import('./pageMarkStore')
      if (blankPending) {
        usePageMarkStore.getState().setPendingEmphasizeConfirm(blankPending)
      }
    } catch {
      /* optional */
    }
    return {
      ok: false,
      reason: 'uncovered_needs_confirm',
      message:
        '强调笔全是空白：仅空白可铸门。确认后铸新 bookKey，区域把手=该门。',
      decomposition,
      regionBinding,
      pendingConfirm: blankPending ?? undefined,
    }
  }

  const chunksByKey = new Map(index.chunks.map((c) => [c.key, c]))
  const chosen = await candidateFromReusePieces({
    docId,
    page: edge.strandIndex,
    emphasisId: edge.id,
    reuse: regionBinding.reuse,
    chunksByKey,
  })
  if (!chosen) {
    try {
      const { usePageMarkStore } = await import('./pageMarkStore')
      if (blankPending) {
        usePageMarkStore.getState().setPendingEmphasizeConfirm(blankPending)
      }
    } catch {
      /* optional */
    }
    return {
      ok: false,
      reason: 'uncovered_needs_confirm',
      message: '占块无法落到 A1 槽。请确认空白铸门。',
      decomposition,
      regionBinding,
      pendingConfirm: blankPending ?? undefined,
    }
  }

  const mixed = decomposition.coverage === 'mixed_hit_and_uncovered'

  // 无空白：区域把手 = 指针单门或 combo，立刻齐
  if (!mixed && !regionBinding.blank) {
    const sealed = await sealEmphasizeRegionKey({
      docId,
      reuseBookKeys: regionBinding.reuse.map((r) => r.bookKey),
    })
    regionBinding = {
      ...regionBinding,
      regionKey: sealed.regionKey,
      regionMemberKeys: sealed.regionMemberKeys,
    }
    // 多指针时 chosen.R.key 已是 combo；单指针则与 regionKey 同
    if (sealed.regionKey !== chosen.R.key && sealed.regionMemberKeys.length > 1) {
      chosen.R = { ...chosen.R, key: sealed.regionKey, memberKeys: sealed.regionMemberKeys }
    }
  }

  try {
    const { usePageMarkStore } = await import('./pageMarkStore')
    const st = usePageMarkStore.getState()
    st.setLastLayoutHits({
      docId,
      emphasisId: edge.id,
      bookKeys: regionBinding.reuse.map((r) => r.bookKey),
    })
    if (regionBinding.regionKey) {
      st.attachRegionToEmphasize({
        docId,
        emphasizeId: edge.id,
        regionKey: regionBinding.regionKey,
        regionMemberKeys: regionBinding.regionMemberKeys,
      })
    }
    if (mixed && blankPending) st.setPendingEmphasizeConfirm(blankPending)
    else st.clearPendingEmphasizeConfirm()
  } catch {
    /* optional */
  }

  return {
    ok: true,
    chosen,
    candidates: [chosen],
    source: chosen.R.source,
    coverage: mixed ? 'mixed_hit_and_uncovered' : 'hit_existing',
    decomposition,
    regionBinding,
    pendingConfirm: mixed && blankPending ? blankPending : undefined,
  }
}

/**
 * B-side object anchoring: BM25 over A1 atoms (no embedding).
 */
export async function resolveVqToCandidates(
  index: BookIndex,
  question: string,
  topK = 8,
): Promise<{
  candidates: CircleCandidate[]
  weakFigOnly: boolean
  usedEmbedApi: boolean
  autoLockOk: boolean
  poolSize: number
  expandNote: string
  searchQuery: string
}> {
  const q = question.trim()
  if (!q || index.chunks.length === 0) {
    return {
      candidates: [],
      weakFigOnly: false,
      usedEmbedApi: false,
      autoLockOk: false,
      poolSize: 0,
      expandNote: '',
      searchQuery: q,
    }
  }

  const retrievalQ = q

  const bm = await recallCandidatesByBm25({
    bookIndex: index,
    query: retrievalQ,
    topK,
    allowedKeys: null,
  })

  return {
    candidates: bm.candidates,
    weakFigOnly: bm.weakFigOnly,
    usedEmbedApi: false,
    autoLockOk: bm.autoLockOk,
    poolSize: bm.poolSize,
    expandNote: '',
    searchQuery: retrievalQ,
  }
}

/** Legacy no-op: retrieval no longer uses vBook vectors. */
export async function reembedBookIndex(index: BookIndex): Promise<{
  index: BookIndex
  usedApi: boolean
}> {
  return {
    index: {
      ...index,
      chunks: index.chunks.map((c) => ({ ...c, vBook: [] })),
      builtAt: Date.now(),
    },
    usedApi: false,
  }
}
