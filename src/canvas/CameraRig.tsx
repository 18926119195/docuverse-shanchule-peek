import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useDocuverse } from './store'
import {
  innerSphereRadius,
  pageRadialDirection,
  radialToYawPitch,
  readingOuterRadius,
  yawPitchToRadial,
} from './geometry'
import { perspectiveFovApproachingOrtho } from './constructionCamera'

const DEFAULT_FOV = 50

/**
 * Roaming: outer shell, lookAt origin.
 * Relation lenses: eye + lookAt derived from objects (cameraEye / cameraLookAt).
 * Construction: perspective FOV shrinks as view distance grows → approaches ortho.
 */
export function CameraRig() {
  const { camera } = useThree()
  const swooping = useDocuverse((s) => s.swooping)
  const pages = useDocuverse((s) => s.pages)
  const ocrOpen = useDocuverse((s) => s.ocrOpen)
  const linkFocusId = useDocuverse((s) => s.linkFocusId)
  const viewPathMode = useDocuverse((s) => s.viewPathMode)
  const cameraLens = useDocuverse((s) => s.cameraLens)
  const tickViewPathPlayback = useDocuverse((s) => s.tickViewPathPlayback)
  const total = Math.max(pages.length, 1)

  useFrame((_, dt) => {
    if (viewPathMode === 'playing') {
      tickViewPathPlayback(dt)
    }

    let state = useDocuverse.getState()
    if (state.constructionStage === 'crossing') {
      state.tickConstructionCrossing(dt)
      state = useDocuverse.getState()
    }

    const inner = innerSphereRadius(total)
    const minR = inner + 3
    const maxR = inner * 5 + 80

    const eye = state.cameraEye
    const look = state.cameraLookAt
    const lens = state.cameraLens
    const useDerived =
      eye &&
      look &&
      (lens === 'construction' ||
        lens === 'retrospective' ||
        lens === 'tetrahedron')

    let desired: THREE.Vector3
    const pan = state.viewPan
    const panV = new THREE.Vector3(pan[0], pan[1], pan[2])
    if (useDerived && eye) {
      desired = new THREE.Vector3(eye[0], eye[1], eye[2])
    } else {
      const shellDir = yawPitchToRadial(state.viewYaw, state.viewPitch)
      const r = THREE.MathUtils.clamp(state.cameraDistance, minR, maxR)
      desired = shellDir.multiplyScalar(r).add(panV)
    }

    const speed =
      viewPathMode === 'playing' || viewPathMode === 'paused'
        ? 14
        : swooping || ocrOpen || linkFocusId || cameraLens !== 'roaming'
          ? state.constructionStage === 'crossing'
            ? 14
            : 6.5
          : 3.2
    camera.position.lerp(desired, 1 - Math.exp(-speed * dt))

    if (useDerived && look) {
      camera.lookAt(look[0], look[1], look[2])
    } else {
      camera.lookAt(panV.x, panV.y, panV.z)
    }

    const rNow = camera.position.length()
    camera.near = Math.max(
      0.02,
      useDerived ? 0.05 : rNow - inner - 4,
    )
    camera.far = Math.max(800, rNow * 2.5 + inner * 2)

    // Perspective → ortho limit for planar construction / retrospective
    if (camera instanceof THREE.PerspectiveCamera) {
      if (
        useDerived &&
        eye &&
        look &&
        (lens === 'construction' || lens === 'retrospective') &&
        state.constructionStage === 'planar'
      ) {
        const dist = Math.hypot(
          eye[0] - look[0],
          eye[1] - look[1],
          eye[2] - look[2],
        )
        const targetFov = perspectiveFovApproachingOrtho(dist)
        camera.fov += (targetFov - camera.fov) * Math.min(1, 8 * dt)
      } else if (
        state.constructionStage === 'crossing' ||
        state.constructionStage === 'rail'
      ) {
        // Keep perspectival for 穿越感
        if (Math.abs(camera.fov - 42) > 0.05) {
          camera.fov += (42 - camera.fov) * Math.min(1, 6 * dt)
        }
      } else if (Math.abs(camera.fov - DEFAULT_FOV) > 0.05) {
        camera.fov += (DEFAULT_FOV - camera.fov) * Math.min(1, 6 * dt)
      }
    }

    camera.updateProjectionMatrix()
  })

  return null
}

/**
 * LMB: pan (roaming). RMB: orbit on outer sphere. Wheel: radius (fine steps).
 */
