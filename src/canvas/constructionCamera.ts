import * as THREE from 'three'
import type { EmphasisEdge, EmphasisLink } from '../data/emphasis'
import {
  pagePointToLocal,
  polygonCentroid,
  regionCentroid,
} from '../data/emphasis'
import {
  emphasisSurfaceWorld,
  geodesicMidOutward,
  layerPointOnOuterSphere,
  type AttentionShellKind,
} from './surfaceGeometry'
import { PAGE_H, PAGE_W, innerSphereRadius, radialToYawPitch } from './geometry'

const _n = new THREE.Vector3()
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _m = new THREE.Vector3()
const _c = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _tmp = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _fwd = new THREE.Vector3()

function toArr(v: THREE.Vector3): [number, number, number] {
  return [v.x, v.y, v.z]
}

/** Semantic emphasis centre on the inner page sphere. */
export function emphasisEndpointWorld(
  edge: EmphasisEdge,
  total: number,
): [number, number, number] {
  return emphasisSurfaceWorld(edge, Math.max(total, 1))
}

export type ConstructionDepth = 'commentNear' | 'emphasisNear'

export interface ConstructionTriangle {
  a: [number, number, number]
  b: [number, number, number]
  m: [number, number, number]
  c: [number, number, number]
  centroid: [number, number, number]
  /** Outward mid-axis (= direction M→C). Optical axis for construction pose. */
  normal: [number, number, number]
}

export interface DerivedLensPose {
  eye: [number, number, number]
  lookAt: [number, number, number]
  yaw: number
  pitch: number
  distance: number
}

/** @deprecated use geodesicMidOutward from surfaceGeometry */
export function radialOutNormalAtMid(
  a: THREE.Vector3,
  b: THREE.Vector3,
  _m: THREE.Vector3,
): THREE.Vector3 {
  const innerRadius = Math.max((a.length() + b.length()) * 0.5, 1)
  const [ox, oy, oz] = geodesicMidOutward(
    [a.x, a.y, a.z],
    [b.x, b.y, b.z],
    innerRadius,
  )
  return new THREE.Vector3(ox, oy, oz)
}

/**
 * Build △ABC from two emphasis centres (surface semantics).
 * A,B on inner sphere; M geodesic midpoint; C on outer concentric sphere.
 */
export function buildConstructionTriangle(
  from: EmphasisEdge,
  to: EmphasisEdge,
  total: number,
  /** default comment shell; decision / mainInfer = concentric outer shells */
  shell: AttentionShellKind = 'comment',
): ConstructionTriangle {
  const nPages = Math.max(total, 1)
  const a = emphasisEndpointWorld(from, nPages)
  const b = emphasisEndpointWorld(to, nPages)
  return buildConstructionTriangleFromPoints(a, b, nPages, shell)
}

/**
 * 任意两世界锚点 → 同款 △ABC（key 面板对比用）。
 * A、B 不必在内球上；M/C 仍走测地中点径向外推。
 */
export function buildConstructionTriangleFromPoints(
  a: [number, number, number],
  b: [number, number, number],
  total: number,
  shell: AttentionShellKind = 'comment',
): ConstructionTriangle {
  const nPages = Math.max(total, 1)
  const innerRadius = innerSphereRadius(nPages)
  const { m, point, outward } = layerPointOnOuterSphere(
    a,
    b,
    innerRadius,
    shell,
  )
  const c = point
  const centroid = toArr(
    new THREE.Vector3(a[0], a[1], a[2])
      .add(new THREE.Vector3(b[0], b[1], b[2]))
      .add(new THREE.Vector3(c[0], c[1], c[2]))
      .multiplyScalar(1 / 3),
  )

  return { a: [...a], b: [...b], m, c, centroid, normal: outward }
}

/** Same mid-ray as comment C; returns comment / decision / mainInfer shell points. */
export function buildConcentricShellStack(
  a: [number, number, number],
  b: [number, number, number],
  total: number,
): Record<AttentionShellKind, [number, number, number]> {
  const innerRadius = innerSphereRadius(Math.max(total, 1))
  return {
    comment: layerPointOnOuterSphere(a, b, innerRadius, 'comment').point,
    decision: layerPointOnOuterSphere(a, b, innerRadius, 'decision').point,
    mainInfer: layerPointOnOuterSphere(a, b, innerRadius, 'mainInfer').point,
  }
}

