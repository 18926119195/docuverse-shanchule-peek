/**
 * 不占主界面：角落一键导出写信台 + LLM I/O + tokens。
 */

import { useState } from 'react'
import {
  copyDeskLlmExport,
  downloadDeskLlmExport,
} from '../reasoning/exportDeskLlmDump'
import { useLlmIoStream } from '../reasoning/llmIoStreamStore'

export function DeskLlmExportButton() {
  const n = useLlmIoStream((s) => s.entries.length)
  const [note, setNote] = useState<string | null>(null)

  const flash = (msg: string) => {
    setNote(msg)
    window.setTimeout(() => setNote(null), 2200)
  }

  return (
    <div className="desk-llm-export" aria-label="导出写信台与 LLM I/O">
      <button
        type="button"
        className="desk-llm-export-btn"
        title="复制：写信台快照 + LLM system/user/output + token"
        onClick={async () => {
          const r = await copyDeskLlmExport()
          flash(r.note)
        }}
      >
        导出诊断{n > 0 ? ` ·${n}` : ''}
      </button>
      <button
        type="button"
        className="desk-llm-export-btn desk-llm-export-btn--file"
        title="下载 .md 文件"
        onClick={() => {
          const r = downloadDeskLlmExport()
          flash(r.ok ? `已下载 ${r.fileName}` : '下载失败')
        }}
      >
        .md
      </button>
      {note ? <span className="desk-llm-export-note">{note}</span> : null}
    </div>
  )
}
