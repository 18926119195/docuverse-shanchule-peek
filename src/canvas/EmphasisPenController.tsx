import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import {
  distPage,
  resolveClosedEmphasisRing,
  type PagePoint,
} from '../data/emphasis'
import {
  beginStrokePickCache,
  endStrokePickCache,
  invalidatePagePickRect,
  pickPageNormOnStrand,
  pickPageSurfaceForAim,
  pickPageUnderCursorForStroke,
} from './pageSurfaceRegistry'
import {
  appendInkTrailVertex,
  clearInkTrail,
  rebuildInkTrail,
  scheduleInkRedraw,
  setInkInvalidate,
} from './liveInkGpu'
import { getEmphasisAim, setEmphasisAim } from './emphasisAim'
import { useDocuverse } from './store'

const _ndc = new THREE.Vector2()
const _ray = new THREE.Raycaster()

/** Visual trail dedupe (page_norm 0–1000). */
const MIN_GPU_DIST = 0.35
/** Seal polygon subsample. */
const MIN_SEAL_DIST = 0.5

function tryPushSealPoint(
  pts: PagePoint[],
  next: PagePoint,
  minDist: number,
): boolean {
  if (pts.length === 0) {
    pts.push(next)
    return true
  }
  if (distPage(pts[pts.length - 1], next) < minDist) return false
  pts.push(next)
  return true
}

/**
 * GPU buffer append on pointer; one invalidate per frame.
 * Stroke uses pointerrawupdate only (no duplicate pointermove).
 */
