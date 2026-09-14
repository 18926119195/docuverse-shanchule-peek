import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useDocuverse } from './store'
import { PAGE_H, PAGE_W } from './geometry'
import {
  pagePointToLocal,
  polygonCentroid,
  regionCentroid,
  type PagePoint,
} from '../data/emphasis'
import {
  emphasisStrokeColor,
  pageDraftStrokeColor,
  type EmphasisStrokeRole,
} from './emphasisStroke'
import { LiveInkTrail } from './LiveInkTrail'
import { useReasoning } from '../reasoning/closureStore'

const noHit = (() => undefined) as unknown as THREE.Mesh['raycast']

/**
 * Sealed emphases: outline only — never fill / solid disc over the page.
 * Color is page-keyed; same-page coils get brighter for newer seals.
 * Invisible hit disc keeps click-to-select without covering text.
 */
function polygonLocalPoints(
  polygon: PagePoint[],
  close: boolean,
): [number, number, number][] {
  const pts = polygon.map(([x, y]) => {
    const [lx, ly] = pagePointToLocal([x, y], PAGE_W, PAGE_H)
    return [lx, ly, 0.16] as [number, number, number]
  })
  if (close && pts.length > 2) {
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) {
      pts.push(first)
    }
  }
  return pts
}

function bboxOutline(
  bbox: [number, number, number, number],
): [number, number, number][] {
  const [x0, y0, x1, y1] = bbox
  const corners: PagePoint[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ]
  return corners.map(([x, y]) => {
    const [lx, ly] = pagePointToLocal([x, y], PAGE_W, PAGE_H)
    return [lx, ly, 0.17] as [number, number, number]
  })
}

