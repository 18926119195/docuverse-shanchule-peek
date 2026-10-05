/**
 * Fan-out orchestration:
 * prepareLetterDesk (draft+compose+propose) → human review → executeLetterDesk (gateway).
 * runFanout remains a one-shot helper (auto-confirm proposed decisions).
 */

import {
  executeInferOps,
  executeRetrieve,
  executeReuse,
} from './toolGateway'
import { executeInstructionCompose } from './instructionCompose'
import {
  buildCorridorPackage,
  buildDoorPackage,
  pickDefaultLockCorridor,
  type CorridorPackage,
  type DoorPackage,
  type LetterLockState,
} from './letterPackages'
import type { FanoutInferUnit } from './fanoutCompose'
import type { ComposePolicy } from './composePolicy'
import { FANOUT_ROLE_NOTE } from './fanoutRoles'
import {
  buildPathMarker,
  proposeLetterRows,
  rowsToDeferredArchive,
  snapshotFromRows,
  unitMemberKeysOf,
  type DeferredUnitArchive,
  type LetterDeskSnapshot,
  type LetterRunStrategy,
  type LetterUnitDecision,
  type LetterUnitRow,
} from './letterDesk'
import { buildFingerprint, collectRefluxMarkers } from './toolArchive'
import { LOCKED_LLM } from './modelRuntimeConfig'
import type { BookIndex, CircleCandidate } from './pipelineA'
import type { ActionRecord, FanoutPath } from './types'
import type {
  ForbidPatternEntry,
  HarnessContext,
  MotionBrainInput,
  MotionPlan,
  WorkingSetState,
} from './harnessTypes'
import { buildMotionPlans, buildMotionPlansFromDoorPackage, proposeComposeBags } from './motionBrain'
import { buildHarnessContext, pathToMemoryEntry } from './harnessContext'
import { emptyWorkingSet } from './harnessTypes'
import {
  allGatewayPlansApproved,
  buildPendingGatewayPlans,
  executeHarnessMotion,
  type PendingGatewayPlan,
} from './harnessGateway'
import type { BookSemanticIndex } from './semanticIndex'
import { inferWithMicroLoop } from './microLoop'

function ringAngle(strandIndex: number, total: number): number {
  const n = Math.max(total, 1)
  return (strandIndex / n) * Math.PI * 2 - Math.PI / 2
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const i = next
        next += 1
        results[i] = await fn(items[i], i)
      }
    },
  )
  await Promise.all(workers)
  return results
}

export interface FanoutRunOptions {
  topK?: number
  concurrency?: number
  pageCount?: number
  policy?: ComposePolicy
  acceptedPaths?: FanoutPath[]
  /** 已推断缓存（未采纳也可复用） */
  inferredPaths?: FanoutPath[]
  reuseAcceptedCombos?: boolean
  letterStrategy?: LetterRunStrategy
  expandBudget?: number
  /** 钉死对象后只保留这些草稿 key */
  lockedSlotKeys?: string[]
  /** 推理模型 id，进入指纹；换模型不命中旧缓存 */
  modelId?: string
  /** @deprecated use policy */
  windowRadius?: number
  /** @deprecated use policy */
  includeFine?: boolean
  /** @deprecated use policy */
  includeWindow?: boolean
  semanticIndex?: BookSemanticIndex | null
  /** Human lock for package A/B (corridor / doors) */
  letterLock?: LetterLockState
  /** @deprecated geometric compose deleted; ignored */
  instructionCompose?: boolean
  forceWholeBookRetrieve?: boolean
  onProgress?: (msg: string) => void
  /** Required for executeLetterDesk / runFanout gateway path */
  harnessExec?: {
    ctx: HarnessContext
    motionPlans: ReadonlyArray<MotionPlan>
    approvedPlanIds: ReadonlySet<string>
    pendingGateway: ReadonlyArray<PendingGatewayPlan>
    workingSet: WorkingSetState
    forbidPatterns: ForbidPatternEntry[]
    archiveOnlyPathIds: ReadonlySet<string>
  }
}

export interface FanoutDraftReport {
  searchQuery: string
  expandNote: string
  autoLockOk: boolean
  poolSize: number
  candidates: Array<{ key: string; score: number; page: number }>
}

/** Session held between prepare (review) and execute (gateway). */
export interface LetterDeskSession {
  question: string
  bookIndex: BookIndex
  pageCount: number
  concurrency: number
  units: FanoutInferUnit[]
  rows: LetterUnitRow[]
  snapshot: LetterDeskSnapshot
  draftReport: FanoutDraftReport
  retrieveAction: ActionRecord
  composeAction: ActionRecord
  acceptedPaths: FanoutPath[]
  inferredPaths: FanoutPath[]
  modelId: string
  /** Raw draft hits kept for re-compose after lock */
  draftCandidates: CircleCandidate[]
  /** Package A/B delivery (handbook) */
  corridorPackage?: CorridorPackage
  doorPackage?: DoorPackage
  lockCorridor?: string
  funnelStage?: string
}

