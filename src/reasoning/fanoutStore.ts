/**
 * Fan-out store: session results are ephemeral;
 * accepted paths + deferred (尚未展开) archives persist to localStorage.
 */

import { create } from 'zustand'
import type { ActionRecord, FanoutPath } from './types'
import { FANOUT_ROLE_NOTE } from './fanoutRoles'
import type { IdentityKind } from './identityFocus'
import type {
  FanoutDraftReport,
  LetterDeskSession,
} from './fanoutRunner'
import type {
  DeferredUnitArchive,
  LetterDeskSnapshot,
  LetterRunStrategy,
  LetterUnitDecision,
} from './letterDesk'
import {
  reproposeLetterDesk,
  setLetterUnitDecision,
} from './fanoutRunner'
import {
  emptyCurrentObject,
  lockSlotsObject,
  type CurrentObject,
} from './currentObject'
import { LOCKED_LLM } from './modelRuntimeConfig'
import type {
  AcceptPathOptions,
  ForbidPatternEntry,
  HarnessContext,
  MotionPlan,
  WorkingSetState,
} from './harnessTypes'
import { DEFAULT_ACCEPT_OPTIONS, emptyWorkingSet } from './harnessTypes'
import {
  acceptPathInContext,
  buildHarnessContext,
  registerInferPaths,
  rejectPathInContext,
} from './harnessContext'
import {
  loadHarnessPersisted,
  saveHarnessPersisted,
} from './harnessPersistence'
import {
  buildPendingGatewayPlans,
  type PendingGatewayPlan,
} from './harnessGateway'
import type { BookIndex } from './pipelineA'

const STORAGE_PREFIX = 'docuverse.fanout.v1:'
const DEFERRED_PREFIX = 'docuverse.fanout.deferred.v1:'
const INFERRED_PREFIX = 'docuverse.fanout.inferred.v1:'

export type FanoutPhase =
  | 'idle'
  | 'retrieving'
  | 'composing'
  | 'review'
  | 'inferring'
  | 'done'
  | 'error'

/** Disk payload — accepted paths only */
interface FanoutAcceptedPersisted {
  actionLog: ActionRecord[]
  paths: FanoutPath[]
  lastQuestion: string
}

function storageKey(corpus: string): string {
  return `${STORAGE_PREFIX}${corpus || 'default'}`
}

function deferredKey(corpus: string): string {
  return `${DEFERRED_PREFIX}${corpus || 'default'}`
}

function emptyAccepted(): FanoutAcceptedPersisted {
  return { actionLog: [], paths: [], lastQuestion: '' }
}

function newActionId(kind: string): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function loadAccepted(corpus: string): FanoutAcceptedPersisted {
  try {
    const raw = localStorage.getItem(storageKey(corpus))
    if (!raw) return emptyAccepted()
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return emptyAccepted()
    const o = data as Record<string, unknown>
    const paths = Array.isArray(o.paths) ? (o.paths as FanoutPath[]) : []
    const acceptedPaths = paths.filter((p) => p.direction?.accepted === true)
    const idSet = new Set(acceptedPaths.flatMap((p) => p.actionIds))
    const actionLog = (
      Array.isArray(o.actionLog) ? (o.actionLog as ActionRecord[]) : []
    ).filter((a) => idSet.has(a.actionId))
    return {
      paths: acceptedPaths,
      actionLog,
      lastQuestion:
        typeof o.lastQuestion === 'string' ? o.lastQuestion : '',
    }
  } catch {
    return emptyAccepted()
  }
}

function saveAccepted(corpus: string, state: FanoutAcceptedPersisted): void {
  try {
    const paths = state.paths.filter((p) => p.direction.accepted === true)
    const idSet = new Set(paths.flatMap((p) => p.actionIds))
    const payload: FanoutAcceptedPersisted = {
      paths,
      actionLog: state.actionLog.filter((a) => idSet.has(a.actionId)),
      lastQuestion: state.lastQuestion,
    }
    localStorage.setItem(storageKey(corpus), JSON.stringify(payload))
  } catch {
    /* ignore quota */
  }
}

