import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import * as THREE from 'three'
import { useDocuverse } from '../canvas/store'
import { emphasisSurfaceWorld } from '../canvas/surfaceGeometry'
import { yawPitchToRadial, radialToYawPitch } from '../canvas/geometry'
import { emphasisStrokeColor } from '../canvas/emphasisStroke'
import { renderEmphasisTile } from '../data/emphasisCatalog'
import type { EmphasisEdge } from '../data/emphasis'

const MAP_R = 1
const CAM_DIST = 3.15

const noHit = (() => undefined) as unknown as THREE.Mesh['raycast']

function toUnit(
  world: [number, number, number],
): [number, number, number] {
  const v = new THREE.Vector3(...world)
  if (v.lengthSq() < 1e-12) return [0, 0, 1]
  v.normalize().multiplyScalar(MAP_R)
  return [v.x, v.y, v.z]
}

const COIL_RING: [number, number, number][] = (() => {
  const pts: [number, number, number][] = []
  const r = 1
  for (let i = 0; i <= 28; i++) {
    const th = (i / 28) * Math.PI * 2
    pts.push([Math.cos(th) * r, Math.sin(th) * r, 0])
  }
  return pts
})()

/** Hollow coil on the sphere — never a filled disc. */
function StarCoil({
  edge,
  position,
  color,
  role,
  onHover,
  onLeave,
  onPick,
}: {
  edge: EmphasisEdge
  position: [number, number, number]
  color: string
  role: 'plain' | 'here' | 'selected' | 'from' | 'linked' | 'target'
  onHover: (id: string) => void
  onLeave: () => void
  onPick: (id: string) => void
}) {
  const group = useRef<THREE.Group>(null)
  const base =
    role === 'from' || role === 'selected'
      ? 0.055
      : role === 'target'
        ? 0.048
        : role === 'linked' || role === 'here'
          ? 0.042
          : 0.036

  useLayoutEffect(() => {
    if (!group.current) return
    group.current.lookAt(0, 0, 0)
  }, [position])

  useFrame(({ clock }) => {
    if (!group.current) return
    const pulse =
      role === 'from' || role === 'target'
        ? 1 + 0.1 * Math.sin(clock.elapsedTime * 5.5)
        : 1
    group.current.scale.setScalar(base * pulse)
  })

  return (
    <group ref={group} position={position}>
      <Line
        points={COIL_RING}
        color={color}
        lineWidth={role === 'from' || role === 'selected' ? 2.4 : 1.8}
        transparent
        opacity={0.95}
        depthWrite={false}
      />
      <mesh
        onPointerOver={(e) => {
          e.stopPropagation()
          document.body.style.cursor = 'pointer'
          onHover(edge.id)
        }}
        onPointerOut={(e) => {
          e.stopPropagation()
          document.body.style.cursor = 'auto'
          onLeave()
        }}
        onPointerDown={(e) => {
          e.stopPropagation()
          if (e.button !== 0) return
          onPick(edge.id)
        }}
      >
        <circleGeometry args={[1.35, 16]} />
        <meshBasicMaterial
          transparent
          opacity={0}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  )
}

function LinkChord({
  a,
  b,
}: {
  a: [number, number, number]
  b: [number, number, number]
}) {
  return (
    <Line
      points={[a, b]}
      color="#9c7cff"
      transparent
      opacity={0.45}
      lineWidth={1.5}
      depthWrite={false}
    />
  )
}

