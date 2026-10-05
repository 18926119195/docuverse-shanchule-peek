/**
 * Emphasis → LLM-readable packet.
 * Geometry stays for local navigate; model should pick ids, not invent coords.
 */

import type { PageDocument } from '../zigzag/types'
import type { EmphasisEdge, EmphasisLink, PagePoint } from './emphasis'
import { imageUrlToDataUri } from './ocrService'

export interface CatalogEntry {
  id: string
  strandIndex: number
  sourceDoc: string | null
  sourcePage: number | null
  reading: string
  hasReading: boolean
  polygonPointCount: number
  /** Metadata only — do not ask the model to re-layout from these */
  aabb: [number, number, number, number]
  contextPolicy: 'in_situ'
  groundPolicy: 'page_minus_figure'
}

export interface CatalogLinkEntry {
  id: string
  fromEmphasisId: string
  toEmphasisId: string
  fromStrand: number | null
  toStrand: number | null
  note: string
}

export interface OutlinedPageImage {
  emphasisId: string
  strandIndex: number
  /** JPEG/PNG data URI with outline drawn on full page */
  dataUri: string
}

export interface EmphasisPacket {
  version: 1
  generatedAt: number
  instructions: string
  catalogText: string
  entries: CatalogEntry[]
  links: CatalogLinkEntry[]
  outlinedImages: OutlinedPageImage[]
}

const PACKET_INSTRUCTIONS = [
  '本数据包描述用户在原件页上密封的「强调边」（figure←ground），不是剪报副本。',
  '每条边有稳定 id。请只从目录中选择匹配的 id；不要编造 id，不要输出坐标当定位依据。',
  'aabb / polygon 元数据仅供系统本地导航；请勿自行换算版面。',
  '无「用户理解」的边请结合整页描边图理解强调域。',
  '回复时优先输出 JSON：{"ids":["emph_…"],"reason":"…"}。',
].join('\n')

export function buildCatalogEntries(
  edges: EmphasisEdge[],
): CatalogEntry[] {
  return edges.map((e) => ({
    id: e.id,
    strandIndex: e.strandIndex,
    sourceDoc: e.sourceDoc ?? null,
    sourcePage: e.sourcePage ?? null,
    reading: e.reading,
    hasReading: Boolean(e.reading.trim()),
    polygonPointCount: e.region.polygon.length,
    aabb: e.region.aabb,
    contextPolicy: e.contextPolicy,
    groundPolicy: e.groundPolicy,
  }))
}

export function buildCatalogLinkEntries(
  links: EmphasisLink[],
  edges: EmphasisEdge[],
): CatalogLinkEntry[] {
  const byId = new Map(edges.map((e) => [e.id, e]))
  return links.map((l) => {
    const from = byId.get(l.fromEmphasisId)
    const to = byId.get(l.toEmphasisId)
    return {
      id: l.id,
      fromEmphasisId: l.fromEmphasisId,
      toEmphasisId: l.toEmphasisId,
      fromStrand: from?.strandIndex ?? null,
      toStrand: to?.strandIndex ?? null,
      note: l.note,
    }
  })
}

export function formatCatalogText(
  entries: CatalogEntry[],
  links: CatalogLinkEntry[],
): string {
  const lines: string[] = [
    '=== 强调边目录（catalog）===',
    `共 ${entries.length} 条强调 · ${links.length} 条跨页射线`,
    '',
  ]
  for (const e of entries) {
    const pageLabel =
      e.sourcePage != null
        ? `PDF 第 ${e.sourcePage} 页（strand ${e.strandIndex}）`
        : `strand ${e.strandIndex}`
    const doc = e.sourceDoc ? ` · 文档 ${e.sourceDoc}` : ''
    lines.push(`---`)
    lines.push(`id: ${e.id}`)
    lines.push(`页: ${pageLabel}${doc}`)
    lines.push(
      `用户理解: ${e.hasReading ? e.reading : '（无——请看描边图）'}`,
    )
    lines.push(
      `语义: 原件页 in_situ 强调域（figure←ground），轮廓 ${e.polygonPointCount} 点`,
    )
    lines.push(
      `本地锚点元数据(勿换算): aabb=${JSON.stringify(e.aabb)}`,
    )
  }
  if (links.length > 0) {
    lines.push('')
    lines.push('=== 跨页强调射线 ===')
    for (const l of links) {
      lines.push(
        `id: ${l.id} · ${l.fromEmphasisId} (s${l.fromStrand ?? '?'}) → ${l.toEmphasisId} (s${l.toStrand ?? '?'})${l.note ? ` · ${l.note}` : ''}`,
      )
    }
  }
  return lines.join('\n')
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('页图加载失败'))
    img.src = url
  })
}

/** Draw closed region on full page image (page_norm_0_1000 → pixels). */
export async function renderOutlinedPage(
  pageImageUrl: string,
  polygon: PagePoint[],
  opts?: { stroke?: string; fill?: string },
): Promise<string> {
  const dataUri = await imageUrlToDataUri(pageImageUrl)
  const img = await loadImage(dataUri)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth || img.width
  canvas.height = img.naturalHeight || img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.drawImage(img, 0, 0)
  if (polygon.length < 3) {
    return canvas.toDataURL('image/jpeg', 0.85)
  }
  const w = canvas.width
  const h = canvas.height
  ctx.beginPath()
  polygon.forEach(([nx, ny], i) => {
    const x = (nx / 1000) * w
    const y = (ny / 1000) * h
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.closePath()
  ctx.fillStyle = opts?.fill ?? 'rgba(255, 213, 79, 0.22)'
  ctx.fill()
  ctx.strokeStyle = opts?.stroke ?? '#ffd54f'
  ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) * 0.004))
  ctx.stroke()
  return canvas.toDataURL('image/jpeg', 0.85)
}

