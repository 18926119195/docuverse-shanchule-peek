/**
 * Origin 矢量风格：Position=Tail（from）→ 尖（to）。
 * 轴：虚线；箭尖：Open（双翼 V，非实心锥）。
 */

import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'

const noHit = (() => undefined) as unknown as THREE.Mesh['raycast']

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

/** Origin Arrowheads · Angle≈75° → 每翼相对轴 ≈37.5° */
const HEAD_HALF_DEG = 37.5

export function DirectedShaft({
  from,
  to,
  color,
  dim = false,
  lineWidth = 2.4,
  dashed = true,
}: {
  from: THREE.Vector3 | [number, number, number]
  to: THREE.Vector3 | [number, number, number]
  color: string
  dim?: boolean
  lineWidth?: number
  /** 默认虚线轴（Origin 矢量 + 虚线要求） */
  dashed?: boolean
}) {
  const a = useMemo(
    () =>
      from instanceof THREE.Vector3
        ? from.clone()
        : new THREE.Vector3(from[0], from[1], from[2]),
    [from],
  )
  const b = useMemo(
    () =>
      to instanceof THREE.Vector3
        ? to.clone()
        : new THREE.Vector3(to[0], to[1], to[2]),
    [to],
  )

  const geom = useMemo(() => {
    const delta = b.clone().sub(a)
    const len = delta.length()
    const dir =
      len < 1e-6 ? new THREE.Vector3(0, 1, 0) : delta.clone().normalize()

    // Open 箭尖：沿 -dir 收回 headLen，两侧张开（Origin Angle≈75°）
    const headLen = clamp(len * 0.12, 0.45, 2.4)
    const half = (HEAD_HALF_DEG * Math.PI) / 180
    const flare = headLen * Math.tan(half)

    const ref =
      Math.abs(dir.y) < 0.92
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0)
    const side = new THREE.Vector3().crossVectors(dir, ref).normalize()
    const up = new THREE.Vector3().crossVectors(side, dir).normalize()

    const tip = b.clone()
    const base = tip.clone().add(dir.clone().multiplyScalar(-headLen))
    const wingL = base.clone().add(up.clone().multiplyScalar(flare))
    const wingR = base.clone().add(up.clone().multiplyScalar(-flare))

    // 轴从尾到箭尖根，虚线不穿进 V
    const shaftStart = a.clone()
    const shaftEnd = base.clone().add(dir.clone().multiplyScalar(headLen * 0.08))
    const safeEnd =
      shaftEnd.distanceTo(shaftStart) < len * 0.12
        ? a.clone().lerp(b, 0.62)
        : shaftEnd
    const n = 12
    const shaft: THREE.Vector3[] = []
    for (let i = 0; i <= n; i++) {
      shaft.push(shaftStart.clone().lerp(safeEnd, i / n))
    }

    const dashSize = clamp(len * 0.035, 0.22, 1.1)
    const gapSize = clamp(len * 0.022, 0.14, 0.7)

    return {
      shaft,
      headL: [wingL, tip] as [THREE.Vector3, THREE.Vector3],
      headR: [wingR, tip] as [THREE.Vector3, THREE.Vector3],
      dashSize,
      gapSize,
    }
  }, [a, b])

  const opacity = dim ? 0.1 : 0.96
  const lw = dim ? Math.max(1, lineWidth * 0.45) : lineWidth
  const headLw = Math.max(lw, dim ? 1.2 : 2.6)

  return (
    <group>
      <Line
        points={geom.shaft}
        color={color}
        lineWidth={lw}
        transparent
        opacity={opacity}
        dashed={dashed}
        dashSize={geom.dashSize}
        gapSize={geom.gapSize}
        raycast={noHit}
      />
      {/* Open 箭尖 · 双翼 */}
      <Line
        points={geom.headL}
        color={color}
        lineWidth={headLw}
        transparent
        opacity={opacity}
        raycast={noHit}
      />
      <Line
        points={geom.headR}
        color={color}
        lineWidth={headLw}
        transparent
        opacity={opacity}
        raycast={noHit}
      />
    </group>
  )
}
