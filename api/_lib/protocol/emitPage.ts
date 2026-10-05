/**
 * Layout cut → bookKey emission (server).
 * 一 layout 提案行 → 一枚 lockId（layout 坐标）；同行 OCR 字只作初始 T 脸，不进 lockId。
 * layout_details from Zhipu is page-major: layout_details[pageIndex] = blocks[].
 */
import { zhipuApiKey, zhipuOcrModel } from '../env.js'
import { makeSlotKey } from './keys.js'

export type PageBBox = [number, number, number, number]

export interface EmittedSlot {
  /** bookKey lockId = layout (doc, page, layoutK)；非 OCR 身份 */
  lockId: string
  /** 页内 layout 步序（= bookKey 时间分量）；≠ OCR 步 */
  layoutK: number
  /** @deprecated 同 layoutK；兼容旧调用 */
  slotK: number
  page: number
  label: string
  bbox: PageBBox
  /** 初始 OCR 读数 T（脸）；改字不换 lockId */
  content: string
  sourceContent: string
  cutBound: true
}

export interface EmitPageResult {
  docId: string
  page: number
  slots: EmittedSlot[]
  pageWidth?: number
  pageHeight?: number
  markdown: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function asBBox(v: unknown): PageBBox | null {
  if (!Array.isArray(v) || v.length < 4) return null
  const nums = v.slice(0, 4).map((x) => Number(x))
  if (nums.some((n) => !Number.isFinite(n))) return null
  return [nums[0], nums[1], nums[2], nums[3]]
}

function clampThousandBox(b: PageBBox): PageBBox {
  const clamp = (n: number) => Math.max(0, Math.min(1000, n))
  let [x0, y0, x1, y1] = b
  x0 = clamp(x0)
  y0 = clamp(y0)
  x1 = clamp(x1)
  y1 = clamp(y1)
  if (x1 < x0) [x0, x1] = [x1, x0]
  if (y1 < y0) [y0, y1] = [y1, y0]
  return [x0, y0, x1, y1]
}

/**
 * Normalize layout bbox → page_norm 0–1000 (origin top-left, +y down).
 * Live Zhipu: bbox_2d is pixels on data_info canvas.
 */
export function normalizeBboxToThousand(
  bbox: PageBBox,
  refW: number,
  refH: number,
): PageBBox {
  const [x0, y0, x1, y1] = bbox
  const maxV = Math.max(
    Math.abs(x0),
    Math.abs(y0),
    Math.abs(x1),
    Math.abs(y1),
  )
  let out: PageBBox
  if (maxV <= 1.0001) {
    out = [x0 * 1000, y0 * 1000, x1 * 1000, y1 * 1000]
  } else if (refW > 1 && refH > 1) {
    out = [
      (x0 / refW) * 1000,
      (y0 / refH) * 1000,
      (x1 / refW) * 1000,
      (y1 / refH) * 1000,
    ]
  } else if (maxV <= 1000.5) {
    out = [x0, y0, x1, y1]
  } else {
    out = [
      (x0 / maxV) * 1000,
      (y0 / maxV) * 1000,
      (x1 / maxV) * 1000,
      (y1 / maxV) * 1000,
    ]
  }
  return clampThousandBox(out)
}

function readApiCanvasSize(json: Record<string, unknown>): {
  width: number
  height: number
} {
  const dataInfo = isRecord(json.data_info) ? json.data_info : null
  const pages = dataInfo && Array.isArray(dataInfo.pages) ? dataInfo.pages : []
  const page0 = pages.length > 0 && isRecord(pages[0]) ? pages[0] : null
  const width =
    (page0 && typeof page0.width === 'number' ? page0.width : 0) ||
    (dataInfo && typeof dataInfo.width === 'number' ? dataInfo.width : 0) ||
    0
  const height =
    (page0 && typeof page0.height === 'number' ? page0.height : 0) ||
    (dataInfo && typeof dataInfo.height === 'number' ? dataInfo.height : 0) ||
    0
  return { width, height }
}

/**
 * Zhipu returns layout_details as:
 * - page-major: [ [block, …], [block, …], … ]
 * - or flat: [ block, block, … ]
 * Never treat an inner page array as a single “block”.
 */
export function unwrapLayoutDetailBlocks(
  json: Record<string, unknown>,
  pageIndex = 0,
): unknown[] {
  const details = json.layout_details
  if (!Array.isArray(details) || details.length === 0) {
    if (Array.isArray(json.data)) return json.data
    return []
  }
  const first = details[0]
  if (Array.isArray(first)) {
    const idx = Math.max(0, Math.min(pageIndex, details.length - 1))
    const pageBlocks = details[idx]
    return Array.isArray(pageBlocks) ? pageBlocks : []
  }
  if (isRecord(first) && (first.bbox_2d !== undefined || first.bbox !== undefined)) {
    return details
  }
  if (isRecord(details) && Array.isArray((details as { layouts?: unknown }).layouts)) {
    return (details as unknown as { layouts: unknown[] }).layouts
  }
  return []
}

/** Normalize layout_parsing JSON into ordered {label,content,bbox}[] in page_norm. */
export function parseLayoutBlocks(
  json: unknown,
  pageIndex = 0,
): Array<{
  label: string
  content: string
  bbox: PageBBox
}> {
  if (!isRecord(json)) return []
  const { width: apiW, height: apiH } = readApiCanvasSize(json)
  const source = unwrapLayoutDetailBlocks(json, pageIndex)
  const out: Array<{ label: string; content: string; bbox: PageBBox }> = []

  for (const item of source) {
    if (!isRecord(item)) continue
    const raw =
      asBBox(item.bbox_2d) ||
      asBBox(item.bbox) ||
      asBBox(item.box) ||
      null
    if (!raw) continue
    const itemW = typeof item.width === 'number' ? item.width : 0
    const itemH = typeof item.height === 'number' ? item.height : 0
    const bbox = normalizeBboxToThousand(
      raw,
      apiW > 1 ? apiW : itemW,
      apiH > 1 ? apiH : itemH,
    )
    if (bbox[2] - bbox[0] < 0.5 || bbox[3] - bbox[1] < 0.5) continue
    const label =
      typeof item.label === 'string'
        ? item.label
        : typeof item.category === 'string'
          ? item.category
          : 'text'
    const content =
      typeof item.content === 'string'
        ? item.content
        : typeof item.text === 'string'
          ? item.text
          : typeof item.markdown === 'string'
            ? item.markdown
            : ''
    out.push({ label, content: content.trim(), bbox })
  }

  out.sort((a, b) => {
    const dy = a.bbox[1] - b.bbox[1]
    if (Math.abs(dy) > 8) return dy
    return a.bbox[0] - b.bbox[0]
  })
  return out
}

export async function callZhipuLayout(fileDataUri: string): Promise<unknown> {
  const apiKey = zhipuApiKey()
  if (!apiKey) throw new Error('ZHIPU_API_KEY missing on server')

  const res = await fetch('https://open.bigmodel.cn/api/paas/v4/layout_parsing', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: zhipuOcrModel(),
      file: fileDataUri,
    }),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  } catch {
    throw new Error(`OCR 响应非 JSON: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const msg =
      isRecord(json) && isRecord(json.error) && typeof json.error.message === 'string'
        ? json.error.message
        : text.slice(0, 300)
    throw new Error(`OCR 失败: ${msg}`)
  }
  return json
}

/**
 * Server layout-encode: one layout proposal row → one bookKey (layoutK);
 * geom from proposal; OCR text on the same row = initial T face only.
 */
export async function emitPageSlots(input: {
  docId: string
  page: number
  imageDataUri: string
}): Promise<EmitPageResult> {
  const layout = await callZhipuLayout(input.imageDataUri)
  // Single page image → always page 0 of layout_details
  const blocks = parseLayoutBlocks(layout, 0)
  if (blocks.length === 0) {
    const hint =
      isRecord(layout) && Array.isArray(layout.layout_details)
        ? `layout_details pages=${layout.layout_details.length}`
        : 'no layout_details'
    throw new Error(
      `layout 未切出任何版面槽（${hint}）。请确认智谱 layout_parsing 返回含 bbox 的块。`,
    )
  }

  const slots: EmittedSlot[] = blocks.map((b, layoutK) => ({
    lockId: makeSlotKey(input.docId, input.page, layoutK),
    layoutK,
    slotK: layoutK,
    page: input.page,
    label: b.label,
    bbox: b.bbox,
    content: b.content,
    sourceContent: b.content,
    cutBound: true as const,
  }))

  const md =
    isRecord(layout) && typeof layout.md_results === 'string'
      ? layout.md_results
      : slots.map((s) => s.content).filter(Boolean).join('\n\n')

  const { width: pageWidth, height: pageHeight } = isRecord(layout)
    ? readApiCanvasSize(layout)
    : { width: 0, height: 0 }

  return {
    docId: input.docId,
    page: input.page,
    slots,
    pageWidth: pageWidth || undefined,
    pageHeight: pageHeight || undefined,
    markdown: md,
  }
}
