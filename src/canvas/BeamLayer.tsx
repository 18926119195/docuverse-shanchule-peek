import { useMemo } from 'react'
import * as THREE from 'three'
import type { PageDocument, ResolvedConnection } from '../zigzag/types'
import { PAGE_H, PAGE_W, connectionColor, pageLocalToWorld } from './geometry'
import { spanCornerPoints } from '../zigzag/edl'
import { bboxToLocalRect } from '../data/ocrService'
import { useDocuverse } from './store'

interface BeamLayerProps {
  pages: PageDocument[]
  connections: ResolvedConnection[]
  currentStrand: number
  companionStrand: number
  currentConnectionId: string | null
}

function endpointFromOffset(
  page: PageDocument,
  strand: number,
  offset: number,
  size: number,
  total: number,
): THREE.Vector3 {
  const corners = spanCornerPoints(
    page.text,
    offset,
    Math.min(size, 80),
    PAGE_W,
    PAGE_H,
  )
  const x = (corners.topLeft[0] + corners.topRight[0]) / 2
  const y = (corners.topLeft[1] + corners.bottomLeft[1]) / 2
  const w = pageLocalToWorld(strand, total, [x, y, 0.05])
  return new THREE.Vector3(w[0], w[1], w[2])
}

function endpointFromBbox(
  bbox: [number, number, number, number],
  strand: number,
  total: number,
): THREE.Vector3 {
  const rect = bboxToLocalRect(bbox, PAGE_W, PAGE_H, 0)
  const w = pageLocalToWorld(strand, total, [rect.x, rect.y, 0.05])
  return new THREE.Vector3(w[0], w[1], w[2])
}

function connectionEndpoint(
  page: PageDocument,
  strand: number,
  offset: number,
  size: number,
  total: number,
  bbox?: [number, number, number, number],
): THREE.Vector3 {
  if (bbox) return endpointFromBbox(bbox, strand, total)
  return endpointFromOffset(page, strand, offset, size, total)
}

export function BeamLayer({
  pages,
  connections,
  currentConnectionId,
}: BeamLayerProps) {
  const traverseAlongPair = useDocuverse((s) => s.traverseAlongPair)
  const byStrand = useMemo(
    () => new Map(pages.map((p) => [p.strandIndex, p])),
    [pages],
  )
  const total = pages.length

  const beams = useMemo(() => {
    return connections
      .map((c) => {
        const fromPage = byStrand.get(c.fromStrand)
        const toPage = byStrand.get(c.toStrand)
        if (!fromPage || !toPage) return null
        const a = connectionEndpoint(
          fromPage,
          c.fromStrand,
          c.fromPageOffset,
          c.fromSize,
          total,
          c.fromBbox,
        )
        const b = connectionEndpoint(
          toPage,
          c.toStrand,
          c.toPageOffset,
          c.toSize,
          total,
          c.toBbox,
        )
        const isCurrent = c.id === currentConnectionId
        const mid = a.clone().lerp(b, 0.5)
        const dir = b.clone().sub(a)
        const len = dir.length()
        if (len < 0.001) return null
        const quat = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          dir.clone().normalize(),
        )
        return { c, a, b, mid, len, quat, isCurrent }
      })
      .filter(Boolean) as {
      c: ResolvedConnection
      a: THREE.Vector3
      b: THREE.Vector3
      mid: THREE.Vector3
      len: number
      quat: THREE.Quaternion
      isCurrent: boolean
    }[]
  }, [connections, byStrand, currentConnectionId, total])

  const noHit = (() => undefined) as unknown as THREE.Mesh['raycast']
  const emphasizeMode = useDocuverse((s) => s.emphasizeMode)
  const cameraLens = useDocuverse((s) => s.cameraLens)
  const relationLens =
    cameraLens === 'construction' || cameraLens === 'retrospective'
  // 建联对照 / 强调笔：勿抢拉链与页面
  const muteHits = emphasizeMode || relationLens

  return (
    <group>
      {beams.map(({ c, mid, len, quat, isCurrent, a, b }) => {
        const color = connectionColor(c, isCurrent)
        const radius = isCurrent ? 0.07 : c.kind === 'transclusion' ? 0.05 : 0.028
        return (
          <group key={c.id}>
            <mesh position={mid} quaternion={quat} raycast={noHit}>
              <cylinderGeometry args={[radius, radius, Math.max(0.1, len), 8]} />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={isCurrent ? 0.95 : 0.45}
                depthWrite={false}
              />
            </mesh>
            <mesh position={mid} quaternion={quat} raycast={noHit}>
              <boxGeometry
                args={[isCurrent ? 0.55 : 0.28, Math.max(0.1, len), 0.01]}
              />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={isCurrent ? 0.35 : 0.12}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            <mesh position={a} raycast={noHit}>
              <sphereGeometry args={[isCurrent ? 0.09 : 0.05, 12, 12]} />
              <meshBasicMaterial color={color} />
            </mesh>
            <mesh position={b} raycast={noHit}>
              <sphereGeometry args={[isCurrent ? 0.09 : 0.05, 12, 12]} />
              <meshBasicMaterial color={color} />
            </mesh>
            {/* Fat hit volume: click → Nelson current↔companion along this beam */}
            <mesh
              position={mid}
              quaternion={quat}
              raycast={muteHits ? noHit : undefined}
              onClick={(e) => {
                if (muteHits) return
                e.stopPropagation()
                traverseAlongPair(c.fromStrand, c.toStrand, {
                  connectionId: c.id,
                })
              }}
              onPointerDown={(e) => {
                if (muteHits) return
                e.stopPropagation()
                if (e.button !== 0) return
                traverseAlongPair(c.fromStrand, c.toStrand, {
                  connectionId: c.id,
                })
              }}
              onPointerOver={() => {
                if (!muteHits) document.body.style.cursor = 'pointer'
              }}
              onPointerOut={() => {
                document.body.style.cursor = 'auto'
              }}
            >
              <cylinderGeometry
                args={[0.28, 0.28, Math.max(0.3, len), 8]}
              />
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