export function EmphasisOverlay({
  strandIndex,
  isCurrent,
}: {
  strandIndex: number
  isCurrent: boolean
}) {
  const edges = useDocuverse((s) => s.emphasisEdges)
  const selectedId = useDocuverse((s) => s.selectedEmphasisId)
  const emphasisLinkFromId = useDocuverse((s) => s.emphasisLinkFromId)
  const setEmphasisLinkFrom = useDocuverse((s) => s.setEmphasisLinkFrom)
  const createEmphasisLink = useDocuverse((s) => s.createEmphasisLink)
  const selectEmphasis = useDocuverse((s) => s.selectEmphasis)
  const draft = useDocuverse((s) => s.emphasisDraftPoints)
  const draftStrand = useDocuverse((s) => s.emphasisDraftStrand)
  const emphasizeMode = useDocuverse((s) => s.emphasizeMode)
  const strokeActive = useDocuverse((s) => s.emphasisStrokeActive)
  const cameraLens = useDocuverse((s) => s.cameraLens)
  const constructionLinkId = useDocuverse((s) => s.constructionLinkId)
  const retrospectiveLinkId = useDocuverse((s) => s.retrospectiveLinkId)
  const links = useDocuverse((s) => s.emphasisLinks)
  const lockBoxes = useReasoning((s) => s.lockBoxes)

  const mine = useMemo(
    () => edges.filter((e) => e.strandIndex === strandIndex),
    [edges, strandIndex],
  )

  const relationFigureIds = useMemo(() => {
    const lensOn =
      cameraLens === 'construction' || cameraLens === 'retrospective'
    const linkId = constructionLinkId ?? retrospectiveLinkId
    if (!lensOn || !linkId) return null as Set<string> | null
    const link = links.find((l) => l.id === linkId)
    if (!link) return null
    return new Set([link.fromEmphasisId, link.toEmphasisId])
  }, [cameraLens, constructionLinkId, retrospectiveLinkId, links])

  // Paused draft (pointer up, not sealed)
  const pausedDraftPts = useMemo(() => {
    if (strokeActive) return null
    const src =
      draftStrand === strandIndex || (draftStrand === null && isCurrent)
        ? draft
        : null
    if (!src || src.length < 2) return null
    return polygonLocalPoints(src, false)
  }, [strokeActive, draft, draftStrand, strandIndex, isCurrent])

  const waitingForB = Boolean(emphasisLinkFromId)
  const draftColor = pageDraftStrokeColor(strandIndex)

  const onEmphasisPointer = (edgeId: string, button: number) => {
    if (button !== 0) return
    if (emphasizeMode) return
    if (emphasisLinkFromId) {
      if (emphasisLinkFromId === edgeId) {
        setEmphasisLinkFrom(null)
        return
      }
      createEmphasisLink(edgeId)
      return
    }
    selectEmphasis(edgeId)
  }

  return (
    <group>
      {lockBoxes
        .filter((b) => b.page === strandIndex)
        .map((b, i) => {
          const loop = bboxOutline(b.bbox)
          const focus = b.focus === true
          return loop.length >= 2 ? (
            <Line
              key={`lock-${i}-${b.bbox.join(',')}-${focus ? 'f' : 'a'}`}
              points={loop}
              color={focus ? '#7dffc4' : '#5cffb1'}
              lineWidth={focus ? 3.4 : 2.4}
              dashed={!focus}
              dashScale={focus ? 1 : 8}
            />
          ) : null
        })}
      {mine.map((edge) => {
        const isRelationFigure = relationFigureIds?.has(edge.id) ?? false
        const isA = edge.id === emphasisLinkFromId
        const isSel = edge.id === selectedId && !waitingForB
        const isB = waitingForB && !isA
        let role: EmphasisStrokeRole = 'default'
        if (isRelationFigure) role = 'relation'
        else if (isA) role = 'linkFrom'
        else if (isB) role = 'linkTarget'
        else if (isSel) role = 'selected'
        const lineColor = emphasisStrokeColor(edge, mine, role)
        const loop = polygonLocalPoints(edge.region.polygon, true)
        const [x0, y0, x1, y1] = edge.region.aabb
        const anchorUv =
          edge.region.polygon.length >= 3
            ? polygonCentroid(edge.region.polygon)
            : regionCentroid(edge.region.aabb)
        const [cx, cy] = pagePointToLocal(anchorUv, PAGE_W, PAGE_H)
        const [lx0, ly0] = pagePointToLocal([x0, y0], PAGE_W, PAGE_H)
        const [lx1, ly1] = pagePointToLocal([x1, y1], PAGE_W, PAGE_H)
        const hitR = Math.max(
          0.14,
          Math.min(
            0.55,
            0.35 * Math.min(Math.abs(lx1 - lx0), Math.abs(ly1 - ly0)),
          ),
        )
        const hot = isRelationFigure || isA || isB || isSel
        return (
          <group key={edge.id}>
            {loop.length >= 2 && (
              <Line
                points={loop}
                color={lineColor}
                lineWidth={hot ? 3.5 : 2.5}
              />
            )}
            <mesh
              position={[cx, cy, 0.18]}
              raycast={emphasizeMode ? noHit : undefined}
              onPointerDown={(e) => {
                e.stopPropagation()
                onEmphasisPointer(edge.id, e.button)
              }}
              onPointerOver={() => {
                if (!emphasizeMode) {
                  document.body.style.cursor = waitingForB
                    ? 'cell'
                    : 'pointer'
                }
              }}
              onPointerOut={() => {
                document.body.style.cursor = 'auto'
              }}
            >
              <circleGeometry args={[Math.min(hitR, 0.22), 16]} />
              <meshBasicMaterial
                color={lineColor}
                transparent
                opacity={hot ? 0.55 : 0.28}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          </group>
        )
      })}

      <LiveInkTrail strandIndex={strandIndex} />
      {pausedDraftPts && pausedDraftPts.length >= 2 && (
        <Line points={pausedDraftPts} color={draftColor} lineWidth={4} />
      )}
    </group>
  )
}
