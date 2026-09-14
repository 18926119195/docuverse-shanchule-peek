/**
 * GLM-OCR layout_parsing — returns text blocks with bbox for same-plane compare.
 */

export interface OcrBlock {
  /**
   * Stable id：emit 后为 sealed bookKey handle（layout 门牌）。
   * 改 content 永不换 id / 不挪 bbox。
   */
  id: string
  index: number
  label: string
  /** Editable T — changing this never moves the bbox or remints bookKey */
  content: string
  /** Immutable text from the first OCR pass (provenance / restore) = T0 */
  sourceContent: string
  /** Normalized 0–1000 coords: [xmin, ymin, xmax, ymax] — layout geom */
  bbox: [number, number, number, number]
  /** User has verified this text; required before permanent bond */
  confirmed: boolean
  /**
   * True when geom was registered at layout cut (切割即登记 bookKey)。
   */
  cutBound?: boolean
  /**
   * 页内 layout 步序（bookKey 时间分量）。
   * 历史名 slotK；语义 = layoutK，≠ OCR 步。
   */
  slotK?: number
  layoutK?: number
}

export interface OcrPageResult {
  strandIndex: number
  markdown: string
  blocks: OcrBlock[]
  pageWidth: number
  pageHeight: number
  createdAt: number
  /**
   * One-shot audit of how layout coords were interpreted (for OCR 对照错位排查).
   * Not required for restore; safe to ignore in UI.
   */
  coordDebug?: {
    imageWidth: number
    imageHeight: number
    apiWidth: number
    apiHeight: number
    sampleRaw: [number, number, number, number] | null
    sampleNorm: [number, number, number, number] | null
  }
}

