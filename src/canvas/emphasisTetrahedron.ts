import * as THREE from 'three'
import type { EmphasisEdge, EmphasisLink } from '../data/emphasis'
import {
  constructionFaceOnPose,
  emphasisEndpointWorld,
  triangleForLink,
  type ConstructionTriangle,
  type DerivedLensPose,
} from './constructionCamera'
import { radialToYawPitch } from './geometry'

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _d = new THREE.Vector3()
const _m1 = new THREE.Vector3()
const _m2 = new THREE.Vector3()
const _eye = new THREE.Vector3()
const _n = new THREE.Vector3()
const _f = new THREE.Vector3()

export type TetCorner = 0 | 1 | 2 | 3

export interface AnchoredTetrahedron {
  /** Anchor face = already-built relation triangle ABC */
  anchor: ConstructionTriangle
  /** Fourth vertex from a candidate emphasis (source position, not moved) */
  d: [number, number, number]
  dEmphasisId: string
  vertices: {
    A: [number, number, number]
    B: [number, number, number]
    C: [number, number, number]
    D: [number, number, number]
  }
  /** Four faces; index 0 is always anchor ABC */
  faces: {
    id: 'ABC' | 'ABD' | 'ACD' | 'BCD'
    a: [number, number, number]
    b: [number, number, number]
    c: [number, number, number]
    center: [number, number, number]
    normal: [number, number, number]
    isAnchor: boolean
  }[]
}

function toArr(v: THREE.Vector3): [number, number, number] {
  return [v.x, v.y, v.z]
}

function faceOf(
  id: AnchoredTetrahedron['faces'][0]['id'],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  isAnchor: boolean,
  preferN?: THREE.Vector3,
): AnchoredTetrahedron['faces'][0] {
  _n.copy(b).sub(a).cross(_c.copy(c).sub(a))
  if (_n.lengthSq() < 1e-12) _n.set(0, 1, 0)
  else _n.normalize()
  _f.copy(a).add(b).add(c).multiplyScalar(1 / 3)
  if (preferN && _n.dot(preferN) < 0) _n.negate()
  else if (!preferN && _n.dot(_f) < 0) _n.negate()
  return {
    id,
    a: toArr(a),
    b: toArr(b),
    c: toArr(c),
    center: toArr(_f),
    normal: toArr(_n),
    isAnchor,
  }
}

/**
 * Tetrahedron with fixed face ABC (built link) + D from another emphasis centre.
 * Source positions only — never relocates pages.
 */
export function buildAnchoredTetrahedron(
  link: EmphasisLink,
  from: EmphasisEdge,
  to: EmphasisEdge,
  dEdge: EmphasisEdge,
  total: number,
): AnchoredTetrahedron | null {
  if (dEdge.id === from.id || dEdge.id === to.id) return null
  const anchor = triangleForLink(from, to, total, link.commentCenter)
  if (!anchor) return null
  const d = emphasisEndpointWorld(dEdge, Math.max(total, 1))

  const A = new THREE.Vector3(anchor.a[0], anchor.a[1], anchor.a[2])
  const B = new THREE.Vector3(anchor.b[0], anchor.b[1], anchor.b[2])
  const C = new THREE.Vector3(anchor.c[0], anchor.c[1], anchor.c[2])
  const D = new THREE.Vector3(d[0], d[1], d[2])
  const prefer = new THREE.Vector3(anchor.normal[0], anchor.normal[1], anchor.normal[2])

  const faces = [
    faceOf('ABC', A, B, C, true, prefer),
    faceOf('ABD', A, B, D, false),
    faceOf('ACD', A, C, D, false),
    faceOf('BCD', B, C, D, false),
  ]

  return {
    anchor,
    d,
    dEmphasisId: dEdge.id,
    vertices: { A: anchor.a, B: anchor.b, C: anchor.c, D: d },
    faces,
  }
}

/**
 * Fig.9-style pose: project along midpoints of opposite edges AB and CD
 * (AB is the emphasis base — natural opposite to comment–candidate edge CD).
 * Eye derived from edge midpoints — objects → camera.
 */
export function anchoredTetrahedronProjectionPose(
  tet: AnchoredTetrahedron,
): DerivedLensPose {
  const { A, B, C, D } = tet.vertices
  _a.set(A[0], A[1], A[2])
  _b.set(B[0], B[1], B[2])
  _c.set(C[0], C[1], C[2])
  _d.set(D[0], D[1], D[2])
  // Opposite edges AB and CD
  _m1.copy(_a).add(_b).multiplyScalar(0.5)
  _m2.copy(_c).add(_d).multiplyScalar(0.5)
  _n.copy(_m1).sub(_m2)
  if (_n.lengthSq() < 1e-10) {
    // Fallback: face-on anchor
    return constructionFaceOnPose(tet.anchor)
  }
  _n.normalize()
  const center = new THREE.Vector3()
    .add(_a)
    .add(_b)
    .add(_c)
    .add(_d)
    .multiplyScalar(0.25)
  let span = 0
  for (const p of [_a, _b, _c, _d]) {
    span = Math.max(span, p.distanceTo(center))
  }
  const halfFov = THREE.MathUtils.degToRad(25)
  const dist = Math.max(10, (span * 1.35) / Math.tan(halfFov))
  // Choose side so anchor face normal roughly faces camera
  const anchorN = new THREE.Vector3(
    tet.anchor.normal[0],
    tet.anchor.normal[1],
    tet.anchor.normal[2],
  )
  if (_n.dot(anchorN) < 0) _n.negate()
  _eye.copy(center).addScaledVector(_n, dist)
  const { yaw, pitch } = radialToYawPitch(_eye)
  return {
    eye: toArr(_eye),
    lookAt: toArr(center),
    yaw,
    pitch,
    distance: _eye.length(),
  }
}

