/**
 * 监督归因（两轨）：
 * - predict：材料/prospect/问法立错；旧 ι 作尸检
 *   · 同问：reframe / need_peek / drop_briefs —— 禁采纳本轮坏 path，其它历史 path 仍可 reuse
 *   · 换问：revise_q —— 新 qk 走标准流（含 reuse）；≠ 狭义 deepen
 * - reason_narrow：材料∩大方向仍成立；必排坏 ι → infer（same_q | deepen），不过 decide
 *
 * path / 同窝信效度结果与上一轮 query→neighbour I/O：归因的主要参考指标，不是第三条监督轨。
 */

import { extractJsonObject } from './inferPath'
import { useAttentionIo } from './attentionIoStore'
import { demoAuthHeaders } from './demoAuth'
import {
  loadDualModelConfig,
  reasonEndpointReady,
  LOCKED_LLM,
} from './modelRuntimeConfig'
import { ingestKeyIncrementStatuses } from './attentionArrival'
import { llmThinkingField } from './llmThinking'

export type CritiqueFault = 'predict' | 'reason_narrow' | 'ask_user'

export type PredictSub =
  | 'reframe' // 同问 · 框错 → 重 decide
  | 'need_peek' // 同问 · 材料不够 → decide ± peek
  | 'drop_briefs' // 同问 · 剔死路 brief
  | 'revise_q' // 预测侧换问（新 qk，非 deepen 子问）

export type ReasonSub =
  | 'same_q' // 同问换推
  | 'deepen' // 深化子 Q（继承父 prospect）

export interface CritiqueAutopsy {
  badProspectKeys: string[]
  keepBriefKeys: string[]
  dropBriefKeys: string[]
  excludeInferKeys: string[]
  touchedBookKeys: string[]
  /** 本轮否定的 path（同问复盘禁采纳；换问时亦勿直接 reuse 这条死路） */
  badPathKeys: string[]
  failShape: string
}

export interface CritiqueDecision {
  fault: CritiqueFault
  predictSub?: PredictSub
  reasonSub?: ReasonSub
  /** 狭义推理 deepen 的子问文 */
  deepenQuestion?: string
  /** 预测轨 revise_q 的新问文（独立 qk，非父链深化） */
  reviseQuestion?: string
  autopsy: CritiqueAutopsy
  decideStrategyHint: string
  why: string
  raw: string
}

export interface CritiqueLedger {
  queryKey: string
  question: string
  parentQueryKey: string | null
  prospects: Array<{
    prospectKey: string
    briefKey: string
    text: string
  }>
  infers: Array<{
    inferKey: string
    bookKeys: string[]
    text: string
  }>
  /** 本问已落 path（配对结果 = 归因仪表） */
  paths: Array<{
    pathKey: string
    inferKey: string
    prospectKey: string
    matchMode: string
  }>
  pathKeys: string[]
  /**
   * 上一轮 query LLM 落账的 neighbour I/O：
   * 历史问与现问的相关度 + 该历史线上的 path —— 供判「贴着 reuse / 躲开 / 换问」
   */
  queryNeighbours: Array<{
    neighbourKey: string
    historicQueryKey: string
    historicQuestion: string
    degree: string
    pathKeys: string[]
  }>
  pending: boolean
  weakDecideKeys: string[]
  unreadDecideKeys: string[]
}

