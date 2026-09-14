/**
 * 实验 UI：LLM I/O 信息流（监督交互，非产品壳）。
 * 每条可展开；支持单条 / 全流一键复制，便于贴回 Cursor 诊断。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  formatLlmIoEntry,
  formatLlmIoStream,
  formatLlmUsageLine,
  sumLlmIoUsage,
  useLlmIoStream,
  type LlmIoStreamEntry,
} from '../reasoning/llmIoStreamStore'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

function EntryCard({
  entry,
  expanded,
  onToggle,
}: {
  entry: LlmIoStreamEntry
  expanded: boolean
  onToggle: () => void
}) {
  const [copied, setCopied] = useState(false)
  const when = new Date(entry.at).toLocaleTimeString()
  const usageLine = formatLlmUsageLine(entry.usage)

  return (
    <article
      className={`llm-io-card${entry.ok ? '' : ' llm-io-card--fail'}${
        entry.kind === 'note' ? ' llm-io-card--note' : ''
      }`}
    >
      <header className="llm-io-card-head">
        <button type="button" className="llm-io-card-title" onClick={onToggle}>
          <span className="llm-io-seq">#{entry.seq}</span>
          <span className="llm-io-job">{entry.job}</span>
          <span className="llm-io-stage">{entry.stage}</span>
          <span className="llm-io-time">{when}</span>
          {usageLine && (
            <span className="llm-io-tokens" title={usageLine}>
              {entry.usage?.totalTokens != null
                ? `${entry.usage.totalTokens}tok`
                : 'tok'}
            </span>
          )}
          {!entry.ok && <span className="llm-io-fail">FAIL</span>}
        </button>
        <button
          type="button"
          className="corpus-chip"
          onClick={async () => {
            const ok = await copyText(formatLlmIoEntry(entry))
            setCopied(ok)
            window.setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? '已复制' : '复制本条'}
        </button>
      </header>
      {expanded && (
        <div className="llm-io-card-body">
          {entry.queryKey && (
            <p className="llm-io-meta">
              queryKey: <code>{entry.queryKey}</code>
            </p>
          )}
          {usageLine && <p className="llm-io-meta">{usageLine}</p>}
          {entry.note && <p className="llm-io-meta">note: {entry.note}</p>}
          {entry.kind === 'llm' && (
            <>
              <details open>
                <summary>SYSTEM</summary>
                <pre>{entry.system || '（空）'}</pre>
              </details>
              <details open>
                <summary>USER</summary>
                <pre>{entry.user || '（空）'}</pre>
              </details>
              <details open>
                <summary>OUTPUT</summary>
                <pre>{entry.output || '（空）'}</pre>
              </details>
            </>
          )}
          {entry.kind === 'note' && <pre>{entry.note || entry.output}</pre>}
        </div>
      )}
    </article>
  )
}

export function LlmIoStreamPanel() {
  const entries = useLlmIoStream((s) => s.entries)
  const clear = useLlmIoStream((s) => s.clear)
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set())
  const [copyAllState, setCopyAllState] = useState<'idle' | 'ok' | 'fail'>(
    'idle',
  )
  const [filterJob, setFilterJob] = useState<string>('all')
  const scrollerRef = useRef<HTMLDivElement>(null)

  const jobs = useMemo(() => {
    const set = new Set(entries.map((e) => e.job))
    return ['all', ...[...set].sort()]
  }, [entries])

  const visible = useMemo(
    () =>
      filterJob === 'all'
        ? entries
        : entries.filter((e) => e.job === filterJob),
    [entries, filterJob],
  )

  const streamUsageLine = useMemo(
    () => formatLlmUsageLine(sumLlmIoUsage(visible)),
    [visible],
  )

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [entries.length])

  useEffect(() => {
    if (entries.length === 0) return
    const last = entries[entries.length - 1]
    if (!last) return
    setOpenIds((prev) => {
      const next = new Set(prev)
      next.add(last.id)
      return next
    })
  }, [entries])

  return (
    <section className="llm-io-stream" aria-label="LLM I/O 信息流">
      <header className="llm-io-stream-head">
        <div>
          <h2>LLM I/O 信息流</h2>
          <p>
            实验监督用 · 不看 briefKey 壳 · 复制后可贴回 Cursor 诊断
            {streamUsageLine ? ` · ${streamUsageLine}` : ''}
          </p>
        </div>
        <div className="llm-io-stream-actions">
          <label className="llm-io-filter">
            工种
            <select
              value={filterJob}
              onChange={(e) => setFilterJob(e.target.value)}
            >
              {jobs.map((j) => (
                <option key={j} value={j}>
                  {j}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="corpus-chip"
            onClick={() =>
              setOpenIds(new Set(visible.map((e) => e.id)))
            }
          >
            全部展开
          </button>
          <button
            type="button"
            className="corpus-chip"
            onClick={() => setOpenIds(new Set())}
          >
            全部折叠
          </button>
          <button
            type="button"
            className="corpus-chip llm-io-copy-all"
            onClick={async () => {
              const ok = await copyText(formatLlmIoStream(visible))
              setCopyAllState(ok ? 'ok' : 'fail')
              window.setTimeout(() => setCopyAllState('idle'), 1500)
            }}
          >
            {copyAllState === 'ok'
              ? '全流已复制'
              : copyAllState === 'fail'
                ? '复制失败'
                : `一键复制全流（${visible.length}）`}
          </button>
          <button type="button" className="corpus-chip" onClick={() => clear()}>
            清空
          </button>
        </div>
      </header>

      <div className="llm-io-stream-list" ref={scrollerRef}>
        {visible.length === 0 ? (
          <p className="llm-io-empty">
            尚无 LLM 调用。底部提问跑自动流后，intent / decide / infer /
            supervise 的 system·user·output 会按序出现在这里。
          </p>
        ) : (
          visible.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              expanded={openIds.has(entry.id)}
              onToggle={() =>
                setOpenIds((prev) => {
                  const next = new Set(prev)
                  if (next.has(entry.id)) next.delete(entry.id)
                  else next.add(entry.id)
                  return next
                })
              }
            />
          ))
        )}
      </div>
    </section>
  )
}
