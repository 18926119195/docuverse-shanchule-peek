/**
 * 本问进度图（常驻）：queryKey 锚 + 按 LLM 调用序的 out 整批边。
 * ≥2 边选中 → 调取双集合面板；点边切换选中。
 */

import { useMemo, useState } from 'react'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import { usePanelSummonStore } from '../reasoning/panelSummonStore'
import {
  buildTurnJobGraph,
  resolveActiveQueryKey,
} from '../reasoning/turnJobProgress'
import { shortHandle } from '../reasoning/ocrSlot'

export function TurnJobProgressGraph() {
  const ledger = useAttentionIo((s) => s.llmCallLedger)
  const settled = useAttentionIo((s) => s.settledQueries)
  const neighbours = useAttentionIo((s) => s.neighbours)
  const selectedEdgeIds = usePanelSummonStore((s) => s.selectedEdgeIds)
  const toggleEdgeSelect = usePanelSummonStore((s) => s.toggleEdgeSelect)
  const clearEdgeSelect = usePanelSummonStore((s) => s.clearEdgeSelect)
  const summonSelectedEdges = usePanelSummonStore((s) => s.summonSelectedEdges)
  const summonCallBatch = usePanelSummonStore((s) => s.summonCallBatch)
  const [hint, setHint] = useState('')

  const graph = useMemo(() => {
    void ledger
    void settled
    void neighbours
    return buildTurnJobGraph(resolveActiveQueryKey())
  }, [ledger, settled, neighbours])

  if (!graph.queryKeyNow && graph.edges.length === 0) {
    return (
      <div className="turn-progress" role="status">
        <div className="turn-progress-head">本问进度</div>
        <div className="turn-progress-empty">尚无 queryKey · 提问后出现咬尾/撬开边</div>
      </div>
    )
  }

  const qkNodes = graph.nodes.filter((n) => n.kind === 'queryKey')
  const jobNodes = graph.nodes.filter((n) => n.kind === 'job')

  return (
    <div className="turn-progress" role="navigation" aria-label="本问进度拓扑">
      <div className="turn-progress-head">
        <span className="turn-progress-title">本问进度</span>
        <span className="turn-progress-meta">
          {shortHandle(graph.queryKeyNow)} · 边×{graph.edges.length} · 已选
          {selectedEdgeIds.length}
        </span>
      </div>

      <div className="turn-progress-qk">
        {qkNodes.map((n) =>
          n.kind === 'queryKey' ? (
            <span
              key={n.id}
              className={`turn-progress-chip qk ${n.role}`}
              title={n.queryKey}
            >
              {n.role === 'now' ? 'now' : 'hist'} · {shortHandle(n.queryKey)}
            </span>
          ) : null,
        )}
      </div>

      <div className="turn-progress-jobs">
        {jobNodes.map((n) =>
          n.kind === 'job' ? (
            <span
              key={n.id}
              className={`turn-progress-chip job ${n.status}`}
              title={n.job}
            >
              {n.job}
            </span>
          ) : null,
        )}
      </div>

      <div className="turn-progress-edges">
        {graph.edges.map((e) => {
          const on = selectedEdgeIds.includes(e.llmCallId)
          return (
            <button
              key={e.id}
              type="button"
              className={`turn-progress-edge${on ? ' on' : ''}`}
              title={`${e.llmCallId}\n${e.memberKeys.join('\n')}`}
              onClick={() => toggleEdgeSelect(e.llmCallId)}
              onDoubleClick={() => summonCallBatch(e.llmCallId)}
            >
              <span className="turn-progress-edge-job">{e.job}</span>
              <span className="turn-progress-edge-kind">{e.keyKind}</span>
              <span className="turn-progress-edge-n">×{e.memberKeys.length}</span>
            </button>
          )
        })}
        {graph.edges.length === 0 && (
          <span className="turn-progress-empty">本问尚无 LLM 调用批</span>
        )}
      </div>

      <div className="turn-progress-actions">
        <button
          type="button"
          className="corpus-chip"
          disabled={selectedEdgeIds.length < 2}
          onClick={() => {
            const r = summonSelectedEdges()
            setHint(r.note)
          }}
        >
          跳转双面板（≥2边）
        </button>
        <button
          type="button"
          className="corpus-chip"
          onClick={() => {
            clearEdgeSelect()
            setHint('')
          }}
        >
          清选
        </button>
        {hint && <span className="turn-progress-hint">{hint}</span>}
      </div>
    </div>
  )
}
