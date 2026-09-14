/**
 * Reading-order helpers for page_norm bboxes (0–1000, top-left origin).
 * Avoids naive top→left sort that stitches two columns / spread halves into
 * one horizontal “row” (wrong for dual-column books and open-book scans).
 */

export type PageBBox = [number, number, number, number]

function cx(b: PageBBox): number {
  return (b[0] + b[2]) / 2
}

function width(b: PageBBox): number {
  return Math.max(0, b[2] - b[0])
}

/**
 * Detect a vertical gutter (column / spread split) from block centers.
 * Returns split X in page_norm, or null for single-column layouts.
 */
export function detectColumnSplitX(boxes: PageBBox[]): number | null {
  if (boxes.length < 4) return null
  const cxs = boxes.map(cx).sort((a, b) => a - b)
  let bestGap = 0
  let bestMid: number | null = null
  for (let i = 0; i < cxs.length - 1; i++) {
    const gap = cxs[i + 1] - cxs[i]
    const mid = (cxs[i] + cxs[i + 1]) / 2
    // Gutter for 2-col or open-book spread usually sits near page center
    if (mid < 280 || mid > 720) continue
    if (gap > bestGap) {
      bestGap = gap
      bestMid = mid
    }
  }
  if (bestMid == null || bestGap < 55) return null
  const left = cxs.filter((x) => x < bestMid).length
  const right = cxs.filter((x) => x >= bestMid).length
  if (left < 2 || right < 2) return null
  return bestMid
}

/** 0 = left column, 1 = right; spanning/wide → column of larger overlap. */
export function columnIndexForBox(
  bbox: PageBBox,
  splitX: number | null,
): number {
  if (splitX == null) return 0
  const w = width(bbox)
  // Full-bleed / cross-gutter: treat as left-column stream by y (headers etc.)
  if (w >= 520 || (bbox[0] < splitX - 20 && bbox[2] > splitX + 20)) {
    return 0
  }
  return cx(bbox) < splitX ? 0 : 1
}

/**
 * Compare two boxes in reading order (optional column split).
 * Column-major: finish left column top→bottom, then right.
 */
export function compareReadingOrderBBox(
  a: PageBBox,
  b: PageBBox,
  splitX: number | null,
  lineTol = 8,
): number {
  const ca = columnIndexForBox(a, splitX)
  const cb = columnIndexForBox(b, splitX)
  if (ca !== cb) return ca - cb
  const dy = a[1] - b[1]
  if (Math.abs(dy) > lineTol) return dy
  return a[0] - b[0]
}

export function sortByReadingOrder<T extends { bbox: PageBBox }>(
  items: T[],
  lineTol = 8,
): T[] {
  const splitX = detectColumnSplitX(items.map((it) => it.bbox))
  return [...items].sort((a, b) =>
    compareReadingOrderBBox(a.bbox, b.bbox, splitX, lineTol),
  )
}

/** Debug / HUD: human label for detected layout. */
export function describeReadingLayout(boxes: PageBBox[]): string {
  const split = detectColumnSplitX(boxes)
  if (split == null) return '单栏（自上而下）'
  return `双栏/对页（分界≈${Math.round(split)}，先左栏后右栏）`
}