/**
 * Crop around aabb (with padding) + outline — for overview linking board.
 * Still from original page render; not a detached clip ontology.
 */
export async function renderEmphasisTile(
  pageImageUrl: string,
  polygon: PagePoint[],
  aabb: [number, number, number, number],
  opts?: { padNorm?: number },
): Promise<string> {
  const dataUri = await imageUrlToDataUri(pageImageUrl)
  const img = await loadImage(dataUri)
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  const pad = opts?.padNorm ?? 40
  const [x0, y0, x1, y1] = aabb
  const left = Math.max(0, ((x0 - pad) / 1000) * w)
  const top = Math.max(0, ((y0 - pad) / 1000) * h)
  const right = Math.min(w, ((x1 + pad) / 1000) * w)
  const bottom = Math.min(h, ((y1 + pad) / 1000) * h)
  const cw = Math.max(1, Math.round(right - left))
  const ch = Math.max(1, Math.round(bottom - top))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.drawImage(img, left, top, cw, ch, 0, 0, cw, ch)
  if (polygon.length >= 3) {
    ctx.beginPath()
    polygon.forEach(([nx, ny], i) => {
      const x = (nx / 1000) * w - left
      const y = (ny / 1000) * h - top
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.fillStyle = 'rgba(255, 213, 79, 0.2)'
    ctx.fill()
    ctx.strokeStyle = '#ffd54f'
    ctx.lineWidth = Math.max(2, Math.round(Math.min(cw, ch) * 0.012))
    ctx.stroke()
  }
  return canvas.toDataURL('image/jpeg', 0.88)
}

export interface BuildPacketOptions {
  /** Prefer outlining edges with empty reading (for model vision). */
  preferEmptyReading?: boolean
  /** Max outlined images to attach (cost / size). */
  maxOutlinedImages?: number
  /** If set, only outline these ids. */
  onlyIds?: string[]
}

export async function buildEmphasisPacket(
  edges: EmphasisEdge[],
  links: EmphasisLink[],
  pages: PageDocument[],
  options: BuildPacketOptions = {},
): Promise<EmphasisPacket> {
  const preferEmpty = options.preferEmptyReading !== false
  const maxImages = options.maxOutlinedImages ?? 12
  const entries = buildCatalogEntries(edges)
  const linkEntries = buildCatalogLinkEntries(links, edges)
  const catalogText = formatCatalogText(entries, linkEntries)

  let candidates = [...edges]
  if (options.onlyIds?.length) {
    const allow = new Set(options.onlyIds)
    candidates = candidates.filter((e) => allow.has(e.id))
  }
  if (preferEmpty) {
    candidates = [
      ...candidates.filter((e) => !e.reading.trim()),
      ...candidates.filter((e) => e.reading.trim()),
    ]
  }

  const pageByStrand = new Map(pages.map((p) => [p.strandIndex, p]))
  const outlinedImages: OutlinedPageImage[] = []
  for (const e of candidates) {
    if (outlinedImages.length >= maxImages) break
    const page = pageByStrand.get(e.strandIndex)
    if (!page?.imageUrl) continue
    try {
      const dataUri = await renderOutlinedPage(
        page.imageUrl,
        e.region.polygon,
      )
      outlinedImages.push({
        emphasisId: e.id,
        strandIndex: e.strandIndex,
        dataUri,
      })
    } catch {
      /* skip broken page image */
    }
  }

  return {
    version: 1,
    generatedAt: Date.now(),
    instructions: PACKET_INSTRUCTIONS,
    catalogText,
    entries,
    links: linkEntries,
    outlinedImages,
  }
}

/** Local cascade ①: match user reading text. */
export function searchEmphasisByReading(
  edges: EmphasisEdge[],
  query: string,
): EmphasisEdge[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return edges.filter((e) => e.reading.toLowerCase().includes(q))
}

/** Pull emph_… ids from model JSON or free text. */
export function parseEmphasisIdsFromModelText(
  text: string,
  knownIds: Set<string>,
): string[] {
  const found = new Set<string>()
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed: unknown = JSON.parse(jsonMatch[0])
      if (
        parsed &&
        typeof parsed === 'object' &&
        'ids' in parsed &&
        Array.isArray((parsed as { ids: unknown }).ids)
      ) {
        for (const id of (parsed as { ids: unknown[] }).ids) {
          if (typeof id === 'string' && knownIds.has(id)) found.add(id)
        }
      }
    }
  } catch {
    /* fall through to regex */
  }
  const re = /emph_[a-z0-9]+_[a-z0-9]+/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (knownIds.has(m[0])) found.add(m[0])
  }
  return [...found]
}

export function downloadEmphasisPacketJson(packet: EmphasisPacket): void {
  const slim = {
    version: packet.version,
    generatedAt: packet.generatedAt,
    instructions: packet.instructions,
    catalogText: packet.catalogText,
    entries: packet.entries,
    links: packet.links,
    outlinedImageIds: packet.outlinedImages.map((o) => ({
      emphasisId: o.emphasisId,
      strandIndex: o.strandIndex,
      bytesApprox: Math.round(o.dataUri.length * 0.75),
    })),
  }
  const blob = new Blob([JSON.stringify(slim, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `emphasis-packet-${packet.generatedAt}.json`
  a.click()
  URL.revokeObjectURL(url)
}
