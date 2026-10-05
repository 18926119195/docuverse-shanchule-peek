/**
 * Surface semantics vs render proxy.
 *
 * Backend truth:
 * - Each page is a patch on the inner document sphere (concentric shell).
 * - Emphasis selectors live in page_norm_0_1000 — intrinsic (u,v) on that patch.
 * - Relation endpoints A/B are points on the inner sphere; comment C on an outer shell.
 *
 * Render proxy (unchanged UX):
 * - PageMesh still draws a flat card at the page tangent plane (pageHomePosition).
 * - Overlays/beams attach via uv → flat local coords on that card.
 *
 * All conversion between the two layers lives here.
 */

import * as THREE from 'three'
import type { EmphasisEdge, PagePoint } from '../data/emphasis'
import { pagePointToLocal, polygonCentroid, regionCentroid } from '../data/emphasis'
import {
  PAGE_H,
  PAGE_W,
  basisFromOutward,
  innerSphereRadius,
  pageHomePosition,
  pageHomeQuaternion,
  pageLocalToWorld,
  pageRadialDirection,
} from './geometry'
import { getPageSurfaceGroup } from './pageSurfaceRegistry'

/** Comment layer sits on this concentric outer sphere (× inner radius). */
export const COMMENT_SPHERE_SCALE = 1.48
/** 决策层：相对评论壳的同心外球 */
export const DECISION_SPHERE_SCALE = COMMENT_SPHERE_SCALE * 1.22
/** 主推理层：再外一圈同心壳 */
export const MAIN_INFER_SPHERE_SCALE = DECISION_SPHERE_SCALE * 1.22

export type AttentionShellKind = 'comment' | 'decision' | 'mainInfer'

export const ATTENTION_SHELL_SCALE: Record<AttentionShellKind, number> = {
  comment: COMMENT_SPHERE_SCALE,
  decision: DECISION_SPHERE_SCALE,
  mainInfer: MAIN_INFER_SPHERE_SCALE,
}

export interface PageSurfaceFrame {
  strandIndex: number
  total: number
  innerRadius: number
  /** Unit outward radial at page anchor */
  outward: THREE.Vector3
  /** Page centre on inner sphere — semantic anchor */
  surfaceOrigin: THREE.Vector3
  /** Same as surfaceOrigin; flat card is tangent here (render proxy origin) */
  renderOrigin: THREE.Vector3
  tangentX: THREE.Vector3
  tangentY: THREE.Vector3
}

const _v = new THREE.Vector3()
const _u = new THREE.Vector3()
const _w = new THREE.Vector3()

function clampDot(x: number): number {
  return Math.max(-1, Math.min(1, x))
}

/** Intrinsic frame for one page patch on the inner sphere. */
export function pageSurfaceFrame(
  strandIndex: number,
  total: number,
): PageSurfaceFrame {
  const nPages = Math.max(total, 1)
  const innerRadius = innerSphereRadius(nPages)
  const outward = pageRadialDirection(strandIndex, nPages)
  const surfaceOrigin = outward.clone().multiplyScalar(innerRadius)
  const { x: tangentX, y: tangentY } = basisFromOutward(outward)
  const [ox, oy, oz] = pageHomePosition(strandIndex, nPages)
  return {
    strandIndex,
    total: nPages,
    innerRadius,
    outward,
    surfaceOrigin,
    renderOrigin: new THREE.Vector3(ox, oy, oz),
    tangentX,
    tangentY,
  }
}

function vec3(arr: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(arr[0], arr[1], arr[2])
}

function toArr(v: THREE.Vector3): [number, number, number] {
  return [v.x, v.y, v.z]
}

/**
 * Map intrinsic (u,v) to a point on the inner sphere:
 * sample in tangent frame, then radially project onto the shell.
 */
export function uvToSurfaceWorld(
  uv: PagePoint,
  frame: PageSurfaceFrame,
): [number, number, number] {
  const [lx, ly] = pagePointToLocal(uv, PAGE_W, PAGE_H)
  _v
    .copy(frame.surfaceOrigin)
    .addScaledVector(frame.tangentX, lx)
    .addScaledVector(frame.tangentY, ly)
  if (_v.lengthSq() < 1e-10) {
    _v.copy(frame.outward).multiplyScalar(frame.innerRadius)
  } else {
    _v.normalize().multiplyScalar(frame.innerRadius)
  }
  return toArr(_v)
}