export interface FanoutRunResult {
  ok: boolean
  error?: string
  paths: FanoutPath[]
  actions: ActionRecord[]
  searchQuery: string
  draftReport?: FanoutDraftReport
  letterDesk?: LetterDeskSnapshot
  deferredArchive?: DeferredUnitArchive[]
}

/** Build motion plans for letter desk (no full T text). */
export function buildMotionPlansForDesk(input: {
  question: string
  docId: string
  units: FanoutInferUnit[]
  acceptedPaths: FanoutPath[]
  inferredPaths: FanoutPath[]
  workingSet: WorkingSetState
  forbidPatterns: ForbidPatternEntry[]
  expandBudget: number
  draftKeys: string[]
  archiveOnlyPathIds?: ReadonlySet<string>
  doorPackage?: DoorPackage
}): MotionPlan[] {
  if (input.doorPackage) {
    return buildMotionPlansFromDoorPackage({
      question: input.question,
      docId: input.docId,
      doorPackage: input.doorPackage,
      workingSet: input.workingSet,
      forbidPatterns: input.forbidPatterns,
      expandBudget: input.expandBudget,
    })
  }

  const composeCandidates = input.units.map((u) => ({
    unitKey: u.candidate.R.key,
    kind: u.kind,
    label: u.label,
    memberKeys: unitMemberKeysOf(u),
  }))

  // 指纹 combo reuse 已废；motion 不再吃 reuseHits
  const reuseHits: Array<{ unitKey: string; pathId: string; score: number }> =
    []
  void input.acceptedPaths
  void input.inferredPaths

  const currentMemory = input.acceptedPaths
    .filter((p) => p.direction.accepted === true)
    .filter((p) => !(input.archiveOnlyPathIds?.has(p.pathId)))
    .map((p) => pathToMemoryEntry(p, 'settled', 'current'))

  const archivePaths = input.acceptedPaths
    .filter((p) => p.direction.accepted === true)
    .filter((p) => input.archiveOnlyPathIds?.has(p.pathId))
    .map((p) => pathToMemoryEntry(p, 'settled', 'archive'))

  return buildMotionPlans({
    question: input.question,
    docId: input.docId,
    draftKeys: input.draftKeys,
    composeCandidates,
    workingSet: input.workingSet,
    currentMemory,
    archivePaths,
    reuseHits,
    expandBudget: input.expandBudget,
    maxKeysPerPlan: 8,
    forbidPatterns: input.forbidPatterns,
  })
}

/** Re-lock corridor and rebuild door package + instruction bags. */
export async function relockCorridorOnDesk(
  session: LetterDeskSession,
  lockCorridor: string,
  options: {
    semanticIndex: BookSemanticIndex
    letterLock?: LetterLockState
    expandBudget?: number
    strategy?: LetterRunStrategy
  },
): Promise<LetterDeskSession> {
  const letterLock: LetterLockState = {
    ...options.letterLock,
    lockCorridor,
    skipPackageA: true,
  }
  const draftKeys = session.draftReport.candidates.map((c) => c.key)
  const corridorPackage = buildCorridorPackage({
    question: session.question,
    semantic: options.semanticIndex,
    draftKeys,
    lock: letterLock,
  })
  const motionBags = proposeComposeBags({
    draftKeys,
    bookIndex: session.bookIndex,
    semantic:
      options.semanticIndex.tocConfirmed === true
        ? options.semanticIndex
        : null,
    maxBags: 5,
  })
  const composed = await executeInstructionCompose({
    bookIndex: session.bookIndex,
    fineCandidates: session.draftCandidates,
    draftKeys,
    scopedKeys: letterLock.lockKeys ?? [],
    question: session.question,
    spec: {
      mode: 'custom',
      customBags: motionBags.bags,
      maxBags: Math.max(1, motionBags.bags.length),
    },
  })
  const units = composed.ok ? composed.units : session.units
  const doorPackage = buildDoorPackage({
    question: session.question,
    docId: session.bookIndex.docId,
    bookIndex: session.bookIndex,
    semantic: options.semanticIndex,
    lockCorridor,
    draftKeys,
    scopedKeys: letterLock.lockKeys ?? [],
    bags: units,
    acceptedPaths: session.acceptedPaths,
    inferredPaths: session.inferredPaths,
    modelId: session.modelId,
    lock: letterLock,
  })
  const strategy = options.strategy ?? session.snapshot.strategy
  const expandBudget = options.expandBudget ?? session.snapshot.expandBudget
  const rows = proposeLetterRows({
    units,
    question: session.question,
    acceptedPaths: session.acceptedPaths,
    inferredPaths: session.inferredPaths,
    modelId: session.modelId,
    strategy,
    expandBudget,
    allowReuse: true,
  })
  return {
    ...session,
    units,
    rows,
    composeAction: composed.action,
    corridorPackage,
    doorPackage,
    lockCorridor,
    snapshot: snapshotFromRows({
      question: session.question,
      comboCount: units.length,
      strategy,
      expandBudget,
      rows,
      status: 'review',
    }),
  }
}

