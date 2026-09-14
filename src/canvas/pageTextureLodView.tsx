import { useEffect, useRef, useState, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import {
  cameraDistanceToPage,
  getPageTextureLod,
  pickPageTextureLod,
  type PageTextureLodLevel,
} from './pageTextureLod'
import { PAGE_H, PAGE_W } from './geometry'

const noRaycast = (() => undefined) as unknown as THREE.Mesh['raycast']

const LOD_CHECK_INTERVAL_S = 0.12

interface PageTextureLodProps {
  url: string
  opacity: number
  pageGroup: RefObject<THREE.Group | null>
  role: 'current' | 'companion' | 'background'
  emphasizeMode: boolean
  isAimOrStrokePage: boolean
}

export function PageTextureLodView({
  url,
  opacity,
  pageGroup,
  role,
  emphasizeMode,
  isAimOrStrokePage,
}: PageTextureLodProps) {
  const matRef = useRef<THREE.MeshBasicMaterial>(null)
  const lodRef = useRef<PageTextureLodLevel>(0)
  const applyingRef = useRef(false)
  const mountedRef = useRef(true)
  const lastCheckRef = useRef(0)
  const { camera, invalidate } = useThree()
  const [ready, setReady] = useState(false)

  const applyLod = (level: PageTextureLodLevel) => {
    if (applyingRef.current || lodRef.current === level) return
    applyingRef.current = true
    void getPageTextureLod(url, level)
      .then((tex) => {
        if (!mountedRef.current || !matRef.current) return
        matRef.current.map = tex
        matRef.current.needsUpdate = true
        lodRef.current = level
        setReady(true)
        invalidate()
      })
      .catch((e) => {
        console.warn('PageTextureLod', e)
      })
      .finally(() => {
        applyingRef.current = false
      })
  }

  useEffect(() => {
    mountedRef.current = true
    lodRef.current = -1 as PageTextureLodLevel
    setReady(false)
    applyLod(role === 'background' ? 0 : 1)
    return () => {
      mountedRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount on url
  }, [url])

  useFrame((state) => {
    const t = state.clock.elapsedTime
    if (t - lastCheckRef.current < LOD_CHECK_INTERVAL_S) return
    lastCheckRef.current = t

    const g = pageGroup.current
    if (!g) return
    g.updateWorldMatrix(true, false)
    const dist = cameraDistanceToPage(camera, g.matrixWorld)
    const next = pickPageTextureLod({
      distance: dist,
      role,
      emphasizeMode,
      isAimOrStrokePage,
      currentLevel: lodRef.current >= 0 ? lodRef.current : 0,
    })
    if (next !== lodRef.current) {
      applyLod(next)
    }
  })

  return (
    <mesh castShadow receiveShadow raycast={noRaycast}>
      <planeGeometry args={[PAGE_W, PAGE_H]} />
      <meshBasicMaterial
        ref={matRef}
        transparent={opacity < 0.999}
        opacity={ready ? opacity : opacity * 0.85}
        depthWrite={opacity > 0.5}
        side={THREE.DoubleSide}
        toneMapped={false}
        color={ready ? '#ffffff' : '#e8e4da'}
      />
    </mesh>
  )
}
