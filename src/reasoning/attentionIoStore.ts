/**
 * 评论层注意力 + 写信台递交确认（Q / 工种 / 版本）→ WM 包。
 * 几何：决策/主推理 = 评论同构同心外球（见 surfaceGeometry shell scales）。
 */

import { create } from 'zustand'
import {
  fingerprintOfInfer,
  mintInferKey,
  mintQueryKey,
  type InferPathRaw,
} from './inferPath'
import {
  deliveryId,
  type DeskDeliveryLink,
} from './deskDelivery'
import {
  contentFingerprint,
  mintInstanceKey,
  newLlmCallId,
  newSettleActionId,
  statusAllowsMint,
} from './settleMint'
import {
  MIN_PROSPECT_RELEVANCE,
  relevanceAllowsInfer,
} from '../arch/prospectRelevance'
import { bindSolutionsByBookLineage, composeNormTextFromPath } from './pathLineageBind'
import { useIndexGate } from './indexGate'
import type { LlmCallLedgerEntry } from './llmCallLedger'
import {
  buildWindowAliasTable,
  resolveWindowDoorplate,
} from '../arch/windowAlias'
import { jobToOutKeyKind } from './llmCallLedger'
import type {
  IncrementReadStatus,
  KeyIncrementStatusRow,
  StatusJob,
} from './keyIncrementStatus'
import {
  listQueryFamilyKeys,
  listQuerySelfAndAncestors as lineageSelfAndAncestors,
} from '../arch/queryLineage'

export type KeyKind =
  | 'query'
  | 'brief'
  | 'book'
  | 'delta'
  | 'infer'
  | 'prospect'
  | 'path'
  | 'other'

/** 写信台工种；都不选 = peek（换 I/O） */
export type DeskJob = 'peek' | 'query' | 'decide' | 'supervise' | 'infer'
export type { DeskDeliveryJob, DeskDeliveryLink } from './deskDelivery'

export interface AttentionRow {
  key: string
  kind: KeyKind
  text: string
}

export interface AttentionStep {
  id: string
  deltaKey: string
  label: string
  premiseKeys: string[]
  input: AttentionRow[]
  output: AttentionRow[]
  /** 本步绑定的提问（问题域） */
  question: string
  createdAt: number
}

export interface AttentionEdge {
  id: string
  fromKey: string
  toKey: string
  stepId: string
  bondId?: string
}

/**
 * 主推理边：bookKey──(inferKey)──bookKey
 * inferKey = 写信台落账微动作铸键（方案 B）；一槽一 key（解法内的一步）
 */
export interface InferEdge {
  id: string
  inferKey: string
  settleActionId: string
  /** 同一次 LLM 调用批；多槽共享 */
  llmCallId?: string
  /** 正文副索引（fp_*），不当门牌 */
  contentFingerprint: string
  /** 本步全部材料门（≥1；溯源） */
  bookKeys: string[]
  /** 与 bookKeys 等长：窗内 ⟦n⟧ 槽号（展开时写入） */
  bookSlots?: number[]
  /** UI 连线端：单门时 from===to；多门时为首尾 */
  fromBookKey: string
  toBookKey: string
  /** 增量正文 infer（本步如何从材料推出） */
  infer: string
  /**
   * @deprecated 同 infer；旧字段名，读写均指向增量正文
   */
  rationale: string
  /** 解法级：所属 solutionKey（一条 conclusion 解法） */
  solutionKey?: string
  /** 解法总览（同 solution 各步共享） */
  conclusion?: string
  /** 本步服务 conclusion 的哪一块 */
  role?: string
  /** 窗左（in）：材料摘录 + Q */
  leftText: string
  /** 窗右（out）：本步 infer */
  rightText: string
  question: string
  /** 本轮 queryKey（settle 时挂上） */
  queryKey: string
  pathIndex: number
  stepIndex: number
  /**
   * 落账时序序号（单调递增）。
   * 只标记进 LTM 的次序，便于查看/撤销；≠ 已调度进 WM，≠ 已钉注意力。
   */
  settleSeq: number
  createdAt: number
}

/**
 * decide 增量：prospect 挂在 briefKey 上（每槽一次 settle，非共享批坐标）
 */
export interface ProspectRecord {
  prospectKey: string
  settleActionId: string
  /** 同一次 decide LLM 调用批 */
  llmCallId?: string
  /**
   * 材料父门。
   * main：briefKey；本实验分支：= bookKey（顶替 brief 索引位）。
   */
  briefKey: string
  text: string
  contentFingerprint: string
  queryKey: string
  /** decide 对 Q 的解问相关度 1–5；缺省视为 3 */
  relevance?: number
  settleSeq: number
  createdAt: number
}

/**
 * path = 一条解法（conclusion 总览）的候选/成案；steps 为载荷；prospect 按 book 成对挂载（不叉乘）。
 * matchMode: candidate = infer 后台先铸；user = 人手确认；supervise_llm = 监督印证
 */
export interface PathRecord {
  pathKey: string
  settleActionId: string
  llmCallId?: string
  /**
   * 兼容旧：首步 inferKey；解法级请看 inferKeys
   */
  inferKey: string
  /**
   * 兼容旧：首个 prospectKey（可空）；解法级请看 prospectKeys
   */
  prospectKey: string
  queryKey: string
  matchMode: 'candidate' | 'user' | 'supervise_llm'
  /** 监督三态；candidate 默认 unread */
  validityStatus?: 'sufficient' | 'insufficient' | 'unread'
  /** 解法 ID（与 InferEdge.solutionKey 对齐） */
  solutionKey?: string
  /** 解法总览 */
  conclusion?: string
  inferKeys?: string[]
  prospectKeys?: string[]
  bookKeysSequence?: string[]
  steps?: Array<{
    inferKey: string
    role: string
    bookKeys: string[]
    /** 与 bookKeys 等长：窗内 ⟦n⟧ 槽号 */
    bookSlots?: number[]
    infer: string
  }>
  settleSeq: number
  createdAt: number
}

/**
 * 推理归一化 key：监督对充分 path 写出的单段路径正文（infer 为底、prospect 修饰）
 * 挂靠 pathKey；reuse 主坐标
 */
export interface NormRecord {
  normKey: string
  pathKey: string
  settleActionId: string
  llmCallId?: string
  text: string
  contentFingerprint: string
  queryKey: string
  settleSeq: number
  createdAt: number
}

/** infer 落账后：等人手确认成案；未完成前禁止自动信效度 LLM */
export interface PendingPathBoundPair {
  pathKey: string
  /** 兼容：首步 inferKey */
  inferKey: string
  /** 兼容：首个 prospect（可空） */
  prospectKey: string
  briefKey: string
  sharedBookKeys: string[]
  solutionKey?: string
  conclusion?: string
  inferKeys?: string[]
  prospectKeys?: string[]
  bookKeysSequence?: string[]
  steps?: Array<{
    inferKey: string
    role: string
    bookKeys: string[]
    bookSlots?: number[]
    inferText: string
  }>
  prospects?: Array<{
    prospectKey: string
    briefKey: string
    bookKey: string
    text: string
  }>
}

export interface PendingPathMatch {
  queryKey: string
  question: string
  /** 已铸候选 pathKey */
  pathKeys: string[]
  /** 同窝对上的 infer（已血缘绑定，非全量候选） */
  inferKeys: string[]
  /** 同窝对上的 prospect（已血缘绑定） */
  prospectKeys: string[]
  /** 台已绑定的同窝对（含 pathKey）；人手/LLM 只许在此集合上确认或评测 */
  boundPairs: PendingPathBoundPair[]
  createdAt: number
}

/** 复用闸判可复用后：先展示再批；未批前不铸 reuseKey */
export interface PendingReuseCandidate {
  normKey: string
  pathKey: string
  oldQueryKey: string
  rationale: string
  normText: string
  bookKeys: string[]
  inferKeys: string[]
  prospectKeys: string[]
}

export interface PendingReuseProposal {
  queryKey: string
  question: string
  candidates: PendingReuseCandidate[]
  /** 若整单撤销 → 落入新铸时剔除 */
  excludeBriefKeys: string[]
  createdAt: number
}

/**
 * 复用任务停泊：当前有 neighbour 相关，但已审 norm 都不够撑满 Q_now，
 * 且仍有相关历史问尚未铸 norm → 不落入 decide/infer，等确认 path 后再续跑复用闸。
 * 续跑顺序 = neighbour 落账序（阶段 A）。
 */
export interface PendingReuseWait {
  queryKey: string
  question: string
  neighbourOrder: Array<{
    historicQueryKey: string
    degree: string
    rank: number
  }>
  /** 已审 canSolve=false 的 norm */
  exhaustedNormKeys: string[]
  /** 仍缺 norm、按 neighbour 序等待的 historic qk */
  awaitingHistoricQueryKeys: string[]
  lastNote: string
  createdAt: number
  updatedAt: number
}

/** queryLLM neighbour：相关度挂在被选中的历史 queryKey 上（不是挂在 Q_now） */
export interface NeighbourRecord {
  neighbourKey: string
  settleActionId: string
  llmCallId?: string
  /**
   * 历史 queryKey —— neighbour 增量挂靠对象。
   * 含义：这条「旧问」相对 Q_now 有多相关；之后可凭它索引到旧 query 线做 reuse。
   */
  historicQueryKey: string
  /** 当前问的 queryKey（本轮串联） */
  nowQueryKey: string
  /** 相关程度说明 / 序位（queryLLM 产出的增量） */
  degree: string
  rank: number
  settleSeq: number
  createdAt: number
}

/**
 * 复用边：现 queryKey ──reuseKey──► normKey（谱系可回 path）
 */
export interface QueryReuseLink {
  id: string
  reuseKey: string
  settleActionId: string
  llmCallId?: string
  fromQueryKey: string
  /** 被复用的归一化推理 */
  normKey: string
  /** 谱系：norm 挂靠的 path */
  pathKey: string
  /** 兼容旧 UI：path 所属旧 queryKey */
  toQueryKey: string
  question: string
  oldQuestion: string
  rationale: string
  inferKeys: string[]
  prospectKeys: string[]
  settleSeq: number
  createdAt: number
}

/** 评论层「注意力切换」后的确认草稿（未确认前不进写信台） */
export interface DeskConfirmDraft {
  edgeId: string
  qDraft: string
  /** 历史 Q 灰色补全（点才采纳） */
  qGhost: string | null
  job: DeskJob
  /** 0 = 最新 head；更大 = 更旧版本索引 */
  versionIndex: number
}

/** 确认后的写信台薄指令（门牌+工种+Q；正文由台 fetch，不在此打包） */
export interface LetterDeskPackage {
  id: string
  edgeId: string
  /** 种子门牌 */
  bookKey: string
  briefKey: string
  question: string
  job: DeskJob
  versionIndex: number
  createdAt: number
  /** @deprecated 正文应台侧 fetch；保留空串兼容 UI */
  bookText?: string
  briefText?: string
  /** infer 玩法 B：钉住 ι 换方向；缺省不排除 */
  excludeMode?: 'B'
  /** 玩法 B：要排除的 inferKey[] */
  excludeInferKeys?: string[]
  /** decide：只压这些 briefKey（续滚）；缺省则 seed+同 Q 历史 */
  onlyBriefKeys?: string[]
  /** infer：只压这些 bookKey；缺省则 expand 会扩成 ready/hist 全集（易整表） */
  onlyBookKeys?: string[]
  /** 监督预测轨：decide 窗内的策略尸检提示（迭代策略，非直接 seedRange） */
  decideCritiqueHint?: string
  /** 实验：目录导航轮 —— 只送章节框架（校准 strand），要 strand 起止，不铸 prospect */
  tocNav?: boolean
  /** tocNav 时的目录正文（台组窗用） */
  tocCatalog?: string
  /**
   * reframe 硬闸：这些坏 prospect 正文的「像不像」样本；
   * 新铸 prospect 若同构则拒落账（可触发一次重 decide）。
   */
  avoidProspectTexts?: string[]
  /**
   * infer 包：跳过嵌套复用闸（autoFlow 入口已跑过 reuse）。
   * 避免二次闸 + 环依赖把新铸卡死在 expand 之后。
   */
  skipReuse?: boolean
}

/** 意图路由沿革 · 台侧记录（≠ 注意力窗 I/O） */
export interface IntentDeskLogEntry {
  id: string
  at: number
  sessionEpoch: number
  question: string
  action: string
  note: string
}