function YouAreHere() {
  const group = useRef<THREE.Group>(null)
  const ring = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (ring.current) {
      ring.current.lookAt(0, 0, 0)
      const s = 1 + 0.08 * Math.sin(clock.elapsedTime * 3)
      ring.current.scale.setScalar(s)
    }
    if (!group.current) return
    const s = useDocuverse.getState()
    const total = Math.max(s.pages.length, 1)
    let pos: [number, number, number]
    if (s.selectedEmphasisId) {
      const sel = s.emphasisEdges.find((e) => e.id === s.selectedEmphasisId)
      if (sel) {
        pos = toUnit(emphasisSurfaceWorld(sel, total))
        group.current.position.set(...pos)
        return
      }
    }
    const onPage = s.emphasisEdges.filter(
      (e) => e.strandIndex === s.currentStrand,
    )
    if (onPage.length > 0) {
      const mid = new THREE.Vector3()
      for (const e of onPage) {
        mid.add(new THREE.Vector3(...emphasisSurfaceWorld(e, total)))
      }
      mid.multiplyScalar(1 / onPage.length)
      pos = toUnit([mid.x, mid.y, mid.z])
    } else if (s.cameraEye) {
      pos = toUnit(s.cameraEye)
    } else {
      const r = yawPitchToRadial(s.viewYaw, s.viewPitch)
      pos = [r.x * MAP_R, r.y * MAP_R, r.z * MAP_R]
    }
    group.current.position.set(...pos)
  })
  return (
    <group ref={group}>
      <mesh ref={ring} raycast={noHit}>
        <ringGeometry args={[0.08, 0.11, 32]} />
        <meshBasicMaterial
          color="#ff8a65"
          side={THREE.DoubleSide}
          transparent
          opacity={0.9}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}

function InvalidateOnStoreCam({ enabled }: { enabled: boolean }) {
  const invalidate = useThree((t) => t.invalidate)
  useEffect(() => {
    if (!enabled) return
    return useDocuverse.subscribe((state, prev) => {
      if (
        state.cameraEye !== prev.cameraEye ||
        state.viewYaw !== prev.viewYaw ||
        state.viewPitch !== prev.viewPitch ||
        state.selectedEmphasisId !== prev.selectedEmphasisId ||
        state.currentStrand !== prev.currentStrand ||
        state.emphasisEdges !== prev.emphasisEdges ||
        state.emphasisLinks !== prev.emphasisLinks
      ) {
        invalidate()
      }
    })
  }, [enabled, invalidate])
  return null
}

function MapOrbitCamera({
  yaw,
  pitch,
  followMain,
}: {
  yaw: number
  pitch: number
  /** When true, read main-view yaw/pitch/eye from store each frame (no React churn). */
  followMain: boolean
}) {
  const { camera, invalidate } = useThree()
  useFrame(() => {
    let y = yaw
    let p = pitch
    if (followMain) {
      const s = useDocuverse.getState()
      if (s.cameraEye) {
        const rp = radialToYawPitch(
          new THREE.Vector3(s.cameraEye[0], s.cameraEye[1], s.cameraEye[2]),
        )
        y = rp.yaw
        p = rp.pitch
      } else {
        y = s.viewYaw
        p = s.viewPitch
      }
    }
    const pos = yawPitchToRadial(y, p).multiplyScalar(CAM_DIST)
    camera.position.copy(pos)
    camera.up.set(0, 1, 0)
    camera.lookAt(0, 0, 0)
    if (!followMain) invalidate()
  })
  return null
}

