/**
 * 残文补缺 S₁ · 默写 LLM（协议锁定）
 * docs/book-noun-pipeline-protocol-2026-09-14.md §3
 *
 * 流水线：
 *   BEFORE  制 R → 分批 R_batch（无门牌/坐标）
 *   PROMPT  system + user（见下方常量）
 *   LLM     /api/llm chat/completions
 *   AFTER   本批子串硬闸 → 整串去重 → 掩串二轮 → S₁ Draft → 并集 Draft → S（建表结束，不 locate）
 */

import { demoAuthHeaders } from '../reasoning/demoAuth'
import { extractJsonObject } from '../reasoning/inferPath'
import { llmThinkingField } from '../reasoning/llmThinking'
import {
  loadDualModelConfig,
  reasonEndpointReady,
  LOCKED_LLM,
} from '../reasoning/modelRuntimeConfig'
import type { BookIndex } from '../reasoning/pipelineA'
import {
  type BookNounDraft,
  type BookNounIndex,
  type ResidualBatch,
  buildResidualPlainTexts,
  buildS1BatchesByS0Gaps,
  collectPlainTexts,
  dedupeNounDrafts,
  extractS0FromPlainTexts,
  maskSurfacesInText,
  nounCanonical,
  surfacesToDrafts,
} from './bookNounIndex'
import { runBatchesParallel } from './parallelLlmBatch'

// ─────────────────────────────────────────────
// PROMPT（补缺默写 · 完整提示词）
// ─────────────────────────────────────────────

export const S1_DICTATION_SYSTEM = [
  '【发明权】你只能从用户给出的【本批残文】中抄写连续原文片段；禁止造词、禁止翻译、禁止近义改写、禁止补全残缺词。',
  '【任务】残文中已用实心块「█」盖住规则表 S₀ 已收录的词。请找出仍可能漏网的专名 / 名词 / 名词短语，原样抄出。',
  '【输出】仅 JSON（可包在 ```json 中）：{"nouns":["原文片段", "..."]}',
].join('\n')

export function buildS1DictationUserPrompt(input: {
  batchId: string
  residualText: string
  round: number
}): string {
  const roundNote =
    input.round <= 1
      ? '本轮：首轮默写补缺。'
      : `本轮：第 ${input.round} 轮（已掩去上轮收卷串后的剩余残文）。`
  return [
    `batchId: ${input.batchId}`,
    roundNote,
    '',
    '【本批残文 · 开始】',
    input.residualText,
    '【本批残文 · 结束】',
    '',
    '请只输出 JSON：{"nouns":["..."]}',
  ].join('\n')
}

// ─────────────────────────────────────────────
// LLM 调用
// ─────────────────────────────────────────────

async function flashChat(input: {
  system: string
  user: string
  signal?: AbortSignal
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
    if (input.signal?.aborted) {
      return { ok: false, note: 'LLM 已取消' }
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: reason.model || LOCKED_LLM.chatModel,
        temperature: 0,
        max_tokens: 4096,
        ...llmThinkingField('disabled'),
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
      }),
      signal: input.signal,
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
    const aborted =
      input.signal?.aborted ||
      (e instanceof Error &&
        (e.name === 'AbortError' || /abort/i.test(e.message)))
    return {
      ok: false,
      note: aborted
        ? 'LLM 已取消'
        : e instanceof Error
          ? e.message
          : 'LLM 请求失败',
    }
  }
}

// ─────────────────────────────────────────────
// AFTER：解析 → 本批子串硬闸 → 剔噪 → 整串 ignore-case 去重（禁止最长串吞并）
// ─────────────────────────────────────────────

export type S1Reject = {
  raw: string
  reason: 'empty' | 'not_substring' | 'noise'
}

const NOISE_EXACT = new Set(
  ['the', 'and', 'dans', 'les', 'des', '如何', '什么', '是否', '提到'].map((s) =>
    s.toLowerCase(),
  ),
)

export function parseS1NounsFromLlm(raw: string): string[] {
  const obj = extractJsonObject(raw)
  if (!obj) return []
  const arr = Array.isArray(obj.nouns) ? obj.nouns : []
  const out: string[] = []
  for (const x of arr) {
    if (typeof x === 'string' && x.trim()) out.push(x.trim())
  }
  return out
}

/**
 * 硬闸：必须是本批 residualText 的连续子串（先敏感匹配；失败再 ignore-case 找回原文切片）。
 * 回配作用域 = 本召输入，禁止调用方传入全书其它批文本。
 */