/** Basis whose +Z aligns with ±MC (Target B axis). Prefer live camera for pages. */
export function billboardBasis(
  normal: [number, number, number],
  faceSign: 1 | -1,
): { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3; quat: THREE.Quaternion } {
  const z = new THREE.Vector3(normal[0], normal[1], normal[2])
    .normalize()
    .multiplyScalar(faceSign)
  const worldUp = new THREE.Vector3(0, 1, 0)
  _x.crossVectors(worldUp, z)
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0).cross(z)
  _x.normalize()
  _y.copy(z).cross(_x).normalize()
  const quat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(_x, _y, z),
  )
  return { x: _x.clone(), y: _y.clone(), z, quat }
}

/**
 * Perspective image-plane coords of a world point (origin at look axis).
 * Returns null if behind the camera.
 */
function projectToViewPlane(
  world: THREE.Vector3,
  eye: THREE.Vector3,
  lookAt: THREE.Vector3,
): { x: number; y: number } | null {
  _fwd.copy(lookAt).sub(eye)
  if (_fwd.lengthSq() < 1e-12) return null
  _fwd.normalize()
  const worldUp = new THREE.Vector3(0, 1, 0)
  _right.crossVectors(_fwd, worldUp)
  if (_right.lengthSq() < 1e-10) {
    _right.crossVectors(_fwd, new THREE.Vector3(1, 0, 0))
  }
  _right.normalize()
  _up.copy(_right).cross(_fwd).normalize()

  _tmp.copy(world).sub(eye)
  const depth = _tmp.dot(_fwd)
  if (depth <= 1e-6) return null
  return {
    x: _tmp.dot(_right) / depth,
    y: _tmp.dot(_up) / depth,
  }
}

/**
 * How far proj(C) is from midpoint(proj(A), proj(B)) in view-plane units.
 * ~0 when eye sits on the M–C radial (geodesic symmetry).
 */
export function projectionMidpointError(
  tri: ConstructionTriangle,
  eye: [number, number, number],
  lookAt: [number, number, number],
): number {
  const e = new THREE.Vector3(eye[0], eye[1], eye[2])
  const l = new THREE.Vector3(lookAt[0], lookAt[1], lookAt[2])
  const pa = projectToViewPlane(new THREE.Vector3(...tri.a), e, l)
  const pb = projectToViewPlane(new THREE.Vector3(...tri.b), e, l)
  const pc = projectToViewPlane(new THREE.Vector3(...tri.c), e, l)
  if (!pa || !pb || !pc) return Number.POSITIVE_INFINITY
  const mx = (pa.x + pb.x) * 0.5
  const my = (pa.y + pb.y) * 0.5
  return Math.hypot(pc.x - mx, pc.y - my)
}

function observationAxis(tri: ConstructionTriangle): THREE.Vector3 {
  _m.set(tri.m[0], tri.m[1], tri.m[2])
  if (_m.lengthSq() > 1e-8) {
    return _m.clone().normalize()
  }
  _n.set(tri.normal[0], tri.normal[1], tri.normal[2])
  if (_n.lengthSq() > 1e-8) return _n.normalize()
  return new THREE.Vector3(0, 0, 1)
}

/**
 * Rebuild spherical comment centres for every link (data hygiene).
 * Clears legacy spring apex so all links use the same construction path.
 * Does not change emphasis region selectors or page homes.
 */
export function migrateLinksSphericalComment(
  edges: EmphasisEdge[],
  links: EmphasisLink[],
  total: number,
): EmphasisLink[] {
  const nPages = Math.max(total, 1)
  const byId = new Map(edges.map((e) => [e.id, e]))
  let changed = false
  const next = links.map((link) => {
    const from = byId.get(link.fromEmphasisId)
    const to = byId.get(link.toEmphasisId)
    if (!from || !to) return link
    const tri = buildConstructionTriangle(from, to, nPages)
    const same =
      link.commentCenter !== null &&
      Math.abs(link.commentCenter[0] - tri.c[0]) < 1e-3 &&
      Math.abs(link.commentCenter[1] - tri.c[1]) < 1e-3 &&
      Math.abs(link.commentCenter[2] - tri.c[2]) < 1e-3
    if (same && link.apex === null) return link
    changed = true
    return { ...link, commentCenter: tri.c, apex: null }
  })
  return changed ? next : links
}