function StarMapScene({
  setHoverId,
}: {
  setHoverId: (id: string | null) => void
}) {
  const edges = useDocuverse((s) => s.emphasisEdges)
  const links = useDocuverse((s) => s.emphasisLinks)
  const pages = useDocuverse((s) => s.pages)
  const selectedId = useDocuverse((s) => s.selectedEmphasisId)
  const fromId = useDocuverse((s) => s.emphasisLinkFromId)
  const currentStrand = useDocuverse((s) => s.currentStrand)
  const selectEmphasis = useDocuverse((s) => s.selectEmphasis)
  const navigateToEmphasis = useDocuverse((s) => s.navigateToEmphasis)

  const total = Math.max(pages.length, 1)

  const stars = useMemo(() => {
    return edges.map((edge) => ({
      edge,
      pos: toUnit(emphasisSurfaceWorld(edge, total)),
    }))
  }, [edges, total])

  const peersByStrand = useMemo(() => {
    const map = new Map<number, EmphasisEdge[]>()
    for (const e of edges) {
      const list = map.get(e.strandIndex)
      if (list) list.push(e)
      else map.set(e.strandIndex, [e])
    }
    return map
  }, [edges])

  const linkedIds = useMemo(() => {
    const set = new Set<string>()
    for (const l of links) {
      set.add(l.fromEmphasisId)
      set.add(l.toEmphasisId)
    }
    return set
  }, [links])

  const chords = useMemo(() => {
    const byId = new Map(stars.map((s) => [s.edge.id, s.pos] as const))
    const out: {
      id: string
      a: [number, number, number]
      b: [number, number, number]
    }[] = []
    for (const l of links) {
      const a = byId.get(l.fromEmphasisId)
      const b = byId.get(l.toEmphasisId)
      if (a && b) out.push({ id: l.id, a, b })
    }
    return out
  }, [links, stars])

  const waiting = Boolean(fromId)

  const onPick = useCallback(
    (id: string) => {
      const s = useDocuverse.getState()
      if (s.emphasisLinkFromId) {
        if (s.emphasisLinkFromId === id) {
          s.setEmphasisLinkFrom(null)
          return
        }
        s.createEmphasisLink(id)
        return
      }
      selectEmphasis(id)
      navigateToEmphasis(id)
    },
    [navigateToEmphasis, selectEmphasis],
  )

  return (
    <>
      <ambientLight intensity={0.9} />
      <mesh raycast={noHit}>
        <sphereGeometry args={[MAP_R, 48, 32]} />
        <meshBasicMaterial
          color="#1a1030"
          transparent
          opacity={0.22}
          side={THREE.BackSide}
          depthWrite={false}
        />
      </mesh>
      <mesh raycast={noHit}>
        <sphereGeometry args={[MAP_R * 1.002, 32, 24]} />
        <meshBasicMaterial
          color="#7e57c2"
          wireframe
          transparent
          opacity={0.28}
        />
      </mesh>

      {chords.map((c) => (
        <LinkChord key={c.id} a={c.a} b={c.b} />
      ))}

      <YouAreHere />

      {stars.map(({ edge, pos }) => {
        let role: 'plain' | 'here' | 'selected' | 'from' | 'linked' | 'target' =
          'plain'
        if (edge.id === fromId) role = 'from'
        else if (waiting && edge.id !== fromId) role = 'target'
        else if (edge.id === selectedId) role = 'selected'
        else if (edge.strandIndex === currentStrand) role = 'here'
        else if (linkedIds.has(edge.id)) role = 'linked'
        const peers = peersByStrand.get(edge.strandIndex) ?? [edge]
        const strokeRole =
          role === 'from'
            ? 'linkFrom'
            : role === 'selected'
              ? 'selected'
              : role === 'target'
                ? 'linkTarget'
                : 'default'
        const color = emphasisStrokeColor(edge, peers, strokeRole)
        return (
          <StarCoil
            key={edge.id}
            edge={edge}
            position={pos}
            color={color}
            role={role}
            onHover={setHoverId}
            onLeave={() => setHoverId(null)}
            onPick={onPick}
          />
        )
      })}
    </>
  )
}