export function newOcrBlockId(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

export function rebuildOcrMarkdown(blocks: OcrBlock[]): string {
  return blocks
    .map((b) => b.content.trim())
    .filter((t) => t.length > 0)
    .join('\n\n')
}

export function ocrPageHasEdits(result: OcrPageResult): boolean {
  return result.blocks.some((b) => b.content !== b.sourceContent)
}

/** Local page-plane point → small bbox in 0–1000 (for “add block at click”) */
export function localPointToBbox(
  localX: number,
  localY: number,
  pageW: number,
  pageH: number,
  boxW = 200,
  boxH = 70,
): [number, number, number, number] {
  const nx = ((localX + pageW / 2) / pageW) * 1000
  const ny = ((pageH / 2 - localY) / pageH) * 1000
  const halfW = boxW / 2
  const halfH = boxH / 2
  return [
    Math.min(1000, Math.max(0, nx - halfW)),
    Math.min(1000, Math.max(0, ny - halfH)),
    Math.min(1000, Math.max(0, nx + halfW)),
    Math.min(1000, Math.max(0, ny + halfH)),
  ]
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function parseBbox(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length < 4) return null
  const nums = raw.slice(0, 4).map((x) => Number(x))
  if (nums.some((n) => Number.isNaN(n))) return null
  return [nums[0], nums[1], nums[2], nums[3]]
}

/** Optional sizes that disambiguate MaaS pixel bboxes vs page_norm. */
export type BboxNormContext = {
  /** Bitmap we display / crop (local page image). */
  imageWidth?: number
  imageHeight?: number
  /**
   * `data_info.pages[0]` from layout_parsing — the canvas MaaS bbox pixels
   * are measured on (may equal the upload, or an internal re-render).
   */
  apiWidth?: number
  apiHeight?: number
}

function clampThousandBox(
  out: [number, number, number, number],
): [number, number, number, number] {
  const ax = Math.min(out[0], out[2])
  const ay = Math.min(out[1], out[3])
  const bx = Math.max(out[0], out[2])
  const by = Math.max(out[1], out[3])
  return [
    Math.min(1000, Math.max(0, ax)),
    Math.min(1000, Math.max(0, ay)),
    Math.min(1000, Math.max(0, bx)),
    Math.min(1000, Math.max(0, by)),
  ]
}

function pixelsToThousand(
  bbox: [number, number, number, number],
  refW: number,
  refH: number,
): [number, number, number, number] {
  const [x0, y0, x1, y1] = bbox
  return [
    (x0 / refW) * 1000,
    (y0 / refH) * 1000,
    (x1 / refW) * 1000,
    (y1 / refH) * 1000,
  ]
}

/**
 * MaaS may letterbox the page into a different-aspect canvas. Map 0–1000 on
 * that canvas back onto the content bitmap (contain-fit).
 */
export function unletterboxThousandToImage(
  box: [number, number, number, number],
  apiW: number,
  apiH: number,
  imgW: number,
  imgH: number,
): [number, number, number, number] {
  if (apiW < 2 || apiH < 2 || imgW < 2 || imgH < 2) return box
  const scale = Math.min(apiW / imgW, apiH / imgH)
  const dw = imgW * scale
  const dh = imgH * scale
  if (dw < 1 || dh < 1) return box
  const ox = (apiW - dw) / 2
  const oy = (apiH - dh) / 2
  const map = (nx: number, ny: number): [number, number] => {
    const cx = (nx / 1000) * apiW
    const cy = (ny / 1000) * apiH
    return [((cx - ox) / dw) * 1000, ((cy - oy) / dh) * 1000]
  }
  const a = map(box[0], box[1])
  const b = map(box[2], box[3])
  return [a[0], a[1], b[0], b[1]]
}

/**
 * Normalize layout bbox → page_norm 0–1000 (origin top-left, +y down).
 *
 * Live Zhipu layout_parsing (this project): bbox_2d is **pixels** on
 * data_info / the bitmap we sent — confirmed by crop passes where
 * xmax/ymax equal the crop width/height (e.g. raw=[8,29,363,390] on
 * 363×390). OpenAPI examples of 0–1 still apply when maxAbs ≤ 1.
 *
 * Do NOT keep values ≤1000 as page_norm when we know the pixel canvas:
 * on a 960×743 scan every coord is ≤1000, and treating them as thousandths
 * systematically shrinks overlays toward the top-left.
 */
export function normalizeBboxToThousand(
  bbox: [number, number, number, number],
  pageWidth: number,
  pageHeight: number,
  ctx?: BboxNormContext,
): [number, number, number, number] {
  const [x0, y0, x1, y1] = bbox
  const maxV = Math.max(
    Math.abs(x0),
    Math.abs(y0),
    Math.abs(x1),
    Math.abs(y1),
  )

  const apiW = ctx?.apiWidth && ctx.apiWidth > 1 ? ctx.apiWidth : 0
  const apiH = ctx?.apiHeight && ctx.apiHeight > 1 ? ctx.apiHeight : 0
  const imgW =
    ctx?.imageWidth && ctx.imageWidth > 1
      ? ctx.imageWidth
      : pageWidth > 1
        ? pageWidth
        : 0
  const imgH =
    ctx?.imageHeight && ctx.imageHeight > 1
      ? ctx.imageHeight
      : pageHeight > 1
        ? pageHeight
        : 0

  const refW = apiW > 1 ? apiW : imgW
  const refH = apiH > 1 ? apiH : imgH

  let out: [number, number, number, number]
  if (maxV <= 1.0001) {
    // Documented 0–1 fractions
    out = [x0 * 1000, y0 * 1000, x1 * 1000, y1 * 1000]
  } else if (refW > 1 && refH > 1) {
    // Absolute pixels on the same canvas as data_info / local bitmap
    out = pixelsToThousand(bbox, refW, refH)
  } else if (maxV <= 1000.5) {
    // No canvas size known — assume already page_norm
    out = [x0, y0, x1, y1]
  } else {
    out = [
      (x0 / maxV) * 1000,
      (y0 / maxV) * 1000,
      (x1 / maxV) * 1000,
      (y1 / maxV) * 1000,
    ]
  }

  if (apiW > 1 && apiH > 1 && imgW > 1 && imgH > 1) {
    const apiAspect = apiW / apiH
    const imgAspect = imgW / imgH
    if (Math.abs(apiAspect - imgAspect) > 0.04) {
      out = unletterboxThousandToImage(out, apiW, apiH, imgW, imgH)
    }
  }

  return clampThousandBox(out)
}

/** Strip OCR markdown / TeX noise for on-plane display */
export function sanitizeOcrDisplayText(raw: string): string {
  return raw
    .replace(/\$\\textcircled\{[^}]*\}\$/g, '©')
    .replace(/\\textcircled\{[^}]*\}/g, '©')
    .replace(/\$[^$]*\$/g, (m) => m.replace(/\$/g, ''))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseLayoutParsingResponse(
  json: unknown,
  strandIndex: number,
  imageSize?: { width: number; height: number },
): OcrPageResult {
  const root = asRecord(json) ?? {}
  const dataInfo = asRecord(root.data_info)
  const pages = Array.isArray(dataInfo?.pages) ? dataInfo.pages : []
  const page0 = asRecord(pages[0])
  // MaaS bbox pixels are on data_info canvas (GLM-OCR SDK divides by these)
  const apiWidth = Number(page0?.width) || 0
  const apiHeight = Number(page0?.height) || 0
  // Local bitmap we display / crop — keep for result.pageWidth/Height + letterbox
  const imageWidth =
    imageSize && imageSize.width > 1 ? imageSize.width : 0
  const imageHeight =
    imageSize && imageSize.height > 1 ? imageSize.height : 0
  const pageWidth = imageWidth || apiWidth || 1000
  const pageHeight = imageHeight || apiHeight || 1000

  const layoutDetails = root.layout_details
  const firstPageBlocks = Array.isArray(layoutDetails)
    ? Array.isArray(layoutDetails[0])
      ? layoutDetails[0]
      : layoutDetails
    : []

  const blocks: OcrBlock[] = []
  const mdParts: string[] = []
  let sampleRaw: [number, number, number, number] | null = null
  let sampleNorm: [number, number, number, number] | null = null

  const normCtx: BboxNormContext = {
    imageWidth: imageWidth || undefined,
    imageHeight: imageHeight || undefined,
    apiWidth: apiWidth || undefined,
    apiHeight: apiHeight || undefined,
  }

  for (const item of firstPageBlocks) {
    const rec = asRecord(item)
    if (!rec) continue
    const rawBbox = parseBbox(rec.bbox_2d)
    if (!rawBbox) continue
    // Legacy per-item width/height only if data_info missing
    const itemApiW = Number(rec.width) || 0
    const itemApiH = Number(rec.height) || 0
    const bbox = normalizeBboxToThousand(rawBbox, pageWidth, pageHeight, {
      ...normCtx,
      apiWidth: normCtx.apiWidth || itemApiW || undefined,
      apiHeight: normCtx.apiHeight || itemApiH || undefined,
    })
    if (!sampleRaw) {
      sampleRaw = rawBbox
      sampleNorm = bbox
    }
    // Degenerate / empty boxes
    if (bbox[2] - bbox[0] < 0.5 || bbox[3] - bbox[1] < 0.5) continue
    const content = typeof rec.content === 'string' ? rec.content.trim() : ''
    const label = typeof rec.label === 'string' ? rec.label : 'text'
    const index = typeof rec.index === 'number' ? rec.index : blocks.length
    blocks.push({
      id: newOcrBlockId(),
      index,
      label,
      content,
      sourceContent: content,
      bbox,
      confirmed: false,
    })
    if (content) mdParts.push(content)
  }

  const mdField =
    typeof root.md_results === 'string'
      ? root.md_results
      : typeof root.markdown === 'string'
        ? root.markdown
        : mdParts.join('\n\n')

  if (sampleRaw && sampleNorm) {
    const area = Math.max(0, imageWidth) * Math.max(0, imageHeight)
    // Full page ~960×740; tag role so k-crop lines are not mistaken for page geom
    const role = area >= 500_000 ? 'page' : 'crop'
    console.info(
      `[ocr-coord] role=${role} image=${imageWidth}x${imageHeight} api=${apiWidth}x${apiHeight} raw=${JSON.stringify(sampleRaw)} norm=${JSON.stringify(sampleNorm)}`,
    )
  }

  return {
    strandIndex,
    markdown: mdField,
    blocks,
    pageWidth,
    pageHeight,
    createdAt: Date.now(),
    coordDebug: {
      imageWidth,
      imageHeight,
      apiWidth,
      apiHeight,
      sampleRaw,
      sampleNorm,
    },
  }
}

