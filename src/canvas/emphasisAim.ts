/**
 * Emphasize pen aim — which page is prepared for circling.
 * Module store (not Zustand) so hover stays cheap.
 */

let aimStrand: number | null = null
let version = 0
const listeners = new Set<() => void>()

export function getEmphasisAim(): number | null {
  return aimStrand
}

export function getEmphasisAimVersion(): number {
  return version
}

export function setEmphasisAim(strandIndex: number | null): boolean {
  if (aimStrand === strandIndex) return false
  aimStrand = strandIndex
  version++
  for (const l of listeners) l()
  return true
}

export function subscribeEmphasisAim(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}
