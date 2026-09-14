/**
 * Current analysis object (book / page / slots).
 * Nail down before tool choice and conclusion reuse.
 */

export type ObjectScopeKind = 'book' | 'page' | 'slots'

export interface CurrentObject {
  kind: ObjectScopeKind
  docId: string
  /** 0-based pages when kind is page */
  pages: number[]
  /** Slot keys when kind is slots (or locked from draft) */
  slotKeys: string[]
  /** Human/auto lock source */
  lockedBy: 'auto' | 'user' | 'none'
  label: string
}

export function emptyCurrentObject(docId = ''): CurrentObject {
  return {
    kind: 'book',
    docId,
    pages: [],
    slotKeys: [],
    lockedBy: 'none',
    label: '全书（未钉死）',
  }
}

export function lockSlotsObject(input: {
  docId: string
  slotKeys: string[]
  pages: number[]
  lockedBy: 'auto' | 'user'
}): CurrentObject {
  const keys = [...new Set(input.slotKeys.filter(Boolean))]
  const pages = [...new Set(input.pages)].sort((a, b) => a - b)
  return {
    kind: keys.length > 0 ? 'slots' : pages.length > 0 ? 'page' : 'book',
    docId: input.docId,
    pages,
    slotKeys: keys,
    lockedBy: input.lockedBy,
    label:
      keys.length > 0
        ? `已锁 ${keys.length} 槽 · p${pages.map((p) => p + 1).join(',') || '?'}`
        : pages.length > 0
          ? `已锁页 p${pages.map((p) => p + 1).join(',')}`
          : '全书',
  }
}

/** Filter draft candidates to those intersecting the locked object. */
export function filterKeysByObject(
  candidateKeys: string[],
  object: CurrentObject | null,
): string[] {
  if (!object || object.lockedBy === 'none') return candidateKeys
  if (object.kind === 'slots' && object.slotKeys.length > 0) {
    const allow = new Set(object.slotKeys)
    const hit = candidateKeys.filter((k) => allow.has(k))
    return hit.length > 0 ? hit : candidateKeys
  }
  return candidateKeys
}
