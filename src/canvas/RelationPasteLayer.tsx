import { memo, useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import { Html, Line, Text } from '@react-three/drei'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { useDocuverse } from './store'
import { pageQuaternionFromOutward } from './geometry'
import {
  triangleForLink,
  type ConstructionTriangle,
} from './constructionCamera'
import {
  emphasisRenderWorldAt,
  liftedMidTowardComment,
} from './surfaceGeometry'

const noHit = (() => undefined) as unknown as THREE.Mesh['raycast']

function DashedWaitingC({
  position,
  fill,
}: {
  position: [number, number, number]
  /** 0 = hollow dashed wait; 1 = C fills as M */
  fill: number
}) {
  const group = useRef<THREE.Group>(null)
  useBillboard(group)
  const ring = useMemo(() => {
    const pts: [number, number, number][] = []
    const r = 0.32
    for (let i = 0; i <= 64; i++) {
      const th = (i / 64) * Math.PI * 2
      pts.push([Math.cos(th) * r, Math.sin(th) * r, 0])
    }
    return pts
  }, [])
  const f = THREE.MathUtils.clamp(fill, 0, 1)
  return (
    <group ref={group} position={position} renderOrder={38}>
      <Line
        points={ring}
        color="#ffe0ff"
        dashed
        dashSize={0.07}
        gapSize={0.05}
        lineWidth={2}
        transparent
        opacity={0.35 + 0.55 * (1 - f)}
        depthTest={false}
      />
      <mesh raycast={noHit} renderOrder={37}>
        <circleGeometry args={[0.26 * f, 24]} />
        <meshBasicMaterial
          color="#ffe0ff"
          transparent
          opacity={0.15 + 0.8 * f}
          depthWrite={false}
          depthTest={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <Text
        position={[0, 0.48, 0.04]}
        fontSize={0.14}
        color="#e1bee7"
        anchorX="center"
        anchorY="bottom"
        renderOrder={39}
        depthOffset={-2}
      >
        {f > 0.85 ? 'C→填满M' : 'C · 虚线等待 M'}
      </Text>
    </group>
  )
}

function useBillboard(group: RefObject<THREE.Group | null>) {
  useFrame(({ camera }) => {
    if (!group.current) return
    const look = new THREE.Vector3()
    camera.getWorldDirection(look)
    if (look.lengthSq() < 1e-10) return
    group.current.quaternion.copy(pageQuaternionFromOutward(look.negate()))
  })
}

/**
 * Planar zipper: screen-vertical only (靠近/远离).
 * Rail mid: drag along the screen projection of M→C (any direction toward C).
 */
function useConstructionHandleDrag(
  enabled: boolean,
  mode: 'rail' | 'planar',
  tri: ConstructionTriangle | null,
) {
  const drag = useRef<{
    pointerId: number
    lastX: number
    lastY: number
  } | null>(null)
  const nudgeConstructionMidLift = useDocuverse(
    (s) => s.nudgeConstructionMidLift,
  )
  const setSuppressCameraOrbit = useDocuverse((s) => s.setSuppressCameraOrbit)

  useEffect(() => {
    if (!enabled) {
      drag.current = null
      setSuppressCameraOrbit(false)
      return
    }
    const onMove = (ev: PointerEvent) => {
      const d = drag.current
      if (!d || ev.pointerId !== d.pointerId) return
      const dx = ev.clientX - d.lastX
      const dy = ev.clientY - d.lastY
      d.lastX = ev.clientX
      d.lastY = ev.clientY
      if (Math.hypot(dx, dy) < 0.4) return

      const stage = useDocuverse.getState().constructionStage
      if (stage === 'planar' || mode === 'planar') {
        // Vertical only for spread
        if (Math.abs(dy) < 0.5) return
        nudgeConstructionMidLift(-dy * 0.018)
        return
      }

      // Rail: advance along screen-space M→C
      const t = tri
      if (!t) {
        nudgeConstructionMidLift(-dy * 0.012)
        return
      }
      const cam = useDocuverse.getState()
      const eye = cam.cameraEye
        ? new THREE.Vector3(...cam.cameraEye)
        : null
      const look = cam.cameraLookAt
        ? new THREE.Vector3(...cam.cameraLookAt)
        : new THREE.Vector3(0, 0, 0)
      if (!eye) {
        nudgeConstructionMidLift(-dy * 0.012 + dx * 0.004)
        return
      }
      const m = new THREE.Vector3(...t.m)
      const c = new THREE.Vector3(...t.c)
      const fwd = look.clone().sub(eye).normalize()
      const worldUp = new THREE.Vector3(0, 1, 0)
      const right = new THREE.Vector3().crossVectors(fwd, worldUp)
      if (right.lengthSq() < 1e-10) right.set(1, 0, 0)
      right.normalize()
      const up = new THREE.Vector3().crossVectors(right, fwd).normalize()
      const toScreen = (p: THREE.Vector3) => {
        const rel = p.clone().sub(eye)
        const depth = Math.max(rel.dot(fwd), 0.2)
        return {
          x: rel.dot(right) / depth,
          y: rel.dot(up) / depth,
        }
      }
      const sm = toScreen(m)
      const sc = toScreen(c)
      let sx = sc.x - sm.x
      let sy = sc.y - sm.y
      const slen = Math.hypot(sx, sy)
      if (slen < 1e-6) {
        nudgeConstructionMidLift(-dy * 0.014)
        return
      }
      sx /= slen
      sy /= slen
      // Pointer: +x right, +y down → screen y flips
      const along = dx * sx + -dy * sy
      // ~180px of drag along axis ≈ full climb
      nudgeConstructionMidLift(along * 0.0065)
    }
    const onUp = (ev: PointerEvent) => {
      if (!drag.current || ev.pointerId !== drag.current.pointerId) return
      drag.current = null
      setSuppressCameraOrbit(false)
      document.body.style.cursor = 'auto'
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      // 开笔 / 卸手柄时清 suppress，避免右键平移被永久卡住
      drag.current = null
      setSuppressCameraOrbit(false)
    }
  }, [enabled, mode, tri, nudgeConstructionMidLift, setSuppressCameraOrbit])

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (!enabled || e.button !== 0) return
    e.stopPropagation()
    setSuppressCameraOrbit(true)
    useDocuverse.setState({ suppressCameraOrbit: true })
    drag.current = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
    }
    document.body.style.cursor =
      mode === 'planar' ? 'ns-resize' : 'grabbing'
  }

  const hoverProps = enabled
    ? {
        onPointerOver: () => {
          document.body.style.cursor =
            mode === 'planar' ? 'ns-resize' : 'grab'
        },
        onPointerOut: () => {
          if (!drag.current) document.body.style.cursor = 'auto'
        },
      }
    : {}

  return { onDown, hoverProps }
}

