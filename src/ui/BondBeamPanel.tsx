import { useDocuverse } from '../canvas/store'

/**
 * List permanent bonds and create / delete user rays between them.
 */
export function BondBeamPanel() {
  const permanentBonds = useDocuverse((s) => s.permanentBonds)
  const userBeams = useDocuverse((s) => s.userBeams)
  const bondLinkFromId = useDocuverse((s) => s.bondLinkFromId)
  const currentStrand = useDocuverse((s) => s.currentStrand)
  const setBondLinkFrom = useDocuverse((s) => s.setBondLinkFrom)
  const createUserBeam = useDocuverse((s) => s.createUserBeam)
  const deletePermanentBond = useDocuverse((s) => s.deletePermanentBond)
  const deleteUserBeam = useDocuverse((s) => s.deleteUserBeam)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)

  const pageBonds = permanentBonds.filter((b) => b.strandIndex === currentStrand)
  const otherBonds = permanentBonds.filter((b) => b.strandIndex !== currentStrand)

  const onBondClick = (bondId: string) => {
    if (!bondLinkFromId) {
      setBondLinkFrom(bondId)
      return
    }
    if (bondLinkFromId === bondId) {
      setBondLinkFrom(null)
      return
    }
    createUserBeam(bondId, 'pointer')
  }

  return (
    <section className="hud-panel bonds">
      <h2>永久绑定 · 用户射线</h2>
      <p className="hint">
        射线不会自动生成。先密封绑定，再点选两个绑定端点连线。
        {bondLinkFromId ? ' · 已选端点 A，再点另一绑定完成射线' : ''}
      </p>
      <p className="meta">
        全库绑定 {permanentBonds.length} · 用户射线 {userBeams.length}
      </p>

      {bondLinkFromId && (
        <button
          type="button"
          className="corpus-chip"
          onClick={() => setBondLinkFrom(null)}
        >
          取消选中端点 A
        </button>
      )}

      <h3 className="bond-subhead">本页绑定</h3>
      {pageBonds.length === 0 ? (
        <p className="hint">本页尚无永久绑定。请在 OCR 面板确认检验并密封。</p>
      ) : (
        <ul className="bond-roster">
          {pageBonds.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                className={bondLinkFromId === b.id ? 'active' : ''}
                onClick={() => onBondClick(b.id)}
              >
                {b.confirmedText.slice(0, 28)}
                {b.confirmedText.length > 28 ? '…' : ''}
                <span className="bond-comment-chip">{b.comment.slice(0, 24)}</span>
              </button>
              <button
                type="button"
                className="corpus-chip danger bond-del"
                onClick={() => {
                  if (window.confirm('删除此永久绑定及其相关射线？')) {
                    deletePermanentBond(b.id)
                  }
                }}
              >
                删
              </button>
            </li>
          ))}
        </ul>
      )}

      {otherBonds.length > 0 && (
        <>
          <h3 className="bond-subhead">其他页绑定（可作对端）</h3>
          <ul className="bond-roster">
            {otherBonds.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  className={bondLinkFromId === b.id ? 'active' : ''}
                  onClick={() => onBondClick(b.id)}
                  onDoubleClick={() => swoopToPage(b.strandIndex)}
                >
                  s{b.strandIndex} · {b.confirmedText.slice(0, 22)}
                  {b.confirmedText.length > 22 ? '…' : ''}
                  <span className="bond-comment-chip">{b.comment.slice(0, 20)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {userBeams.length > 0 && (
        <>
          <h3 className="bond-subhead">已画射线</h3>
          <ul className="bond-roster">
            {userBeams.map((beam) => {
              const from = permanentBonds.find((b) => b.id === beam.fromBondId)
              const to = permanentBonds.find((b) => b.id === beam.toBondId)
              return (
                <li key={beam.id}>
                  <span className="meta">
                    s{from?.strandIndex ?? '?'}→s{to?.strandIndex ?? '?'} ·{' '}
                    {beam.flinkType}
                  </span>
                  <button
                    type="button"
                    className="corpus-chip danger bond-del"
                    onClick={() => deleteUserBeam(beam.id)}
                  >
                    删
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
