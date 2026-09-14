/**
 * Embedding client for 审计 / 寻址 (V_book, V_q).
 * OpenAI-compatible /embeddings; falls back to local lexical probe when unset.
 */

import { demoAuthHeaders } from './demoAuth'
import {
  embedEndpointReady,
  loadDualModelConfig,
} from './modelRuntimeConfig'
import { textToProbe } from './lexicalProbe'

export function embedConfigStatus(): {
  configured: boolean
  baseUrl: string
  model: string
  mode: 'api' | 'lexical_probe'
} {
  const { embed } = loadDualModelConfig()
  const configured = embedEndpointReady(embed)
  return {
    configured,
    baseUrl: embed.baseUrl || '/api/llm',
    model: embed.model,
    mode: configured ? 'api' : 'lexical_probe',
  }
}

function l2Normalize(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 1
  return v.map((x) => x * inv)
}

async function embedViaApi(texts: string[]): Promise<number[][]> {
  const { embed } = loadDualModelConfig()
  if (!embedEndpointReady(embed)) {
    throw new Error('审计 Embedding 未配置')
  }
  // Prefer server proxy so LLM_API_KEY never ships in the browser bundle.
  const base = (embed.baseUrl.trim() || '/api/llm').replace(/\/$/, '')
  const url = `${base}/embeddings`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...demoAuthHeaders(),
  }
  if (embed.apiKey.trim() && !base.startsWith('/api/llm')) {
    headers.Authorization = `Bearer ${embed.apiKey.trim()}`
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: embed.model,
      input: texts,
    }),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Embedding HTTP ${res.status}: ${errText.slice(0, 240)}`)
  }
  const data: unknown = await res.json()
  if (
    typeof data !== 'object' ||
    data === null ||
    !('data' in data) ||
    !Array.isArray((data as { data: unknown }).data)
  ) {
    throw new Error('Embedding 响应格式异常')
  }
  const rows = (data as { data: Array<{ embedding?: unknown; index?: number }> })
    .data
  const sorted = [...rows].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  )
  const out: number[][] = []
  for (const row of sorted) {
    if (!Array.isArray(row.embedding)) {
      throw new Error('Embedding 向量缺失')
    }
    const vec: number[] = []
    for (const x of row.embedding) {
      if (typeof x !== 'number') throw new Error('Embedding 向量含非数字')
      vec.push(x)
    }
    out.push(l2Normalize(vec))
  }
  if (out.length !== texts.length) {
    throw new Error(
      `Embedding 条数不匹配：期望 ${texts.length}，得到 ${out.length}`,
    )
  }
  return out
}

/** Single or batch; uses API when configured, else lexical probe. */
export async function embedTexts(texts: string[]): Promise<{
  vectors: number[][]
  usedApi: boolean
}> {
  if (texts.length === 0) return { vectors: [], usedApi: false }
  const status = embedConfigStatus()
  if (!status.configured) {
    return {
      vectors: texts.map((t) => textToProbe(t)),
      usedApi: false,
    }
  }
  // Batch in chunks to avoid payload limits
  const BATCH = 32
  const vectors: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH)
    const part = await embedViaApi(slice)
    vectors.push(...part)
  }
  return { vectors, usedApi: true }
}

export async function embedOne(text: string): Promise<{
  vector: number[]
  usedApi: boolean
}> {
  const { vectors, usedApi } = await embedTexts([text])
  return { vector: vectors[0] ?? textToProbe(text), usedApi }
}
