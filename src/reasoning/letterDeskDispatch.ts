/**
 * 写信台调度：lookup(job) → 契约导向 expand → fetch → 组窗 → LLM。
 * 薄指令只含门牌；正文仅在 fetch 时从 MasterTable/A1 展开。
 */

import type { BookIndex } from './pipelineA'
import { atomSearchText } from './hybridRetrieve'
import type { DeskJob, LetterDeskPackage } from './attentionIoStore'
import { useAttentionIo } from './attentionIoStore'
import { lookupContract } from './letterDeskContracts'
import {
  doorHasBrief,
  docHasAnyBrief,
  listBriefVersionsOnDoor,
  mapBookToHeadBrief,
  mapBriefToBook,
} from './masterTableMap'
import { demoAuthHeaders } from './demoAuth'
import {
  loadDualModelConfig,
  reasonEndpointReady,
} from './modelRuntimeConfig'
import {
  extractJsonObject,
  fallbackInferPaths,
  parseInferPaths,
  parseQueryNeighbours,
  parsePathValidityJudgments,
} from './inferPath'
import { useIndexGate } from './indexGate'
import { settlePeekItemsFromLlm } from './a1DsChat'
import type { InferEdge } from './attentionIoStore'
import { LOCKED_LLM } from './modelRuntimeConfig'
import {
  historicQueryKeysWithNorms,
  listHistoricQueryEntriesForNeighbour,
  expandHistoricQueryKey,
} from './deskEntryGate'
import {
  formatDirectedPathIncrementReturn,
  hopsFromAnswerParts,
  notesIndicatePathSettled,
} from './pathIncrementReturn'
import {
  keyStatusContractHint,
  unreadForceCommitInstruction,
} from './keyIncrementStatus'
import { ingestKeyIncrementStatuses } from './attentionArrival'
import {
  buildWindowAliasTable,
  displayWindowAlias,
  expandDoorplatesInLlmText,
  formatDeskMaterialSlot,
  resolveWindowDoorplate,
  windowAliasContractHint,
  type WindowAliasTable,
} from '../arch/windowAlias'
import { qCoreNeedles, textHitsQCore } from '../arch/qCoreBookHits'
import { newLlmCallId } from './settleMint'
import { useLlmIoStream, parseLlmUsage, addLlmUsage, type LlmTokenUsage } from './llmIoStreamStore'

export interface ThinSeed {
  bookKey?: string
  briefKey?: string
  question: string
  job: DeskJob
  versionIndex?: number
  /** decide 续滚：只展这些 briefKey */
  onlyBriefKeys?: string[]
  /** infer：只展这些 bookKey（与 autoFlow mintable 对准） */
  onlyBookKeys?: string[]
  /** 监督预测轨 → decide 策略提示 */
  decideCritiqueHint?: string
  /** reframe：拒铸与这些坏 prospect 正文同构的输出 */
  avoidProspectTexts?: string[]
}

export interface ExpandedKey {
  kind: 'briefKey' | 'bookKey' | 'queryKey'
  key: string
  /** peek 已开：对照贴 */
  parentBriefKey?: string
  parentBrief?: string
  opened?: boolean
  /** query 窗：历史 Q 文 */
  qText?: string
  /** query 窗：题族角色 */
  familyRole?: 'root' | 'deepen'
  parentQueryKey?: string
}

export interface AssembledWindow {
  job: DeskJob
  contractIn: string
  contractOut: string
  /** 给 LLM 的用户包（已按契约组好） */
  userPayload: string
  systemPayload: string
  note: string
  /**
   * decide/infer/peek 窗内 bookKey → ⟦n⟧ 槽表。
   * 落账前须用此表展开 LLM 回传；query/supervise 为空表。
   */
  aliasTable: WindowAliasTable
}

/** 供 reuseGate 等模块复用（动态 import，避免环依赖） */
export function flashChat(input: {
  system: string
  user: string
  temperature?: number
  maxTokens?: number
  retryOnEmpty?: boolean
  /** 仅 decide/infer 开；默认关（DeepSeek V4 否则默认狂烧 reasoning） */
  thinking?: boolean
  /** 写信台早停：取消未完成的 fetch（非暂停/续跑） */
  signal?: AbortSignal
  /** 实验信息流：落账 system/user/output */
  ioMeta?: {
    job: string
    stage?: string
    queryKey?: string
    llmCallId?: string
  }
}): Promise<
  | { ok: true; content: string; finishReason: string; usage?: LlmTokenUsage }
  | { ok: false; note: string; usage?: LlmTokenUsage }
> {
  // deferred — use shared helper via dynamic path to avoid circular import weight
  return flashChatImpl(input)
}

async function flashChatImpl(input: {
  system: string
  user: string
  temperature?: number
  maxTokens?: number
  /** 空内容时再打一次（主推理偶发） */
  retryOnEmpty?: boolean
  thinking?: boolean
  signal?: AbortSignal
  ioMeta?: {
    job: string
    stage?: string
    queryKey?: string
    llmCallId?: string
  }
}): Promise<
  | { ok: true; content: string; finishReason: string; usage?: LlmTokenUsage }
  | { ok: false; note: string; usage?: LlmTokenUsage }
