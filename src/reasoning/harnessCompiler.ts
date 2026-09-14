/**
 * Harness compiler: project HarnessContext → blocks + AllowedKeys.
 */

import type { BookIndex } from './pipelineA'
import type { AbBlock } from './formalPath'
import type {
  CompilerBlock,
  HarnessCompileResult,
  HarnessContext,
  MotionPlan,
  PathMemoryEntry,
} from './harnessTypes'
import { collectRefluxMarkers } from './toolArchive'

function slotText(bookIndex: BookIndex, key: string): string {
  const chunk = bookIndex.chunks.find((c) => c.key === key)
  if (!chunk) return ''
  const faces = chunk.faces
  const parts: string[] = []
  if (faces.text?.content) parts.push(faces.text.content)
  if (faces.fig?.note) parts.push(`[图] ${faces.fig.note}`)
  return parts.join('\n').trim()
}

function slotPage(bookIndex: BookIndex, key: string): number | undefined {
  return bookIndex.chunks.find((c) => c.key === key)?.page
}

export function compileHarnessProjection(input: {
  ctx: HarnessContext
  bookIndex: BookIndex
  plan: MotionPlan
  memberKeys: ReadonlyArray<string>
}): HarnessCompileResult {
  const { ctx, bookIndex, plan, memberKeys } = input
  const allowedKeys = [...memberKeys]
  const pathMarkers: string[] = markersFromEntries(ctx.working.currentMemory)

  if (plan.action === 'reuse' && plan.reuseFromPathId) {
    const entry =
      ctx.working.currentMemory.find((e) => e.pathId === plan.reuseFromPathId) ??
      ctx.historical.archivePaths.find((e) => e.pathId === plan.reuseFromPathId) ??
      ctx.historical.settledPaths.find((e) => e.pathId === plan.reuseFromPathId)
    const marker = entry?.path.direction.pathMarker
    if (marker) pathMarkers.push(marker)
    const reflux = collectRefluxMarkers(entry ? [entry.path] : [], 4)
    return {
      question: ctx.working.question,
      allowedKeys,
      blocks: [],
      pathMarkers,
      refluxPremise: reflux,
      mode: 'reuse',
    }
  }

  if (plan.action === 'deferred') {
    return {
      question: ctx.working.question,
      allowedKeys,
      blocks: [],
      pathMarkers,
      refluxPremise: collectRefluxMarkers(
        ctx.working.currentMemory.map((e) => e.path),
        4,
      ),
      mode: 'deferred',
    }
  }

  const keysToOpen =
    plan.faultInKeys.length > 0 ? plan.faultInKeys : [...memberKeys]

  const blocks: CompilerBlock[] = []
  for (const k of keysToOpen) {
    if (!k || !allowedKeys.includes(k)) continue
    const text = slotText(bookIndex, k)
    if (!text) continue
    blocks.push({
      key: k,
      text,
      page: slotPage(bookIndex, k),
      shortHandle: k.split('|').pop()?.slice(0, 8),
    })
  }

  const reflux = collectRefluxMarkers(
    ctx.working.currentMemory.map((e) => e.path),
    4,
  )

  return {
    question: ctx.working.question,
    allowedKeys,
    blocks,
    pathMarkers: [...pathMarkers, ...markersFromEntries(ctx.working.currentMemory)],
    refluxPremise: reflux,
    mode: plan.action === 'faultIn' ? 'faultInOnly' : 'expand',
  }
}

function markersFromEntries(entries: ReadonlyArray<PathMemoryEntry>): string[] {
  return entries
    .map((e) => e.path.direction.pathMarker)
    .filter((m): m is string => Boolean(m))
}

export function compileHistoricalPointersOnly(ctx: HarnessContext): string[] {
  return [
    ...ctx.working.currentMemory.map((e) => e.path.direction.pathMarker ?? ''),
    ...ctx.historical.archivePaths.map((e) => e.path.direction.pathMarker ?? ''),
  ].filter(Boolean)
}

/** Convert compiler blocks → infer-ops AbBlock[] */
export function compilerBlocksToAbBlocks(
  blocks: ReadonlyArray<CompilerBlock>,
): AbBlock[] {
  return blocks.map((b) => ({
    key: b.key,
    text: b.text,
    page: b.page,
    shortHandle: b.shortHandle,
  }))
}

/** Append settled pathMarkers to question for compact reflux context */
export function augmentQuestionWithMarkers(input: {
  question: string
  pathMarkers: ReadonlyArray<string>
  refluxPremise?: ReadonlyArray<{
    conclusion: string
    pathSummary: string
    fromKey: string
  }>
}): string {
  const parts = [input.question.trim()]
  const markers = input.pathMarkers.filter(Boolean)
  if (markers.length > 0) {
    parts.push(
      '【已结算 pathMarker · 只认号不展开 T】',
      markers.join('\n---\n'),
    )
  }
  const reflux = input.refluxPremise ?? []
  if (reflux.length > 0) {
    parts.push(
      '【回流前提】',
      reflux
        .map(
          (r) =>
            `from ${r.fromKey}: ${r.conclusion.slice(0, 120)} | ${r.pathSummary.slice(0, 80)}`,
        )
        .join('\n'),
    )
  }
  return parts.join('\n')
}
