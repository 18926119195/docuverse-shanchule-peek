import * as THREE from 'three'
import type { FlinkType, ResolvedConnection } from '../zigzag/types'

export const PAGE_W = 8.2
export const PAGE_H = 11.2
/** Nominal chord spacing between neighbouring page centres on the inner sphere */
export const PAGE_GAP_X = 10.5
/** Gap between original page and OCR twin on the same reading plane */
export const OCR_PLANE_GAP = 1.15

const _v = new THREE.Vector3()
const _z = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()

/**
 * Poker-ring radius: pages stand in reading order around a circle
 * (fanout fork — replaces helical sphere packing).
 */
export function innerSphereRadius(total: number): number {
  const n = Math.max(total, 1)
  if (n === 1) return Math.max(22, PAGE_W * 2.2)
  // Chord ≈ PAGE_GAP_X between neighbours on the ring
  return Math.max(22, (n * PAGE_GAP_X) / (2 * Math.PI))
}

/**
 * 结算架：固定 C 时靠转球把目标页旋进机位槽（非相机追页）。
 * 仅影响 poker 环角度；退出结算时清零。
 */
let pokerYawOffset = 0

export function getPokerYawOffset(): number {
  return pokerYawOffset
}

export function setPokerYawOffset(rad: number): void {
  pokerYawOffset = Number.isFinite(rad) ? rad : 0
}

export function clearPokerYawOffset(): void {
  pokerYawOffset = 0
}

/**
 * Unit radial in the XZ plane — outward from ring centre to the page.
 * Book order = angle around the circle (poker layout).
 */
export function pageRadialDirection(
  strandIndex: number,
  total: number,
): THREE.Vector3 {
  const n = Math.max(total, 1)
  if (n === 1) {
    const o = getPokerYawOffset()
    if (Math.abs(o) < 1e-8) return new THREE.Vector3(0, 0, 1)
    return new THREE.Vector3(Math.sin(o), 0, Math.cos(o)).normalize()
  }
  const angle =
    (strandIndex / n) * Math.PI * 2 - Math.PI / 2 + getPokerYawOffset()
  return new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)).normalize()
}

/** Angle of a page on the poker ring (for path arrow anchors). */
export function pageRingAngle(strandIndex: number, total: number): number {
  const n = Math.max(total, 1)
  return (strandIndex / n) * Math.PI * 2 - Math.PI / 2 + getPokerYawOffset()
}

/**
 * Fan-out vertical stack (bottom → top):
 * PDF poker deck → OCR slots → compose units → infer conclusions.
 */
export const FANOUT_LAYER_Y = {
  pdf: 0,
  ocr: PAGE_H * 1.25,
  compose: PAGE_H * 2.35,
  infer: PAGE_H * 3.45,
} as const

export type FanoutLayerId = keyof typeof FANOUT_LAYER_Y

/** Same ring XZ as a page, lifted to a fan-out layer. */
export function fanoutLayerPosition(
  strandIndex: number,
  total: number,
  layer: FanoutLayerId,
  radiusScale = 1,
): [number, number, number] {
  const [x, , z] = pageHomePosition(strandIndex, total)
  const s = radiusScale
  return [x * s, FANOUT_LAYER_Y[layer], z * s]
}

/** Polar placement on a layer ring (for compose/infer hubs). */
export function fanoutPolarOnLayer(
  angle: number,
  total: number,
  layer: FanoutLayerId,
  radiusScale = 0.55,
): [number, number, number] {
  const r = innerSphereRadius(Math.max(total, 1)) * radiusScale
  return [
    Math.cos(angle) * r,
    FANOUT_LAYER_Y[layer],
    Math.sin(angle) * r,
  ]
}

/**
 * Orthonormal page basis at a world position on/near the inner sphere:
 * +Z = outward (toward outer-shell camera), +Y ≈ world-up projected, +X = right.
 */
export function basisFromOutward(outward: THREE.Vector3): {
  x: THREE.Vector3
  y: THREE.Vector3
  z: THREE.Vector3
} {
  const z = outward.clone().normalize()
  const worldUp = new THREE.Vector3(0, 1, 0)
  let x = new THREE.Vector3().crossVectors(worldUp, z)
  if (x.lengthSq() < 1e-8) {
    x.crossVectors(new THREE.Vector3(0, 0, 1), z)
  }
  x.normalize()
  const y = new THREE.Vector3().crossVectors(z, x).normalize()
  return { x, y, z }
}

export function pageBasis(
  strandIndex: number,
  total: number,
): { origin: THREE.Vector3; x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 } {
  const z = pageRadialDirection(strandIndex, total)
  const [ox, oy, oz] = pageHomePosition(strandIndex, total)
  const origin = new THREE.Vector3(ox, oy, oz)
  const { x, y } = basisFromOutward(z)
  return { origin, x, y, z }
}

export function pageQuaternionFromOutward(outward: THREE.Vector3): THREE.Quaternion {
  const { x, y, z } = basisFromOutward(outward)
  _m.makeBasis(x, y, z)
  return _q.setFromRotationMatrix(_m).clone()
}