export function gatherCritiqueLedger(queryKey: string): CritiqueLedger | null {
  const qk = queryKey.trim()
  if (!qk) return null
  const st = useAttentionIo.getState()
  const family = new Set(st.listQuerySelfAndAncestors(qk))
  const question = st.settledQueries[qk] ?? ''
  const prospects = st.prospects
    .filter((p) => family.has(p.queryKey))
    .map((p) => ({
      prospectKey: p.prospectKey,
      briefKey: p.briefKey,
      text: p.text,
    }))
  const infers = st.inferEdges
    .filter((e) => family.has(e.queryKey))
    .map((e) => ({
      inferKey: e.inferKey,
      bookKeys: [...e.bookKeys],
      text: e.infer || e.rationale,
    }))
  if (prospects.length === 0 && infers.length === 0) return null

  const paths = st.listPathsForQueryKey(qk).map((p) => ({
    pathKey: p.pathKey,
    inferKey: p.inferKey,
    prospectKey: p.prospectKey,
    matchMode: p.matchMode,
  }))
  // 挂起未配时，把候选 ι×prospect 也视作「本轮待审成案」参考
  const pending = st.pendingPathMatch
  const pathKeys = [
    ...new Set([
      ...paths.map((p) => p.pathKey),
      ...(pending?.queryKey === qk ? pending.pathKeys ?? [] : []),
    ]),
  ]

  const queryNeighbours = st.neighbours
    .filter((n) => n.nowQueryKey === qk || family.has(n.nowQueryKey))
    .map((n) => {
      const hq = n.historicQueryKey
      return {
        neighbourKey: n.neighbourKey,
        historicQueryKey: hq,
        historicQuestion: st.settledQueries[hq] ?? '',
        degree: n.degree,
        pathKeys: st.listPathsForQueryKey(hq).map((p) => p.pathKey),
      }
    })

  return {
    queryKey: qk,
    question,
    parentQueryKey: st.getQueryParent(qk),
    prospects,
    infers,
    paths,
    pathKeys,
    queryNeighbours,
    pending: Boolean(pending && pending.queryKey === qk),
    weakDecideKeys: st.listKeysNeedingMore('decide', { queryKey: qk }),
    unreadDecideKeys: st.listKeysUnread('decide', { queryKey: qk }),
  }
}