/** Page-local Y of an emphasis centre — used to level A/B on the construction plane. */
export function emphasisPageLocalY(edge: EmphasisEdge): number {
  const uv =
    edge.region.polygon.length >= 3
      ? polygonCentroid(edge.region.polygon)
      : regionCentroid(edge.region.aabb)
  const [, ly] = pagePointToLocal(uv, PAGE_W, PAGE_H)
  return ly
}

/**
 * Display-only coplanar layout for the two linked pages.
 * Semantic A/B/C and page homes are NOT mutated — only render proxy poses.
 *
 * Both pages share one plane ⟂ optical axis (∥ image plane):
 * - commentNear: plane at M (far); C stays nearer on the outer shell
 * - emphasisNear: plane pulled toward the camera along the axis
 * - spread: left/right spacing on that plane (靠近 / 远离)
 * - alignLocalY: shift page along billboard-up by −ly so the linked emphasis
 *   sits on the mid horizontal (A–B reads as a level zipper line)
 */
export function constructionCoplanarPagePose(
  tri: ConstructionTriangle,
  side: 'from' | 'to',
  depth: ConstructionDepth,
  spread = 1,
  opts?: { sameStrand?: boolean; alignLocalY?: number },
): [number, number, number] {
  const outward = observationAxis(tri)
  const { x: right, y: up } = billboardBasis(toArr(outward), 1)
  _m.set(tri.m[0], tri.m[1], tri.m[2])
  _c.set(tri.c[0], tri.c[1], tri.c[2])

  let center: THREE.Vector3
  if (depth === 'commentNear') {
    center = _m.clone()
  } else {
    const t = 0.58
    center = _m.clone().multiplyScalar(t)
  }

  // Same page: keep one card centred on the plane
  if (opts?.sameStrand) {
    return [center.x, center.y, center.z]
  }

  const s = Math.max(0.08, Math.min(5.5, spread))
  // Wider leverage so C-drag (zipper) reads clearly
  const half = PAGE_W * (0.28 + 0.62 * s)
  const sign = side === 'from' ? -1 : 1
  // Cancel page-local Y of the linked emphasis → A and B share one horizon
  const ly = opts?.alignLocalY ?? 0
  return [
    center.x + right.x * sign * half - up.x * ly,
    center.y + right.y * sign * half - up.y * ly,
    center.z + right.z * sign * half - up.z * ly,
  ]
}

/** Resolve which side a strand plays in the active coplanar pair. */
export function constructionSideForStrand(
  strandIndex: number,
  fromStrand: number,
  toStrand: number,
): 'from' | 'to' | null {
  if (strandIndex === fromStrand) return 'from'
  if (strandIndex === toStrand) return 'to'
  return null
}

/**
 * Construction journey (not one continuous t):
 * 1. rail — mid slides M→C; eye on a track ⟂ mid-line, facing the mid
 * 2. crossing — eye follows the hole through C (穿越)
 * 3. planar — 俯视 coplanar pages; zipper only 靠近/远离
 */
export type ConstructionStage = 'rail' | 'crossing' | 'planar'

const RAIL_SIDE = 7.2
const RAIL_BACK = 2.4

function midOnAxis(
  tri: ConstructionTriangle,
  lift: number,
): THREE.Vector3 {
  const t = THREE.MathUtils.clamp(lift, 0, 1)
  return new THREE.Vector3(
    tri.m[0] + (tri.c[0] - tri.m[0]) * t,
    tri.m[1] + (tri.c[1] - tri.m[1]) * t,
    tri.m[2] + (tri.c[2] - tri.m[2]) * t,
  )
}

function poseFromEyeLook(eye: THREE.Vector3, lookAt: THREE.Vector3): DerivedLensPose {
  return {
    eye: toArr(eye),
    lookAt: toArr(lookAt),
    ...radialToYawPitch(eye),
    distance: eye.length(),
  }
}