function defaultExpandPlan(unit: FanoutInferUnit): MotionPlan {
  const memberKeys = unitMemberKeysOf(unit)
  return {
    rank: 1,
    planId: `expand_${unit.candidate.R.key.slice(0, 16)}`,
    action: 'expand',
    faultInKeys: memberKeys,
    collapseKeys: [],
    unitKey: unit.candidate.R.key,
    score: 0.6,
    rationale: '默认 expand · 全开 memberKeys',
  }
}

function resolvePlanForUnit(
  unit: FanoutInferUnit,
  plans: ReadonlyArray<MotionPlan>,
): MotionPlan {
  const hit = plans.find((p) => p.unitKey === unit.candidate.R.key)
  return hit ?? defaultExpandPlan(unit)
}

function buildBrainInputForUnit(input: {
  question: string
  docId: string
  units: FanoutInferUnit[]
  acceptedPaths: FanoutPath[]
  inferredPaths: FanoutPath[]
  workingSet: WorkingSetState
  forbidPatterns: ForbidPatternEntry[]
  expandBudget: number
  draftKeys: string[]
  archivePaths: FanoutPath[]
}): MotionBrainInput {
  const composeCandidates = input.units.map((u) => ({
    unitKey: u.candidate.R.key,
    kind: u.kind,
    label: u.label,
    memberKeys: unitMemberKeysOf(u),
  }))
  // 指纹 combo reuse 已废
  const reuseHits: Array<{ unitKey: string; pathId: string; score: number }> = []
  void input.inferredPaths
  const currentMemory = input.acceptedPaths
    .filter((p) => p.direction.accepted === true)
    .map((p) => pathToMemoryEntry(p, 'settled', 'current'))
  const archiveMemory = input.archivePaths.map((p) =>
    pathToMemoryEntry(p, 'settled', 'archive'),
  )
  return {
    question: input.question,
    docId: input.docId,
    draftKeys: input.draftKeys,
    composeCandidates,
    workingSet: input.workingSet,
    currentMemory,
    archivePaths: archiveMemory,
    reuseHits,
    expandBudget: input.expandBudget,
    maxKeysPerPlan: 8,
    forbidPatterns: input.forbidPatterns,
  }
}

async function inferUnitViaHarness(input: {
  unit: FanoutInferUnit
  units: FanoutInferUnit[]
  question: string
  bookIndex: BookIndex
  ctx: HarnessContext
  plan: MotionPlan
  workingSet: WorkingSetState
  brainInput: MotionBrainInput
  approved: boolean
}): Promise<{
  result: Awaited<ReturnType<typeof executeInferOps>>
  workingSet: WorkingSetState
  gatewayActions: ActionRecord[]
}> {
  const needsGate =
    input.plan.action === 'scopeRequest' ||
    input.plan.action === 'faultIn' ||
    (input.plan.action === 'expand' && input.plan.faultInKeys.length > 0)

  if (needsGate && !input.approved) {
    const action: ActionRecord = {
      actionId: `gate_skip_${Date.now().toString(36)}`,
      actionKind: 'infer',
      premiseKeys: unitMemberKeysOf(input.unit),
      inputsRef: { question: input.question, role: 'gateway' },
      outputsRef: { error: '双闸未批准', roleNote: 'gateway · awaiting approval' },
      createdAt: Date.now(),
    }
    return {
        result: {
          action,
          direction: null,
          ok: false,
          error: '双闸未批准',
        },
      workingSet: input.workingSet,
      gatewayActions: [],
    }
  }

  if (
    input.plan.action === 'collapse' ||
    input.plan.action === 'scopeRequest' ||
    input.plan.action === 'faultIn'
  ) {
    const motion = await executeHarnessMotion({
      plan: input.plan,
      ctx: input.ctx,
      bookIndex: input.bookIndex,
      unit: input.unit,
      question: input.question,
      workingSet: input.workingSet,
      approved: input.approved,
    })
    if (motion.skipped || !motion.inferResult) {
      const err = motion.skipReason ?? 'motion 跳过'
      const action: ActionRecord = {
        actionId: `motion_skip_${Date.now().toString(36)}`,
        actionKind: 'infer',
        premiseKeys: unitMemberKeysOf(input.unit),
        inputsRef: { question: input.question, role: 'gateway' },
        outputsRef: { error: err },
        createdAt: Date.now(),
      }
      return {
        result: {
          action,
          direction: null,
          ok: false,
          error: err,
        },
        workingSet: motion.workingSet,
        gatewayActions: motion.actions,
      }
    }
    return {
      result: motion.inferResult,
      workingSet: motion.workingSet,
      gatewayActions: motion.actions,
    }
  }

  const loop = await inferWithMicroLoop({
    unit: input.unit,
    question: input.question,
    bookIndex: input.bookIndex,
    ctx: input.ctx,
    initialPlan: input.plan,
    brainInput: input.brainInput,
    workingSet: input.workingSet,
  })

  return {
    result: loop.result,
    workingSet: loop.workingSet,
    gatewayActions: [],
  }
}

