/**
 * 壳间距拉链：拓扑邻接图不变，只调相邻几何步长 shellStep。
 * ≥2 块常显面板时出现；拖滑块 / 靠近·远离；可进 key 面板对比 construction。
 */

import { useMemo, useRef } from 'react'
import {
  SHELL_STEP_MAX,
  SHELL_STEP_MIN,
  usePanelSummonStore,
} from '../reasoning/panelSummonStore'
import { packAdjacentShellRatios } from '../arch/attentionPanel'
import {
  enterCompareForSummonedKeys,
  refreshKeyCompareIfActive,
} from '../reasoning/keyPanelCompare'
import { useDocuverse } from '../canvas/store'

export function ShellZipperControls() {
  const panels = usePanelSummonStore((s) => s.panels)
  const shellStep = usePanelSummonStore((s) => s.shellStep)
  const setShellStep = usePanelSummonStore((s) => s.setShellStep)
  const nudgeShellStep = usePanelSummonStore((s) => s.nudgeShellStep)
  const dismissAll = usePanelSummonStore((s) => s.dismissAll)
  const keyComparePair = useDocuverse((s) => s.keyComparePair)
  const exitConstructionLens = useDocuverse((s) => s.exitConstructionLens)
  const cameraLens = useDocuverse((s) => s.cameraLens)
  const trackRef = useRef<HTMLDivElement>(null)

  const kinds = useMemo(
    () => [...new Set(panels.map((p) => p.keyKind))],
    [panels],
  )
  const packed = useMemo(
    () => packAdjacentShellRatios(kinds, shellStep),
    [kinds, shellStep],
  )

  if (panels.length < 2) return null

  const t =
    (shellStep - SHELL_STEP_MIN) / (SHELL_STEP_MAX - SHELL_STEP_MIN)

  const applyStep = (next: number) => {
    setShellStep(next)
    queueMicrotask(() => refreshKeyCompareIfActive())
  }

  const setFromClientX = (clientX: number) => {
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width < 1) return
    const u = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    applyStep(SHELL_STEP_MIN + u * (SHELL_STEP_MAX - SHELL_STEP_MIN))
  }

  return (
    <div className="shell-zipper" role="group" aria-label="壳间距拉链">
      <div className="shell-zipper-head">
        <span className="shell-zipper-title">壳间距拉链</span>
        <span className="shell-zipper-meta">
          邻接图打包 · step {shellStep.toFixed(2)} · 面板×{panels.length}
          {keyComparePair ? ' · 对比中' : ''}
        </span>
        {cameraLens !== 'construction' && (
          <button
            type="button"
            className="upload-btn"
            onClick={() => enterCompareForSummonedKeys()}
            title="钉住前两块面板为「key 面板对比」（无 rail/穿洞；间距用壳拉链）"
          >
            对比
          </button>
        )}
        {keyComparePair && cameraLens === 'construction' && (
          <button
            type="button"
            className="corpus-chip"
            onClick={() => exitConstructionLens()}
          >
            退出对比
          </button>
        )}
        <button
          type="button"
          className="corpus-chip"
          onClick={() => dismissAll()}
          title="收起全部常显面板"
        >
          全收
        </button>
      </div>

      <div className="shell-zipper-row">
        <button
          type="button"
          className="corpus-chip"
          onClick={() => {
            nudgeShellStep(-0.03)
            queueMicrotask(() => refreshKeyCompareIfActive())
          }}
          title="层更近"
        >
          靠近
        </button>

        <div
          ref={trackRef}
          className="shell-zipper-track"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
            setFromClientX(e.clientX)
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
            setFromClientX(e.clientX)
          }}
          onPointerUp={(e) => {
            try {
              e.currentTarget.releasePointerCapture(e.pointerId)
            } catch {
              /* */
            }
          }}
        >
          <div className="shell-zipper-rail" />
          <div
            className="shell-zipper-fill"
            style={{ width: `${t * 100}%` }}
          />
          <div
            className="shell-zipper-knob"
            style={{ left: `${t * 100}%` }}
            aria-valuemin={SHELL_STEP_MIN}
            aria-valuemax={SHELL_STEP_MAX}
            aria-valuenow={shellStep}
            role="slider"
          />
          <div className="shell-zipper-teeth" aria-hidden>
            {[...packed.entries()].map(([kind, ratio]) => {
              const maxR = Math.max(...packed.values(), 1)
              const u =
                maxR <= 1.0001
                  ? 0
                  : Math.max(0, Math.min(1, (ratio - 1) / (maxR - 1)))
              return (
                <span
                  key={kind}
                  className="shell-zipper-tooth"
                  style={{ left: `${u * 100}%` }}
                  title={`${kind} ×${ratio.toFixed(2)}`}
                >
                  {kind.slice(0, 2)}
                </span>
              )
            })}
          </div>
        </div>

        <button
          type="button"
          className="corpus-chip"
          onClick={() => {
            nudgeShellStep(0.03)
            queueMicrotask(() => refreshKeyCompareIfActive())
          }}
          title="层更远"
        >
          远离
        </button>
      </div>
    </div>
  )
}