function formatLedger(ledger: CritiqueLedger): string {
  const lines = [
    `queryKey=\`${ledger.queryKey}\``,
    `Q：${ledger.question}`,
    `parentQueryKey=${ledger.parentQueryKey ?? '∅（根）'}`,
    `pendingPath=${ledger.pending}`,
    `decide weak：${ledger.weakDecideKeys.slice(0, 12).join(', ') || '∅'}`,
    `decide unread：${ledger.unreadDecideKeys.slice(0, 12).join(', ') || '∅'}`,
    '',
    '【本问 path · 配对仪表】',
  ]
  if (ledger.paths.length === 0) {
    lines.push('（尚无已落 path）')
  } else {
    for (const p of ledger.paths) {
      lines.push(
        `pathKey=\`${p.pathKey}\` ι=\`${p.inferKey}\` prospect=\`${p.prospectKey}\` mode=${p.matchMode}`,
      )
    }
  }
  lines.push('', '【上一轮 queryLLM · neighbour I/O】')
  if (ledger.queryNeighbours.length === 0) {
    lines.push('（无 neighbour；reuse 候选空，除非换问后重跑 query）')
  } else {
    for (const n of ledger.queryNeighbours) {
      lines.push(
        `neighbour=\`${n.neighbourKey}\` → historic=\`${n.historicQueryKey}\` degree=${n.degree}\n` +
          `旧Q：${n.historicQuestion || '（无原文）'}\n` +
          `该线上 pathKeys：${n.pathKeys.join(', ') || '∅'}\n`,
      )
    }
  }
  lines.push('', '【prospects】')
  for (const p of ledger.prospects) {
    lines.push(
      `prospectKey=\`${p.prospectKey}\` briefKey=\`${p.briefKey}\`\n${p.text}\n`,
    )
  }
  lines.push('【infers】')
  for (const e of ledger.infers) {
    lines.push(
      `inferKey=\`${e.inferKey}\` bookKeys=${e.bookKeys.map((k) => `\`${k}\``).join(',')}\nι：${e.text}\n`,
    )
  }
  return lines.join('\n')
}

function emptyAutopsy(): CritiqueAutopsy {
  return {
    badProspectKeys: [],
    keepBriefKeys: [],
    dropBriefKeys: [],
    excludeInferKeys: [],
    touchedBookKeys: [],
    badPathKeys: [],
    failShape: '',
  }
}

function defaultBadPaths(ledger: CritiqueLedger): string[] {
  const fromSelf = ledger.pathKeys
  // neighbour 线上与本问 ι/prospect 相交的 path，也标成嫌疑死路
  const inferSet = new Set(ledger.infers.map((e) => e.inferKey))
  const prSet = new Set(ledger.prospects.map((p) => p.prospectKey))
  const st = useAttentionIo.getState()
  const linked: string[] = []
  for (const n of ledger.queryNeighbours) {
    for (const pk of n.pathKeys) {
      const row = st.paths.find((p) => p.pathKey === pk)
      if (!row) continue
      if (inferSet.has(row.inferKey) || prSet.has(row.prospectKey)) {
        linked.push(pk)
      }
    }
  }
  return [...new Set([...fromSelf, ...linked])]
}

/** 启发式归因（LLM 失败或可规则命中时） */
export function heuristicCritique(input: {
  userText: string
  ledger: CritiqueLedger
}): CritiqueDecision {
  const t = input.userText.trim()
  const { ledger } = input
  const autopsy: CritiqueAutopsy = {
    ...emptyAutopsy(),
    excludeInferKeys: ledger.infers.map((e) => e.inferKey),
    touchedBookKeys: [
      ...new Set(ledger.infers.flatMap((e) => e.bookKeys)),
    ],
    keepBriefKeys: [
      ...new Set(ledger.prospects.map((p) => p.briefKey).filter(Boolean)),
    ],
    badProspectKeys: ledger.prospects.map((p) => p.prospectKey),
    badPathKeys: defaultBadPaths(ledger),
    failShape: 'heuristic',
  }

  const wantDeepen = /深化|收窄|更具体/.test(t)
  const wantReviseQ =
    /换问|改问|问偏|问法不对|不是这个问题|重新问|换个问题|推翻问|问错了/.test(t)
  const materialish =
    /材料|原文|贴|brief|不够|缺|seed|peek|扩搜|门牌|找错/.test(t)
  const predictish =
    /预测|prospect|框错|不是这个可能|decide|决策/.test(t) ||
    materialish ||
    wantReviseQ
  const reasonish =
    (/推理|方向|换推|infer|ι|推歪|换条路|排除这条/.test(t) || wantDeepen) &&
    !wantReviseQ

  const hasProspect = ledger.prospects.length > 0
  const hasInfer = ledger.infers.length > 0
  const weak =
    ledger.weakDecideKeys.length > 0 || ledger.unreadDecideKeys.length > 0

  if (reasonish && !predictish && hasProspect && hasInfer) {
    const deepText = wantDeepen
      ? t
          .replace(/^(请)?(深化|收窄|更具体)(问句|问题|一下|这题)?[：:\s]*/i, '')
          .trim() || t
      : undefined
    return {
      fault: 'reason_narrow',
      reasonSub: wantDeepen ? 'deepen' : 'same_q',
      deepenQuestion: deepText,
      autopsy: {
        ...autopsy,
        badProspectKeys: [],
        failShape: 'reason_narrow·须排除坏ι',
      },
      decideStrategyHint: '',
      why: wantDeepen
        ? '材料与预测大方向仍可用；深化 Q + 排除坏 ι，跳过 decide'
        : '材料与预测大方向仍可用；同问换推，必排坏 ι，跳过 decide',
      raw: '',
    }
  }

  if (predictish || weak || (hasInfer && !reasonish)) {
    let sub: PredictSub = wantReviseQ
      ? 'revise_q'
      : materialish || weak
        ? 'need_peek'
        : /剔|死路|别用这|换材料/.test(t)
          ? 'drop_briefs'
          : 'reframe'

    if (sub === 'drop_briefs') {
      if (autopsy.dropBriefKeys.length === 0) {
        const badSet = new Set(autopsy.badProspectKeys)
        const fromBad = ledger.prospects
          .filter((p) => badSet.has(p.prospectKey))
          .map((p) => p.briefKey)
          .filter(Boolean)
        autopsy.dropBriefKeys = [...new Set(fromBad)]
      }
      if (autopsy.dropBriefKeys.length === 0) {
        sub = 'reframe'
        autopsy.failShape = 'drop_briefs·无可靠死路brief→reframe'
      } else {
        const dropSet = new Set(autopsy.dropBriefKeys)
        autopsy.keepBriefKeys = autopsy.keepBriefKeys.filter(
          (k) => !dropSet.has(k),
        )
      }
    }

    const reviseQuestion =
      sub === 'revise_q'
        ? t
            .replace(
              /^(请)?(换问|改问|重新问|换个问题|推翻问|问法不对)[：:\s]*/i,
              '',
            )
            .trim() || t
        : undefined

    const nbHint =
      ledger.queryNeighbours.length > 0
        ? `参考 query 邻域：${ledger.queryNeighbours
            .slice(0, 4)
            .map(
              (n) =>
                `${n.historicQueryKey}(${n.degree})→path×${n.pathKeys.length}`,
            )
            .join('；')}。同问禁坏 path：${autopsy.badPathKeys.slice(0, 6).join(',') || '∅'}；其它邻域 path 仍可 reuse。`
        : `无 neighbour I/O；坏 path：${autopsy.badPathKeys.slice(0, 6).join(',') || '∅'}。`

    const hint =
      sub === 'revise_q'
        ? `【监督尸检→换问】旧 Q 立错。新问勿继承旧 prospect 框。旧 ι/prospect 仅负向样本。${nbHint}` +
          `坏 prospect：${autopsy.badProspectKeys.slice(0, 6).join(', ') || '∅'}。`
        : sub === 'reframe'
          ? `【监督尸检→decide 策略】勿再铸同构 prospect：${autopsy.badProspectKeys.map((k) => `\`${k}\``).join(', ') || '（见上轮）'}。` +
            `失败形态：旧 ι 在错误预测上硬撑。${nbHint}` +
            `可留 brief：${autopsy.keepBriefKeys.slice(0, 8).join(', ') || '窗内 brief'}。`
          : sub === 'need_peek'
            ? `【监督尸检→decide 策略】材料/邻域可能不够。先重 decide；若仍 insufficient，再 peek。${nbHint}` +
              `ι 咬过 book：${autopsy.touchedBookKeys.slice(0, 8).join(', ') || '∅'}。`
            : `【监督尸检→decide 策略】死路 brief 建议剔除：${autopsy.dropBriefKeys.slice(0, 8).join(', ')}。` +
              `可留：${autopsy.keepBriefKeys.slice(0, 8).join(', ') || '其余 brief'}。${nbHint}`

    return {
      fault: 'predict',
      predictSub: sub,
      reviseQuestion,
      autopsy,
      decideStrategyHint: hint,
      why:
        sub === 'revise_q'
          ? '问法立错（预测侧换问）；新 qk 走标准流含 reuse；≠ 狭义深化'
          : sub === 'reframe'
            ? '预测框错；同问重 decide；禁坏 path，其它邻域可 reuse'
            : sub === 'need_peek'
              ? '材料侧嫌疑；同问补材料；禁坏 path'
              : '死路 brief；剔后重 decide',
      raw: '',
    }
  }

  return {
    fault: 'ask_user',
    autopsy,
    decideStrategyHint: '',
    why: '说不清是预测（材料/prospect/换问）还是狭义推理（方向/ι）。请点明。',
    raw: '',
  }
}

function parseCritiqueJson(
  content: string,
  ledger: CritiqueLedger,
): CritiqueDecision | null {
  const obj = extractJsonObject(content)
  if (!obj || typeof obj !== 'object') return null
  const root = obj as Record<string, unknown>
  const faultRaw = String(root.fault ?? root.track ?? '').trim()
  let fault: CritiqueFault = 'ask_user'
  if (/predict|预测|材料|prospect/i.test(faultRaw)) fault = 'predict'
  else if (/reason|推理|narrow|方向/i.test(faultRaw)) fault = 'reason_narrow'
  else if (/ask/i.test(faultRaw)) fault = 'ask_user'

  const subRaw = String(root.sub ?? root.predictSub ?? root.reasonSub ?? '').trim()
  const autopsyIn =
    (root.autopsy as Record<string, unknown> | undefined) ?? root
  const asKeys = (v: unknown): string[] => {
    if (!Array.isArray(v)) return []
    return v.map((x) => String(x).trim()).filter(Boolean)
  }

  const autopsy: CritiqueAutopsy = {
    badProspectKeys: asKeys(
      autopsyIn.badProspectKeys ?? autopsyIn.badProspects,
    ),
    keepBriefKeys: asKeys(autopsyIn.keepBriefKeys ?? autopsyIn.keepBriefs),
    dropBriefKeys: asKeys(autopsyIn.dropBriefKeys ?? autopsyIn.dropBriefs),
    excludeInferKeys: asKeys(
      autopsyIn.excludeInferKeys ?? autopsyIn.excludeInfers,
    ),
    touchedBookKeys: asKeys(
      autopsyIn.touchedBookKeys ?? autopsyIn.bookKeys,
    ),
    badPathKeys: asKeys(autopsyIn.badPathKeys ?? autopsyIn.badPaths),
    failShape: String(autopsyIn.failShape ?? root.why ?? '').trim(),
  }
  if (autopsy.excludeInferKeys.length === 0) {
    autopsy.excludeInferKeys = ledger.infers.map((e) => e.inferKey)
  }
  if (autopsy.badPathKeys.length === 0) {
    autopsy.badPathKeys = defaultBadPaths(ledger)
  }

  const why = String(root.why ?? root.note ?? '').trim() || fault
  const deepenQuestion = String(
    root.deepenQuestion ?? root.deepen ?? '',
  ).trim()
  const reviseQuestion = String(
    root.reviseQuestion ?? root.newQuestion ?? '',
  ).trim()

  if (fault === 'reason_narrow') {
    const reasonSub: ReasonSub =
      /deepen|深化|收窄/i.test(subRaw) || deepenQuestion
        ? 'deepen'
        : 'same_q'
    return {
      fault,
      reasonSub,
      deepenQuestion: deepenQuestion || undefined,
      autopsy: { ...autopsy, badProspectKeys: [] },
      decideStrategyHint: '',
      why,
      raw: content,
    }
  }

  if (fault === 'predict') {
    let predictSub: PredictSub = 'reframe'
    if (/revise|换问|改问|问法/i.test(subRaw) || reviseQuestion) {
      predictSub = 'revise_q'
    } else if (/peek|seed|材料|扩/i.test(subRaw)) predictSub = 'need_peek'
    else if (/drop|剔|死路/i.test(subRaw)) predictSub = 'drop_briefs'
    const hint =
      String(root.decideStrategyHint ?? root.strategyHint ?? '').trim() ||
      heuristicCritique({
        userText: why + (reviseQuestion ? ` 换问：${reviseQuestion}` : ''),
        ledger,
      }).decideStrategyHint
    return {
      fault,
      predictSub,
      reviseQuestion: reviseQuestion || undefined,
      autopsy,
      decideStrategyHint: hint,
      why,
      raw: content,
    }
  }

  return {
    fault: 'ask_user',
    autopsy,
    decideStrategyHint: '',
    why: why || '请说明是预测问题还是推理方向问题',
    raw: content,
  }
}

export async function runSuperviseCritique(input: {
  userText: string
  queryKey: string
  onProgress?: (msg: string) => void
}): Promise<CritiqueDecision> {
  const ledger = gatherCritiqueLedger(input.queryKey)
  if (!ledger) {
    return {
      fault: 'ask_user',
      autopsy: emptyAutopsy(),
      decideStrategyHint: '',
      why: '台账无 prospect/infer，无法监督归因。请先跑完自动流或钉住本问。',
      raw: '',
    }
  }

  const fallback = heuristicCritique({
    userText: input.userText,
    ledger,
  })

  const { reason } = loadDualModelConfig()
  if (!reasonEndpointReady(reason)) return fallback

  const base = (reason.baseUrl.trim() || '/api/llm').replace(/\/$/, '')
  input.onProgress?.('监督归因 · 预测轨 vs 狭义推理轨…')
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...demoAuthHeaders(),
      },
      body: JSON.stringify({
        model: reason.model || LOCKED_LLM.chatModel,
        temperature: 0,
        // 监督归因 = 分类路由，不开 reasoning
        ...llmThinkingField('disabled'),
        messages: [
          {
            role: 'system',
            content:
              '你是写信台监督归因（不是 path 配对）。path 与 query→neighbour 是参考仪表。\n' +
              '只判两轨之一：\n' +
              '1) predict：材料/prospect/问法立错。子型：\n' +
              '   - reframe|need_peek|drop_briefs：同问；禁采纳 badPathKeys；其它 neighbour 线上 path 仍可 reuse。\n' +
              '   - revise_q：问法推翻；输出 reviseQuestion；新问独立 qk（不要当成 deepen 子问）；标准流含 reuse；旧 ι/prospect 只负向。\n' +
              '2) reason_narrow：材料∩预测大方向仍成立；same_q 换推或 deepen 子问；必排坏 ι；禁止重跑 decide。\n' +
              '判 revise_q vs deepen：问法立错→revise_q；大框仍对只收窄→deepen。\n' +
              '参考【上一轮 queryLLM · neighbour I/O】决定：贴着哪条历史 reuse、躲开哪条死路、是否该换问。\n' +
              '只输出 JSON：{"fault":"predict"|"reason_narrow"|"ask_user","sub":"reframe|need_peek|drop_briefs|revise_q|same_q|deepen","reviseQuestion":"…或空","deepenQuestion":"…或空","autopsy":{"badProspectKeys":[],"keepBriefKeys":[],"dropBriefKeys":[],"excludeInferKeys":[],"touchedBookKeys":[],"badPathKeys":[],"failShape":"…"},"decideStrategyHint":"…","why":"…"}',
          },
          {
            role: 'user',
            content: [
              '【用户不满】',
              input.userText,
              '',
              '【台账】',
              formatLedger(ledger),
            ].join('\n'),
          },
        ],
      }),
    })
    if (!res.ok) return fallback
    const data: unknown = await res.json()
    const content =
      typeof data === 'object' &&
      data &&
      'choices' in data &&
      Array.isArray((data as { choices: unknown }).choices)
        ? (data as { choices: Array<{ message?: { content?: string } }> })
            .choices[0]?.message?.content
        : undefined
    if (typeof content !== 'string') return fallback
    ingestKeyIncrementStatuses({
      job: 'supervise',
      llmText: content,
      windowKeys: [
        ...ledger.prospects.map((p) => p.prospectKey),
        ...ledger.infers.map((e) => e.inferKey),
        ...ledger.pathKeys,
        ...ledger.queryNeighbours.map((n) => n.neighbourKey),
      ],
      queryKey: ledger.queryKey,
    })
    return parseCritiqueJson(content, ledger) ?? fallback
  } catch {
    return fallback
  }
}

/** 本问族已有 ι → 再开 infer 必须排除（狭义推理记忆） */
export function priorInferKeysForQuery(queryKey: string): string[] {
  const st = useAttentionIo.getState()
  const family = new Set(st.listQuerySelfAndAncestors(queryKey))
  return st.inferEdges
    .filter((e) => family.has(e.queryKey))
    .map((e) => e.inferKey)
}
