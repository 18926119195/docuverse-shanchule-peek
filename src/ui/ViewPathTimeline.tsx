import { useMemo } from 'react'
import { useDocuverse } from '../canvas/store'
import { viewKeyframeTagClass } from '../data/viewPath'

/**
 * View-path film strip: record outer-shell poses, scrub/play, trim junk takes.
 * Pause = edit-safe; live = keep recording new keyframes.
 */
export function ViewPathTimeline() {
  const viewPath = useDocuverse((s) => s.viewPath)
  const mode = useDocuverse((s) => s.viewPathMode)
  const cursor = useDocuverse((s) => s.viewPathCursor)
  const selectA = useDocuverse((s) => s.viewPathSelectA)
  const selectB = useDocuverse((s) => s.viewPathSelectB)
  const playViewPath = useDocuverse((s) => s.playViewPath)
  const pauseViewPath = useDocuverse((s) => s.pauseViewPath)
  const liveViewPath = useDocuverse((s) => s.liveViewPath)
  const setViewPathCursor = useDocuverse((s) => s.setViewPathCursor)
  const deleteViewPathFrameAt = useDocuverse((s) => s.deleteViewPathFrameAt)
  const deleteViewPathSelection = useDocuverse((s) => s.deleteViewPathSelection)
  const setViewPathSelectMark = useDocuverse((s) => s.setViewPathSelectMark)
  const clearViewPathSelection = useDocuverse((s) => s.clearViewPathSelection)
  const clearViewPath = useDocuverse((s) => s.clearViewPath)
  const commitViewKeyframe = useDocuverse((s) => s.commitViewKeyframe)

  const max = Math.max(0, viewPath.length - 1)
  const frameIndex = Math.round(cursor)

  const selectLabel = useMemo(() => {
    if (selectA === null) return null
    if (selectB === null) return `选区起点 #${selectA}`
    const lo = Math.min(selectA, selectB)
    const hi = Math.max(selectA, selectB)
    return `选区 #${lo}–#${hi}（${hi - lo + 1} 帧）`
  }, [selectA, selectB])

  const modeLabel =
    mode === 'live' ? '实况·录制' : mode === 'playing' ? '回放中' : '暂停·可剪可改'

  return (
    <div
      className="view-path-bar"
      role="region"
      aria-label="机位时间轴"
      title="乱扫会很多无效帧 → 回放拖轴 → 删本帧 / Shift+点两帧标选区再删。暂停时可继续编辑空间。"
    >
      <div className="view-path-head">
        <span className={`view-path-mode mode-${mode}`}>{modeLabel}</span>
        <span className="meta">
          {viewPath.length === 0
            ? '右键环视写入帧'
            : `${viewPath.length}帧 · ${frameIndex + 1}/${viewPath.length}${
                viewPath[frameIndex] ? ` · ${viewPath[frameIndex].tag}` : ''
              }`}
        </span>
        {selectLabel && <span className="view-path-select-tag">{selectLabel}</span>}
      </div>

      <div className="view-path-controls">
        {mode === 'playing' ? (
          <button type="button" className="upload-btn" onClick={pauseViewPath}>
            暂停
          </button>
        ) : (
          <button
            type="button"
            className="upload-btn"
            disabled={viewPath.length === 0}
            onClick={playViewPath}
          >
            回放
          </button>
        )}
        <button
          type="button"
          className={`corpus-chip${mode === 'live' ? ' active' : ''}`}
          onClick={liveViewPath}
        >
          实况
        </button>
        <button
          type="button"
          className="corpus-chip"
          onClick={() => commitViewKeyframe({ tag: '打点', force: true })}
          title="手动打一帧当前机位"
        >
          打点
        </button>
        <button
          type="button"
          className="corpus-chip"
          disabled={viewPath.length === 0}
          onClick={() => deleteViewPathFrameAt(frameIndex)}
        >
          删帧
        </button>
        <button
          type="button"
          className="corpus-chip"
          disabled={selectA === null}
          onClick={deleteViewPathSelection}
          title="删除选区"
        >
          删选
        </button>
        <button
          type="button"
          className="corpus-chip"
          disabled={selectA === null}
          onClick={clearViewPathSelection}
        >
          清选
        </button>
        <button
          type="button"
          className="corpus-chip danger"
          disabled={viewPath.length === 0}
          onClick={() => {
            if (window.confirm('清空整条机位时间轴？')) clearViewPath()
          }}
        >
          清空
        </button>
      </div>

      <div className="view-path-scrub">
        <input
          type="range"
          min={0}
          max={max || 0}
          step={0.01}
          value={viewPath.length === 0 ? 0 : Math.min(cursor, max || 0)}
          disabled={viewPath.length === 0}
          onChange={(e) => setViewPathCursor(Number(e.target.value))}
          aria-label="拖动重返故地"
        />
      </div>

      {viewPath.length > 0 && (
        <div className="view-path-ticks" role="list">
          {viewPath.map((f, i) => {
            const inSel =
              selectA !== null &&
              (() => {
                const b = selectB ?? selectA
                const lo = Math.min(selectA, b)
                const hi = Math.max(selectA, b)
                return i >= lo && i <= hi
              })()
            const on = Math.abs(i - cursor) < 0.51
            return (
              <button
                key={f.id}
                type="button"
                role="listitem"
                className={`view-path-tick ${viewKeyframeTagClass(f.tag)}${on ? ' on' : ''}${inSel ? ' sel' : ''}`}
                title={`#${i + 1} · ${f.tag} · 单击定位 · Shift+单击标记删选区`}
                onClick={(e) => {
                  setViewPathCursor(i)
                  if (e.shiftKey) setViewPathSelectMark(i)
                }}
              >
                {'\u00a0'}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
