/**
 * Live registry of page proxy groups (the same PageMesh instances as on the
 * home sphere). Construction only moves their world pose — never duplicates data.
 *
 * Emphasis pen samples page_norm_0_1000 against these groups so overlays
 * (inner sphere cue, beams, zipper) cannot steal hits.
 */

import * as THREE from 'three'
import { PAGE_H, PAGE_W } from './geometry'
import { localToPagePoint, type PagePoint } from '../data/emphasis'

const groups = new Map<number, THREE.Object3D>()

const _ndc = new THREE.Vector2()
const _ray = new THREE.Raycaster()
const _hit = new THREE.Vector3()
const _plane = new THREE.Plane()
const _normal = new THREE.Vector3()
const _origin = new THREE.Vector3()
const _local = new THREE.Vector3()
const _centerNdc = new THREE.Vector3()
const _toCam = new THREE.Vector3()
const _inv = new THREE.Matrix4()

/** Cached canvas rect — avoid layout thrash on every pointer sample. */
let cachedRect: DOMRect | null = null
let cachedRectEl: HTMLElement | null = null

/** Frozen page plane while drawing (pose locked). */
let strokeCache: {
  strandIndex: number
  normal: THREE.Vector3
  origin: THREE.Vector3
  plane: THREE.Plane
  invMatrix: THREE.Matrix4
} | null = null

export function invalidatePagePickRect(): void {
  cachedRect = null
}

function getRect(domElement: HTMLElement): DOMRect | null {
  if (cachedRect && cachedRectEl === domElement) return cachedRect
  const rect = domElement.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  cachedRect = rect
  cachedRectEl = domElement
  return rect
}

export function beginStrokePickCache(strandIndex: number): void {
  const group = groups.get(strandIndex)
  if (!group) {
    strokeCache = null
    return
  }
  group.updateWorldMatrix(true, false)
  const normal = new THREE.Vector3(0, 0, 1)
    .transformDirection(group.matrixWorld)
    .normalize()
  const origin = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld)
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin)
  strokeCache = {
    strandIndex,
    normal,
    origin,
    plane,
    invMatrix: _inv.copy(group.matrixWorld).invert().clone(),
  }
}

export function endStrokePickCache(): void {
  strokeCache = null
}

/** Half-extent pad for UV sampling / drawing (slightly generous). */
const DRAW_PAD = 0.52
/** Tighter pad to *enter* a new aim target (reduces neighbour edge steal). */
const AIM_ENTER_PAD = 0.44
/** Looser pad to *keep* current aim (hysteresis). */
const AIM_STAY_PAD = 0.58
/** Reject near edge-on / back-facing pages. */
const MIN_FACING = 0.18
/** Sticky page must lose by this factor before aim switches. */
const STICKY_KEEP = 0.78

export type PageSurfaceHit = {
  strandIndex: number
  uv: PagePoint
  worldDist: number
  /** 1 = full front face toward camera, 0 = edge-on, &lt;0 = back. */
  facing: number
  /** NDC distance from cursor to page centre (smaller = more central). */
  screenCenterDist: number
  /** 1 at page centre, 0 at pad edge. */
  interior: number
}

export function registerPageSurface(
  strandIndex: number,
  group: THREE.Object3D | null,
): void {
  if (!group) {
    groups.delete(strandIndex)
    return
  }
  groups.set(strandIndex, group)
}

function hitMetrics(
  clientX: number,
  clientY: number,
  camera: THREE.Camera,
  domElement: HTMLElement,
  pageGroup: THREE.Object3D,
  pad: number,
  opts?: { skipFacing?: boolean; skipScreen?: boolean; frozen?: boolean },
): Omit<PageSurfaceHit, 'strandIndex'> | null {
  const rect = getRect(domElement)
  if (!rect) return null
  _ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1
  _ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1
  _ray.setFromCamera(_ndc, camera)

  if (opts?.frozen && strokeCache) {
    if (!_ray.ray.intersectPlane(strokeCache.plane, _hit)) return null
    _local.copy(_hit).applyMatrix4(strokeCache.invMatrix)
  } else {
    pageGroup.updateWorldMatrix(true, false)
    _normal.set(0, 0, 1).transformDirection(pageGroup.matrixWorld).normalize()
    _origin.setFromMatrixPosition(pageGroup.matrixWorld)
    _plane.setFromNormalAndCoplanarPoint(_normal, _origin)
    if (!_ray.ray.intersectPlane(_plane, _hit)) return null
    if (!opts?.skipFacing) {
      _toCam.subVectors(camera.position, _origin).normalize()
      const facing = _normal.dot(_toCam)
      if (facing < MIN_FACING) return null
    }
    _local.copy(_hit)
    pageGroup.worldToLocal(_local)
  }

  const halfW = PAGE_W * pad
  const halfH = PAGE_H * pad
  if (Math.abs(_local.x) > halfW || Math.abs(_local.y) > halfH) return null

  const ux = 1 - Math.abs(_local.x) / halfW
  const uy = 1 - Math.abs(_local.y) / halfH
  const interior = Math.min(ux, uy)

  let facing = 1
  let screenCenterDist = 0
  let worldDist = camera.position.distanceTo(_hit)
  if (!opts?.frozen) {
    if (!opts?.skipFacing) {
      _toCam.subVectors(camera.position, _origin).normalize()
      facing = _normal.dot(_toCam)
    }
    if (!opts?.skipScreen) {
      _centerNdc.copy(_origin).project(camera)
      screenCenterDist = Math.hypot(
        _centerNdc.x - _ndc.x,
        _centerNdc.y - _ndc.y,
      )
    }
  }

  return {
    uv: localToPagePoint(_local.x, _local.y, PAGE_W, PAGE_H),
    worldDist,
    facing,
    screenCenterDist,
    interior,
  }
}

