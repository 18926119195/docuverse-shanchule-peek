/**
 * Bottom-center translucent dock for reuse audit + latest conclusion.
 * Reads the same reasoning store — does not touch closures / localStorage.
 */
import { useReasoning } from '../reasoning/closureStore'

export function ReasoningFloorDock() {
  const lastMatches = useReasoning((s) => s.lastMatches)
  const forbidIds = useReasoning((s) => s.forbidIds)
  const chooseReuse = useReasoning((s) => s.chooseReuse)
  const toggleForbid = useReasoning((s) => s.toggleForbid)
  const beginLeave = useReasoning((s) => s.beginLeave)
  const lastConclusion = useReasoning((s) => s.lastConclusion)
  const lastPath = useReasoning((s) => s.lastPath)

  const showMatches = lastMatches.length > 0
  const showConclusion = Boolean(lastConclusion || lastPath)
  if (!showMatches && !showConclusion) return null

  return (
    <aside className="reasoning-floor-dock" aria-label="近似方向与最近结论">
      {showMatches && (
        <section className="reasoning-floor-section">
          <h3 className="reasoning-floor-title">近似方向 · 审核</h3>
          <ul className="reasoning-floor-list">
            {lastMatches.map((m) => (
              <li key={m.direction.directionId}>
                <div className="reasoning-floor-hit">
                  <span className="reasoning-floor-sim">
                    sim={m.score.toFixed(2)}
                  </span>
                  <p className="reasoning-floor-q">{m.direction.questionText}</p>
                  <p className="reasoning-floor-muted">
                    {m.direction.conclusion.slice(0, 160)}
                  </p>
                  <div className="reasoning-floor-actions">
                    <button
                      type="button"
                      className="reasoning-floor-btn"
                      onClick={() => void chooseReuse(m.direction.directionId)}
                    >
                      复用（停止）
                    </button>
                    <button
                      type="button"
                      className="reasoning-floor-btn"
                      onClick={() => toggleForbid(m.direction.directionId)}
                    >
                      {forbidIds.includes(m.direction.directionId)
                        ? '取消排除'
                        : '排除并直接推理'}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="reasoning-floor-btn reasoning-floor-btn-leave"
            onClick={beginLeave}
          >
            不留在该闭包 · 退房
          </button>
        </section>
      )}

      {showConclusion && (
        <section className="reasoning-floor-section">
          <h3 className="reasoning-floor-title">最近结论</h3>
          {lastPath && (
            <pre className="reasoning-floor-pre">{lastPath}</pre>
          )}
          {lastConclusion && (
            <p className="reasoning-floor-conclusion">{lastConclusion}</p>
          )}
        </section>
      )}
    </aside>
  )
}
