/**
 * Identity control surface: one handle → FE scene + BE ledger projections.
 */

import type { ActionRecord, FanoutPath } from './types'
import { shortHandle } from './ocrSlot'

export type IdentityKind = 'slot' | 'action' | 'asset'

export interface IdentityRow {
  kind: IdentityKind
  /** Stable id for UI selection */
  id: string
  label: string
  detail: string
  /** Literature keys to highlight / swoop */
  slotKeys: string[]
  page?: number
  actionId?: string
  pathId?: string
  assetId?: string
}

export function buildIdentityRows(input: {
  paths: FanoutPath[]
  actions: ActionRecord[]
}): IdentityRow[] {
  const rows: IdentityRow[] = []
  const seenSlot = new Set<string>()

  for (const a of input.actions) {
    const role =
      a.inputsRef.role ??
      (a.actionKind === 'retrieve'
        ? 'draft'
        : a.actionKind === 'compose'
          ? 'letter'
          : a.actionKind === 'accept'
            ? 'accept'
            : a.actionKind === 'reuse'
              ? 'reuse'
              : 'gateway')
    const keys =
      a.actionKind === 'retrieve'
        ? (a.outputsRef.draftKeys ?? a.outputsRef.candidateKeys ?? [])
        : a.premiseKeys
    rows.push({
      kind: 'action',
      id: `action:${a.actionId}`,
      label: `${a.actionKind} · ${role}`,
      detail:
        a.outputsRef.roleNote ||
        a.outputsRef.conclusion?.slice(0, 48) ||
        a.outputsRef.error ||
        keys.map(shortHandle).join('+') ||
        a.actionId,
      slotKeys: keys,
      actionId: a.actionId,
      pathId: a.inputsRef.pathId,
      assetId: a.outputsRef.assetId,
    })
  }

  for (const p of input.paths) {
    const assetId = p.direction.directionId
    if (p.direction.accepted === true) {
      rows.push({
        kind: 'asset',
        id: `asset:${assetId}`,
        label: `采纳资产 · ${shortHandle(assetId)}`,
        detail: (p.direction.conclusion || p.unitLabel || '').slice(0, 64),
        slotKeys: p.direction.premiseKeys ?? p.slots?.map((s) => s.key) ?? [],
        page: p.premisePages[0],
        pathId: p.pathId,
        assetId,
      })
    }
    for (const s of p.slots ?? []) {
      if (seenSlot.has(s.key)) continue
      seenSlot.add(s.key)
      rows.push({
        kind: 'slot',
        id: `slot:${s.key}`,
        label: `槽 · ${shortHandle(s.key)} · p${s.page + 1}`,
        detail: (s.excerpt || '').slice(0, 64),
        slotKeys: [s.key],
        page: s.page,
        pathId: p.pathId,
      })
    }
  }

  return rows
}
