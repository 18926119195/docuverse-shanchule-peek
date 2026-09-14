import type { EmphasisEdge } from '../data/emphasis'

/** Golden-angle hues so adjacent strand indices stay distinguishable. */
export function pageEmphasisHue(strandIndex: number): number {
  const n = Math.max(0, Math.floor(strandIndex))
  return (n * 137.508) % 360
}

/**
 * Rank among peers on the same page by createdAt (oldest → 0, newest → 1).
 * Ties broken by id for stability.
 */
export function emphasisRecencyRank(
  edge: EmphasisEdge,
  peersOnPage: EmphasisEdge[],
): number {
  const peers = peersOnPage
    .filter((e) => e.strandIndex === edge.strandIndex)
    .slice()
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      return a.id.localeCompare(b.id)
    })
  if (peers.length <= 1) return 1
  const idx = peers.findIndex((e) => e.id === edge.id)
  if (idx < 0) return 0.6
  return idx / (peers.length - 1)
}

function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360
  const ss = Math.max(0, Math.min(1, s))
  const ll = Math.max(0, Math.min(1, l))
  const c = (1 - Math.abs(2 * ll - 1)) * ss
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = ll - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hh < 60) {
    r = c
    g = x
  } else if (hh < 120) {
    r = x
    g = c
  } else if (hh < 180) {
    g = c
    b = x
  } else if (hh < 240) {
    g = x
    b = c
  } else if (hh < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

export type EmphasisStrokeRole =
  | 'default'
  | 'selected'
  | 'linkFrom'
  | 'linkTarget'
  | 'relation'

/**
 * Page-keyed hue + same-page recency brightness (newer → brighter).
 * Floor lightness keeps older coils visible.
 */
export function emphasisStrokeColor(
  edge: EmphasisEdge,
  peersOnPage: EmphasisEdge[],
  role: EmphasisStrokeRole = 'default',
): string {
  const hue = pageEmphasisHue(edge.strandIndex)
  const recency = emphasisRecencyRank(edge, peersOnPage)
  // Oldest ~0.42, newest ~0.72 — all readable on dark/light page ink
  let light = 0.42 + recency * 0.3
  let sat = 0.78

  if (role === 'selected') {
    light = Math.min(0.82, light + 0.12)
    sat = 0.9
  } else if (role === 'linkFrom') {
    light = Math.min(0.85, light + 0.14)
    sat = 0.55
  } else if (role === 'linkTarget') {
    light = Math.min(0.8, light + 0.1)
    sat = 0.65
  } else if (role === 'relation') {
    light = Math.min(0.84, light + 0.1)
    sat = 0.7
  }

  return hslToHex(hue, sat, light)
}

/** Draft ink while drawing — page hue, high brightness. */
export function pageDraftStrokeColor(strandIndex: number): string {
  return hslToHex(pageEmphasisHue(strandIndex), 0.85, 0.62)
}
