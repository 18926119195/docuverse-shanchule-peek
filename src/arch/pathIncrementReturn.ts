/**
 * 路径落账后：写信台把「有向路径」上各跳增量原文回填调度台。
 *
 * 增量 ≠ 无脑拼接全部全文。
 * 增量 = 沿 fromKey ──► toKey，每跳相对输入多出来的 out 原文，按边序排成有向图。
 * 终点：材料经 infer 新铸 queryKey，或复用闸接到旧 queryKey。
 */

import { useAttentionIo } from '../reasoning/attentionIoStore'

function shortKey(k: string): string {
  const t = k.trim()
  if (t.length <= 28) return t
  return `${t.slice(0, 12)}…${t.slice(-8)}`
}

function hopLabel(text: string, index: number): string {
  const m = text.trim().match(/^#{1,3}\s*([^\n]+)/)
  return (m?.[1] ?? `hop_${index + 1}`).trim()
}

function latestQueryKeyForQuestion(question: string): string | null {
  const q = question.trim()
  const settled = useAttentionIo.getState().settledQueries
  let best: string | null = null
  for (const [qk, text] of Object.entries(settled)) {
    if (text === q) best = qk
  }
  return best
}

/**
 * 组装调度台可见的有向增量回文（落账完成后调用）。
 */
export function formatDirectedPathIncrementReturn(input: {
  question: string
  /** 沿途各工种 / 闸的 LLM 原文（运行序） */
  hopOutputs: Array<{ job?: string; text: string }>
  /** mint = 新铸；reuse = 现 qk──►path；auto = 看 store */
  mode?: 'mint' | 'reuse' | 'auto'
  queryKey?: string
}): string {
  const q = input.question.trim()
  const s = useAttentionIo.getState()
  const qk =
    input.queryKey?.trim() ||
    latestQueryKeyForQuestion(q) ||
    ''
  const reuse = s.queryReuseLinks.find((l) => l.fromQueryKey === qk)
  const mode: 'mint' | 'reuse' =
    input.mode === 'mint' || input.mode === 'reuse'
      ? input.mode
      : reuse
        ? 'reuse'
        : 'mint'

  const inferEdges = s.inferEdges.filter((e) => {
    if (mode === 'reuse' && reuse) {
      return (
        reuse.inferKeys.includes(e.inferKey) || e.queryKey === reuse.toQueryKey
      )
    }
    return e.queryKey === qk
  })

  const ikSet = new Set(inferEdges.map((e) => e.inferKey))
  const maxSeq = s.deskDeliveries.reduce(
    (m, d) => Math.max(m, d.settleSeq),
    0,
  )
  const recent = s.deskDeliveries.filter((d) => {
    if (d.settleSeq < maxSeq - 24) return false
    return (
      d.toKey === qk ||
      ikSet.has(d.toKey) ||
      (reuse != null &&
        (d.toKey === reuse.toQueryKey || d.toKey === reuse.fromQueryKey)) ||
      d.job === 'decide' ||
      d.job === 'query' ||
      d.job === 'peek' ||
      d.job === 'infer' ||
      d.job === 'reuse'
    )
  })

  const topo: string[] = []
  for (const d of recent) {
    const from = d.fromKeys.map((k) => `\`${shortKey(k)}\``).join(' · ')
    topo.push(`${from} ──${d.job}──► \`${shortKey(d.toKey)}\``)
  }
  for (const e of inferEdges) {
    const books = e.bookKeys.map((k) => `\`${shortKey(k)}\``).join(' · ')
    topo.push(
      `${books} ──ι:\`${shortKey(e.inferKey)}\`──► \`${shortKey(qk)}\``,
    )
  }
  if (mode === 'reuse' && reuse) {
    topo.push(
      `\`${shortKey(reuse.fromQueryKey)}\` ──reuse:${shortKey(reuse.reuseKey)}──► norm:\`${shortKey(reuse.normKey)}\`（path:\`${shortKey(reuse.pathKey)}\` · 旧 qk \`${shortKey(reuse.toQueryKey)}\`）`,
    )
  }

  const blocks: string[] = [
    `# 路径落账 · 有向增量回文`,
    ``,
    `Q：${q}`,
    `queryKey=\`${qk}\`${
      mode === 'reuse' && reuse
        ? ` ──reuse:${reuse.reuseKey}──► norm \`${reuse.normKey}\`（path \`${reuse.pathKey}\` · 旧 \`${reuse.toQueryKey}\`）`
        : '（新铸）'
    }`,
    ``,
    `## 有向拓扑（台递送 / ι / 复用）`,
    ...(topo.length > 0 ? topo : ['（本轮暂无台递送边可绘；见下方 ι / 原文）']),
    ``,
    `## 沿途增量原文（按运行序 · 各跳 out）`,
  ]

  input.hopOutputs.forEach((hop, i) => {
    const text = hop.text.trim()
    if (!text) return
    blocks.push(`### ${hop.job?.trim() || hopLabel(text, i)}`, text, '')
  })

  if (inferEdges.length > 0) {
    blocks.push(`## ι 边 I/O 原文（落账结构）`, '')
    for (const e of inferEdges) {
      blocks.push(
        `### ι \`${e.inferKey}\``,
        `${e.bookKeys.map((k) => `\`${k}\``).join(' · ')} ──► \`${qk}\``,
        ``,
        `【in】`,
        e.leftText.trim() || '（空）',
        ``,
        `【out / Δ】`,
        e.rightText.trim() || e.infer?.trim() || e.rationale.trim() || '（空）',
        '',
      )
    }
  }

  if (mode === 'reuse' && reuse) {
    blocks.push(
      `## 复用增量边`,
      `\`${reuse.fromQueryKey}\` ──reuse:${reuse.reuseKey}──► norm:\`${reuse.normKey}\`（path:\`${reuse.pathKey}\` · 旧 \`${reuse.toQueryKey}\`）`,
      reuse.rationale.trim() || '（无依据文）',
      '',
    )
  }

  blocks.push(
    `---`,
    `增量 = 有向边上相对输入多出的 out 原文，按边序回填调度台；不是无序粘贴全部窗口。`,
  )

  return blocks.join('\n')
}

/** 从已拼接的 parts 推断 hop 列表 */
export function hopsFromAnswerParts(parts: string[]): Array<{
  job: string
  text: string
}> {
  return parts
    .map((text, i) => ({ job: hopLabel(text, i), text }))
    .filter((h) => h.text.trim().length > 0)
}

/** 本轮 notes 是否已走到落账（新铸或复用） */
export function notesIndicatePathSettled(notes: string[]): boolean {
  const blob = notes.join(' · ')
  return /settle\s*infer|落账|复用采纳|reuse\s*采纳|qk=/i.test(blob)
}
