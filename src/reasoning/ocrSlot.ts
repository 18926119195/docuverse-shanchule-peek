/**
 * Client-side identity helpers.
 * Authoritative keys are sealed handles from /api/protocol/* — never mint doorplates here.
 */

export type PageBBox = [number, number, number, number]

export function isOpaqueHandle(value: string): boolean {
  return value.startsWith('h1.') && value.length > 12
}

/** @deprecated Local hashing must not mint protocol keys. */
export function stableShortHash(_input: string): string {
  throw new Error('stableShortHash is server-only; use sealed handles')
}

/** @deprecated Use emit-page layout handle（bookKey≠OCR）. */
export function makeSlotKey(_docId: string, _page: number, _k: number): string {
  throw new Error('makeSlotKey is server-only; layout cut must provide sealed handle')
}

/** @deprecated Use /api/protocol/mint-key kind=combo. */
export function makeComboKey(_docId: string, _memberKeys: string[]): string {
  throw new Error('makeComboKey is server-only; call protocolMintKey')
}

export interface SlotMemberRef {
  slotId: string
  pctStart: number
  pctEnd: number
  page: number
  /** 高亮/裁切用：强调笔占块时为 pieceAabb，否则为整槽 */
  bbox: PageBBox
  /** 整扇 bookKey 门框（有占块指针时） */
  bookKeyAabb?: PageBBox
  /** 门内相对 [u0,v0,u1,v1]；有则可用 rel 反算 page */
  rel?: [number, number, number, number]
}

export function spanToPct(
  text: string,
  start: number,
  end: number,
): { pctStart: number; pctEnd: number } {
  const L = Math.max(1, text.length)
  const s = Math.max(0, Math.min(L, start))
  const e = Math.max(s, Math.min(L, end))
  return {
    pctStart: (s / L) * 100,
    pctEnd: (e / L) * 100,
  }
}

export function fullSlotMember(input: {
  slotId: string
  page: number
  bbox: PageBBox
  bookKeyAabb?: PageBBox
  rel?: [number, number, number, number]
}): SlotMemberRef {
  return {
    slotId: input.slotId,
    pctStart: 0,
    pctEnd: 100,
    page: input.page,
    bbox: input.bbox,
    bookKeyAabb: input.bookKeyAabb,
    rel: input.rel,
  }
}

/** Short label for UI logs (does not reveal doorplate). */
export function shortHandle(handle: string): string {
  if (!isOpaqueHandle(handle)) return handle.slice(0, 24)
  if (handle.length <= 18) return handle
  return `${handle.slice(0, 8)}…${handle.slice(-6)}`
}
