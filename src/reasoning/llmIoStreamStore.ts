/**
 * 实验仓：LLM I/O 信息流（监督交互，非产品 UI）。
 * 每次 flash / 意图路由的 system+user+output(+usage) 落账，供一键复制诊断。
 */

import { create } from 'zustand'

export type LlmIoStreamKind = 'llm' | 'note'

/** OpenAI 兼容 usage；缺字段则 undefined */
export type LlmTokenUsage = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** 部分网关会给 reasoning / cached 等；原样附上便于对照 */
  reasoningTokens?: number
  cachedTokens?: number
}

export type LlmIoStreamEntry = {
  id: string
  seq: number
  kind: LlmIoStreamKind
  at: number
  job: string
  stage: string
  queryKey?: string
  llmCallId?: string
  ok: boolean
  finishReason?: string
  note?: string
  usage?: LlmTokenUsage
  system: string
  user: string
  output: string
}

type LlmIoStreamState = {
  entries: LlmIoStreamEntry[]
  nextSeq: number
  pushLlmIo: (input: {
    job: string
    stage?: string
    queryKey?: string
    llmCallId?: string
    ok: boolean
    finishReason?: string
    note?: string
    usage?: LlmTokenUsage | null
    system: string
    user: string
    output: string
  }) => string
  pushNote: (input: { job?: string; stage?: string; text: string }) => void
  clear: () => void
}

const MAX_ENTRIES = 120

function sid(): string {
  return `io_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 从 chat/completions JSON 抽 usage（兼容 OpenAI / DeepSeek 字段名） */
export function parseLlmUsage(data: unknown): LlmTokenUsage | undefined {
  if (!data || typeof data !== 'object') return undefined
  const root = data as Record<string, unknown>
  const u = root.usage
  if (!u || typeof u !== 'object') return undefined
  const usage = u as Record<string, unknown>
  const details =
    usage.completion_tokens_details &&
    typeof usage.completion_tokens_details === 'object'
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : null
  const promptDetails =
    usage.prompt_tokens_details &&
    typeof usage.prompt_tokens_details === 'object'
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : null
  const out: LlmTokenUsage = {
    promptTokens: asNum(usage.prompt_tokens) ?? asNum(usage.input_tokens),
    completionTokens:
      asNum(usage.completion_tokens) ?? asNum(usage.output_tokens),
    totalTokens: asNum(usage.total_tokens),
    reasoningTokens:
      asNum(usage.reasoning_tokens) ?? asNum(details?.reasoning_tokens),
    cachedTokens:
      asNum(usage.prompt_cache_hit_tokens) ??
      asNum(usage.cached_tokens) ??
      asNum(promptDetails?.cached_tokens),
  }
  if (
    out.promptTokens == null &&
    out.completionTokens == null &&
    out.totalTokens == null
  ) {
    return undefined
  }
  if (
    out.totalTokens == null &&
    out.promptTokens != null &&
    out.completionTokens != null
  ) {
    out.totalTokens = out.promptTokens + out.completionTokens
  }
  return out
}

export function addLlmUsage(
  a?: LlmTokenUsage | null,
  b?: LlmTokenUsage | null,
): LlmTokenUsage | undefined {
  if (!a && !b) return undefined
  if (!a) return b ?? undefined
  if (!b) return a
  const sum = (x?: number, y?: number) =>
    x == null && y == null ? undefined : (x ?? 0) + (y ?? 0)
  return {
    promptTokens: sum(a.promptTokens, b.promptTokens),
    completionTokens: sum(a.completionTokens, b.completionTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
    reasoningTokens: sum(a.reasoningTokens, b.reasoningTokens),
    cachedTokens: sum(a.cachedTokens, b.cachedTokens),
  }
}

export function formatLlmUsageLine(u?: LlmTokenUsage | null): string | null {
  if (!u) return null
  const bits: string[] = []
  if (u.promptTokens != null) bits.push(`prompt=${u.promptTokens}`)
  if (u.completionTokens != null) bits.push(`completion=${u.completionTokens}`)
  if (u.totalTokens != null) bits.push(`total=${u.totalTokens}`)
  if (u.reasoningTokens != null) bits.push(`reasoning=${u.reasoningTokens}`)
  if (u.cachedTokens != null) bits.push(`cached=${u.cachedTokens}`)
  return bits.length > 0 ? `tokens: ${bits.join(' · ')}` : null
}

export function sumLlmIoUsage(entries: LlmIoStreamEntry[]): LlmTokenUsage {
  let acc: LlmTokenUsage | undefined
  for (const e of entries) {
    if (e.kind !== 'llm' || !e.usage) continue
    acc = addLlmUsage(acc, e.usage)
  }
  return acc ?? {}
}

export function formatLlmIoEntry(e: LlmIoStreamEntry): string {
  const when = new Date(e.at).toISOString()
  if (e.kind === 'note') {
    return [
      `===== #${e.seq} NOTE · ${e.job} · ${e.stage} · ${when} =====`,
      e.note || e.output || '',
      '',
    ].join('\n')
  }
  return [
    `===== #${e.seq} ${e.job} · ${e.stage} · ${when} =====`,
    `ok: ${e.ok}`,
    e.finishReason ? `finishReason: ${e.finishReason}` : null,
    e.queryKey ? `queryKey: ${e.queryKey}` : null,
    e.llmCallId ? `llmCallId: ${e.llmCallId}` : null,
    formatLlmUsageLine(e.usage),
    e.note ? `note: ${e.note}` : null,
    '--- SYSTEM ---',
    e.system || '（空）',
    '--- USER ---',
    e.user || '（空）',
    '--- OUTPUT ---',
    e.output || '（空）',
    '',
  ]
    .filter((line) => line != null)
    .join('\n')
}

