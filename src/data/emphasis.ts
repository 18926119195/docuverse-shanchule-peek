/**
 * Emphasis = 人手划重点（与 layout 同级 peer），画在同一 PDF 页基底上。
 * 共享 page_norm bbox；落笔本身不铸门。
 * 命中已有 layout → 复用 bookKey；未覆盖 → 用户确认后再按 layout 公式铸门。
 * Pipeline = recorded conversion steps (bits → presentation), intervenable by user.
 */

export type PagePoint = [number, number]

/** Closed region selector in page_norm_0_1000（与 layout / bookKey bbox 同一尺子） */
export interface RegionSelector {
  coordSpace: 'page_norm_0_1000'
  polygon: PagePoint[]
  /** Derived axis-aligned box for quick hit / beam endpoints */
  aabb: [number, number, number, number]
}

export interface EmphasisEdge {
  id: string
  /**
   * 与 BookIndex.docId 对齐的分析对象 id（同一份未改版 PDF）。
   * 旧持久化可能缺省；运行时应补齐后再做 ∩ layout。
   */
  docId?: string
  strandIndex: number
  sourceDoc?: string
  sourcePage?: number
  /** Geometric selector — 与 layout 槽同一 page_norm 基底 */
  region: RegionSelector
  /** Always in-situ: figure is emphasized against same-page ground */
  contextPolicy: 'in_situ'
  groundPolicy: 'page_minus_figure'
  /** User's understanding of this figure←ground relation */
  reading: string
  createdAt: number
  updatedAt: number
}

/** User-authored ray between two emphasis edges (often cross-page) */
export interface EmphasisLink {
  id: string
  fromEmphasisId: string
  toEmphasisId: string
  /** Short label for the relation */
  note: string
  /**
   * Locked world-space apex of the purple link.
   * When set, the two pages park as a triangle cluster around this point
   * so many such structures can be seen globally in the same universe.
   */
  apex: [number, number, number] | null
  /** Comment centre C on the construction median (A–B base edge). */
  commentCenter: [number, number, number] | null
  createdAt: number
}

function isVec3(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    typeof v[2] === 'number'
  )
}

export function normalizeEmphasisEdge(raw: unknown): EmphasisEdge | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') return null
  if (typeof r.strandIndex !== 'number') return null
  if (!r.region || typeof r.region !== 'object') return null
  const region = r.region as Record<string, unknown>
  if (!Array.isArray(region.polygon) || !Array.isArray(region.aabb)) return null
  const polygon = region.polygon as PagePoint[]
  const aabb = region.aabb as [number, number, number, number]
  if (polygon.length < 3 || aabb.length !== 4) return null
  return {
    id: r.id,
    docId: typeof r.docId === 'string' ? r.docId : undefined,
    strandIndex: r.strandIndex,
    sourceDoc: typeof r.sourceDoc === 'string' ? r.sourceDoc : undefined,
    sourcePage: typeof r.sourcePage === 'number' ? r.sourcePage : undefined,
    region: {
      coordSpace: 'page_norm_0_1000',
      polygon,
      aabb,
    },
    contextPolicy: 'in_situ',
    groundPolicy: 'page_minus_figure',
    reading: typeof r.reading === 'string' ? r.reading : '',
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
  }
}

export function normalizeEmphasisLink(raw: unknown): EmphasisLink | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') return null
  if (typeof r.fromEmphasisId !== 'string') return null
  if (typeof r.toEmphasisId !== 'string') return null
  return {
    id: r.id,
    fromEmphasisId: r.fromEmphasisId,
    toEmphasisId: r.toEmphasisId,
    note: typeof r.note === 'string' ? r.note : '',
    apex: isVec3(r.apex) ? [r.apex[0], r.apex[1], r.apex[2]] : null,
    commentCenter: isVec3(r.commentCenter)
      ? [r.commentCenter[0], r.commentCenter[1], r.commentCenter[2]]
      : null,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
  }
}

export type PipelineStepKind =
  | 'parse'
  | 'render'
  | 'normalize'
  | 'emphasize'
  | 'reading'
  | 'link'
  | 'ocr'
  | 'note'