> {
  const { reason } = loadDualModelConfig()
  if (!reasonEndpointReady(reason)) {
    const fail = { ok: false as const, note: '推理槽未配置（/api/llm）' }
    useLlmIoStream.getState().pushLlmIo({
      job: input.ioMeta?.job || 'unknown',
      stage: input.ioMeta?.stage || 'flash',
      queryKey: input.ioMeta?.queryKey,
      llmCallId: input.ioMeta?.llmCallId,
      ok: false,
      note: fail.note,
      system: input.system,
      user: input.user,
      output: '',
    })
    return fail
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
  const { llmThinkingField } = await import('./llmThinking')

  const once = async (): Promise<
    | { ok: true; content: string; finishReason: string; usage?: LlmTokenUsage }
    | { ok: false; note: string; usage?: LlmTokenUsage }
  > => {
    try {
      if (input.signal?.aborted) {
        return { ok: false, note: 'LLM 已取消（早停）' }
      }
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: reason.model || LOCKED_LLM.chatModel,
          temperature: input.temperature ?? 0.15,
          max_tokens: input.maxTokens ?? 4096,
          ...llmThinkingField(input.thinking ? 'enabled' : 'disabled'),
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
      const usage = parseLlmUsage(data)
      if (
        typeof data !== 'object' ||
        data === null ||
        !('choices' in data) ||
        !Array.isArray((data as { choices: unknown }).choices)
      ) {
        return { ok: false, note: 'LLM 响应无 choices', usage }
      }
      const choice = (
        data as {
          choices: Array<{
            finish_reason?: string
            message?: {
              content?: string | null
              reasoning_content?: string | null
              refusal?: string | null
            }
          }>
        }
      ).choices[0]
      const msg = choice?.message
      const finishReason = choice?.finish_reason ?? '?'
      const raw =
        (typeof msg?.content === 'string' && msg.content.trim()
          ? msg.content
          : null) ||
        (typeof msg?.reasoning_content === 'string' &&
        msg.reasoning_content.trim()
          ? msg.reasoning_content
          : null) ||
        (typeof msg?.refusal === 'string' && msg.refusal.trim()
          ? msg.refusal
          : null)
      if (!raw || !raw.trim()) {
        return {
          ok: false,
          note: `LLM 空内容 · finish_reason=${finishReason} · 请重试主推理或缩小材料窗`,
          usage,
        }
      }
      return { ok: true, content: raw, finishReason, usage }
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

  const record = (
    result:
      | { ok: true; content: string; finishReason: string; usage?: LlmTokenUsage }
      | { ok: false; note: string; usage?: LlmTokenUsage },
  ) => {
    useLlmIoStream.getState().pushLlmIo({
      job: input.ioMeta?.job || 'unknown',
      stage: input.ioMeta?.stage || 'flash',
      queryKey: input.ioMeta?.queryKey,
      llmCallId: input.ioMeta?.llmCallId,
      ok: result.ok,
      finishReason: result.ok ? result.finishReason : undefined,
      note: result.ok ? undefined : result.note,
      usage: result.usage,
      system: input.system,
      user: input.user,
      output: result.ok ? result.content : '',
    })
    return result
  }

  const first = await once()
  if (first.ok || !input.retryOnEmpty) return record(first)
  if (input.signal?.aborted || first.note.includes('已取消')) return record(first)
  if (!first.note.includes('空内容')) return record(first)
  const second = await once()
  const mergedUsage = addLlmUsage(first.usage, second.usage)
  if (second.ok) {
    return record({
      ...second,
      usage: mergedUsage,
    })
  }
  return record({
    ok: false,
    note: `${first.note} → 重试仍失败：${second.note}`,
    usage: mergedUsage,
  })
}

/**
 * 契约导向 expand：先 allow/forbid，再只走准许的 map 边。
 */
export function expandSeedsForJob(input: {
  docId: string
  job: DeskJob
  seeds: ThinSeed[]
  /** 本问线；缺则尝试从 seed.question 解析 */
  queryKey?: string
}): { keys: ExpandedKey[]; note: string } {
  const contract = lookupContract(input.job)
  const keys: ExpandedKey[] = []
  const seen = new Set<string>()
  const io = useAttentionIo.getState()
  const resolvedQk =
    input.queryKey?.trim() ||
    input.seeds
      .map((s) => io.findQueryKeyForQuestion(s.question ?? ''))
      .find(Boolean) ||
    undefined
  const qScope = resolvedQk ? { queryKey: resolvedQk } : undefined

  const push = (k: ExpandedKey) => {
    const id = `${k.kind}:${k.key}`
    if (seen.has(id)) return
    if (k.kind === 'briefKey' && !contract.allow.includes('briefKey')) return
    if (k.kind === 'bookKey' && !contract.allow.includes('bookKey')) return
    if (k.kind === 'queryKey' && !contract.allow.includes('queryKey')) return
    seen.add(id)
    keys.push(k)
  }

  /** 三态驱动：优先 sufficient；unread 仍可进窗；insufficient 默认不递送（除非窗内尚无足够 key） */
  const preferByStatus = (kind: 'briefKey' | 'bookKey' | 'queryKey', raw: string[]) => {
    const ready = new Set(io.listKeysReadyToDeliver(undefined, qScope))
    const unread = new Set(io.listKeysUnread(undefined, qScope))
    const need = new Set(io.listKeysNeedingMore(undefined, qScope))
    const scopedRows = qScope
      ? io.listKeyStatuses({ queryKey: qScope.queryKey })
      : io.keyIncrementStatuses
    if (scopedRows.length === 0) {
      for (const k of raw) push({ kind, key: k })
      return
    }
    const preferred = raw.filter((k) => ready.has(k) || unread.has(k))
    const use = preferred.length > 0 ? preferred : raw.filter((k) => !need.has(k))
    const final = use.length > 0 ? use : raw
    for (const k of final) push({ kind, key: k })
  }

  for (const seed of input.seeds) {
    if (input.job === 'peek') {
      // 门况局部：briefKey → map book → 已开；bookKey → 查是否有贴
      let bookKey = seed.bookKey
      let parentBrief: string | undefined
      let parentBriefKey: string | undefined
      if (seed.briefKey) {
        const hit = mapBriefToBook(input.docId, seed.briefKey)
        if (hit) {
          bookKey = hit.bookKey
          parentBrief = hit.brief
          parentBriefKey = seed.briefKey
        }
      }
      // insufficient book → 优先热启补贴（本问族）
      const needBooks = io.listKeysNeedingMore('peek', qScope)
      if (!bookKey && needBooks.length > 0) {
        bookKey = needBooks[0]
      }
      if (!bookKey) continue
      if (parentBriefKey || doorHasBrief(input.docId, bookKey)) {
        const head = mapBookToHeadBrief(input.docId, bookKey)
        const versions = listBriefVersionsOnDoor(input.docId, bookKey)
        const ver =
          typeof seed.versionIndex === 'number'
            ? versions[seed.versionIndex]
            : undefined
        push({
          kind: 'bookKey',
          key: bookKey,
          opened: true,
          parentBriefKey:
            parentBriefKey || ver?.briefKey || head?.briefKey,
          parentBrief: parentBrief || ver?.brief || head?.brief,
        })
      } else {
        push({ kind: 'bookKey', key: bookKey, opened: false })
      }
      continue
    }

    if (input.job === 'query') {
      const nowQk =
        useAttentionIo.getState().findQueryKeyForQuestion(input.seeds[0]?.question ?? '') ||
        ''
      // 优先用种子 question 对应 qk；多 seed 时仍排除所有当前问文匹配
      const nowKeys = new Set<string>()
      for (const s of input.seeds) {
        const qk = useAttentionIo.getState().findQueryKeyForQuestion(s.question)
        if (qk) nowKeys.add(qk)
      }
      const historic = listHistoricQueryEntriesForNeighbour(
        [...nowKeys][0] || nowQk || undefined,
      ).filter((e) => !nowKeys.has(e.queryKey))
      // 防整表问线：只取最近 HISTORIC_QUERY_CAP 条
      const HISTORIC_QUERY_CAP = 24
      const capped =
        historic.length > HISTORIC_QUERY_CAP
          ? historic.slice(-HISTORIC_QUERY_CAP)
          : historic
      preferByStatus(
        'queryKey',
        capped.map((e) => e.queryKey),
      )
      for (const k of keys) {
        if (k.kind !== 'queryKey') continue
        const hit = historic.find((e) => e.queryKey === k.key)
        if (hit) {
          k.qText = hit.qText
          k.familyRole = hit.familyRole
          k.parentQueryKey = hit.parentQueryKey
        }
      }
      continue
    }

    if (input.job === 'decide') {
      // 实验：decide 队列是 bookKey
      // onlyBookKeys 显式传入（含 []）= 钉死队列保序；勿 preferByStatus 重排（否则窗内 ⟦n⟧ 与批序错位）
      if (seed.onlyBookKeys !== undefined) {
        for (const b of seed.onlyBookKeys) {
          const t = b.trim()
          if (t) push({ kind: 'bookKey', key: t })
        }
      } else if (seed.onlyBriefKeys && seed.onlyBriefKeys.length > 0) {
        // 兼容：onlyBriefKeys 在本分支语义=bookKey 队列（保序）
        for (const b of seed.onlyBriefKeys) {
          const t = b.trim()
          if (t) push({ kind: 'bookKey', key: t })
        }
      } else {
        const books: string[] = []
        if (seed.bookKey) books.push(seed.bookKey)
        if (seed.briefKey && !seed.briefKey.startsWith('bh_')) {
          books.push(seed.briefKey)
        }
        books.push(...io.listKeysUnread('decide', qScope))
        books.push(...io.listKeysNeedingMore('decide', qScope))
        books.push(...io.listBookKeysForQuestion(seed.question))
        preferByStatus('bookKey', [...new Set(books)])
      }
      continue
    }

    if (input.job === 'supervise') {
      let bookKey = seed.bookKey
      let briefKey = seed.briefKey
      if (briefKey && !bookKey) {
        bookKey = mapBriefToBook(input.docId, briefKey)?.bookKey
      }
      if (bookKey && !briefKey) {
        briefKey = mapBookToHeadBrief(input.docId, bookKey)?.briefKey
      }
      if (bookKey && briefKey) {
        push({ kind: 'bookKey', key: bookKey })
        push({ kind: 'briefKey', key: briefKey })
      }
      continue
    }

    if (input.job === 'infer') {
      // onlyBookKeys 钉死保序 → 与窗内 ⟦n⟧ 对齐
      if (seed.onlyBookKeys && seed.onlyBookKeys.length > 0) {
        for (const b of seed.onlyBookKeys) {
          const t = b.trim()
          if (t) push({ kind: 'bookKey', key: t })
        }
      } else {
        const books: string[] = []
        let bookKey = seed.bookKey
        if (!bookKey && seed.briefKey) {
          bookKey = mapBriefToBook(input.docId, seed.briefKey)?.bookKey
        }
        if (bookKey) books.push(bookKey)
        for (const bk of io.listKeysReadyToDeliver('decide', qScope)) {
          const hit = mapBriefToBook(input.docId, bk)
          if (hit) books.push(hit.bookKey)
        }
        const histBooks = io.listBookKeysForQuestion(seed.question)
        books.push(...histBooks)
        books.push(...io.listKeysUnread('infer', qScope))
        preferByStatus('bookKey', [...new Set(books)])
      }
    }
  }

  return {
    keys,
    note: `expand ${input.job} · ${keys.length} keys · allow=${contract.allow.join(',')} · 三态过滤`,
  }
}

function fetchBookT(bookIndex: BookIndex, bookKey: string): string {
  const chunk = bookIndex.chunks.find((c) => c.key === bookKey)
  return chunk ? atomSearchText(chunk) : ''
}

function fetchBriefText(docId: string, briefKey: string): string {
  const hit = mapBriefToBook(docId, briefKey)
  return hit?.brief ?? ''
}
void fetchBriefText

/**
 * bookKey 已定 → 倒查历史问法 queryKey/Q原文 → 排除槽（展开原文）
 */
export function reverseLookupExcludeQuestions(bookKeys: string[]): Array<{
  queryKey: string
  qText: string
}> {
  return useAttentionIo.getState().listQuestionsForBookKeys(bookKeys)
}

export function assembleWindow(input: {
  docId: string
  bookIndex: BookIndex
  job: DeskJob
  qNow: string
  seeds: ThinSeed[]
  keys: ExpandedKey[]
  /** 本问 queryKey；用于 unread 强制读完（按问线） */
  queryKey?: string
  /** 目录导航轮：只送章节框架 */
  tocNav?: boolean
  tocCatalog?: string
  /** 玩法 B：钉住 ι 换方向时要避开的 inferKey 原文 */
  excludeInfers?: Array<{ inferKey: string; rationale: string }>
  /** 监督预测轨：decide 策略尸检 */
  decideCritiqueHint?: string
}): AssembledWindow {
  const contract = lookupContract(input.job)
  const ioForStatus = useAttentionIo.getState()
  const resolvedQk =
    input.queryKey?.trim() ||
    ioForStatus.findQueryKeyForQuestion(input.qNow) ||
    ioForStatus.selectedQueryKey ||
    undefined
  const windowKeyIds = input.keys.map((k) => k.key.trim()).filter(Boolean)
  const forceCommitKeys = resolvedQk
    ? ioForStatus
        .listKeysUnread(input.job, { queryKey: resolvedQk })
        .filter((k) => windowKeyIds.includes(k))
    : ioForStatus
        .listKeysUnread(input.job)
        .filter((k) => windowKeyIds.includes(k))
  const forceSet = new Set(forceCommitKeys)

  const bookFullKeys = input.keys
    .filter((k) => k.kind === 'bookKey')
    .map((k) => k.key)
  const queryFullKeys = input.keys
    .filter((k) => k.kind === 'queryKey')
    .map((k) => k.key)
  // supervise 的 path 列表在分支内确定；此处先占空表，分支内重建
  let aliasTable =
    input.job === 'decide' ||
    input.job === 'infer' ||
    input.job === 'peek'
      ? buildWindowAliasTable(bookFullKeys)
      : input.job === 'query'
        ? buildWindowAliasTable(queryFullKeys)
        : buildWindowAliasTable([])
  let aliasHint = windowAliasContractHint(aliasTable)

  const lines: string[] = [`Q_now：${input.qNow}`, `契约 in：${contract.inNote}`, '']
  if (aliasHint && !input.tocNav) lines.push(aliasHint, '')

  if (input.job === 'query') {
    lines.push('【阶段 A · query 窗 · 历史问族槽 ⟦n⟧ · 无 brief】')
    for (const k of input.keys.filter((x) => x.kind === 'queryKey')) {
      const role =
        k.familyRole === 'deepen'
          ? `深化←父问（台侧已绑，勿回传父全键）`
          : '根问'
      lines.push(
        formatDeskMaterialSlot({
          fullKey: k.key,
          table: aliasTable,
          body: `角色：${role}\n历史Q：${k.qText || '（无原文）'}`,
        }),
      )
    }
    lines.push(
      '扫完后只输出 JSON：\n' +
        '{\n' +
        '  "neighbours": [{ "queryKey": "⟦n⟧", "degree": "相关度说明", "reuseEligible": true|false }, …],\n' +
        '  "keyStatuses": [{ "key": "⟦n⟧", "status": "unread|sufficient|insufficient" }],\n' +
        '  "attentionArrived": true | false\n' +
        '}\n' +
        '规则：对称输出 ⊆ 上方历史问槽；queryKey/key 只许回传 ⟦n⟧；增量 = neighbour（该历史 Q 与 Q_now 的相关度）；\n' +
        '【reuseEligible 硬闸】每条 neighbour 必填 true|false：\n' +
        '  true = 该历史问已有 path/norm 能完整回答 Q_now（同问深化、几乎同问、极高、可整段复用）→ 台才开 reuse；\n' +
        '  false = 仅中高/半边/仅一侧/方法论可迁移/材料相关但问型不同 → 仍可进 neighbours 喂 seed，但禁止 reuse；\n' +
        '  多实体并列问（如是否提及 A 和 B）单侧历史问一律 false。\n' +
        '历史池含「根问」与「深化子问」；深化问与其父/兄可比相关度（靠拢或拉开）；\n' +
        '台对每条 settle neighbourKey，挂在对应 historic queryKey 上；\n' +
        '不出 briefKey；不得渗透 bookKey/T；禁止 qk_ 全长。\n' +
        `- ${keyStatusContractHint('queryKey')}\n` +
        '- 窗内每个 ⟦n⟧ 都要有 status（有 neighbour≈sufficient；未看=unread；看了但不相关=insufficient）。',
    )
  } else if (input.job === 'decide') {
    if (input.decideCritiqueHint?.trim()) {
      lines.push(input.decideCritiqueHint.trim(), '')
    }
    if (input.tocNav && input.tocCatalog?.trim()) {
      lines.push(input.tocCatalog.trim(), '')
      lines.push(
        '请只输出 JSON（可围栏）：\n' +
          '{\n' +
          '  "stopReason": "expand",\n' +
          '  "seedRanges": [ { "fromStrand": 10, "toStrand": 19 }, { "fromStrand": 40, "toStrand": 55 } ]\n' +
          '}\n' +
          '硬规则：\n' +
          '- 本轮是目录导航：禁止 prospects；禁止编造正文；禁止输出 bookKey / 印码 / memberKeys。\n' +
          '- seedRanges 只写校准后 strand 起止（上表 strand N–M）；可点多段；勿单条巨跨度盖全书。\n' +
          '- 台侧按 strand ∩ A1 拼 seedBookKeys 后再送正文 decide。\n' +
          '- keyStatuses 可省略；勿为每章长写 rationale。\n' +
          '- 优先保证 JSON 完整可解析。',
      )
    } else {
    const forceDecide = unreadForceCommitInstruction(
      forceCommitKeys.map((k) => displayWindowAlias(k, aliasTable)),
      'bookKey',
    )
    if (forceDecide) lines.push(forceDecide, '')
    lines.push(
      '【实验·无 peek】decide 直读材料槽：上行 ⟦n⟧ 独占行，下行正文 T；' +
        'prospect 父门=该槽（JSON 只许回传 bookKey/briefKey/key=⟦n⟧）。',
    )
    const qNeedles = qCoreNeedles(input.qNow)
    const qCoreHitDoors: string[] = []
    for (const k of input.keys.filter((x) => x.kind === 'bookKey')) {
      const T = fetchBookT(input.bookIndex, k.key).slice(0, 1200)
      const door = displayWindowAlias(k.key, aliasTable)
      const tags: string[] = []
      if (forceSet.has(k.key)) {
        tags.push(
          '【强制读完·禁止 unread】insufficient 禁 rationale；sufficient 须短 rationale',
        )
      }
      if (!T.trim()) {
        tags.push(
          '【台侧·T 空】本门无原文，禁止编造；须 status=insufficient，prospects 勿写本门。',
        )
      }
      const qHit = textHitsQCore(T, qNeedles)
      if (qHit) qCoreHitDoors.push(door)
      if (qHit) {
        tags.push(
          `【问核提示】T 含 Q 专名（${qNeedles.slice(0, 4).join('/')}）——逐门判解问相关：` +
            `若原文在批评/拒斥/清算/替代 Freud 的概念装置 → sufficient + prospect + relevance≥3；` +
            `仅点名/标题/临床旁例 → insufficient（勿铸）。`,
        )
      }
      lines.push(
        formatDeskMaterialSlot({
          fullKey: k.key,
          table: aliasTable,
          body: T,
          tags,
        }),
      )
    }
    if (qCoreHitDoors.length > 0) {
      lines.push(
        `【问核提示】本窗 ${qCoreHitDoors.map((d) => `\`${d}\``).join(' ')} 词面命中专名：` +
          `专名≠充分，也≠默认不足；逐门独立打分，禁止整窗一刀切 insufficient。`,
        '',
      )
    }
    const statusEnum =
      forceCommitKeys.length > 0
        ? 'sufficient|insufficient（强制读完槽 禁止 unread）| 其余可 unread|sufficient|insufficient'
        : 'unread|sufficient|insufficient'
    const keyStatusSchema =
      forceCommitKeys.length > 0
        ? `[{ "key": "⟦n⟧", "status": "${statusEnum}", "rationale": "仅 sufficient 可写；insufficient 禁止 rationale" }]`
        : `[{ "key": "⟦n⟧", "status": "${statusEnum}" }]`
    lines.push(
      '请只输出 JSON（可围栏）：\n' +
        '{\n' +
        '  "prospects": [{ "bookKey": "⟦n⟧", "prospect": "单行≤40字：该原文解 Q_now 的一种可能", "status": "sufficient", "relevance": 4 }],\n' +
        `  "keyStatuses": ${keyStatusSchema},\n` +
          '  "stopReason": null | "expand" | "token_full" | "off_book",\n' +
          '  "seedRange": null | { "from":"⟦n⟧","to":"⟦n⟧" } | { "from":"-inf","to":"⟦n⟧" } | { "from":"⟦n⟧","to":"+inf" },\n' +
          '  "seedRanges": [ { "from":"⟦n⟧", "to":"⟦n⟧" } ]\n' +
          '}\n' +
          '硬规则：\n' +
          '- 调度只看槽三态 + relevance；不要输出整窗 coverage；不要输出 keep[]。\n' +
          '- 【prospect 仅解问充分】只有能直接支撑解 Q_now 才写 prospects[]；须带 relevance 1–5（5=核心论据，3=可用，1–2=旁例/仅点名→勿铸，改标 insufficient）。\n' +
          '- 【rationale 闸】insufficient 一律禁止 rationale；普通轮 keyStatuses 只报 status；强制读完时 sufficient 才写短 rationale。\n' +
          '- 【解问·正例】批评/拒斥/清算/替代 Freud 的地形学切割、力比多经济、科学主义枷锁、启示文本化、元心理学等 → sufficient + relevance≥4（哪怕只是论证一截）。\n' +
          '- 【解问·反例】仅专名点名、章节标题、临床轶事旁引、无法抽出「如何批判」步骤 → insufficient，勿因专名硬铸。\n' +
          '- 【问核】专名命中只是提示；逐门独立判断，禁止整窗一刀切 insufficient。\n' +
          '- insufficient → 可写 seedRange，但端点须指向**窗外**未读邻域；禁止 seedRange 覆盖整窗（如 from=⟦1⟧ to=⟦末⟧）；若无窗外锚点则 stopReason=null、seedRange=null。\n' +
          '- 未处理完 → unread（台续滚，下一轮对该槽强制读完）。\n' +
          '- seedRange 锚点须已读；一槽一 prospectKey；bookKey/briefKey/key 只许回传本窗 ⟦n⟧；禁止 h1 全长、wN、裸号、slot。\n' +
          '- prospect 必须单行、≤40字；禁止换行；字符串内禁止英文双引号。\n' +
          `- ${keyStatusContractHint('bookKey')}\n` +
          '- 窗内每个 ⟦n⟧ 都必须出现在 prospects.status 或 keyStatuses 里。\n' +
          '- 优先保证 JSON 完整可解析。',
    )
    }
  } else if (input.job === 'peek') {
    lines.push('【peek 铸贴窗 · 材料槽 ⟦n⟧】')
    for (const k of input.keys.filter((x) => x.kind === 'bookKey')) {
      const T = fetchBookT(input.bookIndex, k.key).slice(0, 800)
      const tags: string[] = []
      if (k.opened && k.parentBrief) {
        tags.push(
          `opened=true · 对照贴 briefKey=\`${k.parentBriefKey}\`:\n${k.parentBrief}`,
        )
        tags.push(
          '请判 noop|add|condense，输出同一 ⟦n⟧ + brief 正文（台铸 briefKey）。',
        )
      } else {
        tags.push('opened=false · 请 create：同一 ⟦n⟧ + brief 正文。')
      }
      lines.push(
        formatDeskMaterialSlot({
          fullKey: k.key,
          table: aliasTable,
          body: T,
          tags,
        }),
      )
    }
    const secondPeek =
      input.keys.some((k) => k.kind === 'bookKey' && k.opened) ||
      docHasAnyBrief(input.docId)
    lines.push(
      '请只输出 JSON：\n' +
        '{\n' +
        '  "briefs":[\n' +
        '    { "key":"⟦n⟧", "brief":"贴A", "status":"sufficient" },\n' +
        '    { "key":"同一 ⟦n⟧", "briefs":["贴B","贴C"], "status":"sufficient" }\n' +
        '  ],\n' +
        '  "keyStatuses":[{ "key":"⟦n⟧", "status":"unread|sufficient|insufficient" }]\n' +
        '}\n' +
        `- ${keyStatusContractHint('bookKey')}\n` +
        '- 主协议是 briefs[]（items[] 已废除）。\n' +
        '- 一槽一 briefKey：多条同 key，或一行 briefs:["贴A","贴B"] 展开；禁止多贴合成一条。\n' +
        '- 仅 status=sufficient（或有 brief 未报态）才铸 briefKey；unread/insufficient 不铸键。\n' +
        '- key 只许回传本窗 ⟦n⟧；禁止 h1 全长、wN、裸号、slot。\n' +
        (secondPeek
          ? '- 二次+ peek：用户原话若出现在窗旁注，只作修贴意图，禁止抄进 brief。'
          : '- 第一次冷启：只按固定指令从 T 铸贴，不要依赖用户问题。'),
    )
  } else if (input.job === 'supervise') {
    lines.push('【监督 · path 槽 ⟦n⟧ · 信效度 + 归一化推理（非配对）】')
    const io = useAttentionIo.getState()
    const qk =
      resolvedQk ||
      io.pendingPathMatch?.queryKey ||
      io.selectedQueryKey ||
      Object.keys(io.settledQueries).at(-1) ||
      ''
    const pending = io.pendingPathMatch
    const candidatePaths =
      pending?.pathKeys?.length
        ? io.paths.filter((p) => pending.pathKeys.includes(p.pathKey))
        : qk
          ? io.paths.filter(
              (p) =>
                p.queryKey === qk &&
                (p.matchMode === 'candidate' || p.matchMode === 'user'),
            )
          : []
    aliasTable = buildWindowAliasTable(
      candidatePaths.map((p) => p.pathKey),
    )
    aliasHint = windowAliasContractHint(aliasTable)
    if (aliasHint) lines.push(aliasHint, '')
    const forcePathKeys =
      forceCommitKeys.length > 0
        ? forceCommitKeys
        : qk
          ? io
              .listKeysUnread('supervise', { queryKey: qk })
              .filter((k) => candidatePaths.some((p) => p.pathKey === k))
          : []
    const forcePathSet = new Set(forcePathKeys)
    const forceSupervise = unreadForceCommitInstruction(
      forcePathKeys.map((k) => displayWindowAlias(k, aliasTable)),
      'path槽',
    )
    if (forceSupervise) lines.push(forceSupervise, '')
    if (candidatePaths.length === 0) {
      lines.push(
        '台侧无候选 path 可评。勿编造 judgments。\n' +
          '请输出 JSON：{ "judgments": [], "keyStatuses": [] }',
      )
    } else {
      lines.push(
        `本问 Q：${io.settledQueries[qk] ?? input.qNow}\n` +
          '下列均为写信台已铸 path（血缘已绑定），以 ⟦n⟧ 分槽；你只评信效度，充分时写归一化推理正文。\n' +
          '归一化：以 infer 为基地（主链大致不改），prospect 作修饰/补全；供 reuse 单段展开省 token。\n' +
          '禁止增删槽；pathKey/key 只许回传 ⟦n⟧；禁止 ph_/inferKey/prospectKey 全长。\n' +
          '请输出 JSON：\n' +
          '{\n' +
          '  "judgments":[{ "pathKey":"⟦n⟧", "status":"sufficient|insufficient", "normalizedText":"充分时必填", "rationale":"仅 sufficient 可写；insufficient 禁止" }],\n' +
          '  "keyStatuses":[{ "key":"⟦n⟧", "status":"unread|sufficient|insufficient" }]\n' +
          '}\n' +
          '- sufficient 必须带 normalizedText → 台铸 normKey；insufficient 不铸、禁 rationale\n' +
          '- 曾报 unread 的槽：禁止再 unread；sufficient 须短 rationale，insufficient 禁 rationale\n' +
          `- ${keyStatusContractHint('pathKey')}`,
      )
      for (const p of candidatePaths) {
        const edge = io.inferEdges.find((e) => e.inferKey === p.inferKey)
        const pr = io.prospects.find((x) => x.prospectKey === p.prospectKey)
        const tags: string[] = []
        if (forcePathSet.has(p.pathKey)) {
          tags.push(
            '【强制读完·禁止 unread】insufficient 禁 rationale；sufficient 须短 rationale',
          )
        }
        const body =
          `ι 展开：${(edge?.infer || edge?.rationale || '').trim()}\n` +
          `prospect 展开：${(pr?.text || '').trim()}`
        lines.push(
          formatDeskMaterialSlot({
            fullKey: p.pathKey,
            table: aliasTable,
            body,
            tags,
          }),
        )
      }
    }
  } else {
    // infer
    const forceInfer = unreadForceCommitInstruction(
      forceCommitKeys.map((k) => displayWindowAlias(k, aliasTable)),
      'bookKey',
    )
    if (forceInfer) lines.push(forceInfer, '')
    lines.push('【infer · 材料槽 ⟦n⟧（独占行 + 正文 T）】')
    const bookKeys = input.keys
      .filter((x) => x.kind === 'bookKey')
      .map((x) => x.key)
    for (const bk of bookKeys) {
      const T = fetchBookT(input.bookIndex, bk).slice(0, 600)
      const tags: string[] = []
      if (forceSet.has(bk)) {
        tags.push(
          '【强制读完·禁止 unread】insufficient 禁 rationale；sufficient 须短 rationale',
        )
      }
      lines.push(
        formatDeskMaterialSlot({
          fullKey: bk,
          table: aliasTable,
          body: T,
          tags,
        }),
      )
    }
    const excludesI = input.excludeInfers ?? []
    if (excludesI.length > 0) {
      lines.push('【排除 · 玩法 B · inferKey / ι 原文 · 勿沿此方向再推】')
      for (const e of excludesI) {
        lines.push(`inferKey=\`${e.inferKey}\`\nι原文：${e.rationale}\n`)
      }
    }
    lines.push(
      '请只输出 JSON（可围栏），结构：\n' +
        '{\n' +
        '  "attentionArrived": true | false,\n' +
        '  "materialStatus": [{ "bookKey": "⟦n⟧", "status": "unread|sufficient|insufficient", "rationale": "仅 sufficient 可写；insufficient 禁止" }],\n' +
        '  "keyStatuses": [{ "key": "⟦n⟧", "status": "unread|sufficient|insufficient" }],\n' +
        '  "paths": [\n' +
        '    {\n' +
        '      "conclusion": "这些充分 infer 如何排列/组合后，直接回答如何解 Q_now（解法总览）",\n' +
        '      "steps": [\n' +
        '        { "role": "该步在总览里的论证角色", "bookKeys": ["⟦2⟧"], "infer": "认真读完该门 T 后：如何从材料推出这一步" },\n' +
        '        {\n' +
        '          "role": "另一论证角色（仅当两门确实能合推）",\n' +
        '          "bookKeys": ["⟦3⟧","⟦9⟧"],\n' +
        '          "infer": "⟦3⟧ …该门如何支撑本步…\\n⟦9⟧ …该门如何支撑本步…\\n【合推】…这两门如何合在一起共同完成本步要解决的事…"\n' +
        '        }\n' +
        '      ]\n' +
        '    }\n' +
        '  ]\n' +
        '}\n' +
        '【读与写·顺序】\n' +
        '1) 认真读完本窗每一个 ⟦n⟧ 的 T；对每门报三态；只有充分才允许进入 steps 写 infer。\n' +
        '2) 对充分门写出逐步 infer（该门/该组合如何支撑解 Q 的一截论证）。\n' +
        '3) 再写 conclusion：说明上述 infer 如何排列或组合，形成一种能直接回答 Q_now 的解法总览。\n' +
        '【组合·由你判断，不设步数上限】\n' +
        '- 若读完后发现若干门的论证能一起解 Q → 可把它们放进同一步的 bookKeys。\n' +
        '- 【多门一步·强制格式】bookKeys 含 ≥2 个 ⟦n⟧ 时，infer 必须：\n' +
        '  (a) 先按门分述：每个 bookKeys 里的 ⟦n⟧ 各写一段（门牌须与 bookKeys 一致，便于台侧匹配）；\n' +
        '  (b) 再写【合推】：说明这些门如何合在一起，共同回答「本步要解决的东西」（并置/互补/因果等须写清）。\n' +
        '  禁止只写合论不写分门；禁止把合论当成某一单门的分述。\n' +
        '- 若某门单独就够支撑一步 → 该步只挂一门，infer 不必【合推】。\n' +
        '- 若某门充分但与当前解法拼不上 → 不要硬并；可另开一条 path，或本解法不用它（仍须在 materialStatus 报足三态）。\n' +
        '- 禁止：1门→2门→3门 爬梯剧本；禁止机械「一门一步扫完所有槽」却无组合逻辑；禁止无充分材料硬写 infer。\n' +
        '【path】每条 path=一种解法；多条 paths 须论证主轴可区分（不要只换顺序复述同料）；' +
        'role=本步服务 conclusion 哪一块；bookKeys≥1 且须来自上方 ⟦n⟧；' +
        '禁止 [同一槽,同一槽] 自环；台对每步铸 inferKey、对每条 path 铸审计 pathKey；' +
        'attentionArrived=是否已读完并能穷举解法；不能则 false；' +
        '【rationale 闸】insufficient 禁止 rationale；sufficient 的 materialStatus 可写短 rationale；' +
        '勿散文' +
        (excludesI.length > 0 ? '；勿把排除项当材料' : '') +
        '。\n' +
        `- ${keyStatusContractHint('bookKey')}\n` +
        '- 进入 paths 的门 = sufficient；未用进解法的充分门也须在 keyStatuses/materialStatus 报足。\n' +
        '- 曾报 unread 的槽：禁止再 unread；sufficient 须短 rationale，insufficient 禁 rationale。',
    )
  }

  return {
    job: input.job,
    contractIn: contract.inNote,
    contractOut: contract.outNote,
    userPayload: lines.join('\n'),
    systemPayload: [
      `你执行写信台契约「${input.job}」。`,
      `in：${contract.inNote}`,
      `out：${contract.outNote}`,
      forceCommitKeys.length > 0
        ? '本窗含曾报 unread 的 key：禁止再次 unread；sufficient 须短理由；insufficient 禁止 rationale。'
        : '',
      aliasHint
        ? '本窗对象用 ⟦n⟧ 槽分隔；JSON 门牌只许 ⟦n⟧；台侧展开为全长键。'
        : '',
      '禁止改契约；禁止把排除项当材料；禁止闲聊。',
    ]
      .filter(Boolean)
      .join('\n'),
    note:
      `组窗 ${input.job} · keys=${input.keys.length}` +
      (aliasTable.fullKeys.length
        ? ` · 槽 ⟦1⟧…⟦${aliasTable.fullKeys.length}⟧`
        : '') +
      (forceCommitKeys.length
        ? ` · unread强制读完×${forceCommitKeys.length}`
        : ''),
    aliasTable,
  }
}

/** 候选 path：neighbour 挂靠的历史 qk + 本问祖先链（深化可直用父 path） */
export function listCandidatePathsViaNeighbours(nowQueryKey?: string) {
  const st = useAttentionIo.getState()
  const qk = nowQueryKey?.trim()
  if (!qk) return []
  const historic = new Set<string>()
  for (const n of st.neighbours.filter((x) => x.nowQueryKey === qk)) {
    const hq =
      expandHistoricQueryKey(n.historicQueryKey, qk) || n.historicQueryKey
    if (hq) historic.add(hq)
  }
  // 深化：父链 path 始终可进 reuse 候选（即使尚未落 neighbour）
  for (const a of st.listQuerySelfAndAncestors(qk)) {
    if (a !== qk) historic.add(a)
  }
  // 始终并入「已有 norm 的历史 qk」（neighbour 未落账/指错时仍能进 reuse 闸）
  for (const hq of historicQueryKeysWithNorms(qk)) historic.add(hq)
  if (historic.size === 0) return []
  const out: ReturnType<typeof st.listPathsForQueryKey> = []
  const seen = new Set<string>()
  for (const hq of historic) {
    for (const p of st.listPathsForQueryKey(hq)) {
      if (seen.has(p.pathKey)) continue
      seen.add(p.pathKey)
      out.push(p)
    }
  }
  return out
}

/** @deprecated 用 listCandidatePathsViaNeighbours；book 邻近扫不符合 reuse 架构 */
export function listCandidatePaths(bookKeys: string[]) {
  return useAttentionIo.getState().listPathsForBookKeys(bookKeys)
}

/** @deprecated 用 listCandidatePaths；保留给玩法 B 排除 ι */
export function listCandidateInferEdges(bookKeys: string[]): InferEdge[] {
  return useAttentionIo.getState().listInferEdgesForBookKeys(bookKeys)
}

import { runReuseGate, listNeighbourHistoricsOrdered } from './reuseGate'
export { runReuseGate, listNeighbourHistoricsOrdered }

async function runMainInferAndSettle(input: {
  pkg: LetterDeskPackage
  bookIndex: BookIndex
  docId: string
  keys: ExpandedKey[]
  seeds: ThinSeed[]
  excludeInfers?: Array<{ inferKey: string; rationale: string }>
  queryKey?: string
  onProgress?: (msg: string) => void
  signal?: AbortSignal
}): Promise<{ part: string; note: string }> {
  const bookKeys = input.keys
    .filter((k) => k.kind === 'bookKey')
    .map((k) => k.key)

  const win = assembleWindow({
    docId: input.docId,
    bookIndex: input.bookIndex,
    job: 'infer',
    qNow: input.pkg.question,
    seeds: input.seeds,
    keys: input.keys,
    excludeInfers: input.excludeInfers,
    queryKey: input.queryKey,
  })
  input.onProgress?.('写信台 · infer · LLM…')
  const chat = await flashChat({
    system: win.systemPayload,
    user: win.userPayload,
    temperature: 0.15,
    maxTokens: 8192,
    retryOnEmpty: true,
    // thinking 全关：开则易 length 空 content，ι 落不成
    signal: input.signal,
    ioMeta: {
      job: 'infer',
      stage: 'main',
      queryKey: input.queryKey,
    },
  })
  if (!chat.ok) {
    return { part: `### infer 失败\n${chat.note}`, note: chat.note }
  }

  const llmExpanded = expandDoorplatesInLlmText(
    chat.content,
    win.aliasTable,
    extractJsonObject,
  )

  ingestKeyIncrementStatuses({
    job: 'infer',
    llmText: llmExpanded,
    windowKeys: bookKeys,
    queryKey: input.queryKey,
  })

  let paths = parseInferPaths(llmExpanded)
  if (paths.length === 0) {
    // 禁止 fallback 造伪槽（会把多段内容并进错误 key）
    void fallbackInferPaths
    return {
      part: `### infer · 未解析到输出槽\n禁止用兜底合并正文。请重跑。\n--- raw ---\n${chat.content.trim()}`,
      note: 'infer 无槽 · 未落账',
    }
  }
  const bookTexts: Record<string, string> = {}
  for (const bk of bookKeys) {
    bookTexts[bk] = fetchBookT(input.bookIndex, bk)
  }
  const settled = useAttentionIo.getState().settleInferPaths({
    question: input.pkg.question,
    paths,
    bookTexts,
    queryKey: input.queryKey,
    llmCallId: newLlmCallId('infer'),
  })

  // 不在此自动监督：挂起等人手确认；显式 skip 才跑监督铸 norm
  const userPaths = useAttentionIo
    .getState()
    .listPathsForQueryKey(settled.queryKey)
    .filter((p) => p.matchMode === 'user')
  const pending = useAttentionIo.getState().pendingPathMatch
  const pathNote =
    userPaths.length > 0
      ? `已有用户确认 path×${userPaths.length}`
      : pending
        ? `已铸候选 pathKey×${pending.pathKeys?.length ?? 0}；确认或「跳过」→监督铸 norm`
        : '无 path 挂起'

  return {
    part:
      `### infer · 落账\n` +
      `queryKey=\`${settled.queryKey}\`\n` +
      `inferKeys: ${settled.inferKeys.map((k) => `\`${k}\``).join(', ')}\n` +
      `pathKeys(candidate): ${(pending?.pathKeys ?? settled.pathKeys).map((k) => `\`${k}\``).join(', ') || '∅'}\n` +
      `pathKeys(user): ${userPaths.map((p) => `\`${p.pathKey}\``).join(', ') || '∅'}\n` +
      `${pathNote}\n` +
      `--- raw ---\n${llmExpanded.trim()}`,
    note: `settle infer · ${settled.inferKeys.length} · candPath×${pending?.pathKeys?.length ?? settled.pathKeys.length} · userPath×${userPaths.length} · pending=${pending ? 'yes' : 'no'} · qk=${settled.queryKey}` +
      (win.aliasTable.fullKeys.length
        ? ` · 材料槽×${win.aliasTable.fullKeys.length}`
        : ''),
  }
}

/**
 * 用户明确跳过手工确认后：用挂起里已铸 pathKey → 监督 LLM → 充分则铸 normKey。
 */
export async function skipPendingPathMatchToSupervise(input?: {
  onProgress?: (msg: string) => void
}): Promise<{ pathKeys: string[]; normKeys?: string[]; note: string; raw: string }> {
  const st = useAttentionIo.getState()
  const pending = st.pendingPathMatch
  if (!pending) {
    const anyUser = st.paths.filter((p) => p.matchMode === 'user')
    if (anyUser.length > 0) {
      return {
        pathKeys: anyUser.map((p) => p.pathKey),
        note: '无挂起 · 已有用户 path',
        raw: '',
      }
    }
    return { pathKeys: [], note: '无挂起的 path 可跳过', raw: '' }
  }
  const qk = pending.queryKey
  const prePathKeys = pending.pathKeys
  const preBound = pending.boundPairs
  st.clearPendingPathMatch()
  return runPathMatchSuperviseIfNeeded({
    queryKey: qk,
    onProgress: input?.onProgress,
    force: true,
    prePathKeys,
    preBoundPairs: preBound,
  })
}

/**
 * 监督：在已铸 pathKey 上评信效度；充分则台铸 normKey（归一化推理）。
 */
export async function runPathMatchSuperviseIfNeeded(input: {
  queryKey: string
  onProgress?: (msg: string) => void
  /** true = 用户已显式跳过手工确认 */
  force?: boolean
  /** 跳过前挂起的 pathKey */
  prePathKeys?: string[]
  /** 兼容：挂起 boundPairs */
  preBoundPairs?: Array<{
    pathKey?: string
    inferKey: string
    prospectKey: string
    briefKey: string
    sharedBookKeys: string[]
  }>
  signal?: AbortSignal
}): Promise<{ pathKeys: string[]; normKeys?: string[]; note: string; raw: string }> {
  const st = useAttentionIo.getState()
  const qk = input.queryKey.trim()
  const existingUser = st
    .listPathsForQueryKey(qk)
    .filter((p) => p.matchMode === 'user')
  if (existingUser.length > 0) {
    const norms = st.listNormsForPathKeys(existingUser.map((p) => p.pathKey))
    return {
      pathKeys: existingUser.map((p) => p.pathKey),
      normKeys: norms.map((n) => n.normKey),
      note: `用户已确认 path×${existingUser.length} · 不触发信效度 LLM`,
      raw: '',
    }
  }
  if (st.pendingPathMatch && !input.force) {
    return {
      pathKeys: [],
      note: '仍在等待用户确认 path · 禁止自动评测（请 settleUserPathMatches 或 skipPendingPathMatchToSupervise）',
      raw: '',
    }
  }

  let candidates = st.paths.filter(
    (p) =>
      p.queryKey === qk &&
      (p.matchMode === 'candidate' || p.matchMode === 'user'),
  )
  if (input.prePathKeys && input.prePathKeys.length > 0) {
    const allow = new Set(input.prePathKeys)
    candidates = candidates.filter((p) => allow.has(p.pathKey))
  } else if (input.preBoundPairs && input.preBoundPairs.length > 0) {
    const allow = new Set(
      input.preBoundPairs.map((p) =>
        p.pathKey?.trim()
          ? p.pathKey.trim()
          : `${p.inferKey}::${p.prospectKey}`,
      ),
    )
    candidates = candidates.filter(
      (p) =>
        allow.has(p.pathKey) ||
        allow.has(`${p.inferKey}::${p.prospectKey}`),
    )
  }
  if (candidates.length === 0) {
    // 无候选则尝试现场绑定并先铸
    const docId = useIndexGate.getState().bookIndex?.docId?.trim() ?? ''
    if (docId) {
      const pending = st.beginPendingPathMatch({
        queryKey: qk,
        question: st.settledQueries[qk] ?? '',
        inferKeys: st.inferEdges
          .filter((e) => e.queryKey === qk)
          .map((e) => e.inferKey),
      })
      candidates = st.paths.filter((p) => pending.pathKeys.includes(p.pathKey))
      st.clearPendingPathMatch()
    }
  }
  if (candidates.length === 0) {
    return {
      pathKeys: [],
      note: '监督跳过 · 无候选 pathKey',
      raw: '',
    }
  }

  const allowedPath = new Set(candidates.map((p) => p.pathKey))
  const lines: string[] = [
    `queryKey=\`${qk}\``,
    `Q：${st.settledQueries[qk] ?? ''}`,
    '',
    '【台已铸 pathKey · 解法级（conclusion + steps 溯源）】',
    '你只评信效度；充分时写归一化推理（以 conclusion 为总览，可含分步）。',
    '禁止增删 pathKey；禁止把 inferKey/prospectKey 当并列门牌回传。',
    '',
  ]
  for (const p of candidates) {
    const conclusion = (p.conclusion ?? '').trim()
    const steps =
      p.steps?.length
        ? p.steps
        : (() => {
            const iks = p.inferKeys?.length
              ? p.inferKeys
              : p.inferKey
                ? [p.inferKey]
                : []
            return iks.map((ik) => {
              const edge = st.inferEdges.find((e) => e.inferKey === ik)
              return {
                inferKey: ik,
                role: (edge?.role ?? '').trim(),
                bookKeys: edge?.bookKeys ?? [],
                infer: (edge?.infer || edge?.rationale || '').trim(),
              }
            })
          })()
    const prospectKeys = p.prospectKeys?.length
      ? p.prospectKeys
      : p.prospectKey
        ? [p.prospectKey]
        : []
    const prospectBlock = prospectKeys
      .map((pk) => {
        const pr = st.prospects.find((x) => x.prospectKey === pk)
        return pr?.text?.trim()
          ? `- ${pr.text.trim().slice(0, 200)}`
          : null
      })
      .filter(Boolean)
      .join('\n')
    const stepBlock = steps
      .map((s, i) => {
        const role = s.role ? ` · ${s.role}` : ''
        const books = (s.bookKeys ?? []).join(', ') || '∅'
        return `  ${i + 1}${role} · book=[${books}]\n  ${(s.infer || '').slice(0, 280)}`
      })
      .join('\n')
    lines.push(
      `── pathKey=\`${p.pathKey}\` ──\n` +
        `conclusion：${conclusion || '（无）'}\n` +
        `steps：\n${stepBlock || '  （无）'}\n` +
        (prospectBlock
          ? `prospect 载荷：\n${prospectBlock}\n`
          : 'prospect 载荷：（无）\n'),
    )
  }
  lines.push(
    '\n只输出一个 JSON 对象（可 ```json 围栏），不要散文：\n' +
      '{\n' +
      '  "judgments": [\n' +
      '    { "pathKey": "ph_…", "status": "sufficient|insufficient", "normalizedText": "…" }\n' +
      '  ]\n' +
      '}\n' +
      '须覆盖上方每一 pathKey；sufficient 必须带 normalizedText → 台铸 normKey。',
  )

  input.onProgress?.('写信台 · 监督 · pathKey 信效度+归一化…')
  const chat = await flashChat({
    system: [
      '你是监督：pathKey 已由写信台按材料血缘铸好。',
      '只判信效度；充分则写归一化推理（infer 为底、prospect 修饰），供 reuse 省 token。',
      '只输出合法 JSON（judgments）；thinking 关闭场景下务必完整闭合括号。',
    ].join('\n'),
    user: lines.join('\n'),
    temperature: 0.1,
    maxTokens: 8192,
    retryOnEmpty: true,
    signal: input.signal,
    ioMeta: {
      job: 'supervise',
      stage: 'path_norm',
      queryKey: qk || undefined,
    },
  })
  if (!chat.ok) {
    return { pathKeys: [], note: `监督失败：${chat.note}`, raw: '' }
  }

  ingestKeyIncrementStatuses({
    job: 'supervise',
    llmText: chat.content,
    windowKeys: candidates.map((p) => p.pathKey),
    queryKey: qk,
  })

  const pairToPath = new Map(
    candidates.map((p) => [`${p.inferKey}::${p.prospectKey}`, p.pathKey] as const),
  )
  const judgments = parsePathValidityJudgments(chat.content).map((j) => {
    let pathKey = (j.pathKey ?? '').trim()
    if (!pathKey && j.inferKey && j.prospectKey) {
      pathKey = pairToPath.get(`${j.inferKey}::${j.prospectKey}`) ?? ''
    }
    return { ...j, pathKey }
  })
  const mapped = judgments.filter((j) => j.pathKey && allowedPath.has(j.pathKey))
  if (mapped.length === 0) {
    return {
      pathKeys: candidates.map((p) => p.pathKey),
      note: `监督 · 候选 path×${candidates.length} · 无有效 judgments`,
      raw: chat.content,
    }
  }

  const llmCallId = newLlmCallId('supervise')
  const confirmed = useAttentionIo.getState().confirmSupervisePaths({
    queryKey: qk,
    llmCallId,
    judgments: mapped.map((j) => ({
      pathKey: j.pathKey!,
      status: j.status,
      normalizedText: j.normalizedText,
    })),
  })
  useAttentionIo.getState().clearPendingPathMatch()
  return {
    pathKeys: confirmed.pathKeys,
    normKeys: confirmed.normKeys,
    note: `${confirmed.note} · 候选×${candidates.length}`,
    raw: chat.content,
  }
}