function isNearFullPage(bbox: [number, number, number, number]): boolean {
  const area = Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1])
  return area >= 0.82 * 1_000_000
}

function pickTightBBox(chunk: {
  bbox: [number, number, number, number]
  inkBoxes?: Array<[number, number, number, number]>
}): [number, number, number, number] {
  if (!isNearFullPage(chunk.bbox)) return chunk.bbox
  const parts = (chunk.inkBoxes ?? []).filter((b) => !isNearFullPage(b))
  if (parts.length === 1) return parts[0]
  if (parts.length > 1) {
    let x0 = 1000
    let y0 = 1000
    let x1 = 0
    let y1 = 0
    for (const b of parts) {
      x0 = Math.min(x0, b[0])
      y0 = Math.min(y0, b[1])
      x1 = Math.max(x1, b[2])
      y1 = Math.max(y1, b[3])
    }
    return [x0, y0, x1, y1]
  }
  return chunk.bbox
}

function premisePagesOf(unit: FanoutInferUnit): number[] {
  const pages = new Set<number>()
  pages.add(unit.candidate.R.page)
  for (const box of unit.candidate.boxes) pages.add(box.page)
  for (const m of unit.candidate.members) pages.add(m.page)
  return [...pages]
}

function composeScopeOf(
  pages: number[],
  memberCount: number,
): 'single' | 'same_page' | 'cross_page' {
  if (memberCount <= 1) return 'single'
  if (pages.length <= 1) return 'same_page'
  return 'cross_page'
}

function slotsOf(
  unit: FanoutInferUnit,
  bookIndex: BookIndex,
): FanoutPath['slots'] {
  const { candidate } = unit
  const text = candidate.excerpt.replace(/^【[^\n]*】\n?/, '').trim()
  const keys =
    candidate.R.memberKeys && candidate.R.memberKeys.length > 0
      ? candidate.R.memberKeys
      : candidate.members.map((m) => m.slotId)

  if (keys.length > 0) {
    return keys.map((key, i) => {
      const chunk = bookIndex.chunks.find((c) => c.key === key)
      const member = candidate.members.find((m) => m.slotId === key)
      const bbox = chunk
        ? pickTightBBox(chunk)
        : !member?.bbox || isNearFullPage(member.bbox)
          ? ([100, 120, 500, 320] as [number, number, number, number])
          : member.bbox
      const page =
        chunk?.page ?? member?.page ?? candidate.boxes[i]?.page ?? candidate.R.page
      const excerpt = chunk
        ? (chunk.faces.text?.content ?? chunk.content).slice(0, 96)
        : text.slice(0, 96)
      return { key, page, bbox, excerpt }
    })
  }

  return candidate.boxes.map((b) => ({
    key: candidate.R.key,
    page: b.page,
    bbox: isNearFullPage(b.bbox)
      ? ([100, 120, 500, 320] as [number, number, number, number])
      : b.bbox,
    excerpt: text.slice(0, 96),
  }))
}

/**
 * Draft + compose + propose unit decisions. Does NOT call the gateway infer/reuse.
 */
export async function prepareLetterDesk(
  bookIndex: BookIndex,
  question: string,
  options: FanoutRunOptions = {},
): Promise<
  | { ok: true; session: LetterDeskSession; actions: ActionRecord[] }
  | { ok: false; error: string; actions: ActionRecord[]; draftReport?: FanoutDraftReport; searchQuery: string }