export function pageHomeQuaternion(
  strandIndex: number,
  total: number,
): THREE.Quaternion {
  return pageQuaternionFromOutward(pageRadialDirection(strandIndex, total))
}

/** World offset of OCR twin: along page local +X (tangent). */
export function ocrPanelOffset(
  strandIndex = 0,
  total = 1,
): [number, number, number] {
  const { x } = pageBasis(strandIndex, total)
  const d = PAGE_W + OCR_PLANE_GAP
  return [x.x * d, x.y * d, x.z * d]
}

/**
 * Page centre on the poker ring — upright card facing outward.
 */
export function pageHomePosition(
  strandIndex: number,
  total: number,
): [number, number, number] {
  const z = pageRadialDirection(strandIndex, total)
  const r = innerSphereRadius(total)
  // Lift so cards stand like poker chips around the table
  const y = PAGE_H * 0.42
  return [z.x * r, y, z.z * r]
}

/** Map page-local (x,y,z) — z toward camera/outward — into world. */
export function pageLocalToWorld(
  strandIndex: number,
  total: number,
  local: [number, number, number],
  origin?: [number, number, number],
  /** When pages face the camera (construction planar), pass live basis — do not rebuild from radial. */
  basisOverride?: { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 },
): [number, number, number] {
  const b = pageBasis(strandIndex, total)
  const ox = origin ? origin[0] : b.origin.x
  const oy = origin ? origin[1] : b.origin.y
  const oz = origin ? origin[2] : b.origin.z
  if (basisOverride) {
    const { x, y, z } = basisOverride
    return [
      ox + x.x * local[0] + y.x * local[1] + z.x * local[2],
      oy + x.y * local[0] + y.y * local[1] + z.y * local[2],
      oz + x.z * local[0] + y.z * local[1] + z.z * local[2],
    ]
  }
  // If origin overridden (parked), rebuild basis from that radial
  if (origin) {
    _z.set(ox, oy, oz)
    if (_z.lengthSq() < 1e-8) _z.copy(b.z)
    else _z.normalize()
    const { x, y, z } = basisFromOutward(_z)
    return [
      ox + x.x * local[0] + y.x * local[1] + z.x * local[2],
      oy + x.y * local[0] + y.y * local[1] + z.y * local[2],
      oz + x.z * local[0] + y.z * local[1] + z.z * local[2],
    ]
  }
  return [
    ox + b.x.x * local[0] + b.y.x * local[1] + b.z.x * local[2],
    oy + b.x.y * local[0] + b.y.y * local[1] + b.z.y * local[2],
    oz + b.x.z * local[0] + b.y.z * local[1] + b.z.z * local[2],
  ]
}

/** Spherical angles (yaw, pitch) for a radial direction — outer-shell camera. */
export function radialToYawPitch(dir: THREE.Vector3): {
  yaw: number
  pitch: number
} {
  const d = dir.clone().normalize()
  const pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1))
  const yaw = Math.atan2(d.x, d.z)
  return { yaw, pitch }
}

export function yawPitchToRadial(yaw: number, pitch: number): THREE.Vector3 {
  const cp = Math.cos(pitch)
  return new THREE.Vector3(
    Math.sin(yaw) * cp,
    Math.sin(pitch),
    Math.cos(yaw) * cp,
  ).normalize()
}

/** Comfortable outer-shell radius for reading one page. */
export function readingOuterRadius(total: number): number {
  return innerSphereRadius(total) + Math.max(16, PAGE_H * 1.35)
}

/** @deprecated use pageHomePosition */
export function pagePosition(
  strandIndex: number,
  _current: number,
  _companion: number,
  total: number,
): [number, number, number] {
  return pageHomePosition(strandIndex, total)
}

/** Midpoint between current and companion (chord), nudged outward. */
export function readingFocus(
  current: number,
  companion: number,
  total: number,
): [number, number, number] {
  const a = pageHomePosition(current, total)
  if (current === companion) return a
  const b = pageHomePosition(companion, total)
  _v.set((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5)
  if (_v.lengthSq() < 1e-6) return a
  const r = innerSphereRadius(total) * 1.02
  _v.normalize().multiplyScalar(r)
  return [_v.x, _v.y, _v.z]
}

/**
 * Ease page toward partner; slight inward tuck into the shell interlayer
 * (relations live inside the page surface, not outside).
 */
export function linkFocusPose(
  strand: number,
  otherStrand: number,
  total: number,
  opts?: { pull?: number; lift?: number },
): [number, number, number] {
  const home = pageHomePosition(strand, total)
  const other = pageHomePosition(otherStrand, total)
  const pull = opts?.pull ?? 0.3
  const lift = opts?.lift ?? 1.6
  const { z } = pageBasis(strand, total)
  // -z = toward sphere centre (into the interlayer)
  return [
    home[0] + (other[0] - home[0]) * pull - z.x * lift,
    home[1] + (other[1] - home[1]) * pull - z.y * lift,
    home[2] + (other[2] - home[2]) * pull - z.z * lift,
  ]
}

/**
 * Triangle cluster in the tangent frame at an inward apex.
 * “Drop” moves pages slightly toward the shell so they stay readable from outside.
 */
export function triangleClusterPose(
  apex: [number, number, number],
  side: 'left' | 'right',
  opts?: { spread?: number; drop?: number },
): [number, number, number] {
  const spread = opts?.spread ?? PAGE_W * 0.62
  const drop = opts?.drop ?? PAGE_H * 0.2
  _z.set(apex[0], apex[1], apex[2])
  if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1)
  else _z.normalize()
  const { x } = basisFromOutward(_z)
  const xSign = side === 'left' ? -1 : 1
  // + outward from apex (toward shell) so parked pages sit near the surface
  return [
    apex[0] + x.x * xSign * spread + _z.x * drop,
    apex[1] + x.y * xSign * spread + _z.y * drop,
    apex[2] + x.z * xSign * spread + _z.z * drop,
  ]
}