export function gateNounsAgainstBatchText(
  candidates: string[],
  batchText: string,
): { accepted: string[]; rejected: S1Reject[] } {
  const accepted: string[] = []
  const rejected: S1Reject[] = []

  for (const raw of candidates) {
    const w = raw.replace(/\s+/g, ' ').trim()
    if (!w) {
      rejected.push({ raw, reason: 'empty' })
      continue
    }
    if (NOISE_EXACT.has(w.toLowerCase()) || w.length < 2) {
      rejected.push({ raw: w, reason: 'noise' })
      continue
    }
    if (/^[\d\W_█]+$/.test(w) || /^█+$/.test(w) || w.includes('█')) {
      rejected.push({ raw: w, reason: 'noise' })
      continue
    }

    let grounded: string | null = null
    const exactAt = batchText.indexOf(w)
    if (exactAt >= 0) {
      grounded = batchText.slice(exactAt, exactAt + w.length)
    } else {
      const lowerHay = batchText.toLowerCase()
      const lowerNeedle = w.toLowerCase()
      const at = lowerHay.indexOf(lowerNeedle)
      if (at >= 0) {
        grounded = batchText.slice(at, at + w.length)
      }
    }
    if (!grounded) {
      rejected.push({ raw: w, reason: 'not_substring' })
      continue
    }
    // 拒绝含掩码的「命中」（跨 █ 抄出的半截短语）
    if (grounded.includes('█') || !grounded.replace(/█/g, '').trim()) {
      rejected.push({ raw: w, reason: 'noise' })
      continue
    }
    accepted.push(grounded)
  }

  return {
    accepted: dedupeSurfacesIgnoreCase(accepted),
    rejected,
  }
}

/** ignore-case 整串去重，保留先出现的展示形。禁止子串吞并（Lacan ⊄ Jacques Lacan）。 */
export function dedupeSurfacesIgnoreCase(surfaces: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of surfaces) {
    const c = nounCanonical(s)
    if (!c || seen.has(c)) continue
    seen.add(c)
    out.push(s)
  }
  return out
}

function surfacesToS1Drafts(surfaces: string[]): BookNounDraft[] {
  return surfacesToDrafts(surfaces)
}

// ─────────────────────────────────────────────
// 单批：BEFORE 已备好 batch → LLM → AFTER（含掩串二轮）
// ─────────────────────────────────────────────

export type S1BatchRoundAudit = {
  round: number
  residualChars: number
  rawLlm: string
  parsed: string[]
  accepted: string[]
  rejected: S1Reject[]
  note: string
}

export type S1BatchResult = {
  batchId: string
  surfaces: string[]
  rounds: S1BatchRoundAudit[]
  note: string
}

