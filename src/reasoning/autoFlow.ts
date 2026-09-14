/**
 * 自动流（实验分支 · 无 peek）：
 * 0) 可选材料前置
 * 1) 问线：历史 queryKey → neighbour→reuse；否则新铸
 * 2) decide toc_nav：目录框架（strand）→ strand∩A1 全量 → seedBookKeys
 * 3) decide 正文：book+T 分批读完走廊（此阶段不 seedRange 空扩）
 * 4) 有可铸 prospect → infer；infer 判定材料不够才 seedRange→再 decide
 */

import type { BookIndex } from './pipelineA'
import { askDeepSeekWithLetterDesk } from './a1DsChat'
import { newLlmCallId } from './settleMint'
import { useAttentionIo, type LetterDeskPackage } from './attentionIoStore'
import {
  bookKeysForInferFromDecideLineage,
} from './pathLineageBind'
import { expandIncrementSlots, statusAllowsMint } from './settleMint'
import {
  extractJsonObject,
  parseQueryNeighbours,
  salvageProspectObjectsByRegex,
} from './inferPath'
import {
  needsColdPeekPrecondition,
  resolveAskLineBranch,
  listHistoricQueryEntriesForNeighbour,
  expandHistoricQueryKey,
} from './deskEntryGate'
import { selectColdPeekSkeletonKeys } from '../arch/coldPeekSkeleton'
import { resolveToBookKey } from '../arch/noPeekExperiment'
import {
  formatTocCatalogForDecide,
  listTocCorridors,
  parseTocNavStrandRanges,
  closedFromTocDrafts,
} from '../arch/tocDecideNav'
import {
  expandClosedSeedRangesToBookKeys,
  expandStrandRangesToBookKeys,
  closeSeedRangeDrafts,
  parseSeedRangeDraft,
  type SeedRange,
  type SeedRangeDraft,
} from './seedRange'
import {
  prioritizeBookKeysByQCore,
} from '../arch/qCoreBookHits'
import {
  mergeHotPeekCandidates,
  stashHungerForIngest,
} from './ingestLlmFeed'
import { chunkUniqueKeys, runBatchesParallel } from '../arch/parallelLlmBatch'
import { deskMonitorAttentionArrival } from './attentionArrival'
import {
  formatDirectedPathIncrementReturn,
  hopsFromAnswerParts,
} from './pathIncrementReturn'
import {
  normalizeRelevance,
  relevanceAllowsInfer,
  MIN_PROSPECT_RELEVANCE,
} from '../arch/prospectRelevance'
import {
  normalizeIncrementStatus,
  type IncrementReadStatus,
} from './keyIncrementStatus'

/** 单问内：infer 判定不够后，最多再 seedRange→decide→infer 的外圈次数（不含首轮） */
const MAX_HOT_PEEK = 2
const MAX_DECIDE_ROUNDS = 6
/** 单次 decide 窗 brief 上限：过大易撞 max_tokens 截断 JSON */
const DECIDE_BATCH = 6
/** decide 真并行并发路上限 */
const DECIDE_CONCURRENCY = 3
/** 可铸 prospect 累计达到此数才早停进 infer（走廊扫尽则有多少进多少） */
const MIN_DECIDE_PROSPECTS = 10