export function EmphasisPenController() {
  const emphasizeMode = useDocuverse((s) => s.emphasizeMode)
  const sealEmphasisDraft = useDocuverse((s) => s.sealEmphasisDraft)
  const { gl, camera, scene, invalidate } = useThree()
  const stroke = useRef<{
    pointerId: number
    strandIndex: number
    pts: PagePoint[]
  } | null>(null)
  const handleCache = useRef<THREE.Object3D[]>([])

  useEffect(() => {
    setInkInvalidate(() => invalidate())
    return () => setInkInvalidate(null)
  }, [invalidate])

  useEffect(() => {
    if (!emphasizeMode) {
      stroke.current = null
      setEmphasisAim(null)
      endStrokePickCache()
      useDocuverse.setState({
        emphasisStrokeActive: false,
        suppressCameraOrbit: false,
      })
      return
    }

    const el = gl.domElement
    invalidatePagePickRect()

    const refreshHandles = () => {
      const handles: THREE.Object3D[] = []
      scene.traverse((o) => {
        const kind = o.userData?.constructionHandle
        if (kind === 'core' || kind === true) handles.push(o)
      })
      handleCache.current = handles
    }
    refreshHandles()

    const hitsHandleFirst = (
      clientX: number,
      clientY: number,
    ): { dist: number } | null => {
      const handles = handleCache.current
      if (handles.length === 0) return null
      const rect = el.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return null
      _ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1
      _ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1
      _ray.setFromCamera(_ndc, camera)
      const hits = _ray.intersectObjects(handles, false)
      if (hits.length === 0) return null
      return { dist: hits[0].distance }
    }

    const endStrokeUi = () => {
      useDocuverse.setState({
        emphasisStrokeActive: false,
        suppressCameraOrbit: false,
      })
    }

    const trySeal = (pts: PagePoint[], strandIndex: number): boolean => {
      const ring = resolveClosedEmphasisRing(pts)
      if (!ring) return false
      endStrokePickCache()
      clearInkTrail(strandIndex)
      // Pass confirmed ring directly — store must not re-detect (ring is already closed)
      sealEmphasisDraft(strandIndex, ring)
      stroke.current = null
      invalidate()
      return true
    }

    const sampleStroke = (
      s: NonNullable<typeof stroke.current>,
      clientX: number,
      clientY: number,
    ): void => {
      const uv = pickPageNormOnStrand(
        s.strandIndex,
        clientX,
        clientY,
        camera,
        el,
      )
      if (!uv) return

      if (appendInkTrailVertex(s.strandIndex, uv, MIN_GPU_DIST)) {
        scheduleInkRedraw()
      }
      tryPushSealPoint(s.pts, uv, MIN_SEAL_DIST)
    }

    const onStrokeMove = (e: PointerEvent) => {
      const s = stroke.current
      if (!s || e.pointerId !== s.pointerId) return
      e.preventDefault()

      const coalesced =
        typeof e.getCoalescedEvents === 'function'
          ? e.getCoalescedEvents()
          : null
      if (coalesced && coalesced.length > 1) {
        for (const ev of coalesced) {
          sampleStroke(s, ev.clientX, ev.clientY)
        }
      } else {
        sampleStroke(s, e.clientX, e.clientY)
      }
    }

    const onAimMove = (e: PointerEvent) => {
      if (stroke.current) return
      if (e.buttons !== 0) return
      const hit = pickPageSurfaceForAim(
        e.clientX,
        e.clientY,
        camera,
        el,
        getEmphasisAim(),
      )
      if (!hit) return
      setEmphasisAim(hit.strandIndex)
    }

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      if (!useDocuverse.getState().emphasizeMode) return
      invalidatePagePickRect()
      refreshHandles()

      const pageHit = pickPageUnderCursorForStroke(
        e.clientX,
        e.clientY,
        camera,
        el,
      )
      if (!pageHit) {
        if (hitsHandleFirst(e.clientX, e.clientY)) return
        return
      }

      const strand = pageHit.strandIndex
      const uv = pageHit.uv
      setEmphasisAim(strand)

      e.preventDefault()
      e.stopImmediatePropagation()

      beginStrokePickCache(strand)
      useDocuverse.setState({
        emphasisStrokeActive: true,
        suppressCameraOrbit: true,
        emphasisDraftStrand: strand,
        emphasisDraftPoints: [],
      })

      const pts: PagePoint[] = [uv]
      stroke.current = {
        pointerId: e.pointerId,
        strandIndex: strand,
        pts,
      }

      clearInkTrail(strand)
      rebuildInkTrail(strand, pts)
      invalidate()

      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }

    const onUp = (e: PointerEvent) => {
      const s = stroke.current
      if (!s || e.pointerId !== s.pointerId) return
      sampleStroke(s, e.clientX, e.clientY)
      if (!trySeal(s.pts, s.strandIndex)) {
        endStrokePickCache()
        useDocuverse.setState({
          emphasisDraftPoints: [...s.pts],
          emphasisDraftStrand: s.strandIndex,
        })
        clearInkTrail(s.strandIndex)
        stroke.current = null
        endStrokeUi()
        invalidate()
      }
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }

    const onResize = () => invalidatePagePickRect()

    const hasRaw =
      typeof window !== 'undefined' && 'onpointerrawupdate' in window

    el.addEventListener('pointerdown', onDown, true)
  // Stroke: one listener path — raw preferred, else move
    if (hasRaw) {
      window.addEventListener('pointerrawupdate', onStrokeMove as EventListener)
    } else {
      window.addEventListener('pointermove', onStrokeMove)
    }
    window.addEventListener('pointermove', onAimMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('resize', onResize)

    return () => {
      el.removeEventListener('pointerdown', onDown, true)
      if (hasRaw) {
        window.removeEventListener(
          'pointerrawupdate',
          onStrokeMove as EventListener,
        )
      } else {
        window.removeEventListener('pointermove', onStrokeMove)
      }
      window.removeEventListener('pointermove', onAimMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('resize', onResize)
      stroke.current = null
      setEmphasisAim(null)
      endStrokePickCache()
      endStrokeUi()
    }
  }, [emphasizeMode, gl, camera, scene, invalidate, sealEmphasisDraft])

  return null
}
