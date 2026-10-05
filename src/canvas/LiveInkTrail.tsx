/**
 * Per-page GPU ink line — registered for synchronous pointer writes.
 */

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import {
  INK_TRAIL_CAP,
  registerInkTrail,
  unregisterInkTrail,
} from './liveInkGpu'
import { pageDraftStrokeColor } from './emphasisStroke'

const noHit = (() => undefined) as unknown as THREE.Mesh['raycast']

export function LiveInkTrail({ strandIndex }: { strandIndex: number }) {
  const positions = useMemo(() => new Float32Array(INK_TRAIL_CAP * 3), [])
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const attr = new THREE.BufferAttribute(positions, 3).setUsage(
      THREE.DynamicDrawUsage,
    )
    g.setAttribute('position', attr)
    g.setDrawRange(0, 0)
    return g
  }, [positions])

  const attr = useMemo(
    () => geom.getAttribute('position') as THREE.BufferAttribute,
    [geom],
  )

  const mat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: pageDraftStrokeColor(strandIndex),
        depthTest: true,
        transparent: true,
        opacity: 1,
        linewidth: 3,
      }),
    [strandIndex],
  )

  const line = useMemo(() => {
    const obj = new THREE.Line(geom, mat)
    obj.frustumCulled = false
    obj.renderOrder = 60
    obj.raycast = noHit
    return obj
  }, [geom, mat])

  useEffect(() => {
    registerInkTrail(strandIndex, { positions, attr, geom })
    return () => unregisterInkTrail(strandIndex)
  }, [strandIndex, positions, attr, geom])

  useEffect(
    () => () => {
      geom.dispose()
      mat.dispose()
    },
    [geom, mat],
  )

  return <primitive object={line} />
}
