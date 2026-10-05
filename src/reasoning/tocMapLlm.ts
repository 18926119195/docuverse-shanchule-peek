/**
 * toc_map：用户框选目录相关渲染页 → LLM 读目录上的印码页 → 台侧校准换成 strand。
 * LLM 只出 title + startPrinted/endPrinted（书上印码）；禁止直接猜 strand。
 */

import type { BookIndex } from './pipelineA'
import { demoAuthHeaders } from './demoAuth'
import { llmThinkingField } from './llmThinking'
import {
  loadDualModelConfig,
  reasonEndpointReady,
  LOCKED_LLM,
} from './modelRuntimeConfig'
import { extractJsonObject } from './inferPath'
import {
  emptyTocEntry,
  fillEndPrinted,
  type TocEntryDraft,
} from './tocParse'
import {
  printedRangeToStrandRange,
  calibrationNote,
  type PageCalibration,
} from './pageCalibration'

async function flashChat(input: {
  system: string
  user: string
}): Promise<{ ok: true; content: string } | { ok: false; note: string }> {
  const { reason } = loadDualModelConfig()
  if (!reasonEndpointReady(reason)) {
    return { ok: false, note: '推理槽未配置（/api/llm）' }
  }
  const base = (reason.baseUrl.trim() || '/api/llm').replace(/\/$/, '')
  const url = `${base}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...demoAuthHeaders(),
  }
  if (reason.apiKey.trim() && !base.startsWith('/api/')) {
    headers.Authorization = `Bearer ${reason.apiKey.trim()}`
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: reason.model || LOCKED_LLM.chatModel,
        temperature: 0.1,
        max_tokens: 8192,
        ...llmThinkingField('disabled'),
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
      }),
    })
    if (!res.ok) {
      const errText = await res.text()
      return {
        ok: false,
        note: `LLM HTTP ${res.status}: ${errText.slice(0, 160)}`,
      }
    }
    const data: unknown = await res.json()
    if (
      typeof data !== 'object' ||
      data === null ||
      !('choices' in data) ||
      !Array.isArray((data as { choices: unknown }).choices)
    ) {
      return { ok: false, note: 'LLM 响应无 choices' }
    }
    const content = (
      data as { choices: Array<{ message?: { content?: string } }> }
    ).choices[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, note: 'LLM 空内容' }
    }
    return { ok: true, content }
  } catch (e) {
    return {
      ok: false,
      note: e instanceof Error ? e.message : 'LLM 请求失败',
    }
  }
}

/** 把印码起止换成 strand，并填末节到 maxStrand */
export function applyPrintedCalibration(
  entries: TocEntryDraft[],
  cal: PageCalibration,
  maxStrand: number,
): TocEntryDraft[] {
  const filled = fillEndPrinted(entries)
  return filled.map((e, i) => {
    const next = filled[i + 1]
    const endPrinted = next
      ? Math.max(e.startPrinted, next.startPrinted - 1)
      : e.endPrinted
    const { startPage, endPage } = printedRangeToStrandRange(
      e.startPrinted,
      endPrinted,
      cal,
    )
    const startStrand = Math.max(0, Math.min(maxStrand, startPage))
    let endStrand = Math.max(0, Math.min(maxStrand, endPage))
    if (i === filled.length - 1) {
      endStrand = Math.max(startStrand, maxStrand)
    }
    if (endStrand < startStrand) endStrand = startStrand
    return {
      ...e,
      startPrinted: e.startPrinted,
      endPrinted,
      startStrand,
      endStrand,
    }
  })
}

function parseTocMapPrinted(raw: string): TocEntryDraft[] {
  const obj = extractJsonObject(raw)
  if (!obj || typeof obj !== 'object') return []
  const root = obj as Record<string, unknown>
  const arr = Array.isArray(root.sections) ? root.sections : []
  const drafts: TocEntryDraft[] = []
  for (let i = 0; i < arr.length; i++) {
    const row = arr[i]
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const title = String(r.title ?? '').trim()
    if (!title) continue
    let start = Number(r.startPrinted ?? r.start_page ?? r.startPage)
    let end = Number(r.endPrinted ?? r.end_page ?? r.endPage)
    if (!Number.isFinite(start)) continue
    if (!Number.isFinite(end)) end = start
    start = Math.max(0, Math.floor(start))
    end = Math.max(start, Math.floor(end))
    const level = Math.max(1, Math.min(6, Number(r.level) || 1))
    drafts.push({
      id: `toc_llm_${Date.now().toString(36)}_${i}`,
      title: title.slice(0, 160),
      startPrinted: start,
      endPrinted: end,
      level,
    })
  }
  return fillEndPrinted(drafts)
}

/**
 * 选中的目录页文本 → LLM（印码）→ 校准 → strand 起止。
 */
export async function runTocMapLlm(input: {
  tocStrands: number[]
  pageText: (strand: number) => string
  bookIndex: BookIndex
  maxStrand: number
  /** 印码 → strand；缺则只返回印码草稿，不写 strand */
  calibration: PageCalibration | null
  onProgress?: (msg: string) => void
}): Promise<{
  ok: boolean
  entries: TocEntryDraft[]
  note: string
  raw: string
}> {
  const strands = [...new Set(input.tocStrands)]
    .filter((s) => s >= 0 && s <= input.maxStrand)
    .sort((a, b) => a - b)
  if (strands.length === 0) {
    return {
      ok: false,
      entries: [],
      note: '请先点选至少一页目录（strand）',
      raw: '',
    }
  }
  void input.bookIndex

  input.onProgress?.(`toc_map · 读目录页×${strands.length}…`)

  const pageBlocks = strands.map((s) => {
    const text = input.pageText(s).trim() || '（本页无文本/OCR）'
    return `【目录相关页 · strand=${s} · 机器第 ${s + 1} 张牌】\n${text.slice(0, 6000)}`
  })

  const system = [
    '你是目录分节员 toc_map。',
    '用户已框选与目录有关的 PDF 渲染页（可能是总目/续目/图目）。',
    '请从目录文字抽出有序章/节标题，并读取目录上标注的正文印码页（阿拉伯数字，如「… 42」「… 224」）。',
    '【硬规则】只输出书上印码 startPrinted/endPrinted；禁止输出 strand/机器牌；禁止把「目录条所在渲染页」当成正文页界。',
    '若目录只给了起点印码，endPrinted 可等于 startPrinted（台会用下一节起点−1 填）。',
    '禁止编造目录页未出现的标题。只输出一个 JSON 对象，不要散文。',
  ].join('\n')

  const user = [
    '【目录相关页 OCR/文本】',
    ...pageBlocks,
    '',
    '只输出 JSON：',
    '{',
    '  "tocStrandsUsed": [0,1],',
    '  "sections": [',
    '    { "ord": 0, "title": "章/节名", "level": 1, "startPrinted": 42, "endPrinted": 46, "status": "sufficient" }',
    '  ],',
    '  "unresolved": [],',
    '  "attentionArrived": true',
    '}',
    '硬规则：startPrinted/endPrinted 必须是目录上的印码整数；节按书序排列；',
    '不要输出 startStrand/endStrand。',
  ].join('\n')

  input.onProgress?.('toc_map · LLM 读印码分节…')
  const chat = await flashChat({ system, user })
  if (!chat.ok) {
    return { ok: false, entries: [], note: chat.note, raw: '' }
  }

  let entries = parseTocMapPrinted(chat.content)
  if (entries.length === 0) {
    entries = [
      {
        ...emptyTocEntry(0),
        startPrinted: 1,
        endPrinted: 1,
      },
    ]
    return {
      ok: false,
      entries,
      note: 'toc_map 未能解析印码 JSON · 已给占位行，请手改印码并校准',
      raw: chat.content,
    }
  }

  if (!input.calibration) {
    return {
      ok: true,
      entries,
      note: `toc_map · 印码分节×${entries.length} · 尚未校准，确认前请完成印码→strand`,
      raw: chat.content,
    }
  }

  const mapped = applyPrintedCalibration(
    entries,
    input.calibration,
    input.maxStrand,
  )
  return {
    ok: true,
    entries: mapped,
    note: `toc_map · 印码×${entries.length} → strand（${calibrationNote(input.calibration)}）· 目录页 ${strands.join(',')}`,
    raw: chat.content,
  }
}