export function OrbitControlsProxy() {
  const orbit = useDocuverse((s) => s.orbit)
  const panRoamingView = useDocuverse((s) => s.panRoamingView)
  const panConstructionView = useDocuverse((s) => s.panConstructionView)
  const orbitConstructionRail = useDocuverse((s) => s.orbitConstructionRail)
  const setCameraDistance = useDocuverse((s) => s.setCameraDistance)
  const commitViewKeyframe = useDocuverse((s) => s.commitViewKeyframe)
  const pauseViewPath = useDocuverse((s) => s.pauseViewPath)
  const pages = useDocuverse((s) => s.pages)
  const dragging = useRef(false)
  const armed = useRef(false)
  const activeButton = useRef<number | null>(null)
  const origin = useRef({ x: 0, y: 0 })
  const last = useRef({ x: 0, y: 0 })
  const { gl } = useThree()

  /** Wheel zoom — smaller = finer control */
  const WHEEL_ROAMING = 0.00052
  const WHEEL_LENS = 0.00105
  const ORBIT_YAW = 0.002
  const ORBIT_PITCH = 0.0016

  useEffect(() => {
    const el = gl.domElement
    const onDown = (e: MouseEvent) => {
      const state = useDocuverse.getState()
      if (state.emphasizeMode && e.button === 0) return
      if (e.button === 2 && state.suppressCameraOrbit) {
        useDocuverse.setState({ suppressCameraOrbit: false })
      } else if (e.button !== 2 && state.suppressCameraOrbit) {
        return
      }
      const lens = state.cameraLens
      const relation =
        lens === 'construction' || lens === 'retrospective'
      if (relation) {
        if (e.button !== 2) return
      } else if (e.button !== 0 && e.button !== 2) {
        return
      }
      const mode = state.viewPathMode
      if (mode === 'playing') pauseViewPath()
      armed.current = true
      dragging.current = false
      activeButton.current = e.button
      origin.current = { x: e.clientX, y: e.clientY }
      last.current = { x: e.clientX, y: e.clientY }
    }
    const onUp = () => {
      if (armed.current && dragging.current && activeButton.current === 2) {
        const s = useDocuverse.getState()
        if (s.cameraLens === 'roaming') {
          if (s.viewPathMode === 'paused') {
            s.liveViewPath()
          }
          commitViewKeyframe({ tag: '环视' })
        }
      }
      armed.current = false
      dragging.current = false
      activeButton.current = null
    }
    const onMove = (e: MouseEvent) => {
      if (!armed.current || activeButton.current === null) return
      if (useDocuverse.getState().emphasisStrokeActive) {
        armed.current = false
        dragging.current = false
        activeButton.current = null
        return
      }
      if (useDocuverse.getState().suppressCameraOrbit) {
        armed.current = false
        dragging.current = false
        activeButton.current = null
        return
      }
      const dx0 = e.clientX - origin.current.x
      const dy0 = e.clientY - origin.current.y
      if (!dragging.current) {
        if (Math.hypot(dx0, dy0) < 6) return
        dragging.current = true
      }
      const dx = e.clientX - last.current.x
      const dy = e.clientY - last.current.y
      last.current = { x: e.clientX, y: e.clientY }
      if (useDocuverse.getState().viewPathMode === 'playing') {
        pauseViewPath()
      }
      const state = useDocuverse.getState()
      const lens = state.cameraLens
      const btn = activeButton.current

      if (btn === 0 && lens === 'roaming') {
        panRoamingView(dx, dy)
        return
      }

      if (btn !== 2) return

      if (lens === 'construction' || lens === 'retrospective') {
        if (state.constructionStage === 'rail') {
          orbitConstructionRail(-dx * ORBIT_YAW, -dy * ORBIT_PITCH)
        } else if (state.constructionStage === 'planar') {
          panConstructionView(dx, dy)
        }
      } else {
        orbit(-dx * ORBIT_YAW, -dy * ORBIT_PITCH)
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (useDocuverse.getState().viewPathMode === 'playing') {
        pauseViewPath()
      }
      const state = useDocuverse.getState()
      if (state.cameraEye && state.cameraLookAt && state.cameraLens !== 'roaming') {
        const eye = new THREE.Vector3(...state.cameraEye)
        const look = new THREE.Vector3(...state.cameraLookAt)
        const dir = eye.clone().sub(look)
        const len = dir.length()
        if (len > 0.5) {
          const factor = Math.exp(e.deltaY * WHEEL_LENS)
          const nextLen = THREE.MathUtils.clamp(len * factor, 1.2, 2500)
          dir.multiplyScalar(nextLen / len)
          const nextEye = look.clone().add(dir)
          const { yaw, pitch } = radialToYawPitch(nextEye)
          useDocuverse.setState({
            cameraEye: [nextEye.x, nextEye.y, nextEye.z],
            viewYaw: yaw,
            viewPitch: pitch,
            cameraDistance: nextEye.length(),
          })
        }
        return
      }
      const total = Math.max(state.pages.length, 1)
      const inner = innerSphereRadius(total)
      const minR = inner + 3
      const maxR = inner * 5 + 80
      const factor = Math.exp(e.deltaY * WHEEL_ROAMING)
      const next = THREE.MathUtils.clamp(
        state.cameraDistance * factor,
        minR,
        maxR,
      )
      setCameraDistance(next)
    }
    const onCtx = (e: MouseEvent) => {
      e.preventDefault()
    }
    el.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('mousemove', onMove)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('contextmenu', onCtx)
    return () => {
      el.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('mousemove', onMove)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('contextmenu', onCtx)
    }
  }, [
    gl,
    orbit,
    panRoamingView,
    panConstructionView,
    orbitConstructionRail,
    setCameraDistance,
    commitViewKeyframe,
    pauseViewPath,
    pages.length,
  ])

  return null
}

export function yawPitchForStrand(strand: number, total: number) {
  return radialToYawPitch(pageRadialDirection(strand, total))
}

export function defaultReadingDistance(total: number) {
  return readingOuterRadius(Math.max(total, 1))
}