/** Pick D: nearest other emphasis centre to anchor centroid (excluding A,B). */
export function pickCandidateD(
  edges: EmphasisEdge[],
  fromId: string,
  toId: string,
  total: number,
  preferId?: string | null,
): EmphasisEdge | null {
  if (preferId) {
    const pref = edges.find(
      (e) => e.id === preferId && e.id !== fromId && e.id !== toId,
    )
    if (pref) return pref
  }
  const others = edges.filter((e) => e.id !== fromId && e.id !== toId)
  if (others.length === 0) return null
  const from = edges.find((e) => e.id === fromId)
  const to = edges.find((e) => e.id === toId)
  if (!from || !to) return others[0]
  const a = emphasisEndpointWorld(from, total)
  const b = emphasisEndpointWorld(to, total)
  const mid = new THREE.Vector3(
    (a[0] + b[0]) * 0.5,
    (a[1] + b[1]) * 0.5,
    (a[2] + b[2]) * 0.5,
  )
  let best = others[0]
  let bestD = Infinity
  for (const e of others) {
    const p = emphasisEndpointWorld(e, total)
    const d = mid.distanceTo(new THREE.Vector3(p[0], p[1], p[2]))
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  return best
}

/* ——— legacy cloud tetrahedron (kept for “all emphases” overview) ——— */

const TET_UNIT: readonly [number, number, number][] = [
  [1, 1, 1],
  [1, -1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
]

export interface EmphasisTetrahedron {
  centroid: [number, number, number]
  vertices: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ]
  oppositeFace: {
    a: [number, number, number]
    b: [number, number, number]
    c: [number, number, number]
    center: [number, number, number]
    normal: [number, number, number]
  }[]
  faceOfEmphasis: Record<string, TetCorner>
  radius: number
}

export function buildEmphasisTetrahedron(
  edges: EmphasisEdge[],
  total: number,
): EmphasisTetrahedron | null {
  if (edges.length === 0) return null
  const nPages = Math.max(total, 1)
  const centers = edges.map((e) => {
    const w = emphasisEndpointWorld(e, nPages)
    return { id: e.id, v: new THREE.Vector3(w[0], w[1], w[2]) }
  })
  const G = new THREE.Vector3()
  for (const c of centers) G.add(c.v)
  G.multiplyScalar(1 / centers.length)
  let R = 0
  for (const c of centers) R = Math.max(R, c.v.distanceTo(G))
  if (R < 1.5) R = 6
  const scale = R * 2.15
  const inv = 1 / Math.sqrt(3)
  const vertices = TET_UNIT.map((u) =>
    new THREE.Vector3(u[0] * inv, u[1] * inv, u[2] * inv)
      .multiplyScalar(scale)
      .add(G),
  ) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]
  const oppositeFace: EmphasisTetrahedron['oppositeFace'] = []
  for (let i = 0; i < 4; i++) {
    const ids = ([0, 1, 2, 3] as const).filter((j) => j !== i)
    _a.copy(vertices[ids[0]])
    _b.copy(vertices[ids[1]])
    _c.copy(vertices[ids[2]])
    _f.copy(_a).add(_b).add(_c).multiplyScalar(1 / 3)
    _n.copy(_b).sub(_a).cross(_c.clone().sub(_a))
    if (_n.lengthSq() < 1e-10) _n.set(0, 1, 0)
    else _n.normalize()
    _eye.copy(vertices[i]).sub(_f)
    if (_n.dot(_eye) < 0) _n.negate()
    oppositeFace.push({
      a: toArr(_a),
      b: toArr(_b),
      c: toArr(_c),
      center: toArr(_f),
      normal: toArr(_n),
    })
  }
  const faceOfEmphasis: Record<string, TetCorner> = {}
  for (const c of centers) {
    let best: TetCorner = 0
    let bestAbs = Infinity
    for (let i = 0; i < 4; i++) {
      const f = oppositeFace[i]
      const dist = Math.abs(
        (c.v.x - f.center[0]) * f.normal[0] +
          (c.v.y - f.center[1]) * f.normal[1] +
          (c.v.z - f.center[2]) * f.normal[2],
      )
      if (dist < bestAbs) {
        bestAbs = dist
        best = i as TetCorner
      }
    }
    faceOfEmphasis[c.id] = best
  }
  return {
    centroid: toArr(G),
    vertices: [
      toArr(vertices[0]),
      toArr(vertices[1]),
      toArr(vertices[2]),
      toArr(vertices[3]),
    ],
    oppositeFace,
    faceOfEmphasis,
    radius: R,
  }
}

export function tetrahedronCornerPose(
  tet: EmphasisTetrahedron,
  corner: TetCorner,
  _total: number,
): DerivedLensPose {
  const face = tet.oppositeFace[corner]
  _f.set(face.center[0], face.center[1], face.center[2])
  _n.set(face.normal[0], face.normal[1], face.normal[2]).normalize()
  const span = Math.max(tet.radius * 2.4, 14)
  const halfFov = THREE.MathUtils.degToRad(25)
  const viewDist = Math.max(8, (span * 0.55) / Math.tan(halfFov))
  _eye.copy(_f).addScaledVector(_n, viewDist)
  const { yaw, pitch } = radialToYawPitch(_eye)
  return {
    eye: toArr(_eye),
    lookAt: [...face.center] as [number, number, number],
    yaw,
    pitch,
    distance: _eye.length(),
  }
}

export function countEmphasesOnFace(
  tet: EmphasisTetrahedron,
  corner: TetCorner,
): number {
  let n = 0
  for (const face of Object.values(tet.faceOfEmphasis)) {
    if (face === corner) n++
  }
  return n
}