function loadDeferred(corpus: string): DeferredUnitArchive[] {
  try {
    const raw = localStorage.getItem(deferredKey(corpus))
    if (!raw) return []
    const data: unknown = JSON.parse(raw)
    return Array.isArray(data) ? (data as DeferredUnitArchive[]) : []
  } catch {
    return []
  }
}

function saveDeferred(corpus: string, list: DeferredUnitArchive[]): void {
  try {
    localStorage.setItem(deferredKey(corpus), JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

function inferredKey(corpus: string): string {
  return `${INFERRED_PREFIX}${corpus || 'default'}`
}

function loadInferred(corpus: string): FanoutPath[] {
  try {
    const raw = localStorage.getItem(inferredKey(corpus))
    if (!raw) return []
    const data: unknown = JSON.parse(raw)
    return Array.isArray(data) ? (data as FanoutPath[]) : []
  } catch {
    return []
  }
}

function saveInferred(corpus: string, paths: FanoutPath[]): void {
  try {
    // Cap cache size
    const trimmed = paths
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 80)
    localStorage.setItem(inferredKey(corpus), JSON.stringify(trimmed))
  } catch {
    /* ignore */
  }
}

function actionsForPaths(
  paths: FanoutPath[],
  pool: ActionRecord[],
): ActionRecord[] {
  const idSet = new Set(paths.flatMap((p) => p.actionIds))
  const byId = new Map(pool.map((a) => [a.actionId, a]))
  const out: ActionRecord[] = []
  for (const id of idSet) {
    const a = byId.get(id)
    if (a) out.push(a)
  }
  return out
}

function persistHarnessSlice(state: {
  corpus: string
  forbidPatterns: ForbidPatternEntry[]
  archiveOnlyPathIds: Set<string>
  workingSet: WorkingSetState
}): void {
  saveHarnessPersisted(state.corpus, {
    forbidPatterns: state.forbidPatterns,
    archiveOnlyPathIds: state.archiveOnlyPathIds,
    workingSet: state.workingSet,
  })
}

function rebuildHarnessFromState(input: {
  corpus: string
  paths: FanoutPath[]
  acceptedPaths: FanoutPath[]
  actionLog: ActionRecord[]
  acceptedActionLog: ActionRecord[]
  lastQuestion: string
  deferredArchive: DeferredUnitArchive[]
  workingSet: WorkingSetState
  forbidPatterns: ForbidPatternEntry[]
  archiveOnlyPathIds: Set<string>
  lastMotionPlans: MotionPlan[]
}): HarnessContext {
  const ctx = buildHarnessContext({
    docId: input.corpus,
    sessionPaths: input.paths,
    acceptedPaths: input.acceptedPaths,
    actionLog: input.actionLog,
    acceptedActionLog: input.acceptedActionLog,
    question: input.lastQuestion || input.acceptedPaths[0]?.question || '',
    deferredUnits: input.deferredArchive,
    workingSet: input.workingSet,
    forbidPatterns: input.forbidPatterns,
    archiveOnlyPathIds: input.archiveOnlyPathIds,
  })
  return {
    ...ctx,
    working: {
      ...ctx.working,
      lastMotionPlans: input.lastMotionPlans,
    },
  }
}

interface FanoutState {
  corpus: string
  phase: FanoutPhase
  progress: string
  error: string | null
  actionLog: ActionRecord[]
  paths: FanoutPath[]
  lastQuestion: string
  draftReport: FanoutDraftReport | null
  letterDesk: LetterDeskSnapshot | null
  letterSession: LetterDeskSession | null
  deferredArchive: DeferredUnitArchive[]
  inferredPaths: FanoutPath[]
  currentObject: CurrentObject
  reasonModelId: string
  letterStrategy: LetterRunStrategy
  expandBudget: number
  activePathId: string | null
  selectedSlotKey: string | null
  focusedActionId: string | null
  focusedIdentityId: string | null
  acceptedPaths: FanoutPath[]
  acceptedActionLog: ActionRecord[]
  acceptedQuestion: string
  /** Harness working set + memory partitions */
  harnessContext: HarnessContext | null
  workingSet: WorkingSetState
  forbidPatterns: ForbidPatternEntry[]
  archiveOnlyPathIds: Set<string>
  lastMotionPlans: MotionPlan[]
  pendingGatewayPlans: PendingGatewayPlan[]
  approvedPlanIds: Set<string>
  setCorpus: (corpus: string) => void
  setPhase: (phase: FanoutPhase, progress?: string) => void
  setError: (msg: string | null) => void
  appendActions: (actions: ActionRecord[]) => void
  setLetterStrategy: (s: LetterRunStrategy) => void
  setExpandBudget: (n: number) => void
  setCurrentObject: (obj: CurrentObject) => void
  lockObjectFromDraft: (keys: string[], pages: number[], lockedBy: 'auto' | 'user') => void
  setLetterPrepare: (input: {
    session: LetterDeskSession
    actions: ActionRecord[]
  }) => void
  replaceLetterSession: (session: LetterDeskSession, extraAction?: ActionRecord) => void
  updateLetterDecision: (index: number, decision: LetterUnitDecision) => void
  reproposeLetter: () => void
  clearLetterDesk: () => void
  returnToLetterDesk: (error: string) => void
  setRunResult: (input: {
    question: string
    paths: FanoutPath[]
    actions: ActionRecord[]
    draftReport?: FanoutDraftReport | null
    letterDesk?: LetterDeskSnapshot | null
    deferredArchive?: DeferredUnitArchive[]
    workingSet?: WorkingSetState
  }) => void
  setActivePathId: (id: string | null) => void
  setSelectedSlotKey: (key: string | null) => void
  focusIdentity: (input: {
    identityId: string
    kind: IdentityKind
    slotKey?: string | null
    actionId?: string | null
    pathId?: string | null
  }) => void
  setPathAccepted: (pathId: string, accepted: boolean) => void
  acceptPathWithOptions: (
    pathId: string,
    options?: AcceptPathOptions,
  ) => void
  rejectPath: (pathId: string) => void
  setMotionPlans: (plans: MotionPlan[]) => void
  refreshPendingGateway: (bookIndex: BookIndex) => void
  approveGatewayPlan: (planId: string) => void
  rejectGatewayPlan: (planId: string) => void
  getHarnessExecBundle: (bookIndex: BookIndex) => {
    ctx: HarnessContext
    motionPlans: MotionPlan[]
    approvedPlanIds: Set<string>
    pendingGateway: PendingGatewayPlan[]
    workingSet: WorkingSetState
    forbidPatterns: ForbidPatternEntry[]
    archiveOnlyPathIds: Set<string>
  }
  getHarnessContext: () => HarnessContext
  removeDeferred: (id: string) => void
  clearRun: () => void
}

export const useFanout = create<FanoutState>((set, get) => ({
  corpus: 'default',
  phase: 'idle',
  progress: '',
  error: null,
  actionLog: [],
  paths: [],
  lastQuestion: '',
  draftReport: null,
  letterDesk: null,
  letterSession: null,
  deferredArchive: [],
  inferredPaths: [],
  currentObject: emptyCurrentObject(),
  reasonModelId: LOCKED_LLM.chatModel,
  letterStrategy: 'force_expand',
  expandBudget: 3,
  activePathId: null,
  selectedSlotKey: null,
  focusedActionId: null,
  focusedIdentityId: null,
  acceptedPaths: [],
  acceptedActionLog: [],
  acceptedQuestion: '',
  harnessContext: null,
  workingSet: emptyWorkingSet(),
  forbidPatterns: [],
  archiveOnlyPathIds: new Set<string>(),
  lastMotionPlans: [],
  pendingGatewayPlans: [],
  approvedPlanIds: new Set<string>(),

  setCorpus: (corpus) => {
    const accepted = loadAccepted(corpus)
    const harnessPersist = loadHarnessPersisted(corpus)
    const workingSet = harnessPersist.workingSet
    const forbidPatterns = harnessPersist.forbidPatterns
    const archiveOnlyPathIds = harnessPersist.archiveOnlyPathIds
    const harnessContext = rebuildHarnessFromState({
      corpus,
      paths: [],
      acceptedPaths: accepted.paths,
      actionLog: [],
      acceptedActionLog: accepted.actionLog,
      lastQuestion: '',
      deferredArchive: loadDeferred(corpus),
      workingSet,
      forbidPatterns,
      archiveOnlyPathIds,
      lastMotionPlans: [],
    })
    set({
      corpus,
      acceptedPaths: accepted.paths,
      acceptedActionLog: accepted.actionLog,
      acceptedQuestion: accepted.lastQuestion,
      deferredArchive: loadDeferred(corpus),
      inferredPaths: loadInferred(corpus),
      currentObject: emptyCurrentObject(corpus),
      reasonModelId: LOCKED_LLM.chatModel,
      paths: [],
      actionLog: [],
      lastQuestion: '',
      draftReport: null,
      letterDesk: null,
      letterSession: null,
      activePathId: accepted.paths[0]?.pathId ?? null,
      selectedSlotKey: null,
      focusedActionId: null,
      focusedIdentityId: null,
      phase: 'idle',
      progress: '',
      error: null,
      workingSet,
      forbidPatterns,
      archiveOnlyPathIds,
      lastMotionPlans: [],
      pendingGatewayPlans: [],
      approvedPlanIds: new Set<string>(),
      harnessContext,
    })
  },

  setPhase: (phase, progress = '') => set({ phase, progress }),

  setError: (msg) =>
    set({ error: msg, phase: msg ? 'error' : get().phase }),

  appendActions: (actions) => {
    set({ actionLog: [...get().actionLog, ...actions] })
  },

  setLetterStrategy: (s) => set({ letterStrategy: s }),

  setExpandBudget: (n) => set({ expandBudget: Math.max(0, n) }),

  setCurrentObject: (obj) => set({ currentObject: obj }),

  lockObjectFromDraft: (keys, pages, lockedBy) => {
    set({
      currentObject: lockSlotsObject({
        docId: get().corpus,
        slotKeys: keys,
        pages,
        lockedBy,
      }),
    })
  },

  setLetterPrepare: ({ session, actions }) => {
    const draft = session.draftReport
    if (draft.autoLockOk && draft.candidates[0] && get().currentObject.lockedBy === 'none') {
      const top = draft.candidates[0]
      set({
        currentObject: lockSlotsObject({
          docId: get().corpus,
          slotKeys: [top.key],
          pages: [top.page],
          lockedBy: 'auto',
        }),
      })
    }
    set({
      letterSession: {
        ...session,
        inferredPaths: get().inferredPaths,
        modelId: get().reasonModelId,
        acceptedPaths: get().acceptedPaths,
      },
      letterDesk: session.snapshot,
      draftReport: session.draftReport,
      lastQuestion: session.question,
      actionLog: [...get().actionLog, ...actions],
      phase: 'review',
      progress: `写信台审查 · ${session.snapshot.comboCount} 种组合`,
      error: null,
      paths: [],
    })
  },

  replaceLetterSession: (session, extraAction) => {
    set({
      letterSession: session,
      letterDesk: session.snapshot,
      actionLog: extraAction
        ? [...get().actionLog, extraAction]
        : get().actionLog,
      phase: 'review',
      progress: `写信台 · 已按对象重组合 · ${session.snapshot.comboCount} 种`,
      error: null,
    })
  },

  updateLetterDecision: (index, decision) => {
    const session = get().letterSession
    if (!session) return
    const next = setLetterUnitDecision(session, index, decision)
    set({
      letterSession: next,
      letterDesk: next.snapshot,
    })
  },

  reproposeLetter: () => {
    const session = get().letterSession
    if (!session) return
    const next = reproposeLetterDesk(session, {
      strategy: get().letterStrategy,
      expandBudget: get().expandBudget,
      allowReuse: true,
    })
    set({
      letterSession: next,
      letterDesk: next.snapshot,
    })
  },

  clearLetterDesk: () =>
    set({
      letterDesk: null,
      letterSession: null,
      phase: get().paths.length > 0 ? 'done' : 'idle',
      progress: '',
    }),

  returnToLetterDesk: (error) => {
    const session = get().letterSession
    set({
      error,
      phase: session ? 'review' : 'error',
      progress: session ? '已回写信台，请改决策后重试' : '',
      letterDesk: session
        ? { ...session.snapshot, status: 'review' }
        : get().letterDesk,
    })
  },

  setRunResult: ({
    question,
    paths,
    actions,
    draftReport,
    letterDesk,
    deferredArchive,
    workingSet: wsPatch,
  }) => {
    const firstSlot = paths[0]?.slots?.[0]?.key ?? null
    const mergedDeferred = [
      ...(deferredArchive ?? []),
      ...get().deferredArchive,
    ]
    const seenDef = new Set<string>()
    const deferredUnique = mergedDeferred.filter((d) => {
      const k = `${d.question}\0${d.memberKeys.slice().sort().join('\0')}`
      if (seenDef.has(k)) return false
      seenDef.add(k)
      return true
    })
    saveDeferred(get().corpus, deferredUnique)

    // Merge inferred cache (session paths become reusable without accept)
    const byId = new Map(get().inferredPaths.map((p) => [p.pathId, p]))
    for (const p of paths) {
      byId.set(p.pathId, {
        ...p,
        direction: {
          ...p.direction,
          cacheTier: p.direction.accepted ? 'accepted' : 'inferred',
        },
      })
    }
    const inferredPaths = [...byId.values()]
    saveInferred(get().corpus, inferredPaths)

    const prev = get()
    const baseCtx = rebuildHarnessFromState({
      corpus: prev.corpus,
      paths: prev.paths,
      acceptedPaths: prev.acceptedPaths,
      actionLog: prev.actionLog,
      acceptedActionLog: prev.acceptedActionLog,
      lastQuestion: question,
      deferredArchive: deferredUnique,
      workingSet: prev.workingSet,
      forbidPatterns: prev.forbidPatterns,
      archiveOnlyPathIds: prev.archiveOnlyPathIds,
      lastMotionPlans: prev.lastMotionPlans,
    })
    const harnessContext = registerInferPaths(baseCtx, paths)
    const workingSet = wsPatch ?? harnessContext.working.workingSet

    set({
      lastQuestion: question,
      paths,
      actionLog: [...get().actionLog, ...actions],
      activePathId: paths[0]?.pathId ?? null,
      selectedSlotKey: firstSlot,
      focusedActionId: null,
      focusedIdentityId: firstSlot ? `slot:${firstSlot}` : null,
      draftReport: draftReport ?? null,
      letterDesk: letterDesk ?? null,
      letterSession: null,
      deferredArchive: deferredUnique,
      inferredPaths,
      workingSet,
      harnessContext,
      phase: 'done',
      progress: '',
      error: null,
    })
    persistHarnessSlice({
      corpus: get().corpus,
      forbidPatterns: get().forbidPatterns,
      archiveOnlyPathIds: get().archiveOnlyPathIds,
      workingSet,
    })
  },

  setActivePathId: (id) => {
    const path =
      get().paths.find((p) => p.pathId === id) ??
      get().acceptedPaths.find((p) => p.pathId === id)
    const slot = path?.slots?.[0]?.key ?? null
    set({
      activePathId: id,
      selectedSlotKey: slot,
      focusedIdentityId: slot ? `slot:${slot}` : null,
    })
  },

  setSelectedSlotKey: (key) =>
    set({
      selectedSlotKey: key,
      focusedIdentityId: key ? `slot:${key}` : null,
    }),

  focusIdentity: ({ identityId, slotKey, actionId, pathId }) => {
    set({
      focusedIdentityId: identityId,
      focusedActionId: actionId ?? null,
      ...(pathId ? { activePathId: pathId } : {}),
      ...(slotKey !== undefined ? { selectedSlotKey: slotKey } : {}),
    })
  },

  getHarnessContext: () => {
    const s = get()
    return rebuildHarnessFromState({
      corpus: s.corpus,
      paths: s.paths,
      acceptedPaths: s.acceptedPaths,
      actionLog: s.actionLog,
      acceptedActionLog: s.acceptedActionLog,
      lastQuestion: s.lastQuestion,
      deferredArchive: s.deferredArchive,
      workingSet: s.workingSet,
      forbidPatterns: s.forbidPatterns,
      archiveOnlyPathIds: s.archiveOnlyPathIds,
      lastMotionPlans: s.lastMotionPlans,
    })
  },

  setMotionPlans: (plans) => {
    const ctx = get().getHarnessContext()
    set({
      lastMotionPlans: plans,
      harnessContext: {
        ...ctx,
        working: { ...ctx.working, lastMotionPlans: plans },
      },
    })
  },

  refreshPendingGateway: (bookIndex) => {
    const s = get()
    const ctx = s.getHarnessContext()
    const pending = buildPendingGatewayPlans(
      s.lastMotionPlans,
      ctx,
      bookIndex,
      s.approvedPlanIds,
    )
    set({ pendingGatewayPlans: pending })
  },

  approveGatewayPlan: (planId) => {
    const approved = new Set(get().approvedPlanIds)
    approved.add(planId)
    const pending = get().pendingGatewayPlans.map((p) =>
      p.planId === planId ? { ...p, status: 'approved' as const } : p,
    )
    set({ approvedPlanIds: approved, pendingGatewayPlans: pending })
  },

  rejectGatewayPlan: (planId) => {
    const approved = new Set(get().approvedPlanIds)
    approved.delete(planId)
    const pending = get().pendingGatewayPlans.map((p) =>
      p.planId === planId ? { ...p, status: 'rejected' as const } : p,
    )
    set({ approvedPlanIds: approved, pendingGatewayPlans: pending })
  },

  getHarnessExecBundle: (bookIndex) => {
    const s = get()
    const ctx = s.getHarnessContext()
    const pending =
      s.pendingGatewayPlans.length > 0
        ? s.pendingGatewayPlans
        : buildPendingGatewayPlans(
            s.lastMotionPlans,
            ctx,
            bookIndex,
            s.approvedPlanIds,
          )
    return {
      ctx,
      motionPlans: s.lastMotionPlans,
      approvedPlanIds: s.approvedPlanIds,
      pendingGateway: pending,
      workingSet: s.workingSet,
      forbidPatterns: s.forbidPatterns,
      archiveOnlyPathIds: s.archiveOnlyPathIds,
    }
  },

  acceptPathWithOptions: (pathId, options = DEFAULT_ACCEPT_OPTIONS) => {
    const s = get()
    let ctx = s.getHarnessContext()
    ctx = acceptPathInContext(ctx, pathId, options)

    const hit =
      s.paths.find((p) => p.pathId === pathId) ??
      s.acceptedPaths.find((p) => p.pathId === pathId)
    if (!hit) return

    const entry =
      ctx.historical.settledPaths.find((e) => e.pathId === pathId) ??
      ctx.working.currentMemory.find((e) => e.pathId === pathId) ??
      ctx.historical.archivePaths.find((e) => e.pathId === pathId)
    const stamped = entry?.path ?? hit

    const premiseKeys =
      stamped.direction.premiseKeys?.length
        ? stamped.direction.premiseKeys
        : (stamped.slots?.map((sl) => sl.key) ?? [])

    const acceptAction: ActionRecord = {
      actionId: newActionId('accept'),
      actionKind: 'accept',
      premiseKeys,
      inputsRef: {
        question: stamped.question,
        role: 'accept',
        pathId: stamped.pathId,
      },
      outputsRef: {
        assetId: stamped.direction.directionId,
        conclusion: stamped.direction.conclusion,
        path: stamped.direction.path,
        pathMarker: stamped.direction.pathMarker,
        roleNote: options.pinToCurrent
          ? `${FANOUT_ROLE_NOTE.accept} · 定在当前`
          : `${FANOUT_ROLE_NOTE.accept} · 只进永久库`,
      },
      createdAt: Date.now(),
    }

    const nextIds = [
      ...(stamped.direction.actionIds ?? stamped.actionIds ?? []),
      acceptAction.actionId,
    ]
    const finalPath: FanoutPath = {
      ...stamped,
      actionIds: nextIds,
      direction: {
        ...stamped.direction,
        actionIds: nextIds,
        accepted: true,
        cacheTier: 'accepted',
      },
    }

    let acceptedPaths = s.acceptedPaths.filter((p) => p.pathId !== pathId)
    acceptedPaths = [...acceptedPaths, finalPath]

    let archiveOnlyPathIds = new Set(s.archiveOnlyPathIds)
    if (!options.pinToCurrent) {
      archiveOnlyPathIds.add(pathId)
    } else {
      archiveOnlyPathIds.delete(pathId)
    }

    const pool = [
      ...s.acceptedActionLog,
      ...s.actionLog,
      acceptAction,
    ]
    const seen = new Set<string>()
    const deduped = pool.filter((a) => {
      if (seen.has(a.actionId)) return false
      seen.add(a.actionId)
      return true
    })

    const acceptedActionLog = actionsForPaths(acceptedPaths, deduped)
    const acceptedQuestion =
      acceptedPaths[0]?.question || s.acceptedQuestion || s.lastQuestion
    const sessionPaths = s.paths.filter((p) => p.pathId !== pathId)
    const workingSet = ctx.working.workingSet
    const forbidPatterns = ctx.historical.forbidPatterns

    set({
      paths: sessionPaths,
      actionLog: [...s.actionLog, acceptAction],
      acceptedPaths,
      acceptedActionLog,
      acceptedQuestion,
      workingSet,
      forbidPatterns,
      archiveOnlyPathIds,
      harnessContext: ctx,
      activePathId: sessionPaths[0]?.pathId ?? acceptedPaths[0]?.pathId ?? null,
      focusedIdentityId: `asset:${finalPath.direction.directionId}`,
      focusedActionId: acceptAction.actionId,
    })

    saveAccepted(s.corpus, {
      paths: acceptedPaths,
      actionLog: acceptedActionLog,
      lastQuestion: acceptedQuestion,
    })
    persistHarnessSlice({
      corpus: s.corpus,
      forbidPatterns,
      archiveOnlyPathIds,
      workingSet,
    })
  },

  rejectPath: (pathId) => {
    const s = get()
    let ctx = s.getHarnessContext()
    const { ctx: nextCtx, newlyForbidden } = rejectPathInContext(ctx, pathId)
    ctx = nextCtx

    const sessionPaths = s.paths.filter((p) => p.pathId !== pathId)
    const workingSet = ctx.working.workingSet
    const forbidPatterns = ctx.historical.forbidPatterns

    set({
      paths: sessionPaths,
      workingSet,
      forbidPatterns,
      harnessContext: ctx,
      activePathId:
        sessionPaths[0]?.pathId ??
        (s.activePathId === pathId ? null : s.activePathId),
      error: newlyForbidden
        ? '该组合已重复拒绝≥3次，运动脑将自动 forbid'
        : s.error,
    })
    persistHarnessSlice({
      corpus: s.corpus,
      forbidPatterns,
      archiveOnlyPathIds: s.archiveOnlyPathIds,
      workingSet,
    })
  },

  setPathAccepted: (pathId, accepted) => {
    if (accepted === true) {
      get().acceptPathWithOptions(pathId, DEFAULT_ACCEPT_OPTIONS)
      return
    }
    get().rejectPath(pathId)
  },

  removeDeferred: (id) => {
    const deferredArchive = get().deferredArchive.filter((d) => d.id !== id)
    saveDeferred(get().corpus, deferredArchive)
    set({ deferredArchive })
  },

  clearRun: () => {
    const { acceptedPaths } = get()
    const slot = acceptedPaths[0]?.slots?.[0]?.key ?? null
    set({
      paths: [],
      actionLog: [],
      lastQuestion: '',
      draftReport: null,
      letterDesk: null,
      letterSession: null,
      activePathId: acceptedPaths[0]?.pathId ?? null,
      selectedSlotKey: slot,
      focusedActionId: null,
      focusedIdentityId: slot ? `slot:${slot}` : null,
      phase: 'idle',
      progress: '',
      error: null,
    })
  },
}))