/** Fetch image as data URI (handles blob:, http(s):, and relative paths) */
export async function imageUrlToDataUri(url: string): Promise<string> {
  if (url.startsWith('data:')) return url
  const res = await fetch(url)
  if (!res.ok) throw new Error(`无法读取页面图像: ${res.status}`)
  const blob = await res.blob()
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const b64 = btoa(binary)
  const mime = blob.type || 'image/png'
  return `data:${mime};base64,${b64}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export async function runGlmOcrOnImage(
  dataUri: string,
  strandIndex: number,
): Promise<OcrPageResult> {
  // Lazy import to avoid circular deps with reasoning ↔ data
  const { loadDualModelConfig, ocrEndpointReady } = await import(
    '../reasoning/modelRuntimeConfig'
  )
  const { demoAuthHeaders } = await import('../reasoning/demoAuth')
  const { ocr } = loadDualModelConfig()
  if (!ocrEndpointReady(ocr)) {
    throw new Error(
      'OCR 未配置：请在 Pilot「模型部署」填写 OCR 端点/Key，或在 .env 配置 ZHIPU_API_KEY 并使用 /api/zhipu 代理',
    )
  }
  const base = (ocr.baseUrl.trim() || '/api/zhipu').replace(/\/$/, '')
  const url = `${base}/layout_parsing`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...demoAuthHeaders(),
  }
  if (ocr.apiKey.trim()) {
    headers.Authorization = `Bearer ${ocr.apiKey.trim()}`
  }
  const body = JSON.stringify({
    model: ocr.model.trim() || 'glm-ocr',
    file: dataUri,
  })

  let res: Response | null = null
  let text = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, { method: 'POST', headers, body })
    text = await res.text()
    if (res.status !== 429) break
    // Rate limit: back off before retry (cut-encode used to stampede the API)
    await sleep(800 * (attempt + 1) * (attempt + 1))
  }
  if (!res) throw new Error('OCR 请求未发出')

  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  } catch {
    throw new Error(`OCR 响应非 JSON: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const err = asRecord(json)
    const msg =
      (typeof err?.error === 'object' &&
        err.error &&
        typeof (err.error as { message?: string }).message === 'string' &&
        (err.error as { message: string }).message) ||
      (typeof err?.msg === 'string' && err.msg) ||
      text.slice(0, 300)
    throw new Error(`OCR 失败: ${msg}`)
  }
  let imageSize: { width: number; height: number } | undefined
  try {
    const img = await loadHtmlImage(dataUri)
    imageSize = {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
    }
  } catch {
    imageSize = undefined
  }
  return parseLayoutParsingResponse(json, strandIndex, imageSize)
}

