/**
 * Vertical fan-out stack:
 *   PDF poker (with premise green boxes)
 *   ↑ OCR fragment poker cards (I/O of retrieve)
 *   ↑ Compose cards (member recipe, same-page scope)
 *   ↑ Infer conclusions
 * Directed arrows mark which layer feeds which.
 */

import { useEffect, useMemo } from 'react'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import {
  FANOUT_LAYER_Y,
  PAGE_H,
  PAGE_W,
  fanoutLayerPosition,
  fanoutPolarOnLayer,
  innerSphereRadius,
  pageBasis,
  pageHomePosition,
  pageHomeQuaternion,
  type FanoutLayerId,
} from './geometry'
import { useFanout } from '../reasoning/fanoutStore'
import { useIndexGate } from '../reasoning/indexGate'
import { useReasoning } from '../reasoning/closureStore'
import { atomSearchText } from '../reasoning/hybridRetrieve'
import { shortHandle } from '../reasoning/ocrSlot'
import type { FanoutPath, FanoutSlotVisual } from '../reasoning/types'
import { useDocuverse } from './store'

const COLOR_PDF = '#9aa3b5'
const COLOR_RETRIEVE = '#3dd6c6'
const COLOR_COMPOSE = '#7aa2ff'
const COLOR_INFER = '#f0a202'
const COLOR_DIM = '#5a6170'

const noHit = (() => undefined) as unknown as THREE.Mesh['raycast']

function straightPoints(from: THREE.Vector3, to: THREE.Vector3, n = 12): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (let i = 0; i <= n; i++) out.push(from.clone().lerp(to, i / n))
  return out
}

