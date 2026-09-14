/**
 * Intrinsic doorplate keys — server authority only.
 * Browser must treat lockId as opaque.
 *
 * bookKey lockId = layout 步坐标（非 OCR）：
 *   `${docId}|slot|p${page}|k${layoutK}`
 * |slot| 为历史词；k = layoutK。同槽改 T / 重 OCR 不改 lockId。
 */

export function stableShortHash(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** Layout-slot doorplate → bookKey identity (seal this; never hash OCR text). */
export function makeSlotKey(docId: string, page: number, layoutK: number): string {
  return `${docId}|slot|p${page}|k${layoutK}`
}

export function makeComboKey(docId: string, memberKeys: string[]): string {
  const body = [...memberKeys].sort().join('\0')
  return `${docId}|combo|${stableShortHash(body)}`
}

export function makeFigKey(docId: string, figId: string): string {
  return `${docId}|fig|${figId}`
}