/** Segment mid on M→C during rail (visual zipper / beam apex). */
export function constructionMidWorld(
  tri: ConstructionTriangle,
  midLift: number,
): [number, number, number] {
  return toArr(midOnAxis(tri, midLift))
}

/**
 * Rail camera: side view of the whole M→C climb.
 * Eye is fixed on the segment (not chasing mid) so dragging M→C stays hittable.
 */
export function constructionRailPose(
  tri: ConstructionTriangle,
  _midLift = 0,
): DerivedLensPose {
  const focus = midOnAxis(tri, 0.5)
  const axis = observationAxis(tri)
  const { x: right } = billboardBasis(toArr(axis), 1)
  const eye = focus
    .clone()
    .addScaledVector(right, RAIL_SIDE * 1.2)
    .addScaledVector(axis, -RAIL_BACK * 1.35)
  return poseFromEyeLook(eye, focus)
}

/** After 穿越: 俯视 coplanar construction plane (along MC, looking at M). */
export function constructionPlanarPose(
  tri: ConstructionTriangle,
  depth: ConstructionDepth = 'commentNear',
  spread = 1,
): DerivedLensPose {
  return constructionFaceOnPose(tri, depth, spread)
}

/**
 * Crossing: eye rides through C along the mid-line (hole),
 * from rail vantage → planar 俯视.
 */
export function constructionCrossingPose(
  tri: ConstructionTriangle,
  crossT: number,
  depth: ConstructionDepth = 'commentNear',
  spread = 1,
): DerivedLensPose {
  const u = THREE.MathUtils.smoothstep(0, 1, THREE.MathUtils.clamp(crossT, 0, 1))
  const rail = constructionRailPose(tri, 1)
  const planar = constructionPlanarPose(tri, depth, spread)
  const eye = new THREE.Vector3(...rail.eye).lerp(
    new THREE.Vector3(...planar.eye),
    u,
  )
  // Punch through C in the middle of the cross for 穿越感
  const c = new THREE.Vector3(...tri.c)
  const via = new THREE.Vector3(...rail.eye).lerp(c, 0.55).lerp(
    new THREE.Vector3(...planar.eye),
    Math.max(0, (u - 0.35) / 0.65),
  )
  const mixedEye = u < 0.55 ? via : eye
  const look = new THREE.Vector3(...rail.lookAt).lerp(
    new THREE.Vector3(...planar.lookAt),
    u,
  )
  return poseFromEyeLook(mixedEye, look)
}

export function constructionPoseForStage(
  tri: ConstructionTriangle,
  stage: ConstructionStage,
  midLift: number,
  crossT: number,
  depth: ConstructionDepth,
  spread: number,
): DerivedLensPose {
  if (stage === 'rail') return constructionRailPose(tri, midLift)
  if (stage === 'crossing') {
    return constructionCrossingPose(tri, crossT, depth, spread)
  }
  return constructionPlanarPose(tri, depth, spread)
}

/** @deprecated — use stage machine; kept for INFLECT refs during migration */
export const CONSTRUCTION_INFLECT = 0.5

/**
 * Perspective FOV that approaches orthographic as eye–look distance → ∞.
 *
 * IMPORTANT: do NOT use fov = 2atan(H/d) here — that locks framed size
 * (dolly-zoom), so zoom-out feels impossible while zoom-in still works
 * once FOV hits the upper clamp. Keep FOV high while dollying so size
 * follows 1/d; only ease FOV down at large d for the ortho limit.
 */
export function perspectiveFovApproachingOrtho(
  eyeLookDistance: number,
): number {
  const d = Math.max(eyeLookDistance, 0.5)
  const near = 32 // below: full perspective, real zoom
  const far = 1200 // at/above: near-ortho rays
  const t = THREE.MathUtils.clamp(
    (Math.log(d) - Math.log(near)) / (Math.log(far) - Math.log(near)),
    0,
    1,
  )
  const s = t * t * (3 - 2 * t) // smoothstep
  return THREE.MathUtils.lerp(48, 3.5, s)
}

