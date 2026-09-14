import { llmUpstream } from '../env.js'

const DEFAULT_CHAT_TIMEOUT_MS = 12 * 60 * 1000

export async function chatCompletion(input: {
  system: string
  user: string
  temperature?: number
  /** Cap completion length (infer-ops / formalize). */
  maxTokens?: number
  /** Abort upstream fetch after this many ms (default 12 min). */
  timeoutMs?: number
  /** DeepSeek V4：仅 infer 开 reasoning；默认关 */
  thinking?: boolean
}): Promise<
  | { ok: true; content: string; usedMock: false }
  | { ok: true; content: string; usedMock: true }
  | { ok: false; error: string; usedMock: false }
> {
  const upstream = llmUpstream()
  if (!upstream.apiKey) {
    return {
      ok: true,
      usedMock: true,
      content: JSON.stringify({
        conclusion: '【Mock】未配置 API Key',
        path: '1. mock\n2. mock',
        usedKeys: [],
        ops: [],
        formalConclusion: '【Mock】未配置 API Key',
      }),
    }
  }

  const url = `${upstream.baseUrl}/chat/completions`
  const timeoutMs = input.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const body: Record<string, unknown> = {
      model: upstream.chatModel,
      temperature: input.temperature ?? 0.3,
      thinking: { type: input.thinking ? 'enabled' : 'disabled' },
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
    }
    if (typeof input.maxTokens === 'number' && input.maxTokens > 0) {
      body.max_tokens = input.maxTokens
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${upstream.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const errText = await res.text()
      return {
        ok: false,
        usedMock: false,
        error: `LLM HTTP ${res.status}: ${errText.slice(0, 240)}`,
      }
    }
    const data: unknown = await res.json()
    if (
      typeof data !== 'object' ||
      data === null ||
      !Array.isArray((data as { choices?: unknown }).choices)
    ) {
      return { ok: false, usedMock: false, error: 'LLM 响应格式异常' }
    }
    const choices = (data as { choices: unknown[] }).choices
    const first = choices[0]
    let content = ''
    if (typeof first === 'object' && first !== null) {
      const msg = (first as { message?: unknown }).message
      if (
        typeof msg === 'object' &&
        msg !== null &&
        typeof (msg as { content?: unknown }).content === 'string'
      ) {
        content = (msg as { content: string }).content
      }
    }
    return { ok: true, usedMock: false, content }
  } catch (e) {
    const name = e instanceof Error ? e.name : ''
    const msg = e instanceof Error ? e.message : String(e)
    if (name === 'AbortError' || /aborted/i.test(msg)) {
      return {
        ok: false,
        usedMock: false,
        error: `上游 LLM 超时（>${Math.round(timeoutMs / 1000)}s）`,
      }
    }
    return {
      ok: false,
      usedMock: false,
      error: `上游 LLM: ${msg}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

export function stripJsonFence(raw: string): string {
  const t = raw.trim()
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
  return m ? m[1].trim() : t
}

export function tryParseJsonObject(
  raw: string,
): Record<string, unknown> | null {
  try {
    const v = JSON.parse(stripJsonFence(raw)) as unknown
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
  } catch {
    /* ignore */
  }
  return null
}