export function EmphasisStarMap() {
  const edges = useDocuverse((s) => s.emphasisEdges)
  const pages = useDocuverse((s) => s.pages)
  const fromId = useDocuverse((s) => s.emphasisLinkFromId)
  const selectedId = useDocuverse((s) => s.selectedEmphasisId)
  const starMapOpen = useDocuverse((s) => s.starMapOpen)
  const setStarMapOpen = useDocuverse((s) => s.setStarMapOpen)
  const setEmphasisLinkFrom = useDocuverse((s) => s.setEmphasisLinkFrom)

  const [hoverId, setHoverId] = useState<string | null>(null)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [previewReading, setPreviewReading] = useState('')
  const [mapYaw, setMapYaw] = useState(() => useDocuverse.getState().viewYaw)
  const [mapPitch, setMapPitch] = useState(() => useDocuverse.getState().viewPitch)
  const [followMain, setFollowMain] = useState(true)
  const drag = useRef<{
    pointerId: number
    lastX: number
    lastY: number
  } | null>(null)
  const cache = useRef(new Map<string, string>())

  useEffect(() => {
    if (!hoverId) {
      setPreviewSrc(null)
      setPreviewReading('')
      return
    }
    const edge = edges.find((e) => e.id === hoverId)
    const page = pages.find((p) => p.strandIndex === edge?.strandIndex)
    if (!edge || !page?.imageUrl) {
      setPreviewSrc(null)
      setPreviewReading(edge?.reading ?? '')
      return
    }
    setPreviewReading(edge.reading)
    const cached = cache.current.get(hoverId)
    if (cached) {
      setPreviewSrc(cached)
      return
    }
    let cancelled = false
    void renderEmphasisTile(
      page.imageUrl,
      edge.region.polygon,
      edge.region.aabb,
    )
      .then((src) => {
        if (cancelled) return
        cache.current.set(hoverId, src)
        setPreviewSrc(src)
      })
      .catch(() => {
        if (!cancelled) setPreviewSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [hoverId, edges, pages])

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 2) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setFollowMain(false)
    drag.current = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
    }
  }
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    const dx = e.clientX - d.lastX
    const dy = e.clientY - d.lastY
    d.lastX = e.clientX
    d.lastY = e.clientY
    const lim = Math.PI / 2 - 0.04
    setMapYaw((y) => y - dx * 0.008)
    setMapPitch((p) => Math.max(-lim, Math.min(lim, p - dy * 0.006)))
  }
  const onPointerUp = (e: ReactPointerEvent) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return
    drag.current = null
    setFollowMain(true)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  if (!starMapOpen) return null

  if (edges.length === 0) {
    return (
      <aside className="star-map-root" aria-label="强调星图">
        <header className="star-map-head">
          <span className="star-map-title">星图 · 建联</span>
          <span className="star-map-meta">0 线圈</span>
        </header>
        <p className="star-map-status">
          尚无强调 · Space+G 开笔圈注后出现于此 · 再按 / Esc 关
        </p>
        <div className="star-map-viewport star-map-viewport-empty" aria-hidden />
        <button
          type="button"
          className="star-map-cancel"
          onClick={() => setStarMapOpen(false)}
        >
          关闭
        </button>
      </aside>
    )
  }

  // 漫游 / 建联 / 回顾 / 四面体均可开（Space+G）
  const fromEdge = edges.find((e) => e.id === fromId)
  const hoverEdge = edges.find((e) => e.id === hoverId)

  return (
    <aside
      className={`star-map-root${fromId ? ' linking' : ''}`}
      aria-label="强调星图 · 建联"
    >
      <header className="star-map-head">
        <span className="star-map-title">星图 · 建联</span>
        <span className="star-map-meta">{edges.length} 线圈</span>
      </header>

      {fromId ? (
        <p className="star-map-status">
          A 已锁定 s{fromEdge?.strandIndex ?? '?'} · 左键点另一线圈完成建联
          <button
            type="button"
            className="star-map-cancel"
            onClick={() => setEmphasisLinkFrom(null)}
          >
            取消
          </button>
        </p>
      ) : (
        <p className="star-map-status">
          {selectedId
            ? 'Enter 锁定当前强调为 A，再点星图上的线圈 B · Space+G 关笔+图'
            : '选中强调后按 Enter，或直接点线圈导航 · Space+G 关笔+图'}
        </p>
      )}

      <div
        className="star-map-viewport"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <Canvas
          frameloop="demand"
          camera={{ position: [0, 0, CAM_DIST], fov: 40, near: 0.1, far: 40 }}
          gl={{ alpha: true, antialias: false, powerPreference: 'low-power' }}
          dpr={1}
          style={{ touchAction: 'none' }}
        >
          <InvalidateOnStoreCam enabled={followMain} />
          <MapOrbitCamera
            yaw={mapYaw}
            pitch={mapPitch}
            followMain={followMain}
          />
          <StarMapScene setHoverId={setHoverId} />
        </Canvas>
        <div className="star-map-you-badge" aria-hidden>
          你在此
        </div>
      </div>

      {hoverEdge && (
        <div className="star-map-preview" role="tooltip">
          {previewSrc ? (
            <img src={previewSrc} alt="" />
          ) : (
            <div className="star-map-preview-empty">预览加载中…</div>
          )}
          <div className="star-map-preview-cap">
            s{hoverEdge.strandIndex}
            {previewReading
              ? ` · ${previewReading.slice(0, 42)}`
              : ' · （未写理解）'}
          </div>
        </div>
      )}
    </aside>
  )
}
