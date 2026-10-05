/**
 * A1 KEY+T → DeepSeek-V4-Flash — select doors and cast brief tags.
 * Successful briefs are hung on bookKey via KeyDecisionState（briefKey = settle 实例）.
 */

import { demoAuthHeaders } from './demoAuth'
import { llmThinkingField } from './llmThinking'
import {
  loadDualModelConfig,
  reasonEndpointReady,
  LOCKED_LLM,
} from './modelRuntimeConfig'
import type { BookIndex } from './pipelineA'
import { a1DsPromptRules, collectA1DsRows, normalizeBriefTag, type A1DsRow } from './a1DsExport'
import {
  PEEK_BRIEF_INSTRUCTION,
  PEEK_HOT_INSTRUCTION_SUFFIX,
  PEEK_USER_ASIDE_HINT,
} from './peekInstruction'
import { rollDoorBrief, type PeekHangMode } from './keyDecisionState'
import {
  normalizeIncrementStatus,
  type IncrementReadStatus,
} from './keyIncrementStatus'
import { statusAllowsMint } from './settleMint'
import { docHasAnyBrief } from './masterTableMap'
import {
  chunkKeys,
  runBatchesParallel,
} from '../arch/parallelLlmBatch'

export type A1DsItem = {
  /** bookKey（A1 门牌） */
  key: string
  /** 门贴正文 */
  brief: string
  /** 为何与 Q 相关 */
  rationale: string
  /** 落账后的 briefKey（settle 实例） */
  briefKey?: string
  /** 输入 key 三态；仅充分才铸 briefKey */
  status?: IncrementReadStatus | null
}

function extractJsonText(raw: string): string {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence?.[1] ?? trimmed).trim()
  const objStart = body.indexOf('{')
  if (objStart < 0) return body
  const objEnd = body.lastIndexOf('}')
  if (objEnd > objStart) return body.slice(objStart, objEnd + 1)
  return body.slice(objStart)
}

function parseJsonBody(raw: string): unknown {
  return JSON.parse(extractJsonText(raw))
}

/** 尾巴缺引号 / 截断时：截到最后一个完整的 `}` 再补 `]}` 或 `}` */
function tryParseRepaired(raw: string): unknown | null {
  const text = extractJsonText(raw)
  try {
    return JSON.parse(text)
  } catch {
    /* continue */
  }
  // 在 briefs 数组里，保留到最后一个完整对象
  const arrKey = text.indexOf('"briefs"')
  if (arrKey < 0) return null
  const arrStart = text.indexOf('[', arrKey)
  if (arrStart < 0) return null
  let depth = 0
  let lastComplete = -1
  let inStr = false
  let esc = false
  for (let i = arrStart; i < text.length; i++) {
    const c = text[i]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) lastComplete = i
    } else if (c === ']' && depth === 0) {
      break
    }
  }
  if (lastComplete < 0) return null
  const head = text.slice(0, arrStart + 1)
  const objs = text.slice(arrStart + 1, lastComplete + 1)
  const repaired = `${head}${objs}]}`
  try {
    return JSON.parse(repaired)
  } catch {
    try {
      return JSON.parse(`${repaired.slice(0, -1)},"answer":""}`)
    } catch {
      return null
    }
  }
}

