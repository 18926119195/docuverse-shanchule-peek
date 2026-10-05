/**
 * 复用闸：neighbour 序评 norm；不够且仍有历史问缺 norm → 停泊，不落入 decide/infer。
 */

import { expandHistoricQueryKey } from './deskEntryGate'
import { parseReuseJudgments } from './inferPath'
import { useAttentionIo } from './attentionIoStore'
import { briefKeysUsedByPaths } from './pathBriefExclusion'
import { mapBriefToBook } from './masterTableMap'
import { keyStatusContractHint } from './keyIncrementStatus'
import { ingestKeyIncrementStatuses } from './attentionArrival'

export function listNeighbourHistoricsOrdered(nowQueryKey?: string): Array<{
  historicQueryKey: string
  degree: string
  rank: number
}> {
  const st = useAttentionIo.getState()
  const qk = nowQueryKey?.trim()
  if (!qk) return []
  const seen = new Set<string>()
  const rows: Array<{
    historicQueryKey: string
    degree: string
    rank: number
  }> = []
  for (const n of st.neighbours.filter((x) => x.nowQueryKey === qk)) {
    const hq =
      expandHistoricQueryKey(n.historicQueryKey, qk) || n.historicQueryKey
    if (!hq || seen.has(hq)) continue
    seen.add(hq)
    rows.push({
      historicQueryKey: hq,
      degree: n.degree,
      rank: n.rank,
    })
  }
  rows.sort((a, b) => a.rank - b.rank || a.historicQueryKey.localeCompare(b.historicQueryKey))
  return rows
}

function historicsStillAwaitingNorms(
  neighbourOrder: Array<{ historicQueryKey: string }>,
): string[] {
  const st = useAttentionIo.getState()
  const out: string[] = []
  for (const row of neighbourOrder) {
    const hq = row.historicQueryKey.trim()
    if (!hq) continue
    const norms = st.listNormsForQueryKey(hq).filter((n) => n.text.trim())
    if (norms.length > 0) continue
    // 仅等「活」的历史问：已有 path 待确认，或挂着 pendingPathMatch
    // 无 path、无 pending 的邻域 = 半截流僵尸，不停泊死等
    const hasPath = st.listPathsForQueryKey(hq).length > 0
    const pendingHere = st.pendingPathMatch?.queryKey === hq
    if (hasPath || pendingHere) out.push(hq)
  }
  return out
}

/**
 * 复用闸：主坐标 = normKey + 展开(归一化推理)；能则现 qk ──reuse──► normKey。
 * 现有 norm 不够撑满 Q_now 且邻域仍有历史问缺 norm → pendingReuseWait（停泊）。
 */
