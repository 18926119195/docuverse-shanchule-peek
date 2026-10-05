/**
 * Edit Decision List + xanacrunch (corner-points / connections)
 * US2012/0137202A1 §§0053–0070
 */

import type {
  ContentLocator,
  EditDecisionList,
  FlinkEntry,
  PageDocument,
  ResolvedConnection,
  Strand,
} from './types'

export function assemblePage(
  permascroll: string,
  strand: Strand,
): PageDocument {
  let text = ''
  const offsetMap: PageDocument['offsetMap'] = []
  for (const entry of strand.contents) {
    const slice = permascroll.slice(entry.start, entry.start + entry.size)
    offsetMap.push({
      pageOffset: text.length,
      scrollOffset: entry.start,
      size: entry.size,
    })
    text += slice
  }
  return {
    strandIndex: strand.index,
    title: strand.title,
    text,
    offsetMap,
  }
}

export function assembleAllPages(
  permascroll: string,
  edl: EditDecisionList,
): PageDocument[] {
  return edl.strands.map((s) => assemblePage(permascroll, s))
}

/** Map permascroll absolute offset → page-local offset if covered by strand */
export function scrollToPageOffset(
  page: PageDocument,
  scrollOffset: number,
  size: number,
): number | null {
  for (const m of page.offsetMap) {
    if (scrollOffset >= m.scrollOffset && scrollOffset + size <= m.scrollOffset + m.size) {
      return m.pageOffset + (scrollOffset - m.scrollOffset)
    }
    // Partial overlap: clamp into mapped region
    if (
      scrollOffset < m.scrollOffset + m.size &&
      scrollOffset + size > m.scrollOffset
    ) {
      return m.pageOffset + Math.max(0, scrollOffset - m.scrollOffset)
    }
  }
  return null
}

function locatorMatchesPage(
  loc: ContentLocator,
  page: PageDocument,
): number | null {
  return scrollToPageOffset(page, loc.start, loc.size)
}

/**
 * Discover transclusions by comparing strand content blocks
 * (bit-by-bit / filtered text identity). Patent §0067.
 */
export function discoverTransclusions(
  pages: PageDocument[],
  minLen = 40,
): ResolvedConnection[] {
  const found: ResolvedConnection[] = []
  let n = 0
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = pages[i]
      const b = pages[j]
      // Sliding window identity on significant substrings
      const step = Math.max(20, Math.floor(minLen / 2))
      for (let ao = 0; ao + minLen <= a.text.length; ao += step) {
        const needle = a.text.slice(ao, ao + minLen)
        if (!needle.trim() || needle.includes('\0')) continue
        const bi = b.text.indexOf(needle)
        if (bi >= 0) {
          // Extend match
          let len = minLen
          while (
            ao + len < a.text.length &&
            bi + len < b.text.length &&
            a.text[ao + len] === b.text[bi + len]
          ) {
            len++
          }
          found.push({
            id: `tx_${n++}`,
            kind: 'transclusion',
            fromStrand: a.strandIndex,
            toStrand: b.strandIndex,
            fromStart: ao,
            fromSize: len,
            toStart: bi,
            toSize: len,
            fromPageOffset: ao,
            toPageOffset: bi,
          })
          ao += len
        }
      }
    }
  }
  // Deduplicate heavily overlapping
  return dedupeConnections(found)
}

function dedupeConnections(list: ResolvedConnection[]): ResolvedConnection[] {
  const out: ResolvedConnection[] = []
  for (const c of list) {
    const overlap = out.some(
      (o) =>
        o.fromStrand === c.fromStrand &&
        o.toStrand === c.toStrand &&
        Math.abs(o.fromPageOffset - c.fromPageOffset) < 20,
    )
    if (!overlap) out.push(c)
  }
  return out
}

/** Process flink entries against assembled pages — patent §0068 */
export function resolveFlinks(
  pages: PageDocument[],
  flinks: FlinkEntry[],
): ResolvedConnection[] {
  const out: ResolvedConnection[] = []
  let n = 0
  for (const fl of flinks) {
    for (const from of fl.from) {
      for (const to of fl.to) {
        for (const pageA of pages) {
          const fromOff = locatorMatchesPage(from, pageA)
          if (fromOff === null) continue
          for (const pageB of pages) {
            const toOff = locatorMatchesPage(to, pageB)
            if (toOff === null) continue
            out.push({
              id: `fl_${n++}`,
              kind: 'flink',
              flinkType: fl.type,
              fromStrand: pageA.strandIndex,
              toStrand: pageB.strandIndex,
              fromStart: from.start,
              fromSize: from.size,
              toStart: to.start,
              toSize: to.size,
              fromPageOffset: fromOff,
              toPageOffset: toOff,
            })
          }
        }
      }
    }
  }
  return out
}

/**
 * xanacrunch — find corner-points of spans so beams can be drawn.
 * Returns approximate local page coordinates for a char span.
 */
export function spanCornerPoints(
  text: string,
  offset: number,
  size: number,
  pageWidth: number,
  pageHeight: number,
  charsPerLine = 48,
  lineHeight = 0.42,
  charWidth = 0.22,
  marginX = 0.8,
  marginY = 1.2,
): {
  topLeft: [number, number]
  topRight: [number, number]
  bottomLeft: [number, number]
  bottomRight: [number, number]
} {
  const startLine = Math.floor(offset / charsPerLine)
  const startCol = offset % charsPerLine
  const end = offset + Math.max(1, size) - 1
  const endLine = Math.floor(end / charsPerLine)
  const endCol = end % charsPerLine

  const yTop = pageHeight / 2 - marginY - startLine * lineHeight
  const yBot = pageHeight / 2 - marginY - (endLine + 1) * lineHeight
  const xLeft = -pageWidth / 2 + marginX + startCol * charWidth
  const xRight = -pageWidth / 2 + marginX + (endCol + 1) * charWidth

  void text
  return {
    topLeft: [xLeft, yTop],
    topRight: [xRight, yTop],
    bottomLeft: [xLeft, yBot],
    bottomRight: [xRight, yBot],
  }
}

export function buildConnections(
  permascroll: string,
  edl: EditDecisionList,
): { pages: PageDocument[]; connections: ResolvedConnection[] } {
  const pages = assembleAllPages(permascroll, edl)
  const transclusions = discoverTransclusions(pages)
  const flinks = resolveFlinks(pages, edl.flinks)
  // Transclusion trumps flink on identical endsets (patent §0063)
  const connections = [...transclusions, ...flinks]
  return { pages, connections }
}