/** 正则捞完整的 key+brief 对（坏 JSON 时的兜底） */
function salvageBriefSlotsFromText(
  raw: string,
  allowed: ReadonlySet<string>,
): A1DsItem[] {
  const items: A1DsItem[] = []
  const re =
    /"key"\s*:\s*"(h1\.[^"]+)"\s*,\s*"brief"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"rationale"\s*:\s*"((?:[^"\\]|\\.)*)")?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]!
    if (!allowed.has(key)) continue
    const brief = normalizeBriefTag(
      m[2]!.replace(/\\"/g, '"').replace(/\\n/g, '\n'),
    )
    if (!brief) continue
    items.push({
      key,
      brief,
      rationale: (m[3] ?? '').replace(/\\"/g, '"').trim(),
    })
  }
  return items
}

function pushPeekSlots(
  items: A1DsItem[],
  input: {
    key: string
    brief: string
    rationale?: string
    status?: IncrementReadStatus | null
  },
) {
  if (!input.key || !input.brief.trim()) return
  items.push({
    key: input.key,
    brief: input.brief.trim(),
    rationale: input.rationale?.trim() || '',
    status: input.status ?? null,
  })
}

/**
 * peek 主协议：briefs[]。
 * - 一元素一槽：{ key, brief }
 * - 同门多贴：多条同 key，或一行 { key, briefs:["贴A","贴B"] } 展开成多槽
 * items[] 已废除，不再解析。
 */
function collectBriefSlotsFromParsed(
  parsed: {
    briefs?: unknown
    answer?: unknown
    rationale?: unknown
  },
  allowed: ReadonlySet<string>,
): { items: A1DsItem[]; answer: string } {
  const items: A1DsItem[] = []

  const ingestRow = (r: Record<string, unknown>) => {
    const key = String(r.key ?? r.bookKey ?? '').trim()
    if (!key || !allowed.has(key)) return
    const rowStatus = normalizeIncrementStatus(r.status ?? r.readStatus)
    const rationale =
      typeof r.rationale === 'string' ? r.rationale.trim() : ''

    // 同门多贴：briefs:["贴A","贴B"] → 每元素独立槽
    const many = Array.isArray(r.briefs) ? r.briefs : null
    if (many && many.length > 0) {
      for (const b of many) {
        if (typeof b === 'string') {
          pushPeekSlots(items, {
            key,
            brief: normalizeBriefTag(b),
            rationale,
            status: rowStatus,
          })
        } else if (b && typeof b === 'object') {
          const br = b as Record<string, unknown>
          pushPeekSlots(items, {
            key,
            brief: normalizeBriefTag(String(br.brief ?? br.text ?? '')),
            rationale:
              typeof br.rationale === 'string'
                ? br.rationale.trim()
                : rationale,
            status:
              normalizeIncrementStatus(br.status ?? br.readStatus) ??
              rowStatus,
          })
        }
      }
      return
    }

    const brief =
      typeof r.brief === 'string' ? normalizeBriefTag(r.brief) : ''
    if (!brief) return
    pushPeekSlots(items, {
      key,
      brief,
      rationale,
      status: rowStatus,
    })
  }

  if (Array.isArray(parsed.briefs)) {
    for (const row of parsed.briefs) {
      if (!row || typeof row !== 'object') continue
      ingestRow(row as Record<string, unknown>)
    }
  }

  const answer =
    typeof parsed.answer === 'string'
      ? parsed.answer.trim()
      : typeof parsed.rationale === 'string'
        ? parsed.rationale.trim()
        : ''
  return { items, answer }
}

function parseFlashResponse(
  raw: string,
  allowed: ReadonlySet<string>,
): { items: A1DsItem[]; answer: string; recovered: boolean } {
  try {
    const parsed = parseJsonBody(raw) as {
      briefs?: unknown
      answer?: unknown
      rationale?: unknown
    }
    const got = collectBriefSlotsFromParsed(parsed, allowed)
    if (got.items.length > 0) {
      return { ...got, recovered: false }
    }
  } catch {
    /* fall through */
  }

  const repaired = tryParseRepaired(raw)
  if (repaired && typeof repaired === 'object') {
    const got = collectBriefSlotsFromParsed(
      repaired as { briefs?: unknown; answer?: unknown; rationale?: unknown },
      allowed,
    )
    if (got.items.length > 0) {
      return {
        items: got.items,
        answer: got.answer || '（JSON 已修复截断后解析）',
        recovered: true,
      }
    }
  }

  const salvaged = salvageBriefSlotsFromText(raw, allowed)
  if (salvaged.length > 0) {
    return {
      items: salvaged,
      answer: '（从破损 JSON 中捞回完整 key+brief）',
      recovered: true,
    }
  }

  return { items: [], answer: raw.trim(), recovered: false }
}

/** 写信台 peek 落账：一槽一 briefKey；同 bookKey 多槽不合并；仅充分才铸 */
export function settlePeekItemsFromLlm(input: {
  docId: string
  llmText: string
  allowedBookKeys: ReadonlyArray<string>
  /** 同一次 peek 母族；缺省本函数内现铸一次 */
  peekFamilyId?: string
  hangMode?: PeekHangMode
}): { items: A1DsItem[]; note: string; skipped: number } {
  const allowed = new Set(input.allowedBookKeys)
  const parsed = parseFlashResponse(input.llmText, allowed)
  const peekFamilyId =
    input.peekFamilyId?.trim() ||
    `desk_peek_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const hangMode = input.hangMode ?? 'revise'
  const hung: A1DsItem[] = []
  let skipped = 0
  let blocked = 0
  for (const it of parsed.items) {
    if (!statusAllowsMint(it.status)) {
      skipped++
      continue
    }
    const rolled = rollDoorBrief({
      docId: input.docId,
      key: it.key,
      decisionBrief: it.brief,
      suggestAction: 'open',
      peekFamilyId,
      taskId: peekFamilyId,
      hangMode,
    })
    if (!rolled.ok) {
      blocked++
      continue
    }
    hung.push({ ...it, briefKey: rolled.entry.briefKey })
  }
  return {
    items: hung,
    skipped: skipped + blocked,
    note:
      hung.length > 0
        ? `peek 落账 briefKey×${hung.length}` +
          (skipped ? ` · 非充分跳过×${skipped}` : '') +
          (blocked ? ` · 异族/重复挡×${blocked}` : '') +
          (parsed.recovered ? ' · 已修复JSON' : '')
        : skipped + blocked > 0
          ? `peek 无充分槽（跳过×${skipped} · 挡×${blocked}）`
          : 'peek 无有效输出槽',
  }
}

async function flashChat(input: {
  system: string
  user: string
  temperature?: number
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
      return { ok: false, note: 'LLM 已取消（早停）' }
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: reason.model || LOCKED_LLM.chatModel,
        temperature: input.temperature ?? 0,
        // peek = 填槽铸贴，不开 reasoning
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
    const choices = (data as { choices: Array<{ message?: { content?: string } }> })
      .choices
    const content = choices[0]?.message?.content
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
        ? 'LLM 已取消（早停）'
        : e instanceof Error
          ? e.message
          : 'LLM 请求失败',
    }
  }
}

function compactTable(rows: A1DsRow[]): string {
  return rows
    .map((r) => `KEY: \`${r.key}\`\nT:\n${r.T}\n`)
    .join('\n')
}

