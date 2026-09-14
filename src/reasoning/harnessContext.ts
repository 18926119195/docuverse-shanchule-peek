/**
 * Build and mutate HarnessContext from fanout store slices.
 * Formal ops theater retired — PathMemoryEntry.formalOps stays empty.
 */

import type { ActionRecord, FanoutPath } from './types'
import type { DeferredUnitArchive } from './letterDesk'
import type {
  AcceptPathOptions,
  HarnessContext,
  HistoricalLedger,
  PathMemoryEntry,
  WorkingContext,
} from './harnessTypes'
import {
  DEFAULT_ACCEPT_OPTIONS,
  emptyWorkingSet,
} from './harnessTypes'
import { syncWorkingSetFromPaths } from './workingSet'
import { recordReject } from './forbidPatterns'

/** @deprecated formal ops retired; always returns [] */
export function extractFormalOps(_path: FanoutPath): never[] {
  return []
}

export function referencedPathIdsOf(path: FanoutPath): string[] {
  const ids: string[] = []
  if (path.reusedFromPathId) ids.push(path.reusedFromPathId)
  const ext = path.direction as { referencedPathIds?: string[] }
  if (ext.referencedPathIds?.length) ids.push(...ext.referencedPathIds)
  return [...new Set(ids.filter(Boolean))]
}

export function pathToMemoryEntry(
  path: FanoutPath,
  settlement: PathMemoryEntry['settlement'],
  memoryTier: PathMemoryEntry['memoryTier'],
): PathMemoryEntry {
  return {
    pathId: path.pathId,
    path,
    settlement,
    memoryTier,
    acceptedAt: settlement === 'settled' ? Date.now() : null,
    formalOps: [],
    referencedPathIds: referencedPathIdsOf(path),
  }
}

function markKeysCollapsed(
  ws: ReturnType<typeof emptyWorkingSet>,
  keys: string[],
): ReturnType<typeof emptyWorkingSet> {
  const collapsed = new Set(ws.collapsed)
  for (const k of keys) if (k) collapsed.add(k)
  return { ...ws, collapsed }
}

export function buildHarnessContext(input: {
  docId: string
  taskId?: string
  sessionPaths: FanoutPath[]
  acceptedPaths: FanoutPath[]
  actionLog: ActionRecord[]
  acceptedActionLog: ActionRecord[]
  question: string
  draftKeys?: string[]
  deferredUnits?: DeferredUnitArchive[]
  workingSet?: ReturnType<typeof emptyWorkingSet>
  forbidPatterns?: HistoricalLedger['forbidPatterns']
  archiveOnlyPathIds?: ReadonlySet<string>
}): HarnessContext {
  const taskId = input.taskId ?? `task_${input.docId}`
  const pendingPaths = input.sessionPaths
    .filter((p) => p.direction.accepted !== true)
    .map((p) => pathToMemoryEntry(p, 'pending', null))

  const archiveOnlyIds = input.archiveOnlyPathIds ?? new Set<string>()

  const settledEntries: PathMemoryEntry[] = []
  const currentMemory: PathMemoryEntry[] = []
  const archivePaths: PathMemoryEntry[] = []

  for (const p of input.acceptedPaths) {
    const tier = archiveOnlyIds.has(p.pathId) ? 'archive' : 'current'
    const entry = pathToMemoryEntry(p, 'settled', tier)
    settledEntries.push(entry)
    if (tier === 'current') currentMemory.push(entry)
    else archivePaths.push(entry)
  }

  let workingSet = input.workingSet ?? emptyWorkingSet()
  for (const e of currentMemory) {
    const keys =
      e.path.direction.premiseKeys ?? e.path.slots.map((s) => s.key)
    workingSet = markKeysCollapsed(workingSet, keys)
  }

  return {
    docId: input.docId,
    taskId,
    updatedAt: Date.now(),
    historical: {
      settledPaths: settledEntries,
      actionLog: [...input.acceptedActionLog],
      archivePaths,
      forbidPatterns: input.forbidPatterns ?? [],
    },
    working: {
      taskId,
      question: input.question,
      pendingPaths,
      currentMemory,
      workingSet,
      deferredUnits: input.deferredUnits ?? [],
      draftKeys: input.draftKeys ?? [],
      lastMotionPlans: [],
      approvedPlanIds: [],
    },
  }
}