export function formatLlmIoStream(entries: LlmIoStreamEntry[]): string {
  const tot = sumLlmIoUsage(entries)
  const totLine = formatLlmUsageLine(tot)
  const llmN = entries.filter((e) => e.kind === 'llm').length
  const header = [
    '# Docuverse no-peek · LLM I/O 信息流',
    `# exportedAt: ${new Date().toISOString()}`,
    `# entries: ${entries.length} · llmCalls: ${llmN}`,
    totLine ? `# ${totLine}` : '# tokens: （本流无 usage / 网关未回）',
    '',
  ].join('\n')
  return header + entries.map(formatLlmIoEntry).join('\n')
}

export const useLlmIoStream = create<LlmIoStreamState>((set, get) => ({
  entries: [],
  nextSeq: 1,

  pushLlmIo: (input) => {
    const id = sid()
    const seq = get().nextSeq
    const entry: LlmIoStreamEntry = {
      id,
      seq,
      kind: 'llm',
      at: Date.now(),
      job: input.job.trim() || 'unknown',
      stage: (input.stage || 'flash').trim() || 'flash',
      queryKey: input.queryKey?.trim() || undefined,
      llmCallId: input.llmCallId?.trim() || undefined,
      ok: input.ok,
      finishReason: input.finishReason,
      note: input.note?.trim() || undefined,
      usage: input.usage ?? undefined,
      system: input.system,
      user: input.user,
      output: input.output,
    }
    set((s) => ({
      nextSeq: seq + 1,
      entries: [...s.entries, entry].slice(-MAX_ENTRIES),
    }))
    return id
  },

  pushNote: (input) => {
    const seq = get().nextSeq
    const entry: LlmIoStreamEntry = {
      id: sid(),
      seq,
      kind: 'note',
      at: Date.now(),
      job: (input.job || 'desk').trim(),
      stage: (input.stage || 'progress').trim(),
      ok: true,
      note: input.text,
      system: '',
      user: '',
      output: input.text,
    }
    set((s) => ({
      nextSeq: seq + 1,
      entries: [...s.entries, entry].slice(-MAX_ENTRIES),
    }))
  },

  clear: () => set({ entries: [], nextSeq: 1 }),
}))