/**
 * Map normalized 0–1000 bbox → local page plane coords (origin at page center).
 * inset=0 keeps OCR twin and source highlights on the exact same grid.
 */
export function bboxToLocalRect(
  bbox: [number, number, number, number],
  pageW: number,
  pageH: number,
  inset = 0,
): { x: number; y: number; w: number; h: number } {
  const [x0, y0, x1, y1] = bbox
  const nx0 = x0 / 1000
  const ny0 = y0 / 1000
  const nx1 = x1 / 1000
  const ny1 = y1 / 1000
  const minX = -pageW / 2 + inset
  const maxX = pageW / 2 - inset
  const minY = -pageH / 2 + inset
  const maxY = pageH / 2 - inset
  let left = -pageW / 2 + nx0 * pageW
  let right = -pageW / 2 + nx1 * pageW
  let top = pageH / 2 - ny0 * pageH
  let bottom = pageH / 2 - ny1 * pageH
  if (inset > 0) {
    left = Math.min(maxX, Math.max(minX, left))
    right = Math.min(maxX, Math.max(minX, right))
    top = Math.min(maxY, Math.max(minY, top))
    bottom = Math.min(maxY, Math.max(minY, bottom))
  }
  if (right < left) [left, right] = [right, left]
  if (top < bottom) [top, bottom] = [bottom, top]
  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    w: Math.max(0.04, right - left),
    h: Math.max(0.04, top - bottom),
  }
}

/** Pick a font size that fits content inside a bbox without spilling neighbors */
export function fitOcrFontSize(
  text: string,
  boxW: number,
  boxH: number,
): number {
  const padW = boxW * 0.92
  const padH = boxH * 0.88
  if (padW < 0.05 || padH < 0.04) return 0.06
  const chars = Math.max(1, text.length)
  // Start from height, then shrink so wrapped lines fit
  let fs = Math.min(0.2, padH * 0.72)
  for (let i = 0; i < 8; i++) {
    const charsPerLine = Math.max(4, Math.floor(padW / (fs * 0.52)))
    const lines = Math.ceil(chars / charsPerLine)
    const needH = lines * fs * 1.15
    if (needH <= padH) break
    fs *= padH / needH
  }
  return Math.min(0.2, Math.max(0.055, fs))
}

