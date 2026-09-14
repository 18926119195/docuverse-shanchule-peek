import { Html, Line, Text, useTexture } from '@react-three/drei'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useDocuverse } from './store'
import {
  OCR_PLANE_GAP,
  PAGE_H,
  PAGE_W,
  ocrPanelOffset,
  pageHomePosition,
  pageHomeQuaternion,
} from './geometry'
import {
  bboxToLocalRect,
  fitOcrFontSize,
  sanitizeOcrDisplayText,
  type OcrBlock,
} from '../data/ocrService'

const noRaycast = (() => undefined) as unknown as THREE.Mesh['raycast']

/** Title chrome — drawn on top; must NOT shift block coordinates */
const HEADER_H = 0.55

/** Shared grid: source highlights and OCR chunks use this exact mapping */
function blockRect(bbox: OcrBlock['bbox']) {
  return bboxToLocalRect(bbox, PAGE_W, PAGE_H, 0)
}

function OcrPageUnderlay({ url }: { url: string }) {
  const texture = useTexture(url)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  return (
    <mesh position={[0, 0, 0.01]} raycast={noRaycast}>
      <planeGeometry args={[PAGE_W, PAGE_H]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={0.28}
        toneMapped={false}
      />
    </mesh>
  )
}

/** In-place editor on the OCR twin — type / delete directly on the page */
function OcrInlineEditor({
  block,
  rect,
}: {
  block: OcrBlock
  rect: { w: number; h: number }
}) {
  const updateOcrBlockContent = useDocuverse((s) => s.updateOcrBlockContent)
  const endOcrInlineEdit = useDocuverse((s) => s.endOcrInlineEdit)
  const deleteOcrBlock = useDocuverse((s) => s.deleteOcrBlock)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [block.id])

  const cssW = Math.max(140, rect.w * 58)
  const cssH = Math.max(52, rect.h * 58)

  return (
    <Html
      transform
      center
      position={[0, 0, 0.09]}
      distanceFactor={7}
      zIndexRange={[200, 0]}
      style={{ pointerEvents: 'auto' }}
    >
      <textarea
        ref={ref}
        className="ocr-inline-input"
        value={block.content}
        spellCheck={false}
        style={{ width: cssW, height: cssH }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onChange={(e) => updateOcrBlockContent(block.id, e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            endOcrInlineEdit()
            return
          }
          // Empty block + Delete/Backspace alone → remove overlay (binding gone for this chunk only)
          if (
            (e.key === 'Delete' || e.key === 'Backspace') &&
            block.content.length === 0 &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault()
            deleteOcrBlock(block.id)
            endOcrInlineEdit()
          }
        }}
      />
    </Html>
  )
}

/**
 * Same-plane OCR twin: sits to the right of the active page.
 * Double-click a chunk to type / delete in place (bbox binding stays).
 */
