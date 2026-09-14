/**
 * Visual grounding: key* text → boxes on the scanned page IMAGE.
 * Matching OCR blocks alone only echoes drifted layout boxes; scans need
 * a locate pass against the rendered page pixels.
 */

import {
  imageUrlToDataUri,
  normalizeBboxToThousand,
} from '../data/ocrService'
import { demoAuthHeaders } from './demoAuth'
import { loadDualModelConfig, reasonEndpointReady } from './modelRuntimeConfig'
import type { LockBox } from './types'
import { normalizeInkText } from './inkHighlight'

const groundCache = new Map<string, LockBox[]>()

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function parseBoxesPayload(
  raw: string,
  page: number,
): LockBox[] {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence?.[1] ?? trimmed).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    const arr = body.match(/\[[\s\S]*\]/)
    if (!arr) return []
    try {
      parsed = JSON.parse(arr[0])
    } catch {
      return []
    }
  }

  let rawBoxes: unknown[] = []
  if (Array.isArray(parsed)) {
    rawBoxes = parsed
  } else {
    const rec = asRecord(parsed)
    if (rec && Array.isArray(rec.boxes)) rawBoxes = rec.boxes
    else if (rec && Array.isArray(rec.bbox)) rawBoxes = [rec.bbox]
  }

  const out: LockBox[] = []
  for (const item of rawBoxes) {
    let nums: number[] | null = null
    if (Array.isArray(item) && item.length >= 4) {
      nums = item.slice(0, 4).map((n) => Number(n))
    } else {
      const rec = asRecord(item)
      if (rec && Array.isArray(rec.bbox) && rec.bbox.length >= 4) {
        nums = rec.bbox.slice(0, 4).map((n) => Number(n))
      }
    }
    if (!nums || nums.some((n) => !Number.isFinite(n))) continue
    const tuple: [number, number, number, number] = [
      nums[0],
      nums[1],
      nums[2],
      nums[3],
    ]
    // Accept 0–1 or 0–1000
    const bbox = normalizeBboxToThousand(tuple, 1000, 1000)
    if (bbox[2] - bbox[0] < 2 || bbox[3] - bbox[1] < 2) continue
    if (bbox[2] - bbox[0] > 980 && bbox[3] - bbox[1] > 980) continue
    out.push({ page, bbox })
  }
  return out.slice(0, 8)
}

function excerptForGround(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= 420) return t
  return `${t.slice(0, 200)} […] ${t.slice(-180)}`
}

/**
 * Ask a vision chat model to locate the locked excerpt on the page image.
 * Returns page_norm boxes (0–1000). Cached per page+excerpt fingerprint.
 */
export async function groundExcerptOnPageImage(input: {
  text: string
  page: number
  imageUrl: string
}): Promise<{ boxes: LockBox[]; note: string }> {
  const needle = normalizeInkText(input.text)
  if (needle.length < 12 || !input.imageUrl) {
    return { boxes: [], note: '无可用摘录或页图' }
  }

  const cacheKey = `${input.page}|${needle.slice(0, 160)}|${needle.slice(-80)}`
  const cached = groundCache.get(cacheKey)
  if (cached) return { boxes: cached, note: 'vision_ground(cache)' }

  const { reason } = loadDualModelConfig()
  const multimodalReason =
    reasonEndpointReady(reason) &&
    /4v|vision|gpt-4o|gemini|qwen.*vl|internvl|llava|vl-/i.test(reason.model)
  // Scans need a real vision locate — do not send page image to text-only chat.
  const useReason = multimodalReason
  const url = useReason
    ? `${(reason.baseUrl.trim() || '/api/llm').replace(/\/$/, '')}/chat/completions`
    : '/api/zhipu/chat/completions'
  const model = useReason ? reason.model : 'glm-4v-flash'
  const apiKey = useReason ? reason.apiKey : ''

  let dataUri: string
  try {
    dataUri = await imageUrlToDataUri(input.imageUrl)
  } catch (e) {
    return {
      boxes: [],
      note: e instanceof Error ? e.message : String(e),
    }
  }

  const excerpt = excerptForGround(input.text)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...demoAuthHeaders(),
  }
  if (apiKey.trim() && !url.startsWith('/api/')) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You locate a text excerpt on a scanned book page image. Return JSON only: {"boxes":[[x0,y0,x1,y1],...]}. Coordinates are page_norm 0–1000, origin top-left, axis down/right. One box per contiguous ink region of the excerpt; do not cover unrelated paragraphs. No markdown.',
          },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUri } },
              {
                type: 'text',
                text: `Locate this excerpt on the page (may be OCR-noisy French). Boxes must hug the printed ink of this passage only:\n\n${excerpt}`,
              },
            ],
          },
        ],
      }),
    })
    const raw = await res.text()
    let json: unknown
    try {
      json = JSON.parse(raw) as unknown
    } catch {
      return { boxes: [], note: `ground 非 JSON: ${raw.slice(0, 120)}` }
    }
    if (!res.ok) {
      return { boxes: [], note: `ground HTTP ${res.status}` }
    }
    const rec = asRecord(json)
    const choices = rec && Array.isArray(rec.choices) ? rec.choices : []
    const first = asRecord(choices[0])
    const message = asRecord(first?.message)
    const content = message?.content
    let textOut = ''
    if (typeof content === 'string') textOut = content
    else if (Array.isArray(content)) {
      textOut = content
        .map((p) => {
          const pr = asRecord(p)
          return typeof pr?.text === 'string' ? pr.text : ''
        })
        .join('\n')
    }
    const boxes = parseBoxesPayload(textOut, input.page)
    if (boxes.length > 0) groundCache.set(cacheKey, boxes)
    return {
      boxes,
      note:
        boxes.length > 0
          ? `vision_ground ×${boxes.length}`
          : 'vision_ground 无有效框',
    }
  } catch (e) {
    return {
      boxes: [],
      note: e instanceof Error ? e.message : String(e),
    }
  }
}

export function clearInkGroundCache(): void {
  groundCache.clear()
}
