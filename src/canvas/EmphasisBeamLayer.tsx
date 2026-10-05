import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { useDocuverse } from './store'
import {
  clampApexToInterlayer,
  interlayerApexBetween,
  lerpPose,
  linkFocusPose,
  pageHomePosition,
} from './geometry'
import { emphasisLiveWorldAt, emphasisRenderWorldAt, liftedMidTowardComment, pageBasisFacingCamera } from './surfaceGeometry'
import {
  constructionCoplanarPagePose,
  emphasisPageLocalY,
  triangleForLink,
} from './constructionCamera'

const noHit = (() => undefined) as unknown as THREE.Mesh['raycast']

const PURPLE = '#b388ff'
const PURPLE_HOT = '#e1bee7'
const DRAG_THRESHOLD_PX = 6

function placeSegment(
  mesh: THREE.Mesh | null,
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
) {
  if (!mesh) return
  const mid = a.clone().lerp(b, 0.5)
  const dir = b.clone().sub(a)
  const len = dir.length()
  if (len < 0.001) return
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize(),
  )
  mesh.position.copy(mid)
  mesh.quaternion.copy(quat)
  mesh.scale.set(radius / 0.05, Math.max(0.1, len), radius / 0.05)
}

/**
 * Purple beams: user can drag the beam apex (geometry only).
 * Page poses are controlled by lenses / construction + link focus,
 * not by spring clustering (Target cleanup).
 */
