/**
 * Working memory panel: premise key* chips + pathMarker (no formal ops theater).
 */

import type { FanoutPath } from '../reasoning/types'
import { shortHandle } from '../reasoning/ocrSlot'

export interface WorkingMemoryPanelProps {
  path: FanoutPath | null
  selectedKey: string | null
  onKeyClick: (key: string, page: number) => void
}

function pageForKey(path: FanoutPath, key: string): number {
  const slot = path.slots.find((s) => s.key === key)
  if (slot) return slot.page
  const idx = (path.direction.premiseKeys ?? []).indexOf(key)
  if (idx >= 0 && path.premisePages[idx] != null) {
    return path.premisePages[idx]
  }
  return path.premisePages[0] ?? 0
}

export function WorkingMemoryPanel({
  path,
  selectedKey,
  onKeyClick,
}: WorkingMemoryPanelProps) {
  if (!path) {
    return (
      <div className="working-memory">
        <div className="fanout-k">工作记忆 · 前提 key*</div>
        <p className="fanout-hint">选择一条路径后显示递交门牌与 pathMarker</p>
      </div>
    )
  }

  const keys =
    path.direction.premiseKeys?.length
      ? path.direction.premiseKeys
      : path.slots.map((s) => s.key)

  return (
    <div className="working-memory">
      <div className="fanout-k">工作记忆 · 前提 key*</div>
      <div className="fanout-chips">
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            className={
              selectedKey === key ? 'fanout-chip active' : 'fanout-chip'
            }
            onClick={() => onKeyClick(key, pageForKey(path, key))}
            title={key}
          >
            {shortHandle(key)}
          </button>
        ))}
      </div>
      {path.direction.conclusion ? (
        <>
          <div className="fanout-k">结论</div>
          <p className="fanout-hint">{path.direction.conclusion}</p>
        </>
      ) : null}
      {path.direction.pathMarker ? (
        <>
          <div className="fanout-k">pathMarker（机读接力）</div>
          <pre className="fanout-path-marker">{path.direction.pathMarker}</pre>
        </>
      ) : null}
    </div>
  )
}
