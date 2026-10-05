import { Suspense, useEffect, useMemo, useRef } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import * as THREE from 'three'
import type { PageDocument, ResolvedConnection } from '../zigzag/types'
import { PAGE_H, PAGE_W, connectionColor, linkFocusPose, lerpPose, pageHomeQuaternion, pageQuaternionFromOutward } from './geometry'
import { resolveParkedPoseForStrand } from './linkPark'
import {
  constructionCoplanarPagePose,
  constructionSideForStrand,
  emphasisPageLocalY,
  triangleForLink,
} from './constructionCamera'
import { spanCornerPoints } from '../zigzag/edl'
import { bboxToLocalRect } from '../data/ocrService'
import { OcrSourceHighlights } from './OcrComparePlane'
import { EmphasisOverlay } from './EmphasisOverlay'
import { PageTextureLodView } from './pageTextureLodView'
import { useDocuverse } from './store'
import { registerPageSurface } from './pageSurfaceRegistry'
import { getEmphasisAim } from './emphasisAim'

interface PageMeshProps {
  page: PageDocument
  homePosition: [number, number, number]
  role: 'current' | 'companion' | 'background'
  connections: ResolvedConnection[]
  currentConnectionId: string | null
  onSelectConnection: (id: string) => void
  onSwoopToPage: (strandIndex: number) => void
}

function wrapText(text: string, width = 46): string {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width) {
        lines.push(line)
        line = word
      } else {
        line = (line + ' ' + word).trim()
      }
    }
    if (line) lines.push(line)
  }
  return lines.slice(0, 42).join('\n')
}

const noRaycast = (() => undefined) as unknown as THREE.Mesh['raycast']

function PaperFallback({ opacity }: { opacity: number }) {
  return (
    <mesh castShadow receiveShadow raycast={noRaycast}>
      <planeGeometry args={[PAGE_W, PAGE_H]} />
      <meshBasicMaterial color="#e8e4da" transparent opacity={opacity} />
    </mesh>
  )
}