export function springClusterPose(
  home: [number, number, number],
  apex: [number, number, number],
  side: 'left' | 'right',
  tension: number,
): [number, number, number] {
  const t = Math.min(1, Math.max(0, tension))
  const parked = triangleClusterPose(apex, side)
  return lerpPose(home, parked, t)
}

export function grabTension(
  homeA: [number, number, number],
  homeB: [number, number, number],
  apex: [number, number, number],
): number {
  const mid: [number, number, number] = [
    (homeA[0] + homeB[0]) * 0.5,
    (homeA[1] + homeB[1]) * 0.5,
    (homeA[2] + homeB[2]) * 0.5,
  ]
  const restLen = Math.hypot(
    homeA[0] - homeB[0],
    homeA[1] - homeB[1],
    homeA[2] - homeB[2],
  )
  const pull = Math.hypot(
    apex[0] - mid[0],
    apex[1] - mid[1],
    apex[2] - mid[2],
  )
  if (restLen < 1) return Math.min(1, pull / 8)
  return Math.min(1, pull / (restLen * 0.35 + 2))
}

/**
 * Purple-link apex in the interlayer: inside the page shell, between the two
 * endpoint surfaces (never outside the sphere past the page faces).
 */
export function interlayerApexBetween(
  homeA: [number, number, number],
  homeB: [number, number, number],
  opts?: { inset?: number },
): [number, number, number] {
  const inset = opts?.inset ?? 0.88
  _v.set(
    (homeA[0] + homeB[0]) * 0.5,
    (homeA[1] + homeB[1]) * 0.5,
    (homeA[2] + homeB[2]) * 0.5,
  )
  if (_v.lengthSq() < 1e-8) {
    // Same radial — step slightly inward from A
    const r = Math.hypot(homeA[0], homeA[1], homeA[2]) * inset
    if (r < 1e-6) return [0, 0, 0]
    _v.set(homeA[0], homeA[1], homeA[2]).normalize().multiplyScalar(r)
    return [_v.x, _v.y, _v.z]
  }
  // Chord midpoint is already inside the sphere; pull a bit deeper into the shell
  _v.multiplyScalar(inset)
  return [_v.x, _v.y, _v.z]
}

/** Keep apex radially inside both page surfaces (夹层约束). */
export function clampApexToInterlayer(
  apex: [number, number, number],
  homeA: [number, number, number],
  homeB: [number, number, number],
): [number, number, number] {
  const rA = Math.hypot(homeA[0], homeA[1], homeA[2])
  const rB = Math.hypot(homeB[0], homeB[1], homeB[2])
  const shell = Math.min(rA, rB)
  const maxR = Math.max(1, shell * 0.97)
  const minR = Math.max(0.5, shell * 0.25)
  _v.set(apex[0], apex[1], apex[2])
  const len = _v.length()
  if (len < 1e-8) {
    // Fallback: interlayer mid
    return interlayerApexBetween(homeA, homeB)
  }
  const r = Math.min(maxR, Math.max(minR, len))
  _v.multiplyScalar(r / len)
  return [_v.x, _v.y, _v.z]
}

export function defaultApexBetweenHomes(
  strandA: number,
  strandB: number,
  total: number,
): [number, number, number] {
  const a = pageHomePosition(strandA, total)
  const b = pageHomePosition(strandB, total)
  return interlayerApexBetween(a, b)
}

export function lerpPose(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]
}

export function flinkColor(type?: FlinkType): string {
  switch (type) {
    case 'bookmark':
      return '#4ea1ff'
    case 'resemblance':
      return '#76ff03'
    case 'clash':
    case 'disagreement':
      return '#ff3d00'
    case 'pointer':
      return '#00e5ff'
    case 'comment':
      return '#c77dff'
    case 'correspondence':
      return '#ffd54f'
    default:
      return '#90caf9'
  }
}

export function connectionColor(c: ResolvedConnection, isCurrent: boolean): string {
  if (isCurrent) return '#ffe082'
  if (c.kind === 'transclusion') return '#ffd700'
  return flinkColor(c.flinkType)
}