/** Lower score wins. Depth + screen centre + facing + interior. */
function aimScore(h: Omit<PageSurfaceHit, 'strandIndex'>): number {
  return (
    h.worldDist * 1.0 +
    h.screenCenterDist * 14 +
    (1 - h.facing) * 8 +
    (1 - h.interior) * 3.5
  )
}

export function pageNormOnGroup(
  clientX: number,
  clientY: number,
  camera: THREE.Camera,
  domElement: HTMLElement,
  pageGroup: THREE.Object3D,
): { uv: PagePoint; worldDist: number } | null {
  const hit = hitMetrics(
    clientX,
    clientY,
    camera,
    domElement,
    pageGroup,
    DRAW_PAD,
  )
  if (!hit) return null
  return { uv: hit.uv, worldDist: hit.worldDist }
}

export function getPageSurfaceGroup(
  strandIndex: number,
): THREE.Object3D | null {
  return groups.get(strandIndex) ?? null
}

/** Sample page_norm on a single prepared strand (fast path while drawing). */
export function pickPageNormOnStrand(
  strandIndex: number,
  clientX: number,
  clientY: number,
  camera: THREE.Camera,
  domElement: HTMLElement,
): PagePoint | null {
  const group = groups.get(strandIndex)
  if (!group || !group.visible) return null
  const frozen = strokeCache?.strandIndex === strandIndex
  const hit = hitMetrics(
    clientX,
    clientY,
    camera,
    domElement,
    group,
    DRAW_PAD,
    frozen
      ? { frozen: true, skipFacing: true, skipScreen: true }
      : { skipFacing: true, skipScreen: true },
  )
  return hit ? hit.uv : null
}

/**
 * Stroke start: which page actually contains the pointer (draw pad).
 * No sticky hysteresis — sticky aim must not block clicking another page.
 */
export function pickPageUnderCursorForStroke(
  clientX: number,
  clientY: number,
  camera: THREE.Camera,
  domElement: HTMLElement,
): PageSurfaceHit | null {
  let best: PageSurfaceHit | null = null
  for (const [strandIndex, group] of groups) {
    if (!group.visible) continue
    const metrics = hitMetrics(
      clientX,
      clientY,
      camera,
      domElement,
      group,
      DRAW_PAD,
      { skipFacing: true, skipScreen: true },
    )
    if (!metrics) continue
    if (!best || metrics.worldDist < best.worldDist) {
      best = { strandIndex, ...metrics }
    }
  }
  return best
}

/**
 * Aim pick: front-facing only, screen-centre weighted, sticky hysteresis.
 * Prevents neighbour edges / pages behind from stealing the prepared page.
 */
export function pickPageSurfaceForAim(
  clientX: number,
  clientY: number,
  camera: THREE.Camera,
  domElement: HTMLElement,
  stickyStrand: number | null,
): PageSurfaceHit | null {
  let best: PageSurfaceHit | null = null
  let bestScore = Infinity
  let sticky: PageSurfaceHit | null = null
  let stickyScore = Infinity

  for (const [strandIndex, group] of groups) {
    if (!group.visible) continue
    const isSticky = stickyStrand === strandIndex
    const pad = isSticky ? AIM_STAY_PAD : AIM_ENTER_PAD
    const metrics = hitMetrics(
      clientX,
      clientY,
      camera,
      domElement,
      group,
      pad,
    )
    if (!metrics) continue
    const hit: PageSurfaceHit = { strandIndex, ...metrics }
    const score = aimScore(metrics)
    if (isSticky) {
      sticky = hit
      stickyScore = score
    }
    if (score < bestScore) {
      best = hit
      bestScore = score
    }
  }

  // Keep sticky unless a challenger clearly wins
  if (sticky && best) {
    if (best.strandIndex === sticky.strandIndex) return sticky
    if (bestScore > stickyScore * STICKY_KEEP) return sticky
  }
  if (sticky && !best) return sticky
  return best
}

/** Frontmost page under the cursor (depth-only; used as fallback). */
export function pickPageSurfaceAtClient(
  clientX: number,
  clientY: number,
  camera: THREE.Camera,
  domElement: HTMLElement,
): { strandIndex: number; uv: PagePoint; worldDist: number } | null {
  return pickPageSurfaceForAim(
    clientX,
    clientY,
    camera,
    domElement,
    null,
  )
}