/** Fat mid handle + M→C tube — easy LMB hit during rail. */
function RailMidGrab({
  tri,
  midPos,
  lift,
  enabled,
  penMode,
}: {
  tri: ConstructionTriangle
  midPos: [number, number, number]
  lift: number
  enabled: boolean
  /** Emphasize pen on: only the visible core steals LMB (fat pads yield to pages). */
  penMode: boolean
}) {
  const { onDown, hoverProps } = useConstructionHandleDrag(
    enabled,
    'rail',
    tri,
  )
  const snapToC = () => {
    if (!enabled) return
    useDocuverse.getState().nudgeConstructionMidLift(1)
  }
  const remain = Math.max(0.15, 1 - lift)
  const axis = useMemo(() => {
    const m = new THREE.Vector3(...tri.m)
    const c = new THREE.Vector3(...tri.c)
    return c.sub(m)
  }, [tri])
  const tubeLen = axis.length() * remain
  const tubeDir = axis.clone().normalize()
  const tubeMid = useMemo((): [number, number, number] => {
    const p = new THREE.Vector3(...midPos).addScaledVector(
      tubeDir,
      tubeLen * 0.5,
    )
    return [p.x, p.y, p.z]
  }, [midPos, tubeDir, tubeLen])
  const tubeQuat = useMemo(() => {
    const q = new THREE.Quaternion()
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tubeDir)
    return q
  }, [tubeDir])
  const padRay = enabled && !penMode ? undefined : noHit
  const coreRay = enabled ? undefined : noHit

  return (
    <group>
      <mesh
        position={midPos}
        renderOrder={90}
        userData={{ constructionHandle: 'pad' }}
        raycast={padRay}
        onPointerDown={onDown}
        {...hoverProps}
      >
        <sphereGeometry args={[0.62, 20, 20]} />
        <meshBasicMaterial
          color="#ffe0ff"
          transparent
          opacity={0.22}
          depthWrite={false}
          depthTest={false}
        />
      </mesh>
      <mesh
        position={midPos}
        renderOrder={91}
        userData={{ constructionHandle: 'core' }}
        raycast={coreRay}
        onPointerDown={onDown}
        {...hoverProps}
      >
        <sphereGeometry args={[0.28, 16, 16]} />
        <meshBasicMaterial
          color="#ffffff"
          depthWrite={false}
          depthTest={false}
        />
      </mesh>
      <mesh
        position={tubeMid}
        quaternion={tubeQuat}
        renderOrder={89}
        userData={{ constructionHandle: 'core' }}
        raycast={coreRay}
        onPointerDown={onDown}
        {...hoverProps}
      >
        <cylinderGeometry
          args={[
            penMode ? 0.12 : 0.22,
            penMode ? 0.12 : 0.22,
            Math.max(tubeLen, 0.4),
            12,
          ]}
        />
        <meshBasicMaterial
          color="#f0abfc"
          transparent
          opacity={0.35}
          depthWrite={false}
          depthTest={false}
        />
      </mesh>
      <mesh
        position={tri.c}
        renderOrder={92}
        userData={{ constructionHandle: 'pad' }}
        raycast={padRay}
        onPointerDown={(e) => {
          if (!enabled || e.button !== 0) return
          e.stopPropagation()
          snapToC()
        }}
        onPointerOver={() => {
          if (!enabled) return
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'auto'
        }}
      >
        <sphereGeometry args={[penMode ? 0.35 : 0.75, 20, 20]} />
        <meshBasicMaterial
          color="#ffe0ff"
          transparent
          opacity={0.12}
          depthWrite={false}
          depthTest={false}
        />
      </mesh>
      <Text
        position={[
          midPos[0],
          midPos[1] + 0.55,
          midPos[2],
        ]}
        fontSize={0.22}
        color="#ffe0ff"
        anchorX="center"
        anchorY="bottom"
        renderOrder={93}
        depthOffset={-4}
        raycast={noHit}
      >
        {`沿轴拖 · ${lift.toFixed(2)} · 再推向 C 回拉链俯视`}
      </Text>
    </group>
  )
}