export function acceptPathInContext(
  ctx: HarnessContext,
  pathId: string,
  options: AcceptPathOptions = DEFAULT_ACCEPT_OPTIONS,
): HarnessContext {
  const pendingIdx = ctx.working.pendingPaths.findIndex((e) => e.pathId === pathId)
  let entry: PathMemoryEntry | undefined
  let pendingPaths = [...ctx.working.pendingPaths]

  if (pendingIdx >= 0) {
    entry = pendingPaths[pendingIdx]
    pendingPaths = pendingPaths.filter((_, i) => i !== pendingIdx)
  } else {
    entry = ctx.historical.settledPaths.find((e) => e.pathId === pathId)
  }
  if (!entry) return ctx

  const tier = options.pinToCurrent ? 'current' : 'archive'
  const settled: PathMemoryEntry = {
    ...entry,
    settlement: 'settled',
    memoryTier: tier,
    acceptedAt: Date.now(),
    path: {
      ...entry.path,
      direction: { ...entry.path.direction, accepted: true, cacheTier: 'accepted' },
    },
  }

  let currentMemory = ctx.working.currentMemory.filter((e) => e.pathId !== pathId)
  let archivePaths = ctx.historical.archivePaths.filter((e) => e.pathId !== pathId)
  let settledPaths = ctx.historical.settledPaths.filter((e) => e.pathId !== pathId)

  if (tier === 'current') currentMemory = [...currentMemory, settled]
  else archivePaths = [...archivePaths, settled]
  settledPaths = [...settledPaths, settled]

  if (options.lineageClosure) {
    for (const refId of settled.referencedPathIds) {
      const refPending = pendingPaths.find((e) => e.pathId === refId)
      const refExisting =
        settledPaths.find((e) => e.pathId === refId) ??
        currentMemory.find((e) => e.pathId === refId) ??
        archivePaths.find((e) => e.pathId === refId)
      if (refExisting?.settlement === 'settled') continue
      const refPath =
        refPending?.path ??
        ctx.working.currentMemory.find((e) => e.pathId === refId)?.path
      if (!refPath) continue
      const promoted = pathToMemoryEntry(refPath, 'settled', 'archive')
      archivePaths = [...archivePaths.filter((e) => e.pathId !== refId), promoted]
      settledPaths = [...settledPaths.filter((e) => e.pathId !== refId), promoted]
      pendingPaths = pendingPaths.filter((e) => e.pathId !== refId)
    }
  }

  const premiseKeys =
    settled.path.direction.premiseKeys ?? settled.path.slots.map((s) => s.key)
  const workingSet = markKeysCollapsed(ctx.working.workingSet, [...premiseKeys])

  return {
    ...ctx,
    updatedAt: Date.now(),
    historical: {
      ...ctx.historical,
      settledPaths,
      archivePaths,
    },
    working: {
      ...ctx.working,
      pendingPaths,
      currentMemory,
      workingSet,
    },
  }
}

export function rejectPathInContext(
  ctx: HarnessContext,
  pathId: string,
): { ctx: HarnessContext; newlyForbidden: boolean } {
  const pendingIdx = ctx.working.pendingPaths.findIndex((e) => e.pathId === pathId)
  if (pendingIdx < 0) return { ctx, newlyForbidden: false }

  const entry = ctx.working.pendingPaths[pendingIdx]
  const { patterns, newlyForbidden } = recordReject(
    ctx.historical.forbidPatterns,
    entry.path,
  )

  return {
    ctx: {
      ...ctx,
      updatedAt: Date.now(),
      historical: { ...ctx.historical, forbidPatterns: patterns },
      working: {
        ...ctx.working,
        pendingPaths: ctx.working.pendingPaths.filter((e) => e.pathId !== pathId),
      },
    },
    newlyForbidden,
  }
}

export function registerInferPaths(
  ctx: HarnessContext,
  paths: FanoutPath[],
): HarnessContext {
  const pendingPaths = paths.map((p) => pathToMemoryEntry(p, 'pending', null))
  let workingSet = ctx.working.workingSet
  for (const p of paths) {
    const keys = p.direction.premiseKeys ?? p.slots.map((s) => s.key)
    workingSet = syncWorkingSetFromPaths({
      ws: workingSet,
      premiseKeys: keys,
      treatAsExpanded: true,
    })
  }
  return {
    ...ctx,
    updatedAt: Date.now(),
    working: {
      ...ctx.working,
      pendingPaths,
      workingSet,
    },
  }
}

export function archiveOnlyPathIdSet(ctx: HarnessContext): Set<string> {
  return new Set(ctx.historical.archivePaths.map((e) => e.pathId))
}

export function pathsFromContext(ctx: HarnessContext): {
  acceptedPaths: FanoutPath[]
  sessionPaths: FanoutPath[]
} {
  const acceptedPaths = ctx.historical.settledPaths.map((e) => e.path)
  const sessionPaths = ctx.working.pendingPaths.map((e) => e.path)
  return { acceptedPaths, sessionPaths }
}

export function applyWorkingContextPatch(
  base: HarnessContext,
  patch: Partial<WorkingContext>,
): HarnessContext {
  return {
    ...base,
    updatedAt: Date.now(),
    working: { ...base.working, ...patch },
  }
}