async function runOneDictationRound(input: {
  batchId: string
  residualText: string
  round: number
  signal?: AbortSignal
}): Promise<{
  raw: string
  parsed: string[]
  note: string
  ok: boolean
}> {
  const user = buildS1DictationUserPrompt({
    batchId: input.batchId,
    residualText: input.residualText,
    round: input.round,
  })
  let chat = await flashChat({
    system: S1_DICTATION_SYSTEM,
    user,
    signal: input.signal,
  })
  // JSON / 空：整批重试一次
  if (!chat.ok) {
    return { raw: '', parsed: [], note: chat.note, ok: false }
  }
  let parsed = parseS1NounsFromLlm(chat.content)
  if (parsed.length === 0 && !/\{\s*"nouns"\s*:\s*\[/.test(chat.content)) {
    const retry = await flashChat({
      system: S1_DICTATION_SYSTEM,
      user:
        user +
        '\n\n【重试】上轮输出无法解析为 {"nouns":[...]}。请只输出该 JSON。',
      signal: input.signal,
    })
    if (retry.ok) {
      chat = retry
      parsed = parseS1NounsFromLlm(retry.content)
    }
  }
  return {
    raw: chat.content,
    parsed,
    note: chat.ok ? 'ok' : 'fail',
    ok: true,
  }
}

/**
 * 单批补缺：默写 → 本批回配 → 掩串 → 至多再一轮。
 */
export async function runS1DictationOnBatch(input: {
  batch: ResidualBatch
  /** 含首轮，默认 2 */
  maxRounds?: number
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}): Promise<S1BatchResult> {
  const maxRounds = Math.max(1, input.maxRounds ?? 2)
  let residual = input.batch.text
  const allAccepted: string[] = []
  const rounds: S1BatchRoundAudit[] = []

  for (let round = 1; round <= maxRounds; round++) {
    if (!residual.replace(/█/g, '').trim()) {
      rounds.push({
        round,
        residualChars: residual.length,
        rawLlm: '',
        parsed: [],
        accepted: [],
        rejected: [],
        note: '残文已空，停止',
      })
      break
    }
    input.onProgress?.(
      `S₁ 默写 · ${input.batch.batchId} · 轮${round}/${maxRounds} · ${residual.length} 字…`,
    )
    const llm = await runOneDictationRound({
      batchId: input.batch.batchId,
      residualText: residual,
      round,
      signal: input.signal,
    })
    if (!llm.ok) {
      rounds.push({
        round,
        residualChars: residual.length,
        rawLlm: llm.raw,
        parsed: [],
        accepted: [],
        rejected: [],
        note: llm.note,
      })
      break
    }
    const gated = gateNounsAgainstBatchText(llm.parsed, residual)
    rounds.push({
      round,
      residualChars: residual.length,
      rawLlm: llm.raw,
      parsed: llm.parsed,
      accepted: gated.accepted,
      rejected: gated.rejected,
      note:
        `收×${gated.accepted.length} · 拒×${gated.rejected.length}` +
        (gated.rejected.some((r) => r.reason === 'not_substring')
          ? ' · 含乱编/非本批子串'
          : ''),
    })
    if (gated.accepted.length === 0) break
    for (const s of gated.accepted) allAccepted.push(s)
    // 掩已收串 → 下一轮残文
    residual = maskSurfacesInText(residual, gated.accepted)
  }

  const merged = dedupeSurfacesIgnoreCase(allAccepted)
  return {
    batchId: input.batch.batchId,
    surfaces: merged,
    rounds,
    note: `批 ${input.batch.batchId} · 收 text×${merged.length} · 轮次×${rounds.length}`,
  }
}

// ─────────────────────────────────────────────
// 全书入口：BEFORE 全链路 + 各批 LLM + 合成 S
// ─────────────────────────────────────────────

export type RunS1DictationResult = {
  ok: boolean
  index: BookNounIndex
  batchResults: S1BatchResult[]
  note: string
}

/**
 * BEFORE：纯 T → S₀ Draft → mask → 分批
 * LLM+AFTER：每批默写回配 → S₁ Draft
 * 并集去重（Draft）→ S（建表结束；**不 locate**）
 */
export async function runBookNounS1Dictation(input: {
  bookIndex: BookIndex
  /** 已有 S₀ Draft；否则现场规则抽 */
  s0?: BookNounDraft[]
  maxCharsPerBatch?: number
  maxRoundsPerBatch?: number
  /** S₀ 间隙批并行度，默认 3 */
  concurrency?: number
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}): Promise<RunS1DictationResult> {
  const plains = collectPlainTexts(input.bookIndex)
  if (plains.length === 0) {
    return {
      ok: false,
      index: {
        docId: input.bookIndex.docId,
        builtAt: Date.now(),
        s0: [],
        s1: [],
        S: [],
      },
      batchResults: [],
      note: '无可用原文 T（A1 空或不可检索）',
    }
  }

  const s0 = dedupeNounDrafts(
    input.s0?.length ? input.s0 : extractS0FromPlainTexts(plains),
  )
  input.onProgress?.(`S₀ Draft ×${s0.length} · 制残文…`)

  const residualPlains = buildResidualPlainTexts(plains, s0)
  /** S₀ 间隙并行；过长间隙内串联；跨 S₀ 切口 priorNouns 重叠 */
  const batches = buildS1BatchesByS0Gaps({
    plains,
    residualPlains,
    s0,
    maxChars: input.maxCharsPerBatch ?? 12_000,
    priorNouns: 2,
  })
  if (batches.length === 0) {
    return {
      ok: true,
      index: {
        docId: input.bookIndex.docId,
        builtAt: Date.now(),
        s0,
        s1: [],
        S: s0,
      },
      batchResults: [],
      note: '残文为空（S₀ 可能已盖满）· S=S₀',
    }
  }

  const concurrency = Math.max(1, input.concurrency ?? 3)
  input.onProgress?.(
    `S₁ 默写 · S₀间隙批 ×${batches.length} · 并行≤${concurrency}…`,
  )

  const parallel = await runBatchesParallel({
    batches,
    concurrency,
    signal: input.signal,
    run: (batch, _i, signal) =>
      runS1DictationOnBatch({
        batch,
        maxRounds: input.maxRoundsPerBatch ?? 2,
        signal,
        onProgress: input.onProgress,
      }),
  })

  const batchResults: S1BatchResult[] = []
  const s1Acc: BookNounDraft[] = []
  for (const r of parallel.results) {
    if (!r.ok) continue
    batchResults.push(r.value)
    s1Acc.push(...surfacesToS1Drafts(r.value.surfaces))
  }

  const s1 = dedupeNounDrafts(s1Acc)
  const S = dedupeNounDrafts([...s0, ...s1])

  const index: BookNounIndex = {
    docId: input.bookIndex.docId,
    builtAt: Date.now(),
    s0,
    s1,
    S,
  }

  return {
    ok: true,
    index,
    batchResults,
    note: `S₀×${s0.length} · S₁×${s1.length} · S×${S.length} · 批×${batchResults.length}`,
  }
}

/** 审计：导出本批将送出的完整 messages（不发网） */
export function previewS1DictationMessages(input: {
  batchId: string
  residualText: string
  round?: number
}): { system: string; user: string } {
  return {
    system: S1_DICTATION_SYSTEM,
    user: buildS1DictationUserPrompt({
      batchId: input.batchId,
      residualText: input.residualText,
      round: input.round ?? 1,
    }),
  }
}