/** Visible zipper — never opacity 0 (Three skips raycast on fully transparent). */
function ZipperHandle({
  position,
  blend,
  draggable,
  mode,
  tri,
  penMode,
}: {
  position: [number, number, number]
  blend: number
  draggable: boolean
  mode: 'rail' | 'planar'
  tri: ConstructionTriangle | null
  penMode: boolean
}) {
  const group = useRef<THREE.Group>(null)
  useBillboard(group)
  const { onDown, hoverProps } = useConstructionHandleDrag(
    draggable,
    mode,
    tri,
  )
  const planar = mode === 'planar'
  const trackW = planar ? (penMode ? 0.42 : 0.55) : 0.14
  const trackH = planar ? (penMode ? 1.8 : 2.4) : 1.35
  const tabW = planar ? (penMode ? 0.7 : 0.85) : 0.42
  const tabH = planar ? 0.48 : 0.32
  const padRay = draggable && !penMode ? undefined : noHit
  const coreRay = draggable ? undefined : noHit

  return (
    <group ref={group} position={position} renderOrder={80}>
      <mesh
        position={[0, 0, 0.02]}
        renderOrder={80}
        userData={{ constructionHandle: 'pad' }}
        raycast={padRay}
        onPointerDown={onDown}
        {...hoverProps}
      >
        <planeGeometry args={[planar ? 2.2 : 0.7, trackH + 1.2]} />
        <meshBasicMaterial
          color="#f0abfc"
          transparent
          opacity={penMode ? 0.04 : 0.12}
          depthWrite={false}
          depthTest={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh
        position={[0, trackH * 0.38, 0.04]}
        renderOrder={81}
        userData={{ constructionHandle: 'core' }}
        raycast={coreRay}
        onPointerDown={onDown}
        {...hoverProps}
      >
        <planeGeometry args={[tabW, tabH]} />
        <meshBasicMaterial
          color="#ffe0ff"
          transparent
          opacity={0.95}
          depthWrite={false}
          depthTest={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh
        renderOrder={81}
        userData={{ constructionHandle: 'core' }}
        raycast={coreRay}
        onPointerDown={onDown}
        {...hoverProps}
      >
        <planeGeometry args={[trackW, trackH]} />
        <meshBasicMaterial
          color="#f0abfc"
          transparent
          opacity={0.9}
          depthWrite={false}
          depthTest={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <Text
        position={[0, trackH * 0.55 + 0.2, 0.06]}
        fontSize={planar ? 0.22 : 0.16}
        color="#ffe0ff"
        anchorX="center"
        anchorY="bottom"
        renderOrder={82}
        depthOffset={-4}
        raycast={noHit}
      >
        {planar
          ? `拉链 · 间距 ${blend.toFixed(2)}`
          : `中点 · ${blend.toFixed(2)}`}
      </Text>
      <Text
        position={[0, -trackH * 0.55 - 0.12, 0.06]}
        fontSize={planar ? 0.16 : 0.11}
        color="#e1bee7"
        anchorX="center"
        anchorY="top"
        renderOrder={82}
        depthOffset={-4}
        raycast={noHit}
      >
        {planar
          ? '上拖靠近 · 下拖远离（到底回穿洞）'
          : '沿 M→C 拖，或点 C'}
      </Text>
    </group>
  )
}

const COMMENT_NOTE_SAVE_MS = 480

/**
 * 评论层热路径 = 非受控 textarea（浏览器原生编辑，零 React 重渲染）。
 * 与强调笔 GPU 缓冲同构：显示在本地 DOM，停顿/失焦才入库。
 */
function CommentAtC({
  position,
  linkId,
  note,
  stealth,
}: {
  position: [number, number, number]
  linkId: string
  note: string
  /** G：隐身（层仍在 C）；false = 现身可编辑文本 */
  stealth: boolean
}) {
  const group = useRef<THREE.Group>(null)
  useBillboard(group)
  const updateEmphasisLinkNote = useDocuverse((s) => s.updateEmphasisLinkNote)
  const setCommentLayerExpanded = useDocuverse((s) => s.setCommentLayerExpanded)
  const setSuppressCameraOrbit = useDocuverse((s) => s.setSuppressCameraOrbit)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const dirtyRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const linkIdRef = useRef(linkId)
  const noteRef = useRef(note)
  /** 拼音/日文等 IME 组字中 — 禁止 flush */
  const composingRef = useRef(false)

  const readDom = useCallback((): string => areaRef.current?.value ?? '', [])

  const flushNote = useCallback(() => {
    if (composingRef.current) return
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (!dirtyRef.current) return
    const text = readDom()
    dirtyRef.current = false
    noteRef.current = text
    updateEmphasisLinkNote(linkIdRef.current, text)
  }, [readDom, updateEmphasisLinkNote])

  const scheduleSave = useCallback(() => {
    if (composingRef.current) return
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      flushNote()
    }, COMMENT_NOTE_SAVE_MS)
  }, [flushNote])

  useEffect(() => {
    if (linkIdRef.current !== linkId) {
      if (dirtyRef.current && !composingRef.current) {
        updateEmphasisLinkNote(linkIdRef.current, readDom())
        dirtyRef.current = false
      }
      linkIdRef.current = linkId
      noteRef.current = note
      dirtyRef.current = false
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      // key={linkId} remounts textarea with defaultValue; no manual sync needed
      return
    }
    // 外部改写 note（且本地未脏）时同步 DOM，不打断正在输入
    if (
      !dirtyRef.current &&
      !composingRef.current &&
      note !== noteRef.current &&
      areaRef.current
    ) {
      noteRef.current = note
      areaRef.current.value = note
    }
  }, [linkId, note, readDom, updateEmphasisLinkNote])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
      }
      if (dirtyRef.current) {
        const el = areaRef.current
        updateEmphasisLinkNote(linkIdRef.current, el?.value ?? noteRef.current)
      }
    }
  }, [updateEmphasisLinkNote])

  useEffect(() => {
    if (stealth) return
    const id = window.setTimeout(() => areaRef.current?.focus(), 40)
    return () => window.clearTimeout(id)
  }, [stealth, linkId])

  const onInput = useCallback(() => {
    dirtyRef.current = true
    scheduleSave()
  }, [scheduleSave])

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false
    dirtyRef.current = true
    scheduleSave()
  }, [scheduleSave])

  if (stealth) {
    return (
      <group ref={group} position={position} renderOrder={45}>
        <mesh raycast={noHit} renderOrder={45}>
          <sphereGeometry args={[0.18, 16, 16]} />
          <meshBasicMaterial
            color="#ffe0ff"
            transparent
            opacity={0.35}
            depthWrite={false}
            depthTest={false}
          />
        </mesh>
        <Text
          position={[0, 0.38, 0.04]}
          fontSize={0.16}
          color="#ce93d8"
          anchorX="center"
          anchorY="bottom"
          renderOrder={46}
          depthOffset={-2}
          raycast={noHit}
        >
          C · 评论在此 · G 现身
        </Text>
      </group>
    )
  }

  return (
    <group ref={group} position={position} renderOrder={50}>
      {/* 真透明：无遮光底板，仅靠 Html 玻璃描边 */}
      <Html
        transform
        distanceFactor={9}
        position={[0, 0, 0.02]}
        style={{ pointerEvents: 'auto' }}
        zIndexRange={[120, 80]}
      >
        <div
          className="comment-at-c-panel"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="comment-at-c-head">
            <span>评论层 · C</span>
            <button
              type="button"
              className="comment-at-c-stealth"
              onClick={() => setCommentLayerExpanded(false)}
            >
              Space+G 隐身
            </button>
          </div>
          <textarea
            key={linkId}
            ref={areaRef}
            className="comment-at-c-textarea"
            rows={6}
            defaultValue={note}
            placeholder="文本评论…"
            spellCheck={false}
            onFocus={() => setSuppressCameraOrbit(true)}
            onBlur={() => {
              setSuppressCameraOrbit(false)
              flushNote()
            }}
            onCompositionStart={() => {
              composingRef.current = true
            }}
            onCompositionEnd={onCompositionEnd}
            onInput={onInput}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
      </Html>
    </group>
  )
}