export interface LetterDeskPickup {
  packages: LetterDeskPackage[]
  edgeIds: string[]
  bookKeys: string[]
  briefKeys: string[]
  pairs: Array<{
    edgeId: string
    bookKey: string
    briefKey: string
    bookText: string
    briefText: string
    question: string
    job: DeskJob
  }>
}

/** 问句规范化：同文判定用（ trim + 空白折叠 + 去语气尾） */
export function normalizeQuestionText(question: string): string {
  return question
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[?？]+$/g, '')
    .replace(/(?:呢|吗|么|呀|啊)+$/g, '')
    .trim()
}

/** bookKey → 曾用过的提问原文（倒查排除问法） */
function latestQueryKeyForQuestion(
  settled: Record<string, string>,
  question: string,
): string | null {
  const q = normalizeQuestionText(question)
  if (!q) return null
  let best: string | null = null
  for (const [qk, text] of Object.entries(settled)) {
    if (normalizeQuestionText(text) === q) best = qk
  }
  return best
}

/** 显式「切换注意力」钉住；≠ 仅打开查看 */
export type PinnedAttention =
  | { kind: 'edge'; edgeId: string; label: string }
  | { kind: 'infer'; inferKey: string }
  | { kind: 'query'; queryKey: string }

interface AttentionIoState {
  steps: AttentionStep[]
  edges: AttentionEdge[]
  /** 主推理哈希边 book──(inferKey)──book */
  inferEdges: InferEdge[]
  selectedEdgeId: string | null
  selectedInferKey: string | null
  /** 点开 ι 时所在页：展开面板挂这里（与 book 哪一页无关，只防双开） */
  selectedInferHostStrand: number | null
  selectedQueryKey: string | null
  /** 钉住的注意力窗（非第一步）；打开窗不会自动写入 */
  pinnedAttention: PinnedAttention | null
  /** 正在评论层确认的草稿（点注意力切换打开） */
  confirmDraft: DeskConfirmDraft | null
  /** 已确认、待/已投递写信台 */
  deskPackages: LetterDeskPackage[]
  lastStatus: string | null
  /**
   * 写信台给人看的提示条（单问安全阀触顶等）。
   * 不进注意力窗 steps/edges。
   */
  deskPrompt: string | null
  /**
   * 意图↔台 调度沿革（保留）；禁止当注意力窗 I/O 写入。
   */
  intentDeskLog: IntentDeskLogEntry[]
  /** 意图会话代数：进过 infer 后 +1，下一轮意图 LLM 当新会话 */
  intentSessionEpoch: number
  /** @deprecated 用 deskPackages；保留兼容 chip 高亮 */
  wmEdgeIds: string[]
  /** 沿革：bookKey → 提问原文[]（主推理倒查排除问法） */
  bookKeyToQuestions: Record<string, string[]>
  questionToBookKeys: Record<string, string[]>
  questionToBriefKeys: Record<string, string[]>
  /** 已落账 queryKey → 该问曾挂 briefKey[]（阶段 A→B 容器 join） */
  queryKeyToBriefKeys: Record<string, string[]>
  /** 已落账 queryKey → 问原文（仅路径回指后） */
  settledQueries: Record<string, string>
  /**
   * 深化谱系：childQueryKey → parentQueryKey。
   * 无条目 = 根问（完全换问 / 首问）；有父 = 深化子问。
   */
  queryParentOf: Record<string, string>
  /** 问句正文指纹 → 最近一次 queryKey（副索引，不当门牌） */
  questionFingerprintToQueryKey: Record<string, string>
  /** decide 落账的 prospect（挂 briefKey） */
  prospects: ProspectRecord[]
  /** infer×prospect 候选/成案 path */
  paths: PathRecord[]
  /** 监督铸：path → 归一化推理 normKey */
  norms: NormRecord[]
  /** queryLLM neighbour 挂历史 queryKey */
  neighbours: NeighbourRecord[]
  /** 复用增量边：现问 → normKey */
  queryReuseLinks: QueryReuseLink[]
  /** infer 后候选 path：用户未完成确认时挂起 */
  pendingPathMatch: PendingPathMatch | null
  /** 复用闸可复用：等人批/撤（先展示再铸 reuseKey） */
  pendingReuseProposal: PendingReuseProposal | null
  /**
   * 复用停泊：邻域有相关但现有 norm 不够；等其它历史问铸 norm 后再续复用，
   * 禁止因此直接重推 decide/infer。
   */
  pendingReuseWait: PendingReuseWait | null
  /** 各 LLM：输入 key → 增量三态（unread/sufficient/insufficient） */
  keyIncrementStatuses: KeyIncrementStatusRow[]
  /**
   * 热启饥饿：decide 写了闭集但展开为空（常因中间页尚未 OCR）。
   * 后台入账后 noteBookIndexAugmented 只在仍 insufficient 时补给。
   */
  pendingHunger: null | { queryKey: string; closed: Array<{ from: string; to: string }> }
  /** 待热启 peek 的 bookKey（后台新入账 ∩ 饥饿闭集未开） */
  pendingIngestFeedBookKeys: string[]
  setPendingHunger: (h: {
    queryKey: string
    closed: Array<{ from: string; to: string }>
  }) => void
  clearPendingHunger: () => void
  offerPendingIngestFeed: (bookKeys: string[]) => void
  takePendingIngestFeed: () => string[]
  clearPendingIngestFeed: () => void
  /**
   * 下一笔落账用的时序序号（从 1 起）。
   * 调度（隐→显）与注意力切换分轨；本计数只服务 LTM 落账次序。
   */
  nextSettleSeq: number
  /** 写信台递送有向边：fromKeys ──► toKey（尖 = 递送 key） */
  deskDeliveries: DeskDeliveryLink[]
  /** 一次 LLM 调用批台账（进度边 / 集合面板） */
  llmCallLedger: LlmCallLedgerEntry[]
  nextLlmCallTurnSeq: number
  registerLlmCallBatch: (input: {
    llmCallId: string
    job: LlmCallLedgerEntry['job']
    memberKeys: string[]
    queryKey: string
    keyKind?: LlmCallLedgerEntry['keyKind']
  }) => void
  recordDeskDelivery: (input: {
    job: DeskDeliveryLink['job']
    fromKeys: string[]
    toKey: string
    stepId?: string
  }) => void
  /**
   * 记录 LLM 对输入 key 的增量三态（供写信台决定递送哪些）。
   * 同 job+key+queryKey 保留最新一条（问线隔离；无 queryKey 的旧行另槽）。
   */
  recordKeyIncrementStatuses: (input: {
    job: StatusJob
    /** 本问线；缺省则不挂 qk（仅兼容，调度应尽量传入） */
    queryKey?: string
    rows: Array<{
      key: string
      status: IncrementReadStatus
      incrementKey?: string
      note?: string
    }>
  }) => void
  listKeyStatuses: (opts?: {
    job?: StatusJob
    status?: IncrementReadStatus
    queryKey?: string
    includeFamily?: boolean
  }) => KeyIncrementStatusRow[]
  /** 充分 → 可递送下游的输入 key */
  listKeysReadyToDeliver: (
    job?: StatusJob,
    scope?: { queryKey?: string; includeFamily?: boolean },
  ) => string[]
  /** 不充分 → 需补材料 */
  listKeysNeedingMore: (
    job?: StatusJob,
    scope?: { queryKey?: string; includeFamily?: boolean },
  ) => string[]
  /** 未读 → 尚未处理 */
  listKeysUnread: (
    job?: StatusJob,
    scope?: { queryKey?: string; includeFamily?: boolean },
  ) => string[]
  /**
   * 本问 queryKey：同文（规范化后）复用已有 qk；否则 settle 新铸为**根**（无父）。
   * 不满意某环 → 只重做该环，不另开 qk。
   */
  ensureQueryKey: (question: string) => string
  /** 只查不铸：同文已有则返回 qk，否则 null */
  findQueryKeyForQuestion: (question: string) => string | null
  /**
   * 深化原问：铸（或复用同文）子 queryKey，挂 parent；继承父链 brief 挂靠。
   * 同文已是该父之子 → 复用；同文等于父原文 → 返回父（未深化）。
   */
  ensureDeepenedQueryKey: (input: {
    parentQueryKey: string
    question: string
  }) => string
  getQueryParent: (queryKey: string) => string | null
  listQueryFamily: (queryKey: string) => string[]
  /** 自身 + 祖先（深化继承 prospect/path） */
  listQuerySelfAndAncestors: (queryKey: string) => string[]
  pushPeekStep: (input: {
    question: string
    items: Array<{
      key: string
      brief: string
      briefKey?: string
      bookText?: string
      bondId?: string
    }>
    mode?: 'cold' | 'hot'
    llmCallId?: string
  }) => string
  pushFlashStep: (input: {
    question: string
    items: Array<{
      key: string
      brief: string
      rationale?: string
      briefKey?: string
      bookText?: string
      bondId?: string
    }>
    answer?: string
  }) => string
  attachBondIds: (
    stepId: string,
    map: Array<{ bookKey: string; bondId: string }>,
  ) => void
  openEdge: (edgeId: string) => void
  openInferEdge: (inferKey: string, hostStrand?: number) => void
  openQueryKey: (queryKey: string) => void
  closeAttention: () => void
  /** 打开确认（不立刻进写信台） */
  beginAttentionSwitch: (edgeId: string) => void
  pinAttentionEdge: (edgeId: string) => void
  pinAttentionInfer: (inferKey: string) => void
  pinAttentionQuery: (queryKey: string) => void
  unpinAttention: () => void
  /** 打开钉住的窗（UI 跳转）；不改变钉住状态 */
  focusPinnedAttention: () => void
  cancelConfirm: () => void
  setConfirmQDraft: (text: string) => void
  acceptQGhost: () => void
  setConfirmJob: (job: DeskJob) => void
  setConfirmVersion: (index: number) => void
  /** 确认 → 写入 deskPackages；job=peek 只标记需换贴 */
  commitConfirmToDesk: () => boolean
  removeDeskPackage: (id: string) => void
  clearDesk: () => void
  getLetterDeskPickup: () => LetterDeskPickup
  listHistoricQuestions: () => string[]
  listVersionsForEdge: (edgeId: string) => Array<{
    briefKey: string
    briefText: string
    question: string
    stepId: string
  }>
  suggestQGhost: (prefix: string) => string | null
  listBriefKeysForQuestion: (question: string) => string[]
  listBookKeysForQuestion: (question: string) => string[]
  listQuestionsForBookKeys: (
    bookKeys: string[],
  ) => Array<{ queryKey: string; qText: string }>
  listInferEdgesForBookKeys: (bookKeys: string[]) => InferEdge[]
  listPathsForQueryKey: (queryKey: string) => PathRecord[]
  listNormsForPathKeys: (pathKeys: string[]) => NormRecord[]
  listNormsForQueryKey: (queryKey: string) => NormRecord[]
  listProspectsForBriefKeys: (briefKeys: string[]) => ProspectRecord[]
  listPathsForBookKeys: (bookKeys: string[]) => PathRecord[]
  /**
   * decide：仅充分 prospect 槽 settle 铸 prospectKey（铸键≠递送）。
   * 同 briefKey 可多槽；briefKey 必须 ∈ allowedBriefKeys；未读/不充分拒铸。
   */
  settleProspects: (input: {
    question: string
    queryKey?: string
    /** 同一次 decide LLM 调用 */
    llmCallId?: string
    keeps: Array<{
      briefKey: string
      prospect: string
      status?: string | null
      relevance?: number | null
    }>
    /** 本窗允许的 briefKey；缺省则不校验（仅兼容旧调用） */
    allowedBriefKeys?: string[]
  }) => {
    queryKey: string
    prospectKeys: string[]
    rejected: Array<{ briefKey: string; reason: string }>
  }
  /**
   * queryLLM：被选中的 historic queryKey + neighbour（相关度）→ 各 settle 一枚 neighbourKey
   */
  settleNeighbours: (input: {
    nowQuestion: string
    nowQueryKey?: string
    llmCallId?: string
    neighbours: Array<{ historicQueryKey: string; degree: string }>
  }) => { nowQueryKey: string; neighbourKeys: string[] }
  /**
   * 解法级 path 落账（候选或成案）；亦兼容旧 infer×prospect
   */
  settlePaths: (input: {
    queryKey: string
    llmCallId?: string
    matches: Array<{
      inferKey: string
      /** 可空：解法级无单 prospect 主键 */
      prospectKey: string
      matchMode?: 'candidate' | 'user' | 'supervise_llm'
      solutionKey?: string
      conclusion?: string
      inferKeys?: string[]
      prospectKeys?: string[]
      bookKeysSequence?: string[]
      steps?: PathRecord['steps']
    }>
  }) => { pathKeys: string[] }
  /**
   * 监督充分：在已有 pathKey 上铸 normKey（归一化推理正文）
   */
  settleNorms: (input: {
    queryKey: string
    llmCallId?: string
    rows: Array<{ pathKey: string; text: string }>
  }) => { normKeys: string[] }
  /**
   * 监督 JSON 落账：充分→铸 norm；不足→标 path；升 matchMode
   */
  confirmSupervisePaths: (input: {
    queryKey: string
    llmCallId?: string
    judgments: Array<{
      pathKey: string
      status?: 'sufficient' | 'insufficient' | 'unread'
      normalizedText?: string
    }>
  }) => { pathKeys: string[]; normKeys: string[]; note: string }
  /** infer 落账后：血缘绑定并先铸候选 pathKey，挂起等人手/监督 */
  beginPendingPathMatch: (input: {
    queryKey: string
    question: string
    inferKeys: string[]
  }) => PendingPathMatch
  /** 用户 tick 候选 pathKey → 升 user，并登记 normKey（默认证文=ι为底+prospect补全；可自带整理文） */
  settleUserPathMatches: (input: {
    queryKey?: string
    /** 优先：直接确认 pathKey */
    pathKeys?: string[]
    /** 兼容旧：infer×prospect */
    matches?: Array<{ inferKey: string; prospectKey: string }>
    /**
     * 可选：用户自己整理的归一化正文（pathKey → text）。
     * 缺省则台用 ι+prospect 拼默认正文再铸 normKey。
     */
    normalizedByPathKey?: Record<string, string>
  }) => { pathKeys: string[]; normKeys: string[]; ok: boolean; note: string }
  clearPendingPathMatch: () => void
  /** 复用闸：挂起提案（不自动 adopt） */
  beginPendingReuseProposal: (input: PendingReuseProposal) => void
  /** 批准：对选中（或缺省全部）候选 adoptReusePath */
  approvePendingReuse: (input?: {
    normKeys?: string[]
    llmCallId?: string
  }) => {
    ok: boolean
    note: string
    adopted: Array<{
      queryKey: string
      reuseKey: string
      normKey: string
      pathKey: string
    }>
  }
  /** 撤销：清挂起，返回剔除 brief 供新铸续跑 */
  rejectPendingReuse: () => {
    question: string
    queryKey: string
    excludeBriefKeys: string[]
  } | null
  clearPendingReuseProposal: () => void
  beginPendingReuseWait: (input: PendingReuseWait) => void
  clearPendingReuseWait: () => void
  /**
   * 主推理 out 落账：每步 settle 铸 inferKey；挂本轮 queryKey。
   * 先铸候选 path（beginPendingPathMatch）；人手确认或跳过→监督铸 normKey。
   */
  settleInferPaths: (input: {
    question: string
    paths: InferPathRaw[]
    bookTexts?: Record<string, string>
    queryKey?: string
    llmCallId?: string
  }) => { queryKey: string; inferKeys: string[]; pathKeys: string[] }
  /**
   * 复用闸通过：现 queryKey ──reuse──► normKey（可回 path）。
   */
  adoptReusePath: (input: {
    question: string
    /** 主坐标：归一化 key；缺则用 pathKey 找已有 norm */
    normKey?: string
    pathKey?: string
    rationale: string
    queryKey?: string
    llmCallId?: string
  }) => {
    queryKey: string
    reuseKey: string
    normKey: string
    pathKey: string
    oldQueryKey: string
    inferKeys: string[]
    prospectKeys: string[]
  } | null
  setLastStatus: (msg: string | null) => void
  /** 写信台提示（安全阀 / 台监）；不写注意力窗 */
  setDeskPrompt: (msg: string | null) => void
  clearDeskPrompt: () => void
  /** 意图↔台记录：保留；不进 steps/edges */
  pushIntentDeskLog: (input: {
    question: string
    action: string
    note: string
  }) => void
  /** 本问已进过主推理 → 换新意图会话 */
  bumpIntentSessionAfterMainInfer: (reason?: string) => void
  clearAll: () => void
  /** 水合长期记忆（key + 母系）；不碰 pending / deskPackages / steps */
  hydrateKeyLineageMemory: (input: {
    settledQueries: Record<string, string>
    queryParentOf: Record<string, string>
    queryKeyToBriefKeys: Record<string, string[]>
    prospects: ProspectRecord[]
    paths: PathRecord[]
    norms: NormRecord[]
    inferEdges: InferEdge[]
    neighbours: NeighbourRecord[]
    queryReuseLinks: QueryReuseLink[]
    deskDeliveries: DeskDeliveryLink[]
    keyIncrementStatuses: KeyIncrementStatusRow[]
    nextSettleSeq?: number
  }) => void
  /** 兼容旧调用 */
  toggleWm: (edgeId: string) => void
  setWm: (edgeId: string, on: boolean) => void
  clearWm: () => void
}

