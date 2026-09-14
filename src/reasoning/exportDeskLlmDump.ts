/**
 * 写信台 + LLM I/O + token 一键导出（无面板，仅文本包）。
 * 设计：目录向导确认后，导出自带「书 TOC + 审计分类目录」——贴 Cursor 不用再手工理结构。
 */

import { useAttentionIo } from './attentionIoStore'
import { useIndexGate } from './indexGate'
import {
  formatLlmIoEntry,
  formatLlmUsageLine,
  sumLlmIoUsage,
  useLlmIoStream,
  type LlmIoStreamEntry,
  type LlmTokenUsage,
} from './llmIoStreamStore'

function usageLine(u?: LlmTokenUsage | null): string {
  return formatLlmUsageLine(u) ?? 'tokens: （无）'
}

/** 工种 → 审计分卷（已定类，导出即分好） */
const JOB_BUCKETS: Array<{ id: string; title: string; match: (job: string) => boolean }> = [
  {
    id: 'toc',
    title: 'A · 目录/建库（toc_map / toc_nav）',
    match: (j) => /toc|建库|目录/i.test(j),
  },
  {
    id: 'intent',
    title: 'B · 意图路由',
    match: (j) => /intent/i.test(j),
  },
  {
    id: 'neighbour',
    title: 'C · 邻域 settle',
    match: (j) => /neighbour|邻域/i.test(j),
  },
  {
    id: 'decide',
    title: 'D · Decide / 材料选取',
    match: (j) => /decide|peek|prospect/i.test(j),
  },
  {
    id: 'infer',
    title: 'E · Infer 合推',
    match: (j) => /infer/i.test(j),
  },
  {
    id: 'path',
    title: 'F · Path / 方案成型',
    match: (j) => /path/i.test(j),
  },
  {
    id: 'reuse',
    title: 'G · 复用闸 / 停泊',
    match: (j) => /reuse|复用/i.test(j),
  },
  {
    id: 'supervise',
    title: 'H · 监督 / 批判',
    match: (j) => /supervise|critique|监督/i.test(j),
  },
  {
    id: 'auto',
    title: 'I · 自动流进度 note',
    match: (j) => /auto_flow|autoflow|desk/i.test(j),
  },
]

function bucketForJob(job: string): (typeof JOB_BUCKETS)[number] {
  const hit = JOB_BUCKETS.find((b) => b.match(job))
  return (
    hit ?? {
      id: 'other',
      title: 'Z · 其它',
      match: () => true,
    }
  )
}

function byJobUsage(entries: LlmIoStreamEntry[]): string {
  const map = new Map<string, LlmTokenUsage>()
  const counts = new Map<string, number>()
  for (const e of entries) {
    if (e.kind !== 'llm') continue
    counts.set(e.job, (counts.get(e.job) ?? 0) + 1)
    if (!e.usage) continue
    const prev = map.get(e.job)
    if (!prev) {
      map.set(e.job, { ...e.usage })
      continue
    }
    map.set(e.job, {
      promptTokens: (prev.promptTokens ?? 0) + (e.usage.promptTokens ?? 0),
      completionTokens:
        (prev.completionTokens ?? 0) + (e.usage.completionTokens ?? 0),
      totalTokens: (prev.totalTokens ?? 0) + (e.usage.totalTokens ?? 0),
      reasoningTokens:
        (prev.reasoningTokens ?? 0) + (e.usage.reasoningTokens ?? 0),
      cachedTokens: (prev.cachedTokens ?? 0) + (e.usage.cachedTokens ?? 0),
    })
  }
  const jobs = [...new Set([...counts.keys(), ...map.keys()])].sort()
  if (jobs.length === 0) return '（无 LLM 调用）'
  return jobs
    .map((job) => {
      const n = counts.get(job) ?? 0
      const u = map.get(job)
      const bucket = bucketForJob(job).title
      return `- [${bucket}] ${job} ×${n} · ${usageLine(u)}`
    })
    .join('\n')
}

