/**
 * Ted Nelson CVS / EDL types
 * US2012/0137202A1 — System for Exploring Connections Between Data Pages
 */

export type FlinkType =
  | 'bookmark'
  | 'resemblance'
  | 'clash'
  | 'pointer'
  | 'disagreement'
  | 'comment'
  | 'correspondence'

/** Five comma-delimited fields in patent EDL */
export interface ContentLocator {
  globalLocation?: string
  localLocation?: string
  fileId: string
  start: number
  size: number
}

export interface StrandContentEntry extends ContentLocator {}

export interface Strand {
  index: number
  title: string
  contents: StrandContentEntry[]
}

export interface FlinkEntry {
  index: number
  type: FlinkType
  from: ContentLocator[]
  to: ContentLocator[]
}

export interface EditDecisionList {
  permascrollFileId: string
  strands: Strand[]
  flinks: FlinkEntry[]
}

export type ConnectionKind = 'transclusion' | 'flink'

export interface SpanCornerPoints {
  /** Four corners of a text span on a page plane (local page coords) */
  topLeft: [number, number]
  topRight: [number, number]
  bottomLeft: [number, number]
  bottomRight: [number, number]
}

export interface ResolvedConnection {
  id: string
  kind: ConnectionKind
  flinkType?: FlinkType
  fromStrand: number
  toStrand: number
  fromStart: number
  fromSize: number
  toStart: number
  toSize: number
  /** Absolute offsets into the page's assembled text */
  fromPageOffset: number
  toPageOffset: number
  /** When set, beam ends at PDF bbox center (0–1000) instead of text offset */
  fromBbox?: [number, number, number, number]
  toBbox?: [number, number, number, number]
  /** Optional user comment shown in HUD */
  comment?: string
}

/** A-pipeline atom on a page: bbox in page_norm_0_1000 + text */
export interface PageTextChunk {
  id: string
  content: string
  bbox: [number, number, number, number]
  /** Constituent layout boxes when this chunk was merged (optional). */
  inkBoxes?: Array<[number, number, number, number]>
}

export interface PageDocument {
  strandIndex: number
  title: string
  text: string
  /** Map from page-local char offset → permascroll absolute offset */
  offsetMap: { pageOffset: number; scrollOffset: number; size: number }[]
  /** When set, card shows this PDF page scan instead of text */
  imageUrl?: string
  /** Source PDF label for HUD grouping */
  sourceDoc?: string
  sourcePage?: number
  /**
   * PDF text-layer chunks (A pipeline). Empty on scans until OCR.
   * Coordinates: page_norm_0_1000, same space as emphasis polygons.
   */
  textChunks?: PageTextChunk[]
}
