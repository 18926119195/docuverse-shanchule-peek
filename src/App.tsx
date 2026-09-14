import { CvsScene } from './canvas/CvsScene'
import { KeyboardNav } from './ui/KeyboardNav'
import { A1ChatDock } from './ui/A1ChatDock'
import { DeskLlmExportButton } from './ui/DeskLlmExportButton'
import { PdfUploadPanel } from './ui/PdfUploadPanel'
import { TocWizard } from './ui/TocWizard'
import { TocWizardBoundary } from './ui/TocWizardBoundary'
import { WorkbenchPalette } from './ui/WorkbenchPalette'
import { EmphasisStarMap } from './ui/EmphasisStarMap'
import { ShellZipperControls } from './ui/ShellZipperControls'
import { SettlementVSplit } from './ui/SettlementVSplit'
import { useIndexGate } from './reasoning/indexGate'
import { useAttentionIo } from './reasoning/attentionIoStore'
import './App.css'

/**
 * 默认布局：上球 · 下写信台幕布（qk→path→详情 ↔ 输入）。
 * pendingPath / pendingReuse 时球切 audit；复用与确认 path 同在幕布审计区对照。
 */
export default function App() {
  const indexReady = useIndexGate((s) => s.ready)
  const pendingPath = useAttentionIo((s) => s.pendingPathMatch)
  const pendingReuse = useAttentionIo((s) => s.pendingReuseProposal)
  const settlementAudit = Boolean(pendingPath || pendingReuse)

  if (indexReady) {
    return (
      <>
        <SettlementVSplit
          sphere={
            settlementAudit ? (
              <CvsScene settlementAudit />
            ) : (
              <CvsScene />
            )
          }
          desk={<A1ChatDock compact />}
          footer={
            <footer className="patent-bar">
              {settlementAudit
                ? '结算 · 拖中线调球/幕布 · 双击复位 · 5175'
                : '写信台 · 球/幕布 · 拖中线调高度 · 5175'}
            </footer>
          }
        />
        <KeyboardNav />
        <DeskLlmExportButton />
        <div className="hud hud-slim hud-slim--settlement">
          <PdfUploadPanel />
        </div>
        <WorkbenchPalette />
        <EmphasisStarMap />
        <ShellZipperControls />
        <TocWizardBoundary>
          <TocWizard />
        </TocWizardBoundary>
      </>
    )
  }

  return (
    <div className="app-root app-root--io-lab">
      <KeyboardNav />
      <DeskLlmExportButton />
      <aside className="hud hud-slim" aria-label="上传与语料">
        <header className="hud-brand">
          <div className="brand-mark">DOCUMVERSE</div>
          <div className="brand-sub">no-peek · I/O 实验</div>
        </header>
        <PdfUploadPanel />
      </aside>
      <main className="stage stage--io-lab">
        <div className="letter-workbench-stage letter-workbench-stage--compact">
          <p className="letter-workbench-title">no-peek · I/O 实验</p>
          <p className="letter-workbench-sub">
            左侧上传 PDF 后进入写信台：球在上、幕布在提示与输入之间
          </p>
        </div>
      </main>
      <TocWizardBoundary>
        <TocWizard />
      </TocWizardBoundary>
      <footer className="patent-bar">
        实验仓 · 上传 PDF 后开始 · 5175
      </footer>
    </div>
  )
}
