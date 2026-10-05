/**
 * Demo: Agent proposes figure regions (page_norm polygons) and a cross-page link.
 * Not a model call — staged geometry so the UI can show "AI drawing" then seal + link.
 */

import type { PagePoint } from './emphasis'

export interface AiEmphasisProposal {
  strandIndex: number
  /** Closed ring in page_norm_0_1000 */
  polygon: PagePoint[]
  reading: string
}

export interface AiLinkProposal {
  note: string
  from: AiEmphasisProposal
  to: AiEmphasisProposal
}

/** Soft oval / freehand-ish closed ring around a centre (page_norm). */
export function makeDemoEmphasisRing(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  segments = 28,
  wobble = 0.06,
): PagePoint[] {
  const pts: PagePoint[] = []
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2
    const j =
      1 +
      wobble * Math.sin(t * 3.1 + 0.4) +
      wobble * 0.45 * Math.cos(t * 5.7)
    const x = cx + Math.cos(t) * rx * j
    const y = cy + Math.sin(t) * ry * j
    pts.push([
      Math.min(980, Math.max(20, x)),
      Math.min(980, Math.max(20, y)),
    ])
  }
  return pts
}

/**
 * Build a default two-page Agent proposal from current/companion strands.
 */
export function buildDefaultAiLinkProposal(
  strandA: number,
  strandB: number,
): AiLinkProposal {
  return {
    note: 'Agent · 跨页关联：两处强调同属「连接 / 交错」语义簇',
    from: {
      strandIndex: strandA,
      polygon: makeDemoEmphasisRing(320, 380, 150, 110, 30, 0.07),
      reading:
        'Agent 强调：此区域相对同页背景被抬起——关注「页间连接」的局部结构，而非整页大意。',
    },
    to: {
      strandIndex: strandB,
      polygon: makeDemoEmphasisRing(620, 420, 140, 120, 30, 0.08),
      reading:
        'Agent 强调：对应端点在另一页上的 figure←ground；与 A 端构成可比对的一对。',
    },
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
