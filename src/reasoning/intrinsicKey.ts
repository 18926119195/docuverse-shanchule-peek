import type { AdjustKind, IntrinsicCoordinate, PlaceFaces, RelationKind } from './types'

export { makeComboKey, makeSlotKey, stableShortHash } from './ocrSlot'

export function makeIntrinsicKey(docId: string, start: number, end: number): string {
  return `${docId}|${start}|${end}`
}

export function makeFigKey(_docId: string, _figId: string): string {
  throw new Error('makeFigKey is server-only; call protocolMintKey({ kind: "fig" })')
}

/** Prefer opaque labels for UI — never echo stream intervals or slot formulas. */
export function formatRLabel(R: IntrinsicCoordinate): string {
  const faces: string[] = []
  if (R.faces.text) faces.push('文字脸')
  if (R.faces.fig) faces.push('图脸')
  const faceTag = faces.length ? faces.join('+') : R.kind
  const members = R.memberKeys?.length
    ? ` · ${R.memberKeys.length}槽`
    : ''
  return `锁定对象${members} · ${faceTag}`
}

export function classifyIntervalRelation(
  a: IntrinsicCoordinate,
  b: IntrinsicCoordinate,
): { relation: RelationKind; adjust?: AdjustKind } {
  if (a.docId !== b.docId) {
    return { relation: 'disjoint' }
  }
  if (a.key === b.key) {
    return { relation: 'overlap', adjust: 'same' }
  }
  const aMembers = a.memberKeys?.length ? a.memberKeys : [a.key]
  const bMembers = b.memberKeys?.length ? b.memberKeys : [b.key]
  const shared = aMembers.some((k) => bMembers.includes(k))
  if (shared) {
    if (
      aMembers.length === bMembers.length &&
      aMembers.every((k) => bMembers.includes(k))
    ) {
      return { relation: 'overlap', adjust: 'same' }
    }
    return { relation: 'overlap', adjust: 'partial' }
  }
  if (a.kind === 'fig' || b.kind === 'fig') {
    return { relation: 'disjoint' }
  }
  if (a.start === b.start && a.end === b.end) {
    return { relation: 'overlap', adjust: 'same' }
  }
  const disjoint = a.end <= b.start || b.end <= a.start
  if (disjoint) return { relation: 'disjoint' }

  const aInB = a.start >= b.start && a.end <= b.end
  const bInA = b.start >= a.start && b.end <= a.end
  if (aInB && !bInA) return { relation: 'overlap', adjust: 'expand' }
  if (bInA && !aInB) return { relation: 'overlap', adjust: 'shrink' }
  if (aInB && bInA) return { relation: 'overlap', adjust: 'same' }
  return { relation: 'overlap', adjust: 'partial' }
}

/** Machine readout for Bundle / closure — content only, no slot indices or handles. */
export function facesToReadout(faces: PlaceFaces): string {
  const parts: string[] = []
  if (faces.text) {
    parts.push('【文字脸】', faces.text.content)
  }
  if (faces.fig) {
    const note = faces.fig.note
      .replace(/h1\.[A-Za-z0-9_-]{8,}/g, '[句柄]')
      .replace(/页\s*=\s*\d+/g, '页=*')
      .replace(/k\s*=\s*\d+/gi, 'k=*')
      .replace(/figId=\S+/g, '')
      .trim()
    parts.push('【图脸】', note || '与文字同锁的图脸已附着')
    if (faces.fig.imageRef) {
      parts.push(
        faces.fig.imageRef.startsWith('data:') ||
          faces.fig.imageRef.startsWith('blob:')
          ? 'imageRef=(页图已附着)'
          : 'imageRef=(外部图引用)',
      )
    }
  }
  return parts.filter((p) => p.length > 0).join('\n')
}
