import { Canvas } from '@react-three/fiber'
import { Suspense, useCallback, useState } from 'react'
import * as THREE from 'three'
import { useDocuverse } from './store'
import { PageMesh } from './PageMesh'
import { BeamLayer } from './BeamLayer'
import { EmphasisBeamLayer } from './EmphasisBeamLayer'
import { CameraRig, OrbitControlsProxy } from './CameraRig'
import { innerSphereRadius, pageHomePosition } from './geometry'
import { OcrComparePlane } from './OcrComparePlane'
import { RelationPasteLayer } from './RelationPasteLayer'
import { KeyPanelLayer } from './KeyPanelLayer'
import { EmphasisPenController } from './EmphasisPenController'

const noHit = (() => undefined) as unknown as THREE.Mesh['raycast']

export function CvsScene({
  settlementAudit = false,
}: {
  /**
   * 结算：复用原球体全部交互；仅渲染 infer 激活页（不渲全库页）。
   */
  settlementAudit?: boolean
}) {
  const [canvasKey, setCanvasKey] = useState(0)
  const onCanvasCreated = useCallback(({ gl }: { gl: THREE.WebGLRenderer }) => {
    const canvas = gl.domElement
    const onLost = (e: Event) => {
      e.preventDefault()
      window.setTimeout(() => setCanvasKey((k) => k + 1), 50)
    }
    canvas.addEventListener('webglcontextlost', onLost, { once: true })
  }, [])

  const pages = useDocuverse((s) => s.pages)
  const connections = useDocuverse((s) => s.connections)
  const currentStrand = useDocuverse((s) => s.currentStrand)
  const companionStrand = useDocuverse((s) => s.companionStrand)
  const currentConnectionId = useDocuverse((s) => s.currentConnectionId)
  const selectConnection = useDocuverse((s) => s.selectConnection)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)
  const settlementSphereEpoch = useDocuverse((s) => s.settlementSphereEpoch)
  const auditSphereStrands = useDocuverse((s) => s.auditSphereStrands)

  const auditSet =
    settlementAudit && auditSphereStrands.length > 0
      ? new Set(auditSphereStrands)
      : null
  // 结算：只挂激活页；槽位仍用全书自然坐标，交互与常态同一套 swoop
  const visiblePages = settlementAudit
    ? pages.filter((p) =>
        auditSet ? auditSet.has(p.strandIndex) : Boolean(p.imageUrl),
      )
    : pages
  const ringTotal = Math.max(pages.length, 1)
  const ringR = innerSphereRadius(ringTotal)
  void settlementSphereEpoch

  return (
    <Canvas
      key={canvasKey}
      onCreated={onCanvasCreated}
      shadows={false}
      dpr={[1, 1.5]}
      camera={{
        fov: 50,
        near: 0.05,
        far: 50000,
        position: [0, ringR * 1.55, ringR * 1.55],
      }}
      style={{ width: '100%', height: '100%' }}
      performance={{ min: 0.5 }}
    >
      <color attach="background" args={['#0b0e14']} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[8, 28, 6]} intensity={0.95} />
      <fog attach="fog" args={['#0b0e14', ringR * 1.6, ringR * 6.2]} />

      <CameraRig />
      <OrbitControlsProxy />
      <EmphasisPenController />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} raycast={noHit}>
        <circleGeometry args={[ringR * 1.08, 64]} />
        <meshBasicMaterial
          color="#0e141c"
          transparent
          opacity={0.55}
          depthWrite={false}
        />
      </mesh>

      {visiblePages.map((page) => {
        const role =
          page.strandIndex === currentStrand
            ? 'current'
            : page.strandIndex === companionStrand
              ? 'companion'
              : 'background'
        const home = pageHomePosition(page.strandIndex, ringTotal)
        return (
          <PageMesh
            key={`${page.imageUrl ?? 'txt'}-${page.strandIndex}-e${settlementSphereEpoch}`}
            page={page}
            homePosition={home}
            role={role}
            connections={connections}
            currentConnectionId={currentConnectionId}
            onSelectConnection={selectConnection}
            onSwoopToPage={swoopToPage}
          />
        )
      })}

      <Suspense fallback={null}>
        <OcrComparePlane />
      </Suspense>
      <BeamLayer
        pages={pages}
        connections={connections}
        currentStrand={currentStrand}
        companionStrand={companionStrand}
        currentConnectionId={currentConnectionId}
      />
      <EmphasisBeamLayer />
      <Suspense fallback={null}>
        <RelationPasteLayer />
        <KeyPanelLayer />
      </Suspense>
    </Canvas>
  )
}
