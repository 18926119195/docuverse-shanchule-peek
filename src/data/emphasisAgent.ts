/**
 * Emphasis Agent: cascade ① reading → ② catalog(+outlined) → ③ full PDF (confirm).
 * Model returns ids only; navigation uses local geometry.
 */

import type { PageDocument } from '../zigzag/types'
import type { EmphasisEdge, EmphasisLink } from './emphasis'
import {
  buildEmphasisPacket,
  parseEmphasisIdsFromModelText,
  searchEmphasisByReading,
  type EmphasisPacket,
} from './emphasisCatalog'

const CHAT_URL = '/api/zhipu/chat/completions'
const DEFAULT_MODEL = 'glm-4v-flash'

export type AgentStage = 'reading' | 'structure' | 'full_pdf' | 'done'

export interface AgentSearchResult {
  stage: AgentStage
  ids: string[]
  reason: string
  rawModelText?: string
  packet?: EmphasisPacket
  needsFullPdfConfirm?: boolean
}

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

async function callZhipuChat(
  messages: ChatMessage[],
  model = DEFAULT_MODEL,
): Promise<string> {
  const { demoAuthHeaders } = await import('../reasoning/demoAuth')
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...demoAuthHeaders(),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
    }),
  })
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  } catch {
    throw new Error(`模型响应非 JSON: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const errObj =
      json && typeof json === 'object' && 'error' in json
        ? (json as { error?: { message?: string } }).error?.message
        : undefined
    throw new Error(errObj ?? `模型请求失败 ${res.status}`)
  }
  if (
    !json ||
    typeof json !== 'object' ||
    !('choices' in json) ||
    !Array.isArray((json as { choices: unknown }).choices) ||
    (json as { choices: unknown[] }).choices.length === 0
  ) {
    throw new Error('模型响应缺少 choices')
  }
  const choice = (json as { choices: { message?: { content?: unknown } }[] })
    .choices[0]
  const content = choice?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p && typeof p === 'object' && 'text' in p) {
          const t = (p as { text: unknown }).text
          return typeof t === 'string' ? t : ''
        }
        return ''
      })
      .join('\n')
  }
  throw new Error('模型未返回文本内容')
}

export function runLocalReadingSearch(
  edges: EmphasisEdge[],
  query: string,
): AgentSearchResult {
  const hits = searchEmphasisByReading(edges, query)
  return {
    stage: 'reading',
    ids: hits.map((h) => h.id),
    reason:
      hits.length > 0
        ? `本地评论匹配 ${hits.length} 条`
        : '本地评论无匹配，可进入结构目录搜索',
  }
}

export async function runStructureCatalogSearch(
  query: string,
  edges: EmphasisEdge[],
  links: EmphasisLink[],
  pages: PageDocument[],
): Promise<AgentSearchResult> {
  if (edges.length === 0) {
    return {
      stage: 'structure',
      ids: [],
      reason: '尚无强调边',
      needsFullPdfConfirm: true,
    }
  }

  const packet = await buildEmphasisPacket(edges, links, pages, {
    preferEmptyReading: true,
    maxOutlinedImages: Math.min(8, edges.length),
  })

  const known = new Set(edges.map((e) => e.id))
  const userParts: ChatContentPart[] = [
    {
      type: 'text',
      text: [
        packet.instructions,
        '',
        packet.catalogText,
        '',
        `用户问句：${query}`,
        '',
        '请只从目录选匹配的强调 id。若确实无法匹配，返回 {"ids":[],"reason":"…","suggest_full_pdf":true}。',
        '描边图（若有）紧随其后，每张对应一条强调。',
      ].join('\n'),
    },
  ]

  for (const img of packet.outlinedImages) {
    userParts.push({
      type: 'text',
      text: `描边图 · id=${img.emphasisId} · strand ${img.strandIndex}`,
    })
    userParts.push({
      type: 'image_url',
      image_url: { url: img.dataUri },
    })
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是文档宇宙中的强调检索助手。只根据提供的 catalog 与描边图选择已有 emph_ id。禁止编造坐标；禁止编造 id。',
    },
    { role: 'user', content: userParts },
  ]

  let raw: string
  try {
    raw = await callZhipuChat(messages)
  } catch (firstErr) {
    // Fallback: text-only model if vision endpoint fails
    const textOnly: ChatMessage[] = [
      messages[0],
      {
        role: 'user',
        content: [
          packet.instructions,
          '',
          packet.catalogText,
          '',
          `用户问句：${query}`,
          '',
          '（本次未附带图像）请只从目录选 id，返回 {"ids":[…],"reason":"…"}。',
        ].join('\n'),
      },
    ]
    try {
      raw = await callZhipuChat(textOnly, 'glm-4-flash')
    } catch {
      throw firstErr instanceof Error
        ? firstErr
        : new Error(String(firstErr))
    }
  }

  const ids = parseEmphasisIdsFromModelText(raw, known)
  let suggestFull = ids.length === 0
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed: unknown = JSON.parse(jsonMatch[0])
      if (
        parsed &&
        typeof parsed === 'object' &&
        'suggest_full_pdf' in parsed &&
        (parsed as { suggest_full_pdf: unknown }).suggest_full_pdf === true
      ) {
        suggestFull = true
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        'reason' in parsed &&
        typeof (parsed as { reason: unknown }).reason === 'string'
      ) {
        return {
          stage: 'structure',
          ids,
          reason: (parsed as { reason: string }).reason,
          rawModelText: raw,
          packet,
          needsFullPdfConfirm: suggestFull && ids.length === 0,
        }
      }
    }
  } catch {
    /* use defaults */
  }

  return {
    stage: 'structure',
    ids,
    reason:
      ids.length > 0
        ? `结构目录匹配 ${ids.length} 条`
        : '结构目录未匹配；若需要可确认后搜全书',
    rawModelText: raw,
    packet,
    needsFullPdfConfirm: suggestFull,
  }
}

/** Coarse ③: send page texts (truncated) after user confirm. */
export async function runCoarseFullPdfSearch(
  query: string,
  edges: EmphasisEdge[],
  pages: PageDocument[],
): Promise<AgentSearchResult> {
  const known = new Set(edges.map((e) => e.id))
  const pageSnips = pages
    .slice(0, 40)
    .map((p) => {
      const body = (p.text || '').replace(/\s+/g, ' ').slice(0, 400)
      return `strand ${p.strandIndex}${p.sourcePage != null ? ` PDF p${p.sourcePage}` : ''}: ${body || '（无文本，仅有页图）'}`
    })
    .join('\n\n')

  const edgeHint = edges
    .map(
      (e) =>
        `${e.id} @strand${e.strandIndex} reading=${e.reading || '（无）'}`,
    )
    .join('\n')

  const raw = await callZhipuChat(
    [
      {
        role: 'system',
        content:
          '粗粒度全书检索。若能对应到已有强调 id 则返回这些 id；否则返回空 ids，并简述可能相关的页码（strand）。不要编造 emph_ id。',
      },
      {
        role: 'user',
        content: [
          `用户问句：${query}`,
          '',
          '已知强调边：',
          edgeHint || '（无）',
          '',
          '页文本摘要：',
          pageSnips,
          '',
          '返回 {"ids":[…],"reason":"…","hint_strands":[0,1]}',
        ].join('\n'),
      },
    ],
    'glm-4-flash',
  )

  const ids = parseEmphasisIdsFromModelText(raw, known)
  let reason = '全书粗搜完成'
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed: unknown = JSON.parse(jsonMatch[0])
      if (
        parsed &&
        typeof parsed === 'object' &&
        'reason' in parsed &&
        typeof (parsed as { reason: unknown }).reason === 'string'
      ) {
        reason = (parsed as { reason: string }).reason
      }
    }
  } catch {
    /* keep default */
  }

  return {
    stage: 'full_pdf',
    ids,
    reason,
    rawModelText: raw,
  }
}
