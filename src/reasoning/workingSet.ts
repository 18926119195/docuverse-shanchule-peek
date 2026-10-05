/**
 * Working set: expanded / collapsed / pinned / closed key* states.
 */

import type { WorkingSetState } from './harnessTypes'
import { emptyWorkingSet } from './harnessTypes'

export function markExpanded(ws: WorkingSetState, keys: Iterable<string>): WorkingSetState {
  const expanded = new Set(ws.expanded)
  const collapsed = new Set(ws.collapsed)
  for (const k of keys) {
    if (!k) continue
    expanded.add(k)
    collapsed.delete(k)
  }
  return { ...ws, expanded, collapsed }
}

export function markCollapsed(ws: WorkingSetState, keys: Iterable<string>): WorkingSetState {
  const expanded = new Set(ws.expanded)
  const collapsed = new Set(ws.collapsed)
  for (const k of keys) {
    if (!k) continue
    expanded.delete(k)
    collapsed.add(k)
  }
  return { ...ws, expanded, collapsed }
}

export function markPinned(ws: WorkingSetState, keys: Iterable<string>): WorkingSetState {
  const pinned = new Set(ws.pinned)
  for (const k of keys) {
    if (k) pinned.add(k)
  }
  return { ...ws, pinned }
}

export function keysNeedingOpen(
  memberKeys: ReadonlyArray<string>,
  ws: WorkingSetState,
): string[] {
  return memberKeys.filter(
    (k) => k && !ws.expanded.has(k) && !ws.closed.has(k),
  )
}

export function syncWorkingSetFromPaths(input: {
  ws: WorkingSetState
  premiseKeys: ReadonlyArray<string>
  treatAsExpanded: boolean
}): WorkingSetState {
  if (input.treatAsExpanded) {
    return markExpanded(input.ws, input.premiseKeys)
  }
  return markCollapsed(input.ws, input.premiseKeys)
}

export function applyFaultIn(ws: WorkingSetState, keys: ReadonlyArray<string>): WorkingSetState {
  return markExpanded(ws, keys)
}

export function applyCollapse(ws: WorkingSetState, keys: ReadonlyArray<string>): WorkingSetState {
  return markCollapsed(ws, keys)
}

export { emptyWorkingSet }