export function PageMesh({
  page,
  homePosition,
  role,
  connections,
  currentConnectionId,
  onSelectConnection,
  onSwoopToPage,
}: PageMeshProps) {
  const group = useRef<THREE.Group>(null)
  const frameMat = useRef<THREE.MeshBasicMaterial>(null)
  const hasImage = Boolean(page.imageUrl)
  const ocrOpen = useDocuverse((s) => s.ocrOpen)
  const ocrActiveStrand = useDocuverse((s) => s.ocrActiveStrand)
  const addOcrBlockAtLocalPoint = useDocuverse((s) => s.addOcrBlockAtLocalPoint)
  const emphasizeMode = useDocuverse((s) => s.emphasizeMode)
  const currentStrand = useDocuverse((s) => s.currentStrand)
  const emphasisDraftStrand = useDocuverse((s) => s.emphasisDraftStrand)
  const linkFocusId = useDocuverse((s) => s.linkFocusId)
  const draggingLinkId = useDocuverse((s) => s.draggingLinkId)
  const emphasisLinks = useDocuverse((s) => s.emphasisLinks)
  const emphasisEdges = useDocuverse((s) => s.emphasisEdges)
  const pageCount = useDocuverse((s) => s.pages.length)
  const preferParkLinkId = draggingLinkId ?? linkFocusId

  const isAimOrStrokePage =
    emphasizeMode &&
    (page.strandIndex === currentStrand ||
      page.strandIndex === getEmphasisAim() ||
      page.strandIndex === emphasisDraftStrand)

  const focusPartner = useMemo(() => {
    if (!linkFocusId) return null
    const link = emphasisLinks.find((l) => l.id === linkFocusId)
    if (!link) return null
    const from = emphasisEdges.find((e) => e.id === link.fromEmphasisId)
    const to = emphasisEdges.find((e) => e.id === link.toEmphasisId)
    if (!from || !to) return null
    if (page.strandIndex === from.strandIndex) return to.strandIndex
    if (page.strandIndex === to.strandIndex) return from.strandIndex
    return null
  }, [linkFocusId, emphasisLinks, emphasisEdges, page.strandIndex])

  const parkedPose = useMemo(
    () =>
      resolveParkedPoseForStrand(
        page.strandIndex,
        emphasisLinks,
        emphasisEdges,
        preferParkLinkId,
        pageCount,
      ),
    [page.strandIndex, emphasisLinks, emphasisEdges, preferParkLinkId, pageCount],
  )

  const inLinkFocus = focusPartner !== null || parkedPose !== null
  const cameraLens = useDocuverse((s) => s.cameraLens)
  const constructionDepth = useDocuverse((s) => s.constructionDepth)
  const constructionSpread = useDocuverse((s) => s.constructionSpread)
  const constructionStage = useDocuverse((s) => s.constructionStage)
  const constructionLinkId = useDocuverse((s) => s.constructionLinkId)
  const retrospectiveLinkId = useDocuverse((s) => s.retrospectiveLinkId)
  const tetraAnchorLinkId = useDocuverse((s) => s.tetraAnchorLinkId)
  const tetraCandidateDId = useDocuverse((s) => s.tetraCandidateDId)

  /** Strands that belong to the active relation (A,B and optional D) — stay bright */
  const relationHot = useMemo(() => {
    const lensOn =
      cameraLens === 'construction' ||
      cameraLens === 'retrospective' ||
      cameraLens === 'tetrahedron'
    if (!lensOn) return null as Set<number> | null
    const linkId =
      cameraLens === 'tetrahedron'
        ? tetraAnchorLinkId
        : (constructionLinkId ?? retrospectiveLinkId)
    if (!linkId) return null
    const link = emphasisLinks.find((l) => l.id === linkId)
    if (!link) return null
    const hot = new Set<number>()
    for (const id of [link.fromEmphasisId, link.toEmphasisId, tetraCandidateDId]) {
      if (!id) continue
      const e = emphasisEdges.find((x) => x.id === id)
      if (e) hot.add(e.strandIndex)
    }
    return hot
  }, [
    cameraLens,
    constructionLinkId,
    retrospectiveLinkId,
    tetraAnchorLinkId,
    tetraCandidateDId,
    emphasisLinks,
    emphasisEdges,
  ])

  const focusDimmed =
    (Boolean(linkFocusId) && focusPartner === null && parkedPose === null) ||
    (relationHot !== null && !relationHot.has(page.strandIndex))

  const relationBright =
    relationHot !== null && relationHot.has(page.strandIndex)

  // Hide non-pair pages only after 穿洞 → planar 俯视
  // 强调笔开启时：全局可见可批注，不藏页
  const hideForRelationLens =
    !emphasizeMode &&
    (cameraLens === 'construction' || cameraLens === 'retrospective') &&
    relationHot !== null &&
    !relationBright &&
    constructionStage === 'planar'

  const opacity = emphasizeMode && focusDimmed
    ? 0.55
    : focusDimmed
      ? relationHot
        ? 0.08
        : 0.22
      : relationBright
        ? 1
        : role === 'current'
          ? 1
          : role === 'companion'
            ? 0.98
            : parkedPose
              ? 0.95
              : 0.82
  const paper = role === 'background' && !relationBright ? '#dfe3ec' : '#f7f4ec'
  const scale =
    relationBright &&
    (cameraLens === 'construction' || cameraLens === 'retrospective') &&
    constructionStage === 'planar'
      ? constructionDepth === 'commentNear'
        ? 0.88
        : 1.0
      : inLinkFocus || parkedPose || relationBright
        ? 1.06
        : focusDimmed && relationHot
          ? 0.88
          : role === 'current'
            ? 1.04
            : role === 'companion'
              ? 1.0
              : 0.92

  const coplanarPose = useMemo((): [number, number, number] | null => {
    const lensOn =
      cameraLens === 'construction' || cameraLens === 'retrospective'
    if (!lensOn || !relationBright || constructionStage !== 'planar') {
      return null
    }
    const linkId = constructionLinkId ?? retrospectiveLinkId
    if (!linkId) return null
    const link = emphasisLinks.find((l) => l.id === linkId)
    if (!link) return null
    const from = emphasisEdges.find((e) => e.id === link.fromEmphasisId)
    const to = emphasisEdges.find((e) => e.id === link.toEmphasisId)
    if (!from || !to) return null
    const side = constructionSideForStrand(
      page.strandIndex,
      from.strandIndex,
      to.strandIndex,
    )
    if (!side) return null
    const tri = triangleForLink(from, to, Math.max(pageCount, 1), null)
    if (!tri) return null
    const sameStrand = from.strandIndex === to.strandIndex
    const alignEdge = side === 'from' ? from : to
    return constructionCoplanarPagePose(
      tri,
      side,
      cameraLens === 'retrospective' ? 'commentNear' : constructionDepth,
      constructionSpread,
      {
        sameStrand,
        alignLocalY: sameStrand ? 0 : emphasisPageLocalY(alignEdge),
      },
    )
  }, [
    cameraLens,
    constructionDepth,
    constructionSpread,
    constructionStage,
    constructionLinkId,
    retrospectiveLinkId,
    relationBright,
    emphasisLinks,
    emphasisEdges,
    page.strandIndex,
    pageCount,
  ])

  // Same PageMesh instance as on the home sphere — only world pose changes in planar.
  useEffect(() => {
    registerPageSurface(page.strandIndex, group.current)
    return () => registerPageSurface(page.strandIndex, null)
  }, [page.strandIndex])

  // Re-bind after first commit when ref is ready (once, not every frame)
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      registerPageSurface(page.strandIndex, group.current)
    })
    return () => cancelAnimationFrame(id)
  }, [page.strandIndex, hideForRelationLens])

  /**
   * Planar only: pages face camera on shared image plane.
   * Rail / crossing: stay at semantic home (穿越感).
   */
  const lockFaceOn =
    relationBright &&
    constructionStage === 'planar' &&
    (cameraLens === 'construction' || cameraLens === 'retrospective')

  const relevant = useMemo(
    () =>
      connections.filter(
        (c) => c.fromStrand === page.strandIndex || c.toStrand === page.strandIndex,
      ),
    [connections, page.strandIndex],
  )

  useFrame(({ camera }, dt) => {
    if (!group.current) return
    const aimed =
      emphasizeMode && getEmphasisAim() === page.strandIndex

    // Instant aim feedback (no React) — prepared drawable range
    if (frameMat.current) {
      if (aimed) {
        frameMat.current.color.set('#ffe0ff')
        frameMat.current.opacity = 0.88
      } else if (relationBright) {
        frameMat.current.color.set('#e040fb')
        frameMat.current.opacity =
          focusDimmed && relationHot ? 0.04 : 0.75
      } else if (role === 'current') {
        frameMat.current.color.set('#ffd700')
        frameMat.current.opacity =
          focusDimmed && relationHot ? 0.04 : 0.5
      } else if (role === 'companion') {
        frameMat.current.color.set('#00e5ff')
        frameMat.current.opacity =
          focusDimmed && relationHot ? 0.04 : 0.5
      } else {
        frameMat.current.color.set('#2a3344')
        frameMat.current.opacity =
          focusDimmed && relationHot ? 0.04 : 0.12
      }
    }

    // Drawing: freeze page pose/scale so UV hits stay where the finger started
    if (useDocuverse.getState().emphasisStrokeActive) return

    // Aim feedback is border-only — never scale (scale reads as “拉近跳动”)
    const s = THREE.MathUtils.damp(group.current.scale.x, scale, 6, dt)
    group.current.scale.setScalar(s)

    let target: [number, number, number] = homePosition
    if (lockFaceOn && coplanarPose) {
      target = coplanarPose
    } else if (!lockFaceOn) {
      if (parkedPose) {
        target = parkedPose
      } else if (inLinkFocus && focusPartner !== null) {
        target = linkFocusPose(
          page.strandIndex,
          focusPartner,
          Math.max(pageCount, 1),
        )
      }
    }
    const p = group.current.position
    const dx = target[0] - p.x
    const dy = target[1] - p.y
    const dz = target[2] - p.z
    const distSq = dx * dx + dy * dy + dz * dz
    // Background pages at rest: skip expensive lerp/slerp
    if (
      !lockFaceOn &&
      !parkedPose &&
      !inLinkFocus &&
      distSq < 1e-6 &&
      Math.abs(group.current.scale.x - scale) < 1e-4
    ) {
      return
    }
    const next = lerpPose(
      [p.x, p.y, p.z],
      target,
      1 -
        Math.exp(
          -(useDocuverse.getState().draggingLinkId ? 7.5 : 4.2) * dt,
        ),
    )
    group.current.position.set(next[0], next[1], next[2])

    if (lockFaceOn) {
      const look = new THREE.Vector3()
      camera.getWorldDirection(look)
      if (look.lengthSq() > 1e-10) {
        const q = pageQuaternionFromOutward(look.negate())
        group.current.quaternion.slerp(q, 1 - Math.exp(-5 * dt))
      }
    } else if (distSq > 1e-5 || inLinkFocus || parkedPose) {
      const outward = new THREE.Vector3(next[0], next[1], next[2])
      if (outward.lengthSq() > 1e-8) {
        const q = pageQuaternionFromOutward(outward.normalize())
        group.current.quaternion.slerp(q, 1 - Math.exp(-5 * dt))
      }
    }
  })

  const enterPage = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>) => {
    // R3F pointer listeners are often passive — do not call native preventDefault.
    e.stopPropagation()
    onSwoopToPage(page.strandIndex)
  }

  const onPagePointerDown = (e: ThreeEvent<PointerEvent>) => {
    // Emphasize pen is owned by EmphasisPenController (canvas pick → same page_norm store)
    if (emphasizeMode && e.button === 0) return
    e.stopPropagation()
    if (
      ocrOpen &&
      ocrActiveStrand === page.strandIndex &&
      e.altKey &&
      e.button === 0
    ) {
      const local = group.current
        ? group.current.worldToLocal(e.point.clone())
        : e.object.worldToLocal(e.point.clone())
      addOcrBlockAtLocalPoint(local.x, local.y)
      return
    }
    if (e.button === 0) {
      const lens = useDocuverse.getState().cameraLens
      if (lens === 'construction' || lens === 'retrospective') return
      enterPage(e)
    }
  }

  const preview = wrapText(page.text)
  const showTextBody = !hasImage && role !== 'background'
  const showConnMarks = role !== 'background' && !emphasizeMode
  // 朝向跟 home 径向走（结算紧凑槽与 strandIndex 可能不一致）
  const initialQuat = useMemo(() => {
    const outward = new THREE.Vector3(
      homePosition[0],
      0,
      homePosition[2],
    )
    if (outward.lengthSq() < 1e-8) {
      return pageHomeQuaternion(page.strandIndex, Math.max(pageCount, 1))
    }
    return pageQuaternionFromOutward(outward.normalize())
  }, [homePosition, page.strandIndex, pageCount])

  // Do NOT bind position/quaternion as React props — R3F would reset them on
  // every store-driven re-render and cancel construction parallel alignment.
  // Relation lenses: useFrame owns pose — never snap back to sphere home.
  useEffect(() => {
    if (!group.current) return
    const lens = useDocuverse.getState().cameraLens
    if (
      lens === 'construction' ||
      lens === 'retrospective' ||
      lens === 'tetrahedron'
    ) {
      return
    }
    group.current.position.set(
      homePosition[0],
      homePosition[1],
      homePosition[2],
    )
    group.current.quaternion.copy(initialQuat)
  }, [homePosition, initialQuat])

  return (
    <group
      ref={group}
      visible={!hideForRelationLens}
      userData={{ strandIndex: page.strandIndex, title: page.title }}
    >
      <mesh
        position={[0, 0, 0.06]}
        userData={{ strandIndex: page.strandIndex }}
        raycast={
          (cameraLens === 'construction' ||
            cameraLens === 'retrospective') &&
          !emphasizeMode
            ? noRaycast
            : undefined
        }
        onPointerDown={onPagePointerDown}
        onContextMenu={(e) => {
          e.stopPropagation()
          e.nativeEvent.preventDefault()
        }}
        onPointerOver={(e) => {
          e.stopPropagation()
          if (!emphasizeMode) document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          if (!emphasizeMode) document.body.style.cursor = 'default'
        }}
      >
        <planeGeometry args={[PAGE_W, PAGE_H]} />
        <meshBasicMaterial
          transparent
          opacity={0.001}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {hasImage && page.imageUrl ? (
        <Suspense fallback={<PaperFallback opacity={opacity} />}>
          <PageTextureLodView
            url={page.imageUrl}
            opacity={opacity}
            pageGroup={group}
            role={role}
            emphasizeMode={emphasizeMode}
            isAimOrStrokePage={isAimOrStrokePage}
          />
        </Suspense>
      ) : (
        <mesh castShadow receiveShadow raycast={noRaycast}>
          <planeGeometry args={[PAGE_W, PAGE_H]} />
          <meshPhysicalMaterial
            color={paper}
            roughness={0.55}
            metalness={0}
            transparent
            opacity={opacity}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      <mesh position={[0, 0, -0.02]} raycast={noRaycast}>
        <planeGeometry args={[PAGE_W + 0.18, PAGE_H + 0.18]} />
        <meshBasicMaterial
          ref={frameMat}
          color={
            relationBright
              ? '#e040fb'
              : role === 'current'
                ? '#ffd700'
                : role === 'companion'
                  ? '#00e5ff'
                  : '#2a3344'
          }
          transparent
          opacity={
            focusDimmed && relationHot
              ? 0.04
              : relationBright
                ? 0.75
                : role === 'background'
                  ? 0.12
                  : 0.5
          }
          side={THREE.DoubleSide}
        />
      </mesh>

      <mesh position={[0, PAGE_H / 2 - 0.35, 0.02]} raycast={noRaycast}>
        <planeGeometry args={[PAGE_W - 0.3, 0.5]} />
        <meshBasicMaterial
          color={
            role === 'current'
              ? '#1a2332'
              : role === 'companion'
                ? '#163042'
                : '#2a3344'
          }
          transparent
          opacity={0.88}
        />
      </mesh>
      <Text
        position={[0, PAGE_H / 2 - 0.35, 0.03]}
        fontSize={0.2}
        color="#f0e6d2"
        anchorX="center"
        anchorY="middle"
        maxWidth={PAGE_W - 0.6}
        raycast={noRaycast}
      >
        {`${page.strandIndex} · ${page.title}`}
      </Text>

      {showTextBody && (
        <Text
          position={[0, 0.2, 0.02]}
          fontSize={0.16}
          color="#1c1a16"
          anchorX="center"
          anchorY="middle"
          maxWidth={PAGE_W - 1.4}
          lineHeight={1.35}
          textAlign="left"
          overflowWrap="break-word"
          raycast={noRaycast}
        >
          {preview}
        </Text>
      )}

      {!hasImage && role === 'background' && (
        <Text
          position={[0, 0, 0.02]}
          fontSize={0.28}
          color="#1c1a16"
          anchorX="center"
          anchorY="middle"
          maxWidth={PAGE_W - 1.2}
          raycast={noRaycast}
        >
          {`#${page.strandIndex}\n点此飞向此页`}
        </Text>
      )}

      {showConnMarks &&
        relevant.map((c) => {
          const isFrom = c.fromStrand === page.strandIndex
          const bbox = isFrom ? c.fromBbox : c.toBbox
          let w: number
          let h: number
          let cx: number
          let cy: number
          if (bbox) {
            const rect = bboxToLocalRect(bbox, PAGE_W, PAGE_H, 0)
            w = Math.max(0.2, rect.w)
            h = Math.max(0.2, rect.h)
            cx = rect.x
            cy = rect.y
          } else {
            const off = isFrom ? c.fromPageOffset : c.toPageOffset
            const size = isFrom ? Math.max(c.fromSize, 8) : Math.max(c.toSize, 8)
            const corners = spanCornerPoints(
              page.text || ' '.repeat(2000),
              off,
              Math.min(size, 120),
              PAGE_W,
              PAGE_H,
            )
            w = Math.max(0.35, corners.topRight[0] - corners.topLeft[0])
            h = Math.max(0.35, corners.topLeft[1] - corners.bottomLeft[1])
            cx = (corners.topLeft[0] + corners.topRight[0]) / 2
            cy = (corners.topLeft[1] + corners.bottomLeft[1]) / 2
          }
          const isCurrent = c.id === currentConnectionId
          return (
            <mesh
              key={c.id + (isFrom ? '_f' : '_t')}
              position={[cx, cy, 0.12]}
              onPointerDown={(e) => {
                e.stopPropagation()
                // Right button reserved for camera orbit
                if (e.button !== 0) return
                onSelectConnection(c.id)
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                onSelectConnection(c.id)
                onSwoopToPage(isFrom ? c.toStrand : c.fromStrand)
              }}
            >
              <planeGeometry args={[w, h]} />
              <meshBasicMaterial
                color={connectionColor(c, isCurrent)}
                transparent
                opacity={isCurrent ? 0.45 : 0.22}
                depthWrite={false}
              />
            </mesh>
          )
        })}

      <EmphasisOverlay
        strandIndex={page.strandIndex}
        isCurrent={role === 'current'}
      />
      <OcrSourceHighlights strandIndex={page.strandIndex} />
    </group>
  )
}