/** 薄包 → 台调度 → LLM（正文仅此处 fetch） */
export async function dispatchLetterDesk(input: {
  docId: string
  bookIndex: BookIndex
  packages: LetterDeskPackage[]
  /** 调度条上的补充说明；默认用各包 question */
  dispatcherNote?: string
  /** 本轮已铸 queryKey（方案 B）；缺则各 settle 自铸 */
  turnQueryKey?: string
  onProgress?: (msg: string) => void
  /** 并行早停：取消本包未完成的 LLM fetch */
  signal?: AbortSignal
}): Promise<{ ok: boolean; answer: string; note: string }> {
  if (input.packages.length === 0) {
    return { ok: false, answer: '', note: '写信台无薄指令包' }
  }

  const parts: string[] = []
  const notes: string[] = []
  const turnQueryKey = input.turnQueryKey?.trim() || undefined

  for (const pkg of input.packages) {
    if (input.signal?.aborted) {
      notes.push('写信台 · 已取消（早停）')
      break
    }
    input.onProgress?.(`写信台 · ${pkg.job} · expand…`)
    const seeds: ThinSeed[] = [
      {
        bookKey: pkg.bookKey || undefined,
        briefKey: pkg.briefKey || undefined,
        question: pkg.question,
        job: pkg.job,
        versionIndex: pkg.versionIndex,
        onlyBriefKeys: pkg.onlyBriefKeys,
        onlyBookKeys: pkg.onlyBookKeys,
        decideCritiqueHint: pkg.decideCritiqueHint,
        avoidProspectTexts: pkg.avoidProspectTexts,
      },
    ]
    const { keys, note: expNote } = expandSeedsForJob({
      docId: input.docId,
      job: pkg.job,
      seeds,
      queryKey: turnQueryKey,
    })
    notes.push(expNote)
    // toc_nav：只送走廊表，不需 bookKey 进窗；允许 expand 空
    const tocNavOnly =
      pkg.job === 'decide' &&
      Boolean(pkg.tocNav) &&
      Boolean(pkg.tocCatalog?.trim())
    if (keys.length === 0 && !tocNavOnly) {
      parts.push(
        `### ${pkg.job} · 无法组窗（expand 空）\nseed book=${pkg.bookKey} brief=${pkg.briefKey}`,
      )
      continue
    }
    // 防伪门：toc_nav 不得把占位 bookKey「toc」送进窗
    if (tocNavOnly) {
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i]!
        if (
          k.kind === 'bookKey' &&
          (k.key === 'toc' || k.key === 'toc_nav' || !k.key.startsWith('h1.'))
        ) {
          keys.splice(i, 1)
        }
      }
    }

    // peek / infer / supervise：入窗 bookKey 即并行物化页图（与 LLM 并行，不等结算）
    if (pkg.job === 'peek' || pkg.job === 'infer' || pkg.job === 'supervise') {
      const bookKeysIn = keys
        .filter((k) => k.kind === 'bookKey')
        .map((k) => k.key)
      if (bookKeysIn.length > 0) {
        void import('./prefetchBookPages').then(({ prefetchPagesForBookKeys }) => {
          void prefetchPagesForBookKeys({
            bookKeys: bookKeysIn,
            bookIndex: input.bookIndex,
            onProgress: input.onProgress,
          })
        })
      }
    }

    if (pkg.job === 'infer') {
      // infer；reuse 在前；再开时必排本问族已有 ι（狭义推理记忆，≠ reuse）
      const { priorInferKeysForQuery } = await import('./superviseCritique')
      const qkForPrior =
        turnQueryKey ||
        useAttentionIo.getState().findQueryKeyForQuestion(pkg.question) ||
        ''
      const priorIk = qkForPrior ? priorInferKeysForQuery(qkForPrior) : []
      const wantExclude = [
        ...new Set([
          ...(pkg.excludeMode === 'B' ? pkg.excludeInferKeys ?? [] : []),
          ...priorIk,
        ]),
      ]

      // 显式玩法 B / 监督换推：跳过 reuse，直开带排除的 infer
      const forceExcludeInfer =
        pkg.excludeMode === 'B' && (pkg.excludeInferKeys?.length ?? 0) > 0
      // autoFlow 入口已 reuse 过 → 勿嵌套再闸（未绑定 runReuseGate 时会 ReferenceError 卡死）
      const skipNestedReuse = Boolean(pkg.skipReuse)

      if (!forceExcludeInfer && !skipNestedReuse) {
        const priorPaths = listCandidatePathsViaNeighbours(turnQueryKey)
        if (priorPaths.length > 0) {
          const gate = await runReuseGate({
            qNow: pkg.question,
            docId: input.docId,
            queryKey: turnQueryKey,
            excludeNormKeys:
              useAttentionIo.getState().pendingReuseWait?.exhaustedNormKeys,
            onProgress: input.onProgress,
            signal: input.signal,
            flashChat,
            listCandidatePaths: listCandidatePathsViaNeighbours,
          })
          notes.push(gate.note)
          if (gate.awaitingMoreNorms) {
            parts.push(
              `### 复用停泊 · 等历史问铸 norm（未开 infer）\n` +
                `现 queryKey=\`${gate.queryKey ?? turnQueryKey}\`\n` +
                `awaiting: ${(gate.awaitingHistoricQueryKeys ?? [])
                  .map((k) => `\`${k}\``)
                  .join(', ')}\n` +
                `exhaustedNorm×${gate.exhaustedNormKeys?.length ?? 0}\n` +
                (gate.raw ? `--- gate raw ---\n${gate.raw.trim()}\n` : ''),
            )
            notes.push('复用停泊·等历史问确认 path')
            continue
          }
          if (gate.awaitingApproval) {
            parts.push(
              `### 复用 · 提案挂起 ×${gate.normKeys?.length ?? 1}（待批准，未开 infer）\n` +
                `现 queryKey=\`${gate.queryKey}\`\n` +
                `normKeys: ${(gate.normKeys ?? []).map((k) => `\`${k}\``).join(', ')}\n` +
                `pathKeys: ${(gate.pathKeys ?? [gate.pathKey]).map((k) => `\`${k}\``).join(', ')}\n` +
                `--- gate raw ---\n${gate.raw.trim()}`,
            )
            notes.push('等待用户批准复用')
            continue
          }
          if (gate.adopted) {
            parts.push(
              `### 复用 · 采纳旧 path ×${gate.pathKeys?.length ?? 1}（未开新 infer）\n` +
                `现 queryKey=\`${gate.queryKey}\`\n` +
                `pathKeys: ${(gate.pathKeys ?? [gate.pathKey]).map((k) => `\`${k}\``).join(', ')}\n` +
                `reuseKeys: ${(gate.reuseKeys ?? [gate.reuseKey]).map((k) => `\`${k}\``).join(', ')}\n` +
                `依据：${gate.judgments.filter((j) => j.canSolve).map((j) => j.rationale).join('；')}\n` +
                `--- gate raw ---\n${gate.raw.trim()}`,
            )
            continue
          }
          parts.push(
            `### 复用未采纳 → infer\n` +
              `${gate.note}` +
              (gate.excludeBriefKeys.length
                ? ` · 已标剔 brief×${gate.excludeBriefKeys.length}（供 decide 前置，不进 infer 窗）`
                : '') +
              `\n` +
              (gate.raw ? `--- gate raw ---\n${gate.raw.trim()}\n` : ''),
          )
        } else {
          notes.push('复用跳过·无 neighbour→path')
        }
      } else if (skipNestedReuse) {
        notes.push('复用跳过·包标 skipReuse（入口已闸）')
      }

      if (wantExclude.length > 0) {
        const want = new Set(wantExclude)
        const all = useAttentionIo.getState().inferEdges
        const excludeInfers = all
          .filter((e) => want.has(e.inferKey))
          .map((e) => ({
            inferKey: e.inferKey,
            rationale: e.infer || e.rationale,
          }))
        if (excludeInfers.length === 0 && forceExcludeInfer) {
          parts.push(
            `### infer · 拒绝无差分重跑\n排除键无法解析。请钉住 ι 或走监督归因。`,
          )
          notes.push('infer 拒绝 · 排除集空解析')
          continue
        }
        if (excludeInfers.length > 0) {
          notes.push(
            `infer 必排先验 ι×${excludeInfers.length}` +
              (forceExcludeInfer ? ' · 玩法B/监督' : ' · 自动'),
          )
          const main = await runMainInferAndSettle({
            pkg,
            bookIndex: input.bookIndex,
            docId: input.docId,
            keys,
            seeds,
            excludeInfers,
            queryKey: turnQueryKey,
            onProgress: input.onProgress,
            signal: input.signal,
          })
          parts.push(main.part)
          notes.push(main.note)
          continue
        }
      }

      // 首次 infer（无先验 ι）
      const main = await runMainInferAndSettle({
        pkg,
        bookIndex: input.bookIndex,
        docId: input.docId,
        keys,
        seeds,
        queryKey: turnQueryKey,
        onProgress: input.onProgress,
        signal: input.signal,
      })
      parts.push(main.part)
      notes.push(main.note)
      continue
    }

    const win = assembleWindow({
      docId: input.docId,
      bookIndex: input.bookIndex,
      job: pkg.job,
      qNow: pkg.question,
      seeds,
      keys,
      queryKey: turnQueryKey,
      decideCritiqueHint:
        pkg.job === 'decide'
          ? pkg.decideCritiqueHint || seeds[0]?.decideCritiqueHint
          : undefined,
      tocNav: pkg.job === 'decide' ? Boolean(pkg.tocNav) : false,
      tocCatalog:
        pkg.job === 'decide' && pkg.tocNav
          ? pkg.tocCatalog || pkg.decideCritiqueHint
          : undefined,
    })
    notes.push(win.note)
    input.onProgress?.(`写信台 · ${pkg.job} · LLM…`)
    const chat = await flashChat({
      system: win.systemPayload,
      user: win.userPayload,
      temperature: 0.15,
      // decide 12 条 prospect JSON 易撞 length；与 infer 同档
      maxTokens: pkg.job === 'decide' ? 8192 : undefined,
      // thinking 默认关（decide/infer 亦关；见实测全关更稳）
      signal: input.signal,
      ioMeta: {
        job: pkg.job,
        stage: 'dispatch',
        queryKey: turnQueryKey || undefined,
      },
    })
    if (!chat.ok) {
      const earlySkip =
        /已取消|早停/.test(chat.note) || Boolean(input.signal?.aborted)
      parts.push(
        earlySkip
          ? `### ${pkg.job} · 早停跳过\n${chat.note}`
          : `### ${pkg.job} 失败\n${chat.note}`,
      )
      continue
    }
    {
      const llmExpanded =
        pkg.job === 'decide' || pkg.job === 'peek'
          ? expandDoorplatesInLlmText(
              chat.content,
              win.aliasTable,
              extractJsonObject,
            )
          : chat.content

      ingestKeyIncrementStatuses({
        job: pkg.job,
        llmText: llmExpanded,
        windowKeys: keys.map((k) => k.key),
        queryKey:
          turnQueryKey ||
          useAttentionIo.getState().findQueryKeyForQuestion(pkg.question) ||
          undefined,
      })
      // toc_nav：只吃走廊表；禁止当正文 decide 落 prospect / JSON 抢救（否则会丢掉 strand）
      if (pkg.job === 'decide' && pkg.tocNav) {
        notes.push('toc_nav · raw')
        parts.push(`### toc_nav · out\n--- raw ---\n${chat.content.trim()}`)
        continue
      }

      // 一槽一 key：写信台路径也必须 settle，禁止只吐文本不落账
      if (pkg.job === 'decide') {
        const { parseDecideOutcome } = await import('./autoFlow')
        const { filterKeepsAvoidingBadProspects } = await import(
          './prospectIsomorph'
        )
        const decideOut = parseDecideOutcome(llmExpanded)
        const allowed = keys
          .filter((k) => k.kind === 'bookKey' || k.kind === 'briefKey')
          .map((k) => k.key)
        const avoid = pkg.avoidProspectTexts ?? []
        const coerceKeepDoor = (briefKey: string) =>
          resolveWindowDoorplate(briefKey, win.aliasTable) ?? briefKey
        let keeps = decideOut.keeps.map((k) => ({
          ...k,
          briefKey: coerceKeepDoor(k.briefKey),
        }))
        let isoRejected: Array<{ briefKey: string; reason: string }> = []
        let rawForLog = llmExpanded
        let truncated = chat.finishReason === 'length'

        // 仅「真解析失败 / 截断」才抢救重试；合法 JSON 但无 prospect（如全 unread）不重打
        if (
          ((!decideOut.ok && keeps.length === 0) || truncated) &&
          !pkg.edgeId.includes('_json_retry')
        ) {
          input.onProgress?.(
            truncated
              ? '写信台 · decide JSON 截断 → 缩短重试…'
              : '写信台 · decide JSON 不可解析 → 缩短重试…',
          )
          const retryHint =
            (pkg.decideCritiqueHint || '') +
            '\n【JSON 抢救重试】上一轮输出无法完整解析或被截断。' +
            '每个 prospect 单行≤30字；禁止换行与字符串内双引号；' +
            '必须输出完整可解析 JSON；写不完就少写几条，保证括号闭合。' +
            '若 brief 含与 Q 相关专名（如 Lacan/拉康/freudo-lacanien），必须 sufficient 并写明「提到…」。'
          const retryWin = assembleWindow({
            docId: input.docId,
            bookIndex: input.bookIndex,
            job: 'decide',
            qNow: pkg.question,
            seeds,
            keys,
            queryKey: turnQueryKey,
            decideCritiqueHint: retryHint,
          })
          const retryChat = await flashChat({
            system: retryWin.systemPayload,
            user: retryWin.userPayload,
            temperature: 0.1,
            maxTokens: 8192,
            signal: input.signal,
            ioMeta: {
              job: 'decide',
              stage: 'json_retry',
              queryKey: turnQueryKey || undefined,
            },
          })
          if (retryChat.ok) {
            const retryExpanded = expandDoorplatesInLlmText(
              retryChat.content,
              retryWin.aliasTable,
              extractJsonObject,
            )
            const retryOut = parseDecideOutcome(retryExpanded)
            if (retryOut.keeps.length > 0 || retryOut.ok) {
              keeps = retryOut.keeps.map((k) => ({
                ...k,
                briefKey: coerceKeepDoor(k.briefKey),
              }))
              rawForLog = retryExpanded
              truncated = retryChat.finishReason === 'length'
              ingestKeyIncrementStatuses({
                job: 'decide',
                llmText: retryExpanded,
                windowKeys: keys.map((k) => k.key),
                queryKey:
                  turnQueryKey ||
                  useAttentionIo
                    .getState()
                    .findQueryKeyForQuestion(pkg.question) ||
                  undefined,
              })
              parts.push(
                `### decide · JSON重试\nkeeps ${keeps.length} · finish=${retryChat.finishReason}\n--- raw ---\n${retryExpanded.trim()}`,
              )
            }
          }
        }

        // 问核词面命中 ≠ 强制 mint：由 LLM 判「能否答 Q」+ relevance；不再强制重试

        if (avoid.length > 0) {
          const filtered = filterKeepsAvoidingBadProspects(keeps, avoid)
          keeps = filtered.kept
          isoRejected = filtered.rejected
          // 全部同构 → 加强提示再 decide 一次
          if (
            keeps.length === 0 &&
            isoRejected.length > 0 &&
            !pkg.edgeId.includes('_iso_retry')
          ) {
            input.onProgress?.(
              '写信台 · reframe 同构拒铸 → 加强尸检再 decide…',
            )
            const retryHint =
              (pkg.decideCritiqueHint || '') +
              '\n【硬闸重试】上一轮 prospect 与坏框同构已被拒铸。必须给出明显不同的解题可能；禁止复述旧 prospect。'
            const retryWin = assembleWindow({
              docId: input.docId,
              bookIndex: input.bookIndex,
              job: 'decide',
              qNow: pkg.question,
              seeds,
              keys,
              queryKey: turnQueryKey,
              decideCritiqueHint: retryHint,
            })
            const retryChat = await flashChat({
              system: retryWin.systemPayload,
              user: retryWin.userPayload,
              temperature: 0.2,
              maxTokens: 8192,
              signal: input.signal,
              ioMeta: {
                job: 'decide',
                stage: 'avoid_retry',
                queryKey: turnQueryKey || undefined,
              },
            })
            if (retryChat.ok) {
              const retryExpanded = expandDoorplatesInLlmText(
                retryChat.content,
                retryWin.aliasTable,
                extractJsonObject,
              )
              const retryOut = parseDecideOutcome(retryExpanded)
              const again = filterKeepsAvoidingBadProspects(
                retryOut.keeps.map((k) => ({
                  ...k,
                  briefKey: coerceKeepDoor(k.briefKey),
                })),
                avoid,
              )
              keeps = again.kept
              isoRejected = [...isoRejected, ...again.rejected]
              rawForLog = retryExpanded
              ingestKeyIncrementStatuses({
                job: 'decide',
                llmText: retryExpanded,
                windowKeys: keys.map((k) => k.key),
                queryKey:
                  turnQueryKey ||
                  useAttentionIo
                    .getState()
                    .findQueryKeyForQuestion(pkg.question) ||
                  undefined,
              })
              parts.push(
                `### decide · 同构重试\n保留 ${keeps.length} · 仍拒 ${again.rejected.length}\n--- raw ---\n${retryExpanded.trim()}`,
              )
            }
          }
        }
        const settled = useAttentionIo.getState().settleProspects({
          question: pkg.question,
          queryKey: turnQueryKey,
          llmCallId: newLlmCallId('decide'),
          keeps,
          allowedBriefKeys: allowed,
        })
        notes.push(
          `prospect×${settled.prospectKeys.length}` +
            (settled.rejected.length || isoRejected.length
              ? ` · 拒${settled.rejected.length + isoRejected.length}`
              : '') +
            (isoRejected.length ? ` · 同构${isoRejected.length}` : '') +
            (truncated ? ' · truncated' : '') +
            (!decideOut.ok && keeps.length === 0
              ? ` · parse:${decideOut.note}`
              : ''),
        )
        parts.push(
          `### decide · 落账\nprospectKeys: ${settled.prospectKeys.map((k) => `\`${k}\``).join(', ') || '∅'}` +
            (isoRejected.length
              ? `\n同构拒：${isoRejected.map((r) => `${r.briefKey}(${r.reason})`).join('; ')}`
              : '') +
            (truncated ? `\nfinish_reason=length（已尽量抢救完整行）` : '') +
            `\n--- raw ---\n${rawForLog.trim()}`,
        )
      } else if (pkg.job === 'query') {
        const rows = parseQueryNeighbours(chat.content)
          .map((n) => ({
            queryKey:
              expandHistoricQueryKey(n.queryKey, turnQueryKey) || '',
            degree: n.degree,
            reuseEligible: n.reuseEligible,
          }))
          .filter((n) => n.queryKey)
        const nb = useAttentionIo.getState().settleNeighbours({
          nowQuestion: pkg.question,
          nowQueryKey: turnQueryKey,
          llmCallId: newLlmCallId('query'),
          neighbours: rows.map((n) => ({
            historicQueryKey: n.queryKey,
            degree:
              n.degree +
              (n.reuseEligible === true
                ? ' · reuseEligible=true'
                : n.reuseEligible === false
                  ? ' · reuseEligible=false'
                  : ''),
          })),
        })
        notes.push(`neighbour×${nb.neighbourKeys.length}`)
        parts.push(
          `### query · 落账\nneighbourKeys: ${nb.neighbourKeys.map((k) => `\`${k}\``).join(', ') || '∅'}\n--- raw ---\n${chat.content.trim()}`,
        )
      } else if (pkg.job === 'peek') {
        const bookKeys = keys
          .filter((k) => k.kind === 'bookKey')
          .map((k) => k.key)
        const peekCallId = newLlmCallId('peek')
        const peekSettled = settlePeekItemsFromLlm({
          docId: input.docId,
          llmText: llmExpanded,
          allowedBookKeys: bookKeys,
          peekFamilyId: peekCallId,
          hangMode: 'revise',
        })
        notes.push(peekSettled.note)
        parts.push(
          `### peek · 落账\nbriefKeys: ${peekSettled.items.map((i) => `\`${i.briefKey}\``).join(', ') || '∅'}\nllmCallId: \`${peekCallId}\`\n--- raw ---\n${llmExpanded.trim()}`,
        )
      } else {
        parts.push(`### ${pkg.job} · out\n${chat.content.trim()}`)
      }
    }
  }

  const joined = parts.join('\n\n')
  const q =
    input.packages.map((p) => p.question.trim()).find(Boolean) ||
    input.dispatcherNote?.trim() ||
    ''
  // 整条路径落账（新铸 qk 或复用旧 qk）后：有向增量原文回填调度台
  const answer =
    q && notesIndicatePathSettled(notes)
      ? formatDirectedPathIncrementReturn({
          question: q,
          hopOutputs: hopsFromAnswerParts(parts),
          mode: 'auto',
        })
      : joined

  return {
    ok: parts.length > 0,
    answer,
    note: notes.join(' · '),
  }
}
