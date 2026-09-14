/**
 * Persist harness slices: forbidPatterns, archiveOnlyPathIds, workingSet.
 */

import type { ForbidPatternEntry, WorkingSetState } from './harnessTypes'
import { emptyWorkingSet } from './harnessTypes'

const HARNESS_PREFIX = 'docuverse.harness.v1:'

export interface HarnessPersisted {
  forbidPatterns: ForbidPatternEntry[]
  archiveOnlyPathIds: string[]
  workingSet: {
    expanded: string[]
    collapsed: string[]
    pinned: string[]
    closed: string[]
  }
}

function storageKey(corpus: string): string {
  return `${HARNESS_PREFIX}${corpus || 'default'}`
}

function emptyPersisted(): HarnessPersisted {
  const ws = emptyWorkingSet()
  return {
    forbidPatterns: [],
    archiveOnlyPathIds: [],
    workingSet: {
      expanded: [...ws.expanded],
      collapsed: [...ws.collapsed],
      pinned: [...ws.pinned],
      closed: [...ws.closed],
    },
  }
}

function isForbidEntry(v: unknown): v is ForbidPatternEntry {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.fingerprint === 'string' &&
    typeof o.memberKeysSignature === 'string' &&
    typeof o.rejectCount === 'number'
  )
}

function workingSetFromPersisted(
  raw: HarnessPersisted['workingSet'] | undefined,
): WorkingSetState {
  if (!raw) return emptyWorkingSet()
  return {
    expanded: new Set(
      Array.isArray(raw.expanded)
        ? raw.expanded.filter((k): k is string => typeof k === 'string')
        : [],
    ),
    collapsed: new Set(
      Array.isArray(raw.collapsed)
        ? raw.collapsed.filter((k): k is string => typeof k === 'string')
        : [],
    ),
    pinned: new Set(
      Array.isArray(raw.pinned)
        ? raw.pinned.filter((k): k is string => typeof k === 'string')
        : [],
    ),
    closed: new Set(
      Array.isArray(raw.closed)
        ? raw.closed.filter((k): k is string => typeof k === 'string')
        : [],
    ),
  }
}

export function loadHarnessPersisted(corpus: string): {
  forbidPatterns: ForbidPatternEntry[]
  archiveOnlyPathIds: Set<string>
  workingSet: WorkingSetState
} {
  try {
    const raw = localStorage.getItem(storageKey(corpus))
    if (!raw) {
      const empty = emptyPersisted()
      return {
        forbidPatterns: empty.forbidPatterns,
        archiveOnlyPathIds: new Set(empty.archiveOnlyPathIds),
        workingSet: workingSetFromPersisted(empty.workingSet),
      }
    }
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) {
      const empty = emptyPersisted()
      return {
        forbidPatterns: empty.forbidPatterns,
        archiveOnlyPathIds: new Set(empty.archiveOnlyPathIds),
        workingSet: workingSetFromPersisted(empty.workingSet),
      }
    }
    const o = data as Record<string, unknown>
    const forbidPatterns = Array.isArray(o.forbidPatterns)
      ? o.forbidPatterns.filter(isForbidEntry)
      : []
    const archiveOnlyPathIds = Array.isArray(o.archiveOnlyPathIds)
      ? o.archiveOnlyPathIds.filter((id): id is string => typeof id === 'string')
      : []
    const wsRaw = o.workingSet as HarnessPersisted['workingSet'] | undefined
    return {
      forbidPatterns,
      archiveOnlyPathIds: new Set(archiveOnlyPathIds),
      workingSet: workingSetFromPersisted(wsRaw),
    }
  } catch {
    const empty = emptyPersisted()
    return {
      forbidPatterns: empty.forbidPatterns,
      archiveOnlyPathIds: new Set(empty.archiveOnlyPathIds),
      workingSet: workingSetFromPersisted(empty.workingSet),
    }
  }
}

export function saveHarnessPersisted(
  corpus: string,
  input: {
    forbidPatterns: ForbidPatternEntry[]
    archiveOnlyPathIds: ReadonlySet<string>
    workingSet: WorkingSetState
  },
): void {
  const payload: HarnessPersisted = {
    forbidPatterns: input.forbidPatterns,
    archiveOnlyPathIds: [...input.archiveOnlyPathIds],
    workingSet: {
      expanded: [...input.workingSet.expanded],
      collapsed: [...input.workingSet.collapsed],
      pinned: [...input.workingSet.pinned],
      closed: [...input.workingSet.closed],
    },
  }
  try {
    localStorage.setItem(storageKey(corpus), JSON.stringify(payload))
  } catch {
    /* ignore quota */
  }
}