function sid(): string {
  return `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** @deprecated 整窗 coverage 已废；仅兼容旧 JSON，勿作调度闸 */
export function normalizeDecideCoverage(raw: string): string {
  const s = raw.trim()
  const lower = s.toLowerCase()
  if (
    lower === 'enough' ||
    lower === 'partial' ||
    lower === 'insufficient'
  ) {
    return lower
  }
  if (
    /足以|足够|够了|可以回应|已覆盖|材料够|够用|commit|enough/.test(s) ||
    /足以回应|多角度.*够|核心.*覆盖/.test(s)
  ) {
    return 'enough'
  }
  if (/peek|扩搜|还要贴|缺材料|不够看/.test(s)) {
    return 'insufficient'
  }
  if (/部分|未全|还要滚|续滚|partial|继续看/.test(s)) {
    return 'partial'
  }
  return lower.slice(0, 48) || 'unknown'
}

export function parseDecideOutcome(llmText: string): {
  briefKeys: string[]
  keeps: Array<{
    briefKey: string
    prospect: string
    status: IncrementReadStatus | null
    relevance: number | null
  }>
  lastBriefKey: string | null
  /** @deprecated 勿作闸；仅日志 */
  coverage: string | null
  stopReason: string | null
  /** 早写草案（可半开）；热启前须经台闭集化 */
  seedRangeDraft: SeedRangeDraft | null
  /** 多段 seedRanges[]（目录导航可一次点多章） */
  seedRangeDrafts: SeedRangeDraft[]
  /** @deprecated 仅当草案为闭集时填充；热启请走闭集化 */
  seedRange: SeedRange | null
  ok: boolean
  note: string
} {
  let obj = extractJsonObject(llmText)
  // 再降一档：整段 JSON 废了也用正则捞已写完的 prospect 行
  if (!obj || typeof obj !== 'object') {
    const loose = salvageProspectObjectsByRegex(llmText)
    if (loose.length === 0) {
      return {
        briefKeys: [],
        keeps: [],
        lastBriefKey: null,
        coverage: null,
        stopReason: null,
        seedRangeDraft: null,
        seedRangeDrafts: [],
        seedRange: null,
        ok: false,
        note: 'decide 硬闸：无法解析 JSON',
      }
    }
    obj = { prospects: loose }
  }
  const root = obj as Record<string, unknown>
  const lastBriefKey = String(root.lastBriefKey ?? '').trim() || null
  const coverageRaw = String(root.coverage ?? '').trim()
  const coverage = coverageRaw ? normalizeDecideCoverage(coverageRaw) : null
  const stopReason = String(root.stopReason ?? '').trim() || null
  const seedRangeDrafts: SeedRangeDraft[] = []
  const pushDraft = (raw: unknown) => {
    const d = parseSeedRangeDraft(raw)
    if (d) seedRangeDrafts.push(d)
  }
  // 有 seedRanges[] 时忽略单条 seedRange，避免巨跨度 from–to 盖住多章
  if (Array.isArray(root.seedRanges) && root.seedRanges.length > 0) {
    for (const row of root.seedRanges) pushDraft(row)
  } else {
    pushDraft(root.seedRange)
  }
  const seedRangeDraft = seedRangeDrafts[0] ?? null
  const seedRange =
    seedRangeDraft?.kind === 'closed'
      ? { from: seedRangeDraft.from, to: seedRangeDraft.to }
      : null

  const briefKeys: string[] = []
  const keeps: Array<{
    briefKey: string
    prospect: string
    status: IncrementReadStatus | null
    relevance: number | null
  }> = []

  const pushKeep = (
    briefKey: string,
    prospect: string,
    status: IncrementReadStatus | null,
    relevance: number | null,
  ) => {
    const bk = briefKey.trim()
    const text = prospect.trim()
    if (!bk) return
    briefKeys.push(bk)
    if (!text) return
    keeps.push({ briefKey: bk, prospect: text, status, relevance })
  }

  const ingestDecideRow = (r: Record<string, unknown>) => {
    // 实验：bookKey 优先；briefKey 字段亦可回传同一门牌
    const bk = String(r.bookKey ?? r.briefKey ?? r.key ?? '').trim()
    if (!bk) return
    const rowStatus = normalizeIncrementStatus(r.status ?? r.readStatus)
    const rowRel = normalizeRelevance(
      r.relevance ?? r.score ?? r.rel ?? r.相关度,
    )
    const slots = expandIncrementSlots(r.prospect, r.prospects)
    if (slots.length === 0) {
      briefKeys.push(bk)
      return
    }
    for (const slot of slots) {
      const slotStatus =
        normalizeIncrementStatus(slot.statusRaw) ?? rowStatus
      const slotRel = normalizeRelevance(slot.relevance) ?? rowRel
      pushKeep(bk, slot.text, slotStatus, slotRel)
    }
  }

  // 主协议 prospects[]（keep[] 已废除）
  if (Array.isArray(root.prospects)) {
    for (const row of root.prospects) {
      if (!row || typeof row !== 'object') continue
      ingestDecideRow(row as Record<string, unknown>)
    }
  }

  // 结构化抠完仍空 → 正则补漏（字段乱序 / 半截 JSON）
  if (keeps.length === 0 && briefKeys.length === 0) {
    for (const row of salvageProspectObjectsByRegex(llmText)) {
      ingestDecideRow(row)
    }
  }

  const mintable = keeps.filter(
    (k) => statusAllowsMint(k.status) && relevanceAllowsInfer(k.relevance),
  )
  // toc_nav：seedRanges 可能是 fromStrand/toStrand，parseSeedRangeDraft 不认书序门牌
  const hasStrandNav =
    Array.isArray(root.seedRanges) &&
    root.seedRanges.some((row) => {
      if (!row || typeof row !== 'object') return false
      const r = row as Record<string, unknown>
      return (
        r.fromStrand != null ||
        r.toStrand != null ||
        r.startStrand != null ||
        r.endStrand != null ||
        r.sectionIndex != null
      )
    })
  const hasAny =
    mintable.length > 0 ||
    briefKeys.length > 0 ||
    keeps.length > 0 ||
    seedRangeDrafts.length > 0 ||
    hasStrandNav ||
    (stopReason === 'expand' && Array.isArray(root.seedRanges)) ||
    Array.isArray(root.keyStatuses) ||
    Array.isArray(root.keyStatus) ||
    Array.isArray(root.statuses)

  if (!hasAny) {
    return {
      briefKeys: [],
      keeps: [],
      lastBriefKey,
      coverage,
      stopReason,
      seedRangeDraft,
      seedRangeDrafts,
      seedRange,
      ok: false,
      note: 'decide 硬闸：无 prospects/keyStatuses',
    }
  }

  return {
    briefKeys: [...new Set(briefKeys)],
    keeps,
    lastBriefKey,
    coverage,
    stopReason,
    seedRangeDraft,
    seedRangeDrafts,
    seedRange,
    ok: true,
    note:
      `decide · 三态驱动` +
      (coverage ? ` · (旧coverage=${coverage}忽略调度)` : '') +
      (stopReason ? ` · stop=${stopReason}` : '') +
      (seedRangeDraft
        ? ` · seedDraft=${seedRangeDraft.kind}`
        : '') +
      (seedRangeDrafts.length > 1
        ? ` · seedRanges×${seedRangeDrafts.length}`
        : '') +
      ` · prospect槽×${keeps.length} · 可铸×${mintable.length}`,
  }
}

/** @deprecated 用 parseDecideOutcome */
export function parseDecideKeepBriefKeys(llmText: string): string[] {
  return parseDecideOutcome(llmText).briefKeys
}

async function runStageA(input: {
  question: string
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
}): Promise<{
  neighbours: Array<{
    queryKey: string
    degree: string
    reuseEligible?: boolean
  }>
  raw: string
  note: string
}> {
  const turnQk =
    useAttentionIo.getState().findQueryKeyForQuestion(input.question) ||
    useAttentionIo.getState().ensureQueryKey(input.question)
  const entries = listHistoricQueryEntriesForNeighbour(turnQk)
  if (entries.length === 0) {
    return { neighbours: [], raw: '', note: '阶段A跳过·无历史 queryKey（已排除 Q_now）' }
  }
  const pkg: LetterDeskPackage = {
    id: sid(),
    edgeId: `stageA_${sid()}`,
    bookKey: '',
    briefKey: '',
    question: input.question,
    job: 'query',
    versionIndex: 0,
    createdAt: Date.now(),
  }
  const res = await askDeepSeekWithLetterDesk({
    question: input.question,
    packages: [pkg],
    bookIndex: input.bookIndex,
    docId: input.bookIndex.docId,
    onProgress: input.onProgress,
  })
  let neighbours = parseQueryNeighbours(res.answer)
    .map((n) => ({
      queryKey: expandHistoricQueryKey(n.queryKey, turnQk) || '',
      degree: n.degree,
      reuseEligible: n.reuseEligible,
    }))
    .filter((n) => n.queryKey)
  // 禁止「解析空 → 全历史当 neighbour」：那会把 brief 队列打成整表
  if (neighbours.length === 0) {
    return {
      neighbours: [],
      raw: res.answer,
      note:
        (res.note || '阶段A') +
        ' · neighbour 解析空（不兜底全历史）',
    }
  }
  return {
    neighbours,
    raw: res.answer,
    note: res.note || `阶段A · neighbour×${neighbours.length}`,
  }
}

/** 邻域/骨架前置仍用小帽；toc 走廊改为全量入队（见 TOC_CORRIDOR_HARD_CAP） */
const DECIDE_BRIEF_CAP = 24
/** toc strand∩A1 全量入 decide 的硬顶（防单条巨跨度盖全书） */
const TOC_CORRIDOR_HARD_CAP = 400

function briefQueueAfterStageA(
  docId: string,
  neighbourQueryKeys: string[],
  bookIndex: BookIndex,
): string[] {
  const st = useAttentionIo.getState()
  const ordered: string[] = []
  const seen = new Set<string>()
  const pushParent = (raw: string) => {
    const k = raw.trim()
    if (!k) return
    // 旧 peek 的 bh_peek_* / briefKey → 书门；已是 bookKey 则原样
    const book =
      resolveToBookKey(docId, bookIndex, k) ||
      (bookIndex.chunks.some((c) => c.key === k) ? k : null)
    if (!book || seen.has(book)) return
    seen.add(book)
    ordered.push(book)
  }
  for (const qk of neighbourQueryKeys) {
    for (const path of st.listPathsForQueryKey(qk)) {
      const prospect = st.prospects.find(
        (p) => p.prospectKey === path.prospectKey,
      )
      if (prospect?.briefKey) pushParent(prospect.briefKey)
      const edge = st.inferEdges.find((e) => e.inferKey === path.inferKey)
      for (const bk of edge?.bookKeys ?? []) pushParent(bk)
    }
    for (const bk of st.queryKeyToBriefKeys[qk] ?? []) pushParent(bk)
  }
  return ordered.slice(0, DECIDE_BRIEF_CAP)
}

function attachBriefsToQuestion(
  q: string,
  briefKeys: string[],
  queryKey?: string,
) {
  useAttentionIo.setState((s) => {
    const questionToBriefKeys = {
      ...s.questionToBriefKeys,
      [q]: [...new Set([...(s.questionToBriefKeys[q] ?? []), ...briefKeys])],
    }
    const queryKeyToBriefKeys = { ...s.queryKeyToBriefKeys }
    if (queryKey?.trim()) {
      const qk = queryKey.trim()
      queryKeyToBriefKeys[qk] = [
        ...new Set([...(queryKeyToBriefKeys[qk] ?? []), ...briefKeys]),
      ]
    }
    return { questionToBriefKeys, queryKeyToBriefKeys }
  })
}

/** 三态调度（decide 阶段）：可铸≥门槛 → infer；未达门槛则续滚未读；走廊尽则有多少进多少 */
function decideRoundAction(input: {
  scope: string[]
  mintableCount: number
  queryKey: string
}): 'done' | 'continue_unread' | 'pause' {
  if (input.mintableCount >= MIN_DECIDE_PROSPECTS) return 'done'

  const st = useAttentionIo.getState()
  const scopeSet = new Set(input.scope)
  const qScope = { queryKey: input.queryKey }
  const unread = st
    .listKeysUnread('decide', qScope)
    .filter((k) => scopeSet.has(k))

  if (unread.length > 0) return 'continue_unread'
  // 走廊已尽：不够 10 也带着现有 prospect 进 infer
  if (input.mintableCount > 0) return 'done'
  return 'pause'
}

/**
 * 拼 decide 书门队列（无 BM25）：邻域已解 book ∪ 骨架兜底。
 * 首跳主路径改为目录 toc_nav → strand∩A1 → seedBookKeys。
 */
async function assembleDecideSeedBookKeys(input: {
  question: string
  bookIndex: BookIndex
  docId: string
  neighbourBookKeys: string[]
  cap: number
}): Promise<{ keys: string[]; note: string }> {
  void input.question
  void input.docId
  const seen = new Set<string>()
  const keys: string[] = []
  const push = (raw: string) => {
    const k = raw.trim()
    if (!k || seen.has(k)) return
    if (!input.bookIndex.chunks.some((c) => c.key === k)) return
    seen.add(k)
    keys.push(k)
  }

  let neighbourN = 0
  for (const k of input.neighbourBookKeys) {
    if (keys.length >= input.cap) break
    const before = keys.length
    push(k)
    if (keys.length > before) neighbourN++
  }

  let skeletonN = 0
  if (keys.length < Math.min(6, input.cap)) {
    const skeleton = selectColdPeekSkeletonKeys({
      bookIndex: input.bookIndex,
      semantic: null,
    })
    for (const k of skeleton) {
      if (keys.length >= input.cap) break
      const before = keys.length
      push(k)
      if (keys.length > before) skeletonN++
    }
  }

  if (keys.length === 0) {
    for (const c of input.bookIndex.chunks) {
      if (keys.length >= input.cap) break
      push(c.key)
    }
  }

  return {
    keys: keys.slice(0, input.cap),
    note:
      `seedBookKeys×${keys.length}` +
      ` · 邻域×${neighbourN}` +
      ` · 骨架补×${skeletonN}` +
      ` · （首跳优先 toc_nav，无 BM25）`,
  }
}

/** 单问安全阀 / 暂停 → 写信台提示（不进注意力窗） */
function deskPromptSafety(msg: string) {
  useAttentionIo.getState().setDeskPrompt(msg)
  useAttentionIo.getState().setLastStatus(msg)
}

export async function runAutoFlow(input: {
  question: string
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
  sealItems: (items: Array<{
    key: string
    brief: string
    briefKey: string
    bookText?: string
  }>) => Array<{
    key: string
    brief: string
    briefKey: string
    bookText?: string
    bondId: string
  }>
  /**
   * 监督预测轨续跑：禁止采纳这些坏 path。
   * 其它 neighbour 线上 path 仍可 reuse（禁死路 ≠ 禁一切历史）。
   */
  excludePathKeys?: string[]
  /** @deprecated 用 excludePathKeys；true 时等价于不跑 reuse（过刚，仅兼容） */
  skipReuse?: boolean
  /** 写入 decide 窗的监督尸检策略（预测轨） */
  decideCritiqueHint?: string
  /** 进入 decide 前剔除的死路 brief */
  excludeBriefKeys?: string[]
}): Promise<{ ok: boolean; answer: string; note: string }> {
  const q = input.question.trim()
  if (!q) {
    return { ok: false, answer: '', note: '自动流需要问句' }
  }

  const parts: string[] = []
  const notes: string[] = []
  const docId = input.bookIndex.docId
  // 本轮唯一 queryKey（方案 B settle）；贯穿 decide/prospect/infer/path/reuse
  const turnQueryKey = useAttentionIo.getState().ensureQueryKey(q)
  if (input.skipReuse) notes.push('skipReuse')
  if (input.excludePathKeys?.length) {
    notes.push(`excludePath×${input.excludePathKeys.length}`)
  }
  if (input.decideCritiqueHint?.trim()) notes.push('decideCritiqueHint')

  // —— 层 0：材料前置（实验：无 peek LLM，骨架 bookKey 直入 decide 队列）——
  let sealedBriefKeys: string[] = []
  let sealedItems: Array<{
    key: string
    brief: string
    briefKey: string
    bondId?: string
  }> = []
  let stepId = ''

  if (needsColdPeekPrecondition(docId)) {
    input.onProgress?.(
      '自动流 · 材料前置 · Q检索+骨架 seedBookKeys（实验·无 peek）…',
    )
    notes.push(`材料前置·seedBookKeys·qk=${turnQueryKey}`)
    const pack = await assembleDecideSeedBookKeys({
      question: q,
      bookIndex: input.bookIndex,
      docId,
      neighbourBookKeys: [],
      cap: DECIDE_BRIEF_CAP,
    })
    if (pack.keys.length === 0) {
      return {
        ok: false,
        answer: '',
        note: 'seedBookKeys 空：A1 无 bookKey，自动流中止',
      }
    }
    sealedBriefKeys = pack.keys
    sealedItems = sealedBriefKeys.map((bk) => ({
      key: bk,
      brief: '',
      briefKey: bk,
    }))
    attachBriefsToQuestion(q, sealedBriefKeys, turnQueryKey)
    parts.push(
      `### 自动流 · 材料前置 · seedBookKeys（无 peek）\n${pack.note}`,
    )
    notes.push(pack.note)
  }

  // —— 层 1：问线分叉（历史 queryKey → 复用前置；否则新铸）——
  // 必须排除本轮刚 ensure 的 qk；勿用「账上有任意 qk」误判有历史
  const askBranch = resolveAskLineBranch(turnQueryKey)
  notes.push(`问线·${askBranch.kind}·qk=${turnQueryKey}`)

  if (askBranch.kind === 'try_reuse') {
    input.onProgress?.('自动流 · 问线复用前置（历史 queryKey → neighbour→norm）…')
    const a = await runStageA({
      question: q,
      bookIndex: input.bookIndex,
      onProgress: input.onProgress,
    })
    parts.push(
      `### 自动流 · 阶段 A\nneighbours=${a.neighbours.map((n) => `${n.queryKey}(${n.degree || '·'})`).join(', ') || '∅'}`,
    )
    notes.push(a.note)
    {
      const { ingestKeyIncrementStatuses } = await import('./attentionArrival')
      const historic = listHistoricQueryEntriesForNeighbour(turnQueryKey).map(
        (e) => e.queryKey,
      )
      ingestKeyIncrementStatuses({
        job: 'query',
        llmText: a.raw,
        windowKeys: historic,
        queryKey: turnQueryKey,
      })
    }
    // 阶段 A 解析的 neighbour 必须落账；禁止「query 空 → 兜底含norm」绕过 query 硬闸
    const neighbourRows = a.neighbours as Array<{
      queryKey: string
      degree: string
      reuseEligible?: boolean
    }>
    if (neighbourRows.length > 0) {
      const nb = useAttentionIo.getState().settleNeighbours({
        nowQuestion: q,
        nowQueryKey: turnQueryKey,
        llmCallId: newLlmCallId('query'),
        neighbours: neighbourRows.map((n) => ({
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
      notes.push(`neighbour落账×${nb.neighbourKeys.length}`)
    } else {
      notes.push('neighbour×0·query未点名（不兜底冒充）')
    }
    const neighbourBooks = briefQueueAfterStageA(
      docId,
      neighbourRows.map((n) => n.queryKey),
      input.bookIndex,
    )
    input.onProgress?.('自动流 · 拼 seedBookKeys（邻域 ∪ 骨架；首跳靠 toc_nav）…')
    {
      const pack = await assembleDecideSeedBookKeys({
        question: q,
        bookIndex: input.bookIndex,
        docId,
        neighbourBookKeys: neighbourBooks,
        cap: DECIDE_BRIEF_CAP,
      })
      sealedBriefKeys = pack.keys
      notes.push(pack.note)
      parts.push(`### 自动流 · seedBookKeys\n${pack.note}`)
    }

    const { reuseAuthorizedHistoricKeys } = await import('./queryReuseAuth')
    const reuseOkKeys = reuseAuthorizedHistoricKeys(neighbourRows)
    const queryOpensReuse = reuseOkKeys.length > 0

    if (input.skipReuse) {
      notes.push('复用跳过·兼容 skipReuse')
      parts.push('### 自动流 · 跳过 reuse（兼容）')
    } else if (!queryOpensReuse) {
      notes.push(
        neighbourRows.length === 0
          ? '复用跳过·query未点名邻域'
          : `复用跳过·query硬闸未授权（邻域×${neighbourRows.length}·均非完整复用）`,
      )
      parts.push(
        '### 自动流 · query 硬闸：不授权 reuse\n' +
          (neighbourRows.length === 0
            ? '无 neighbour → 直接新铸'
            : `neighbour×${neighbourRows.length} 仅喂 seed；未达完整复用 → 不烧 reuse LLM`),
      )
    } else {
      input.onProgress?.('自动流 · query已授权 → reuse（neighbour→path→norm）…')
      const { runReuseGate } = await import('./letterDeskDispatch')
      const gate = await runReuseGate({
        qNow: q,
        docId,
        queryKey: turnQueryKey,
        excludePathKeys: input.excludePathKeys,
        excludeNormKeys:
          useAttentionIo.getState().pendingReuseWait?.exhaustedNormKeys,
        onlyHistoricQueryKeys: reuseOkKeys,
        onProgress: input.onProgress,
      })
      notes.push(gate.note)
      parts.push(
        gate.awaitingMoreNorms
          ? `### 自动流 · 复用停泊\n${gate.note}\nawaiting=${(gate.awaitingHistoricQueryKeys ?? []).join(', ') || '·'}`
          : gate.awaitingApproval
            ? `### 自动流 · 复用提案挂起 ×${gate.normKeys?.length ?? 1}\nnorms=${(gate.normKeys ?? []).join(', ') || '·'} · 待批准`
            : gate.adopted
              ? `### 自动流 · 复用采纳 ×${gate.pathKeys?.length ?? 1}\nnorms=${(gate.normKeys ?? []).join(', ') || '·'} · paths=${(gate.pathKeys ?? [gate.pathKey]).join(', ')}`
              : `### 自动流 · 复用未采纳 → 落入新铸\n${gate.note}`,
      )
      if (gate.awaitingMoreNorms) {
        useAttentionIo.getState().setDeskPrompt(
          `复用停泊 · 等历史问确认 path 后续跑 · qk=${gate.queryKey ?? turnQueryKey}` +
            (gate.awaitingHistoricQueryKeys?.length
              ? ` · 待：${gate.awaitingHistoricQueryKeys.map((k) => k.slice(0, 18)).join(',')}`
              : ''),
        )
        notes.push('复用停泊·等历史问铸 norm')
        return {
          ok: true,
          answer:
            parts.join('\n\n') +
            `\n\n### 复用停泊\n` +
            `queryKey=\`${gate.queryKey ?? turnQueryKey}\`\n` +
            `awaitingHistoric: ${(gate.awaitingHistoricQueryKeys ?? [])
              .map((k) => `\`${k}\``)
              .join(', ')}\n` +
            `exhaustedNorm×${gate.exhaustedNormKeys?.length ?? 0}\n` +
            `确认这些历史问的 path（铸 norm）后会续跑复用闸；勿直接新铸。`,
          note: `自动流 · ${notes.join(' → ')}`,
        }
      }
      if (gate.awaitingApproval) {
        useAttentionIo.getState().setDeskPrompt(
          `写信台 · 复用提案：批准铸 reuse→norm，或撤销后落入新铸。qk=${gate.queryKey ?? turnQueryKey}`,
        )
        notes.push('等待用户批准复用')
        return {
          ok: true,
          answer:
            parts.join('\n\n') +
            `\n\n### 等待复用批准\n` +
            `queryKey=\`${gate.queryKey ?? turnQueryKey}\`\n` +
            `normKeys: ${(gate.normKeys ?? []).map((k) => `\`${k}\``).join(', ')}\n` +
            `pathKeys: ${(gate.pathKeys ?? []).map((k) => `\`${k}\``).join(', ')}\n` +
            `请在结算面板批准 / 撤销。`,
          note: `自动流 · ${notes.join(' → ')}`,
        }
      }
      if (gate.adopted) {
        const pathReturn = formatDirectedPathIncrementReturn({
          question: q,
          hopOutputs: hopsFromAnswerParts(parts),
          mode: 'reuse',
          queryKey: turnQueryKey,
        })
        useAttentionIo.getState().setLastStatus(`自动流 · 复用完成 · ${notes.join(' → ')}`)
        useAttentionIo.getState().clearDeskPrompt()
        return {
          ok: true,
          answer: pathReturn,
          note: `自动流 · ${notes.join(' → ')}`,
        }
      }
      const st = useAttentionIo.getState()
      // 只剔：本问族 decide insufficient +「本问自己」失败 path brief（跨问邻域材料勿剔）
      const excludeBriefs = new Set<string>(gate.excludeBriefKeys ?? [])
      const qScope = { queryKey: turnQueryKey }
      for (const k of st.listKeysNeedingMore('decide', qScope)) {
        excludeBriefs.add(k)
      }
      if (excludeBriefs.size > 0) {
        sealedBriefKeys = sealedBriefKeys.filter((b) => !excludeBriefs.has(b))
        const unread = st
          .listKeysUnread('decide', qScope)
          .filter((k) => !excludeBriefs.has(k))
        sealedBriefKeys = [...new Set([...sealedBriefKeys, ...unread])]
        notes.push(
          `精细剔除 path/本问不足 brief×${excludeBriefs.size} · 余 ${sealedBriefKeys.length}（同门其余保留；邻域旧问材料不剔）`,
        )
        parts.push(
          `### 自动流 · 复用失败后精细剔除\n本问失败 path brief ∪ 本问族 insufficient×${excludeBriefs.size} · 余 ${sealedBriefKeys.length}`,
        )
      }
      useAttentionIo.getState().setDeskPrompt(
        `复用不够 · 新铸 decide/infer · ${q.slice(0, 40)}`,
      )
    }
  } else {
    // mint：无历史问线，不跑阶段 A / reuse
    input.onProgress?.('自动流 · 问线新铸（无历史 queryKey，跳过 reuse）…')
    if (sealedBriefKeys.length === 0) {
      const pack = await assembleDecideSeedBookKeys({
        question: q,
        bookIndex: input.bookIndex,
        docId,
        neighbourBookKeys: [],
        cap: DECIDE_BRIEF_CAP,
      })
      sealedBriefKeys = pack.keys
      notes.push(pack.note)
      parts.push(`### 自动流 · 问线新铸 · seedBookKeys\n${pack.note}`)
    } else {
      notes.push(`新铸 · 沿用前置 seedBookKeys×${sealedBriefKeys.length}`)
      parts.push(
        `### 自动流 · 问线新铸\n沿用前置 seedBookKeys×${sealedBriefKeys.length}`,
      )
    }
  }

  if (sealedBriefKeys.length === 0) {
    return {
      ok: false,
      answer: parts.join('\n\n'),
      note: `自动流中止 · 无 book 可 decide · ${notes.join(' → ')}`,
    }
  }

  // 统一硬帽：decide 窗不得打成整表
  if (sealedBriefKeys.length > DECIDE_BRIEF_CAP) {
    sealedBriefKeys = sealedBriefKeys.slice(0, DECIDE_BRIEF_CAP)
    notes.push(`decide book 帽×${DECIDE_BRIEF_CAP}`)
  }

  // 监督预测轨：先剔死路材料父门（在 attach 之前）
  if (input.excludeBriefKeys && input.excludeBriefKeys.length > 0) {
    const drop = new Set(input.excludeBriefKeys)
    const before = sealedBriefKeys.length
    sealedBriefKeys = sealedBriefKeys.filter((b) => !drop.has(b))
    notes.push(`监督剔 book×${drop.size} · ${before}→${sealedBriefKeys.length}`)
    parts.push(
      `### 自动流 · 监督剔除死路 book\n剔×${drop.size} · 余 ${sealedBriefKeys.length}`,
    )
    if (sealedBriefKeys.length === 0) {
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · 监督剔除后无 book · ${notes.join(' → ')}`,
      }
    }
  }

  attachBriefsToQuestion(q, sealedBriefKeys, turnQueryKey)

  // 深化子问：父链已有 prospect、本问尚无 → 跳过 decide，材料继承后直开 infer
  const stLine = useAttentionIo.getState()
  const parentQk = stLine.getQueryParent(turnQueryKey)
  const familyQks = new Set(stLine.listQuerySelfAndAncestors(turnQueryKey))
  const parentProspects = stLine.prospects.filter((p) => familyQks.has(p.queryKey))
  const ownProspects = stLine.prospects.filter((p) => p.queryKey === turnQueryKey)
  const deepenSkipDecide =
    Boolean(parentQk) && parentProspects.length > 0 && ownProspects.length === 0

  if (deepenSkipDecide) {
    notes.push(
      `深化·跳过decide · parent=${parentQk} · 继承prospect×${parentProspects.length}`,
    )
    parts.push(
      `### 自动流 · 深化继承\n跳过 decide；沿用父链 prospect×${parentProspects.length}；infer 用深化 Q 控方向`,
    )
    // 递送用父链充分 brief（已在 sealedBriefKeys / 继承）
    const briefKeys = [
      ...new Set(
        parentProspects
          .map((p) => p.briefKey)
          .filter(Boolean),
      ),
    ]
    if (briefKeys.length === 0) {
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · 深化无父 prospect brief · ${notes.join(' → ')}`,
      }
    }
    sealedBriefKeys = [...new Set([...sealedBriefKeys, ...briefKeys])]

    input.onProgress?.('自动流 · 深化 · 直开 infer…')
    const deepenLineage = bookKeysForInferFromDecideLineage({
      docId,
      mintableBriefKeys: briefKeys,
      prospects: parentProspects,
      deskDeliveries: useAttentionIo.getState().deskDeliveries,
    })
    const bookKeys = deepenLineage.bookKeys
    notes.push(
      `深化血缘 book×${bookKeys.length}` +
        (deepenLineage.unmappedBriefKeys.length
          ? ` · 未映brief×${deepenLineage.unmappedBriefKeys.length}`
          : '') +
        (deepenLineage.orphanProspectKeys.length
          ? ` · 无book prospect×${deepenLineage.orphanProspectKeys.length}`
          : ''),
    )
    if (bookKeys.length === 0) {
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · 深化 prospect→brief→book 血缘无解 · ${notes.join(' → ')}`,
      }
    }
    const mainPkg: LetterDeskPackage = {
      id: sid(),
      edgeId: `${stepId || 'infer_deepen'}_${bookKeys[0]}`,
      bookKey: bookKeys[0]!,
      briefKey: deepenLineage.pairs[0]?.briefKey || briefKeys[0] || '',
      question: q,
      job: 'infer',
      versionIndex: 0,
      createdAt: Date.now(),
      onlyBookKeys: bookKeys,
    }
    const mainRes = await askDeepSeekWithLetterDesk({
      question: q,
      packages: [mainPkg],
      bookIndex: input.bookIndex,
      docId,
      onProgress: input.onProgress,
      turnQueryKey,
    })
    parts.push(mainRes.answer || '### infer · （空）')
    notes.push(mainRes.note)
    const mainFailed =
      !mainRes.ok ||
      /空内容|失败|HTTP|无 choices|请求失败/.test(mainRes.note)
    if (mainFailed) {
      deskPromptSafety(
        `写信台 · 深化 infer 未写出（${mainRes.note}）。可钉窗重跑或改深化问法。`,
      )
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流 · 深化 infer 失败 · ${notes.join(' → ')}`,
      }
    }
    deskMonitorAttentionArrival({
      job: 'infer',
      llmText: mainRes.answer,
      windowKeys: bookKeys,
      queryKey: turnQueryKey,
    })
    const pending = useAttentionIo.getState().pendingPathMatch
    const userPaths = useAttentionIo
      .getState()
      .listPathsForQueryKey(turnQueryKey)
      .filter((p) => p.matchMode === 'user')
    if (userPaths.length === 0 && pending) {
      useAttentionIo.getState().setDeskPrompt(
        `写信台 · 深化后 path：候选 pathKey×${pending.pathKeys?.length ?? 0} · 结算面确认/撤销` +
          ` · qk=${pending.queryKey}`,
      )
      notes.push('等待 path 确认/撤销（深化）')
      return {
        ok: true,
        answer:
          parts.join('\n\n') +
          `\n\n### 等待 path（深化 · 只亮 pathKey + bookKey）\n` +
          `queryKey=\`${pending.queryKey}\`\n` +
          `pathKeys×${pending.pathKeys?.length ?? 0}:\n` +
          (pending.boundPairs ?? [])
            .map(
              (p) =>
                `- path=\`${p.pathKey}\` · conclusion=${(p.conclusion ?? '').slice(0, 48) || '∅'} · book=${(p.bookKeysSequence ?? p.sharedBookKeys).join(',') || '∅'}`,
            )
            .join('\n'),
        note: `自动流 · ${notes.join(' → ')}`,
      }
    }
    const pathReturn = formatDirectedPathIncrementReturn({
      question: q,
      hopOutputs: hopsFromAnswerParts(parts),
      mode: 'auto',
      queryKey: turnQueryKey,
    })
    useAttentionIo
      .getState()
      .setLastStatus(`自动流完成 · ${notes.join(' → ')}`)
    useAttentionIo.getState().clearDeskPrompt()
    return {
      ok: true,
      answer: pathReturn,
      note: `自动流 · ${notes.join(' → ')}`,
    }
  }

  // 三态：decide 优先本问族 sufficient ∪ unread；无本问状态则全量本问队列
  {
    const st = useAttentionIo.getState()
    const qScope = { queryKey: turnQueryKey }
    const ready = new Set(st.listKeysReadyToDeliver('decide', qScope))
    const unread = new Set(st.listKeysUnread('decide', qScope))
    if (ready.size > 0 || unread.size > 0) {
      const filtered = sealedBriefKeys.filter(
        (k) => ready.has(k) || unread.has(k),
      )
      if (filtered.length > 0) {
        sealedBriefKeys = filtered
        notes.push(`本问三态过滤 brief×${sealedBriefKeys.length}`)
      }
    }
  }

  let decideOut: ReturnType<typeof parseDecideOutcome> | null = null
  let decideScope: string[] | undefined
  let hotPeekCount = 0
  /** 跨轮早写草案；热启前统一闭集化 */
  const allSeedDrafts: SeedRangeDraft[] = []
  /** 本轮 decide 晚执行闭集（供热启；半开未配不上的不进） */
  let lastClosedForPeek: SeedRange[] = []
  /** 本问已落账的 prospect 累计（分批 decide 合并） */
  const allMintableKeeps: Array<{
    briefKey: string
    prospect: string
    status: IncrementReadStatus | null
    relevance: number | null
  }> = []

  // —— 目录导航首轮：校准 strand 走廊 → LLM 吐 strand → 台 strand∩A1 全量 → decide ——
  {
    let semantic: import('./semanticIndex').BookSemanticIndex | null = null
    try {
      const { useIndexGate } = await import('./indexGate')
      semantic = useIndexGate.getState().semanticIndex ?? null
    } catch {
      /* optional */
    }
    const corridors = listTocCorridors(semantic, input.bookIndex)
    if (corridors.length > 0) {
      const catalog = formatTocCatalogForDecide(corridors)
      input.onProgress?.(
        `自动流 · decide · toc_nav 目录导航（章×${corridors.length}）…`,
      )
      const tocPkg: LetterDeskPackage = {
        id: sid(),
        edgeId: `${stepId || 'decide'}_toc_nav`,
        bookKey: '',
        briefKey: '',
        question: q,
        job: 'decide',
        versionIndex: 0,
        createdAt: Date.now(),
        onlyBookKeys: [],
        tocNav: true,
        tocCatalog: catalog,
      }
      const tocRes = await askDeepSeekWithLetterDesk({
        question: q,
        packages: [tocPkg],
        bookIndex: input.bookIndex,
        docId,
        onProgress: input.onProgress,
        turnQueryKey,
      })
      const tocStrands = closedFromTocDrafts(
        parseTocNavStrandRanges(tocRes.answer, corridors),
      )
      notes.push(
        tocStrands.length > 0
          ? `toc_nav · strand×${tocStrands.length}`
          : `toc_nav · ${parseDecideOutcome(tocRes.answer).note}`,
      )
      parts.push(
        `### 自动流 · toc_nav\n章×${corridors.length} · strand×${tocStrands.length}` +
          (tocStrands.length
            ? `\n` +
              tocStrands
                .map((r) => `- strand ${r.fromStrand}–${r.toStrand}`)
                .join('\n')
            : ''),
      )
      if (tocStrands.length > 0) {
        const expanded = expandStrandRangesToBookKeys({
          docId,
          bookIndex: input.bookIndex,
          ranges: tocStrands,
          maxKeys: TOC_CORRIDOR_HARD_CAP,
        })
        const seedBooks = expanded.bookKeys
        const capped = seedBooks.length >= TOC_CORRIDOR_HARD_CAP
        if (seedBooks.length > 0) {
          // 问核命中段提到队首：先读含 Lacan/专名的页，satisficing 早停才有意义
          const prio = prioritizeBookKeysByQCore({
            bookKeys: seedBooks,
            bookIndex: input.bookIndex,
            question: q,
          })
          const orderedBooks = prio.keys
          sealedBriefKeys = orderedBooks
          sealedItems = orderedBooks.map((bk) => ({
            key: bk,
            brief: '',
            briefKey: bk,
          }))
          attachBriefsToQuestion(q, orderedBooks, turnQueryKey)
          decideScope = orderedBooks
          lastClosedForPeek = expanded.usedClosed
          notes.push(
            `toc→seedBookKeys 全量×${orderedBooks.length}` +
              (capped ? `（硬顶 ${TOC_CORRIDOR_HARD_CAP}）` : '') +
              ` · ${expanded.note} · ${prio.note}`,
          )
          parts.push(
            `### 自动流 · toc→seedBookKeys（strand∩A1 全量）\n` +
              `×${orderedBooks.length}` +
              (capped ? ` · 硬顶 ${TOC_CORRIDOR_HARD_CAP}` : '') +
              `\n${expanded.note}\n${prio.note}\n` +
              `（分批×${DECIDE_BATCH}；可铸≥${MIN_DECIDE_PROSPECTS} 再早停进 infer）`,
          )
          try {
            const { useLlmIoStream } = await import('./llmIoStreamStore')
            useLlmIoStream.getState().pushNote({
              job: 'decide',
              stage: 'toc_seedBookKeys',
              text:
                `toc_nav strand∩A1 全量 → seedBookKeys ×${orderedBooks.length}` +
                (capped ? ` · 硬顶 ${TOC_CORRIDOR_HARD_CAP}` : '') +
                `\nstrand×${tocStrands.length} · ${expanded.note}\n${prio.note}\n` +
                `问核先队×${prio.hitKeys.length}\n` +
                orderedBooks.join('\n'),
            })
          } catch {
            /* optional */
          }
        } else {
          notes.push(`toc_nav · strand∩A1 空 · ${expanded.note}`)
        }
      }
    }
  }

  decideThenInfer: for (let postInferExpand = 0; postInferExpand <= MAX_HOT_PEEK; postInferExpand++) {
  for (let round = 0; round < MAX_DECIDE_ROUNDS; round++) {
    const scope =
      decideScope && decideScope.length > 0 ? decideScope : sealedBriefKeys
    if (scope.length === 0) break

    // 分批真并行：key 去重；有可铸 prospect 即可进 infer → abort 其余批
    const batches = chunkUniqueKeys(scope, DECIDE_BATCH)

    let roundOk = false
    let lastStop: string | null = null
    const roundSeedDrafts: SeedRangeDraft[] = []
    const roundNotes: string[] = []

    type DecideBatchOutcome = {
      bi: number
      batch: string[]
      decideRes: { ok: boolean; answer: string; note: string }
      effective: ReturnType<typeof parseDecideOutcome>
      mintable: Array<{
        briefKey: string
        prospect: string
        status: IncrementReadStatus | null
        relevance: number | null
      }>
    }

    input.onProgress?.(
      `自动流 · decide${round > 0 ? ` · 第${round + 1}轮` : ''}` +
        (batches.length > 1
          ? ` · 真并行 ${batches.length} 批×≤${DECIDE_BATCH} · 并发≤${DECIDE_CONCURRENCY}…`
          : '…'),
    )

    const mintableAccum = new Set<string>()
    const parallel = await runBatchesParallel({
      batches,
      concurrency: DECIDE_CONCURRENCY,
      run: async (batch, bi, signal): Promise<DecideBatchOutcome> => {
        const firstBook = batch[0]!
        input.onProgress?.(
          `自动流 · decide · 批${bi + 1}/${batches.length} 跑…`,
        )
        const decidePkg: LetterDeskPackage = {
          id: sid(),
          edgeId: `${stepId || 'decide'}_${firstBook}_b${bi}`,
          bookKey: firstBook,
          briefKey: firstBook,
          question: q,
          job: 'decide',
          versionIndex: 0,
          createdAt: Date.now(),
          onlyBookKeys: batch,
          decideCritiqueHint: input.decideCritiqueHint,
        }
        const decideRes = await askDeepSeekWithLetterDesk({
          question: q,
          packages: [decidePkg],
          bookIndex: input.bookIndex,
          docId,
          onProgress: input.onProgress,
          turnQueryKey,
          signal,
        })

        const batchOut = parseDecideOutcome(decideRes.answer)
        let effective = batchOut
        if (!batchOut.ok || batchOut.keeps.length === 0) {
          const fromStore = useAttentionIo
            .getState()
            .prospects.filter(
              (p) =>
                p.queryKey === turnQueryKey && batch.includes(p.briefKey),
            )
            .map((p) => ({
              briefKey: p.briefKey,
              prospect: p.text,
              status: 'sufficient' as IncrementReadStatus,
              relevance: p.relevance ?? MIN_PROSPECT_RELEVANCE,
            }))
          if (fromStore.length > 0) {
            effective = {
              ...batchOut,
              ok: true,
              keeps: fromStore,
              briefKeys: fromStore.map((k) => k.briefKey),
              note: `${batchOut.note} · store补×${fromStore.length}`,
            }
          }
        }
        const mintable = effective.keeps.filter(
          (k) =>
            statusAllowsMint(k.status) && relevanceAllowsInfer(k.relevance),
        )
        return { bi, batch, decideRes, effective, mintable }
      },
      // 累计可铸≥MIN 才 abort 其余批；否则继续扫（走廊尽则全跑完）
      shouldStop: (outcome) => {
        for (const m of outcome.mintable) {
          const k = m.briefKey.trim()
          if (k) mintableAccum.add(k)
        }
        return mintableAccum.size >= MIN_DECIDE_PROSPECTS
      },
    })

    const outcomes = parallel.results
      .filter(
        (
          r,
        ): r is {
          index: number
          ok: true
          value: DecideBatchOutcome
        } => Boolean(r && r.ok),
      )
      .map((r) => r.value)
      .sort((a, b) => a.bi - b.bi)

    const seenBrief = new Set(allMintableKeeps.map((k) => k.briefKey))
    for (const o of outcomes) {
      parts.push(o.decideRes.answer || '### decide · （空）')
      roundNotes.push(o.decideRes.note)
      if (o.effective.ok || o.effective.keeps.length > 0) {
        roundOk = true
        for (const m of o.mintable) {
          if (seenBrief.has(m.briefKey)) continue
          seenBrief.add(m.briefKey)
          allMintableKeeps.push(m)
        }
        if (o.effective.stopReason) lastStop = o.effective.stopReason
        // 丢弃「整窗自覆盖」seedRange（from=w1 to=w6 且 ⊆ 本批）：不产生新材料，只会空扩
        const batchSet = new Set(o.batch)
        const draftsUseful = (
          o.effective.seedRangeDrafts?.length
            ? o.effective.seedRangeDrafts
            : o.effective.seedRangeDraft
              ? [o.effective.seedRangeDraft]
              : []
        ).filter((d) => {
          if (d.kind !== 'closed') return true
          const fromIn = batchSet.has(d.from)
          const toIn = batchSet.has(d.to)
          // 两端都在本批且 mintable 空 → 假 expand
          if (fromIn && toIn && o.mintable.length === 0) return false
          return true
        })
        if (draftsUseful.length) {
          roundSeedDrafts.push(...draftsUseful)
          allSeedDrafts.push(...draftsUseful)
        } else if (
          (o.effective.seedRangeDrafts?.length ||
            o.effective.seedRangeDraft) &&
          o.mintable.length === 0
        ) {
          roundNotes.push(
            `decide · 丢弃自覆盖 seedRange（本批×${o.batch.length} 无可铸）`,
          )
        }
        roundNotes.push(
          o.effective.ok
            ? o.effective.note
            : `decide · 残缺抢救 · prospect槽×${o.effective.keeps.length}`,
        )
      } else {
        roundNotes.push(o.effective.note)
      }
      deskMonitorAttentionArrival({
        job: 'decide',
        llmText: o.decideRes.answer,
        windowKeys: o.batch,
        queryKey: turnQueryKey,
      })
    }
    for (const r of parallel.results) {
      if (r && !r.ok) {
        roundNotes.push(
          r.aborted
            ? `decide · 批${r.index + 1} 早停取消`
            : `decide · 批${r.index + 1} 失败：${r.note}`,
        )
      }
    }
    if (parallel.stoppedEarly) {
      roundNotes.push(parallel.note)
    }

    // 晚执行：并行草案闭集化（锚点须本问族已读）；未配上的半开不进 peek
    const stDecide = useAttentionIo.getState()
    const qScope = { queryKey: turnQueryKey }
    const unreadSet = new Set(stDecide.listKeysUnread('decide', qScope))
    const isBriefRead = (briefKey: string) => {
      const k = briefKey.trim()
      if (!k) return false
      if (unreadSet.has(k)) return false
      const rows = stDecide.listKeyStatuses({
        job: 'decide',
        queryKey: turnQueryKey,
      })
      const hit = rows.find((r) => r.key === k)
      // 有态且非 unread = 已读；无态不认（严）
      return Boolean(hit && hit.status !== 'unread')
    }
    const closedPack = closeSeedRangeDrafts({
      docId,
      bookIndex: input.bookIndex,
      drafts: allSeedDrafts,
      isBriefRead,
    })
    lastClosedForPeek = closedPack.closed
    if (allSeedDrafts.length > 0) {
      notes.push(closedPack.note)
      parts.push(`### 自动流 · seedRange 闭集化\n${closedPack.note}`)
    }
    const mergedClosed = closedPack.closed[0] ?? null

    notes.push(...roundNotes)
    decideOut = {
      briefKeys: [...new Set(allMintableKeeps.map((k) => k.briefKey))],
      keeps: allMintableKeeps,
      lastBriefKey: allMintableKeeps.at(-1)?.briefKey ?? null,
      coverage: null,
      stopReason: lastStop,
      seedRangeDraft: mergedClosed
        ? { kind: 'closed', from: mergedClosed.from, to: mergedClosed.to }
        : roundSeedDrafts[0] ?? null,
      seedRangeDrafts:
        closedPack.closed.length > 0
          ? closedPack.closed.map((c) => ({
              kind: 'closed' as const,
              from: c.from,
              to: c.to,
            }))
          : roundSeedDrafts,
      seedRange: mergedClosed,
      ok: roundOk || allMintableKeeps.length > 0,
      note:
        allMintableKeeps.length > 0
          ? `decide · 真并行分批×${batches.length} · 可铸×${allMintableKeeps.length}` +
            (parallel.stoppedEarly ? ' · 早停取消其余' : '') +
            (closedPack.closed.length
              ? ` · 闭集×${closedPack.closed.length}`
              : '')
          : roundNotes.at(-1) || 'decide 硬闸：无法解析 JSON',
    }

    const roundDecide = decideOut
    if (!roundDecide.ok) {
      deskPromptSafety(
        `写信台 · decide 硬闸失败：${roundDecide.note}。请检查本问材料或重试。`,
      )
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · ${roundDecide.note} · ${notes.join(' → ')}`,
      }
    }

    // 仅看本窗 scope 内可铸，避免扩搜后旧 prospect 跳过新 book
    const mintable = allMintableKeeps.filter((k) => scope.includes(k.briefKey))
    const action = decideRoundAction({
      scope,
      mintableCount: mintable.length,
      queryKey: turnQueryKey,
    })

    if (action === 'done') {
      // 保留 decide 草案闭集：infer 不够时再 seedRange，勿在此清空
      notes.push(
        mintable.length >= MIN_DECIDE_PROSPECTS
          ? `三态·可铸×${mintable.length}≥${MIN_DECIDE_PROSPECTS} → infer`
          : `三态·可铸×${mintable.length}（走廊尽·未满${MIN_DECIDE_PROSPECTS}）→ infer`,
      )
      break
    }

    if (action === 'pause') {
      if (lastClosedForPeek.length > 0) {
        stashHungerForIngest({
          queryKey: turnQueryKey,
          closed: lastClosedForPeek,
          reason: 'decide 扫完无可铸；seedRange 挂起，等 infer/人工续才扩',
        })
      }
      deskPromptSafety(
        mintable.length === 0
          ? `写信台 · decide 已扫完仍无可铸 prospect。seedRange 已挂起；勿在 decide 中途空扩。可换问法或钉窗续调度。`
          : `写信台 · 本问自动流暂停（三态无可铸 prospect）。可钉住注意力窗续调度，或换问法重试。`,
      )
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note:
          `自动流暂停 · decide 扫完无可铸（seedRange 挂起·未空扩）· ${notes.join(' → ')}`,
      }
    }

    if (action === 'continue_unread') {
      const unread = useAttentionIo
        .getState()
        .listKeysUnread('decide', { queryKey: turnQueryKey })
        .filter((k) => scope.includes(k))
      const covered = new Set(allMintableKeeps.map((k) => k.briefKey))
      const leftover = scope.filter((k) => !covered.has(k))
      decideScope =
        unread.length > 0
          ? unread
          : leftover.length > 0
            ? leftover
            : scope
      notes.push(`续滚·未读 brief×${decideScope.length}`)
      parts.push(`### 自动流 · 续滚未读\n余 ${decideScope.length} brief`)
      continue
    }

    // decide 阶段禁止 seedRange；不可达兜底
    notes.push('decide·禁空扩（须 infer 不够才 seedRange）')
    break
  }

  const finalMintable = (
    decideOut?.keeps.filter(
      (k) => statusAllowsMint(k.status) && relevanceAllowsInfer(k.relevance),
    ) ?? []
  ).sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
  if (!decideOut || finalMintable.length === 0) {
    deskPromptSafety(
      `写信台 · 本问 decide 轮次触顶或无可铸充分 prospect（或相关度均 <${MIN_PROSPECT_RELEVANCE}）。请钉窗人工调度或换问法。`,
    )
    return {
      ok: true,
      answer: parts.join('\n\n'),
      note:
        `自动流暂停 · decide 无可铸充分 prospect · ${notes.join(' → ')}`,
    }
  }

  // 递送下游：高相关充分 brief；prospect 已在各轮 letterDeskDispatch(decide) 落账
  const briefKeys = [
    ...new Set(finalMintable.map((k) => k.briefKey)),
  ]
  notes.push(
    `infer择优·相关度≥${MIN_PROSPECT_RELEVANCE} · brief×${briefKeys.length}`,
  )
  if (briefKeys.length === 0) {
    return {
      ok: true,
      answer: parts.join('\n\n'),
      note: `自动流暂停 · 充分槽无 briefKey · ${notes.join(' → ')}`,
    }
  }

  const prospectCount = useAttentionIo
    .getState()
    .prospects.filter((p) => p.queryKey === turnQueryKey).length
  notes.push(`prospect×${prospectCount}（desk 已落）`)
  if (prospectCount === 0) {
    // 兼容：若 desk 未落（旧路径），补一次 settle
    const settledProspects = useAttentionIo.getState().settleProspects({
      question: q,
      queryKey: turnQueryKey,
      llmCallId: newLlmCallId('decide'),
      keeps: finalMintable,
      allowedBriefKeys: sealedBriefKeys,
    })
    notes.push(`prospect补落×${settledProspects.prospectKeys.length}`)
    if (settledProspects.prospectKeys.length === 0) {
      deskPromptSafety('写信台 · 充分 prospect 均未落账（窗门牌校验失败？）。')
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note: `自动流暂停 · prospect 落账为空 · ${notes.join(' → ')}`,
      }
    }
  }

  // ——— infer：只送「本轮充分 prospect」血缘上的 book（brief→book），禁宽兜底换错材料 ———
  input.onProgress?.('自动流 · infer…')
  const stInfer = useAttentionIo.getState()
  const mintableSet = new Set(briefKeys)
  const lineageProspects = stInfer.prospects
    .filter(
      (p) =>
        p.queryKey === turnQueryKey &&
        mintableSet.has(p.briefKey.trim()) &&
        relevanceAllowsInfer(p.relevance),
    )
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
  const lineage = bookKeysForInferFromDecideLineage({
    docId,
    mintableBriefKeys: briefKeys,
    prospects: lineageProspects,
    deskDeliveries: stInfer.deskDeliveries,
  })
  const bookKeys = lineage.bookKeys
  notes.push(
    `infer血缘 pair×${lineage.pairs.length} · book×${bookKeys.length}` +
      (lineage.unmappedBriefKeys.length
        ? ` · 未映brief×${lineage.unmappedBriefKeys.length}`
        : '') +
      (lineage.orphanProspectKeys.length
        ? ` · 无book prospect×${lineage.orphanProspectKeys.length}`
        : ''),
  )
  if (bookKeys.length === 0) {
    deskPromptSafety(
      '写信台 · decide 充分 prospect 无法溯到 bookKey（门表/peek 递送断了）。禁止灌全部 peek 门。',
    )
    return {
      ok: false,
      answer: parts.join('\n\n'),
      note: `自动流中止 · prospect→brief→book 血缘无解 · ${notes.join(' → ')}`,
    }
  }
  // package.briefKey：取第一对血缘 brief（与 onlyBookKeys[0] 同源），勿用任意 sealedBrief
  const lineageBriefKey = lineage.pairs[0]?.briefKey || briefKeys[0] || ''

  const mainPkg: LetterDeskPackage = {
    id: sid(),
    edgeId: `${stepId || 'infer'}_${bookKeys[0]}`,
    bookKey: bookKeys[0]!,
    briefKey: lineageBriefKey,
    question: q,
    job: 'infer',
    versionIndex: 0,
    createdAt: Date.now(),
    onlyBookKeys: bookKeys,
    // 入口已跑 reuse；嵌套再闸会撞未绑定符号 / 重复烧 token
    skipReuse: true,
  }

  const mainRes = await askDeepSeekWithLetterDesk({
    question: q,
    packages: [mainPkg],
    bookIndex: input.bookIndex,
    docId,
    onProgress: input.onProgress,
    turnQueryKey,
  })
  parts.push(mainRes.answer || '### infer · （空）')
  notes.push(mainRes.note)

  const mainFailed =
    !mainRes.ok ||
    /空内容|失败|HTTP|无 choices|请求失败/.test(mainRes.note)
  if (mainFailed) {
    deskPromptSafety(
      `写信台 · infer 未写出内容（${mainRes.note}）。前序 decide 已有充分 prospect；可钉住材料窗重跑 infer。`,
    )
    return {
      ok: false,
      answer: parts.join('\n\n'),
      note: `自动流 · infer 失败 · ${notes.join(' → ')}`,
    }
  }

  deskMonitorAttentionArrival({
    job: 'infer',
    llmText: mainRes.answer,
    windowKeys: bookKeys,
    queryKey: turnQueryKey,
  })

  // infer 够不够：有 ι 且非自报未到位，且未整窗 insufficient
  {
    const { parseAttentionArrival } = await import('./attentionArrival')
    const stAi = useAttentionIo.getState()
    const inferMinted = stAi.inferEdges.filter(
      (e) => e.queryKey === turnQueryKey,
    ).length
    const inferWeak = stAi.listKeysNeedingMore('infer', {
      queryKey: turnQueryKey,
    })
    const attn = parseAttentionArrival(mainRes.answer)
    const inferEnough =
      inferMinted > 0 &&
      !(attn.reported && attn.arrived === false) &&
      inferWeak.length < bookKeys.length
    if (inferEnough) {
      useAttentionIo.getState().clearPendingHunger()
      useAttentionIo.getState().clearPendingIngestFeed()
      notes.push(`infer·够 · ι×${inferMinted}`)
    } else {
      notes.push(`infer·不够 · ι×${inferMinted} · weak×${inferWeak.length}`)
      if (postInferExpand >= MAX_HOT_PEEK) {
        if (lastClosedForPeek.length > 0) {
          stashHungerForIngest({
            queryKey: turnQueryKey,
            closed: lastClosedForPeek,
            reason: 'infer 不够且 seedRange 扩搜触顶',
          })
        }
        deskPromptSafety(
          `写信台 · infer 判定材料不够，seedRange 扩搜已触顶（最多 ${MAX_HOT_PEEK} 次）。可钉窗旁路或换问法。`,
        )
        return {
          ok: true,
          answer: parts.join('\n\n'),
          note: `自动流暂停 · infer不够·扩搜触顶 · ${notes.join(' → ')}`,
        }
      }
      let closedForPeek = lastClosedForPeek
      if (closedForPeek.length === 0) {
        deskPromptSafety(
          '写信台 · infer 判定不够，但 decide 未留下可展开的 seedRange 闭集。请钉窗换材料或换问法。',
        )
        return {
          ok: true,
          answer: parts.join('\n\n'),
          note: `自动流暂停 · infer不够·无seedRange闭集 · ${notes.join(' → ')}`,
        }
      }
      const expanded = expandClosedSeedRangesToBookKeys({
        docId,
        bookIndex: input.bookIndex,
        closed: closedForPeek,
      })
      notes.push(expanded.note)
      const already = new Set(sealedBriefKeys)
      const candidates = mergeHotPeekCandidates({
        expandedUnopened: expanded.unopened,
        expandedAll: expanded.bookKeys,
      }).filter((k) => !already.has(k))
      if (candidates.length === 0) {
        stashHungerForIngest({
          queryKey: turnQueryKey,
          closed: closedForPeek,
          reason: 'infer 不够后扩搜无新 book（区间均已 decide）',
        })
        deskPromptSafety(
          '写信台 · infer 不够；seedRange 展开无新 book（均已扫过）。可换问法或等后台入账。',
        )
        return {
          ok: true,
          answer: parts.join('\n\n'),
          note: `自动流暂停 · infer不够·扩搜无新书 · ${notes.join(' → ')}`,
        }
      }
      hotPeekCount++
      sealedBriefKeys = [...new Set([...sealedBriefKeys, ...candidates])]
      attachBriefsToQuestion(q, candidates, turnQueryKey)
      for (const bk of candidates) {
        sealedItems.push({ key: bk, brief: '', briefKey: bk })
      }
      parts.push(
        `### 自动流 · infer不够 → seedRange 扩搜\n+bookKey×${candidates.length}\n` +
          candidates.map((k) => `- \`${k}\``).join('\n') +
          `\n${expanded.note}`,
      )
      notes.push(`infer不够→seedRange +×${candidates.length}`)
      decideScope = candidates
      input.onProgress?.(
        `自动流 · infer不够 → seedRange→decide（+${candidates.length}）…`,
      )
      continue decideThenInfer
    }
  }

  // path：等人手确认成案；未确认则挂起（禁止自动信效度 LLM）
  const pending = useAttentionIo.getState().pendingPathMatch
  const userPaths = useAttentionIo
    .getState()
    .listPathsForQueryKey(turnQueryKey)
    .filter((p) => p.matchMode === 'user')
  if (userPaths.length === 0 && pending) {
    useAttentionIo.getState().setDeskPrompt(
      `写信台 · path：候选 pathKey×${pending.pathKeys?.length ?? 0} · 结算面确认/撤销。` +
        ` qk=${pending.queryKey}`,
    )
    notes.push('等待用户 path 确认/撤销')
    return {
      ok: true,
      answer:
        `### 等待 path 确认\n` +
        `queryKey=\`${pending.queryKey}\` · path×${pending.pathKeys?.length ?? 0}\n` +
        `请在结算面确认或撤销（中栏：解法 conclusion → bookKey 序列 → steps）。`,
      note: `自动流 · ${notes.join(' → ')}`,
    }
  }

  const pathReturn = formatDirectedPathIncrementReturn({
    question: q,
    hopOutputs: hopsFromAnswerParts(parts),
    mode: 'auto',
    queryKey: turnQueryKey,
  })

  useAttentionIo
    .getState()
    .setLastStatus(`自动流完成 · ${notes.join(' → ')}`)
  useAttentionIo.getState().clearDeskPrompt()

  return {
    ok: true,
    answer: pathReturn,
    note: `自动流 · ${notes.join(' → ')}`,
  }
  } // decideThenInfer

  return {
    ok: false,
    answer: parts.join('\n\n'),
    note: `自动流结束 · 未落成 path · ${notes.join(' → ')}`,
  }
}
