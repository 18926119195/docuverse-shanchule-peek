import { useDocuverse } from '../canvas/store'
import { PdfUploadPanel } from './PdfUploadPanel'

/** Minimal left rail: brand + upload + page jump. */
export function HUD() {
  const pages = useDocuverse((s) => s.pages)
  const currentStrand = useDocuverse((s) => s.currentStrand)
  const companionStrand = useDocuverse((s) => s.companionStrand)
  const uploadLabel = useDocuverse((s) => s.uploadLabel)
  const corpus = useDocuverse((s) => s.corpus)
  const setCorpus = useDocuverse((s) => s.setCorpus)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)
  const stepPage = useDocuverse((s) => s.stepPage)

  const current = pages[currentStrand]

  return (
    <div className="hud hud-slim">
      <header className="hud-brand">
        <div className="brand-mark">DOCUMVERSE</div>
        <div className="brand-sub">A1 → Flash · PDF 框</div>
        <div className="mode-toggle corpus">
          {uploadLabel ? (
            <button
              className={corpus === 'upload' ? 'active' : ''}
              type="button"
              onClick={() => setCorpus('upload')}
            >
              {uploadLabel}
            </button>
          ) : (
            <span className="meta">请上传 PDF</span>
          )}
        </div>
      </header>

      <PdfUploadPanel />

      <section className="hud-panel pages">
        <h2>页面</h2>
        <p className="meta">{current?.title ?? '—'}</p>
        <div className="page-step">
          <button type="button" onClick={() => stepPage(-1)}>
            [
          </button>
          <button type="button" onClick={() => stepPage(1)}>
            ]
          </button>
        </div>
        <ul className="page-roster">
          {pages.map((p) => (
            <li key={p.strandIndex}>
              <button
                type="button"
                className={
                  p.strandIndex === currentStrand
                    ? 'active current'
                    : p.strandIndex === companionStrand
                      ? 'active companion'
                      : ''
                }
                onClick={() => swoopToPage(p.strandIndex)}
              >
                {p.strandIndex + 1}. {p.title.replace(/\.txt$/i, '').slice(0, 28)}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