> {
  const q = question.trim()
  if (!q) {
    return {
      ok: false,
      error: '请先输入问题',
      actions: [],
      searchQuery: '',
    }
  }

  const topK = options.topK ?? 5
  const concurrency = options.concurrency ?? 3
  const pageCount = Math.max(options.pageCount ?? 1, 1)
  // 指纹 combo reuse 已废除（2026-09-04）；问线复用走 neighbour→path
  const allowReuse = false
  void options.reuseAcceptedCombos
  const acceptedPaths = (options.acceptedPaths ?? []).filter(
    (p) => p.direction.accepted === true,
  )
  const inferredPaths = options.inferredPaths ?? []
  const modelId = options.modelId || LOCKED_LLM.chatModel
  const strategy: LetterRunStrategy = options.letterStrategy ?? 'force_expand'
  const expandBudget = options.expandBudget ?? 3
  const actions: ActionRecord[] = []

  options.onProgress?.('草稿·漏斗缩域→召回 key*（非注入）…')
  const retrieved = await executeRetrieve({
    bookIndex,
    question: q,
    topK,
    semanticIndex: options.semanticIndex ?? null,
    forceWholeBook: options.forceWholeBookRetrieve,
    preferredSectionIds: options.letterLock?.lockCorridor
      ? [options.letterLock.lockCorridor]
      : undefined,
  })
  actions.push(retrieved.action)

  if (retrieved.candidates.length === 0) {
    return {
      ok: false,
      error: `未检索到可推理段落（池=${retrieved.poolSize}）`,
      actions,
      searchQuery: retrieved.searchQuery,
      draftReport: {
        searchQuery: retrieved.searchQuery,
        expandNote: retrieved.expandNote,
        autoLockOk: retrieved.autoLockOk,
        poolSize: retrieved.poolSize,
        candidates: [],
      },
    }
  }

  let fineCandidates = retrieved.candidates
  const locked = options.lockedSlotKeys?.filter(Boolean) ?? []
  if (locked.length > 0) {
    const allow = new Set(locked)
    const filtered = fineCandidates.filter((c) => allow.has(c.R.key))
    if (filtered.length > 0) fineCandidates = filtered
  }

  const draftKeys = fineCandidates.map((c) => c.R.key)
  const draftReport: FanoutDraftReport = {
    searchQuery: retrieved.searchQuery,
    expandNote: retrieved.expandNote,
    autoLockOk: retrieved.autoLockOk,
    poolSize: retrieved.poolSize,
    candidates: retrieved.candidates.map((c) => ({
      key: c.R.key,
      score: c.score,
      page: c.R.page,
    })),
  }

  const draftAction: ActionRecord = {
    ...retrieved.action,
    outputsRef: {
      ...retrieved.action.outputsRef,
      roleNote: [
        FANOUT_ROLE_NOTE.draft,
        retrieved.stage ? `漏斗=${retrieved.stage}` : '',
        retrieved.autoLockOk ? 'autoLockOk' : 'autoLockOff',
        retrieved.expandNote || '',
        `pool=${retrieved.poolSize}`,
        locked.length ? `locked=${locked.length}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    },
  }
  actions[actions.length - 1] = draftAction

  options.onProgress?.(
    retrieved.autoLockOk
      ? `写信·草稿已递交（建议锁 Top1 · ${draftReport.candidates.length} 料）…`
      : `写信·指令组袋（${fineCandidates.length} 料）…`,
  )

  const semantic =
    options.semanticIndex?.tocConfirmed === true
      ? options.semanticIndex
      : null
  let corridorPackage: CorridorPackage | undefined
  let doorPackage: DoorPackage | undefined
  let lockCorridor: string | undefined =
    options.letterLock?.lockCorridor || retrieved.lockCorridorHint

  if (semantic) {
    corridorPackage = buildCorridorPackage({
      question: q,
      semantic,
      draftKeys,
      lock: options.letterLock,
      topK: 5,
    })
    lockCorridor =
      options.letterLock?.lockCorridor ||
      pickDefaultLockCorridor(corridorPackage) ||
      lockCorridor
  }

  // Handbook §0.10: bags from motion brain; geometric not on main path.
  const motionBags = proposeComposeBags({
    draftKeys,
    bookIndex,
    semantic: semantic?.tocConfirmed ? semantic : null,
    maxBags: Math.min(5, Math.max(1, topK)),
  })
  const composed = await executeInstructionCompose({
    bookIndex,
    fineCandidates,
    draftKeys,
    scopedKeys: options.letterLock?.lockKeys ?? [],
    question: q,
    spec: {
      mode: 'custom',
      customBags: motionBags.bags,
      maxBags: Math.max(1, motionBags.bags.length),
    },
  })
  actions.push({
    ...composed.action,
    outputsRef: {
      ...composed.action.outputsRef,
      roleNote: [composed.action.outputsRef.roleNote, motionBags.rationale]
        .filter(Boolean)
        .join(' · '),
    },
  })

  if (!composed.ok || composed.units.length === 0) {
    return {
      ok: false,
      error: composed.error || '组合后无可用推理单元',
      actions,
      searchQuery: retrieved.searchQuery,
      draftReport,
    }
  }

  if (semantic && lockCorridor) {
    doorPackage = buildDoorPackage({
      question: q,
      docId: bookIndex.docId,
      bookIndex,
      semantic,
      lockCorridor,
      draftKeys,
      scopedKeys: options.letterLock?.lockKeys ?? [],
      bags: composed.units,
      acceptedPaths,
      inferredPaths,
      modelId,
      lock: options.letterLock,
    })
  }

  const rows = proposeLetterRows({
    units: composed.units,
    question: q,
    acceptedPaths,
    inferredPaths,
    modelId,
    strategy,
    expandBudget,
    allowReuse,
  })
  const snapshot = snapshotFromRows({
    question: q,
    comboCount: composed.units.length,
    strategy,
    expandBudget,
    rows,
    status: 'review',
  })

  options.onProgress?.(
    `写信台·指令袋 ${snapshot.comboCount} · 复用 ${snapshot.counts.reuse} · 新推 ${snapshot.counts.expand} · 尚未展开 ${snapshot.counts.deferred}` +
      (lockCorridor ? ` · 廊 ${lockCorridor}` : ''),
  )

  return {
    ok: true,
    actions,
    session: {
      question: q,
      bookIndex,
      pageCount,
      concurrency,
      units: composed.units,
      rows,
      snapshot,
      draftReport,
      retrieveAction: draftAction,
      composeAction: composed.action,
      acceptedPaths,
      inferredPaths,
      modelId,
      draftCandidates: retrieved.candidates,
      corridorPackage,
      doorPackage,
      lockCorridor,
      funnelStage: retrieved.stage,
    },
  }
}

export function reproposeLetterDesk(
  session: LetterDeskSession,
  input: {
    strategy: LetterRunStrategy
    expandBudget: number
    allowReuse?: boolean
  },
): LetterDeskSession {
  const rows = proposeLetterRows({
    units: session.units,
    question: session.question,
    acceptedPaths: session.acceptedPaths,
    inferredPaths: session.inferredPaths,
    modelId: session.modelId,
    strategy: input.strategy,
    expandBudget: input.expandBudget,
    allowReuse: input.allowReuse !== false,
  })
  return {
    ...session,
    rows,
    snapshot: snapshotFromRows({
      question: session.question,
      comboCount: session.units.length,
      strategy: input.strategy,
      expandBudget: input.expandBudget,
      rows,
      status: 'review',
    }),
  }
}

export function setLetterUnitDecision(
  session: LetterDeskSession,
  index: number,
  decision: LetterUnitDecision,
): LetterDeskSession {
  const rows = session.rows.map((r) => {
    if (r.index !== index) return r
    if (decision === 'reuse') {
      // 指纹 combo reuse 已废：手动选 reuse → 降级 expand
      return {
        ...r,
        decision: 'expand' as const,
        rationale:
          'fanout 指纹 reuse 已废除 → 改为新推（问线复用请走 neighbour→path）',
        reuseFromPathId: undefined,
      }
    }
    if (decision === 'deferred') {
      return {
        ...r,
        decision: 'deferred' as const,
        rationale: '手动标为尚未展开',
        reuseFromPathId: undefined,
      }
    }
    return {
      ...r,
      decision: 'expand' as const,
      rationale: '手动标为本轮新推',
      reuseFromPathId: undefined,
    }
  })
  return {
    ...session,
    rows,
    snapshot: snapshotFromRows({
      question: session.question,
      comboCount: session.units.length,
      strategy: session.snapshot.strategy,
      expandBudget: session.snapshot.expandBudget,
      rows,
      status: 'review',
    }),
  }
}

/**
 * Re-compose letter desk after user locks current object (草稿锁细).
 */
export async function rebuildLetterDeskWithLock(
  session: LetterDeskSession,
  input: {
    lockedSlotKeys: string[]
    policy?: ComposePolicy
    strategy: LetterRunStrategy
    expandBudget: number
  },
): Promise<
  | { ok: true; session: LetterDeskSession; action: ActionRecord }
  | { ok: false; error: string; action?: ActionRecord }
> {
  const allow = new Set(input.lockedSlotKeys.filter(Boolean))
  let fine = session.draftCandidates
  if (allow.size > 0) {
    const filtered = fine.filter((c) => allow.has(c.R.key))
    if (filtered.length > 0) fine = filtered
  }
  const draftKeys = fine.map((c) => c.R.key)
  const motionBags = proposeComposeBags({
    draftKeys,
    bookIndex: session.bookIndex,
    semantic: null,
    maxBags: Math.min(5, Math.max(1, draftKeys.length)),
  })
  const composed = await executeInstructionCompose({
    bookIndex: session.bookIndex,
    fineCandidates: fine,
    draftKeys,
    question: session.question,
    spec: {
      mode: 'custom',
      customBags: motionBags.bags,
      maxBags: Math.max(1, motionBags.bags.length),
    },
  })
  if (!composed.ok || composed.units.length === 0) {
    return {
      ok: false,
      error: composed.error || '按锁定对象组合后无单元',
      action: composed.action,
    }
  }
  const rows = proposeLetterRows({
    units: composed.units,
    question: session.question,
    acceptedPaths: session.acceptedPaths,
    inferredPaths: session.inferredPaths,
    modelId: session.modelId,
    strategy: input.strategy,
    expandBudget: input.expandBudget,
    allowReuse: true,
  })
  return {
    ok: true,
    action: composed.action,
    session: {
      ...session,
      units: composed.units,
      rows,
      composeAction: composed.action,
      snapshot: snapshotFromRows({
        question: session.question,
        comboCount: composed.units.length,
        strategy: input.strategy,
        expandBudget: input.expandBudget,
        rows,
        status: 'review',
      }),
    },
  }
}
/**
 * Gateway execute: only reuse + expand rows. Deferred → archive, not run.
 */
export async function executeLetterDesk(
  session: LetterDeskSession,
  options: {
    onProgress?: (msg: string) => void
    harness: {
      ctx: HarnessContext
      motionPlans: ReadonlyArray<MotionPlan>
      approvedPlanIds: ReadonlySet<string>
      pendingGateway: ReadonlyArray<PendingGatewayPlan>
      workingSet: WorkingSetState
      forbidPatterns: ForbidPatternEntry[]
      archiveOnlyPathIds: ReadonlySet<string>
    }
  },
): Promise<FanoutRunResult & { returnToDesk?: boolean; workingSet?: WorkingSetState }> {
  const {
    question: q,
    bookIndex,
    pageCount,
    concurrency,
    units,
    rows,
    draftReport,
    retrieveAction,
    composeAction,
    acceptedPaths,
    inferredPaths,
    modelId,
  } = session

  const actions: ActionRecord[] = [retrieveAction, composeAction]
  const toReuse: Array<{ unit: FanoutInferUnit; index: number; from: FanoutPath }> =
    []
  const toInfer: Array<{ unit: FanoutInferUnit; index: number }> = []
  const archivePool = [...acceptedPaths, ...inferredPaths]

  for (const row of rows) {
    const unit = units[row.index]
    if (!unit) continue
    // 指纹 combo reuse 已废：即便旧会话残留 decision=reuse，也一律新推
    if (row.decision === 'expand' || row.decision === 'reuse') {
      toInfer.push({ unit, index: row.index })
    }
  }

  const deferredArchive = rowsToDeferredArchive(q, rows)
  const refluxPool = collectRefluxMarkers(archivePool, 6)
  const refluxPremise = refluxPool[0]
    ? {
        conclusion: refluxPool[0].conclusion,
        pathSummary: refluxPool
          .map((m) => m.pathSummary)
          .join(' || ')
          .slice(0, 400),
        fromKey: refluxPool[0].fromKey,
      }
    : undefined

  options.onProgress?.(
    toReuse.length + toInfer.length > 0
      ? `网关·新推 ${toInfer.length} · 复用 ${toReuse.length} · 跳过尚未展开 ${deferredArchive.length}${
          refluxPremise ? ' · 带路径标记回流' : ''
        }${options.harness ? ' · 编译→infer→监督' : ''}`
      : `网关·本轮无执行单元（${deferredArchive.length} 条尚未展开已存档）`,
  )

  if (toReuse.length + toInfer.length === 0) {
    return {
      ok: deferredArchive.length > 0,
      error:
        deferredArchive.length > 0
          ? undefined
          : '写信台无 reuse/expand 单元可执行',
      paths: [],
      actions,
      searchQuery: draftReport.searchQuery,
      draftReport,
      letterDesk: {
        ...session.snapshot,
        status: deferredArchive.length > 0 ? 'done' : 'review',
        counts: {
          reuse: 0,
          expand: 0,
          deferred: deferredArchive.length,
        },
      },
      deferredArchive,
      returnToDesk: deferredArchive.length === 0,
    }
  }

  if (!allGatewayPlansApproved(options.harness.pendingGateway)) {
    return {
      ok: false,
      error: '双闸：尚有 motion 计划未人批（scopeRequest / faultIn / partial expand）',
      paths: [],
      actions,
      searchQuery: draftReport.searchQuery,
      draftReport,
      letterDesk: { ...session.snapshot, status: 'review' },
      deferredArchive: rowsToDeferredArchive(q, rows),
      returnToDesk: true,
    }
  }

  const motionPlans = options.harness.motionPlans
  const harnessCtx = options.harness.ctx
  let execWorkingSet = options.harness.workingSet

  const archiveOnlyPaths = acceptedPaths.filter((p) =>
    options.harness.archiveOnlyPathIds.has(p.pathId),
  )

  const brainInput = buildBrainInputForUnit({
    question: q,
    docId: harnessCtx.docId,
    units,
    acceptedPaths,
    inferredPaths,
    workingSet: execWorkingSet,
    forbidPatterns: options.harness.forbidPatterns,
    expandBudget: session.snapshot.expandBudget,
    draftKeys: draftReport.candidates.map((c) => c.key),
    archivePaths: archiveOnlyPaths,
  })

  const inferResults = await mapPool(
    toInfer,
    concurrency,
    async ({ unit, index }) => {
      const plan = resolvePlanForUnit(unit, motionPlans)
      const needsGate = plan.action === 'scopeRequest' || plan.action === 'faultIn'
      const approved =
        !needsGate || options.harness.approvedPlanIds.has(plan.planId)

      const out = await inferUnitViaHarness({
        unit,
        units,
        question: q,
        bookIndex,
        ctx: {
          ...harnessCtx,
          working: { ...harnessCtx.working, question: q },
        },
        plan,
        workingSet: execWorkingSet,
        brainInput,
        approved,
      })
      execWorkingSet = out.workingSet
      return {
        result: out.result,
        gatewayActions: out.gatewayActions,
        index,
        unit,
        reusedFromPathId: undefined as string | undefined,
      }
    },
  )

  const reuseResults = toReuse.map(({ unit, index, from }) => {
    const result = executeReuse({
      candidate: unit.candidate,
      question: q,
      fromPath: from,
    })
    return {
      result,
      index,
      unit,
      reusedFromPathId: from.pathId,
    }
  })

  const merged = [...inferResults, ...reuseResults].sort(
    (a, b) => a.index - b.index,
  )

  const paths: FanoutPath[] = []
  const retrieveId = retrieveAction.actionId
  const composeId = composeAction.actionId

  for (const item of merged) {
    const { result, index, unit, reusedFromPathId } = item
    const gatewayActions =
      'gatewayActions' in item ? item.gatewayActions : undefined
    if (gatewayActions?.length) actions.push(...gatewayActions)
    actions.push(result.action)
    if (!result.ok || !result.direction) continue

    const premisePages = premisePagesOf(unit)
    const memberKeys = unitMemberKeysOf(unit)
    // Model-authored path/conclusion → compact marker for later reflux
    const pathMarker = buildPathMarker({
      unitLabel: unit.label,
      memberKeys,
      question: q,
      conclusion: result.direction.conclusion,
      path: result.direction.path,
      reused: Boolean(reusedFromPathId),
    })
    const fingerprint = buildFingerprint({
      toolClass: 'infer',
      memberKeys,
      stepOrder: unit.kind,
      modelId,
    })

    const direction = {
      ...result.direction,
      premiseKeys: memberKeys,
      actionIds: [retrieveId, composeId, result.action.actionId],
      path: reusedFromPathId
        ? result.direction.path
        : `【${unit.label}】\n${result.direction.path}`,
      pathMarker,
      fingerprint,
      cacheTier: 'inferred' as const,
      referencedPathIds: reusedFromPathId ? [reusedFromPathId] : undefined,
    }

    const last = actions[actions.length - 1]
    if (last) {
      actions[actions.length - 1] = {
        ...last,
        outputsRef: { ...last.outputsRef, pathMarker },
      }
    }

    const anchorPage = premisePages[0] ?? unit.candidate.R.page
    const slots = slotsOf(unit, bookIndex)
    paths.push({
      pathId: `path_${result.action.actionId}`,
      question: q,
      direction,
      actionIds: direction.actionIds ?? [],
      premisePages,
      slots,
      unitKind: unit.kind,
      unitLabel: reusedFromPathId ? `复用·${unit.label}` : unit.label,
      composeScope: composeScopeOf(premisePages, memberKeys.length),
      injectedExcerpt: unit.candidate.excerpt,
      conclusionAngle:
        ringAngle(anchorPage, pageCount) +
        (index - (units.length - 1) / 2) * 0.06,
      createdAt: Date.now(),
      reusedFromPathId,
    })
  }

  if (paths.length === 0 && deferredArchive.length === 0) {
    const lastErr = merged
      .map((r) => r.result.error)
      .filter(Boolean)
      .slice(-1)[0]
    return {
      ok: false,
      error: `${lastErr || '全部单元推理失败'} · 已回写信台，请改信后再确认执行`,
      paths: [],
      actions,
      searchQuery: draftReport.searchQuery,
      draftReport,
      letterDesk: { ...session.snapshot, status: 'review' },
      deferredArchive,
      returnToDesk: true,
    }
  }

  return {
    ok: true,
    paths,
    actions,
    searchQuery: draftReport.searchQuery,
    draftReport,
    letterDesk: {
      ...session.snapshot,
      status: 'done',
    },
    deferredArchive,
    workingSet: execWorkingSet,
  }
}

/**
 * One-shot: prepare + auto-confirm proposed decisions + execute.
 * Prefer prepareLetterDesk → review → executeLetterDesk in the HUD.
 */
export async function runFanout(
  bookIndex: BookIndex,
  question: string,
  options: FanoutRunOptions = {},
): Promise<FanoutRunResult> {
  const prepared = await prepareLetterDesk(bookIndex, question, options)
  if (!prepared.ok) {
    return {
      ok: false,
      error: prepared.error,
      paths: [],
      actions: prepared.actions,
      searchQuery: prepared.searchQuery,
      draftReport: prepared.draftReport,
    }
  }

  let harnessExec = options.harnessExec
  if (!harnessExec) {
    const plans = buildMotionPlansForDesk({
      question: question.trim(),
      docId: bookIndex.docId,
      units: prepared.session.units,
      acceptedPaths: options.acceptedPaths ?? [],
      inferredPaths: options.inferredPaths ?? [],
      workingSet: emptyWorkingSet(),
      forbidPatterns: [],
      expandBudget: options.expandBudget ?? 3,
      draftKeys: prepared.session.draftReport.candidates.map((c) => c.key),
      archiveOnlyPathIds: new Set<string>(),
    })
    const approved = new Set(plans.map((p) => p.planId))
    const ctx = buildHarnessContext({
      docId: bookIndex.docId,
      sessionPaths: [],
      acceptedPaths: options.acceptedPaths ?? [],
      actionLog: prepared.actions,
      acceptedActionLog: [],
      question: question.trim(),
      workingSet: emptyWorkingSet(),
    })
    const pending = buildPendingGatewayPlans(
      plans,
      ctx,
      bookIndex,
      approved,
    ).map((p) => ({ ...p, status: 'approved' as const }))
    harnessExec = {
      ctx,
      motionPlans: plans,
      approvedPlanIds: approved,
      pendingGateway: pending,
      workingSet: emptyWorkingSet(),
      forbidPatterns: [],
      archiveOnlyPathIds: new Set<string>(),
    }
  }

  return executeLetterDesk(prepared.session, {
    onProgress: options.onProgress,
    harness: harnessExec,
  })
}