export async function runReuseGate(input: {
  qNow: string
  /** 用于 brief↔book 精细剔除 */
  docId?: string
  /** @deprecated 架构以 neighbour→path 为准；保留兼容 */
  bookKeys?: string[]
  queryKey?: string
  /** 监督同问复盘：禁止采纳这些坏 path（其它 neighbour path 仍可） */
  excludePathKeys?: string[]
  /** 已审不够的 norm：续跑时跳过 */
  excludeNormKeys?: string[]
  /**
   * query 硬闸授权的历史问：只评这些 qk 上的 path/norm。
   * 空/缺省 = 不额外收窄（兼容直调）；有值则 ∩ neighbour 候选。
   */
  onlyHistoricQueryKeys?: string[]
  onProgress?: (msg: string) => void
  signal?: AbortSignal
  /** 由 letterDeskDispatch 注入，避免动态 import 环 / 未绑定符号 */
  flashChat?: (input: {
    system: string
    user: string
    temperature?: number
    signal?: AbortSignal
    ioMeta?: { job: string; stage?: string; queryKey?: string }
  }) => Promise<
    | { ok: true; content: string; finishReason: string }
    | { ok: false; note: string }
  >
  listCandidatePaths?: (nowQueryKey?: string) => Array<{
    pathKey: string
    queryKey: string
    inferKey?: string
    inferKeys?: string[]
    prospectKey?: string
    prospectKeys?: string[]
    matchMode?: string
    settleActionId?: string
    settleSeq?: number
    createdAt?: number
    bookKeysSequence?: string[]
    steps?: Array<{ bookKeys: string[] }>
  }>
}): Promise<{
  adopted: boolean
  /** 已挂起提案，等人批（≠ 已 adopt） */
  awaitingApproval: boolean
  /** 现有 norm 不够，仍等其它历史问铸 norm（勿落入 decide/infer） */
  awaitingMoreNorms: boolean
  exhaustedNormKeys: string[]
  awaitingHistoricQueryKeys: string[]
  queryKey?: string
  reuseKey?: string
  pathKey?: string
  pathKeys?: string[]
  normKey?: string
  normKeys?: string[]
  reuseKeys?: string[]
  oldQueryKey?: string
  inferKeys?: string[]
  prospectKeys?: string[]
  judgments: ReturnType<typeof parseReuseJudgments>
  /** 失败 path 实际用过的 brief（同门其余保留） */
  excludeBriefKeys: string[]
  raw: string
  note: string
}> {
  const deps =
    input.flashChat && input.listCandidatePaths
      ? {
          flashChat: input.flashChat,
          listCandidatePathsViaNeighbours: input.listCandidatePaths,
        }
      : await import('./letterDeskDispatch')
  const { listCandidatePathsViaNeighbours, flashChat } = deps

  const banned = new Set(
    (input.excludePathKeys ?? []).map((k) => k.trim()).filter(Boolean),
  )
  const bannedNorms = new Set(
    (input.excludeNormKeys ?? []).map((k) => k.trim()).filter(Boolean),
  )
  const turnQk =
    input.queryKey?.trim() ||
    useAttentionIo.getState().findQueryKeyForQuestion(input.qNow) ||
    useAttentionIo.getState().ensureQueryKey(input.qNow)
  const neighbourOrder = listNeighbourHistoricsOrdered(turnQk)
  const awaitingHistorics = historicsStillAwaitingNorms(neighbourOrder)
  const emptyBase = {
    adopted: false as const,
    awaitingApproval: false as const,
    judgments: [] as ReturnType<typeof parseReuseJudgments>,
    excludeBriefKeys: [] as string[],
    raw: '',
    exhaustedNormKeys: [...bannedNorms],
    awaitingHistoricQueryKeys: awaitingHistorics,
  }

  const parkWait = (note: string, exhausted: string[]) => {
    const now = Date.now()
    useAttentionIo.getState().beginPendingReuseWait({
      queryKey: turnQk,
      question: input.qNow,
      neighbourOrder,
      exhaustedNormKeys: exhausted,
      awaitingHistoricQueryKeys: awaitingHistorics,
      lastNote: note,
      createdAt: now,
      updatedAt: now,
    })
    return {
      ...emptyBase,
      awaitingMoreNorms: true as const,
      exhaustedNormKeys: exhausted,
      awaitingHistoricQueryKeys: awaitingHistorics,
      queryKey: turnQk,
      note,
    }
  }

  // 类型转换：因为 input.listCandidatePaths 可能只有简单字段，但实际需要完整 PathRecord
  const rawPaths = listCandidatePathsViaNeighbours(turnQk)
    .filter((p) => !banned.has(p.pathKey))
    .filter((p) => {
      const allow = input.onlyHistoricQueryKeys
      if (!allow || allow.length === 0) return true
      const want = new Set(allow.map((k) => k.trim()).filter(Boolean))
      return want.has(p.queryKey)
    })
  const paths = rawPaths as import('./attentionIoStore').PathRecord[]
  const st = useAttentionIo.getState()
  const rankByHistoric = new Map(
    neighbourOrder.map((n) => [n.historicQueryKey, n.rank]),
  )
  let norms = st
    .listNormsForPathKeys(paths.map((p) => p.pathKey))
    .filter((n) => n.text.trim() && !bannedNorms.has(n.normKey))

  // 按 neighbour 序排：先 Lacan 线、再 Freud 线…
  const byPath = new Map(paths.map((p) => [p.pathKey, p]))
  norms = [...norms].sort((a, b) => {
    const qa = byPath.get(a.pathKey)?.queryKey ?? a.queryKey
    const qb = byPath.get(b.pathKey)?.queryKey ?? b.queryKey
    const ra = rankByHistoric.get(qa) ?? 1e9
    const rb = rankByHistoric.get(qb) ?? 1e9
    if (ra !== rb) return ra - rb
    return a.normKey.localeCompare(b.normKey)
  })

  if (norms.length === 0) {
    if (awaitingHistorics.length > 0) {
      return parkWait(
        `复用停泊 · 尚无可用 norm · 等历史问铸 norm：${awaitingHistorics
          .map((k) => k.slice(0, 18))
          .join(',')}`,
        [...bannedNorms],
      )
    }
    useAttentionIo.getState().clearPendingReuseWait()
    return {
      ...emptyBase,
      awaitingMoreNorms: false,
      awaitingHistoricQueryKeys: [],
      note: banned.size
        ? `复用闸：候选均被排除或无 normKey（坏 path×${banned.size}）`
        : '复用闸：无 neighbour→path→norm 候选（须历史问线已有 normKey：用户确认 path 登记或监督铸）',
    }
  }

  const settled = st.settledQueries
  const lines: string[] = [
    `Q_now：${input.qNow}`,
    '',
    '【候选 · 按 neighbour 相关序；每条以 normKey 为主坐标；展开 = 监督归一化推理路径】',
  ]
  for (const n of norms) {
    const p = byPath.get(n.pathKey)
    const hq = p?.queryKey ?? n.queryKey
    const rank = rankByHistoric.get(hq)
    lines.push(`\nnormKey=\`${n.normKey}\``)
    lines.push(`neighbour序=${rank ?? '∅'} · 挂靠 pathKey=\`${n.pathKey}\``)
    lines.push(`挂靠旧 queryKey=\`${hq}\``)
    lines.push(`旧 Q：${settled[hq] ?? '（无原文）'}`)
    lines.push(`归一化推理：${n.text}`)
  }
  lines.push(
    '\n请判断：哪条归一化路径能否**完整**解决 Q_now。\n' +
      '只输出 JSON：\n' +
      '{\n' +
      '  "judgments": [\n' +
      '    { "normKey": "nk_…", "pathKey": "ph_…", "canSolve": true|false, "status": "unread|sufficient|insufficient", "rationale": "依据…" }\n' +
      '  ],\n' +
      '  "keyStatuses": [{ "key": "nk_…", "status": "unread|sufficient|insufficient" }]\n' +
      '}\n' +
      '规则：每个候选 normKey 一条；主坐标是 normKey；' +
      'canSolve=true **仅当**该路径完整覆盖 Q_now 全部要点；' +
      '多实体/并列问（如「是否提及 A 和 B」）只撑一侧 = 不够，必须 canSolve=false、status=insufficient；' +
      '禁止半边覆盖冒充可复用；禁止以正文指纹当门牌；' +
      'status：能完整复用=sufficient；审过不够=insufficient；未审=unread。\n' +
      `- ${keyStatusContractHint('normKey')}`,
  )

  input.onProgress?.('写信台 · 复用闸 · LLM…')
  const chat = await flashChat({
    system: [
      '你是复用闸：只评「已有归一化推理路径（normKey）能否完整返回 / 撑住 Q_now」。',
      '主坐标是 normKey；不写新路径；不改契约；不翻库；不靠正文指纹撞车。',
      '半覆盖（多实体只命中一部分）一律不够，不可 canSolve=true。',
    ].join('\n'),
    user: lines.join('\n'),
    temperature: 0.1,
    signal: input.signal,
    ioMeta: {
      job: 'reuse',
      stage: 'gate',
      queryKey: input.queryKey || undefined,
    },
  })
  if (!chat.ok) {
    return {
      ...emptyBase,
      awaitingMoreNorms: false,
      note: `复用闸失败：${chat.note}`,
    }
  }

  ingestKeyIncrementStatuses({
    job: 'reuse',
    llmText: chat.content,
    windowKeys: norms.map((n) => n.normKey),
    queryKey: input.queryKey,
  })

  let judgments = parseReuseJudgments(chat.content)
  if (judgments.length === 0 && /true|canSolve|能|不能|复用/i.test(chat.content)) {
    const hitTrue = /canSolve\s*[:=]\s*true|能解决|可以复用|足以回/i.test(
      chat.content,
    )
    judgments = norms.map((n, i) => ({
      pathKey: n.pathKey,
      inferKey: byPath.get(n.pathKey)?.inferKey ?? '',
      canSolve: hitTrue && i === 0,
      rationale: chat.content.trim().slice(0, 400),
    }))
  }

  const byNorm = new Map(norms.map((n) => [n.normKey, n]))
  const byPathKeyNorm = new Map(norms.map((n) => [n.pathKey, n]))
  const resolveNorm = (j: (typeof judgments)[0]) => {
    const nk = String((j as { normKey?: string }).normKey ?? '').trim()
    if (nk && byNorm.has(nk)) return byNorm.get(nk)!
    if (j.pathKey && byPathKeyNorm.has(j.pathKey)) {
      return byPathKeyNorm.get(j.pathKey)!
    }
    return null
  }

  const failedPaths = paths.filter((p) => {
    const n = byPathKeyNorm.get(p.pathKey)
    if (!n) return true
    const j = judgments.find((x) => resolveNorm(x)?.normKey === n.normKey)
    return !j || !j.canSolve
  })
  // 仅剔「本问自己」失败 path 用过的 brief（同问重试防撞车）。
  // 邻域历史问（旧 Q≠Q_now）的材料往往正是新问要用的，禁止误剔。
  const failedSameQuestion = failedPaths.filter((p) => p.queryKey === turnQk)
  const excludeBriefKeys = input.docId
    ? briefKeysUsedByPaths({
        docId: input.docId,
        paths: failedSameQuestion,
        prospects: st.prospects,
        inferEdges: st.inferEdges,
      })
    : [
        ...new Set(
          failedSameQuestion.flatMap((path) => {
            const pr = st.prospects.find((p) => p.prospectKey === path.prospectKey)
            return pr?.briefKey ? [pr.briefKey] : []
          }),
        ),
      ]

  const triedNormKeys = [
    ...new Set([
      ...bannedNorms,
      ...norms.map((n) => n.normKey),
      ...judgments
        .map((j) => resolveNorm(j)?.normKey)
        .filter((k): k is string => Boolean(k)),
    ]),
  ]
  const insufficientNormKeys = [
    ...new Set([
      ...bannedNorms,
      ...judgments
        .filter((j) => !j.canSolve)
        .map((j) => resolveNorm(j)?.normKey)
        .filter((k): k is string => Boolean(k)),
      // 未出现在 judgments 里的候选也算已审不够
      ...norms
        .filter((n) => {
          const j = judgments.find((x) => resolveNorm(x)?.normKey === n.normKey)
          return !j || !j.canSolve
        })
        .map((n) => n.normKey),
    ]),
  ]

  const wins = judgments.filter((j) => j.canSolve)
  if (wins.length === 0) {
    if (awaitingHistorics.length > 0) {
      return parkWait(
        `复用停泊 · 现有 norm 不够撑满 Q · 等历史问：${awaitingHistorics
          .map((k) => k.slice(0, 18))
          .join(',')} · 已尽×${insufficientNormKeys.length}`,
        insufficientNormKeys,
      )
    }
    useAttentionIo.getState().clearPendingReuseWait()
    return {
      adopted: false,
      awaitingApproval: false,
      awaitingMoreNorms: false,
      exhaustedNormKeys: triedNormKeys,
      awaitingHistoricQueryKeys: [],
      judgments,
      excludeBriefKeys,
      raw: chat.content,
      note: `复用闸：全部不够 · ${judgments.length} 条审过 → decide/infer`,
    }
  }

  // 先展示再批：挂起提案，不自动 adopt
  useAttentionIo.getState().clearPendingReuseWait()
  const queryKey =
    input.queryKey?.trim() ||
    useAttentionIo.getState().ensureQueryKey(input.qNow)
  const candidates: import('./attentionIoStore').PendingReuseCandidate[] = []
  for (const win of wins) {
    const n = resolveNorm(win)
    if (!n) continue
    const path = byPath.get(n.pathKey) || paths.find((p) => p.pathKey === n.pathKey)
    const inferEdge = path
      ? st.inferEdges.find((e) => e.inferKey === path.inferKey)
      : undefined
    const pathProspectKeys = [
      ...new Set(
        [
          ...(path?.prospectKeys ?? []),
          ...(path?.prospectKey ? [path.prospectKey] : []),
        ]
          .map((k) => k.trim())
          .filter(Boolean),
      ),
    ]
    const pathBooks = [
      ...new Set(
        [
          ...(path?.bookKeysSequence ?? []),
          ...(path?.steps ?? []).flatMap((s) => s.bookKeys),
          ...(inferEdge?.bookKeys ?? []),
        ]
          .map((k) => k.trim())
          .filter(Boolean),
      ),
    ]
    for (const pk of pathProspectKeys) {
      const pr = st.prospects.find((p) => p.prospectKey === pk)
      if (!pr?.briefKey || !input.docId) continue
      const hit = mapBriefToBook(input.docId, pr.briefKey)
      if (hit?.bookKey) pathBooks.push(hit.bookKey)
      else if (pr.briefKey && !pr.briefKey.startsWith('bh_')) {
        pathBooks.push(pr.briefKey)
      }
    }
    candidates.push({
      normKey: n.normKey,
      pathKey: n.pathKey,
      oldQueryKey: path?.queryKey ?? n.queryKey,
      rationale: win.rationale || '',
      normText: n.text,
      bookKeys: [...new Set(pathBooks)],
      inferKeys: path?.inferKeys?.length
        ? path.inferKeys
        : path
          ? [path.inferKey]
          : [],
      prospectKeys: pathProspectKeys,
    })
  }
  if (candidates.length === 0) {
    if (awaitingHistorics.length > 0) {
      return parkWait(
        `复用闸判可复用但无法组提案 · 停泊等历史问 · wins=${wins.length}`,
        insufficientNormKeys,
      )
    }
    useAttentionIo.getState().clearPendingReuseWait()
    return {
      adopted: false,
      awaitingApproval: false,
      awaitingMoreNorms: false,
      exhaustedNormKeys: triedNormKeys,
      awaitingHistoricQueryKeys: [],
      judgments,
      excludeBriefKeys,
      raw: chat.content,
      note: `复用闸判可复用但无法组提案 · wins=${wins.length}`,
    }
  }

  useAttentionIo.getState().beginPendingReuseProposal({
    queryKey,
    question: input.qNow,
    candidates,
    excludeBriefKeys,
    createdAt: Date.now(),
  })

  const first = candidates[0]!
  return {
    adopted: false,
    awaitingApproval: true,
    awaitingMoreNorms: false,
    exhaustedNormKeys: insufficientNormKeys,
    awaitingHistoricQueryKeys: [],
    queryKey,
    pathKey: first.pathKey,
    pathKeys: candidates.map((c) => c.pathKey),
    normKey: first.normKey,
    normKeys: candidates.map((c) => c.normKey),
    oldQueryKey: first.oldQueryKey,
    inferKeys: [...new Set(candidates.flatMap((c) => c.inferKeys))],
    prospectKeys: [...new Set(candidates.flatMap((c) => c.prospectKeys))],
    judgments,
    excludeBriefKeys: [],
    raw: chat.content,
    note: `复用提案挂起×${candidates.length} · 待批准（未铸 reuseKey）`,
  }
}