/** Visual anchor — on flat page proxy (beams, highlights that must match drawn region). */
export function emphasisRenderWorld(
  edge: EmphasisEdge,
  total: number,
  localZ = 0.16,
): [number, number, number] {
  return emphasisRenderWorldAt(edge, total, undefined, localZ)
}

export type PageBasisVectors = {
  x: THREE.Vector3
  y: THREE.Vector3
  z: THREE.Vector3
}

/** Same as emphasisRenderWorld but when the flat page proxy has moved from home. */
export function emphasisRenderWorldAt(
  edge: EmphasisEdge,
  total: number,
  pageOrigin?: [number, number, number],
  /** Match EmphasisOverlay stroke plane (z=0.16) for repeatable coil-centre hits. */
  localZ = 0.16,
  basisOverride?: PageBasisVectors,
): [number, number, number] {
  const frame = pageSurfaceFrame(edge.strandIndex, total)
  const uv = emphasisAnchorUv(edge)
  return uvToRenderWorld(uv, frame, localZ, pageOrigin, basisOverride)
}

/** Page-norm centre used for beams / A·B / star map.
 * Blend area-centroid with AABB centre: hand-drawn coils densify unevenly;
 * pure shoelace can sit off the visual middle of a circled label.
 */
export function emphasisAnchorUv(edge: EmphasisEdge): PagePoint {
  if (edge.region.polygon.length < 3) {
    return regionCentroid(edge.region.aabb)
  }
  const area = polygonCentroid(edge.region.polygon)
  const box = regionCentroid(edge.region.aabb)
  return [
    area[0] * 0.45 + box[0] * 0.55,
    area[1] * 0.45 + box[1] * 0.55,
  ]
}

const _liveLocal = new THREE.Vector3()

/**
 * Beam / relation anchors from the LIVE PageMesh matrix.
 * Guarantees the purple line meets the drawn coil centre
 * (reconstructed pageOrigin+basis can drift in planar / lerp).
 */
export function emphasisLiveWorldAt(
  edge: EmphasisEdge,
  localZ = 0.16,
): [number, number, number] | null {
  const group = getPageSurfaceGroup(edge.strandIndex)
  if (!group || !group.visible) return null
  const [lx, ly] = pagePointToLocal(emphasisAnchorUv(edge), PAGE_W, PAGE_H)
  group.updateWorldMatrix(true, false)
  _liveLocal.set(lx, ly, localZ)
  _liveLocal.applyMatrix4(group.matrixWorld)
  return [_liveLocal.x, _liveLocal.y, _liveLocal.z]
}

function uvToRenderWorld(
  uv: PagePoint,
  frame: PageSurfaceFrame,
  localZ = 0.16,
  pageOrigin?: [number, number, number],
  basisOverride?: PageBasisVectors,
): [number, number, number] {
  const [lx, ly] = pagePointToLocal(uv, PAGE_W, PAGE_H)
  return pageLocalToWorld(
    frame.strandIndex,
    frame.total,
    [lx, ly, localZ],
    pageOrigin,
    basisOverride,
  )
}

/** Flat-card orientation for PageMesh / overlays at this page. */
export function pageRenderProxy(strandIndex: number, total: number): {
  position: [number, number, number]
  quaternion: THREE.Quaternion
  frame: PageSurfaceFrame
} {
  const frame = pageSurfaceFrame(strandIndex, total)
  return {
    position: pageHomePosition(strandIndex, total),
    quaternion: pageHomeQuaternion(strandIndex, total),
    frame,
  }
}

/** Semantic endpoint — on inner sphere (construction, tetrahedron, stored relations). */
export function emphasisSurfaceWorld(
  edge: EmphasisEdge,
  total: number,
): [number, number, number] {
  const frame = pageSurfaceFrame(edge.strandIndex, total)
  return uvToSurfaceWorld(emphasisAnchorUv(edge), frame)
}

/**
 * Page +Z faces the camera — same convention as PageMesh lockFaceOn.
 * Use for coplanar beam anchors so hits match drawn coils after any PDF import.
 */
export function pageBasisFacingCamera(camera: THREE.Camera): PageBasisVectors {
  const look = new THREE.Vector3()
  camera.getWorldDirection(look)
  if (look.lengthSq() < 1e-12) {
    return basisFromOutward(new THREE.Vector3(0, 0, 1))
  }
  return basisFromOutward(look.negate().normalize())
}

