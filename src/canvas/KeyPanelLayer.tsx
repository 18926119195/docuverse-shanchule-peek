/**
 * 常显 key 面板层：按 llmCallId 集合门（一门多格）立在壳上。
 */

import { Html } from '@react-three/drei'
import { useMemo } from 'react'
import { useIndexGate } from '../reasoning/indexGate'
import { useDocuverse } from './store'
import { usePanelSummonStore } from '../reasoning/panelSummonStore'
import { resolveKeyWorldAnchor } from '../reasoning/keyWorldAnchor'
import { AttentionDoorFace } from '../ui/AttentionDoorFace'
import { shortHandle } from '../reasoning/ocrSlot'
import { adjacentCallIdsForKey } from '../reasoning/turnJobProgress'

export function KeyPanelLayer() {
  const panels = usePanelSummonStore((s) => s.panels)
  const globalScale = usePanelSummonStore((s) => s.globalScale)
  const shellStep = usePanelSummonStore((s) => s.shellStep)
  const dismissPanel = usePanelSummonStore((s) => s.dismissPanel)
  const toggleEdgeSelect = usePanelSummonStore((s) => s.toggleEdgeSelect)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const pageCount = useDocuverse((s) => Math.max(s.pages.length, 1))

  const resolved = useMemo(() => {
    if (!bookIndex || panels.length === 0) return []
    const activeKinds = panels.map((p) => p.keyKind)
    return panels.map((p) => {
      const seedKey = p.memberKeys[0] ?? p.panelId
      const a = resolveKeyWorldAnchor({
        key: seedKey,
        keyKind: p.keyKind,
        bookIndex,
        pageCount,
        globalScale,
        activeKinds,
        shellStep,
        queryKeyForAzimuth: p.queryKey,
      })
      const memberFaces = p.memberKeys.map((mk) => {
        if (mk === seedKey) return { key: mk, text: a.faceText }
        const m = resolveKeyWorldAnchor({
          key: mk,
          keyKind: p.keyKind,
          bookIndex,
          pageCount,
          globalScale,
          activeKinds,
          shellStep,
          queryKeyForAzimuth: p.queryKey,
        })
        return { key: mk, text: m.faceText }
      })
      return { summoned: p, anchor: a, memberFaces }
    })
  }, [bookIndex, panels, pageCount, globalScale, shellStep])

  if (!bookIndex || resolved.length === 0) return null

  return (
    <group>
      {resolved.map(({ summoned, anchor, memberFaces }) => {
        if (!anchor.world) return null
        return (
          <Html
            key={summoned.panelId}
            position={anchor.world}
            center
            distanceFactor={18}
            zIndexRange={[160, 0]}
            style={{ pointerEvents: 'auto' }}
          >
            <div
              className="key-panel-live"
              data-kind={anchor.keyKind}
              data-batch={summoned.llmCallId ? '1' : '0'}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="key-panel-live-head">
                <span className="key-panel-live-kind">{anchor.keyKind}</span>
                <span
                  className="key-panel-live-id"
                  title={summoned.llmCallId ?? summoned.panelId}
                >
                  {summoned.llmCallId
                    ? `批×${memberFaces.length}`
                    : shortHandle(summoned.panelId)}
                </span>
                <button
                  type="button"
                  className="key-panel-live-x"
                  title="收起"
                  onClick={() => dismissPanel(summoned.panelId)}
                >
                  ×
                </button>
              </div>
              <div className="key-panel-live-batch">
                {memberFaces.map((mf, i) => (
                  <AttentionDoorFace
                    key={mf.key}
                    doorKey={mf.key}
                    keyKind={anchor.keyKind}
                    faceText={mf.text}
                    hostBookKey={anchor.hostBookKey ?? undefined}
                    queryKey={
                      anchor.keyKind === 'query' ? mf.key : summoned.queryKey
                    }
                  >
                    <button
                      type="button"
                      className="key-panel-live-cell"
                      title="点 key：展开相邻进度边"
                      onClick={() => {
                        const adj = adjacentCallIdsForKey(mf.key)
                        for (const id of [...adj.inbound, ...adj.outbound]) {
                          toggleEdgeSelect(id)
                        }
                      }}
                    >
                      <span className="key-panel-live-cell-i">{i + 1}</span>
                      <span className="key-panel-live-cell-k">
                        {shortHandle(mf.key)}
                      </span>
                      <span className="key-panel-live-body">
                        {mf.text?.slice(0, 280) || '（无正文）'}
                      </span>
                    </button>
                  </AttentionDoorFace>
                ))}
              </div>
            </div>
          </Html>
        )
      })}
    </group>
  )
}