/** 书目录快照：toc_map 已确认则整表导出，审计侧勿再跑目录向导 */
function bookTocSnapshot(): string {
  const gate = useIndexGate.getState()
  const semantic = gate.semanticIndex
  const book = gate.bookIndex
  const lines: string[] = [
    '## 书目录快照（toc_map）',
    `docId: ${book?.docId ?? semantic?.docId ?? '∅'}`,
    `chunks×${book?.chunks.length ?? 0}`,
    `tocConfirmed: ${semantic?.tocConfirmed === true ? 'yes' : 'no'}`,
    `tocSkipped: ${semantic?.tocSkipped === true ? 'yes' : 'no'}`,
    '',
  ]
  if (!semantic) {
    lines.push('（尚无 semanticIndex · 未建目录）', '')
    return lines.join('\n')
  }
  if (semantic.tocSkipped) {
    lines.push('（用户跳过目录 · 无 TOC 闭集 · 提问走全书 BM25）', '')
    return lines.join('\n')
  }
  if (!semantic.tocConfirmed) {
    lines.push('（目录向导未确认 · 章节草稿可能不完整）', '')
  } else {
    lines.push(
      '> 本包已含确认后的章节分类；贴 Cursor 审计时 **不要再要求重跑 toc_map / 目录向导**。',
      '',
    )
  }
  const sections = [...semantic.sections].sort((a, b) => a.ord - b.ord)
  lines.push(`sections×${sections.length}`, '')
  for (const s of sections) {
    const span = s.pageRange
      ? `strand ${s.pageRange.startPage}–${s.pageRange.endPage}`
      : `page=${s.page}`
    const members = s.memberKeys?.length ?? 0
    lines.push(
      `- #${s.ord} \`${s.nodeId}\` · ${s.title || '（无题）'} · ${span} · memberKeys×${members}`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

/** 本包总目录：一眼知道分卷，不用再手工编 md 目录 */
function exportCatalog(entries: LlmIoStreamEntry[]): string {
  const st = useAttentionIo.getState()
  const byBucket = new Map<string, LlmIoStreamEntry[]>()
  for (const e of entries) {
    const b = bucketForJob(e.job)
    const list = byBucket.get(b.id) ?? []
    list.push(e)
    byBucket.set(b.id, list)
  }
  const lines: string[] = [
    '## 本包分类目录（已分好类 · 勿再手工理结构）',
    '',
    '### 文档骨架',
    '- [书目录快照（toc_map）](#书目录快照toc_map)',
    '- [Token 汇总](#token-汇总) / [按工种](#token-按工种)',
    '- [写信台快照](#写信台快照)',
    '- [按 queryKey 索引](#按-querykey-索引)',
    '- [按工种分卷正文](#llm-io-按工种分卷正文)',
    '- [时序全流（附录）](#llm-io-时序全流附录)',
    '',
    '### 按工种分卷索引',
  ]
  for (const b of JOB_BUCKETS) {
    const list = byBucket.get(b.id) ?? []
    if (list.length === 0) continue
    const seqs = list.map((e) => `#${e.seq}`).join(' ')
    lines.push(`- ${b.title} · entries×${list.length} · ${seqs}`)
  }
  const other = byBucket.get('other') ?? []
  if (other.length > 0) {
    lines.push(
      `- Z · 其它 · entries×${other.length} · ${other.map((e) => `#${e.seq}`).join(' ')}`,
    )
  }
  lines.push('', '### 按 queryKey 索引')
  const qkMap = new Map<string, number[]>()
  for (const e of entries) {
    const qk = e.queryKey?.trim()
    if (!qk) continue
    const arr = qkMap.get(qk) ?? []
    arr.push(e.seq)
    qkMap.set(qk, arr)
  }
  const settled = st.settledQueries
  if (qkMap.size === 0 && Object.keys(settled).length === 0) {
    lines.push('- （本流无 queryKey）')
  } else {
    const keys = [
      ...new Set([...Object.keys(settled), ...qkMap.keys()]),
    ].sort()
    for (const qk of keys) {
      const q = settled[qk] ?? ''
      const seqs = qkMap.get(qk) ?? []
      const paths = st.listPathsForQueryKey?.(qk)?.length ?? 0
      const norms = st.listNormsForQueryKey?.(qk)?.length ?? 0
      lines.push(
        `- \`${qk}\` · Q=${(q || '∅').slice(0, 48)} · path×${paths} · norm×${norms}` +
          (seqs.length ? ` · io=[${seqs.map((n) => `#${n}`).join(' ')}]` : ''),
      )
    }
  }
  lines.push('')
  return lines.join('\n')
}

function letterDeskSnapshot(): string {
  const st = useAttentionIo.getState()
  const pending = st.pendingPathMatch
  const reuse = st.pendingReuseProposal
  const pickup = st.getLetterDeskPickup()
  const lines: string[] = [
    '## 写信台快照',
    `exportedAt: ${new Date().toISOString()}`,
    `deskPrompt: ${st.deskPrompt ?? '∅'}`,
    `lastStatus: ${st.lastStatus ?? '∅'}`,
    `intentSessionEpoch: ${st.intentSessionEpoch}`,
    `deskPackages×${st.deskPackages.length}`,
    `pickup.packages×${pickup.packages.length}`,
    '',
  ]
  if (pending) {
    lines.push(
      '### pendingPathMatch',
      `queryKey: ${pending.queryKey}`,
      `question: ${pending.question}`,
      `pathKeys×${pending.pathKeys?.length ?? 0}`,
      `inferKeys×${pending.inferKeys?.length ?? 0}`,
      `prospectKeys×${pending.prospectKeys?.length ?? 0}`,
      `boundPairs×${pending.boundPairs?.length ?? 0}`,
      '',
    )
    for (const p of pending.boundPairs ?? []) {
      const books =
        p.bookKeysSequence && p.bookKeysSequence.length > 0
          ? p.bookKeysSequence
          : p.sharedBookKeys
      lines.push(
        `- path=${p.pathKey}` +
          (p.solutionKey ? ` · solution=${p.solutionKey}` : '') +
          ` · conclusion=${(p.conclusion ?? '').slice(0, 80)}` +
          ` · steps×${p.steps?.length ?? 0}` +
          ` · prospects×${p.prospects?.length ?? p.prospectKeys?.length ?? 0}` +
          ` · book=[${(books ?? []).join(', ')}]`,
      )
      for (const step of p.steps ?? []) {
        lines.push(
          `  · step role=${step.role || '∅'} · ι=${step.inferKey} · book=[${step.bookKeys.join(', ')}] · ${(step.inferText || '').slice(0, 60)}`,
        )
      }
    }
    lines.push('')
  } else {
    lines.push('### pendingPathMatch: null', '')
  }
  if (reuse) {
    lines.push(
      '### pendingReuseProposal',
      `queryKey: ${reuse.queryKey}`,
      `question: ${reuse.question}`,
      `candidates×${reuse.candidates.length}`,
      '',
    )
  } else {
    lines.push('### pendingReuseProposal: null', '')
  }
  const reuseWait = st.pendingReuseWait
  if (reuseWait) {
    lines.push(
      '### pendingReuseWait',
      `queryKey: ${reuseWait.queryKey}`,
      `question: ${reuseWait.question}`,
      `lastNote: ${reuseWait.lastNote}`,
      `exhaustedNormKeys×${reuseWait.exhaustedNormKeys.length}: ${reuseWait.exhaustedNormKeys.join(', ') || '∅'}`,
      `awaitingHistoricQueryKeys×${reuseWait.awaitingHistoricQueryKeys.length}: ${reuseWait.awaitingHistoricQueryKeys.join(', ') || '∅'}`,
      `neighbourOrder×${reuseWait.neighbourOrder.length}`,
      '',
    )
    for (const n of reuseWait.neighbourOrder) {
      lines.push(
        `- #${n.rank} ${n.historicQueryKey}${n.degree ? ` · ${n.degree}` : ''}`,
      )
    }
    lines.push('')
  } else {
    lines.push('### pendingReuseWait: null', '')
  }
  if (st.intentDeskLog.length > 0) {
    lines.push('### intentDeskLog（最近 20）')
    for (const row of st.intentDeskLog.slice(-20)) {
      lines.push(
        `- ${new Date(row.at).toISOString()} · epoch=${row.sessionEpoch} · ${row.action} · q=${row.question.slice(0, 60)} · ${row.note}`,
      )
    }
    lines.push('')
  }
  const qks = Object.keys(st.settledQueries)
  if (qks.length > 0) {
    lines.push('### settledQueries')
    for (const qk of qks.slice(-12)) {
      lines.push(`- ${qk}: ${st.settledQueries[qk]}`)
    }
    lines.push('')
  }
  if (st.neighbours.length > 0) {
    lines.push(`### neighbours×${st.neighbours.length}`)
    for (const n of st.neighbours.slice(-24)) {
      lines.push(
        `- ${n.neighbourKey}: now=${n.nowQueryKey} → hist=${n.historicQueryKey}` +
          (n.degree ? ` · ${n.degree}` : ''),
      )
    }
    lines.push('')
  }
  if (st.queryReuseLinks.length > 0) {
    lines.push(`### queryReuseLinks×${st.queryReuseLinks.length}`)
    for (const r of st.queryReuseLinks.slice(-24)) {
      lines.push(
        `- ${r.reuseKey}: ${r.fromQueryKey} ⇐ ${r.toQueryKey}` +
          (r.normKey ? ` · norm=${r.normKey}` : ''),
      )
    }
    lines.push('')
  }
  lines.push(
    `### 账本计数`,
    `prospects×${st.prospects.length} · inferEdges×${st.inferEdges.length} · paths×${st.paths.length} · norms×${st.norms.length} · neighbours×${st.neighbours.length} · reuseLinks×${st.queryReuseLinks.length}`,
    '',
  )
  return lines.join('\n')
}

function queryKeyIndexSection(entries: LlmIoStreamEntry[]): string {
  const st = useAttentionIo.getState()
  const lines: string[] = ['## 按 queryKey 索引', '']
  const qks = Object.keys(st.settledQueries)
  if (qks.length === 0) {
    lines.push('（无 settledQueries）', '')
    return lines.join('\n')
  }
  for (const qk of qks) {
    const q = st.settledQueries[qk] ?? ''
    const paths = st.listPathsForQueryKey(qk)
    const norms = st.listNormsForQueryKey(qk)
    const ios = entries.filter((e) => e.queryKey === qk).map((e) => e.seq)
    lines.push(`### \`${qk}\``)
    lines.push(`Q: ${q}`)
    lines.push(
      `path×${paths.length} · norm×${norms.length} · io×${ios.length}` +
        (ios.length ? ` · [#${ios.join(', #')}]` : ''),
    )
    for (const p of paths.slice(-4)) {
      lines.push(
        `- path=${p.pathKey} · ${(p.conclusion || '').slice(0, 72)}`,
      )
    }
    for (const n of norms.slice(-4)) {
      lines.push(`- norm=${n.normKey} · ${(n.text || '').slice(0, 72)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/** 正文按工种分卷（主读路径）；时序附录保留对照 */
function classifiedIoBody(entries: LlmIoStreamEntry[]): string {
  const lines: string[] = [
    '## LLM I/O 按工种分卷正文',
    '',
    '> 主读路径：已按工种分卷。条目序号 `#n` 与时序附录一致，可交叉跳转。',
    '',
  ]
  const used = new Set<string>()
  for (const b of [...JOB_BUCKETS, { id: 'other', title: 'Z · 其它', match: () => true }]) {
    const list = entries.filter((e) => {
      if (used.has(e.id)) return false
      const hit = b.id === 'other' ? true : bucketForJob(e.job).id === b.id
      return hit
    })
    if (list.length === 0) continue
    for (const e of list) used.add(e.id)
    lines.push(`### ${b.title}`, '')
    for (const e of list) {
      lines.push(formatLlmIoEntry(e))
    }
  }
  return lines.join('\n')
}

function chronoAppendix(entries: LlmIoStreamEntry[]): string {
  const lines: string[] = [
    '## LLM I/O 时序全流（附录）',
    '',
    '> 仅作时间线对照；分类阅读请用上方分卷。',
    '',
  ]
  for (const e of entries) {
    lines.push(formatLlmIoEntry(e))
  }
  return lines.join('\n')
}

/** 完整导出：书 TOC + 本包分类目录 + 分卷正文（已分好类，勿再弄目录） */
export function buildDeskLlmExportText(): string {
  const entries = useLlmIoStream.getState().entries
  const tot = sumLlmIoUsage(entries)
  const llmN = entries.filter((e) => e.kind === 'llm').length
  const parts = [
    '# Docuverse · 写信台 + LLM I/O 导出包',
    `# exportedAt: ${new Date().toISOString()}`,
    `# entries: ${entries.length} · llmCalls: ${llmN}`,
    '# 约定：本包已含书目录快照 + 审计分类目录 + 按工种分卷；贴 Cursor **不要再要求重编目录 / 重跑 toc_map**。',
    '',
    exportCatalog(entries),
    bookTocSnapshot(),
    '## Token 汇总',
    usageLine(tot),
    '',
    '## Token 按工种',
    byJobUsage(entries),
    '',
    letterDeskSnapshot(),
    queryKeyIndexSection(entries),
    classifiedIoBody(entries),
    chronoAppendix(entries),
  ]
  return parts.join('\n')
}

export async function copyDeskLlmExport(): Promise<{
  ok: boolean
  chars: number
  note: string
}> {
  const text = buildDeskLlmExportText()
  try {
    await navigator.clipboard.writeText(text)
    return { ok: true, chars: text.length, note: `已复制 ${text.length} 字（已分卷）` }
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
      return {
        ok,
        chars: text.length,
        note: ok ? `已复制 ${text.length} 字（已分卷）` : '复制失败',
      }
    } catch {
      return { ok: false, chars: text.length, note: '复制失败' }
    }
  }
}

export function downloadDeskLlmExport(): {
  ok: boolean
  fileName: string
  chars: number
} {
  const text = buildDeskLlmExportText()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const fileName = `docuverse-desk-llm-${stamp}.md`
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
  return { ok: true, fileName, chars: text.length }
}