export type A1DsAskResult = {
  ok: boolean
  keys: string[]
  items: A1DsItem[]
  answer: string
  note: string
  packsScanned: number
}

/** One Flash call: A1 KEY+T → briefs[{key, brief|briefs[]}]；一槽一 briefKey。 */
export async function askDeepSeekWithA1(input: {
  question: string
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
  /** 缺省=冷启整表；热启传 seedRange 展开后的 bookKey */
  candidateKeys?: string[]
  /** cold=整表点名；hot=书序区间扩搜 */
  peekMode?: 'cold' | 'hot'
  /** 热启：已开门牌（有 head）— 禁止当处女 create，仅缺口才列入 */
  openedKeys?: string[]
  /** 本问 queryKey：peek 三态挂问线 */
  queryKey?: string
  /**
   * 是否附用户原话旁注。
   * 缺省：热启 / 已有 brief（第二次+ peek）→ true；纯冷启第一次 → false。
   */
  attachUserUtterance?: boolean
}): Promise<A1DsAskResult> {
  const peekInstruction = PEEK_BRIEF_INSTRUCTION
  const qSide = input.question.trim()
  if (!peekInstruction) {
    return {
      ok: false,
      keys: [],
      items: [],
      answer: '',
      note: 'peek 指令缺失',
      packsScanned: 0,
    }
  }

  const peekMode =
    input.peekMode ?? (input.candidateKeys?.length ? 'hot' : 'cold')

  // 仅热启且未显式传窗时：用强调笔∩layout 的 bookKey（冷启整表不受影响）
  let resolvedCandidates = input.candidateKeys
  if (peekMode === 'hot' && !resolvedCandidates?.length) {
    try {
      const { usePageMarkStore } = await import('./pageMarkStore')
      const hit = usePageMarkStore.getState()
      if (
        hit.lastHitDocId === input.bookIndex.docId &&
        hit.lastHitBookKeys.length > 0
      ) {
        resolvedCandidates = hit.lastHitBookKeys
        input.onProgress?.(
          `peek · 热启用强调∩layout bookKey×${resolvedCandidates.length}`,
        )
      }
    } catch {
      /* optional */
    }
  }

  // 第二次+ peek：热启、或库内已有 brief、或调用方显式要求
  const attachUser =
    input.attachUserUtterance ??
    (peekMode === 'hot' ||
      (input.openedKeys?.length ?? 0) > 0 ||
      docHasAnyBrief(input.bookIndex.docId))
  const onlyKeys =
    resolvedCandidates && resolvedCandidates.length > 0
      ? new Set(resolvedCandidates)
      : undefined
  const preferFirst =
    peekMode === 'hot' && resolvedCandidates?.length
      ? resolvedCandidates
      : undefined

  const rows = collectA1DsRows(input.bookIndex, {
    maxTextChars: 800,
    retrievableOnly: true,
    onlyKeys,
    preferKeysFirst: preferFirst,
  })
  if (rows.length === 0) {
    return {
      ok: false,
      keys: [],
      items: [],
      answer: '',
      note: onlyKeys
        ? `${peekMode === 'hot' ? '热启' : '冷启'} peek：候选门牌区间无可铸`
        : 'A1 为空（请先上传并建库）',
      packsScanned: 0,
    }
  }

  const opened = new Set(input.openedKeys ?? [])

  /** 冷启：多 KEY/批 + 多批真并行；骨架批全部跑完（peek 前置，不因 brief 数早停） */
  const COLD_BATCH = 36
  const COLD_CONCURRENCY = 3
  const uniqueRows = (() => {
    const seen = new Set<string>()
    const out: A1DsRow[] = []
    for (const r of rows) {
      const k = r.key.trim()
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(r)
    }
    return out
  })()
  const batches: A1DsRow[][] =
    peekMode === 'cold' && uniqueRows.length > COLD_BATCH
      ? chunkKeys(uniqueRows, COLD_BATCH)
      : [uniqueRows]

  input.onProgress?.(
    peekMode === 'hot'
      ? `DeepSeek Flash · 热启 peek（书序 N=${uniqueRows.length}）→ 铸门贴…`
      : batches.length > 1
        ? `DeepSeek Flash · 冷启并行 peek（${uniqueRows.length} 行 → ${batches.length} 批×≤${COLD_BATCH} · 并发 ${COLD_CONCURRENCY}）…`
        : `DeepSeek Flash 读取整表 A1（${uniqueRows.length} 行 KEY+T）→ 铸门贴…`,
  )

  type BatchPeekResult = {
    bi: number
    ok: boolean
    note?: string
    items: A1DsItem[]
    skipped: number
    recovered: boolean
    answer: string
    refused: boolean
  }

  const runOneBatch = async (
    bi: number,
    signal: AbortSignal,
  ): Promise<BatchPeekResult> => {
    const batch = batches[bi]!
    const allowedBatch = new Set(batch.map((r) => r.key))

    // 本批入窗 bookKey → 与本批 peek LLM 并行物化页图（不等结算）
    void import('./prefetchBookPages').then(({ prefetchPagesForBookKeys }) => {
      void prefetchPagesForBookKeys({
        bookKeys: batch.map((r) => r.key),
        bookIndex: input.bookIndex,
        onProgress: input.onProgress,
      })
    })

    const system = [
      a1DsPromptRules(),
      peekInstruction,
      peekMode === 'hot'
        ? PEEK_HOT_INSTRUCTION_SUFFIX
        : '【冷启】从本批书序 KEY+T 点名勾门铸贴；KEY 须原样复制。',
      batches.length > 1
        ? `【并行分批 ${bi + 1}/${batches.length}】本消息只有本批 ${batch.length} 行书序连续 KEY+T（全书共 ${uniqueRows.length} 行，其它批由台并行另调）。只从本批 KEY 勾选并铸 brief；禁止空 briefs；禁止要求「请分批输入」。`
        : '',
      attachUser
        ? '【二次+ peek】可参考用户原话旁注理解修贴意图；brief 仍只从 T 提炼。'
        : '【第一次冷启】不要依赖用户问题；只按固定指令从 T 铸贴。',
      opened.size > 0 && peekMode === 'hot'
        ? `已开门牌（有 head）：${[...opened].slice(0, 12).join(', ')}${opened.size > 12 ? '…' : ''} —— 禁止当处女再 create；仅缺口才输出新 brief。`
        : '',
      '只输出 JSON（可包在 ```json 里），不要散文。',
    ]
      .filter(Boolean)
      .join('\n')

    const user = [
      `【peek 指令】\n${peekInstruction}`,
      attachUser && qSide ? `${PEEK_USER_ASIDE_HINT}\n${qSide}` : '',
      '',
      peekMode === 'hot'
        ? `【A1 书序区间 · ${batch.length} 行 · 仅 KEY+T】`
        : batches.length > 1
          ? `【A1 冷启批 ${bi + 1}/${batches.length} · 书序连续 ${batch.length} 行 · 仅 KEY+T】`
          : `【A1 整表 · ${batch.length} 行 · 仅 KEY+T】`,
      compactTable(batch),
    ]
      .filter(Boolean)
      .join('\n')

    const chat = await flashChat({ system, user, temperature: 0.1, signal })
    if (!chat.ok) {
      return {
        bi,
        ok: false,
        note: chat.note,
        items: [],
        skipped: 0,
        recovered: false,
        answer: '',
        refused: false,
      }
    }

    const parsed = parseFlashResponse(chat.content, allowedBatch)
    const refused =
      parsed.items.length === 0 &&
      /分批|无法.*铸|随机.*bookKey|校验.*bookKey/i.test(parsed.answer || '')

    const { deskMonitorAttentionArrival } = await import('./attentionArrival')
    deskMonitorAttentionArrival({
      job: 'peek',
      llmText: chat.content,
      windowKeys: [...allowedBatch],
      queryKey: input.queryKey,
    })

    const peekFamilyId = `a1chat_${peekMode}_${Date.now().toString(36)}_${bi}_${Math.random().toString(36).slice(2, 6)}`
    const hangMode = peekMode === 'hot' ? 'revise' : 'sibling'

    const items: A1DsItem[] = []
    let skipped = 0
    for (const it of parsed.items) {
      if (!statusAllowsMint(it.status)) {
        skipped++
        continue
      }
      const rolled = rollDoorBrief({
        docId: input.bookIndex.docId,
        key: it.key,
        decisionBrief: it.brief,
        suggestAction: 'open',
        peekFamilyId,
        taskId: peekFamilyId,
        hangMode,
      })
      if (!rolled.ok) {
        skipped++
        continue
      }
      items.push({ ...it, briefKey: rolled.entry.briefKey })
    }

    return {
      bi,
      ok: true,
      items,
      skipped,
      recovered: Boolean(parsed.recovered),
      answer: parsed.answer || '',
      refused,
    }
  }

  /** 真并行扫完入窗 KEY；peek 不作 decide 式「够了就停」 */
  const hung: A1DsItem[] = []
  let skipped = 0
  let recoveredAny = false
  let lastAnswer = ''
  let firstFailNote = ''

  if (batches.length > 1) {
    input.onProgress?.(
      `冷启 peek · 真并行 ${batches.length} 批 · 并发≤${COLD_CONCURRENCY}（扫完骨架，不早停）…`,
    )
  }

  const parallel = await runBatchesParallel({
    batches: batches.map((_, bi) => bi),
    concurrency: COLD_CONCURRENCY,
    run: (bi, _index, signal) => runOneBatch(bi, signal),
  })

  const waveResults = parallel.results
    .filter(
      (
        r,
      ): r is {
        index: number
        ok: true
        value: BatchPeekResult
      } => Boolean(r && r.ok),
    )
    .map((r) => r.value)
    .sort((a, b) => a.bi - b.bi)

  const packsScanned =
    parallel.results.filter((r) => r && (r.ok || !r.aborted)).length

  for (const r of waveResults) {
    if (!r.ok) {
      if (!firstFailNote && r.note) firstFailNote = r.note
      continue
    }
    if (r.recovered) recoveredAny = true
    if (r.answer) lastAnswer = r.answer
    skipped += r.skipped
    for (const it of r.items) {
      // 跨批仅去重同门同贴；同门多贴保留
      if (hung.some((h) => h.key === it.key && h.brief === it.brief)) continue
      hung.push(it)
    }
    if (r.refused) {
      input.onProgress?.(
        `冷启 peek · 批 ${r.bi + 1} 拒铸（已并行续其它批）`,
      )
    }
  }

  for (const r of parallel.results) {
    if (r && !r.ok && !r.aborted && r.note && !firstFailNote) {
      firstFailNote = r.note
    }
  }

  if (hung.length === 0 && firstFailNote && packsScanned > 0) {
    return {
      ok: false,
      keys: [],
      items: [],
      answer: '',
      note: firstFailNote,
      packsScanned,
    }
  }

  const keys = hung.map((h) => h.key)
  const note =
    hung.length > 0
      ? `${recoveredAny ? '已从破损 JSON 捞回 · ' : ''}${peekMode === 'hot' ? '热启' : '冷启'}已铸 ${hung.length} 条门贴并挂靠 bookKey` +
        (skipped ? ` · 非充分跳过×${skipped}` : '') +
        ` · 表 ${uniqueRows.length} 行 · 并行扫 ${packsScanned}/${batches.length} 批`
      : `未得到充分 brief · ${peekMode === 'hot' ? '热启区间' : '整表'} ${uniqueRows.length} 行 · 并行扫 ${packsScanned}/${batches.length} 批` +
        (skipped ? ` · 非充分跳过×${skipped}` : '') +
        (lastAnswer ? ` · 模型：${lastAnswer.slice(0, 80)}` : '')

  return {
    ok: true,
    keys,
    items: hung,
    answer:
      lastAnswer ||
      (hung.length
        ? hung.map((h) => `${h.key.slice(0, 24)}…：${h.brief}`).join('\n')
        : '（无门贴）'),
    note,
    packsScanned,
  }
}

/**
 * 写信台投递：薄指令 → 台按 job 契约 expand/fetch 组窗 → LLM。
 * 正文不在确认包里预打包。
 */
export async function askDeepSeekWithLetterDesk(input: {
  question: string
  packages: import('./attentionIoStore').LetterDeskPackage[]
  bookIndex: BookIndex
  docId: string
  /** 本轮 queryKey（方案 B）；自动流传入以免重复铸 */
  turnQueryKey?: string
  onProgress?: (msg: string) => void
  /** 并行早停：取消未完成的 LLM fetch */
  signal?: AbortSignal
}): Promise<{ ok: boolean; answer: string; note: string }> {
  if (!input.packages.length) {
    return {
      ok: false,
      answer: '',
      note: '写信台为空：请在 Δ 上「注意力切换」并确认递交',
    }
  }
  const { dispatchLetterDesk } = await import('./letterDeskDispatch')
  return dispatchLetterDesk({
    docId: input.docId,
    bookIndex: input.bookIndex,
    packages: input.packages,
    dispatcherNote: input.question,
    turnQueryKey: input.turnQueryKey,
    onProgress: input.onProgress,
    signal: input.signal,
  })
}