function LayerDeck({
  y,
  radius,
  color,
  label,
  opacity = 0.22,
}: {
  y: number
  radius: number
  color: string
  label: string
  opacity?: number
}) {
  return (
    <group position={[0, y, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={noHit}>
        <ringGeometry args={[radius * 0.18, radius * 1.02, 64]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <Html
        position={[0, 0.25, -radius * 0.92]}
        center
        style={{ pointerEvents: 'none' }}
      >
        <div
          style={{
            fontFamily: 'IBM Plex Mono, monospace',
            fontSize: 12,
            letterSpacing: '0.08em',
            color,
            background: 'rgba(8,10,16,0.72)',
            padding: '3px 8px',
            borderRadius: 6,
            border: `1px solid ${color}66`,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
      </Html>
    </group>
  )
}

/** Directed delivery: line + cone tip at `to`. */
function DeliveryArrow({
  from,
  to,
  color,
  label,
  active,
  onSelect,
}: {
  from: THREE.Vector3
  to: THREE.Vector3
  color: string
  label: string
  active: boolean
  onSelect: () => void
}) {
  const points = useMemo(() => straightPoints(from, to), [from, to])
  const mid = points[Math.floor(points.length / 2)]
  const opacity = active ? 1 : 0.22
  const dir = useMemo(() => {
    const d = to.clone().sub(from)
    if (d.lengthSq() < 1e-8) return new THREE.Vector3(0, 1, 0)
    return d.normalize()
  }, [from, to])
  const quat = useMemo(() => {
    const q = new THREE.Quaternion()
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    return q
  }, [dir])

  return (
    <group>
      <Line
        points={points}
        color={active ? color : COLOR_DIM}
        lineWidth={active ? 2.6 : 1}
        transparent
        opacity={opacity}
      />
      <mesh
        position={to}
        quaternion={quat}
        onClick={(e) => {
          e.stopPropagation()
          onSelect()
        }}
      >
        <coneGeometry args={[0.28, 0.7, 10]} />
        <meshBasicMaterial
          color={active ? color : COLOR_DIM}
          transparent
          opacity={opacity}
        />
      </mesh>
      {mid && active && (
        <Html position={mid} distanceFactor={32} center style={{ pointerEvents: 'none' }}>
          <div
            style={{
              fontFamily: 'IBM Plex Mono, monospace',
              fontSize: 10,
              color: '#0b0e14',
              background: color,
              padding: '2px 6px',
              borderRadius: 4,
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </div>
        </Html>
      )}
    </group>
  )
}

function FragmentCard({
  position,
  quaternion,
  width,
  height,
  color,
  title,
  body,
  active,
  onClick,
}: {
  position: [number, number, number]
  quaternion: THREE.Quaternion
  width: number
  height: number
  color: string
  title: string
  body: string
  active: boolean
  onClick?: () => void
}) {
  const opacity = active ? 0.92 : 0.4
  return (
    <group position={position} quaternion={quaternion}>
      <mesh
        onClick={(e) => {
          e.stopPropagation()
          onClick?.()
        }}
      >
        <planeGeometry args={[width, height]} />
        <meshBasicMaterial
          color="#121820"
          transparent
          opacity={opacity}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh position={[0, 0, 0.02]} raycast={noHit}>
        <planeGeometry args={[width * 0.96, height * 0.96]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={active ? 0.22 : 0.1}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <Html
        position={[0, 0, 0.05]}
        center
        distanceFactor={42}
        style={{ pointerEvents: 'none' }}
      >
        <div
          style={{
            width: Math.max(72, width * 14),
            maxHeight: Math.max(48, height * 14),
            overflow: 'hidden',
            fontFamily: 'IBM Plex Mono, monospace',
            fontSize: 9,
            lineHeight: 1.25,
            color: '#e8e2d6',
            background: 'rgba(8,12,18,0.88)',
            border: `1px solid ${color}`,
            borderRadius: 4,
            padding: '3px 5px',
            opacity,
          }}
        >
          <div style={{ color, marginBottom: 2 }}>{title}</div>
          <div>{body}</div>
        </div>
      </Html>
    </group>
  )
}

function slotCardSize(bbox: [number, number, number, number]): [number, number] {
  const w = Math.min(3.2, Math.max(1.35, ((bbox[2] - bbox[0]) / 1000) * PAGE_W * 0.5))
  const h = Math.min(2.4, Math.max(0.95, ((bbox[3] - bbox[1]) / 1000) * PAGE_H * 0.4))
  return [w, h]
}

function pathSlots(path: FanoutPath): FanoutSlotVisual[] {
  if (path.slots?.length) return path.slots
  return []
}

const FULL_PAGE_AREA = 0.82 * 1_000_000

function isNearFullPage(bbox: [number, number, number, number]): boolean {
  const area = Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1])
  return area >= FULL_PAGE_AREA
}

/** Resolve all paint-worthy boxes for one cited slot (prefer inkBoxes). */
function lockBoxesForSlot(
  slot: FanoutSlotVisual,
  bookIndex: { chunks: Array<{
    key: string
    page: number
    bbox: [number, number, number, number]
    inkBoxes?: Array<[number, number, number, number]>
    faces?: { text?: { content: string } }
    content?: string
  }> } | null | undefined,
  focus: boolean,
): Array<{
  page: number
  bbox: [number, number, number, number]
  focus?: boolean
  excerpt: string
}> {
  const chunk = bookIndex?.chunks.find((c) => c.key === slot.key)
  const excerpt =
    chunk?.faces?.text?.content ??
    chunk?.content ??
    slot.excerpt ??
    ''
  const page = chunk?.page ?? slot.page
  const ink = (chunk?.inkBoxes ?? []).filter((b) => !isNearFullPage(b))
  if (ink.length > 0) {
    return ink.map((bbox) => ({ page, bbox, focus, excerpt }))
  }
  let bbox = slot.bbox
  if (chunk) {
    const tight = !isNearFullPage(chunk.bbox) ? chunk.bbox : bbox
    if (!isNearFullPage(tight)) bbox = tight
  }
  if (isNearFullPage(bbox)) return []
  return [{ page, bbox, focus, excerpt }]
}

function readingOrder(a: FanoutSlotVisual, b: FanoutSlotVisual): number {
  const dy = a.bbox[1] - b.bbox[1]
  if (Math.abs(dy) > 8) return dy
  return a.bbox[0] - b.bbox[0]
}

/**
 * Per PDF page: pack OCR fragments within that page's width.
 * Fill left→right; when a row is full, stack the next row upward (+Y).
 */
function layoutSlotsOnOcrRing(
  slots: FanoutSlotVisual[],
  pageCount: number,
): Array<{
  slot: FanoutSlotVisual
  pos: THREE.Vector3
  pdf: THREE.Vector3
  quat: THREE.Quaternion
  w: number
  h: number
}> {
  const maxRowWidth = PAGE_W * 0.92
  const gapX = 0.16
  const gapY = 0.2

  const byPage = new Map<number, FanoutSlotVisual[]>()
  for (const s of slots) {
    const list = byPage.get(s.page) ?? []
    list.push(s)
    byPage.set(s.page, list)
  }

  const out: Array<{
    slot: FanoutSlotVisual
    pos: THREE.Vector3
    pdf: THREE.Vector3
    quat: THREE.Quaternion
    w: number
    h: number
  }> = []

  for (const [page, raw] of byPage) {
    const pageSlots = [...raw].sort(readingOrder)
    const home = pageHomePosition(page, pageCount)
    const { x } = pageBasis(page, pageCount)
    const base = fanoutLayerPosition(page, pageCount, 'ocr', 0.9)
    const quat = pageHomeQuaternion(page, pageCount)
    const pdf = new THREE.Vector3(home[0], home[1] + PAGE_H * 0.52, home[2])

    type Row = {
      items: Array<{ slot: FanoutSlotVisual; w: number; h: number }>
      width: number
      maxH: number
    }
    const rows: Row[] = []
    let cur: Row = { items: [], width: 0, maxH: 0 }

    for (const slot of pageSlots) {
      let [w, h] = slotCardSize(slot.bbox)
      w = Math.min(w, maxRowWidth * 0.48)
      const nextWidth =
        cur.items.length === 0 ? w : cur.width + gapX + w
      if (cur.items.length > 0 && nextWidth > maxRowWidth) {
        rows.push(cur)
        cur = { items: [{ slot, w, h }], width: w, maxH: h }
      } else {
        cur.items.push({ slot, w, h })
        cur.width = nextWidth
        cur.maxH = Math.max(cur.maxH, h)
      }
    }
    if (cur.items.length > 0) rows.push(cur)

    let yLift = 0
    for (const row of rows) {
      // Center this row under the page width budget
      let xCursor = -row.width / 2
      for (const item of row.items) {
        const mid = xCursor + item.w / 2
        const pos = new THREE.Vector3(
          base[0] + x.x * mid,
          base[1] + yLift,
          base[2] + x.z * mid,
        )
        out.push({
          slot: item.slot,
          pos,
          pdf,
          quat,
          w: item.w,
          h: item.h,
        })
        xCursor += item.w + gapX
      }
      yLift += row.maxH + gapY
    }
  }
  return out
}

function PathStack({
  path,
  active,
  pageCount,
  selectedSlotKey,
  onSelectPath,
  onSelectSlot,
}: {
  path: FanoutPath
  active: boolean
  pageCount: number
  selectedSlotKey: string | null
  onSelectPath: () => void
  onSelectSlot: (key: string) => void
}) {
  const slots = pathSlots(path)
  const scopeLabel =
    path.composeScope === 'cross_page'
      ? '跨页组合'
      : path.composeScope === 'same_page'
        ? '同页组合'
        : '单槽'

  const composePos = useMemo(() => {
    const p = fanoutPolarOnLayer(path.conclusionAngle, pageCount, 'compose', 0.48)
    return new THREE.Vector3(...p)
  }, [path.conclusionAngle, pageCount])

  const inferPos = useMemo(() => {
    const p = fanoutPolarOnLayer(path.conclusionAngle, pageCount, 'infer', 0.4)
    return new THREE.Vector3(...p)
  }, [path.conclusionAngle, pageCount])

  const ocrAnchors = useMemo(
    () => layoutSlotsOnOcrRing(slots, pageCount),
    [slots, pageCount],
  )

  const inferLabel =
    (path.direction.conclusion || '（无结论）').slice(0, 56) +
    ((path.direction.conclusion?.length ?? 0) > 56 ? '…' : '')

  const composeBody = `${path.unitLabel} · ${scopeLabel}\n成员 ${slots.length}：${slots
    .map((s) => `p${s.page + 1}`)
    .join('+')}\n${(path.injectedExcerpt || '').replace(/^【[^\n]*】\n?/, '').slice(0, 72)}`

  return (
    <group>
      {ocrAnchors.map(({ slot, pos, pdf }) => {
        const slotActive = active && selectedSlotKey === slot.key
        return (
          <group key={`${path.pathId}-slot-${slot.key}`}>
            <DeliveryArrow
              from={pdf}
              to={pos}
              color={COLOR_RETRIEVE}
              label={`retrieve ← 段框`}
              active={slotActive || (active && !selectedSlotKey)}
              onSelect={() => {
                onSelectPath()
                onSelectSlot(slot.key)
              }}
            />
            <DeliveryArrow
              from={pos}
              to={composePos}
              color={COLOR_COMPOSE}
              label={`compose ← ${shortHandle(slot.key)}`}
              active={slotActive || (active && !selectedSlotKey)}
              onSelect={() => {
                onSelectPath()
                onSelectSlot(slot.key)
              }}
            />
          </group>
        )
      })}

      <FragmentCard
        position={[composePos.x, composePos.y, composePos.z]}
        quaternion={new THREE.Quaternion()}
        width={3.4}
        height={2.2}
        color={COLOR_COMPOSE}
        title={`组合输出 · ${scopeLabel}`}
        body={composeBody}
        active={active}
        onClick={onSelectPath}
      />

      <DeliveryArrow
        from={composePos}
        to={inferPos}
        color={COLOR_INFER}
        label="infer ← compose"
        active={active}
        onSelect={onSelectPath}
      />

      <FragmentCard
        position={[inferPos.x, inferPos.y, inferPos.z]}
        quaternion={new THREE.Quaternion()}
        width={3.6}
        height={2.4}
        color={COLOR_INFER}
        title="推理输出"
        body={inferLabel}
        active={active}
        onClick={onSelectPath}
      />
    </group>
  )
}

/** Baseline OCR poker: A1 slots, same-page fragments in a horizontal row. */
function OcrIndexPoker({
  pageCount,
  highlightKeys,
  selectedSlotKey,
  onSelectSlot,
}: {
  pageCount: number
  highlightKeys: Set<string>
  selectedSlotKey: string | null
  onSelectSlot: (key: string, page: number) => void
}) {
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const chunks = bookIndex?.chunks ?? []
  if (chunks.length === 0) return null

  const visuals: FanoutSlotVisual[] = chunks
    .filter((c) => c.kind === 'text' || Boolean(c.faces.text))
    .slice(0, 100)
    .map((c) => {
      const bbox =
        c.inkBoxes?.find(
          (b) => (b[2] - b[0]) * (b[3] - b[1]) < 0.82 * 1_000_000,
        ) ?? c.bbox
      const tight =
        (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) >= 0.82 * 1_000_000
          ? ([100, 120, 480, 300] as [number, number, number, number])
          : bbox
      return {
        key: c.key,
        page: c.page,
        bbox: tight,
        excerpt: atomSearchText(c).slice(0, 72),
      }
    })

  const laid = layoutSlotsOnOcrRing(visuals, pageCount)

  return (
    <group>
      {laid.map(({ slot, pos, quat, w, h }) => {
        const selected = selectedSlotKey === slot.key
        const inPath = highlightKeys.has(slot.key)
        return (
          <FragmentCard
            key={`idx-${slot.key}`}
            position={[pos.x, pos.y, pos.z]}
            quaternion={quat}
            width={w * 0.9}
            height={h * 0.9}
            color={selected || inPath ? COLOR_RETRIEVE : COLOR_PDF}
            title={`OCR · p${slot.page + 1} · ${shortHandle(slot.key)}`}
            body={slot.excerpt || '…'}
            active={selected || inPath || highlightKeys.size === 0}
            onClick={() => onSelectSlot(slot.key, slot.page)}
          />
        )
      })}
    </group>
  )
}

export function FanoutPathArrows() {
  const pages = useDocuverse((s) => s.pages)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)
  const sessionPaths = useFanout((s) => s.paths)
  const acceptedPaths = useFanout((s) => s.acceptedPaths)
  const activePathId = useFanout((s) => s.activePathId)
  const selectedSlotKey = useFanout((s) => s.selectedSlotKey)
  const setActivePathId = useFanout((s) => s.setActivePathId)
  const setSelectedSlotKey = useFanout((s) => s.setSelectedSlotKey)
  const indexReady = useIndexGate((s) => s.ready)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const activateResolved = useReasoning((s) => s.activateResolved)
  const clearActive = useReasoning((s) => s.clearActive)

  const pageCount = Math.max(pages.length, 1)
  const ringR = innerSphereRadius(pageCount)

  const paths = useMemo(() => {
    const byId = new Map<string, FanoutPath>()
    for (const p of acceptedPaths) byId.set(p.pathId, p)
    for (const p of sessionPaths) byId.set(p.pathId, p)
    return [...byId.values()]
  }, [acceptedPaths, sessionPaths])

  const activePath = useMemo(
    () => paths.find((p) => p.pathId === activePathId) ?? paths[0] ?? null,
    [paths, activePathId],
  )

  const highlightKeys = useMemo(() => {
    const s = new Set<string>()
    for (const slot of activePath ? pathSlots(activePath) : []) s.add(slot.key)
    return s
  }, [activePath])

  // PDF: highlight ALL cited boxes on the active path; focus slot is thicker
  useEffect(() => {
    if (!activePath) {
      return
    }
    const slots = pathSlots(activePath)
    if (slots.length === 0) {
      clearActive()
      return
    }

    const focusKey = selectedSlotKey ?? slots[0]?.key ?? null
    const boxes: Array<{
      page: number
      bbox: [number, number, number, number]
      focus?: boolean
    }> = []
    const members: Array<{
      slotId: string
      pctStart: number
      pctEnd: number
      page: number
      bbox: [number, number, number, number]
    }> = []
    let focusPage: number | undefined
    let focusBbox: [number, number, number, number] | undefined
    let focusExcerpt = ''

    for (const slot of slots) {
      const resolved = lockBoxesForSlot(
        slot,
        bookIndex,
        slot.key === focusKey,
      )
      for (const box of resolved) {
        boxes.push({
          page: box.page,
          bbox: box.bbox,
          focus: box.focus,
        })
        members.push({
          slotId: slot.key,
          pctStart: 0,
          pctEnd: 100,
          page: box.page,
          bbox: box.bbox,
        })
        if (slot.key === focusKey && focusPage === undefined) {
          focusPage = box.page
          focusBbox = box.bbox
          focusExcerpt = box.excerpt
        }
      }
    }

    if (boxes.length === 0 || focusPage === undefined || !focusBbox) {
      clearActive()
      return
    }

    swoopToPage(focusPage)
    activateResolved({
      chosen: {
        R: {
          docId: bookIndex?.docId ?? 'fanout',
          kind: 'text',
          key: focusKey ?? slots[0].key,
          start: 0,
          end: Math.max(1, focusExcerpt.length),
          page: focusPage,
          emphasisId: 'fanout_slot',
          chunkIds: [],
          source: 'ocr',
          memberKeys: slots.map((s) => s.key),
          faces: {
            text: {
              start: 0,
              end: Math.max(1, focusExcerpt.length),
              content: focusExcerpt || ' ',
            },
          },
        },
        excerpt: focusExcerpt || ' ',
        score: 1,
        chunkIds: [],
        boxes,
        members,
      },
      candidates: [],
    })
  }, [
    selectedSlotKey,
    activePath,
    bookIndex,
    activateResolved,
    clearActive,
    swoopToPage,
  ])

  const layers: Array<{
    id: FanoutLayerId
    label: string
    color: string
    y: number
  }> = [
    { id: 'pdf', label: 'PDF 扑克层（输入）', color: COLOR_PDF, y: FANOUT_LAYER_Y.pdf },
    {
      id: 'ocr',
      label: 'OCR 切割层（同页宽内横排，满则上叠）',
      color: COLOR_RETRIEVE,
      y: FANOUT_LAYER_Y.ocr,
    },
    {
      id: 'compose',
      label: '组合层（member 配方）',
      color: COLOR_COMPOSE,
      y: FANOUT_LAYER_Y.compose,
    },
    {
      id: 'infer',
      label: '推理层（结论输出）',
      color: COLOR_INFER,
      y: FANOUT_LAYER_Y.infer,
    },
  ]

  return (
    <group>
      {layers.map((L) => (
        <LayerDeck
          key={L.id}
          y={L.y}
          radius={
            ringR * (L.id === 'pdf' ? 1.05 : L.id === 'ocr' ? 0.95 : 0.72)
          }
          color={L.color}
          label={L.label}
          opacity={L.id === 'pdf' ? 0.12 : 0.2}
        />
      ))}

      {indexReady && (
        <OcrIndexPoker
          pageCount={pageCount}
          highlightKeys={highlightKeys}
          selectedSlotKey={selectedSlotKey}
          onSelectSlot={(key, page) => {
            setSelectedSlotKey(key)
            swoopToPage(page)
          }}
        />
      )}

      {paths.map((path) => (
        <PathStack
          key={path.pathId}
          path={path}
          active={path.pathId === (activePath?.pathId ?? null)}
          pageCount={pageCount}
          selectedSlotKey={selectedSlotKey}
          onSelectPath={() => setActivePathId(path.pathId)}
          onSelectSlot={(key) => setSelectedSlotKey(key)}
        />
      ))}
    </group>
  )
}