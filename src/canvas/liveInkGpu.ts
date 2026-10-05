/**
 * GPU ink trail — append-only buffer writes on the pointer hot path.
 * Redraw is scheduled once per frame (never gl.render per sample).
 */

import * as THREE from 'three'
import { PAGE_H, PAGE_W } from './geometry'
import type { PagePoint } from '../data/emphasis'
import { distPage } from '../data/emphasis'

export const INK_TRAIL_CAP = 8192

export type InkTrailGpu = {
  positions: Float32Array
  attr: THREE.BufferAttribute
  geom: THREE.BufferGeometry
  vertexCount: number
  /** Last UV for dedupe on append */
  lastUv: PagePoint | null
}

const trails = new Map<number, InkTrailGpu>()
let invalidateFn: (() => void) | null = null
let framePending = false

export function setInkInvalidate(fn: (() => void) | null): void {
  invalidateFn = fn
}

/** One invalidate per animation frame — buffer already updated on pointer. */
export function scheduleInkRedraw(): void {
  if (framePending) return
  framePending = true
  requestAnimationFrame(() => {
    framePending = false
    invalidateFn?.()
  })
}

export function registerInkTrail(
  strandIndex: number,
  gpu: Omit<InkTrailGpu, 'vertexCount' | 'lastUv'>,
): void {
  trails.set(strandIndex, { ...gpu, vertexCount: 0, lastUv: null })
}

export function unregisterInkTrail(strandIndex: number): void {
  trails.delete(strandIndex)
}

export function clearInkTrail(strandIndex: number): void {
  const t = trails.get(strandIndex)
  if (!t) return
  t.vertexCount = 0
  t.lastUv = null
  t.geom.setDrawRange(0, 0)
}

function uvToLocal(uv: PagePoint): [number, number, number] {
  const [nx, ny] = uv
  return [
    -PAGE_W / 2 + (nx / 1000) * PAGE_W,
    PAGE_H / 2 - (ny / 1000) * PAGE_H,
    0.16,
  ]
}

/** O(1) append with optional min distance dedupe. */
export function appendInkTrailVertex(
  strandIndex: number,
  uv: PagePoint,
  minDist = 0,
): boolean {
  const t = trails.get(strandIndex)
  if (!t) return false
  if (
    minDist > 0 &&
    t.lastUv &&
    distPage(t.lastUv, uv) < minDist
  ) {
    return false
  }
  const i = t.vertexCount
  if (i >= INK_TRAIL_CAP) return false
  const [x, y, z] = uvToLocal(uv)
  const o = i * 3
  t.positions[o] = x
  t.positions[o + 1] = y
  t.positions[o + 2] = z
  t.vertexCount = i + 1
  t.lastUv = uv
  t.attr.needsUpdate = true
  t.geom.setDrawRange(0, t.vertexCount)
  return true
}

export function rebuildInkTrail(strandIndex: number, points: PagePoint[]): void {
  clearInkTrail(strandIndex)
  for (const uv of points) {
    if (!appendInkTrailVertex(strandIndex, uv, 0)) break
  }
}