/**
 * Canonical construction pose for one A–B link.
 *
 * - Eye on concentric observation sphere.
 * - Optical axis through M–C.
 * - commentNear: eye just outside C (comment near-field); pages coplanar at M.
 * - emphasisNear: eye inside; pages coplanar nearer on axis.
 */
export function constructionFaceOnPose(
  tri: ConstructionTriangle,
  depth: ConstructionDepth = 'commentNear',
  spread = 1,
): DerivedLensPose {
  _a.set(tri.a[0], tri.a[1], tri.a[2])
  _b.set(tri.b[0], tri.b[1], tri.b[2])
  _c.set(tri.c[0], tri.c[1], tri.c[2])
  _m.set(tri.m[0], tri.m[1], tri.m[2])

  const outward = observationAxis(tri)
  const halfFov = THREE.MathUtils.degToRad(25)
  const cR = Math.max(_c.length(), _m.length() * 1.05)
  const pageR = Math.max((_a.length() + _b.length()) * 0.5, 1)
  const s = Math.max(0.08, Math.min(5.5, spread))
  // Frame the coplanar pair width, not the sphere chord AB
  const pairSpan = PAGE_W * (0.7 + 1.15 * s)

  let eye: THREE.Vector3
  let lookAt: THREE.Vector3

  if (depth === 'commentNear') {
    const boardSpan = 4.2
    const distPastC = Math.max(3.4, (boardSpan * 0.5) / Math.tan(halfFov))
    eye = outward.clone().multiplyScalar(cR + distPastC)
    // Look at plane centre (M) with C still in foreground on axis
    lookAt = _m.clone()
  } else {
    const framing = Math.max(9, (pairSpan * 0.55) / Math.tan(halfFov) + 2)
    const planeR = pageR * 0.58
    const R_view = Math.max(2.5, planeR - framing * 0.35)
    eye = outward.clone().multiplyScalar(R_view)
    lookAt = _m.clone().multiplyScalar(0.58)
  }

  return {
    eye: toArr(eye),
    lookAt: toArr(lookAt),
    ...radialToYawPitch(eye),
    distance: eye.length(),
  }
}

export function retrospectiveFaceOnPose(
  tri: ConstructionTriangle,
): DerivedLensPose {
  return constructionFaceOnPose(tri, 'commentNear')
}

/** @deprecated */
export function constructionShellPose(tri: ConstructionTriangle) {
  return constructionFaceOnPose(tri, 'commentNear')
}

/** @deprecated */
export function retrospectiveShellPose(tri: ConstructionTriangle) {
  return constructionFaceOnPose(tri, 'commentNear')
}

export function triangleForLink(
  from: EmphasisEdge | undefined,
  to: EmphasisEdge | undefined,
  total: number,
  storedC?: [number, number, number] | null,
): ConstructionTriangle | null {
  if (!from || !to) return null
  const tri = buildConstructionTriangle(from, to, total)
  if (storedC) {
    _m.set(tri.m[0], tri.m[1], tri.m[2])
    _c.set(storedC[0], storedC[1], storedC[2])
    const outward = _m.clone().normalize()
    const cDir = _c.clone().normalize()
    if (
      _c.lengthSq() > 1e-6 &&
      outward.lengthSq() > 1e-8 &&
      cDir.dot(outward) > 0.995 &&
      _c.length() > _m.length()
    ) {
      tri.c = [storedC[0], storedC[1], storedC[2]]
      tri.normal = toArr(cDir)
      tri.centroid = toArr(
        new THREE.Vector3(tri.a[0], tri.a[1], tri.a[2])
          .add(new THREE.Vector3(tri.b[0], tri.b[1], tri.b[2]))
          .add(_c)
          .multiplyScalar(1 / 3),
      )
    }
  }
  return tri
}

export function trianglePlaneBasis(tri: ConstructionTriangle): {
  origin: THREE.Vector3
  x: THREE.Vector3
  y: THREE.Vector3
  z: THREE.Vector3
} {
  const { x, y, z } = billboardBasis(tri.normal, 1)
  return {
    origin: new THREE.Vector3(tri.centroid[0], tri.centroid[1], tri.centroid[2]),
    x,
    y,
    z,
  }
}
