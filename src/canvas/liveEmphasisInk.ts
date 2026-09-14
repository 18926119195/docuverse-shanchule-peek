/**
 * Ephemeral pen ink — module store, not Zustand.
 * Mutate-in-place + version so pointermove stays smooth without reallocating.
 */

import type { PagePoint } from '../data/emphasis'

export type LiveInk = {
  strandIndex: number
  points: PagePoint[]
}

let live: LiveInk | null = null
let version = 0
const listeners = new Set<() => void>()

export function getLiveInk(): LiveInk | null {
  return live
}

/** Snapshot token for useSyncExternalStore (changes whenever ink mutates). */
export function getLiveInkVersion(): number {
  return version
}

export function setLiveInk(next: LiveInk | null): void {
  live = next
  version++
  for (const l of listeners) l()
}

/** Notify subscribers after in-place mutation of live.points */
export function bumpLiveInk(): void {
  if (!live) return
  version++
  for (const l of listeners) l()
}

export function subscribeLiveInk(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}
