/**
 * Client-side lineage walk (谱系): action / path / slot → parents.
 * Server opaque h1. API can replace this later.
 */

import type { ActionRecord, FanoutPath } from './types'
import { shortHandle } from './ocrSlot'

export interface LineageNode {
  id: string
  kind: 'path' | 'action' | 'slot' | 'asset'
  label: string
  detail: string
}

export function resolveLineage(input: {
  focusId: string
  paths: FanoutPath[]
  actions: ActionRecord[]
}): LineageNode[] {
  const { focusId, paths, actions } = input
  const byAction = new Map(actions.map((a) => [a.actionId, a]))
  const nodes: LineageNode[] = []
  const seen = new Set<string>()

  const push = (n: LineageNode) => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    nodes.push(n)
  }

  const path =
    paths.find((p) => p.pathId === focusId) ??
    paths.find((p) => p.direction.directionId === focusId) ??
    paths.find((p) => `asset:${p.direction.directionId}` === focusId)

  if (path) {
    push({
      id: path.pathId,
      kind: 'path',
      label: path.unitLabel || path.pathId,
      detail: path.direction.conclusion.slice(0, 80),
    })
    if (path.direction.accepted) {
      push({
        id: `asset:${path.direction.directionId}`,
        kind: 'asset',
        label: shortHandle(path.direction.directionId),
        detail: '已采纳资产',
      })
    }
    for (const aid of path.actionIds) {
      const a = byAction.get(aid)
      if (!a) continue
      push({
        id: a.actionId,
        kind: 'action',
        label: `${a.actionKind}`,
        detail: a.outputsRef.roleNote || a.outputsRef.conclusion?.slice(0, 60) || '',
      })
      for (const k of a.premiseKeys) {
        push({
          id: `slot:${k}`,
          kind: 'slot',
          label: shortHandle(k),
          detail: '前提槽',
        })
      }
    }
    if (path.reusedFromPathId) {
      push({
        id: path.reusedFromPathId,
        kind: 'path',
        label: `← 复用自 ${path.reusedFromPathId}`,
        detail: 'reuse 父路径',
      })
    }
    return nodes
  }

  const action = byAction.get(focusId) ?? byAction.get(focusId.replace(/^action:/, ''))
  if (action) {
    push({
      id: action.actionId,
      kind: 'action',
      label: action.actionKind,
      detail: action.outputsRef.roleNote || '',
    })
    for (const k of action.premiseKeys) {
      push({
        id: `slot:${k}`,
        kind: 'slot',
        label: shortHandle(k),
        detail: 'premise',
      })
    }
    return nodes
  }

  if (focusId.startsWith('slot:') || focusId.includes('|')) {
    const key = focusId.replace(/^slot:/, '')
    push({
      id: `slot:${key}`,
      kind: 'slot',
      label: shortHandle(key),
      detail: '槽门牌',
    })
    for (const p of paths) {
      if (p.direction.premiseKeys?.includes(key) || p.slots.some((s) => s.key === key)) {
        push({
          id: p.pathId,
          kind: 'path',
          label: p.unitLabel,
          detail: p.direction.conclusion.slice(0, 60),
        })
      }
    }
  }

  return nodes
}