export function OcrComparePlane() {
  const ocrOpen = useDocuverse((s) => s.ocrOpen)
  const ocrBusy = useDocuverse((s) => s.ocrBusy)
  const ocrError = useDocuverse((s) => s.ocrError)
  const ocrActiveStrand = useDocuverse((s) => s.ocrActiveStrand)
  const ocrByStrand = useDocuverse((s) => s.ocrByStrand)
  const ocrHoverBlock = useDocuverse((s) => s.ocrHoverBlock)
  const ocrEditingBlockId = useDocuverse((s) => s.ocrEditingBlockId)
  const ocrInlineEdit = useDocuverse((s) => s.ocrInlineEdit)
  const setOcrHoverBlock = useDocuverse((s) => s.setOcrHoverBlock)
  const beginOcrInlineEdit = useDocuverse((s) => s.beginOcrInlineEdit)
  const endOcrInlineEdit = useDocuverse((s) => s.endOcrInlineEdit)
  const pages = useDocuverse((s) => s.pages)
  const closeOcrPanel = useDocuverse((s) => s.closeOcrPanel)

  const result =
    ocrOpen && ocrActiveStrand !== null ? ocrByStrand[ocrActiveStrand] : undefined
  const sourcePage =
    ocrOpen && ocrActiveStrand !== null ? pages[ocrActiveStrand] : undefined

  const hoverBlock =
    result && ocrHoverBlock !== null
      ? result.blocks.find((x) => x.id === ocrHoverBlock)
      : undefined
  const hoverRect = hoverBlock ? blockRect(hoverBlock.bbox) : null

  if (!ocrOpen || ocrActiveStrand === null) return null

  const home = pageHomePosition(ocrActiveStrand, pages.length)
  const [ox, oy, oz] = ocrPanelOffset(ocrActiveStrand, pages.length)
  const pos: [number, number, number] = [home[0] + ox, home[1] + oy, home[2] + oz]
  const textBlocks = result?.blocks ?? []
  const quat = pageHomeQuaternion(ocrActiveStrand, pages.length)

  return (
    <group position={pos} quaternion={quat}>
      <mesh raycast={noRaycast}>
        <planeGeometry args={[PAGE_W, PAGE_H]} />
        <meshBasicMaterial color="#f4f1ea" toneMapped={false} />
      </mesh>

      {/* Click empty paper ends inline edit */}
      <mesh
        position={[0, 0, 0.005]}
        onPointerDown={(e) => {
          if (!ocrInlineEdit) return
          e.stopPropagation()
          endOcrInlineEdit()
        }}
      >
        <planeGeometry args={[PAGE_W, PAGE_H]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {sourcePage?.imageUrl && <OcrPageUnderlay url={sourcePage.imageUrl} />}

      <mesh position={[0, 0, -0.02]} raycast={noRaycast}>
        <planeGeometry args={[PAGE_W + 0.2, PAGE_H + 0.2]} />
        <meshBasicMaterial color="#00e5ff" transparent opacity={0.55} />
      </mesh>

      {ocrBusy && (
        <Text
          position={[0, 0.5, 0.12]}
          fontSize={0.28}
          color="#1a2332"
          anchorX="center"
          anchorY="middle"
          raycast={noRaycast}
        >
          GLM-OCR 识别中…
        </Text>
      )}

      {ocrError && !ocrBusy && (
        <Text
          position={[0, 0.3, 0.12]}
          fontSize={0.18}
          color="#b71c1c"
          anchorX="center"
          anchorY="middle"
          maxWidth={PAGE_W - 1.2}
          raycast={noRaycast}
        >
          {ocrError}
        </Text>
      )}

      {!ocrBusy &&
        result &&
        textBlocks.map((b) => {
          const rect = blockRect(b.bbox)
          const inline = ocrInlineEdit && ocrEditingBlockId === b.id
          const raw = b.content.trim() ? b.content : '（双击编辑）'
          const display = sanitizeOcrDisplayText(raw) || '（空）'
          const fontSize = fitOcrFontSize(display, rect.w, rect.h)
          const hot = ocrHoverBlock === b.id || ocrEditingBlockId === b.id
          const edited = b.content !== b.sourceContent
          const halfW = rect.w / 2
          const halfH = rect.h / 2
          return (
            <group key={b.id} position={[rect.x, rect.y, 0.05]}>
              <mesh
                onPointerOver={(e) => {
                  e.stopPropagation()
                  setOcrHoverBlock(b.id)
                }}
                onPointerOut={() => {
                  if (ocrEditingBlockId !== b.id) setOcrHoverBlock(null)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  beginOcrInlineEdit(b.id)
                }}
                onPointerDown={(e) => {
                  // keep double-click target from dismissing via paper
                  e.stopPropagation()
                }}
              >
                <planeGeometry args={[rect.w, rect.h]} />
                <meshBasicMaterial
                  color={
                    inline
                      ? '#fff59d'
                      : b.confirmed
                        ? '#a5d6a7'
                        : edited
                          ? '#b3e5fc'
                          : hot
                            ? '#c8e6c9'
                            : '#dcedc8'
                  }
                  transparent
                  opacity={inline ? 0.85 : hot || b.confirmed ? 0.72 : 0.4}
                  depthWrite={false}
                />
              </mesh>
              {inline ? (
                <OcrInlineEditor block={b} rect={rect} />
              ) : (
                <Text
                  position={[0, 0, 0.02]}
                  fontSize={fontSize}
                  color="#1c1a16"
                  anchorX="center"
                  anchorY="middle"
                  maxWidth={rect.w * 0.92}
                  overflowWrap="break-word"
                  whiteSpace="normal"
                  clipRect={[
                    -halfW * 0.98,
                    -halfH * 0.98,
                    halfW * 0.98,
                    halfH * 0.98,
                  ]}
                  raycast={noRaycast}
                >
                  {display}
                </Text>
              )}
            </group>
          )
        })}

      {hoverRect && !ocrInlineEdit && (
        <Line
          points={[
            [-OCR_PLANE_GAP - PAGE_W / 2, hoverRect.y, 0.08],
            [hoverRect.x - hoverRect.w / 2, hoverRect.y, 0.08],
          ]}
          color="#00e5ff"
          lineWidth={1.5}
        />
      )}

      <mesh position={[0, PAGE_H / 2 - HEADER_H / 2, 0.14]} raycast={noRaycast}>
        <planeGeometry args={[PAGE_W - 0.3, HEADER_H]} />
        <meshBasicMaterial color="#0d3a45" transparent opacity={0.92} />
      </mesh>
      <Text
        position={[0, PAGE_H / 2 - HEADER_H / 2, 0.15]}
        fontSize={0.18}
        color="#e8fbff"
        anchorX="center"
        anchorY="middle"
        maxWidth={PAGE_W - 0.6}
        raycast={noRaycast}
      >
        {`OCR 对照 · 双击切块直接编辑 · Esc 结束`}
      </Text>

      <mesh
        position={[PAGE_W / 2 - 0.45, PAGE_H / 2 - HEADER_H / 2, 0.16]}
        onClick={(e) => {
          e.stopPropagation()
          closeOcrPanel()
        }}
      >
        <planeGeometry args={[0.7, 0.4]} />
        <meshBasicMaterial color="#ff8a80" />
      </mesh>
      <Text
        position={[PAGE_W / 2 - 0.45, PAGE_H / 2 - HEADER_H / 2, 0.17]}
        fontSize={0.16}
        color="#1a1010"
        anchorX="center"
        anchorY="middle"
        raycast={noRaycast}
      >
        关闭
      </Text>
    </group>
  )
}

/** Highlight matching OCR blocks on the *original* page — same blockRect() as twin */
export function OcrSourceHighlights({
  strandIndex,
}: {
  strandIndex: number
}) {
  const ocrOpen = useDocuverse((s) => s.ocrOpen)
  const ocrActiveStrand = useDocuverse((s) => s.ocrActiveStrand)
  const ocrByStrand = useDocuverse((s) => s.ocrByStrand)
  const ocrHoverBlock = useDocuverse((s) => s.ocrHoverBlock)
  const ocrEditingBlockId = useDocuverse((s) => s.ocrEditingBlockId)
  const setOcrHoverBlock = useDocuverse((s) => s.setOcrHoverBlock)
  const beginOcrInlineEdit = useDocuverse((s) => s.beginOcrInlineEdit)

  if (!ocrOpen || ocrActiveStrand !== strandIndex) return null
  const result = ocrByStrand[strandIndex]
  if (!result) return null

  return (
    <group>
      {result.blocks.map((b) => {
        const rect = blockRect(b.bbox)
        const hot = ocrHoverBlock === b.id || ocrEditingBlockId === b.id
        return (
          <mesh
            key={`src-${b.id}`}
            position={[rect.x, rect.y, 0.11]}
            onPointerOver={(e) => {
              e.stopPropagation()
              setOcrHoverBlock(b.id)
            }}
            onPointerOut={() => {
              if (ocrEditingBlockId !== b.id) setOcrHoverBlock(null)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              // Jump edit focus to the twin at the same binding
              beginOcrInlineEdit(b.id)
            }}
          >
            <planeGeometry args={[rect.w, rect.h]} />
            <meshBasicMaterial
              color={hot ? '#00e5ff' : '#76ff03'}
              transparent
              opacity={hot ? 0.45 : 0.2}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        )
      })}
    </group>
  )
}