/**
 * Visual mid on the emphasis–emphasis chord, lifting toward C (comment).
 * lift=0 → true midpoint of A_vis–B_vis; lift=1 → C.
 * Repeatable: always derived from current render anchors + C.
 */
export function liftedMidTowardComment(
  aVis: [number, number, number],
  bVis: [number, number, number],
  c: [number, number, number],
  lift: number,
): [number, number, number] {
  const t = Math.max(0, Math.min(1, lift))
  const mx = (aVis[0] + bVis[0]) * 0.5
  const my = (aVis[1] + bVis[1]) * 0.5
  const mz = (aVis[2] + bVis[2]) * 0.5
  return [
    mx + (c[0] - mx) * t,
    my + (c[1] - my) * t,
    mz + (c[2] - mz) * t,
  ]
}

export function slerpMidOnSphere(
  a: [number, number, number],
  b: [number, number, number],
  radius: number,
): [number, number, number] {
  _u.copy(vec3(a)).normalize()
  _w.copy(vec3(b)).normalize()
  const dot = clampDot(_u.dot(_w))
  if (dot > 0.999999) {
    return toArr(_u.multiplyScalar(radius))
  }
  if (dot < -0.999999) {
    const axis = new THREE.Vector3().crossVectors(_u, new THREE.Vector3(0, 1, 0))
    if (axis.lengthSq() < 1e-8) axis.crossVectors(_u, new THREE.Vector3(1, 0, 0))
    axis.normalize()
    return toArr(axis.multiplyScalar(radius))
  }
  const omega = Math.acos(dot)
  const sinOmega = Math.sin(omega)
  const k = Math.sin(omega * 0.5) / sinOmega
  return toArr(
    _u
      .clone()
      .multiplyScalar(k)
      .add(_w.clone().multiplyScalar(k))
      .normalize()
      .multiplyScalar(radius),
  )
}

/** Outward unit radial at geodesic midpoint of A and B on the inner sphere. */
export function geodesicMidOutward(
  a: [number, number, number],
  b: [number, number, number],
  innerRadius: number,
): [number, number, number] {
  const mid = slerpMidOnSphere(a, b, innerRadius)
  const m = vec3(mid)
  if (m.lengthSq() < 1e-8) return [0, 0, 1]
  return toArr(m.normalize())
}

/** Comment C on outer concentric sphere, on ray through geodesic midpoint. */
export function commentPointOnOuterSphere(
  a: [number, number, number],
  b: [number, number, number],
  innerRadius: number,
  outerScale = COMMENT_SPHERE_SCALE,
): {
  m: [number, number, number]
  c: [number, number, number]
  outward: [number, number, number]
} {
  const m = slerpMidOnSphere(a, b, innerRadius)
  const outward = geodesicMidOutward(a, b, innerRadius)
  const outerRadius = innerRadius * outerScale
  const c = toArr(vec3(outward).multiplyScalar(outerRadius))
  return { m, c, outward }
}

/**
 * Same algorithm as comment C (two anchors → geodesic mid → radial),
 * only the concentric shell scale changes (decision / mainInfer).
 */
export function layerPointOnOuterSphere(
  a: [number, number, number],
  b: [number, number, number],
  innerRadius: number,
  kind: AttentionShellKind,
): {
  m: [number, number, number]
  point: [number, number, number]
  outward: [number, number, number]
  scale: number
} {
  const scale = ATTENTION_SHELL_SCALE[kind]
  const { m, c, outward } = commentPointOnOuterSphere(a, b, innerRadius, scale)
  return { m, point: c, outward, scale }
}

/** Single-anchor: radial through anchor → concentric shell (no second emphasis). */
export function singleAnchorShellPoint(
  anchor: [number, number, number],
  kind: AttentionShellKind,
): {
  point: [number, number, number]
  outward: [number, number, number]
  scale: number
} {
  const scale = ATTENTION_SHELL_SCALE[kind]
  const v = vec3(anchor)
  const len = v.length()
  const outward: [number, number, number] =
    len < 1e-8 ? [0, 0, 1] : toArr(v.clone().normalize())
  const base = len < 1e-8 ? 22 : len
  return {
    point: toArr(vec3(outward).multiplyScalar(base * scale)),
    outward,
    scale,
  }
}