export function EmphasisBeamLayer() {
  const pages = useDocuverse((s) => s.pages)
  const edges = useDocuverse((s) => s.emphasisEdges)
  const links = useDocuverse((s) => s.emphasisLinks)
  const selectedId = useDocuverse((s) => s.selectedEmphasisId)
  const linkFocusId = useDocuverse((s) => s.linkFocusId)
  const constructionLinkId = useDocuverse((s) => s.constructionLinkId)
  const retrospectiveLinkId = useDocuverse((s) => s.retrospectiveLinkId)
  const cameraLens = useDocuverse((s) => s.cameraLens)
  const constructionDepth = useDocuverse((s) => s.constructionDepth)
  const constructionSpread = useDocuverse((s) => s.constructionSpread)
  const constructionStage = useDocuverse((s) => s.constructionStage)
  const constructionMidLift = useDocuverse((s) => s.constructionMidLift)
  const draggingLinkId = useDocuverse((s) => s.draggingLinkId)
  const beginDragLinkApex = useDocuverse((s) => s.beginDragLinkApex)
  const updateDragLinkApex = useDocuverse((s) => s.updateDragLinkApex)
  const endDragLinkApex = useDocuverse((s) => s.endDragLinkApex)
  const enterConstructionLens = useDocuverse((s) => s.enterConstructionLens)
  const total = Math.max(pages.length, 1)
  const { camera, gl } = useThree()

  const dragPlane = useRef(new THREE.Plane())
  const dragHit = useRef(new THREE.Vector3())
  const blend = useRef(0)
  const pending = useRef<{
    linkId: string
    pointerId: number
    originX: number
    originY: number
    startPoint: [number, number, number]
    armed: boolean
  } | null>(null)

  const byId = useMemo(
    () => new Map(edges.map((e) => [e.id, e])),
    [edges],
  )

  const beams = useMemo(() => {
    return links
      .map((link) => {
        const from = byId.get(link.fromEmphasisId)
        const to = byId.get(link.toEmphasisId)
        if (!from || !to) return null
        return {
          link,
          from,
          to,
          anchorA: emphasisRenderWorldAt(from, total),
          anchorB: emphasisRenderWorldAt(to, total),
        }
      })
      .filter(Boolean) as {
      link: (typeof links)[0]
      from: (typeof edges)[0]
      to: (typeof edges)[0]
      anchorA: [number, number, number]
      anchorB: [number, number, number]
    }[]
  }, [links, byId, edges])

  type Refs = {
    legA: THREE.Mesh | null
    legB: THREE.Mesh | null
    base: THREE.Mesh | null
    apex: THREE.Mesh | null
    hit: THREE.Mesh | null
    pinA: THREE.Mesh | null
    pinB: THREE.Mesh | null
  }
  const meshRefs = useRef(new Map<string, Refs>())

  // Window-level move/up — mesh onPointerMove dies once the cursor leaves the thin beam
  useEffect(() => {
    const el = gl.domElement

    const project = (
      clientX: number,
      clientY: number,
    ): [number, number, number] | null => {
      const rect = el.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      )
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(ndc, camera)
      if (raycaster.ray.intersectPlane(dragPlane.current, dragHit.current)) {
        return [dragHit.current.x, dragHit.current.y, dragHit.current.z]
      }
      const facing = new THREE.Plane()
      const camDir = new THREE.Vector3()
      camera.getWorldDirection(camDir)
      const dragId = useDocuverse.getState().draggingLinkId
      const anchor = useDocuverse
        .getState()
        .emphasisLinks.find((l) => l.id === dragId)?.apex
      const planePoint = anchor
        ? new THREE.Vector3(anchor[0], anchor[1], anchor[2])
        : new THREE.Vector3(0, 2, 0)
      facing.setFromNormalAndCoplanarPoint(
        camDir.clone().multiplyScalar(-1),
        planePoint,
      )
      if (raycaster.ray.intersectPlane(facing, dragHit.current)) {
        return [dragHit.current.x, dragHit.current.y, dragHit.current.z]
      }
      return null
    }

    const onMove = (ev: PointerEvent) => {
      const p = pending.current
      if (p && !p.armed) {
        const dist = Math.hypot(ev.clientX - p.originX, ev.clientY - p.originY)
        if (dist < DRAG_THRESHOLD_PX) return
        p.armed = true
        dragPlane.current.setFromNormalAndCoplanarPoint(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, p.startPoint[1], 0),
        )
        beginDragLinkApex(p.linkId, p.startPoint)
      }
      if (!useDocuverse.getState().draggingLinkId && !(p && p.armed)) return
      const pos = project(ev.clientX, ev.clientY)
      if (pos) updateDragLinkApex(pos)
    }

    const onUp = (ev: PointerEvent) => {
      const p = pending.current
      if (p && ev.pointerId === p.pointerId) {
        const wasArmed = p.armed
        const linkId = p.linkId
        pending.current = null
        try {
          el.releasePointerCapture(ev.pointerId)
        } catch {
          /* ignore */
        }
        if (useDocuverse.getState().draggingLinkId) {
          endDragLinkApex()
        } else if (!wasArmed) {
          // Short click: re-enter Target B construction (along MC)
          enterConstructionLens(linkId)
        }
        document.body.style.cursor = 'auto'
      } else if (useDocuverse.getState().draggingLinkId) {
        endDragLinkApex()
        document.body.style.cursor = 'auto'
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [
    camera,
    gl,
    beginDragLinkApex,
    updateDragLinkApex,
    endDragLinkApex,
    enterConstructionLens,
  ])

  useFrame((_, dt) => {
    const target = linkFocusId || links.some((l) => l.apex) ? 1 : 0
    blend.current += (target - blend.current) * Math.min(1, 4.2 * dt)

    for (const b of beams) {
      const homeA = pageHomePosition(b.from.strandIndex, total)
      const homeB = pageHomePosition(b.to.strandIndex, total)
      const softA = linkFocusPose(b.from.strandIndex, b.to.strandIndex, total)
      const softB = linkFocusPose(b.to.strandIndex, b.from.strandIndex, total)

      let pageA: [number, number, number]
      let pageB: [number, number, number]
      let apex: [number, number, number]
      let planarBasis:
        | { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 }
        | undefined

      const inConstruction =
        constructionLinkId === b.link.id ||
        retrospectiveLinkId === b.link.id

      if (inConstruction) {
        // Rail/crossing: pages home, mid climbs M→C.
        // Planar: coplanar pages + mid identified with C (hole).
        const tri = triangleForLink(b.from, b.to, total, null)
        if (tri) {
          const depth =
            retrospectiveLinkId === b.link.id
              ? 'commentNear'
              : constructionDepth
          const planar = constructionStage === 'planar'
          if (planar) {
            const sameStrand = b.from.strandIndex === b.to.strandIndex
            pageA = constructionCoplanarPagePose(
              tri,
              'from',
              depth,
              constructionSpread,
              {
                sameStrand,
                alignLocalY: sameStrand
                  ? 0
                  : emphasisPageLocalY(b.from),
              },
            )
            pageB = constructionCoplanarPagePose(
              tri,
              'to',
              depth,
              constructionSpread,
              {
                sameStrand,
                alignLocalY: sameStrand ? 0 : emphasisPageLocalY(b.to),
              },
            )
            apex = tri.c
            // Same face-on basis as PageMesh (camera), not MC axis — else coils miss
            planarBasis = pageBasisFacingCamera(camera)
          } else {
            pageA = homeA
            pageB = homeB
            apex = [0, 0, 0] // filled below from visual AB mid
          }
        } else {
          pageA = homeA
          pageB = homeB
          apex =
            b.link.commentCenter ??
            interlayerApexBetween(homeA, homeB, { inset: 0.9 })
        }
      } else if (b.link.apex) {
        // Keep pages at home; apex only deforms the beam shape.
        apex = clampApexToInterlayer(b.link.apex, homeA, homeB)
        pageA = homeA
        pageB = homeB
      } else if (linkFocusId === b.link.id) {
        const t = blend.current
        pageA = lerpPose(homeA, softA, t)
        pageB = lerpPose(homeB, softB, t)
        apex = interlayerApexBetween(pageA, pageB, { inset: 0.9 })
      } else {
        pageA = homeA
        pageB = homeB
        // Soft sag through the shell interlayer (inside the page sphere)
        apex = interlayerApexBetween(homeA, homeB, { inset: 0.92 })
      }

      const aW =
        emphasisLiveWorldAt(b.from, 0.16) ??
        emphasisRenderWorldAt(b.from, total, pageA, 0.16, planarBasis)
      const cW =
        emphasisLiveWorldAt(b.to, 0.16) ??
        emphasisRenderWorldAt(b.to, total, pageB, 0.16, planarBasis)
      const a = new THREE.Vector3(aW[0], aW[1], aW[2])
      const c = new THREE.Vector3(cW[0], cW[1], cW[2])

      // Rail construction: draggable mid must sit on A–B chord (lift=0), then climb to C
      if (
        inConstruction &&
        constructionStage !== 'planar' &&
        (constructionLinkId === b.link.id ||
          retrospectiveLinkId === b.link.id)
      ) {
        const tri = triangleForLink(b.from, b.to, total, null)
        if (tri) {
          apex = liftedMidTowardComment(
            aW,
            cW,
            tri.c,
            constructionStage === 'crossing' ? 1 : constructionMidLift,
          )
        }
      }

      const peak = new THREE.Vector3(apex[0], apex[1], apex[2])

      const refs = meshRefs.current.get(b.link.id)
      if (!refs) continue
      const hot =
        linkFocusId === b.link.id ||
        constructionLinkId === b.link.id ||
        retrospectiveLinkId === b.link.id ||
        draggingLinkId === b.link.id ||
        Boolean(b.link.apex) ||
        selectedId === b.from.id ||
        selectedId === b.to.id
      const planar =
        inConstruction && constructionStage === 'planar'
      // Fat tubes read as “line grazes the top of the coil”; keep hairline centre
      const radius = planar ? (hot ? 0.018 : 0.012) : hot ? 0.055 : 0.035
      placeSegment(refs.legA, a, peak, radius)
      placeSegment(refs.legB, c, peak, radius)
      // Hide A–B base in planar — it paints a second band across the page
      if (refs.base) {
        if (planar) {
          refs.base.visible = false
        } else {
          refs.base.visible = true
          placeSegment(refs.base, a, c, radius * 0.45)
        }
      }
      if (refs.pinA) {
        refs.pinA.visible = true
        refs.pinA.position.copy(a)
      }
      if (refs.pinB) {
        refs.pinB.visible = true
        refs.pinB.position.copy(c)
      }
      if (refs.apex) {
        refs.apex.position.copy(peak)
        if (inConstruction) {
          refs.apex.visible =
            constructionStage === 'rail' && constructionMidLift < 0.995
        } else {
          refs.apex.visible = true
        }
      }
      if (refs.hit) refs.hit.position.copy(peak)
    }
  })

  const onGrabDown = (linkId: string, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const lens = useDocuverse.getState().cameraLens
    // Construction / retrospective: no spring pull — Target B keeps pages at home
    if (
      (lens === 'construction' || lens === 'retrospective') &&
      (constructionLinkId === linkId || retrospectiveLinkId === linkId)
    ) {
      return
    }
    const p = e.point
    pending.current = {
      linkId,
      pointerId: e.pointerId,
      originX: e.clientX,
      originY: e.clientY,
      startPoint: [p.x, p.y, p.z],
      armed: false,
    }
    try {
      gl.domElement.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    document.body.style.cursor = 'grabbing'
  }

  return (
    <group>
      {beams.map(({ link }) => {
        const hot =
          linkFocusId === link.id ||
          constructionLinkId === link.id ||
          retrospectiveLinkId === link.id ||
          draggingLinkId === link.id ||
          Boolean(link.apex)
        const color = hot ? PURPLE_HOT : PURPLE
        const ensure = () => {
          let r = meshRefs.current.get(link.id)
          if (!r) {
            r = {
              legA: null,
              legB: null,
              base: null,
              apex: null,
              hit: null,
              pinA: null,
              pinB: null,
            }
            meshRefs.current.set(link.id, r)
          }
          return r
        }
        const down = (e: ThreeEvent<PointerEvent>) => onGrabDown(link.id, e)
        const lensBusy =
          (cameraLens === 'construction' || cameraLens === 'retrospective') &&
          (constructionLinkId === link.id || retrospectiveLinkId === link.id)
        // Construction journey: don't steal zipper / page hits
        const pick = lensBusy
          ? { raycast: noHit }
          : {
              onPointerDown: down,
              onPointerOver: () => {
                document.body.style.cursor = 'grab'
              },
              onPointerOut: () => {
                if (!draggingLinkId && !pending.current) {
                  document.body.style.cursor = 'auto'
                }
              },
            }
        return (
          <group key={link.id} renderOrder={20}>
            <mesh
              ref={(m) => {
                ensure().legA = m
              }}
              renderOrder={20}
              {...pick}
            >
              <cylinderGeometry args={[0.05, 0.05, 1, 10]} />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={0.42}
                depthWrite={false}
                depthTest={true}
              />
            </mesh>
            <mesh
              ref={(m) => {
                ensure().legB = m
              }}
              renderOrder={20}
              {...pick}
            >
              <cylinderGeometry args={[0.05, 0.05, 1, 10]} />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={0.42}
                depthWrite={false}
                depthTest={true}
              />
            </mesh>
            <mesh
              ref={(m) => {
                ensure().base = m
              }}
              renderOrder={19}
              {...pick}
            >
              <cylinderGeometry args={[0.05, 0.05, 1, 8]} />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={0.32}
                depthWrite={false}
                depthTest={true}
              />
            </mesh>
            <mesh
              ref={(m) => {
                ensure().pinA = m
              }}
              raycast={noHit}
              renderOrder={24}
            >
              <sphereGeometry args={[0.07, 12, 12]} />
              <meshBasicMaterial
                color="#ffffff"
                transparent
                opacity={0.95}
                depthWrite={false}
                depthTest={false}
              />
            </mesh>
            <mesh
              ref={(m) => {
                ensure().pinB = m
              }}
              raycast={noHit}
              renderOrder={24}
            >
              <sphereGeometry args={[0.07, 12, 12]} />
              <meshBasicMaterial
                color="#ffffff"
                transparent
                opacity={0.95}
                depthWrite={false}
                depthTest={false}
              />
            </mesh>
            <mesh
              ref={(m) => {
                ensure().apex = m
              }}
              raycast={noHit}
              renderOrder={22}
            >
              <sphereGeometry args={[hot ? 0.18 : 0.12, 16, 16]} />
              <meshBasicMaterial color={color} depthWrite={false} />
            </mesh>
            <mesh
              ref={(m) => {
                ensure().hit = m
              }}
              renderOrder={23}
              {...pick}
            >
              <sphereGeometry args={[0.45, 16, 16]} />
              <meshBasicMaterial
                transparent
                opacity={0.001}
                depthWrite={false}
              />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}