const CommentAtCMemo = memo(CommentAtC)

function SkeletonLines({ tri }: { tri: ConstructionTriangle }) {
  const segs = useMemo(
    () =>
      new Float32Array([
        ...tri.a,
        ...tri.b,
        ...tri.m,
        ...tri.c,
        ...tri.a,
        ...tri.c,
        ...tri.b,
        ...tri.c,
      ]),
    [tri],
  )
  return (
    <lineSegments raycast={noHit} renderOrder={30}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[segs, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color="#ffe0ff" depthTest={false} />
    </lineSegments>
  )
}

/**
 * Rail: mid climbs M→C (pages home). Crossing: hole. Planar: zipper=spread.
 * Comment layer always sits at C; G toggles stealth (not existence).
 */
export function RelationPasteLayer() {
  const emphasizeMode = useDocuverse((s) => s.emphasizeMode)
  const cameraLens = useDocuverse((s) => s.cameraLens)
  const constructionLinkId = useDocuverse((s) => s.constructionLinkId)
  const retrospectiveLinkId = useDocuverse((s) => s.retrospectiveLinkId)
  const constructionStage = useDocuverse((s) => s.constructionStage)
  const constructionMidLift = useDocuverse((s) => s.constructionMidLift)
  const constructionSpread = useDocuverse((s) => s.constructionSpread)
  const commentLayerExpanded = useDocuverse((s) => s.commentLayerExpanded)
  const links = useDocuverse((s) => s.emphasisLinks)
  const edges = useDocuverse((s) => s.emphasisEdges)
  const pages = useDocuverse((s) => s.pages)
  const total = Math.max(pages.length, 1)

  const activeLinkId = constructionLinkId ?? retrospectiveLinkId
  const link = links.find((l) => l.id === activeLinkId)
  const from = edges.find((e) => e.id === link?.fromEmphasisId)
  const to = edges.find((e) => e.id === link?.toEmphasisId)

  const tri = useMemo(() => {
    if (!link || !from || !to) return null
    return triangleForLink(from, to, total, null)
  }, [link, from, to, total])

  const midPos = useMemo(() => {
    if (!tri || !from || !to) return null
    // Visual mid on emphasis chord → C (matches purple beam apex)
    const aW = emphasisRenderWorldAt(from, total)
    const bW = emphasisRenderWorldAt(to, total)
    return liftedMidTowardComment(aW, bW, tri.c, constructionMidLift)
  }, [tri, from, to, total, constructionMidLift])

  if (
    (cameraLens !== 'construction' && cameraLens !== 'retrospective') ||
    !tri ||
    !midPos ||
    !from ||
    !to ||
    !link
  ) {
    return null
  }

  // 拉链 / 中点：与强调笔并行（点到手柄拖，点到页圈注）
  const canDrag =
    constructionStage !== 'crossing' &&
    (cameraLens === 'construction' || cameraLens === 'retrospective')
  // Always show mid grab on rail (including near C after reverse 穿洞)
  const midVisible = constructionStage === 'rail'
  const labelVal =
    constructionStage === 'planar'
      ? constructionSpread
      : constructionMidLift
  // expanded = 现身可编辑；!expanded = 隐身（评论层仍在 C）
  const commentStealth = !commentLayerExpanded

  return (
    <group>
      <SkeletonLines tri={tri} />

      {(
        [
          [tri.a, '#ff66f0', 0.12],
          [tri.b, '#ff66f0', 0.12],
          [tri.m, '#e1bee7', 0.08],
          [tri.c, '#ffe0ff', midVisible ? 0.06 : 0.14],
        ] as const
      ).map(([p, color, r], i) => (
        <mesh key={i} position={p} raycast={noHit} renderOrder={35}>
          <sphereGeometry args={[r, 16, 16]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={midVisible && i === 3 ? 0.35 : 0.95}
            depthWrite={false}
            depthTest={false}
          />
        </mesh>
      ))}

      {midVisible && (
        <RailMidGrab
          tri={tri}
          midPos={midPos}
          lift={constructionMidLift}
          enabled={canDrag}
          penMode={emphasizeMode}
        />
      )}

      {constructionStage === 'rail' && (
        <DashedWaitingC
          position={tri.c}
          fill={
            constructionMidLift >= 0.995
              ? 1
              : Math.max(0, (constructionMidLift - 0.55) / 0.45)
          }
        />
      )}

      {constructionStage === 'planar' && (
        <>
          <ZipperHandle
            position={tri.m}
            blend={labelVal}
            draggable={canDrag}
            mode="planar"
            tri={tri}
            penMode={emphasizeMode}
          />
          <CommentAtCMemo
            position={tri.c}
            linkId={link.id}
            note={link.note}
            stealth={commentStealth}
          />
        </>
      )}
    </group>
  )
}