export interface PipelineStep {
  id: string
  at: number
  kind: PipelineStepKind
  actor: 'system' | 'user'
  summary: string
  /** Lightweight provenance — no pixel copies */
  detail?: Record<string, string | number | boolean | null>
}

export function newEmphasisId(): string {
  return `emph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function newEmphasisLinkId(): string {
  return `elink_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function newPipelineStepId(): string {
  return `pipe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function polygonAabb(
  polygon: PagePoint[],
): [number, number, number, number] {
  let minX = 1000
  let minY = 1000
  let maxX = 0
  let maxY = 0
  for (const [x, y] of polygon) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return [minX, minY, maxX, maxY]
}

export function regionCentroid(
  aabb: [number, number, number, number],
): PagePoint {
  const [x0, y0, x1, y1] = aabb
  return [(x0 + x1) / 2, (y0 + y1) / 2]
}

/**
 * Area centroid of a closed region (shoelace).
 * Prefer this over vertex-average: hand-drawn ink densifies some edges and
 * would pull the mean away from the visual centre of the irregular figure.
 */
export function polygonCentroid(polygon: PagePoint[]): PagePoint {
  if (polygon.length === 0) return [500, 500]
  if (polygon.length === 1) return polygon[0]
  if (polygon.length === 2) {
    return [
      (polygon[0][0] + polygon[1][0]) / 2,
      (polygon[0][1] + polygon[1][1]) / 2,
    ]
  }

  // Drop duplicate closing vertex if present
  let pts = polygon
  const first = polygon[0]
  const last = polygon[polygon.length - 1]
  if (distPage(first, last) < 1e-6 && polygon.length > 3) {
    pts = polygon.slice(0, -1)
  }

  let area2 = 0
  let cx = 0
  let cy = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % n]
    const cross = x0 * y1 - x1 * y0
    area2 += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }

  // Degenerate / self-tangled ring → fall back to vertex mean
  if (Math.abs(area2) < 1e-6) {
    let sx = 0
    let sy = 0
    for (const [x, y] of pts) {
      sx += x
      sy += y
    }
    return [sx / n, sy / n]
  }

  const inv = 1 / (3 * area2)
  return [cx * inv, cy * inv]
}

export function makeRegionSelector(polygon: PagePoint[]): RegionSelector {
  return {
    coordSpace: 'page_norm_0_1000',
    polygon,
    aabb: polygonAabb(polygon),
  }
}

/** Page-local XY (origin center) → 0–1000 */
export function localToPagePoint(
  localX: number,
  localY: number,
  pageW: number,
  pageH: number,
): PagePoint {
  const x = ((localX + pageW / 2) / pageW) * 1000
  const y = ((pageH / 2 - localY) / pageH) * 1000
  return [
    Math.min(1000, Math.max(0, x)),
    Math.min(1000, Math.max(0, y)),
  ]
}

/** 0–1000 → page-local XY */
export function pagePointToLocal(
  pt: PagePoint,
  pageW: number,
  pageH: number,
): [number, number] {
  const [nx, ny] = pt
  const x = -pageW / 2 + (nx / 1000) * pageW
  const y = pageH / 2 - (ny / 1000) * pageH
  return [x, y]
}

export function distPage(a: PagePoint, b: PagePoint): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return Math.hypot(dx, dy)
}

/** Close if ≥3 points and last near first (in 0–1000 space) */
export function canClosePolygon(
  points: PagePoint[],
  threshold = 90,
): boolean {
  if (points.length < 3) return false
  return distPage(points[0], points[points.length - 1]) <= threshold
}

/**
 * Segment intersection in page space.
 * Returns intersection point or null (touches at endpoints of adjacent ink ignored by caller).
 */
export function segmentIntersection(
  a1: PagePoint,
  a2: PagePoint,
  b1: PagePoint,
  b2: PagePoint,
): PagePoint | null {
  const [x1, y1] = a1
  const [x2, y2] = a2
  const [x3, y3] = b1
  const [x4, y4] = b2
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
  if (Math.abs(den) < 1e-9) return null
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
  const u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den
  // Allow near-endpoint crossings (dense ink often crosses near vertices)
  if (t < 0.001 || t > 0.999 || u < 0.001 || u > 0.999) return null
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)]
}

/**
 * When the newest segment crosses an earlier part of the trail,
 * return the closed polygon (intersection → … → back to intersection).
 */
export function closedPolygonFromSelfIntersection(
  points: PagePoint[],
): PagePoint[] | null {
  if (points.length < 4) return null
  const n = points.length
  const a1 = points[n - 2]
  const a2 = points[n - 1]
  // Skip the two segments adjacent to the newest one (would false-positive)
  for (let i = 0; i < n - 3; i++) {
    // Also skip very start↔end adjacency when almost closed
    if (i === 0 && n < 6) continue
    const hit = segmentIntersection(a1, a2, points[i], points[i + 1])
    if (!hit) continue
    const ring = [hit, ...points.slice(i + 1, n - 1)]
    if (ring.length >= 3) return ring
  }
  return null
}

/** Open polyline → closed ring (no duplicate closing vertex stored) */
export function finalizeClosedPolygon(points: PagePoint[]): PagePoint[] | null {
  if (points.length < 3) return null
  let poly = [...points]
  if (distPage(poly[0], poly[poly.length - 1]) <= 90 && poly.length > 3) {
    poly = poly.slice(0, -1)
  }
  if (poly.length < 3) return null
  return poly
}

/**
 * Resolve a drawable trail into a sealed region:
 * 1) self-crossing loop, or
 * 2) tip returned near start (user drew a closed circle without a sharp X).
 */
export function resolveClosedEmphasisRing(
  points: PagePoint[],
  nearStartThreshold = 70,
): PagePoint[] | null {
  if (points.length < 3) return null
  const crossed = closedPolygonFromSelfIntersection(points)
  if (crossed && crossed.length >= 3) return crossed
  // Need enough path length so a tiny scribble near start doesn't seal
  if (points.length < 8) return null
  let pathLen = 0
  for (let i = 1; i < points.length; i++) {
    pathLen += distPage(points[i - 1], points[i])
  }
  if (pathLen < 120) return null
  if (!canClosePolygon(points, nearStartThreshold)) return null
  return finalizeClosedPolygon(points)
}

/** Drop near-duplicate samples while drawing */
export function appendDrawPoint(
  points: PagePoint[],
  next: PagePoint,
  minDist = 3,
): PagePoint[] {
  if (points.length === 0) return [next]
  const last = points[points.length - 1]
  if (distPage(last, next) < minDist) return points
  return [...points, next]
}

const STORAGE_PREFIX = 'docuverse.emphasis.v1:'

export function emphasisStorageKey(
  corpus: string,
  label: string | null,
): string {
  return `${STORAGE_PREFIX}${corpus}:${label ?? 'default'}`
}

export function loadEmphasisState(key: string): {
  edges: EmphasisEdge[]
  links: EmphasisLink[]
  pipeline: PipelineStep[]
} {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { edges: [], links: [], pipeline: [] }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { edges: [], links: [], pipeline: [] }
    }
    const rec = parsed as Record<string, unknown>
    const edges = Array.isArray(rec.edges)
      ? (rec.edges
          .map((e) => normalizeEmphasisEdge(e))
          .filter(Boolean) as EmphasisEdge[])
      : []
    const links = Array.isArray(rec.links)
      ? (rec.links
          .map((l) => normalizeEmphasisLink(l))
          .filter(Boolean) as EmphasisLink[])
      : []
    const pipeline = Array.isArray(rec.pipeline)
      ? (rec.pipeline as PipelineStep[])
      : []
    return { edges, links, pipeline }
  } catch {
    return { edges: [], links: [], pipeline: [] }
  }
}

export function saveEmphasisState(
  key: string,
  edges: EmphasisEdge[],
  links: EmphasisLink[],
  pipeline: PipelineStep[],
): void {
  try {
    localStorage.setItem(key, JSON.stringify({ edges, links, pipeline }))
  } catch {
    /* quota */
  }
}

/** Remove all persisted emphasis corpora (pdf / upload / …). */
export function clearAllEmphasisStorage(): number {
  let n = 0
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(STORAGE_PREFIX)) keys.push(k)
    }
    for (const k of keys) {
      localStorage.removeItem(k)
      n++
    }
  } catch {
    /* private mode */
  }
  return n
}