function sid(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function pairText(
  steps: AttentionStep[],
  edge: AttentionEdge,
  versionIndex: number,
): { bookText: string; briefText: string; briefKey: string; question: string } {
  const versions: AttentionStep[] = []
  for (const st of steps) {
    const hasBook = st.input.some(
      (r) => r.kind === 'book' && r.key === edge.fromKey,
    )
    if (hasBook) versions.push(st)
  }
  versions.sort((a, b) => b.createdAt - a.createdAt)
  const step = versions[versionIndex] ?? versions[0]
  const bookText =
    step?.input.find((r) => r.kind === 'book' && r.key === edge.fromKey)
      ?.text ?? ''
  const out =
    step?.output.find((r) => r.kind === 'brief' || r.kind === 'delta') ??
    step?.output.find((r) => r.key === edge.toKey)
  return {
    bookText,
    briefText: out?.text ?? '',
    briefKey: out?.key ?? edge.toKey,
    question: step?.question ?? '',
  }
}

export const useAttentionIo = create<AttentionIoState>((set, get) => ({
  steps: [],
  edges: [],
  inferEdges: [],
  selectedEdgeId: null,
  selectedInferKey: null,
  selectedInferHostStrand: null,
  selectedQueryKey: null,
  pinnedAttention: null,
  confirmDraft: null,
  deskPackages: [],
  lastStatus: null,
  deskPrompt: null,
  intentDeskLog: [],
  intentSessionEpoch: 0,
  wmEdgeIds: [],
  bookKeyToQuestions: {},
  questionToBookKeys: {},
  questionToBriefKeys: {},
  queryKeyToBriefKeys: {},
  settledQueries: {},
  queryParentOf: {},
  questionFingerprintToQueryKey: {},
  prospects: [],
  paths: [],
  norms: [],
  neighbours: [],
  queryReuseLinks: [],
  pendingPathMatch: null,
  pendingReuseProposal: null,
  pendingReuseWait: null,
  keyIncrementStatuses: [],
  pendingHunger: null,
  pendingIngestFeedBookKeys: [],
  nextSettleSeq: 1,
  deskDeliveries: [],
  llmCallLedger: [],
  nextLlmCallTurnSeq: 1,

  registerLlmCallBatch: ({ llmCallId, job, memberKeys, queryKey, keyKind }) => {
    const id = llmCallId.trim()
    const keys = [...new Set(memberKeys.map((k) => k.trim()).filter(Boolean))]
    if (!id || keys.length === 0) return
    const kind = keyKind ?? jobToOutKeyKind(job)
    set((s) => {
      const prev = s.llmCallLedger.find((e) => e.llmCallId === id)
      const mergedKeys = [
        ...new Set([...(prev?.memberKeys ?? []), ...keys]),
      ]
      const rest = s.llmCallLedger.filter((e) => e.llmCallId !== id)
      const entry: LlmCallLedgerEntry = {
        llmCallId: id,
        job: prev?.job ?? job,
        keyKind: prev?.keyKind ?? kind,
        memberKeys: mergedKeys,
        queryKey: (prev?.queryKey || queryKey).trim(),
        createdAt: prev?.createdAt ?? Date.now(),
        turnSeq: prev?.turnSeq ?? s.nextLlmCallTurnSeq,
      }
      return {
        llmCallLedger: [...rest, entry],
        nextLlmCallTurnSeq: prev
          ? s.nextLlmCallTurnSeq
          : s.nextLlmCallTurnSeq + 1,
      }
    })
  },

  findQueryKeyForQuestion: (question) =>
    latestQueryKeyForQuestion(get().settledQueries, question),

  getQueryParent: (queryKey) => {
    const p = get().queryParentOf[queryKey.trim()]
    return p?.trim() || null
  },

  listQueryFamily: (queryKey) =>
    listQueryFamilyKeys(get().queryParentOf, queryKey),

  listQuerySelfAndAncestors: (queryKey) =>
    lineageSelfAndAncestors(get().queryParentOf, queryKey),

  ensureQueryKey: (question) => {
    const q = normalizeQuestionText(question)
    if (!q) {
      const { queryKey } = mintQueryKey()
      set((s) => ({
        settledQueries: { ...s.settledQueries, [queryKey]: '' },
        nextSettleSeq: s.nextSettleSeq,
      }))
      return queryKey
    }
    // 同问同键：已落账原文命中 → 复用（不新铸）
    const existing = latestQueryKeyForQuestion(get().settledQueries, q)
    if (existing) return existing
    // 副索引：指纹命中且账上仍有该 qk → 复用
    const fp = contentFingerprint(q)
    const mapped = get().questionFingerprintToQueryKey[fp]
    if (mapped && get().settledQueries[mapped] != null) {
      const mappedText = normalizeQuestionText(get().settledQueries[mapped])
      if (!mappedText || mappedText === q) return mapped
    }
    const { queryKey } = mintQueryKey()
    set((s) => ({
      settledQueries: { ...s.settledQueries, [queryKey]: q },
      questionFingerprintToQueryKey: {
        ...s.questionFingerprintToQueryKey,
        [fp]: queryKey,
      },
      // 根问：不写 queryParentOf
    }))
    return queryKey
  },

  ensureDeepenedQueryKey: ({ parentQueryKey, question }) => {
    const parent = parentQueryKey.trim()
    const q = normalizeQuestionText(question)
    if (!parent || get().settledQueries[parent] == null) {
      return get().ensureQueryKey(q || question)
    }
    const parentText = normalizeQuestionText(get().settledQueries[parent] ?? '')
    if (!q || q === parentText) return parent

    const existing = latestQueryKeyForQuestion(get().settledQueries, q)
    if (existing) {
      set((s) => {
        if (s.queryParentOf[existing] === parent) return s
        return {
          queryParentOf: { ...s.queryParentOf, [existing]: parent },
        }
      })
      const inheritFrom = lineageSelfAndAncestors(get().queryParentOf, parent)
      const briefs = new Set<string>()
      const map = get().queryKeyToBriefKeys
      for (const k of [parent, ...inheritFrom]) {
        for (const b of map[k] ?? []) briefs.add(b)
      }
      if (briefs.size > 0) {
        set((s) => ({
          queryKeyToBriefKeys: {
            ...s.queryKeyToBriefKeys,
            [existing]: [
              ...new Set([
                ...(s.queryKeyToBriefKeys[existing] ?? []),
                ...briefs,
              ]),
            ],
          },
        }))
      }
      return existing
    }

    const { queryKey } = mintQueryKey()
    const fp = contentFingerprint(q)
    const inheritFrom = lineageSelfAndAncestors(get().queryParentOf, parent)
    const briefs = new Set<string>()
    const map = get().queryKeyToBriefKeys
    for (const k of [parent, ...inheritFrom]) {
      for (const b of map[k] ?? []) briefs.add(b)
    }
    set((s) => ({
      settledQueries: { ...s.settledQueries, [queryKey]: q },
      queryParentOf: { ...s.queryParentOf, [queryKey]: parent },
      questionFingerprintToQueryKey: {
        ...s.questionFingerprintToQueryKey,
        [fp]: queryKey,
      },
      queryKeyToBriefKeys:
        briefs.size > 0
          ? {
              ...s.queryKeyToBriefKeys,
              [queryKey]: [...briefs],
            }
          : s.queryKeyToBriefKeys,
      lastStatus: `深化问 · child=${queryKey} ← parent=${parent}`,
    }))
    return queryKey
  },

  recordDeskDelivery: ({ job, fromKeys, toKey, stepId }) => {
    const to = toKey.trim()
    if (!to) return
    const from = [
      ...new Set(fromKeys.map((k) => k.trim()).filter(Boolean)),
    ].filter((k) => k !== to)
    if (from.length === 0) return
    const settleSeq = get().nextSettleSeq
    const link: DeskDeliveryLink = {
      id: deliveryId(job, to, settleSeq),
      job,
      fromKeys: from,
      toKey: to,
      stepId,
      settleSeq,
      createdAt: Date.now(),
    }
    set((s) => ({
      deskDeliveries: [...s.deskDeliveries, link],
      nextSettleSeq: settleSeq + 1,
    }))
  },

  recordKeyIncrementStatuses: ({ job, queryKey: qkIn, rows }) => {
    if (!rows.length) return
    const now = Date.now()
    let seq = get().nextSettleSeq
    const queryKey = qkIn?.trim() || undefined
    const minted: KeyIncrementStatusRow[] = []
    for (const row of rows) {
      const key = row.key.trim()
      if (!key) continue
      minted.push({
        key,
        status: row.status,
        job,
        queryKey,
        incrementKey: row.incrementKey?.trim() || undefined,
        note: row.note?.trim() || undefined,
        settleSeq: seq++,
        createdAt: now,
      })
    }
    if (minted.length === 0) return
    const sameSlot = (
      a: Pick<KeyIncrementStatusRow, 'job' | 'key' | 'queryKey'>,
      b: Pick<KeyIncrementStatusRow, 'job' | 'key' | 'queryKey'>,
    ) =>
      a.job === b.job &&
      a.key === b.key &&
      (a.queryKey ?? '') === (b.queryKey ?? '')
    set((s) => {
      const kept = s.keyIncrementStatuses.filter(
        (old) => !minted.some((n) => sameSlot(n, old)),
      )
      const ready = minted.filter((r) => r.status === 'sufficient').length
      const weak = minted.filter((r) => r.status === 'insufficient').length
      const unread = minted.filter((r) => r.status === 'unread').length
      return {
        keyIncrementStatuses: [...kept, ...minted],
        nextSettleSeq: seq,
        lastStatus:
          `key三态 · ${job}` +
          (queryKey ? ` · qk=${queryKey}` : '') +
          ` · 充分${ready}/不充分${weak}/未读${unread}`,
      }
    })
  },

  listKeyStatuses: (opts) => {
    let rows = get().keyIncrementStatuses
    if (opts?.job) rows = rows.filter((r) => r.job === opts.job)
    if (opts?.status) rows = rows.filter((r) => r.status === opts.status)
    const qk = opts?.queryKey?.trim()
    if (qk) {
      const family =
        opts?.includeFamily === false
          ? new Set([qk])
          : new Set(get().listQuerySelfAndAncestors(qk))
      // 有 scope 时只认挂了问线的行；无 qk 的旧行不串入本问
      rows = rows.filter((r) => r.queryKey && family.has(r.queryKey))
    }
    return rows
  },

  listKeysReadyToDeliver: (job, scope) => {
    const rows = get().listKeyStatuses({
      job,
      status: 'sufficient',
      queryKey: scope?.queryKey,
      includeFamily: scope?.includeFamily,
    })
    return [...new Set(rows.map((r) => r.key))]
  },

  listKeysNeedingMore: (job, scope) => {
    const rows = get().listKeyStatuses({
      job,
      status: 'insufficient',
      queryKey: scope?.queryKey,
      includeFamily: scope?.includeFamily,
    })
    return [...new Set(rows.map((r) => r.key))]
  },

  listKeysUnread: (job, scope) => {
    const rows = get().listKeyStatuses({
      job,
      status: 'unread',
      queryKey: scope?.queryKey,
      includeFamily: scope?.includeFamily,
    })
    return [...new Set(rows.map((r) => r.key))]
  },

  pushPeekStep: ({ question, items, mode = 'cold', llmCallId: lcIn }) => {
    const id = sid()
    const llmCallId = lcIn?.trim() || undefined
    const deltaKey =
      items.map((it) => it.briefKey || `brief:${it.key}`).join('|') ||
      `peek_${id}`
    const input: AttentionRow[] = [
      { key: 'Q_now', kind: 'query', text: question },
      ...items.map((it) => ({
        key: it.key,
        kind: 'book' as const,
        text: (it.bookText || '').trim() || `bookKey ${it.key}`,
      })),
    ]
    const output: AttentionRow[] = items.map((it) => ({
      key: it.briefKey || `brief:${it.key}`,
      kind: 'brief' as KeyKind,
      text: it.brief,
    }))
    const edges: AttentionEdge[] = items.map((it) => ({
      id: `${id}_${it.key}`,
      fromKey: it.key,
      toKey: it.briefKey || `brief:${it.key}`,
      stepId: id,
      bondId: it.bondId,
    }))
    const step: AttentionStep = {
      id,
      deltaKey,
      label:
        mode === 'cold'
          ? `peek · 冷启 · ${items.length} 门贴`
          : `peek · 扩搜 · ${items.length} 门贴`,
      premiseKeys: items.map((it) => it.key),
      input,
      output,
      question,
      createdAt: Date.now(),
    }
    set((s) => {
      const bookKeyToQuestions = { ...s.bookKeyToQuestions }
      const questionToBookKeys = { ...s.questionToBookKeys }
      const questionToBriefKeys = { ...s.questionToBriefKeys }
      const qBooks = new Set(questionToBookKeys[question] ?? [])
      const qBriefs = new Set(questionToBriefKeys[question] ?? [])
      for (const it of items) {
        qBooks.add(it.key)
        const bq = new Set(bookKeyToQuestions[it.key] ?? [])
        bq.add(question)
        bookKeyToQuestions[it.key] = [...bq]
        if (it.briefKey) qBriefs.add(it.briefKey)
      }
      questionToBookKeys[question] = [...qBooks]
      questionToBriefKeys[question] = [...qBriefs]
      return {
        steps: [...s.steps, step],
        edges: [...s.edges, ...edges],
        selectedEdgeId: null,
        bookKeyToQuestions,
        questionToBookKeys,
        questionToBriefKeys,
      }
    })
    for (const it of items) {
      const briefKey = it.briefKey || `brief:${it.key}`
      get().recordDeskDelivery({
        job: 'peek',
        fromKeys: [it.key],
        toKey: briefKey,
        stepId: id,
      })
    }
    if (llmCallId) {
      const briefKeys = items
        .map((it) => it.briefKey || `brief:${it.key}`)
        .filter(Boolean)
      const qk =
        get().findQueryKeyForQuestion(question) ||
        get().ensureQueryKey(question)
      get().registerLlmCallBatch({
        llmCallId,
        job: 'peek',
        memberKeys: briefKeys,
        queryKey: qk,
        keyKind: 'brief',
      })
    }
    return id
  },

  pushFlashStep: ({ question, items }) =>
    get().pushPeekStep({ question, items, mode: 'cold' }),

  attachBondIds: (stepId, map) => {
    const byBook = new Map(map.map((m) => [m.bookKey, m.bondId]))
    set((s) => ({
      edges: s.edges.map((e) => {
        if (e.stepId !== stepId) return e
        const bondId = byBook.get(e.fromKey)
        return bondId ? { ...e, bondId } : e
      }),
    }))
  },

  openEdge: (edgeId) =>
    set({
      selectedEdgeId: edgeId,
      selectedInferKey: null,
      selectedInferHostStrand: null,
      selectedQueryKey: null,
    }),
  openInferEdge: (inferKey, hostStrand) =>
    set({
      selectedInferKey: inferKey,
      selectedInferHostStrand:
        typeof hostStrand === 'number' ? hostStrand : null,
      selectedEdgeId: null,
      selectedQueryKey: null,
    }),
  openQueryKey: (queryKey) =>
    set({
      selectedQueryKey: queryKey,
      selectedEdgeId: null,
      selectedInferKey: null,
      selectedInferHostStrand: null,
    }),
  closeAttention: () =>
    set({
      selectedEdgeId: null,
      selectedInferKey: null,
      selectedInferHostStrand: null,
      selectedQueryKey: null,
      confirmDraft: null,
    }),

  beginAttentionSwitch: (edgeId) => {
    const s = get()
    const edge = s.edges.find((e) => e.id === edgeId)
    if (!edge) return
    const step = s.steps.find((st) => st.id === edge.stepId)
    const q = step?.question ?? ''
    set({
      selectedEdgeId: edgeId,
      confirmDraft: {
        edgeId,
        qDraft: q,
        qGhost: null,
        job: 'peek',
        versionIndex: 0,
      },
    })
  },


  pinAttentionEdge: (edgeId) => {
    const edge = get().edges.find((e) => e.id === edgeId)
    if (!edge) return
    const label = edge.toKey || edge.fromKey || edgeId
    set({
      pinnedAttention: { kind: 'edge', edgeId, label },
      selectedEdgeId: edgeId,
      selectedInferKey: null,
      selectedInferHostStrand: null,
      selectedQueryKey: null,
    })
  },
  pinAttentionInfer: (inferKey) => {
    if (!get().inferEdges.some((e) => e.inferKey === inferKey)) return
    set({
      pinnedAttention: { kind: 'infer', inferKey },
      selectedInferKey: inferKey,
      selectedEdgeId: null,
      selectedQueryKey: null,
    })
  },
  pinAttentionQuery: (queryKey) => {
    const qk = queryKey.trim()
    if (!qk) return
    set({
      pinnedAttention: { kind: 'query', queryKey: qk },
      selectedQueryKey: qk,
      selectedEdgeId: null,
      selectedInferKey: null,
      selectedInferHostStrand: null,
    })
  },
  unpinAttention: () => set({ pinnedAttention: null }),
  focusPinnedAttention: () => {
    const pin = get().pinnedAttention
    if (!pin) return
    if (pin.kind === 'edge') get().openEdge(pin.edgeId)
    else if (pin.kind === 'infer') get().openInferEdge(pin.inferKey)
    else get().openQueryKey(pin.queryKey)
  },
  cancelConfirm: () => set({ confirmDraft: null }),

  setConfirmQDraft: (text) => {
    const ghost = get().suggestQGhost(text)
    set((s) =>
      s.confirmDraft
        ? {
            confirmDraft: {
              ...s.confirmDraft,
              qDraft: text,
              qGhost:
                ghost &&
                ghost !== text &&
                ghost.toLowerCase().startsWith(text.toLowerCase())
                  ? ghost
                  : null,
            },
          }
        : {},
    )
  },

  acceptQGhost: () => {
    set((s) => {
      if (!s.confirmDraft?.qGhost) return {}
      return {
        confirmDraft: {
          ...s.confirmDraft,
          qDraft: s.confirmDraft.qGhost,
          qGhost: null,
        },
      }
    })
  },

  setConfirmJob: (job) => {
    set((s) =>
      s.confirmDraft
        ? { confirmDraft: { ...s.confirmDraft, job } }
        : {},
    )
  },

  setConfirmVersion: (index) => {
    set((s) =>
      s.confirmDraft
        ? {
            confirmDraft: {
              ...s.confirmDraft,
              versionIndex: Math.max(0, index),
            },
          }
        : {},
    )
  },

  commitConfirmToDesk: () => {
    const s = get()
    const draft = s.confirmDraft
    if (!draft) return false
    const edge = s.edges.find((e) => e.id === draft.edgeId)
    if (!edge) return false
    const texts = pairText(s.steps, edge, draft.versionIndex)
    const q = draft.qDraft.trim() || texts.question
    const pkg: LetterDeskPackage = {
      id: sid(),
      edgeId: edge.id,
      bookKey: edge.fromKey,
      briefKey: texts.briefKey,
      question: q,
      job: draft.job,
      versionIndex: draft.versionIndex,
      createdAt: Date.now(),
    }
    set((st) => ({
      deskPackages: [
        ...st.deskPackages.filter((p) => p.edgeId !== edge.id),
        pkg,
      ],
      wmEdgeIds: st.wmEdgeIds.includes(edge.id)
        ? st.wmEdgeIds
        : [...st.wmEdgeIds, edge.id],
      confirmDraft: null,
      lastStatus:
        draft.job === 'peek'
          ? '已确认 · 工种=再 peek（当前 I/O 待换贴）→ 写信台'
          : `已确认 · ${draft.job} → 写信台`,
    }))
    return true
  },

  removeDeskPackage: (id) => {
    set((s) => {
      const gone = s.deskPackages.find((p) => p.id === id)
      const deskPackages = s.deskPackages.filter((p) => p.id !== id)
      const wmEdgeIds = gone
        ? s.wmEdgeIds.filter((e) => e !== gone.edgeId)
        : s.wmEdgeIds
      return { deskPackages, wmEdgeIds }
    })
  },

  clearDesk: () => set({ deskPackages: [], wmEdgeIds: [] }),

  getLetterDeskPickup: () => {
    const packages = get().deskPackages
    return {
      packages,
      edgeIds: packages.map((p) => p.edgeId),
      bookKeys: packages.map((p) => p.bookKey),
      briefKeys: packages.map((p) => p.briefKey),
      pairs: packages.map((p) => ({
        edgeId: p.edgeId,
        bookKey: p.bookKey,
        briefKey: p.briefKey,
        bookText: p.bookText ?? '',
        briefText: p.briefText ?? '',
        question: p.question,
        job: p.job,
      })),
    }
  },

  listBriefKeysForQuestion: (question) => {
    const q = question.trim()
    return get().questionToBriefKeys[q] ?? []
  },

  listBookKeysForQuestion: (question) => {
    const q = question.trim()
    return get().questionToBookKeys[q] ?? []
  },

  listQuestionsForBookKeys: (bookKeys) => {
    const s = get()
    const seen = new Set<string>()
    const out: Array<{ queryKey: string; qText: string }> = []
    for (const bk of bookKeys) {
      for (const q of s.bookKeyToQuestions[bk] ?? []) {
        if (seen.has(q)) continue
        seen.add(q)
        const qk = latestQueryKeyForQuestion(s.settledQueries, q)
        if (!qk) continue
        out.push({ queryKey: qk, qText: q })
      }
    }
    return out
  },

  listInferEdgesForBookKeys: (bookKeys) => {
    const setKeys = new Set(bookKeys)
    return get().inferEdges.filter(
      (e) =>
        setKeys.has(e.fromBookKey) ||
        setKeys.has(e.toBookKey) ||
        e.bookKeys.some((k) => setKeys.has(k)),
    )
  },

  listPathsForQueryKey: (queryKey) =>
    get().paths.filter((p) => p.queryKey === queryKey),

  listNormsForPathKeys: (pathKeys) => {
    const set = new Set(pathKeys.map((k) => k.trim()).filter(Boolean))
    return get().norms.filter((n) => set.has(n.pathKey))
  },

  listNormsForQueryKey: (queryKey) =>
    get().norms.filter((n) => n.queryKey === queryKey),

  listProspectsForBriefKeys: (briefKeys) => {
    const set = new Set(briefKeys)
    return get().prospects.filter((p) => set.has(p.briefKey))
  },

  listPathsForBookKeys: (bookKeys) => {
    const inferKeys = new Set(
      get()
        .listInferEdgesForBookKeys(bookKeys)
        .map((e) => e.inferKey),
    )
    return get().paths.filter((p) => {
      if (inferKeys.has(p.inferKey)) return true
      return (p.inferKeys ?? []).some((ik) => inferKeys.has(ik))
    })
  },

  settleProspects: ({
    question,
    queryKey: qkIn,
    keeps,
    allowedBriefKeys,
    llmCallId: lcIn,
  }) => {
    const q = question.trim()
    const queryKey = qkIn?.trim() || get().ensureQueryKey(q)
    const llmCallId = lcIn?.trim() || undefined
    const now = Date.now()
    let seq = get().nextSettleSeq
    const minted: ProspectRecord[] = []
    const rejected: Array<{ briefKey: string; reason: string }> = []
    const allow =
      allowedBriefKeys && allowedBriefKeys.length > 0
        ? new Set(allowedBriefKeys.map((k) => k.trim()).filter(Boolean))
        : null
    for (const row of keeps) {
      const briefKey = row.briefKey.trim()
      const text = row.prospect.trim()
      if (!briefKey || !text) {
        rejected.push({
          briefKey: briefKey || '(empty)',
          reason: '缺 briefKey 或 prospect 正文',
        })
        continue
      }
      // 精准落账：只认窗内原样回传的 briefKey，不靠正文模糊搜
      if (allow && !allow.has(briefKey)) {
        rejected.push({
          briefKey,
          reason: 'briefKey 不在本窗允许集（展开后须为窗内全长 bookKey；模型侧只许回传 ⟦n⟧）',
        })
        continue
      }
      // 铸键 ≠ 递送：仅充分才铸；未读/不充分拒铸（状态由 keyStatuses 另记）
      if (!statusAllowsMint(row.status)) {
        rejected.push({
          briefKey,
          reason: `三态=${row.status || '∅'} · 非充分不铸 prospectKey`,
        })
        continue
      }
      if (!relevanceAllowsInfer(row.relevance)) {
        rejected.push({
          briefKey,
          reason: `relevance=${row.relevance} · <${MIN_PROSPECT_RELEVANCE} 不铸（旁例/仅点名）`,
        })
        continue
      }
      const settleActionId = newSettleActionId('decide')
      const prospectKey = mintInstanceKey('prospect', settleActionId)
      minted.push({
        prospectKey,
        settleActionId,
        llmCallId,
        briefKey,
        text,
        contentFingerprint: contentFingerprint(text),
        queryKey,
        relevance:
          typeof row.relevance === 'number' && Number.isFinite(row.relevance)
            ? Math.max(1, Math.min(5, Math.round(row.relevance)))
            : undefined,
        settleSeq: seq++,
        createdAt: now,
      })
    }
    set((s) => ({
      prospects: [...s.prospects, ...minted],
      settledQueries: {
        ...s.settledQueries,
        [queryKey]: q || s.settledQueries[queryKey] || '',
      },
      nextSettleSeq: seq,
      lastStatus:
        `prospect 落账 · ${minted.length} 条` +
        (rejected.length ? ` · 拒${rejected.length}` : '') +
        ` · qk=${queryKey}`,
    }))
    for (const p of minted) {
      get().recordDeskDelivery({
        job: 'decide',
        fromKeys: [p.briefKey],
        toKey: p.prospectKey,
      })
    }
    if (llmCallId && minted.length > 0) {
      get().registerLlmCallBatch({
        llmCallId,
        job: 'decide',
        memberKeys: minted.map((p) => p.prospectKey),
        queryKey,
      })
    }
    return {
      queryKey,
      prospectKeys: minted.map((p) => p.prospectKey),
      rejected,
    }
  },

  settleNeighbours: ({
    nowQuestion,
    nowQueryKey: qkIn,
    neighbours,
    llmCallId: lcIn,
  }) => {
    const q = nowQuestion.trim()
    const nowQueryKey = qkIn?.trim() || get().ensureQueryKey(q)
    const llmCallId = lcIn?.trim() || undefined
    const now = Date.now()
    let seq = get().nextSettleSeq
    const minted: NeighbourRecord[] = []
    neighbours.forEach((row, rank) => {
      let hq = row.historicQueryKey.trim()
      if (!hq) return
      // 阶段 A 只许回传 ⟦n⟧；落账前展开为全长 queryKey
      if (get().settledQueries[hq] == null) {
        const pool = Object.keys(get().settledQueries).filter(
          (k) => k !== nowQueryKey,
        )
        const table = buildWindowAliasTable(pool)
        const full = resolveWindowDoorplate(hq, table)
        if (full) hq = full
        else {
          const n = Number(hq)
          if (Number.isInteger(n) && n >= 1 && n <= pool.length) {
            hq = pool[n - 1]!
          } else if (!hq.startsWith('qk_')) {
            return
          }
        }
      }
      if (!hq || get().settledQueries[hq] == null) return
      const settleActionId = newSettleActionId('neighbour')
      const neighbourKey = mintInstanceKey('neighbour', settleActionId)
      minted.push({
        neighbourKey,
        settleActionId,
        llmCallId,
        historicQueryKey: hq,
        nowQueryKey,
        degree: row.degree.trim() || `rank=${rank + 1}`,
        rank: rank + 1,
        settleSeq: seq++,
        createdAt: now,
      })
    })
    set((s) => ({
      neighbours: [
        ...s.neighbours.filter((n) => n.nowQueryKey !== nowQueryKey),
        ...minted,
      ],
      settledQueries: {
        ...s.settledQueries,
        [nowQueryKey]: q || s.settledQueries[nowQueryKey] || '',
      },
      nextSettleSeq: seq,
      lastStatus: `neighbour 落账 · ${minted.length} 条 · now=${nowQueryKey}`,
    }))
    for (const n of minted) {
      get().recordDeskDelivery({
        job: 'query',
        fromKeys: [n.historicQueryKey],
        toKey: n.neighbourKey,
      })
    }
    if (llmCallId && minted.length > 0) {
      get().registerLlmCallBatch({
        llmCallId,
        job: 'query',
        memberKeys: minted.map((n) => n.neighbourKey),
        queryKey: nowQueryKey,
        keyKind: 'neighbour',
      })
    }
    return { nowQueryKey, neighbourKeys: minted.map((n) => n.neighbourKey) }
  },

  settlePaths: ({ queryKey, matches, llmCallId: lcIn }) => {
    const now = Date.now()
    const llmCallId = lcIn?.trim() || undefined
    let seq = get().nextSettleSeq
    const minted: PathRecord[] = []
    const existing = get().paths
    for (const m of matches) {
      const inferKey = m.inferKey.trim()
      const prospectKey = (m.prospectKey ?? '').trim()
      const solutionKey = (m.solutionKey ?? '').trim()
      // 解法级：至少要有 solutionKey 或 inferKey；prospect 可空
      if (!inferKey && !solutionKey) continue
      const mode = m.matchMode ?? 'candidate'
      const dup = existing.find((p) => {
        if (p.queryKey !== queryKey) return false
        if (solutionKey && p.solutionKey === solutionKey) return true
        if (
          !solutionKey &&
          inferKey &&
          prospectKey &&
          p.inferKey === inferKey &&
          p.prospectKey === prospectKey
        ) {
          return true
        }
        return false
      })
      if (dup) {
        // 已有候选：仅升级 matchMode（不重复铸）
        if (mode !== 'candidate' && dup.matchMode === 'candidate') {
          set((s) => ({
            paths: s.paths.map((p) =>
              p.pathKey === dup.pathKey
                ? { ...p, matchMode: mode, llmCallId: llmCallId ?? p.llmCallId }
                : p,
            ),
          }))
        }
        minted.push(get().paths.find((p) => p.pathKey === dup.pathKey)!)
        continue
      }
      const settleActionId = newSettleActionId('path')
      const pathKey = mintInstanceKey('path', settleActionId)
      const inferKeys = m.inferKeys?.filter(Boolean) ?? (inferKey ? [inferKey] : [])
      const prospectKeys =
        m.prospectKeys?.filter(Boolean) ??
        (prospectKey ? [prospectKey] : [])
      minted.push({
        pathKey,
        settleActionId,
        llmCallId,
        inferKey: inferKey || inferKeys[0] || '',
        prospectKey: prospectKey || prospectKeys[0] || '',
        queryKey,
        matchMode: mode,
        validityStatus: mode === 'candidate' ? 'unread' : undefined,
        solutionKey: solutionKey || undefined,
        conclusion: m.conclusion?.trim() || undefined,
        inferKeys,
        prospectKeys,
        bookKeysSequence: m.bookKeysSequence,
        steps: m.steps,
        settleSeq: seq++,
        createdAt: now,
      })
    }
    const fresh = minted.filter(
      (p) => !existing.some((e) => e.pathKey === p.pathKey),
    )
    if (fresh.length > 0) {
      set((s) => ({
        paths: [...s.paths, ...fresh],
        nextSettleSeq: seq,
        lastStatus: `path 落账 · ${fresh.length} 条 · qk=${queryKey}`,
      }))
      for (const p of fresh) {
        const fromKeys = [
          ...(p.inferKeys?.length ? p.inferKeys : p.inferKey ? [p.inferKey] : []),
          ...(p.prospectKeys?.length
            ? p.prospectKeys
            : p.prospectKey
              ? [p.prospectKey]
              : []),
        ]
        get().recordDeskDelivery({
          job: 'infer',
          fromKeys: fromKeys.length > 0 ? fromKeys : [p.pathKey],
          toKey: p.pathKey,
        })
      }
      if (llmCallId) {
        get().registerLlmCallBatch({
          llmCallId,
          job: 'path',
          memberKeys: fresh.map((p) => p.pathKey),
          queryKey,
        })
      }
    }
    return { pathKeys: minted.map((p) => p.pathKey) }
  },

  settleNorms: ({ queryKey, rows, llmCallId: lcIn }) => {
    const now = Date.now()
    const llmCallId = lcIn?.trim() || undefined
    let seq = get().nextSettleSeq
    const minted: NormRecord[] = []
    const existing = get().norms
    for (const row of rows) {
      const pathKey = row.pathKey.trim()
      const text = row.text.trim()
      if (!pathKey || !text) continue
      const path = get().paths.find((p) => p.pathKey === pathKey)
      if (!path) continue
      const dup = existing.find((n) => n.pathKey === pathKey)
      if (dup) {
        set((s) => ({
          norms: s.norms.map((n) =>
            n.normKey === dup.normKey
              ? {
                  ...n,
                  text,
                  contentFingerprint: contentFingerprint(text),
                  llmCallId: llmCallId ?? n.llmCallId,
                }
              : n,
          ),
        }))
        minted.push(get().norms.find((n) => n.normKey === dup.normKey)!)
        continue
      }
      const settleActionId = newSettleActionId('supervise')
      const normKey = mintInstanceKey('norm', settleActionId)
      minted.push({
        normKey,
        pathKey,
        settleActionId,
        llmCallId,
        text,
        contentFingerprint: contentFingerprint(text),
        queryKey: path.queryKey || queryKey,
        settleSeq: seq++,
        createdAt: now,
      })
    }
    const fresh = minted.filter(
      (n) => !existing.some((e) => e.normKey === n.normKey),
    )
    if (fresh.length > 0) {
      set((s) => ({
        norms: [...s.norms, ...fresh],
        nextSettleSeq: seq,
        lastStatus: `norm 落账 · ${fresh.length} 条 · qk=${queryKey}`,
      }))
      for (const n of fresh) {
        get().recordDeskDelivery({
          job: 'supervise',
          fromKeys: [n.pathKey],
          toKey: n.normKey,
        })
      }
      if (llmCallId) {
        get().registerLlmCallBatch({
          llmCallId,
          job: 'supervise',
          memberKeys: fresh.map((n) => n.normKey),
          queryKey,
          keyKind: 'norm',
        })
      }
    }
    return { normKeys: minted.map((n) => n.normKey) }
  },

  confirmSupervisePaths: ({ queryKey, judgments, llmCallId: lcIn }) => {
    const llmCallId = lcIn?.trim() || undefined
    const allow = new Set(
      get()
        .paths.filter((p) => p.queryKey === queryKey)
        .map((p) => p.pathKey),
    )
    const sufficient: Array<{ pathKey: string; text: string }> = []
    const pathUpdates: Array<{
      pathKey: string
      status: 'sufficient' | 'insufficient' | 'unread'
    }> = []
    for (const j of judgments) {
      const pathKey = j.pathKey.trim()
      if (!pathKey || !allow.has(pathKey)) continue
      const status = j.status ?? 'unread'
      pathUpdates.push({ pathKey, status })
      const text = (j.normalizedText ?? '').trim()
      if (status === 'sufficient' && text) {
        sufficient.push({ pathKey, text })
      }
    }
    if (pathUpdates.length > 0) {
      set((s) => ({
        paths: s.paths.map((p) => {
          const u = pathUpdates.find((x) => x.pathKey === p.pathKey)
          if (!u) return p
          return {
            ...p,
            validityStatus: u.status,
            matchMode:
              u.status === 'sufficient' ? 'supervise_llm' : p.matchMode,
          }
        }),
      }))
    }
    const norms =
      sufficient.length > 0
        ? get().settleNorms({ queryKey, llmCallId, rows: sufficient })
        : { normKeys: [] as string[] }
    return {
      pathKeys: pathUpdates.map((u) => u.pathKey),
      normKeys: norms.normKeys,
      note:
        `监督落账 · 评×${pathUpdates.length} · norm×${norms.normKeys.length}`,
    }
  },

  beginPendingPathMatch: ({ queryKey, question, inferKeys }) => {
    // 深化子问可继承父链 prospect（跳过 decide 时本 qk 尚无 prospect）
    const family = new Set(get().listQuerySelfAndAncestors(queryKey))
    const wantIk = new Set(
      inferKeys.map((k) => k.trim()).filter(Boolean),
    )
    const inferEdges = get().inferEdges.filter(
      (e) =>
        e.queryKey === queryKey &&
        (wantIk.size === 0 || wantIk.has(e.inferKey)),
    )
    const prospectRows = get().prospects.filter((p) => family.has(p.queryKey))
    const docId = useIndexGate.getState().bookIndex?.docId?.trim() ?? ''
    const solutions = docId
      ? bindSolutionsByBookLineage({
          docId,
          inferEdges,
          prospects: prospectRows,
          deskDeliveries: get().deskDeliveries,
        })
      : []

    // 无 docId：仍按 solution 分组铸 path（prospect 载荷空）
    const fallbackSolutions =
      solutions.length > 0
        ? solutions
        : (() => {
            const bySk = new Map<string, typeof inferEdges>()
            for (const e of inferEdges) {
              const sk =
                (e.solutionKey ?? '').trim() ||
                `legacy_pi${e.pathIndex}_ik${e.inferKey}`
              const arr = bySk.get(sk) ?? []
              arr.push(e)
              bySk.set(sk, arr)
            }
            return [...bySk.entries()].map(([sk, edges]) => {
              const steps = edges.map((e) => ({
                inferKey: e.inferKey,
                role: (e.role ?? '').trim(),
                bookKeys: e.bookKeys.map((k) => k.trim()).filter(Boolean),
                bookSlots:
                  e.bookSlots && e.bookSlots.length === e.bookKeys.length
                    ? [...e.bookSlots]
                    : undefined,
                inferText: (e.infer || e.rationale || '').trim(),
              }))
              const bookKeysSequence: string[] = []
              const seen = new Set<string>()
              for (const st of steps) {
                for (const bk of st.bookKeys) {
                  if (seen.has(bk)) continue
                  seen.add(bk)
                  bookKeysSequence.push(bk)
                }
              }
              return {
                solutionKey: sk,
                conclusion:
                  (edges[0]?.conclusion ?? '').trim() ||
                  steps.map((s) => s.inferText).filter(Boolean).join('；'),
                pathIndex: edges[0]?.pathIndex ?? 0,
                steps,
                bookKeysSequence,
                prospects: [] as Array<{
                  prospectKey: string
                  briefKey: string
                  bookKey: string
                  text: string
                }>,
              }
            })
          })()

    const settled = get().settlePaths({
      queryKey,
      llmCallId: newLlmCallId('path'),
      matches: fallbackSolutions.map((s) => ({
        inferKey: s.steps[0]?.inferKey ?? '',
        prospectKey: s.prospects[0]?.prospectKey ?? '',
        matchMode: 'candidate' as const,
        solutionKey: s.solutionKey,
        conclusion: s.conclusion,
        inferKeys: s.steps.map((st) => st.inferKey),
        prospectKeys: s.prospects.map((p) => p.prospectKey),
        bookKeysSequence: s.bookKeysSequence,
        steps: s.steps.map((st) => ({
          inferKey: st.inferKey,
          role: st.role,
          bookKeys: st.bookKeys,
          bookSlots: st.bookSlots,
          infer: st.inferText,
        })),
      })),
    })

    const bySolution = new Map(
      get()
        .paths.filter((p) => p.queryKey === queryKey && p.solutionKey)
        .map((p) => [p.solutionKey!, p] as const),
    )
    const boundPairs: PendingPathBoundPair[] = []
    for (const s of fallbackSolutions) {
      const path =
        bySolution.get(s.solutionKey) ||
        get().paths.find(
          (p) =>
            p.queryKey === queryKey &&
            p.solutionKey === s.solutionKey,
        )
      if (!path?.pathKey) continue
      boundPairs.push({
        pathKey: path.pathKey,
        inferKey: s.steps[0]?.inferKey ?? path.inferKey,
        prospectKey: s.prospects[0]?.prospectKey ?? path.prospectKey ?? '',
        briefKey: s.prospects[0]?.briefKey ?? '',
        sharedBookKeys: s.bookKeysSequence,
        solutionKey: s.solutionKey,
        conclusion: s.conclusion,
        inferKeys: s.steps.map((st) => st.inferKey),
        prospectKeys: s.prospects.map((p) => p.prospectKey),
        bookKeysSequence: s.bookKeysSequence,
        steps: s.steps,
        prospects: s.prospects,
      })
    }

    const pathKeys = [
      ...new Set([
        ...settled.pathKeys,
        ...boundPairs.map((p) => p.pathKey),
      ]),
    ]
    const pending: PendingPathMatch = {
      queryKey,
      question: question.trim(),
      pathKeys,
      inferKeys: [
        ...new Set(boundPairs.flatMap((p) => p.inferKeys ?? [p.inferKey])),
      ],
      prospectKeys: [
        ...new Set(
          boundPairs.flatMap((p) => p.prospectKeys ?? (p.prospectKey ? [p.prospectKey] : [])),
        ),
      ],
      boundPairs,
      createdAt: Date.now(),
    }
    set({
      pendingPathMatch: pending,
      lastStatus:
        `等待 path · qk=${queryKey} · 解法 pathKey×${pathKeys.length}` +
        (family.size > 1 ? ` · 含父链 prospect` : '') +
        (docId ? '' : ' · 无 docId（prospect 载荷空）') +
        ' · 结算面确认 path→登记 norm / 撤销→清挂起',
    })
    return pending
  },

  settleUserPathMatches: ({
    queryKey: qkIn,
    pathKeys: pkIn,
    matches,
    normalizedByPathKey,
  }) => {
    const pending = get().pendingPathMatch
    const queryKey = qkIn?.trim() || pending?.queryKey || ''
    if (!queryKey) {
      return {
        pathKeys: [],
        normKeys: [],
        ok: false,
        note: '无 queryKey / 无挂起匹配',
      }
    }

    const allowPath = new Set(
      (pending?.pathKeys ?? []).filter(Boolean).length
        ? pending!.pathKeys
        : get()
            .paths.filter(
              (p) => p.queryKey === queryKey && p.matchMode === 'candidate',
            )
            .map((p) => p.pathKey),
    )
    const allowPair = new Set(
      (pending?.boundPairs ?? []).map(
        (p) => `${p.inferKey}::${p.prospectKey}`,
      ),
    )

    let chosen: string[] = []
    if (pkIn && pkIn.length > 0) {
      chosen = pkIn.map((k) => k.trim()).filter((k) => allowPath.has(k))
    } else if (matches && matches.length > 0) {
      for (const m of matches) {
        const id = `${m.inferKey.trim()}::${m.prospectKey.trim()}`
        if (!allowPair.has(id) && allowPair.size > 0) continue
        const hit =
          pending?.boundPairs.find(
            (p) =>
              p.inferKey === m.inferKey.trim() &&
              p.prospectKey === m.prospectKey.trim(),
          ) ||
          get().paths.find(
            (p) =>
              p.queryKey === queryKey &&
              p.inferKey === m.inferKey.trim() &&
              p.prospectKey === m.prospectKey.trim(),
          )
        if (hit?.pathKey) chosen.push(hit.pathKey)
      }
    }
    chosen = [...new Set(chosen)]
    if (chosen.length === 0) {
      return {
        pathKeys: [],
        normKeys: [],
        ok: false,
        note: '确认集为空或不在候选 pathKey 集',
      }
    }

    set((s) => ({
      paths: s.paths.map((p) =>
        chosen.includes(p.pathKey)
          ? {
              ...p,
              matchMode: 'user' as const,
              validityStatus: 'sufficient' as const,
            }
          : p,
      ),
      pendingPathMatch: null,
    }))

    // tick → 登记 normKey：用户自带整理文优先，否则台拼 conclusion+分步+prospect
    const rows: Array<{ pathKey: string; text: string }> = []
    for (const pathKey of chosen) {
      const custom = normalizedByPathKey?.[pathKey]?.trim()
      if (custom) {
        rows.push({ pathKey, text: custom })
        continue
      }
      const path = get().paths.find((p) => p.pathKey === pathKey)
      if (!path) continue
      const pendingPair = pending?.boundPairs.find((b) => b.pathKey === pathKey)
      const conclusion =
        (path.conclusion || pendingPair?.conclusion || '').trim()
      const stepTexts =
        path.steps?.map((s) => s.infer) ??
        pendingPair?.steps?.map((s) => s.inferText) ??
        []
      const prospectTexts =
        (path.prospectKeys ?? pendingPair?.prospectKeys ?? [])
          .map(
            (pk) =>
              get().prospects.find((p) => p.prospectKey === pk)?.text?.trim() ||
              '',
          )
          .filter(Boolean)
      const edge = get().inferEdges.find((e) => e.inferKey === path.inferKey)
      const pr = get().prospects.find((p) => p.prospectKey === path.prospectKey)
      const text = composeNormTextFromPath({
        inferText: (edge?.infer || edge?.rationale || '').trim(),
        prospectText: (pr?.text || '').trim(),
        conclusion,
        stepTexts,
        prospectTexts,
      })
      if (text) rows.push({ pathKey, text })
    }
    const norms =
      rows.length > 0
        ? get().settleNorms({
            queryKey,
            llmCallId: newLlmCallId('supervise'),
            rows,
          })
        : { normKeys: [] as string[] }

    return {
      pathKeys: chosen,
      normKeys: norms.normKeys,
      ok: true,
      note:
        `用户 tick path×${chosen.length} · 登记 norm×${norms.normKeys.length}` +
        (normalizedByPathKey && Object.keys(normalizedByPathKey).length
          ? ' · 含自整理文'
          : ' · 台默认conclusion+steps'),
    }
  },

  clearPendingPathMatch: () => set({ pendingPathMatch: null }),

  beginPendingReuseProposal: (input) => {
    const candidates = input.candidates.filter(
      (c) => c.normKey.trim() && c.pathKey.trim(),
    )
    if (!input.queryKey.trim() || candidates.length === 0) return
    const pending: PendingReuseProposal = {
      queryKey: input.queryKey.trim(),
      question: input.question.trim(),
      candidates,
      excludeBriefKeys: [...new Set(input.excludeBriefKeys.map((k) => k.trim()).filter(Boolean))],
      createdAt: Date.now(),
    }
    set({
      pendingReuseProposal: pending,
      deskPrompt:
        `写信台 · 复用提案×${candidates.length}：批准 → 铸 reuseKey；撤销 → 剔 brief 落入新铸。` +
        ` qk=${pending.queryKey}`,
    })
  },

  approvePendingReuse: ({ normKeys, llmCallId } = {}) => {
    const pending = get().pendingReuseProposal
    if (!pending) {
      return { ok: false, note: '无挂起复用提案', adopted: [] }
    }
    const want = new Set(
      (normKeys ?? pending.candidates.map((c) => c.normKey))
        .map((k) => k.trim())
        .filter(Boolean),
    )
    const adopted: Array<{
      queryKey: string
      reuseKey: string
      normKey: string
      pathKey: string
    }> = []
    for (const c of pending.candidates) {
      if (!want.has(c.normKey)) continue
      const row = get().adoptReusePath({
        question: pending.question,
        normKey: c.normKey,
        pathKey: c.pathKey,
        rationale: c.rationale,
        queryKey: pending.queryKey,
        llmCallId,
      })
      if (row) {
        adopted.push({
          queryKey: row.queryKey,
          reuseKey: row.reuseKey,
          normKey: row.normKey,
          pathKey: row.pathKey,
        })
      }
    }
    set({
      pendingReuseProposal: null,
      deskPrompt:
        adopted.length > 0
          ? `写信台 · 已批准复用×${adopted.length}`
          : '写信台 · 复用批准未落账',
      lastStatus:
        adopted.length > 0
          ? `复用批准 · ${adopted.map((a) => a.reuseKey).join(',')}`
          : '复用批准失败',
    })
    return {
      ok: adopted.length > 0,
      note:
        adopted.length > 0
          ? `批准复用×${adopted.length}`
          : '批准失败：候选未能 adopt',
      adopted,
    }
  },

  rejectPendingReuse: () => {
    const pending = get().pendingReuseProposal
    if (!pending) return null
    const out = {
      question: pending.question,
      queryKey: pending.queryKey,
      excludeBriefKeys: [...pending.excludeBriefKeys],
    }
    set({
      pendingReuseProposal: null,
      deskPrompt: '写信台 · 已撤销复用 → 可续跑新铸',
      lastStatus: '复用撤销',
    })
    return out
  },

  clearPendingReuseProposal: () => set({ pendingReuseProposal: null }),

  beginPendingReuseWait: (input) => {
    const queryKey = input.queryKey.trim()
    if (!queryKey) return
    const awaiting = [
      ...new Set(
        input.awaitingHistoricQueryKeys.map((k) => k.trim()).filter(Boolean),
      ),
    ]
    const exhausted = [
      ...new Set(
        input.exhaustedNormKeys.map((k) => k.trim()).filter(Boolean),
      ),
    ]
    const now = Date.now()
    const prev = get().pendingReuseWait
    const wait: PendingReuseWait = {
      queryKey,
      question: input.question.trim(),
      neighbourOrder: input.neighbourOrder.map((n) => ({
        historicQueryKey: n.historicQueryKey.trim(),
        degree: n.degree,
        rank: n.rank,
      })),
      exhaustedNormKeys: [
        ...new Set([...(prev?.queryKey === queryKey ? prev.exhaustedNormKeys : []), ...exhausted]),
      ],
      awaitingHistoricQueryKeys: awaiting,
      lastNote: input.lastNote || '复用停泊 · 等邻域历史问铸 norm',
      createdAt: prev?.queryKey === queryKey ? prev.createdAt : now,
      updatedAt: now,
    }
    set({
      pendingReuseWait: wait,
      deskPrompt:
        `复用停泊 · 现有 norm 不够撑满 Q · 等历史问铸 norm 后再续` +
        (awaiting.length
          ? ` · 待：${awaiting.map((k) => k.slice(0, 18)).join(',')}`
          : '') +
        ` · qk=${queryKey}`,
      lastStatus: wait.lastNote,
    })
  },

  clearPendingReuseWait: () =>
    set({
      pendingReuseWait: null,
    }),

  settleInferPaths: ({
    question,
    paths,
    bookTexts = {},
    queryKey: qkIn,
    llmCallId: lcIn,
  }) => {
    const q = question.trim()
    const queryKey = qkIn?.trim() || get().ensureQueryKey(q)
    const llmCallId = lcIn?.trim() || undefined
    const minted: InferEdge[] = []
    const inferKeys: string[] = []
    const now = Date.now()
    let seq = get().nextSettleSeq

    paths.forEach((path, pathIndex) => {
      const conclusion = (path.conclusion ?? '').trim()
      if (!conclusion && path.steps.length === 0) return
      const solutionSid = newSettleActionId('solution')
      const solutionKey = mintInstanceKey('solution', solutionSid)
      const resolvedConclusion =
        conclusion ||
        path.steps
          .map((s) => (s.infer ?? '').trim())
          .filter(Boolean)
          .join('；')

      path.steps.forEach((step, stepIndex) => {
        const keys = [
          ...new Set(step.bookKeys.map((k) => k.trim()).filter(Boolean)),
        ]
        if (keys.length < 1) return
        const fromBookKey = keys[0]!
        const toBookKey = keys[keys.length - 1]!
        const inferText = (step.infer ?? '').trim()
        if (!inferText) return
        const { settleActionId, inferKey } = mintInferKey()
        const role = (step.role ?? '').trim()
        const materialBlocks = keys.map((bk, i) => {
          const label =
            keys.length === 1
              ? '单门 · 原文'
              : `bookKey[${i}] · 原文`
          const T = (bookTexts[bk] ?? '').slice(0, 400)
          return [`【${label}】\`${bk}\``, T || '（无 T）'].join('\n')
        })
        const leftText = [`Q_now：${q}`, '', ...materialBlocks].join('\n\n')
        const outLabel = role
          ? `【infer · 步骤 · ${role}】`
          : '【infer · 步骤如何支撑解法总览】'
        minted.push({
          id: `inf_${now.toString(36)}_${pathIndex}_${stepIndex}_${minted.length}`,
          inferKey,
          settleActionId,
          llmCallId,
          contentFingerprint: fingerprintOfInfer(inferText),
          bookKeys: keys,
          bookSlots:
            step.bookSlots && step.bookSlots.length === keys.length
              ? [...step.bookSlots]
              : undefined,
          fromBookKey,
          toBookKey,
          infer: inferText,
          rationale: inferText,
          solutionKey,
          conclusion: resolvedConclusion,
          role,
          leftText,
          rightText: [
            `【解法总览】${resolvedConclusion}`,
            outLabel,
            inferText,
          ].join('\n'),
          question: q,
          queryKey,
          pathIndex,
          stepIndex,
          settleSeq: seq++,
          createdAt: now,
        })
        inferKeys.push(inferKey)
      })
    })

    set((s) => {
      const bookKeyToQuestions = { ...s.bookKeyToQuestions }
      const questionToBookKeys = { ...s.questionToBookKeys }
      const qBooks = new Set(questionToBookKeys[q] ?? [])
      for (const e of minted) {
        for (const bk of e.bookKeys) {
          qBooks.add(bk)
          const set = new Set(bookKeyToQuestions[bk] ?? [])
          set.add(q)
          bookKeyToQuestions[bk] = [...set]
        }
      }
      questionToBookKeys[q] = [...qBooks]
      const briefsForQ = s.questionToBriefKeys[q] ?? []
      const queryKeyToBriefKeys = { ...s.queryKeyToBriefKeys }
      if (briefsForQ.length > 0) {
        queryKeyToBriefKeys[queryKey] = [
          ...new Set([
            ...(queryKeyToBriefKeys[queryKey] ?? []),
            ...briefsForQ,
          ]),
        ]
      }
      // 一槽一 inferKey：只追加，禁止用正文指纹 / Map 覆盖合并
      return {
        inferEdges: [...s.inferEdges, ...minted],
        settledQueries: { ...s.settledQueries, [queryKey]: q },
        queryKeyToBriefKeys,
        nextSettleSeq: seq,
        lastStatus: `主推理落账 · queryKey=${queryKey} · ${minted.length} 步 inferKey · 解法按 solution 分组 · seq→${seq - 1}`,
      }
    })

    get().bumpIntentSessionAfterMainInfer(
      `主推理落账后换新意图 · qk=${queryKey}`,
    )

    for (const e of minted) {
      get().recordDeskDelivery({
        job: 'infer',
        fromKeys: e.bookKeys,
        toKey: e.inferKey,
      })
    }
    if (inferKeys.length > 0) {
      get().recordDeskDelivery({
        job: 'infer',
        fromKeys: inferKeys,
        toKey: queryKey,
      })
    }
    if (llmCallId && inferKeys.length > 0) {
      get().registerLlmCallBatch({
        llmCallId,
        job: 'infer',
        memberKeys: inferKeys,
        queryKey,
      })
    }

    // path：按解法铸候选 pathKey 并挂起；跳过→监督铸 normKey
    const existingUser = get()
      .paths.filter((p) => p.queryKey === queryKey && p.matchMode === 'user')
      .map((p) => p.pathKey)
    let pathKeys = existingUser
    if (existingUser.length === 0 && inferKeys.length > 0) {
      const pending = get().beginPendingPathMatch({
        queryKey,
        question: q,
        inferKeys,
      })
      pathKeys = pending.pathKeys
      // 解法未能铸 path 则清挂起
      if (pending.pathKeys.length === 0) {
        get().clearPendingPathMatch()
        set({
          lastStatus:
            `infer 已落 · 未能铸候选 path · qk=${queryKey}`,
        })
      }
    }

    return { queryKey, inferKeys, pathKeys }
  },

  adoptReusePath: ({
    question,
    normKey: nkIn,
    pathKey: pkIn,
    rationale,
    queryKey: qkIn,
    llmCallId: lcIn,
  }) => {
    const q = question.trim()
    const norm =
      (nkIn?.trim()
        ? get().norms.find((n) => n.normKey === nkIn.trim())
        : undefined) ||
      (pkIn?.trim()
        ? get().norms.find((n) => n.pathKey === pkIn.trim())
        : undefined)
    if (!q || !norm) return null
    const path = get().paths.find((p) => p.pathKey === norm.pathKey)
    if (!path) return null
    const queryKey = qkIn?.trim() || get().ensureQueryKey(q)
    const llmCallId = lcIn?.trim() || undefined
    const inferEdge = get().inferEdges.find((e) => e.inferKey === path.inferKey)
    const prospect = get().prospects.find(
      (p) => p.prospectKey === path.prospectKey,
    )
    const oldQueryKey = path.queryKey
    const oldQuestion =
      get().settledQueries[oldQueryKey] ?? inferEdge?.question ?? ''
    const settleActionId = newSettleActionId('reuse')
    const reuseKey = mintInstanceKey('reuse', settleActionId)
    const settleSeq = get().nextSettleSeq
    const link: QueryReuseLink = {
      id: `reuse_${Date.now().toString(36)}`,
      reuseKey,
      settleActionId,
      llmCallId,
      fromQueryKey: queryKey,
      normKey: norm.normKey,
      pathKey: path.pathKey,
      toQueryKey: oldQueryKey,
      question: q,
      oldQuestion,
      rationale: rationale.trim() || '复用闸：旧归一化路径能回 Q_now',
      inferKeys: [path.inferKey],
      prospectKeys: [path.prospectKey],
      settleSeq,
      createdAt: Date.now(),
    }

    set((s) => {
      const bookKeyToQuestions = { ...s.bookKeyToQuestions }
      const questionToBookKeys = { ...s.questionToBookKeys }
      const qBooks = new Set(questionToBookKeys[q] ?? [])
      if (inferEdge) {
        for (const bk of inferEdge.bookKeys) {
          qBooks.add(bk)
          const a = new Set(bookKeyToQuestions[bk] ?? [])
          a.add(q)
          bookKeyToQuestions[bk] = [...a]
        }
      }
      questionToBookKeys[q] = [...qBooks]
      const links = [
        ...s.queryReuseLinks.filter(
          (l) =>
            !(
              l.fromQueryKey === queryKey &&
              (l.normKey === norm.normKey || l.pathKey === path.pathKey)
            ),
        ),
        link,
      ]
      const queryKeyToBriefKeys = { ...s.queryKeyToBriefKeys }
      const fromOld = s.queryKeyToBriefKeys[oldQueryKey] ?? []
      const fromQ = s.questionToBriefKeys[q] ?? []
      const fromProspect = prospect ? [prospect.briefKey] : []
      queryKeyToBriefKeys[queryKey] = [
        ...new Set([
          ...(queryKeyToBriefKeys[queryKey] ?? []),
          ...fromOld,
          ...fromQ,
          ...fromProspect,
        ]),
      ]
      return {
        settledQueries: { ...s.settledQueries, [queryKey]: q },
        queryReuseLinks: links,
        questionToBookKeys,
        bookKeyToQuestions,
        queryKeyToBriefKeys,
        nextSettleSeq: settleSeq + 1,
        lastStatus:
          `复用采纳 · ${queryKey} ──(${reuseKey})──► ${norm.normKey} · #${settleSeq}`,
      }
    })

    get().recordDeskDelivery({
      job: 'reuse',
      fromKeys: [norm.normKey],
      toKey: reuseKey,
    })
    get().recordDeskDelivery({
      job: 'reuse',
      fromKeys: [reuseKey],
      toKey: queryKey,
    })
    if (llmCallId) {
      get().registerLlmCallBatch({
        llmCallId,
        job: 'reuse',
        memberKeys: [reuseKey],
        queryKey,
      })
    }
    return {
      queryKey,
      reuseKey,
      normKey: norm.normKey,
      pathKey: path.pathKey,
      oldQueryKey,
      inferKeys: [path.inferKey],
      prospectKeys: [path.prospectKey],
    }
  },

  listHistoricQuestions: () => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const st of get().steps) {
      const q = st.question.trim()
      if (!q || seen.has(q)) continue
      seen.add(q)
      out.push(q)
    }
    return out
  },

  listVersionsForEdge: (edgeId) => {
    const edge = get().edges.find((e) => e.id === edgeId)
    if (!edge) return []
    const rows: Array<{
      briefKey: string
      briefText: string
      question: string
      stepId: string
    }> = []
    const steps = [...get().steps].sort((a, b) => b.createdAt - a.createdAt)
    for (const st of steps) {
      if (!st.input.some((r) => r.kind === 'book' && r.key === edge.fromKey))
        continue
      const out = st.output.find((r) => r.kind === 'brief' || r.kind === 'delta')
      if (!out) continue
      rows.push({
        briefKey: out.key,
        briefText: out.text,
        question: st.question,
        stepId: st.id,
      })
    }
    return rows
  },

  suggestQGhost: (prefix) => {
    const p = prefix.trim().toLowerCase()
    if (!p) return null
    const hist = get().listHistoricQuestions()
    const hit = hist.find(
      (q) =>
        q.toLowerCase().startsWith(p) && q.toLowerCase() !== p,
    )
    return hit ?? null
  },
  setLastStatus: (msg) => set({ lastStatus: msg }),
  setDeskPrompt: (msg) => set({ deskPrompt: msg }),

  setPendingHunger: (h) =>
    set({
      pendingHunger: {
        queryKey: h.queryKey.trim(),
        closed: h.closed
          .map((c) => ({ from: c.from.trim(), to: c.to.trim() }))
          .filter((c) => c.from && c.to),
      },
    }),

  clearPendingHunger: () => set({ pendingHunger: null }),

  offerPendingIngestFeed: (bookKeys) => {
    const add = bookKeys.map((k) => k.trim()).filter(Boolean)
    if (add.length === 0) return
    set((s) => ({
      pendingIngestFeedBookKeys: [
        ...new Set([...s.pendingIngestFeedBookKeys, ...add]),
      ],
    }))
  },

  takePendingIngestFeed: () => {
    const keys = get().pendingIngestFeedBookKeys
    if (keys.length === 0) return []
    set({ pendingIngestFeedBookKeys: [] })
    return keys
  },

  clearPendingIngestFeed: () => set({ pendingIngestFeedBookKeys: [] }),
  clearDeskPrompt: () => set({ deskPrompt: null }),
  pushIntentDeskLog: ({ question, action, note }) => {
    const entry: IntentDeskLogEntry = {
      id: sid(),
      at: Date.now(),
      sessionEpoch: get().intentSessionEpoch,
      question: question.trim().slice(0, 240),
      action,
      note: note.slice(0, 400),
    }
    set((s) => ({
      intentDeskLog: [...s.intentDeskLog.slice(-79), entry],
    }))
  },
  bumpIntentSessionAfterMainInfer: (reason) => {
    const next = get().intentSessionEpoch + 1
    set({
      intentSessionEpoch: next,
      lastStatus:
        reason ||
        `意图会话已换新 · epoch=${next}（本问已进过主推理）`,
    })
    get().pushIntentDeskLog({
      question: '',
      action: 'intent_session_bump',
      note: reason || `epoch→${next} · after infer`,
    })
  },

  hydrateKeyLineageMemory: (input) => {
    const uniqBy = <T,>(rows: T[], keyOf: (r: T) => string): T[] => {
      const seen = new Set<string>()
      const out: T[] = []
      for (const r of rows) {
        const k = keyOf(r)
        if (!k || seen.has(k)) continue
        seen.add(k)
        out.push(r)
      }
      return out
    }
    set((s) => {
      const settledQueries = {
        ...s.settledQueries,
        ...input.settledQueries,
      }
      const queryParentOf = {
        ...s.queryParentOf,
        ...input.queryParentOf,
      }
      const queryKeyToBriefKeys = { ...s.queryKeyToBriefKeys }
      for (const [qk, briefs] of Object.entries(input.queryKeyToBriefKeys)) {
        const prev = queryKeyToBriefKeys[qk] ?? []
        queryKeyToBriefKeys[qk] = [
          ...new Set([...prev, ...briefs.map((b) => b.trim()).filter(Boolean)]),
        ]
      }
      const questionFingerprintToQueryKey = {
        ...s.questionFingerprintToQueryKey,
      }
      for (const [qk, text] of Object.entries(input.settledQueries)) {
        const t = (text || '').trim()
        if (!t) continue
        questionFingerprintToQueryKey[contentFingerprint(t)] = qk
      }
      return {
        settledQueries,
        queryParentOf,
        queryKeyToBriefKeys,
        questionFingerprintToQueryKey,
        prospects: uniqBy(
          [...s.prospects, ...input.prospects],
          (p) => p.prospectKey,
        ),
        paths: uniqBy([...s.paths, ...input.paths], (p) => p.pathKey),
        norms: uniqBy([...s.norms, ...input.norms], (n) => n.normKey),
        inferEdges: uniqBy(
          [...s.inferEdges, ...input.inferEdges],
          (e) => e.inferKey,
        ),
        neighbours: uniqBy(
          [...s.neighbours, ...input.neighbours],
          (n) => n.neighbourKey,
        ),
        queryReuseLinks: uniqBy(
          [...s.queryReuseLinks, ...input.queryReuseLinks],
          (r) => r.reuseKey,
        ),
        deskDeliveries: uniqBy(
          [...s.deskDeliveries, ...input.deskDeliveries],
          (d) => d.id || `${d.settleSeq}|${d.job}|${d.toKey}`,
        ),
        keyIncrementStatuses: uniqBy(
          [...s.keyIncrementStatuses, ...input.keyIncrementStatuses],
          (r) => `${r.job}|${r.key}|${r.queryKey ?? ''}|${r.settleSeq}`,
        ),
        nextSettleSeq: Math.max(
          s.nextSettleSeq || 1,
          typeof input.nextSettleSeq === 'number' ? input.nextSettleSeq : 1,
          ...[...s.deskDeliveries, ...input.deskDeliveries].map(
            (d) => (d.settleSeq ?? 0) + 1,
          ),
          ...[...s.keyIncrementStatuses, ...input.keyIncrementStatuses].map(
            (r) => (r.settleSeq ?? 0) + 1,
          ),
        ),
      }
    })
  },

  clearAll: () =>
    set({
      steps: [],
      edges: [],
      inferEdges: [],
      selectedEdgeId: null,
      selectedInferKey: null,
      selectedInferHostStrand: null,
      selectedQueryKey: null,
      pinnedAttention: null,
      confirmDraft: null,
      deskPackages: [],
      wmEdgeIds: [],
      lastStatus: null,
      deskPrompt: null,
      intentDeskLog: [],
      intentSessionEpoch: 0,
      bookKeyToQuestions: {},
      questionToBookKeys: {},
      questionToBriefKeys: {},
      queryKeyToBriefKeys: {},
      settledQueries: {},
      queryParentOf: {},
      questionFingerprintToQueryKey: {},
      prospects: [],
      paths: [],
      norms: [],
      neighbours: [],
      queryReuseLinks: [],
      pendingPathMatch: null,
      pendingReuseProposal: null,
      pendingReuseWait: null,
      keyIncrementStatuses: [],
      pendingHunger: null,
      pendingIngestFeedBookKeys: [],
      deskDeliveries: [],
      llmCallLedger: [],
      nextLlmCallTurnSeq: 1,
      nextSettleSeq: 1,
    }),

  toggleWm: (edgeId) => {
    const s = get()
    if (s.wmEdgeIds.includes(edgeId)) {
      set({
        wmEdgeIds: s.wmEdgeIds.filter((id) => id !== edgeId),
        deskPackages: s.deskPackages.filter((p) => p.edgeId !== edgeId),
        confirmDraft:
          s.confirmDraft?.edgeId === edgeId ? null : s.confirmDraft,
      })
      return
    }
    get().beginAttentionSwitch(edgeId)
  },

  setWm: (edgeId, on) => {
    if (on) get().beginAttentionSwitch(edgeId)
    else get().toggleWm(edgeId)
  },

  clearWm: () => get().clearDesk(),
}))

export function getSelectedEdge(): AttentionEdge | null {
  const s = useAttentionIo.getState()
  if (!s.selectedEdgeId) return null
  return s.edges.find((e) => e.id === s.selectedEdgeId) ?? null
}