function loadHtmlImage(dataUri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('页图解码失败，无法切割'))
    img.src = dataUri
  })
}

/**
 * Crop page data-URI by page_norm AABB (0–1000). Same numbers used for slot geom.
 * Optional padThousand expands the crop slightly for OCR margins (geom stays unpadded).
 */
export async function cropPageByBbox(
  pageDataUri: string,
  bbox: [number, number, number, number],
  padThousand = 6,
): Promise<string> {
  const img = await loadHtmlImage(pageDataUri)
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  if (w < 2 || h < 2) throw new Error('页图尺寸无效')

  const [x0, y0, x1, y1] = bbox
  const px0 = Math.max(0, Math.floor(((x0 - padThousand) / 1000) * w))
  const py0 = Math.max(0, Math.floor(((y0 - padThousand) / 1000) * h))
  const px1 = Math.min(w, Math.ceil(((x1 + padThousand) / 1000) * w))
  const py1 = Math.min(h, Math.ceil(((y1 + padThousand) / 1000) * h))
  const cw = Math.max(1, px1 - px0)
  const ch = Math.max(1, py1 - py0)

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建裁切画布')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, cw, ch)
  ctx.drawImage(img, px0, py0, cw, ch, 0, 0, cw, ch)
  return canvas.toDataURL('image/png')
}

function sortBlocksReadingOrder<T extends { bbox: [number, number, number, number]; index: number }>(
  blocks: T[],
): T[] {
  return [...blocks].sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index
    const dy = a.bbox[1] - b.bbox[1]
    if (Math.abs(dy) > 8) return dy
    return a.bbox[0] - b.bbox[0]
  })
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}

/**
 * Cut→Slot ceremony on one page image (same URL as render):
 * 1) ProposeRegions via full-page layout_parsing → lock geom (+ paired content)
 * 2) T0 = propose content for that item; crop-OCR only if propose text empty
 * 3) Slot row = OcrBlock { bbox=geom, sourceContent=T0, content=T, cutBound }
 */
export async function runCutEncodeOcrOnImage(
  pageDataUri: string,
  strandIndex: number,
  opts?: { concurrency?: number; onProgress?: (done: number, total: number) => void },
): Promise<OcrPageResult> {
  const proposed = await runGlmOcrOnImage(pageDataUri, strandIndex)
  const ordered = sortBlocksReadingOrder(proposed.blocks)
  if (ordered.length === 0) {
    return { ...proposed, blocks: [] }
  }

  const concurrency = opts?.concurrency ?? 1
  const recognized = await mapPool(ordered, concurrency, async (block, k) => {
    const geom = block.bbox
    // Text paired with this geom in the same ProposeRegions item — primary T.
    // Re-OCR on crop often invents extra lines (e.g. fake 2nd bullet) while AABB
    // stays on the first; that is T≠框, not a page_norm bug.
    const proposalT = (block.sourceContent || block.content || '').trim()
    let t0 = proposalT
    if (!t0) {
      try {
        if (k > 0) await sleep(350)
        const cropUri = await cropPageByBbox(pageDataUri, geom)
        const cropResult = await runGlmOcrOnImage(cropUri, strandIndex)
        const parts = sortBlocksReadingOrder(cropResult.blocks)
          .map((b) => b.content.trim())
          .filter((t) => t.length > 0)
        // One primary string — joining every micro-block fabricates multi-bullet T
        t0 =
          parts.length === 0
            ? ''
            : parts.reduce((a, b) => (a.length >= b.length ? a : b))
      } catch {
        t0 = ''
      }
    }
    opts?.onProgress?.(k + 1, ordered.length)
    const row: OcrBlock = {
      id: block.id,
      index: k,
      label: block.label,
      content: t0,
      sourceContent: t0,
      bbox: geom,
      confirmed: false,
      cutBound: true,
      slotK: k,
      layoutK: k,
    }
    return row
  })

  return {
    strandIndex,
    markdown: rebuildOcrMarkdown(recognized),
    blocks: recognized,
    pageWidth: proposed.pageWidth,
    pageHeight: proposed.pageHeight,
    createdAt: Date.now(),
    coordDebug: proposed.coordDebug,
  }
}

